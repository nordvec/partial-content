/**
 * Resumable-upload wire dialect for the IETF draft protocol
 * (draft-ietf-httpbis-resumable-upload) over the Fetch API.
 *
 * The handler speaks the draft revisions that deployed clients actually
 * implement, identified by their interop versions: 3 (draft-01), 5
 * (draft-03), and 6 (draft-04/-05). Later revisions have no deployed
 * speakers, so their surface (version negotiation, `Upload-Limit`, GET as an
 * offset probe) is deliberately absent until a stabilized revision ships
 * real clients. Versions are a compiled allowlist; the draft itself forbids
 * cross-version interop, so an unlisted version is answered 400 with the
 * supported set named in the body.
 *
 * The wire differences between the supported versions are encoded in one
 * explicit mapping table ({@link INTEROP_WIRE_FORMATS}), the most important
 * being the completeness header flip: interop 3 sends `Upload-Incomplete`
 * (`?1` asserts the upload is NOT complete), interop 5 and 6 send
 * `Upload-Complete` (`?1` asserts it IS). Both names ride requests and
 * responses, so the polarity is a per-version fact, never a renamed boolean.
 *
 * Interim responses: the draft lets capable servers announce resumption
 * support with `104 (Upload Resumption Supported)`, but a Fetch `Response`
 * cannot carry interim responses, so this handler NEVER emits them (the
 * draft only asks servers to send 104 when they can). Transports that can
 * write interim responses may wire {@link UploadHandlerOptions.onResumptionSupported}
 * to do so; the hook fires once the upload resource exists.
 *
 * Protocol decisions are the orchestrator's ({@link createUploadOrchestrator});
 * this module only translates requests into orchestrator calls and outcomes
 * into statuses and headers, and it never throws: unexpected failures become
 * hardened 500s and are reported to `onError`.
 *
 * @packageDocumentation
 */

import {
  createUploadOrchestrator,
  type UploadOutcome,
  type UploadResourceEvent,
} from "./upload-orchestrator.ts";
import type { UploadPolicy } from "./upload-engine.ts";
import type { ResumableWriteStore } from "./upload-store.ts";
import type { UploadLocker } from "./upload-locker.ts";

// ─── Per-version wire mapping ───────────────────────────────────────────────

/**
 * Everything that differs on the wire between supported interop versions.
 * One row per version, each fact explicit: the completeness header changes
 * NAME and POLARITY at interop 5, and the media-type and problem-details
 * requirements arrive at interop 6.
 */
interface InteropWireFormat {
  /** Header field carrying completeness on requests and responses. */
  completenessHeader: "Upload-Incomplete" | "Upload-Complete";
  /**
   * What a `?1` in that header asserts: `true` means "the upload is
   * complete" (`Upload-Complete`), `false` means "the upload is not
   * complete" (`Upload-Incomplete`).
   */
  headerAssertsComplete: boolean;
  /** Appends must carry `Content-Type: application/partial-upload`. */
  requiresPartialUploadMediaType: boolean;
  /**
   * Offset-mismatch answers carry the registered RFC 9457 problem type
   * (`mismatching-upload-offset`) as `application/problem+json`. Earlier
   * versions predate the registration and get an empty 409 body.
   */
  mismatchProblemDetails: boolean;
  /**
   * Offset probes announce `Upload-Length` when the total is known
   * (a MUST from draft-05 onward; earlier revisions lack the field).
   */
  probeAnnouncesLength: boolean;
}

/**
 * The compiled interop allowlist. 3 = draft-01, 5 = draft-03, 6 =
 * draft-04/-05: every version with deployed clients. The current draft
 * revision has none; it joins this table when it stabilizes.
 */
const INTEROP_WIRE_FORMATS: ReadonlyMap<number, InteropWireFormat> = new Map([
  [3, {
    completenessHeader: "Upload-Incomplete" as const,
    headerAssertsComplete: false,
    requiresPartialUploadMediaType: false,
    mismatchProblemDetails: false,
    probeAnnouncesLength: false,
  }],
  [5, {
    completenessHeader: "Upload-Complete" as const,
    headerAssertsComplete: true,
    requiresPartialUploadMediaType: false,
    mismatchProblemDetails: false,
    probeAnnouncesLength: false,
  }],
  [6, {
    completenessHeader: "Upload-Complete" as const,
    headerAssertsComplete: true,
    requiresPartialUploadMediaType: true,
    mismatchProblemDetails: true,
    probeAnnouncesLength: true,
  }],
]);

const DEFAULT_INTEROP_VERSIONS: readonly number[] = [3, 5, 6];

const INTEROP_VERSION_HEADER = "Upload-Draft-Interop-Version";
const MISMATCHING_OFFSET_PROBLEM_TYPE =
  "https://iana.org/assignments/http-problem-types#mismatching-upload-offset";

/** Serialize a completeness fact into the version's header value. */
function encodeCompleteness(wire: InteropWireFormat, complete: boolean): string {
  return complete === wire.headerAssertsComplete ? "?1" : "?0";
}

/** Interpret the version's header value as a completeness fact. */
function decodeCompleteness(wire: InteropWireFormat, headerValue: boolean): boolean {
  return headerValue === wire.headerAssertsComplete;
}

// ─── Header parsing (RFC 8941 items; malformed fields are ignored) ──────────

/**
 * RFC 8941 boolean item: exactly `?1` or `?0` (surrounding whitespace
 * tolerated). Anything else is a malformed structured field, which the draft
 * says receivers ignore, so it parses as "header absent".
 */
function parseStructuredBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (v === "?1") return true;
  if (v === "?0") return false;
  return undefined;
}

/**
 * RFC 8941 integer item: up to 15 digits, optional sign. Malformed fields
 * are ignored (parse as absent); a syntactically valid but semantically
 * impossible value (negative offset or length) flows to the engine, which
 * rejects it as inconsistent request data.
 */
function parseStructuredInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (!/^-?\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}

/** Plain `Content-Length` (RFC 9110 list syntax not tolerated: single value). */
function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (!/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}

/**
 * Extract the asserted whole-representation SHA-256 from an RFC 9530
 * `Repr-Digest` field, as raw base64 (44 characters). Unsupported
 * algorithms and malformed members are ignored per RFC 9530; only a
 * well-formed `sha-256` byte sequence is returned.
 */
function parseReprDigestSha256(value: string | null): string | undefined {
  if (value === null) return undefined;
  for (const member of value.split(",")) {
    const eq = member.indexOf("=");
    if (eq === -1) continue;
    if (member.slice(0, eq).trim().toLowerCase() !== "sha-256") continue;
    const raw = member.slice(eq + 1).trim();
    if (!raw.startsWith(":") || !raw.endsWith(":")) continue;
    const b64 = raw.slice(1, -1);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) continue;
    return b64;
  }
  return undefined;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** Facts about a creation request, for deriving the final storage key. */
export interface UploadCreation {
  request: Request;
  /** Interop version the creating client speaks. */
  interopVersion: number;
  /** Declared total length, when the client sent one. */
  declaredLength?: number;
  /** The creation also completes the upload (single-request upload). */
  complete: boolean;
}

export interface UploadHandlerContext {
  /** Upload token routed from the URL by the caller's framework. */
  uploadToken?: string;
}

export interface UploadHandlerOptions {
  /** Final storage key for the object a new upload will publish to. */
  key: (creation: UploadCreation) => string;
  /**
   * Value for the `Location` header on creation responses: the URL of the
   * upload resource for the given token. Clients send every follow-up
   * (probe, append, cancel) to this URL.
   */
  location: (uploadToken: string) => string;
  /**
   * Extract the upload token from a resource request when the caller does
   * not route it via `ctx.uploadToken`. Returning `undefined` marks the
   * request as a creation.
   */
  resolveToken?: (req: Request) => string | undefined;
  /**
   * Audit-safe identifier reported on hook events instead of the storage
   * key (keys commonly embed filenames, which must stay out of logs).
   */
  auditKey?: (req: Request) => string | undefined;
  /** Server policy the engine enforces (sizes, append bounds, max age). */
  policy?: UploadPolicy;
  /** Lock provider. Default: in-process cooperative-preemption locker. */
  locker?: UploadLocker;
  /** Structured, content-free audit events. */
  onUploadEvent?: (event: UploadResourceEvent) => void;
  /** Must not throw (there is no sink for a failing error sink). */
  onError?: (error: unknown, context: { uploadToken?: string; operation: string }) => void;
  /** Post-abort flush window in milliseconds. @default 10000 */
  graceMs?: number;
  /** Clock injection (tests). @default Date.now */
  now?: () => number;
  /**
   * Interop versions to serve, each of which must be one this module has a
   * wire mapping for. @default [3, 5, 6]
   */
  interopVersions?: readonly number[];
  /**
   * Fires when a creation produced an upload resource, carrying what a
   * `104 (Upload Resumption Supported)` interim response would: the
   * resource location and the interop version to echo. The Fetch handler
   * itself can never emit interim responses; a transport that can may wire
   * this hook to send the 104. Note the hook necessarily fires after the
   * creation content was consumed (the handler only learns the token from
   * the completed creation), so it arrives later than a native server
   * would send it. Guarded: a throwing hook is routed to `onError`.
   */
  onResumptionSupported?: (info: {
    uploadToken: string;
    location: string;
    interopVersion: number;
  }) => void;
}

/** A framework-agnostic upload endpoint over Fetch primitives. */
export type UploadHandler = (req: Request, ctx?: UploadHandlerContext) => Promise<Response>;

// ─── Response builders ──────────────────────────────────────────────────────

/**
 * Hardening for every error answer, mirroring the read side: `nosniff` and
 * a deny-all CSP so an error body can never be sniffed or execute anything,
 * `no-store` so a transient failure can never be cached past its cause.
 */
const ERROR_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
};

const UTF8_ENCODER = new TextEncoder();

function textResponse(
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): Response {
  const bytes = UTF8_ENCODER.encode(body);
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      ...ERROR_HEADERS,
      ...extraHeaders,
    },
  });
}

function emptyResponse(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Create an upload endpoint speaking the IETF resumable-upload draft.
 *
 * Requests without an upload token (none routed via `ctx.uploadToken`, none
 * resolved by `resolveToken`) are creations; requests with one target the
 * upload resource: `HEAD` probes the offset, `PATCH` appends, `DELETE`
 * cancels. Every response that participates in the protocol echoes the
 * request's interop version.
 *
 * @throws TypeError at construction when `interopVersions` names a version
 * this module has no wire mapping for (misconfiguration must be loud;
 * requests never throw).
 */
export function createUploadHandler(
  store: ResumableWriteStore,
  options: UploadHandlerOptions,
): UploadHandler {
  const versions = [...(options.interopVersions ?? DEFAULT_INTEROP_VERSIONS)].sort(
    (a, b) => a - b,
  );
  if (versions.length === 0) {
    throw new TypeError("upload handler: interopVersions must name at least one version");
  }
  for (const v of versions) {
    if (!INTEROP_WIRE_FORMATS.has(v)) {
      throw new TypeError(
        `upload handler: no wire mapping for interop version ${v} ` +
        `(supported: ${[...INTEROP_WIRE_FORMATS.keys()].join(", ")})`,
      );
    }
  }
  const supportedSet = versions.join(", ");
  const latestVersion = versions[versions.length - 1]!;
  const onError = options.onError;

  const orchestrator = createUploadOrchestrator(store, {
    policy: options.policy,
    locker: options.locker,
    onUploadEvent: options.onUploadEvent,
    onError,
    graceMs: options.graceMs,
    now: options.now,
  });

  /** 400 for a missing, malformed, or unlisted interop version. */
  function unsupportedVersion(): Response {
    return textResponse(
      400,
      `unsupported or missing ${INTEROP_VERSION_HEADER}; supported versions: ${supportedSet}`,
      { [INTEROP_VERSION_HEADER]: String(latestVersion) },
    );
  }

  /**
   * The offset-mismatch answer is the protocol's retry mechanism: 409 with
   * the CORRECT offset and the true completeness, so the client re-anchors
   * without a probe round trip. Interop 6 additionally carries the
   * registered problem type with both offsets.
   */
  function conflictResponse(
    version: number,
    wire: InteropWireFormat,
    correctOffset: number,
    complete: boolean,
    claimedOffset: number,
  ): Response {
    const headers: Record<string, string> = {
      [INTEROP_VERSION_HEADER]: String(version),
      "Upload-Offset": String(correctOffset),
      [wire.completenessHeader]: encodeCompleteness(wire, complete),
      ...ERROR_HEADERS,
    };
    if (!wire.mismatchProblemDetails) {
      return emptyResponse(409, { ...headers, "Content-Length": "0" });
    }
    const body = UTF8_ENCODER.encode(JSON.stringify({
      type: MISMATCHING_OFFSET_PROBLEM_TYPE,
      title: "offset from request does not match offset of resource",
      "expected-offset": correctOffset,
      "provided-offset": claimedOffset,
    }));
    return new Response(body, {
      status: 409,
      headers: {
        ...headers,
        "Content-Type": "application/problem+json",
        "Content-Length": String(body.byteLength),
      },
    });
  }

  /**
   * Render the reject outcomes shared by every interaction. Offset
   * mismatches and idempotent completion replays are append-specific and
   * handled by the caller before this runs.
   */
  function rejectResponse(outcome: UploadOutcome, version: number): Response {
    const echo = { [INTEROP_VERSION_HEADER]: String(version) };
    switch (outcome.kind) {
      case "limit-violation":
        // Size violations are payload problems (413); the floor violations
        // are malformed requests against advertised bounds (400).
        if (outcome.reason === "size-exceeded" || outcome.reason === "append-too-large") {
          return textResponse(413, `upload rejected: ${outcome.reason}`, echo);
        }
        return textResponse(400, `upload rejected: ${outcome.reason}`, echo);
      case "length-inconsistent":
        // The registered inconsistent-length problem type postdates every
        // supported version (it arrives at interop 7), so the body stays
        // plain text at interops 3, 5, and 6.
        return textResponse(400, "inconsistent upload length indicators", echo);
      case "gone":
      case "not-found":
        // The draft folds every dead resource (unknown, cancelled, expired,
        // invalidated) into "not active": 404, empty body.
        return emptyResponse(404, { ...echo, "Content-Length": "0", ...ERROR_HEADERS });
      case "contended":
        // Deliberately distinct from 409: deployed clients retry 423 as-is
        // and re-probe on 409, and contention must not trigger a re-anchor.
        return textResponse(423, "upload resource is busy; retry later", echo);
      case "digest-mismatch":
        return textResponse(
          400,
          "upload content does not match the asserted sha-256 digest",
          echo,
        );
      case "store-error":
        return textResponse(500, "upload storage failure", echo);
      default:
        // An action outcome leaking here is a dialect bug: report it, never
        // throw it at the transport.
        onError?.(
          new Error(`upload handler: unexpected outcome ${outcome.kind}`),
          { operation: "render" },
        );
        return textResponse(500, "upload handler failure", echo);
    }
  }

  /**
   * Probe and cancel requests must not carry upload-state headers (a MUST
   * in every supported revision). Presence is judged on PARSED values,
   * matching deployed servers: a malformed field was already "ignored", so
   * it does not count as present.
   */
  function carriesUploadStateHeaders(req: Request, wire: InteropWireFormat): boolean {
    return parseStructuredBoolean(req.headers.get(wire.completenessHeader)) !== undefined
      || parseStructuredInteger(req.headers.get("Upload-Offset")) !== undefined
      || parseStructuredInteger(req.headers.get("Upload-Length")) !== undefined;
  }

  async function handleCreation(
    req: Request,
    version: number,
    wire: InteropWireFormat,
    auditKey: string | undefined,
  ): Promise<Response> {
    const echo = { [INTEROP_VERSION_HEADER]: String(version) };
    // The completeness header is what MAKES a request an upload creation in
    // the draft's model. This endpoint serves nothing but uploads, so a
    // creation without it cannot fall through to non-resumable handling and
    // is answered 400 instead.
    const completenessValue = parseStructuredBoolean(req.headers.get(wire.completenessHeader));
    if (completenessValue === undefined) {
      return textResponse(
        400,
        `upload creation requires the ${wire.completenessHeader} header field`,
        echo,
      );
    }
    // Creations carry no offset (deployed servers tolerate an explicit 0).
    const offset = parseStructuredInteger(req.headers.get("Upload-Offset"));
    if (offset !== undefined && offset !== 0) {
      return textResponse(400, "upload creation must not carry a non-zero Upload-Offset", echo);
    }
    const complete = decodeCompleteness(wire, completenessValue);
    const declaredLength = parseStructuredInteger(req.headers.get("Upload-Length"));
    // Representation metadata the completed object should retain (the draft
    // says the server SHOULD respect it; the store records it opaquely).
    const contentType = req.headers.get("Content-Type");
    const contentDisposition = req.headers.get("Content-Disposition");
    const metadata: Record<string, string> = {};
    if (contentType !== null) metadata.contentType = contentType;
    if (contentDisposition !== null) metadata.contentDisposition = contentDisposition;

    const outcome = await orchestrator.create({
      key: options.key({ request: req, interopVersion: version, declaredLength, complete }),
      declaredLength,
      contentLength: parseContentLength(req.headers.get("Content-Length")),
      complete,
      body: req.body ?? undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      expectedDigest: parseReprDigestSha256(req.headers.get("Repr-Digest")),
      auditKey,
      signal: req.signal,
    });
    if (outcome.kind !== "created") return rejectResponse(outcome, version);

    const location = options.location(outcome.uploadToken);
    if (options.onResumptionSupported) {
      try {
        options.onResumptionSupported({
          uploadToken: outcome.uploadToken,
          location,
          interopVersion: version,
        });
      } catch (err) {
        onError?.(err, { uploadToken: outcome.uploadToken, operation: "resumption-hook" });
      }
    }
    return emptyResponse(201, {
      ...echo,
      Location: location,
      [wire.completenessHeader]: encodeCompleteness(wire, outcome.complete),
      "Upload-Offset": String(outcome.offset),
    });
  }

  async function handleProbe(
    req: Request,
    uploadToken: string,
    version: number,
    wire: InteropWireFormat,
    auditKey: string | undefined,
  ): Promise<Response> {
    const echo = { [INTEROP_VERSION_HEADER]: String(version) };
    if (carriesUploadStateHeaders(req, wire)) {
      return textResponse(400, "offset retrieval must not carry upload-state header fields", echo);
    }
    const outcome = await orchestrator.probe(uploadToken, { auditKey, signal: req.signal });
    if (outcome.kind !== "probed") return rejectResponse(outcome, version);
    const headers: Record<string, string> = {
      ...echo,
      "Upload-Offset": String(outcome.offset),
      [wire.completenessHeader]: encodeCompleteness(wire, outcome.complete),
      // A cached offset answer would re-anchor a client on stale truth.
      "Cache-Control": "no-store",
    };
    if (wire.probeAnnouncesLength && outcome.length !== undefined) {
      headers["Upload-Length"] = String(outcome.length);
    }
    return emptyResponse(204, headers);
  }

  async function handleAppend(
    req: Request,
    uploadToken: string,
    version: number,
    wire: InteropWireFormat,
    auditKey: string | undefined,
  ): Promise<Response> {
    const echo = { [INTEROP_VERSION_HEADER]: String(version) };
    if (wire.requiresPartialUploadMediaType) {
      const mediaType = req.headers.get("Content-Type");
      if (mediaType === null || mediaType.trim().toLowerCase() !== "application/partial-upload") {
        return textResponse(
          400,
          "upload append requires Content-Type: application/partial-upload",
          echo,
        );
      }
    }
    // Malformed structured fields are ignored, so a garbled offset lands
    // here as "absent", and an append without an offset is unprocessable.
    const offset = parseStructuredInteger(req.headers.get("Upload-Offset"));
    if (offset === undefined) {
      return textResponse(400, "upload append requires the Upload-Offset header field", echo);
    }
    // An append without the completeness header is a completing request in
    // every supported revision (the header is only REQUIRED when false).
    const completenessValue = parseStructuredBoolean(req.headers.get(wire.completenessHeader));
    const complete = completenessValue === undefined
      ? true
      : decodeCompleteness(wire, completenessValue);

    const outcome = await orchestrator.append(uploadToken, {
      offset,
      contentLength: parseContentLength(req.headers.get("Content-Length")),
      complete,
      declaredLength: parseStructuredInteger(req.headers.get("Upload-Length")),
      body: req.body ?? undefined,
      expectedDigest: parseReprDigestSha256(req.headers.get("Repr-Digest")),
      auditKey,
      signal: req.signal,
    });
    switch (outcome.kind) {
      case "appended":
        return emptyResponse(201, {
          ...echo,
          [wire.completenessHeader]: encodeCompleteness(wire, outcome.complete),
          "Upload-Offset": String(outcome.offset),
        });
      case "already-complete":
        // Idempotent replay of a completion the client never saw acknowledged.
        // The engine only answers this when the claimed offset IS the durable
        // offset, so echoing it back is truthful.
        return emptyResponse(200, {
          ...echo,
          [wire.completenessHeader]: encodeCompleteness(wire, true),
          "Upload-Offset": String(offset),
        });
      case "offset-mismatch":
        return conflictResponse(
          version,
          wire,
          outcome.correctOffset,
          outcome.complete,
          outcome.claimedOffset,
        );
      default:
        return rejectResponse(outcome, version);
    }
  }

  async function handleCancel(
    req: Request,
    uploadToken: string,
    version: number,
    wire: InteropWireFormat,
    auditKey: string | undefined,
  ): Promise<Response> {
    const echo = { [INTEROP_VERSION_HEADER]: String(version) };
    if (carriesUploadStateHeaders(req, wire)) {
      return textResponse(400, "upload cancellation must not carry upload-state header fields", echo);
    }
    const outcome = await orchestrator.cancel(uploadToken, { auditKey, signal: req.signal });
    if (outcome.kind !== "cancelled") return rejectResponse(outcome, version);
    return emptyResponse(204, echo);
  }

  async function dispatch(req: Request, ctx?: UploadHandlerContext): Promise<Response> {
    const method = req.method.toUpperCase();
    if (method === "OPTIONS") {
      // Standard method discovery (RFC 9110 Section 8.6); version-agnostic.
      // Limits advertisement via Upload-Limit is a later-revision surface no
      // supported client consumes, so it is deliberately absent here.
      return emptyResponse(204, {
        Allow: "POST, HEAD, PATCH, DELETE, OPTIONS",
        "Cache-Control": "no-store",
      });
    }
    const version = parseStructuredInteger(req.headers.get(INTEROP_VERSION_HEADER));
    if (version === undefined || !versions.includes(version)) {
      // The draft's compatibility posture keys every resumable semantic on a
      // recognized version. This endpoint serves nothing else, so a missing
      // or foreign version cannot fall through and is refused with the
      // supported set named (the echo carries the newest we speak).
      return unsupportedVersion();
    }
    const wire = INTEROP_WIRE_FORMATS.get(version)!;
    const auditKey = options.auditKey?.(req);
    const uploadToken = ctx?.uploadToken ?? options.resolveToken?.(req);
    if (uploadToken === undefined) {
      // The draft allows creation via any content-carrying method; the
      // completeness-header requirement inside does the real gating.
      return handleCreation(req, version, wire, auditKey);
    }
    switch (method) {
      case "HEAD":
        return handleProbe(req, uploadToken, version, wire, auditKey);
      case "PATCH":
        return handleAppend(req, uploadToken, version, wire, auditKey);
      case "DELETE":
        return handleCancel(req, uploadToken, version, wire, auditKey);
      default:
        return textResponse(405, "method not allowed on an upload resource", {
          [INTEROP_VERSION_HEADER]: String(version),
          Allow: "HEAD, PATCH, DELETE, OPTIONS",
        });
    }
  }

  return async function handleUpload(req, ctx): Promise<Response> {
    try {
      return await dispatch(req, ctx);
    } catch (err) {
      // Nothing protocol-level throws (outcomes carry every failure); this
      // is the last-resort seam for hostile inputs and caller-supplied
      // callbacks, honoring the never-throw contract of the handler.
      onError?.(err, { uploadToken: ctx?.uploadToken, operation: "handle" });
      return textResponse(500, "upload handler failure");
    }
  };
}

// ─── Shared upload surface (re-exported for consumers) ──────────────────────
// The write-store contract, errors, locking, and the dialect-agnostic
// orchestrator (for custom wire dialects), so consumers never import
// internal module paths.
export {
  UploadNotFoundError,
  UploadOffsetConflictError,
  UploadDigestMismatchError,
  isUploadNotFoundError,
  isUploadOffsetConflictError,
  isUploadDigestMismatchError,
} from "./upload-store.ts";
export type {
  ResumableWriteStore,
  StoredUploadState,
  CreateUploadOptions,
  AppendChunkOptions,
  CompleteUploadOptions,
  CompletedUpload,
} from "./upload-store.ts";
export { memoryUploadLocker, UploadLockTimeoutError } from "./upload-locker.ts";
export type { UploadLocker, UploadLock } from "./upload-locker.ts";
export { createUploadOrchestrator } from "./upload-orchestrator.ts";
export type {
  UploadOrchestrator,
  UploadOrchestratorOptions,
  UploadOutcome,
  UploadResourceEvent,
  CreateUploadRequest,
  AppendUploadRequest,
} from "./upload-orchestrator.ts";
export type { UploadPolicy, UploadAuditEvent } from "./upload-engine.ts";
