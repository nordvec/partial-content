/**
 * Resumable-upload wire dialect for the IETF draft protocol
 * (draft-ietf-httpbis-resumable-upload) over the Fetch API.
 *
 * The handler speaks five draft revisions, identified by their interop
 * versions: 3 (draft-01), 5 (draft-03), 6 (draft-04 and -05), 9 (draft-12)
 * and 10 (draft-13 and -14). The older ones are what deployed
 * clients implement; the newest is what the specification says today, and a client
 * asks for whichever it speaks. Versions are a compiled allowlist, and the
 * draft forbids cross-version interop, so an unlisted version is answered 400
 * with the supported set named in the body.
 *
 * Serving several versions from one endpoint is what lets a client upgrade on
 * its own schedule rather than the server's, and the wire differences are
 * data rather than branches: one row per version in a table the handlers
 * read.
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
    type UploadKeyResult,
    type UploadPolicyResolver,
} from "./upload-orchestrator.ts";
import type { UploadPolicy } from "./upload-engine.ts";
import type { ResumableWriteStore, UploadDigestAlgorithm, UploadDigests } from "./upload-store.ts";
import { UPLOAD_ERROR_HEADERS, publishedRepresentationHeaders } from "./upload-shared.ts";
import { projectError } from "./object-store.ts";
import {
    bindAuthorize,
    intOption,
    orchestratorOptionsOf,
    policySource,
    reportHandlerFailure,
    type UploadHandlerBaseOptions,
} from "./upload-internals.ts";
import { sanitizeHeaderValue } from "./kernel.ts";
import { parseMediaType, resolveMediaType } from "./media-type.ts";

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
     * Length-inconsistency answers carry the registered problem type
     * (`inconsistent-upload-length`) as `application/problem+json`. It is
     * registered later than the offset one, so the versions that predate it get
     * a plain-text body naming the same fault.
     */
    lengthProblemDetails: boolean;
    /**
     * Offset probes announce `Upload-Length` when the total is known
     * (a MUST from draft-05 onward; earlier revisions lack the field).
     */
    probeAnnouncesLength: boolean;
    /**
     * The completeness header is REQUIRED on an append (draft-04/-05 = interop
     * 5/6). When it is required, an append missing it is a 400 rather than a
     * silent default: defaulting an absent-or-malformed completeness to
     * "completing" would publish a truncated object as done, the worst upload
     * failure. Earlier revisions (interop 3) predate the requirement and treat
     * an absent header as INCOMPLETE (never complete).
     */
    completenessRequiredOnAppend: boolean;
    /**
     * An append to an upload that is ALREADY complete may replay the completion
     * answer instead of refusing.
     *
     * Interop 3, 5 and 6 require the refusal: the server "MUST NOT modify the
     * upload resource and MUST respond with a 400 (Bad Request) status code",
     * so a client written against those versions can use the 400 to learn that
     * its upload finished. Interop 9 replaces that with the case it was getting
     * wrong, a completion whose response the client never received, and permits
     * the server to "replay the final response ... if the request to append to
     * the completed upload is valid".
     *
     * The behaviours are incompatible, so the version decides. A client that
     * wants the retry to succeed asks for interop 9.
     */
    completedAppendIsReplayable: boolean;
    /**
     * Creation and offset-retrieval answers carry `Upload-Limit`, and a
     * rejection caused by a limit carries it too. Interop 9 requires the first
     * two and recommends the third; earlier versions ask for it only on OPTIONS.
     */
    announcesLimits: boolean;
    /**
     * `GET` probes the offset alongside `HEAD`. Interop 9 admits it, noting
     * `HEAD` is preferred "since response content is not required for
     * resumption"; earlier versions define `HEAD` alone, so a `GET` there is a
     * method the resource does not implement.
     */
    getProbesOffset: boolean;
    /**
     * Offset retrieval and cancellation MUST NOT carry upload-state header
     * fields, so a request that does is refused rather than answered. Interop 3,
     * 5 and 6 impose it; interop 9 drops the requirement, and a client that
     * echoes the offset it already holds is answered there.
     *
     * A per-version rule belongs in this table and nowhere else: admitting a
     * later version is then a row, and copying a row cannot silently inherit a
     * restriction that version does not carry.
     */
    refusesUploadStateHeaders: boolean;
    /**
     * A 2xx answer with an incomplete upload acknowledges that the WHOLE
     * request content was received (draft-13), so a creation or append that
     * stopped short (the client went away, a newer request preempted it, the
     * store yielded) is answered 409 with the durable offset to resume from,
     * and a creation keeps its `Location`, the only way back to that prefix.
     * Earlier versions answer it 201 or 204 with that offset, which they permit.
     */
    interruptedContentIsConflict: boolean;
}

/** The draft-12 mapping; draft-13 differs from it only by the interrupted-content status. */
const DRAFT_12_WIRE: InteropWireFormat = {
    completenessHeader: "Upload-Complete",
    headerAssertsComplete: true,
    requiresPartialUploadMediaType: true,
    mismatchProblemDetails: true,
    probeAnnouncesLength: true,
    completenessRequiredOnAppend: true,
    completedAppendIsReplayable: true,
    lengthProblemDetails: true,
    announcesLimits: true,
    getProbesOffset: true,
    refusesUploadStateHeaders: false,
    interruptedContentIsConflict: false,
};

/**
 * The compiled interop allowlist. 3 = draft-01, 5 = draft-03, 6 = draft-04
 * and -05, 9 = draft-12, 10 = draft-13 and -14.
 *
 * Several versions are served from one endpoint because the draft's
 * negotiation is deliberately all-or-nothing: a request declares its version
 * and is answered entirely in that version's terms, and a server that does not
 * recognize the declared one is told not to announce support at all. Keeping
 * the older rows is therefore what lets a client upgrade on its own schedule
 * rather than on ours.
 */
const INTEROP_WIRE_FORMATS: ReadonlyMap<number, InteropWireFormat> = new Map([
    [
        3,
        {
            completenessHeader: "Upload-Incomplete" as const,
            headerAssertsComplete: false,
            requiresPartialUploadMediaType: false,
            mismatchProblemDetails: false,
            probeAnnouncesLength: false,
            completenessRequiredOnAppend: false,
            completedAppendIsReplayable: false,
            announcesLimits: false,
            getProbesOffset: false,
            lengthProblemDetails: false,
            refusesUploadStateHeaders: true,
            interruptedContentIsConflict: false,
        },
    ],
    [
        5,
        {
            completenessHeader: "Upload-Complete" as const,
            headerAssertsComplete: true,
            requiresPartialUploadMediaType: false,
            mismatchProblemDetails: false,
            probeAnnouncesLength: false,
            completenessRequiredOnAppend: true,
            completedAppendIsReplayable: false,
            announcesLimits: false,
            getProbesOffset: false,
            lengthProblemDetails: false,
            refusesUploadStateHeaders: true,
            interruptedContentIsConflict: false,
        },
    ],
    [
        6,
        {
            completenessHeader: "Upload-Complete" as const,
            headerAssertsComplete: true,
            requiresPartialUploadMediaType: true,
            mismatchProblemDetails: true,
            probeAnnouncesLength: true,
            completenessRequiredOnAppend: true,
            completedAppendIsReplayable: false,
            announcesLimits: false,
            getProbesOffset: false,
            lengthProblemDetails: false,
            refusesUploadStateHeaders: true,
            interruptedContentIsConflict: false,
        },
    ],
    [9, DRAFT_12_WIRE],
    [10, { ...DRAFT_12_WIRE, interruptedContentIsConflict: true }],
]);

const DEFAULT_INTEROP_VERSIONS: readonly number[] = [3, 5, 6, 9, 10];

/**
 * Serialize the effective policy as the `Upload-Limit` dictionary.
 *
 * An absent member means the server states no limit of that kind. A server
 * applying none at all still has to say so rather than send an empty field,
 * which is why `min-size` falls back to zero: an empty structured-field value
 * is not a valid dictionary, and silence about limits is what makes a client
 * guess a chunk size and get a 413. An unbounded `maxSize` is such an absent
 * member, since `Infinity` is no RFC 8941 integer.
 *
 * `maxAge` names the REMAINING lifetime of a resource that exists, counted
 * from this response, which is the field's definition. The configured
 * lifetime is the right answer only where no resource is in hand (OPTIONS);
 * anywhere a resource is known, passing its remaining seconds is what stops
 * a client from scheduling a resume for bytes that will be gone.
 */
function encodeUploadLimit(policy: UploadPolicy, maxAge?: number): string {
    const members: string[] = [];
    if (policy.maxSize !== undefined && policy.maxSize !== Infinity) members.push(`max-size=${policy.maxSize}`);
    members.push(`min-size=${policy.minSize ?? 0}`);
    if (policy.maxAppendSize !== undefined) members.push(`max-append-size=${policy.maxAppendSize}`);
    if (policy.minAppendSize !== undefined) members.push(`min-append-size=${policy.minAppendSize}`);
    const age = maxAge ?? policy.maxAgeSeconds;
    if (age !== undefined) members.push(`max-age=${Math.max(0, Math.floor(age))}`);
    return members.join(", ");
}

/** The policy members `Upload-Limit` states, each an RFC 8941 integer on the wire. */
const UPLOAD_LIMIT_BOUNDS = ["maxSize", "minSize", "maxAppendSize", "minAppendSize", "maxAgeSeconds"] as const;

/** The largest magnitude an RFC 8941 integer carries: fifteen digits. */
const RFC_8941_INTEGER_MAX = 999_999_999_999_999;

const INTEROP_VERSION_HEADER = "Upload-Draft-Interop-Version";
const STATE_HEADERS_REFUSED = "upload-state header fields are not allowed here";
const MISMATCHING_OFFSET_PROBLEM_TYPE = "https://iana.org/assignments/http-problem-types#mismatching-upload-offset";
const INCONSISTENT_LENGTH_PROBLEM_TYPE = "https://iana.org/assignments/http-problem-types#inconsistent-upload-length";

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

/** Unpadded base64 length of each verifiable digest, and the padding it takes. */
const DIGEST_BASE64: Readonly<Record<UploadDigestAlgorithm, readonly [number, string]>> = {
    "sha-256": [43, "="],
    "sha-512": [86, "=="],
};

/**
 * A client's asserted whole-representation digests, from RFC 9530
 * `Repr-Digest`, as padded raw base64 keyed by algorithm and verified at
 * completion by a store that can. Unsupported algorithms and malformed
 * members are ignored per RFC 9530; a byte sequence is kept only when its
 * length matches its algorithm. Padding is optional on the wire and always
 * present in the result, so a store compares one canonical form.
 *
 * Offered on every interop version this endpoint serves, including the ones
 * whose draft revision carries no upload-digest text of its own. RFC 9530
 * defines the field independently of any upload protocol, and honoring an
 * assertion the client volunteered cannot break a client that sends none:
 * absent means unverified, exactly as before. Dropping it on the newer
 * versions would remove an integrity guarantee from the consumers most likely
 * to want one, in exchange for nothing a client can observe.
 */
function parseReprDigest(value: string | null): UploadDigests | undefined {
    if (value === null) return undefined;
    let digests: { -readonly [A in UploadDigestAlgorithm]?: string } | undefined;
    for (const member of value.split(",")) {
        const eq = member.indexOf("=");
        const algorithm = member.slice(0, eq).trim().toLowerCase() as UploadDigestAlgorithm;
        const shape = Object.hasOwn(DIGEST_BASE64, algorithm) ? DIGEST_BASE64[algorithm] : undefined;
        const raw = /^:([A-Za-z0-9+/]+)(=*):$/.exec(member.slice(eq + 1).trim());
        if (eq === -1 || !shape || !raw || raw[1].length !== shape[0] || (raw[2] && raw[2] !== shape[1])) continue;
        (digests ??= {})[algorithm] ??= raw[1] + shape[1];
    }
    return digests;
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
    /** The effective policy the creation was accepted under. */
    policy: Readonly<UploadPolicy>;
}

export interface UploadHandlerContext {
    /** Upload token routed from the URL by the caller's framework. */
    uploadToken?: string;
}

export interface UploadHandlerOptions extends UploadHandlerBaseOptions {
    /**
     * Final storage key for the object a new upload will publish to, called
     * only once the policy accepts the creation and before anything is
     * allocated. May be async; may answer the key with the metadata to record
     * ({@link UploadKeyResolution}), or a Response that refuses the creation
     * as-is.
     */
    key: (creation: UploadCreation) => UploadKeyResult | Promise<UploadKeyResult>;
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
     * Server policy the engine enforces (sizes, append bounds, max age).
     * Required, and so is its `maxSize`: an endpoint without a size ceiling is
     * a storage-exhaustion surface, so `maxSize: Infinity` states that choice
     * explicitly and an omission is a TypeError at construction.
     *
     * A function resolves the policy per request (a tenant's quota, a plan's
     * ceiling). Each request is judged under, and its `Upload-Limit` and
     * expiry follow, the policy it resolves, so every request of one upload
     * should resolve the same one. A resolved policy is validated like a
     * static one; an invalid one fails that request with a 500 and a
     * TypeError to `onError`.
     */
    policy: (UploadPolicy & { maxSize: number }) | UploadPolicyResolver;
    /**
     * Interop versions to serve, each of which must be one this module has a
     * wire mapping for. @default [3, 5, 6, 9, 10]
     */
    interopVersions?: readonly number[];
    /**
     * Fires as soon as a creation has allocated its upload resource, before
     * the creation content is read, carrying what a `104 (Upload Resumption
     * Supported)` interim response would. `headers` is that response's field
     * set, ready to send: the interop version echo, `Location`, and
     * `Upload-Limit` where the version announces limits. The Fetch handler
     * itself can never emit interim responses; a transport that can wires
     * this hook to send the 104. Guarded: a throwing hook is routed to
     * `onError` as `resumption-hook`, scrubbed under an audit key.
     */
    onResumptionSupported?: (info: {
        uploadToken: string;
        location: string;
        interopVersion: number;
        headers: Record<string, string>;
    }) => void;
}

/** A framework-agnostic upload endpoint over Fetch primitives. */
export type UploadHandler = (req: Request, ctx?: UploadHandlerContext) => Promise<Response>;

// ─── Response builders ──────────────────────────────────────────────────────

const UTF8_ENCODER = new TextEncoder();

function textResponse(status: number, body: string, extraHeaders?: Record<string, string>): Response {
    const bytes = UTF8_ENCODER.encode(body);
    return new Response(bytes, {
        status,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": String(bytes.byteLength),
            ...UPLOAD_ERROR_HEADERS,
            ...extraHeaders,
        },
    });
}

/** An RFC 9457 problem-details answer. */
function problemResponse(status: number, headers: Record<string, string>, problem: object): Response {
    const body = UTF8_ENCODER.encode(JSON.stringify(problem));
    return new Response(body, {
        status,
        headers: { ...headers, "Content-Type": "application/problem+json", "Content-Length": String(body.byteLength) },
    });
}

/** The resumption state a response reports: where the upload ends, and whether it is done. */
/**
 * 200 for an append that completes the upload, 204 for one that leaves it
 * incomplete. `201 Created` is the status for creating the upload resource,
 * and RFC 9110 Section 15.3.2 makes a 201 without `Location` a claim that
 * this request created what the request URI names: a PATCH to a resource that
 * already existed created nothing. An append that stopped short is 409 where
 * a 2xx would acknowledge content that never arrived
 * ({@link InteropWireFormat.interruptedContentIsConflict}).
 */
function appendedStatus(wire: InteropWireFormat, outcome: { complete: boolean; interrupted: boolean }): number {
    if (outcome.complete) return 200;
    return stoppedShort(wire, outcome) ? 409 : 204;
}

/** Whether `outcome` is content this version may not acknowledge with a 2xx. */
function stoppedShort(wire: InteropWireFormat, outcome: { interrupted: boolean }): boolean {
    return outcome.interrupted && wire.interruptedContentIsConflict;
}

/**
 * Representation metadata a creation asks the completed object to retain (the
 * draft says the server SHOULD respect it; the store records it opaquely), or
 * `undefined` when the request names none.
 */
function representationMetadata(headers: Headers): Record<string, string> | undefined {
    const contentType = headers.get("Content-Type");
    const contentDisposition = headers.get("Content-Disposition");
    if (contentType === null && contentDisposition === null) return undefined;
    return {
        // Stored through the one media-type parser, so an off-grammar client
        // value (a comma list included) never becomes a stored type.
        ...(contentType !== null && { contentType: resolveMediaType(contentType).value }),
        ...(contentDisposition !== null && { contentDisposition }),
    };
}

function progress(wire: InteropWireFormat, offset: number, complete: boolean): Record<string, string> {
    return { "Upload-Offset": String(offset), [wire.completenessHeader]: encodeCompleteness(wire, complete) };
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
export function createUploadHandler(store: ResumableWriteStore, options: UploadHandlerOptions): UploadHandler {
    const versions = (options.interopVersions ?? DEFAULT_INTEROP_VERSIONS).toSorted((a, b) => a - b);
    if (versions.length === 0 || versions.some((v) => !INTEROP_WIRE_FORMATS.has(v))) {
        throw new TypeError(
            `upload handler: interopVersions must name one or more of ${[...INTEROP_WIRE_FORMATS.keys()].join(", ")}`,
        );
    }
    const supportedSet = versions.join(", ");
    const latestVersion = versions[versions.length - 1]!;
    const onError = options.onError;

    const now = options.now ?? Date.now;
    const orchestrator = createUploadOrchestrator(store, orchestratorOptionsOf(options, now));

    // Every request resolves the EFFECTIVE policy, which folds in the store's
    // own `maxAppendSize`: advertising the raw options would omit the very
    // bound a 413 was issued for, leaving the client to guess the retry size
    // the field exists to give it. Encoded without a resource it carries the
    // configured lifetime; a response about a known resource re-encodes with
    // the seconds left until that resource's deadline.
    const policyFor = policySource("createUploadHandler", options.policy, (raw) => {
        const policy = orchestrator.effectivePolicy(raw);
        // `Upload-Limit` states every bound as an RFC 8941 integer, and a parser
        // refuses the whole field on a member that is not one: the client would
        // lose every limit, not only the oversized one. An unbounded size is
        // stated by omitting the member.
        for (const name of UPLOAD_LIMIT_BOUNDS) {
            const value = policy[name];
            if (name !== "maxSize" || value !== Infinity) {
                intOption(`upload handler: policy.${name}`, value, -RFC_8941_INTEGER_MAX, RFC_8941_INTEGER_MAX);
            }
        }
        return policy;
    });

    /** Whole seconds left until a resource's deadline, or `undefined` without one. */
    function secondsUntil(expiresAt: number | undefined): number | undefined {
        return expiresAt === undefined ? undefined : (expiresAt - now()) / 1000;
    }

    /** 400 for a missing, malformed, or unlisted interop version. */
    function unsupportedVersion(): Response {
        return textResponse(400, `unsupported or missing ${INTEROP_VERSION_HEADER}; supported: ${supportedSet}`, {
            [INTEROP_VERSION_HEADER]: String(latestVersion),
        });
    }

    /**
     * The offset-mismatch answer is the protocol's retry mechanism: 409 with
     * the CORRECT offset and the true completeness, so the client re-anchors
     * without a probe round trip. Interop 6 additionally carries the
     * registered problem type with both offsets.
     */
    /**
     * A 409 always reports the upload as incomplete, whatever the resource's
     * own state is. The completeness on a conflict is the client's signal that
     * the conflict is resumable at the offset named beside it; echoing a
     * completed resource's `?1` instead tells a conforming client the
     * representation failed to process, which is terminal, and it abandons an
     * upload one correctly-offset retry would have finished.
     */
    function conflictResponse(
        version: number,
        wire: InteropWireFormat,
        correctOffset: number,
        claimedOffset: number,
    ): Response {
        const headers: Record<string, string> = {
            [INTEROP_VERSION_HEADER]: String(version),
            ...progress(wire, correctOffset, false),
            ...UPLOAD_ERROR_HEADERS,
        };
        if (!wire.mismatchProblemDetails) {
            return emptyResponse(409, { ...headers, "Content-Length": "0" });
        }
        return problemResponse(409, headers, {
            type: MISMATCHING_OFFSET_PROBLEM_TYPE,
            title: "offset from request does not match offset of resource",
            "expected-offset": correctOffset,
            "provided-offset": claimedOffset,
        });
    }

    function limitResponse(
        outcome: Extract<UploadOutcome, { kind: "limit-violation" }>,
        echo: Record<string, string>,
        wire: InteropWireFormat,
        policy: UploadPolicy,
    ): Response {
        // A rejection caused by a limit carries the limits, so the client's
        // retry aims at a number instead of guessing a smaller chunk. A body
        // stopped at this request's ceiling left its prefix durable, and an
        // incomplete non-2xx answer may say where it ends, so the client
        // resumes without a probe. A rejection about an existing resource states
        // the lifetime left until its deadline, never the configured one.
        const at = outcome.durableOffset;
        const limited = {
            ...echo,
            ...(wire.announcesLimits && {
                "Upload-Limit": encodeUploadLimit(policy, secondsUntil(outcome.expiresAt)),
            }),
            ...(at !== undefined && progress(wire, at, false)),
        };
        // Size violations are payload problems (413); the floor violations
        // are malformed requests against advertised bounds (400).
        const tooLarge = outcome.reason === "size-exceeded" || outcome.reason === "append-too-large";
        return textResponse(tooLarge ? 413 : 400, `upload rejected: ${outcome.reason}`, limited);
    }

    /**
     * Render the reject outcomes shared by every interaction. Offset
     * mismatches and idempotent completion replays are append-specific and
     * handled by the caller before this runs.
     */
    function rejectResponse(
        outcome: UploadOutcome,
        version: number,
        wire: InteropWireFormat,
        policy: UploadPolicy,
        extra?: Record<string, string>,
    ): Response {
        const echo = { [INTEROP_VERSION_HEADER]: String(version), ...extra };
        switch (outcome.kind) {
            case "refused":
                return outcome.response;
            case "limit-violation":
                return limitResponse(outcome, echo, wire, policy);
            case "length-inconsistent": {
                // A registered problem type is machine-readable where the version
                // defines one; the versions that predate the registration get the
                // same fault as plain text rather than a type they cannot resolve.
                // A prefix left durable is stated, so the client resumes it unprobed.
                const at = outcome.durableOffset;
                const resumable = { ...echo, ...(at !== undefined && progress(wire, at, false)) };
                if (!wire.lengthProblemDetails) {
                    return textResponse(400, "inconsistent length values for upload", resumable);
                }
                return problemResponse(
                    400,
                    { ...resumable, ...UPLOAD_ERROR_HEADERS },
                    { type: INCONSISTENT_LENGTH_PROBLEM_TYPE, title: "inconsistent length values for upload" },
                );
            }
            case "gone":
            case "not-found":
                // The draft folds every dead resource (unknown, cancelled, expired,
                // invalidated) into "not active": 404, empty body.
                return emptyResponse(404, { ...echo, "Content-Length": "0", ...UPLOAD_ERROR_HEADERS });
            case "contended":
                // Deliberately distinct from 409: deployed clients retry 423 as-is
                // and re-probe on 409, and contention must not trigger a re-anchor.
                return textResponse(423, "upload resource is busy", echo);
            case "digest-mismatch":
                return textResponse(400, "upload content does not match its sha-256 digest", echo);
            case "digest-unverifiable":
                return textResponse(400, "upload digest cannot be verified", echo);
            case "destination-conflict":
                // Not the offset problem type: no offset the client could send
                // resolves it, so a client must not re-anchor and retry.
                return textResponse(409, "upload destination changed; nothing was published", echo);
            case "store-error":
                return textResponse(500, "upload storage failure", echo);
            default:
                // An action outcome leaking here is a dialect bug: report it, never
                // throw it at the transport.
                onError?.(new Error(`upload handler: unexpected outcome ${outcome.kind}`), { operation: "render" });
                return textResponse(500, "upload handler failure", echo);
        }
    }

    /**
     * The 400 for a probe or cancel that carries upload-state headers the
     * version it speaks refuses ({@link InteropWireFormat.refusesUploadStateHeaders}),
     * or undefined when it carries none. Presence is judged on PARSED values: a
     * malformed field is ignored by the structured-field rules, so it does not
     * count as present.
     */
    function refuseStateHeaders(req: Request, wire: InteropWireFormat, echo: Record<string, string>) {
        if (!wire.refusesUploadStateHeaders) return undefined;
        const carries =
            parseStructuredBoolean(req.headers.get(wire.completenessHeader)) !== undefined ||
            parseStructuredInteger(req.headers.get("Upload-Offset")) !== undefined ||
            parseStructuredInteger(req.headers.get("Upload-Length")) !== undefined;
        return carries ? textResponse(400, STATE_HEADERS_REFUSED, echo) : undefined;
    }

    /**
     * Hand the caller its resumption handle, and contain a hook that throws.
     *
     * A throwing caller hook reaches the same sink as every other failure, so it
     * is scrubbed on the same terms: with an audit key in force the token is a
     * bearer capability that must not reach a log, and what the hook threw
     * routinely quotes the location it was handed, which is built from that
     * token. Without an audit key there is nothing to substitute and the token
     * stays in the context, exactly as on the other reporting seams.
     */
    function notifyResumptionSupported(
        uploadToken: string,
        version: number,
        wire: InteropWireFormat,
        policy: UploadPolicy,
        auditKey: string | undefined,
    ): void {
        if (!options.onResumptionSupported) return;
        try {
            const location = sanitizeHeaderValue(options.location(uploadToken));
            const headers: Record<string, string> = {
                [INTEROP_VERSION_HEADER]: String(version),
                Location: location,
                ...(wire.announcesLimits && { "Upload-Limit": encodeUploadLimit(policy) }),
            };
            options.onResumptionSupported({ uploadToken, location, interopVersion: version, headers });
        } catch (err) {
            if (options.auditKey === undefined) onError?.(err, { uploadToken, operation: "resumption-hook" });
            else onError?.(projectError(err, "resumption-hook"), { auditKey, operation: "resumption-hook" });
        }
    }

    async function handleCreation(
        req: Request,
        version: number,
        wire: InteropWireFormat,
        policy: UploadPolicy,
    ): Promise<Response> {
        const echo = { [INTEROP_VERSION_HEADER]: String(version) };
        let auditKey: string | undefined;
        // The completeness header is what MAKES a request an upload creation in
        // the draft's model. This endpoint serves nothing but uploads, so a
        // creation without it cannot fall through to non-resumable handling and
        // is answered 400 instead.
        const completenessValue = parseStructuredBoolean(req.headers.get(wire.completenessHeader));
        if (completenessValue === undefined) {
            return textResponse(400, `upload creation requires the ${wire.completenessHeader} header field`, echo);
        }
        // Creations carry no offset (deployed servers tolerate an explicit 0).
        const offset = parseStructuredInteger(req.headers.get("Upload-Offset"));
        if (offset !== undefined && offset !== 0) {
            return textResponse(400, "upload creation must start at Upload-Offset 0", echo);
        }
        const complete = decodeCompleteness(wire, completenessValue);
        const declaredLength = parseStructuredInteger(req.headers.get("Upload-Length"));

        const outcome = await orchestrator.create({
            key: () =>
                options.key({
                    request: req,
                    interopVersion: version,
                    declaredLength,
                    complete,
                    policy,
                }),
            declaredLength,
            contentLength: parseContentLength(req.headers.get("Content-Length")),
            complete,
            body: req.body ?? undefined,
            metadata: representationMetadata(req.headers),
            expectedDigests: parseReprDigest(req.headers.get("Repr-Digest")),
            auditKey: options.auditKey && ((t) => (auditKey = options.auditKey!({ request: req, uploadToken: t }))),
            onAllocated: (t) => notifyResumptionSupported(t, version, wire, policy, auditKey),
            signal: req.signal,
            policy,
        });
        if (outcome.kind !== "created") {
            // A rejection that names a resource landed AFTER creation allocated it,
            // so bytes may already be durable. The Location is how the client
            // resumes them or deletes them; without it they are unreachable and
            // only a sweep (optional, and meaningless with no max age) reclaims them.
            const stranded = "uploadToken" in outcome ? outcome.uploadToken : undefined;
            return rejectResponse(
                outcome,
                version,
                wire,
                policy,
                stranded === undefined ? undefined : { Location: sanitizeHeaderValue(options.location(stranded)) },
            );
        }

        // A caller's location() output is header-sanitized like every other
        // caller-derived header value (the tus dialect does the same): a stray
        // CR/LF cannot split the response, it is stripped.
        const location = sanitizeHeaderValue(options.location(outcome.uploadToken));
        const short = stoppedShort(wire, outcome);
        return emptyResponse(short ? 409 : 201, {
            ...echo,
            Location: location,
            ...progress(wire, outcome.offset, outcome.complete),
            ...(short && UPLOAD_ERROR_HEADERS),
            // The lifetime left on the resource just created, which streaming the
            // creation's body has already spent part of. A completed upload has
            // nothing left to append, so no limit applies to it.
            ...(wire.announcesLimits &&
                !outcome.complete && {
                    "Upload-Limit": encodeUploadLimit(policy, secondsUntil(outcome.expiresAt)),
                }),
            // A creation that also completed published an object; the response that
            // announces it describes it, with the same validator and digest the read
            // side serves for the rest of that object's life. Empty for a creation
            // that left the upload incomplete, which carries neither.
            ...publishedRepresentationHeaders(outcome),
        });
    }

    async function handleProbe(
        req: Request,
        uploadToken: string,
        version: number,
        wire: InteropWireFormat,
        auditKey: string | undefined,
        policy: UploadPolicy,
    ): Promise<Response> {
        const echo = { [INTEROP_VERSION_HEADER]: String(version) };
        const refused = refuseStateHeaders(req, wire, echo);
        if (refused) return refused;
        const outcome = await orchestrator.probe(uploadToken, {
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "probe"),
            policy,
        });
        if (outcome.kind !== "probed") return rejectResponse(outcome, version, wire, policy);
        const headers: Record<string, string> = {
            ...echo,
            ...progress(wire, outcome.offset, outcome.complete),
            // A cached offset answer would re-anchor a client on stale truth.
            "Cache-Control": "no-store",
        };
        if (wire.probeAnnouncesLength && outcome.length !== undefined) {
            headers["Upload-Length"] = String(outcome.length);
        }
        if (wire.announcesLimits) {
            headers["Upload-Limit"] = encodeUploadLimit(policy, secondsUntil(outcome.expiresAt));
        }
        return emptyResponse(204, headers);
    }

    async function handleAppend(
        req: Request,
        uploadToken: string,
        version: number,
        wire: InteropWireFormat,
        auditKey: string | undefined,
        policy: UploadPolicy,
    ): Promise<Response> {
        const echo = { [INTEROP_VERSION_HEADER]: String(version) };
        if (wire.requiresPartialUploadMediaType) {
            const mediaType = req.headers.get("Content-Type");
            if (parseMediaType(mediaType)?.essence !== "application/partial-upload") {
                return textResponse(400, "upload append requires Content-Type: application/partial-upload", echo);
            }
        }
        // Malformed structured fields are ignored, so a garbled offset lands
        // here as "absent", and an append without an offset is unprocessable.
        const offset = parseStructuredInteger(req.headers.get("Upload-Offset"));
        if (offset === undefined) {
            return textResponse(400, "upload append requires the Upload-Offset header field", echo);
        }
        // Completeness must fail CLOSED, never open: defaulting an absent or
        // malformed completeness header to "completing" would publish a truncated
        // object as done (worst case: a deferred-length upload where the engine's
        // length sums cannot catch it). A present-but-unparseable value is a
        // client error (400) at every version; an ABSENT header is a 400 where
        // the revision requires it (interop 5/6) and INCOMPLETE where it does not
        // (interop 3), never complete.
        const completenessRaw = req.headers.get(wire.completenessHeader);
        const completenessValue = parseStructuredBoolean(completenessRaw);
        if (completenessValue === undefined) {
            if (completenessRaw !== null || wire.completenessRequiredOnAppend) {
                return textResponse(
                    400,
                    `upload append requires a valid ${wire.completenessHeader} header field`,
                    echo,
                );
            }
        }
        const complete = completenessValue === undefined ? false : decodeCompleteness(wire, completenessValue);

        const outcome = await orchestrator.append(uploadToken, {
            offset,
            contentLength: parseContentLength(req.headers.get("Content-Length")),
            complete,
            declaredLength: parseStructuredInteger(req.headers.get("Upload-Length")),
            body: req.body ?? undefined,
            expectedDigests: parseReprDigest(req.headers.get("Repr-Digest")),
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "append"),
            policy,
        });
        switch (outcome.kind) {
            case "appended":
                return emptyResponse(appendedStatus(wire, outcome), {
                    ...echo,
                    ...progress(wire, outcome.offset, outcome.complete),
                    ...(stoppedShort(wire, outcome) && UPLOAD_ERROR_HEADERS),
                    // Present only on the append that completed the upload: that is the
                    // one that published an object to describe.
                    ...publishedRepresentationHeaders(outcome),
                });
            case "already-complete":
                // The engine answers this only for a request whose claimed offset IS
                // the durable offset and which carries no content, so it is a retry of
                // a completion whose response the client never received. That is the
                // VALID append to a completed upload of draft-12 Section 4.4.2, the
                // condition on replaying the final response; one carrying content is
                // refused instead, since the length is fixed at completion and the
                // offset may never exceed it. Whether even a valid retry may be
                // replayed is the version's decision, not ours: replaying where the
                // version requires a refusal would deny a client the signal it uses to
                // learn the upload finished.
                if (!wire.completedAppendIsReplayable) {
                    return textResponse(400, "upload is already complete", echo);
                }
                return emptyResponse(200, { ...echo, ...progress(wire, offset, true) });
            case "offset-mismatch":
                return conflictResponse(version, wire, outcome.correctOffset, outcome.claimedOffset);
            default:
                return rejectResponse(outcome, version, wire, policy);
        }
    }

    async function handleCancel(
        req: Request,
        uploadToken: string,
        version: number,
        wire: InteropWireFormat,
        auditKey: string | undefined,
        policy: UploadPolicy,
    ): Promise<Response> {
        const echo = { [INTEROP_VERSION_HEADER]: String(version) };
        const refused = refuseStateHeaders(req, wire, echo);
        if (refused) return refused;
        const outcome = await orchestrator.cancel(uploadToken, {
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "cancel"),
        });
        if (outcome.kind !== "cancelled") return rejectResponse(outcome, version, wire, policy);
        return emptyResponse(204, echo);
    }

    async function dispatch(req: Request, ctx?: UploadHandlerContext): Promise<Response> {
        const method = req.method.toUpperCase();
        if (method === "OPTIONS") {
            // Standard method discovery (RFC 9110 Section 8.6); version-agnostic,
            // because a client discovering the endpoint has not yet negotiated one.
            //
            // The limits ride along: this target creates upload resources, and a
            // client asks precisely so it can size its first request instead of
            // discovering a ceiling by being refused at one. A version that does not
            // define the field ignores it, which is what makes it safe to answer
            // before the version is known.
            return emptyResponse(204, {
                Allow: "POST, HEAD, PATCH, DELETE, OPTIONS",
                "Upload-Limit": encodeUploadLimit(await policyFor(req)),
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
        const policy = await policyFor(req);
        const uploadToken = ctx?.uploadToken ?? options.resolveToken?.(req);
        const methodNotAllowed = (allow?: string) =>
            textResponse(405, "method not allowed", {
                [INTEROP_VERSION_HEADER]: String(version),
                Allow:
                    allow ??
                    (wire.getProbesOffset ? "GET, HEAD, PATCH, DELETE, OPTIONS" : "HEAD, PATCH, DELETE, OPTIONS"),
            });
        if (uploadToken === undefined) {
            // draft-ietf-httpbis-resumable-upload-13 Section 4.2.1: a creation is a
            // request that can carry content, "such as POST, PUT, and PATCH". Any
            // other method names no resource and must not create one: a tokenless
            // DELETE or GET would otherwise publish an empty object.
            if (!/^(POST|PUT|PATCH)$/.test(method)) return methodNotAllowed("POST, PUT, PATCH, OPTIONS");
            return handleCreation(req, version, wire, policy);
        }
        const auditKey = options.auditKey?.({ request: req, uploadToken });
        switch (method) {
            case "GET":
                // A GET that reaches an upload resource is an offset probe on the
                // versions that define one, and a method the resource does not
                // implement on the versions that do not.
                return wire.getProbesOffset
                    ? handleProbe(req, uploadToken, version, wire, auditKey, policy)
                    : methodNotAllowed();
            case "HEAD":
                return handleProbe(req, uploadToken, version, wire, auditKey, policy);
            case "PATCH":
                return handleAppend(req, uploadToken, version, wire, auditKey, policy);
            case "DELETE":
                return handleCancel(req, uploadToken, version, wire, auditKey, policy);
            default:
                return methodNotAllowed();
        }
    }

    return async function handleUpload(req, ctx): Promise<Response> {
        try {
            return await dispatch(req, ctx);
        } catch (err) {
            // Nothing protocol-level throws (outcomes carry every failure); this
            // is the last-resort seam for hostile inputs and caller-supplied
            // callbacks, honoring the never-throw contract of the handler.
            //
            reportHandlerFailure(options, req, ctx?.uploadToken, err);
            return textResponse(500, "upload handler failure");
        }
    };
}

// ─── Shared upload surface (re-exported for consumers) ──────────────────────
// The write-store contract, errors, locking, and the dialect-agnostic
// orchestrator, from one shared module so /tus and /upload never diverge.
/**
 * The IETF resumable-uploads dialect's counterpart of the tus
 * `TUS_EXPOSED_HEADERS` list: the response headers a cross-origin
 * client must be allowed to read across every supported interop version.
 */
export const UPLOAD_EXPOSED_HEADERS: readonly string[] = Object.freeze([
    "Location",
    "Upload-Offset",
    "Upload-Length",
    "Upload-Complete",
    "Upload-Incomplete",
    "Upload-Draft-Interop-Version",
    "Upload-Limit",
    "ETag",
    "Repr-Digest",
]);

export * from "./upload-shared.ts";
