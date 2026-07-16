/**
 * tus 1.0 wire dialect for partial-content resumable uploads.
 *
 * Translates tus 1.0 requests (core protocol + creation, creation-with-upload,
 * creation-defer-length, termination, and expiration extensions) into upload
 * orchestrator calls, and orchestrator outcomes back into tus statuses and
 * headers. The dialect never touches storage or the protocol engine directly:
 * every byte and every decision flows through the orchestrator, which owns
 * locking, fresh-state sequencing, and the post-abort grace window.
 *
 * Framework-agnostic: the handler takes a standard `Request` and returns a
 * `Response`, so it mounts under Next.js App Router, Hono, SvelteKit, Remix,
 * Cloudflare Workers, Bun.serve, Deno.serve, or plain Node fetch servers.
 *
 * Not implemented: the concatenation extension (a parallel-upload pattern
 * with substantial storage surface, outside this dialect's scope).
 * // descope: tus checksum extension (Upload-Checksum request header); the
 * // package is zero-dependency and runtime-agnostic, so per-append hashing
 * // needs a caller-injected hasher; revisit when a caller-injected hasher
 * // API lands on the orchestrator.
 *
 * @example
 * ```typescript
 * import { createTusHandler } from "partial-content/tus";
 * import { fsUploadStore } from "partial-content/fs";
 *
 * const handler = createTusHandler(store, {
 *   key: ({ metadata }) => crypto.randomUUID(),   // server-generated, never the client filename
 *   location: (token) => `/files/${token}`,
 *   maxSize: 1024 * 1024 * 1024,
 * });
 *
 * // Creation endpoint (POST /files) needs no token:
 * export async function POST(req: Request) { return handler(req); }
 * // Resource endpoint (/files/[token]) supplies it:
 * export async function PATCH(req: Request, { params }: Ctx) {
 *   return handler(req, { uploadToken: params.token });
 * }
 * ```
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
import { sanitizeHeaderValue } from "./index.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The one protocol version this dialect speaks (tus 1.0 core, Tus-Resumable). */
const TUS_VERSION = "1.0.0";

/**
 * Extensions this handler implements, advertised verbatim on OPTIONS
 * (tus 1.0 core, Tus-Extension: comma-separated, omitted when none).
 */
const TUS_EXTENSIONS = "creation,creation-with-upload,creation-defer-length,termination,expiration";

/**
 * The only Content-Type upload content may travel under, on PATCH (tus 1.0
 * core, PATCH: anything else SHOULD be answered 415) and on a creation POST
 * that carries data (creation-with-upload extension).
 */
const OFFSET_CONTENT_TYPE = "application/offset+octet-stream";

/**
 * Response hardening for every non-2xx: deny sniffing and caching, and give
 * active content no origin to execute in. Mirrors the read side's deny
 * headers so both halves of the package fail closed identically.
 */
const DENY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
} as const;

/** One reusable UTF-8 encoder for plain-text error bodies. */
const UTF8_ENCODER = new TextEncoder();
/** Fatal decoder: a metadata value that is not valid UTF-8 is rejected, not laundered. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Strict standard base64 (RFC 4648 Section 4, what the Upload-Metadata value
 * encoding means): full quantums with canonical padding. Rejecting sloppy
 * variants here keeps a malformed header a loud 400 instead of silently
 * storing garbage metadata.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Metadata keys per the creation extension: non-empty, no spaces, no commas.
 * Tightened to printable ASCII (the spec's SHOULD) so a key can never smuggle
 * control bytes into stores or logs.
 */
const METADATA_KEY_RE = /^[\x21-\x2b\x2d-\x7e]+$/;

// ─── Options ─────────────────────────────────────────────────────────────────

/** What the {@link TusHandlerOptions.key} callback sees for a creation request. */
export interface TusCreation {
  /** Parsed, base64-decoded Upload-Metadata pairs (empty object when absent). */
  metadata: Record<string, string>;
  /** The raw creation request (for auth context, URL, tenant headers). */
  request: Request;
}

/**
 * Options for {@link createTusHandler}. Policy bounds may be given flat
 * (`maxSize: n`) or as a {@link UploadPolicy} object; flat fields win.
 */
export interface TusHandlerOptions extends UploadPolicy {
  /**
   * Decide the final storage key for a new upload. The callback receives the
   * client's decoded metadata (commonly `filename`/`filetype`) plus the raw
   * request, and the SERVER decides the key. Never derive the key from the
   * client filename verbatim: a caller-controlled key is a path/overwrite
   * primitive. Generate an opaque id and keep the filename as metadata.
   */
  key: (creation: TusCreation) => string;
  /**
   * Build the `Location` header value for a created upload resource from its
   * token (absolute or path-relative URL, RFC 9110 Section 10.2.2).
   */
  location: (uploadToken: string) => string;
  /**
   * Extract the upload token from a resource request when the caller does not
   * pass `ctx.uploadToken` (e.g. parse it from the URL path). Return
   * `undefined` for "no token here": the request is answered 404.
   */
  resolveToken?: (req: Request) => string | undefined;
  /**
   * Audit-safe identifier reported on upload events instead of the raw
   * token. Called per resource request (HEAD/PATCH/DELETE). Creation events
   * fire before any token exists to map, so they carry only the token; the
   * `metadata` parameter is reserved for callers that derive audit ids from
   * creation metadata via their own `onUploadEvent` correlation.
   */
  auditKey?: (uploadToken: string, metadata?: Record<string, string>) => string;
  /** Policy object form; flat {@link UploadPolicy} fields on these options win. */
  policy?: UploadPolicy;
  /** Lock provider, passed to the orchestrator. */
  locker?: UploadLocker;
  /** Structured, content-free audit events, passed to the orchestrator. */
  onUploadEvent?: (event: UploadResourceEvent) => void;
  /**
   * Error sink for storage failures, throwing hooks, and dialect-level
   * failures (a throwing `key`/`location`/`resolveToken` callback reports
   * with operation `"handler"`). Must not throw.
   */
  onError?: (error: unknown, context: { uploadToken?: string; operation: string }) => void;
  /** Post-abort flush window in ms, passed to the orchestrator. */
  graceMs?: number;
  /** Clock injection (tests), passed to the orchestrator and used for Upload-Expires. */
  now?: () => number;
  /**
   * Extra headers applied to EVERY response (CORS exposure, tracing).
   * Protocol headers win on collision: an extra header can never overwrite
   * `Tus-Resumable`, `Upload-Offset`, or a hardening header.
   */
  extraHeaders?: Record<string, string>;
}

// ─── Header parsing ──────────────────────────────────────────────────────────

/**
 * Parse a header that must be a non-negative integer when present.
 * `undefined` = absent, `null` = present but malformed (a 400, never a guess).
 */
function parseNonNegativeInt(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decode one base64 Upload-Metadata value to a UTF-8 string, or null if malformed. */
function decodeBase64Utf8(value: string): string | null {
  if (!BASE64_RE.test(value)) return null;
  let raw: string;
  try {
    raw = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    // The tus creation extension allows arbitrary binary metadata values;
    // this handler stores metadata as strings, so values must be UTF-8.
    // Rejecting loudly beats storing a lossily re-encoded value.
    return null;
  }
}

/**
 * Parse an Upload-Metadata header (creation extension): comma-separated
 * pairs, key and base64 value separated by one space, keys unique and
 * non-empty without spaces/commas, value optionally omitted when empty.
 * Returns `null` when malformed (the caller answers 400). An absent or
 * empty header parses to no metadata: real clients omit the header rather
 * than send zero pairs, so leniency here breaks nothing.
 */
export function parseUploadMetadata(header: string | null): Record<string, string> | null {
  if (header === null) return {};
  const trimmed = header.trim();
  if (trimmed === "") return {};
  const out = new Map<string, string>();
  for (const rawPair of trimmed.split(",")) {
    const pair = rawPair.trim();
    if (pair === "") return null;
    const parts = pair.split(" ");
    if (parts.length > 2) return null;
    const key = parts[0]!;
    if (!METADATA_KEY_RE.test(key) || out.has(key)) return null;
    const value = parts.length === 2 ? decodeBase64Utf8(parts[1]!) : "";
    if (value === null) return null;
    out.set(key, value);
  }
  return Object.fromEntries(out);
}

/** True when a Content-Type's essence is the tus upload content type. */
function isOffsetOctetStream(contentType: string | null): boolean {
  if (contentType === null) return false;
  const semi = contentType.indexOf(";");
  const essence = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  return essence === OFFSET_CONTENT_TYPE;
}

/** RFC 7231 IMF-fixdate for Upload-Expires (expiration extension). */
function imfFixdate(epochMs: number): string {
  return new Date(epochMs).toUTCString();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Create a tus 1.0 upload handler over a {@link ResumableWriteStore}.
 *
 * The returned function never throws and never leaks backend details to the
 * client: storage failures become hardened 502 responses and are reported to
 * `onError`. Creation POSTs need no token; resource requests (HEAD, PATCH,
 * DELETE) take it from `ctx.uploadToken` or `options.resolveToken`.
 */
export function createTusHandler(
  store: ResumableWriteStore,
  options: TusHandlerOptions,
) {
  // Effective policy: object form first, flat fields override.
  const policy: UploadPolicy = { ...options.policy };
  if (options.maxSize !== undefined) policy.maxSize = options.maxSize;
  if (options.minSize !== undefined) policy.minSize = options.minSize;
  if (options.maxAppendSize !== undefined) policy.maxAppendSize = options.maxAppendSize;
  if (options.minAppendSize !== undefined) policy.minAppendSize = options.minAppendSize;
  if (options.maxAgeSeconds !== undefined) policy.maxAgeSeconds = options.maxAgeSeconds;

  const now = options.now ?? Date.now;
  const onError = options.onError;
  const orchestrator = createUploadOrchestrator(store, {
    policy,
    locker: options.locker,
    onUploadEvent: options.onUploadEvent,
    onError,
    graceMs: options.graceMs,
    now,
  });
  const maxSize = orchestrator.policy.maxSize;
  const maxAgeSeconds = orchestrator.policy.maxAgeSeconds;
  const extraHeaders = options.extraHeaders;

  /** Compose a response: caller extras first, protocol headers win. */
  function respond(
    status: number,
    statusText: string,
    headers: Record<string, string>,
    body: Uint8Array | null = null,
  ): Response {
    return new Response(body, {
      status,
      statusText,
      headers: extraHeaders ? { ...extraHeaders, ...headers } : headers,
    });
  }

  /**
   * Hardened error response: plain-text body (suppressed for HEAD, which is
   * bodyless by definition), deny headers, and the protocol version echo.
   */
  function errorResponse(
    status: number,
    statusText: string,
    message: string,
    opts: { isHead?: boolean; headers?: Record<string, string> } = {},
  ): Response {
    const body = opts.isHead ? null : UTF8_ENCODER.encode(message);
    return respond(status, statusText, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(body === null ? 0 : body.byteLength),
      ...DENY_HEADERS,
      ...opts.headers,
      "Tus-Resumable": TUS_VERSION,
    }, body);
  }

  /**
   * Map a non-success orchestrator outcome to its tus status.
   * - offset-mismatch: 409 without modifying the resource (tus 1.0 core,
   *   PATCH). The client's recovery is a HEAD re-probe, so no offset header
   *   rides the 409 (the spec defines none there).
   * - gone (expired/invalidated): 410, the expiration extension's SHOULD
   *   (404 or 410) with the more truthful of the two.
   * - not-found: 404 without Upload-Offset (tus 1.0 core, HEAD).
   * - size-exceeded / append-too-large: 413 (creation extension MUST for
   *   Upload-Length over Tus-Max-Size; same class for oversized appends),
   *   carrying Tus-Max-Size when one is configured.
   * - other policy floors and length conflicts: 400 (no tus-defined status;
   *   the creation-defer-length extension forbids changing a set length).
   * - contended: 423, kept distinct from 409 so retry-later never looks like
   *   re-probe-now.
   * - store-error: hardened 502, details only to `onError`.
   */
  function rejectResponse(outcome: UploadOutcome, isHead: boolean): Response {
    switch (outcome.kind) {
      case "not-found":
        return errorResponse(404, "Not Found", "upload not found", { isHead });
      case "gone":
        return errorResponse(410, "Gone", `upload ${outcome.reason}`, { isHead });
      case "offset-mismatch":
        return errorResponse(409, "Conflict", "mismatched Upload-Offset", { isHead });
      case "length-inconsistent":
        return errorResponse(400, "Bad Request", "inconsistent upload length", { isHead });
      case "limit-violation":
        if (outcome.reason === "size-exceeded" || outcome.reason === "append-too-large") {
          return errorResponse(413, "Request Entity Too Large", "maximum size exceeded", {
            isHead,
            headers: maxSize !== undefined ? { "Tus-Max-Size": String(maxSize) } : undefined,
          });
        }
        return errorResponse(400, "Bad Request", "upload violates a size policy", { isHead });
      case "contended":
        return errorResponse(423, "Locked", "upload is currently locked by another request", { isHead });
      case "store-error":
        return errorResponse(502, "Bad Gateway", "storage backend error", { isHead });
      default:
        // Success kinds are handled by each method before mapping, and
        // digest-mismatch is unreachable while the checksum extension is
        // descoped (this dialect never asserts a digest). Reaching here is
        // an internal invariant breach: fail closed, never mislabel it as a
        // client error.
        return errorResponse(500, "Internal Server Error", "internal error", { isHead });
    }
  }

  /**
   * tus completion is IMPLICIT: an upload is complete the moment its offset
   * reaches its length, with no completion flag on the wire. The store model
   * publishes atomically on an explicit complete, so when an append lands
   * exactly at the length without having been marked completing (an aborted
   * body whose bytes all flushed inside the grace window, or a body that
   * out-delivered its stated Content-Length), a zero-content completing
   * append publishes the assembled object. Without this, a client that saw
   * `Upload-Offset` equal to its length would stop, satisfied, while the
   * object was never made visible to readers.
   */
  async function healImplicitCompletion(
    uploadToken: string,
    offset: number,
    auditKey: string | undefined,
  ): Promise<UploadOutcome> {
    // Deliberately unsignalled: the trigger case IS a vanished client (an
    // aborted request whose bytes all flushed), and the publish must not be
    // cancelled by the very abort that made it necessary.
    return orchestrator.append(uploadToken, {
      offset,
      contentLength: 0,
      complete: true,
      auditKey,
    });
  }

  // ── Method handlers ──

  /** OPTIONS: capability discovery (tus 1.0 core, OPTIONS: 204, no version gate). */
  function handleOptions(): Response {
    const headers: Record<string, string> = {
      "Tus-Resumable": TUS_VERSION,
      "Tus-Version": TUS_VERSION,
      "Tus-Extension": TUS_EXTENSIONS,
    };
    if (maxSize !== undefined) headers["Tus-Max-Size"] = String(maxSize);
    return respond(204, "No Content", headers);
  }

  /** POST: creation (+ creation-with-upload, creation-defer-length). */
  async function handleCreate(req: Request): Promise<Response> {
    const declaredLength = parseNonNegativeInt(req.headers.get("upload-length"));
    if (declaredLength === null) {
      return errorResponse(400, "Bad Request", "invalid Upload-Length header");
    }
    const deferHeader = req.headers.get("upload-defer-length");
    if (deferHeader !== null && deferHeader !== "1") {
      // Upload-Defer-Length takes no value but 1 (creation-defer-length extension).
      return errorResponse(400, "Bad Request", "invalid Upload-Defer-Length header");
    }
    // Exactly one of Upload-Length / Upload-Defer-Length (creation extension MUST).
    if ((declaredLength !== undefined) === (deferHeader !== null)) {
      return errorResponse(400, "Bad Request", "creation requires exactly one of Upload-Length and Upload-Defer-Length");
    }

    const metadata = parseUploadMetadata(req.headers.get("upload-metadata"));
    if (metadata === null) {
      return errorResponse(400, "Bad Request", "invalid Upload-Metadata header");
    }

    // creation-with-upload: data rides the POST only under the offset
    // content type. A body under any OTHER type is ignored rather than
    // rejected: HTTP clients commonly force a default Content-Type, and the
    // extension keys "this is upload content" on the type alone.
    const hasContent = isOffsetOctetStream(req.headers.get("content-type")) && req.body !== null;
    const contentLength = hasContent ? parseNonNegativeInt(req.headers.get("content-length")) : undefined;
    if (contentLength === null) {
      return errorResponse(400, "Bad Request", "invalid Content-Length header");
    }

    // Implicit tus completion, decided up front where the math allows it:
    // an empty declared length completes at creation; carried content
    // completes when it provably covers the whole declared length; a body of
    // unknown size completes exactly if it delivers all declared bytes (the
    // orchestrator verifies against the durable offset after streaming).
    const complete = declaredLength !== undefined && (
      !hasContent ? declaredLength === 0
      : contentLength !== undefined ? contentLength === declaredLength
      : true
    );

    const key = options.key({ metadata, request: req });
    const outcome = await orchestrator.create({
      key,
      declaredLength,
      contentLength,
      complete,
      body: hasContent ? req.body ?? undefined : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      signal: req.signal,
    });
    if (outcome.kind !== "created") return rejectResponse(outcome, false);

    let isComplete = outcome.complete;
    if (!isComplete && declaredLength !== undefined && outcome.offset === declaredLength) {
      const healed = await healImplicitCompletion(outcome.uploadToken, outcome.offset, undefined);
      if (healed.kind !== "appended" && healed.kind !== "already-complete") {
        return rejectResponse(healed, false);
      }
      isComplete = true;
    }

    const headers: Record<string, string> = {
      "Tus-Resumable": TUS_VERSION,
      // The token is store-generated and the URL caller-built: sanitize the
      // composed value like every other computed header on the read side.
      Location: sanitizeHeaderValue(options.location(outcome.uploadToken)),
    };
    // creation-with-upload MUST report the offset after applying accepted
    // bytes; a plain creation carries no offset (there was no data).
    if (hasContent) headers["Upload-Offset"] = String(outcome.offset);
    // Expiration known at creation MUST ride the creation response
    // (expiration extension); a completed upload no longer expires.
    if (maxAgeSeconds !== undefined && !isComplete) {
      headers["Upload-Expires"] = imfFixdate(now() + maxAgeSeconds * 1000);
    }
    return respond(201, "Created", headers);
  }

  /** HEAD: offset probe (tus 1.0 core, HEAD). */
  async function handleHead(req: Request, uploadToken: string): Promise<Response> {
    const auditKey = options.auditKey?.(uploadToken);
    const outcome = await orchestrator.probe(uploadToken, { auditKey, signal: req.signal });
    if (outcome.kind !== "probed") return rejectResponse(outcome, true);

    const headers: Record<string, string> = {
      "Tus-Resumable": TUS_VERSION,
      // MUST NOT be cached (tus 1.0 core, HEAD): a cached offset poisons
      // every resume decision the client makes from it.
      "Cache-Control": "no-store",
      // Always present, zero included (tus 1.0 core, HEAD MUST).
      "Upload-Offset": String(outcome.offset),
    };
    if (outcome.length !== undefined) {
      headers["Upload-Length"] = String(outcome.length);
    } else {
      // Length still deferred: every HEAD says so (creation-defer-length MUST).
      headers["Upload-Defer-Length"] = "1";
    }
    // descope: Upload-Metadata echo on HEAD (creation extension MUST when
    // metadata was stored); the orchestrator's probed outcome does not carry
    // stored metadata and the dialect never reads the store directly;
    // revisit when the probed UploadOutcome exposes creation metadata.
    if (outcome.remainingLifetimeSeconds !== undefined && !outcome.complete) {
      headers["Upload-Expires"] = imfFixdate(now() + outcome.remainingLifetimeSeconds * 1000);
    }
    return respond(200, "OK", headers);
  }

  /** PATCH: append at offset (tus 1.0 core, PATCH; creation-defer-length length fixing). */
  async function handlePatch(req: Request, uploadToken: string): Promise<Response> {
    if (!isOffsetOctetStream(req.headers.get("content-type"))) {
      // tus 1.0 core, PATCH: all PATCH requests MUST use
      // application/offset+octet-stream; anything else is answered 415.
      return errorResponse(415, "Unsupported Media Type", "PATCH requires Content-Type: application/offset+octet-stream");
    }
    const claimedOffset = parseNonNegativeInt(req.headers.get("upload-offset"));
    if (claimedOffset === undefined || claimedOffset === null) {
      return errorResponse(400, "Bad Request", "missing or invalid Upload-Offset header");
    }
    // Upload-Length on PATCH fixes a deferred length once known
    // (creation-defer-length extension); the engine rejects any change to an
    // already-set length as inconsistent.
    const declaredLength = parseNonNegativeInt(req.headers.get("upload-length"));
    if (declaredLength === null) {
      return errorResponse(400, "Bad Request", "invalid Upload-Length header");
    }
    const contentLength = parseNonNegativeInt(req.headers.get("content-length"));
    if (contentLength === null) {
      return errorResponse(400, "Bad Request", "invalid Content-Length header");
    }

    const auditKey = options.auditKey?.(uploadToken);
    // Pre-append probe: tus has no completion flag on the wire, so whether
    // THIS append completes the upload is derived from the durable length
    // (or the length this request declares). The probe also anchors
    // Upload-Expires. It is advisory only: the engine re-validates offset,
    // length, and bounds against fresh state under the append's own lock.
    const probed = await orchestrator.probe(uploadToken, { auditKey, signal: req.signal });
    if (probed.kind !== "probed") return rejectResponse(probed, false);

    const knownLength = declaredLength ?? probed.length;
    const body = req.body ?? undefined;
    const complete = knownLength !== undefined && (
      contentLength !== undefined
        ? claimedOffset + contentLength === knownLength
        : body !== undefined
    );

    const outcome = await orchestrator.append(uploadToken, {
      offset: claimedOffset,
      contentLength,
      complete,
      declaredLength,
      body,
      auditKey,
      signal: req.signal,
    });

    // Idempotent retry of the final request: the claimed offset matched the
    // durable end of a completed upload, answered like any successful PATCH.
    if (outcome.kind === "already-complete") {
      return respond(204, "No Content", {
        "Tus-Resumable": TUS_VERSION,
        "Upload-Offset": String(claimedOffset),
      });
    }
    if (outcome.kind !== "appended") return rejectResponse(outcome, false);

    let isComplete = outcome.complete;
    if (!isComplete && knownLength !== undefined && outcome.offset === knownLength) {
      const healed = await healImplicitCompletion(uploadToken, outcome.offset, auditKey);
      if (healed.kind !== "appended" && healed.kind !== "already-complete") {
        return rejectResponse(healed, false);
      }
      isComplete = true;
    }

    // An interrupted transfer still answers 204 with the DURABLE offset: the
    // core protocol's network-failure guidance has both sides keep as much
    // transferred data as possible and resume from the stored offset. The
    // client that never reads this response re-probes with HEAD and sees the
    // same offset; one that does read it resumes without the extra HEAD.
    const headers: Record<string, string> = {
      "Tus-Resumable": TUS_VERSION,
      "Upload-Offset": String(outcome.offset),
    };
    // Every PATCH response on an upload that will expire MUST say when
    // (expiration extension). Expiry is anchored at creation, so the
    // pre-append probe's remaining lifetime still holds.
    if (probed.remainingLifetimeSeconds !== undefined && !isComplete) {
      headers["Upload-Expires"] = imfFixdate(now() + probed.remainingLifetimeSeconds * 1000);
    }
    return respond(204, "No Content", headers);
  }

  /** DELETE: termination extension (204, resource then answers 404/410). */
  async function handleDelete(req: Request, uploadToken: string): Promise<Response> {
    const auditKey = options.auditKey?.(uploadToken);
    const outcome = await orchestrator.cancel(uploadToken, { auditKey, signal: req.signal });
    if (outcome.kind !== "cancelled") return rejectResponse(outcome, false);
    return respond(204, "No Content", { "Tus-Resumable": TUS_VERSION });
  }

  return async function handleTus(
    req: Request,
    ctx?: { uploadToken?: string },
  ): Promise<Response> {
    try {
      // Method override (tus 1.0 core, X-HTTP-Method-Override): environments
      // that cannot send PATCH/DELETE tunnel them through POST. Only POST is
      // overridable; overriding GET or others has no tus meaning.
      let method = req.method.toUpperCase();
      if (method === "POST") {
        // No trimming needed: fetch Headers normalize values (leading and
        // trailing whitespace never survive into get()).
        const override = req.headers.get("x-http-method-override");
        if (override) method = override.toUpperCase();
      }

      // OPTIONS carries no version handshake: the server MUST ignore a
      // Tus-Resumable on it (tus 1.0 core, OPTIONS).
      if (method === "OPTIONS") return handleOptions();

      // Version gate for everything else (tus 1.0 core, Tus-Resumable): a
      // missing or unsupported version is answered 412 with Tus-Version and
      // the request is not processed.
      if (req.headers.get("tus-resumable") !== TUS_VERSION) {
        return errorResponse(412, "Precondition Failed", "unsupported Tus-Resumable version", {
          isHead: method === "HEAD",
          headers: { "Tus-Version": TUS_VERSION },
        });
      }

      if (method === "POST") return await handleCreate(req);

      if (method === "HEAD" || method === "PATCH" || method === "DELETE") {
        const uploadToken = ctx?.uploadToken ?? options.resolveToken?.(req);
        if (uploadToken === undefined || uploadToken === "") {
          // No token, no resource: same missing-resource answer as an
          // unknown upload URL, without Upload-Offset (tus 1.0 core, HEAD).
          return errorResponse(404, "Not Found", "upload not found", { isHead: method === "HEAD" });
        }
        if (method === "HEAD") return await handleHead(req, uploadToken);
        if (method === "PATCH") return await handlePatch(req, uploadToken);
        return await handleDelete(req, uploadToken);
      }

      return errorResponse(405, "Method Not Allowed", "method not allowed", {
        headers: { Allow: "POST, HEAD, PATCH, DELETE, OPTIONS" },
      });
    } catch (err) {
      // Never-throw contract, mirroring the read side: an escaping error (a
      // throwing key/location/resolveToken callback, a runtime body failure)
      // becomes a hardened 500 and is surfaced to onError, never to the client.
      onError?.(err, { uploadToken: ctx?.uploadToken, operation: "handler" });
      return errorResponse(500, "Internal Server Error", "internal error");
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
