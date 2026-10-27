/**
 * tus 1.0 wire dialect for partial-content resumable uploads.
 *
 * Translates tus 1.0 requests (core protocol + the creation,
 * creation-with-upload, creation-defer-length, and termination extensions,
 * plus expiration and checksum when configured) into upload orchestrator
 * calls, and orchestrator outcomes back into tus statuses and headers. The
 * advertised extension set is honest: `expiration` appears only when a max age
 * is set, `checksum` only when a verifier is supplied. The dialect never
 * touches storage or the protocol engine directly:
 * every byte and every decision flows through the orchestrator, which owns
 * locking, fresh-state sequencing, and the post-abort grace window.
 *
 * Framework-agnostic: the handler takes a standard `Request` and returns a
 * `Response`, so it mounts under Next.js App Router, Hono, SvelteKit, Remix,
 * Cloudflare Workers, Bun.serve, Deno.serve, or plain Node fetch servers.
 *
 * Not implemented: the concatenation extension (a parallel-upload pattern
 * with substantial storage surface, outside this dialect's scope).
 * // descope: the checksum-trailer variant (Upload-Checksum as an HTTP
 * // trailer); fetch Requests expose no portable trailer API across the
 * // runtimes this package supports; revisit when WHATWG fetch grows one.
 *
 * @example
 * ```typescript
 * import { createTusHandler } from "partial-content/tus";
 * import { fsUploadStore } from "partial-content/fs";
 *
 * const handler = createTusHandler(store, {
 *   key: ({ metadata }) => crypto.randomUUID(),   // server-generated, never the client filename
 *   location: (token) => `/files/${token}`,
 *   policy: { maxSize: 1024 * 1024 * 1024 },
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
    type UploadAuthorizer,
    type UploadOutcome,
    type UploadKeyResult,
    type UploadPolicyResolver,
} from "./upload-orchestrator.ts";
import type { UploadPolicy } from "./upload-engine.ts";
import type { ResumableWriteStore } from "./upload-store.ts";
import { UPLOAD_ERROR_HEADERS, publishedRepresentationHeaders, type PublishedRepresentation } from "./upload-shared.ts";
import { sanitizeHeaderValue } from "./index.ts";
import { parseMediaType } from "./media-type.ts";
import {
    bindAuthorize,
    bytesToBase64,
    intOption,
    orchestratorOptionsOf,
    policySource,
    reportHandlerFailure,
    type UploadHandlerBaseOptions,
} from "./upload-internals.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The one protocol version this dialect speaks (tus 1.0 core, Tus-Resumable). */
const TUS_VERSION = "1.0.0";

/**
 * Extensions this handler ALWAYS implements, regardless of configuration
 * (tus 1.0 core, Tus-Extension: comma-separated, omitted when none). Two more
 * are advertised conditionally: `expiration` only when a max age is configured
 * (advertising it with nothing to expire is a false capability), and
 * `checksum` only when a checksum verifier is supplied.
 */
const TUS_BASE_EXTENSIONS = "creation,creation-with-upload,creation-defer-length,termination";

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

// ─── Checksum extension ──────────────────────────────────────────────────────

/**
 * Per-request integrity verification (tus checksum extension,
 * `Upload-Checksum: <algorithm> <base64>`). The dialect BUFFERS a
 * checksummed request's content and verifies it before any byte reaches the
 * store: the extension's "the chunk MUST be discarded" on mismatch is only
 * honest when unverified bytes were never made durable. The buffer is hard-
 * capped (`maxBufferBytes`, defaulting to the effective max append size), so
 * a caller always bounds the memory cost explicitly.
 */
export interface TusChecksumOptions {
    /**
     * Algorithm tokens accepted (the extension's tokens: `sha1`, `md5`, ...).
     * Matched case-insensitively and advertised via `Tus-Checksum-Algorithm`
     * in lower case. Must be non-empty, and each entry an RFC 9110 token
     * distinct from the others ignoring case, or construction throws.
     */
    algorithms: readonly string[];
    /**
     * One-shot digest of the buffered content under an advertised algorithm,
     * named with the spelling configured in `algorithms`.
     * May be async (WebCrypto). A throwing digest is routed to `onError` and
     * answered as an internal error, never a mismatch.
     */
    digest(algorithm: string, content: Uint8Array): Uint8Array | Promise<Uint8Array>;
    /**
     * Hard cap in bytes on the verification buffer. Defaults to the effective
     * max append size (policy or store); when neither exists the handler
     * refuses construction rather than buffer unboundedly.
     */
    maxBufferBytes?: number;
}

/**
 * Ready-made {@link TusChecksumOptions} over WebCrypto (`crypto.subtle`),
 * which every supported runtime ships: covers `sha1` (the algorithm the
 * extension requires of servers) plus the SHA-2 family. Inject a custom
 * {@link TusChecksumOptions} instead when clients need `md5` or `crc32`.
 */
export function webCryptoChecksum(opts?: { maxBufferBytes?: number }): TusChecksumOptions {
    const SUBTLE_NAMES: Record<string, string> = {
        sha1: "SHA-1",
        sha256: "SHA-256",
        sha384: "SHA-384",
        sha512: "SHA-512",
    };
    return {
        algorithms: ["sha1", "sha256", "sha384", "sha512"],
        maxBufferBytes: opts?.maxBufferBytes,
        async digest(algorithm, content) {
            // subtle.digest() rejects SharedArrayBuffer-backed views (and lib.dom
            // types it so): the handler always passes a dialect-allocated buffer,
            // and a shared-backed view from any other caller is copied out first.
            const safe =
                content.buffer instanceof ArrayBuffer ? (content as Uint8Array<ArrayBuffer>) : new Uint8Array(content);
            return new Uint8Array(await crypto.subtle.digest(SUBTLE_NAMES[algorithm]!, safe));
        },
    };
}

/**
 * The configured checksum tokens keyed by lower case, the form a request
 * token is matched in. Each must be a header token distinct from the others
 * ignoring case: one that is not could never be requested, or would split the
 * advertised list.
 */
function checksumTokens(checksum: TusChecksumOptions | undefined): Map<string, string> {
    const tokens = new Map<string, string>();
    for (const algorithm of checksum?.algorithms ?? []) {
        const lower = algorithm.toLowerCase();
        if (!/^[\w!#$%&'*+.^`|~-]+$/.test(algorithm) || tokens.has(lower)) {
            throw new TypeError(`createTusHandler: checksum.algorithms entry "${algorithm}" is not a distinct token`);
        }
        tokens.set(lower, algorithm);
    }
    // tus 1.0 requires sha1 of every server that offers the checksum extension.
    if (checksum && !tokens.has("sha1")) {
        throw new TypeError("createTusHandler: checksum needs sha1");
    }
    return tokens;
}

/** What one request's resolved policy makes this dialect enforce and advertise. */
interface TusLimits {
    policy: UploadPolicy;
    /** The checksum verification buffer bound; 0 when checksums are off. */
    checksumCap: number;
    /** The `Tus-Extension` list this policy can honor. */
    extensions: string;
}

/** Parsed Upload-Checksum header: algorithm token + asserted digest bytes. */
interface ParsedChecksum {
    algorithm: string;
    digest: Uint8Array;
}

/**
 * Parse `Upload-Checksum: <algorithm> <base64>`. Returns null when malformed
 * (missing space, empty parts, or sloppy base64), which the caller answers
 * with a 400: an integrity assertion is the last header to guess about.
 */
function parseUploadChecksum(header: string): ParsedChecksum | null {
    const sp = header.indexOf(" ");
    if (sp <= 0 || sp === header.length - 1) return null;
    const algorithm = header.slice(0, sp).toLowerCase();
    const digest = decodeBase64Bytes(header.slice(sp + 1).trim());
    if (digest === null || digest.byteLength === 0) return null;
    return { algorithm, digest };
}

/** Byte equality (integrity check, not a secret comparison). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** What the {@link TusHandlerOptions.key} callback sees for a creation request. */
export interface TusCreation {
    /** Parsed, base64-decoded Upload-Metadata pairs (empty object when absent). */
    metadata: Record<string, string>;
    /** The raw creation request (for auth context, URL, tenant headers). */
    request: Request;
    /** `Upload-Length`, when the creation declared it (absent when deferred). */
    declaredLength?: number;
    /** The effective policy the creation was accepted under. */
    policy: Readonly<UploadPolicy>;
}

/**
 * Bounds on a creation's `Upload-Metadata` header. The tus 1.0 protocol sets
 * none, and every pair is decoded and handed to `key()` and the store, so an
 * unbounded header is work and storage a client chooses.
 */
export interface TusMetadataLimits {
    /** Longest header accepted, in bytes. @default 4096 */
    maxBytes?: number;
    /** Most key/value pairs accepted. @default 32 */
    maxPairs?: number;
}

/** Options for {@link createTusHandler}. */
export interface TusHandlerOptions extends UploadHandlerBaseOptions {
    /** A creation whose `Upload-Metadata` exceeds either bound is answered 400. */
    metadataLimits?: TusMetadataLimits;
    /**
     * Decide the final storage key for a new upload. The callback receives the
     * client's decoded metadata (commonly `filename`/`filetype`) plus the raw
     * request, and the SERVER decides the key. Never derive the key from the
     * client filename verbatim: a caller-controlled key is a path/overwrite
     * primitive. Generate an opaque id and keep the filename as metadata.
     */
    key: (creation: TusCreation) => UploadKeyResult | Promise<UploadKeyResult>;
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
     * Size, append and lifetime bounds this endpoint enforces.
     *
     * `minAppendSize` is refused at construction: this dialect always offers
     * `creation-defer-length`, an upload created that way has no length for
     * completion to be inferred from, and the floor's only exemption is a
     * completing append, so the floor would leave such an upload permanently
     * unable to progress.
     *
     * Required, and so is its `maxSize`: an endpoint without a size ceiling is
     * a storage-exhaustion surface, so `maxSize: Infinity` states that choice
     * explicitly and an omission is a TypeError at construction.
     *
     * A function resolves the policy per request (a tenant's quota, a plan's
     * ceiling). Each request is judged under, and its `Tus-Max-Size`,
     * `expiration` extension, `Upload-Expires` and checksum buffer bound
     * follow, the policy it resolves, so every request of one upload should
     * resolve the same one. A resolved policy is validated like a static one,
     * the refusals above included; an invalid one fails that request with a
     * 500 and a TypeError to `onError`.
     */
    policy: (UploadPolicy & { maxSize: number }) | UploadPolicyResolver;
    /**
     * Enable the tus checksum extension (per-request `Upload-Checksum`
     * verification). {@link webCryptoChecksum} covers the spec's mandatory
     * `sha1` on every supported runtime; inject custom hashing for `md5` and
     * friends. Absent: the extension is not advertised and an unsolicited
     * `Upload-Checksum` header is IGNORED, mirroring how the completion path
     * treats an integrity assertion nothing can verify (RFC 9530 posture),
     * rather than failing bytes that were never compared.
     */
    checksum?: TusChecksumOptions;
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

/** Decode strict standard base64 to bytes, or null if malformed. */
function decodeBase64Bytes(value: string): Uint8Array | null {
    if (!BASE64_RE.test(value)) return null;
    let raw: string;
    try {
        raw = atob(value);
    } catch {
        return null;
    }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}

/** Decode one base64 Upload-Metadata value to a UTF-8 string, or null if malformed. */
function decodeBase64Utf8(value: string): string | null {
    const bytes = decodeBase64Bytes(value);
    if (bytes === null) return null;
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
 * than send zero pairs, so leniency here breaks nothing. A header past
 * either of `limits` is malformed too. The result has a null prototype.
 */
export function parseUploadMetadata(header: string | null, limits?: TusMetadataLimits): Record<string, string> | null {
    // Null prototype: keys are client data, so `__proto__` or `constructor` is
    // an ordinary own entry and an absent key never reads an inherited member.
    const out: Record<string, string> = Object.create(null);
    const trimmed = (header ?? "").trim();
    if (trimmed === "") return out;
    const rawPairs = trimmed.split(",");
    if (trimmed.length > (limits?.maxBytes ?? 4096) || rawPairs.length > (limits?.maxPairs ?? 32)) return null;
    for (const rawPair of rawPairs) {
        const pair = metadataPair(rawPair);
        if (pair === null || pair[0] in out) return null;
        out[pair[0]] = pair[1];
    }
    return out;
}

/** One `key[ base64]` pair, decoded, or null if malformed. */
function metadataPair(rawPair: string): [string, string] | null {
    const parts = rawPair.trim().split(" ");
    const key = parts[0]!;
    if (parts.length > 2 || !METADATA_KEY_RE.test(key)) return null;
    const value = parts.length === 2 ? decodeBase64Utf8(parts[1]!) : "";
    return value === null ? null : [key, value];
}

/** Encode a UTF-8 string as standard base64, the Upload-Metadata value form. */
function encodeBase64Utf8(value: string): string {
    return bytesToBase64(UTF8_ENCODER.encode(value));
}

/**
 * Render stored metadata as an Upload-Metadata header value (creation
 * extension): `key <base64>` pairs joined by commas, an empty value rendered
 * as the bare key, exactly the grammar {@link parseUploadMetadata} accepts.
 * Undefined when nothing is representable, so the caller omits the header
 * rather than sending an empty one.
 *
 * A key outside the header grammar is skipped rather than emitted. Metadata
 * that arrived through this dialect cannot contain one (the parser rejects it
 * at creation), but a resource created through the other dialect or through
 * the orchestrator directly can carry any key its caller chose, and the tus
 * grammar has no escaping mechanism: a key holding a comma, a space, or a
 * control byte cannot be expressed here, and guessing an encoding for it
 * would let the value rewrite the header around it.
 */
function encodeUploadMetadata(metadata: Record<string, string>): string | undefined {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(metadata)) {
        if (!METADATA_KEY_RE.test(key)) continue;
        pairs.push(value === "" ? key : `${key} ${encodeBase64Utf8(value)}`);
    }
    return pairs.length > 0 ? pairs.join(",") : undefined;
}

/** True when a Content-Type's essence is the tus upload content type. */
function isOffsetOctetStream(contentType: string | null): boolean {
    return parseMediaType(contentType)?.essence === OFFSET_CONTENT_TYPE;
}

/**
 * `Upload-Expires` (expiration extension), an RFC 9110 Section 5.6.7
 * IMF-fixdate, on an upload that still accepts appends: a completed upload
 * does not expire, and one no max age applies to has no deadline.
 */
function setUploadExpires(headers: Record<string, string>, expiresAt: number | undefined, complete: boolean): void {
    if (expiresAt !== undefined && !complete) headers["Upload-Expires"] = new Date(expiresAt).toUTCString();
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
export function createTusHandler(store: ResumableWriteStore, options: TusHandlerOptions) {
    const now = options.now ?? Date.now;
    const onError = options.onError;
    const orchestrator = createUploadOrchestrator(store, orchestratorOptionsOf(options, now));
    const extraHeaders = options.extraHeaders;
    const checksum = options.checksum;
    const algorithms = checksumTokens(checksum);
    for (const [name, value] of Object.entries(options.metadataLimits ?? {})) {
        intOption(`createTusHandler: metadataLimits.${name}`, value, 1);
    }

    // A per-append floor has exactly one escape, an append that completes the
    // upload, and tus derives completion from a known total length. An upload
    // created under `Upload-Defer-Length` has none, so on such a resource no
    // PATCH can ever take the escape and every one of them is refused: the
    // endpoint accepts the creation and then makes progress impossible. The
    // client cannot adapt either, since tus defines no header carrying an
    // append floor, so the refusal it meets names no number to aim at.
    //
    // The refusal is unconditional because `creation-defer-length` is in this
    // dialect's base extension set: every handler this factory builds
    // advertises it and accepts such a creation, so there is no configuration
    // in which the floor stays escapable. A caller that needs one serves
    // `createUploadHandler`, whose `Upload-Limit` advertises `min-append-size`.
    //
    // The checksum verification buffer MUST be bounded (an unbounded buffer is
    // a memory amplification primitive), so a policy that leaves neither the
    // checksum options nor the append ceiling capping it is refused too.
    const limitsFor = policySource("createTusHandler", options.policy, (raw): TusLimits => {
        const policy = orchestrator.effectivePolicy(raw);
        if (policy.minAppendSize !== undefined) {
            throw new TypeError(
                "createTusHandler: policy.minAppendSize is unsupported (tus advertises no append floor)",
            );
        }
        if (policy.digestPolicy !== undefined) {
            throw new TypeError("createTusHandler: policy.digestPolicy is unsupported");
        }
        // `Upload-Expires` is an IMF-fixdate, whose year has four digits (RFC 9110
        // Section 5.6.7). A lifetime ending past the year 9999 has no date to
        // state: the header would read a five-digit year, or "Invalid Date" once
        // the deadline leaves the range a Date can hold.
        if (policy.maxAgeSeconds !== undefined && now() + policy.maxAgeSeconds * 1000 >= Date.UTC(10_000, 0)) {
            throw new TypeError(
                "createTusHandler: policy.maxAgeSeconds cannot be honored over tus, which states no Upload-Expires past the year 9999",
            );
        }
        const checksumCap = checksum ? (checksum.maxBufferBytes ?? policy.maxAppendSize) : 0;
        if (checksumCap === undefined) {
            throw new TypeError("createTusHandler: checksum needs maxBufferBytes or policy.maxAppendSize");
        }
        // Advertise only what this policy can actually honor: one with no max
        // age never sends Upload-Expires, so it must not claim `expiration`.
        const extensions =
            TUS_BASE_EXTENSIONS +
            (policy.maxAgeSeconds === undefined ? "" : ",expiration") +
            (checksum ? ",checksum" : "");
        return { policy, checksumCap, extensions };
    });

    /** Compose a response: caller extras first, protocol headers win. */
    function respond(
        status: number,
        statusText: string,
        headers: Record<string, string>,
        // ArrayBuffer-backed, not ArrayBufferLike: the DOM lib's BodyInit excludes
        // a SharedArrayBuffer-backed view, and this package is compiled under that
        // lib by its Deno, Workers and browser consumers. The read side pins the
        // same argument on every stream it hands out.
        body: Uint8Array<ArrayBuffer> | null = null,
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
        return respond(
            status,
            statusText,
            {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": String(body === null ? 0 : body.byteLength),
                ...UPLOAD_ERROR_HEADERS,
                ...opts.headers,
                "Tus-Resumable": TUS_VERSION,
            },
            body,
        );
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
    function rejectResponse(
        outcome: UploadOutcome,
        isHead: boolean,
        { policy }: TusLimits,
        extra?: Record<string, string>,
    ): Response {
        const plain = { isHead, headers: extra };
        switch (outcome.kind) {
            case "refused":
                return outcome.response;
            case "not-found":
                return errorResponse(404, "Not Found", "upload not found", plain);
            case "gone":
                return errorResponse(410, "Gone", `upload ${outcome.reason}`, plain);
            case "offset-mismatch":
                return errorResponse(409, "Conflict", "mismatched Upload-Offset", plain);
            case "length-inconsistent":
                return errorResponse(400, "Bad Request", "inconsistent upload length", plain);
            case "limit-violation":
                if (outcome.reason === "size-exceeded" || outcome.reason === "append-too-large") {
                    // A body stopped at this request's ceiling left its prefix durable;
                    // naming where it ends saves the client the HEAD it would resume with.
                    return errorResponse(413, "Content Too Large", "maximum size exceeded", {
                        isHead,
                        headers: {
                            ...extra,
                            ...(policy.maxSize !== undefined && { "Tus-Max-Size": String(policy.maxSize) }),
                            ...(outcome.durableOffset !== undefined && {
                                "Upload-Offset": String(outcome.durableOffset),
                            }),
                        },
                    });
                }
                return errorResponse(400, "Bad Request", "upload violates a size policy", plain);
            case "contended":
                return errorResponse(423, "Locked", "upload is locked", plain);
            case "destination-conflict":
                return errorResponse(409, "Conflict", "upload destination changed; nothing was published", plain);
            case "store-error":
                return errorResponse(502, "Bad Gateway", "storage backend error", plain);
            default:
                // Success kinds are handled by each method before mapping, and
                // digest-mismatch is unreachable: Upload-Checksum verification is
                // dialect-local (content verifies BEFORE it is appended), so this
                // dialect never hands the orchestrator a digest assertion. Reaching
                // here is an internal invariant breach: report it (an operator must
                // see a breach), then fail closed without mislabeling it a client error.
                onError?.(new Error(`tus: unexpected outcome ${outcome.kind}`), {
                    operation: "reject",
                });
                return errorResponse(500, "Internal Server Error", "internal error", { isHead, headers: extra });
        }
    }

    /**
     * Verify an `Upload-Checksum` assertion against the request content, fully
     * buffered first: bytes reach the store only after they verify, which is
     * the sole honest reading of the extension's discard-on-mismatch. Returns
     * the verified content to append, or the error response. An absent header,
     * or any header while the extension is unconfigured, passes the raw body
     * through untouched.
     */
    async function verifyChecksum<B extends Uint8Array | ReadableStream<Uint8Array> | undefined>(
        req: Request,
        checksumCap: number,
        body: B,
    ): Promise<{ body: B | Uint8Array } | { response: Response }> {
        const header = req.headers.get("upload-checksum");
        if (header === null || !checksum) return { body };
        const parsed = parseUploadChecksum(header);
        if (parsed === null) {
            return { response: errorResponse(400, "Bad Request", "invalid Upload-Checksum header") };
        }
        const algorithm = algorithms.get(parsed.algorithm);
        if (algorithm === undefined) {
            // The extension's 400 for an algorithm the server did not advertise.
            return { response: errorResponse(400, "Bad Request", "unsupported checksum algorithm") };
        }
        let content: Uint8Array = new Uint8Array(0);
        if (body instanceof Uint8Array) {
            if (body.byteLength > checksumCap) {
                return { response: errorResponse(413, "Content Too Large", "checksummed content too large") };
            }
            content = body;
        } else if (body !== undefined) {
            const chunks: Uint8Array[] = [];
            let total = 0;
            const reader = body.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > checksumCap) {
                        await reader.cancel().catch(() => {});
                        return {
                            response: errorResponse(413, "Content Too Large", "checksummed content too large"),
                        };
                    }
                    chunks.push(value);
                }
            } catch {
                // A torn body cannot be verified, and none of it reached the store:
                // upload state is unchanged, exactly what a resuming client expects.
                return {
                    response: errorResponse(400, "Bad Request", "checksummed content ended early"),
                };
            }
            content = new Uint8Array(total);
            let at = 0;
            for (const c of chunks) {
                content.set(c, at);
                at += c.byteLength;
            }
        }
        const actual = await checksum.digest(algorithm, content);
        if (!bytesEqual(actual, parsed.digest)) {
            // 460 Checksum Mismatch (the extension's own status). The chunk was
            // never appended, so the client's next HEAD sees the pre-PATCH offset.
            return { response: errorResponse(460, "Checksum Mismatch", "content does not match Upload-Checksum") };
        }
        return { body: content };
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
     *
     * For the same reason a publish that fails answers its own failure, never
     * the pre-publish offset: every failure maps to a status a tus client
     * retries or surfaces, and `extra` carries the Location a creation needs
     * so the allocated resource stays reachable. Success returns the call that
     * published, or `undefined` when an earlier call already had.
     */
    async function completeImplicitly(
        uploadToken: string,
        offset: number,
        auditKey: string | undefined,
        isHead: boolean,
        limits: TusLimits,
        extra?: Record<string, string>,
        authorize?: UploadAuthorizer,
    ): Promise<PublishedRepresentation | undefined | Response> {
        // Deliberately unsignalled: the trigger case IS a vanished client (an
        // aborted request whose bytes all flushed), and the publish must not be
        // cancelled by the very abort that made it necessary.
        const healed = await orchestrator.append(uploadToken, {
            offset,
            contentLength: 0,
            complete: true,
            auditKey,
            policy: limits.policy,
            ...(authorize && { authorize }),
        });
        if (healed.kind === "appended") return healed;
        return healed.kind === "already-complete" ? undefined : rejectResponse(healed, isHead, limits, extra);
    }

    // ── Method handlers ──

    /** OPTIONS: capability discovery (tus 1.0 core, OPTIONS: 204, no version gate). */
    function handleOptions({ policy, extensions }: TusLimits): Response {
        const headers: Record<string, string> = {
            "Tus-Resumable": TUS_VERSION,
            "Tus-Version": TUS_VERSION,
            "Tus-Extension": extensions,
        };
        if (policy.maxSize !== undefined) headers["Tus-Max-Size"] = String(policy.maxSize);
        // Checksum extension MUST: advertise the verifiable algorithms.
        if (checksum) headers["Tus-Checksum-Algorithm"] = [...algorithms.keys()].join(",");
        return respond(204, "No Content", headers);
    }

    /** POST: creation (+ creation-with-upload, creation-defer-length). */
    async function handleCreate(req: Request, limits: TusLimits): Promise<Response> {
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
            return errorResponse(400, "Bad Request", "creation requires one of Upload-Length or Upload-Defer-Length");
        }

        const metadata = parseUploadMetadata(req.headers.get("upload-metadata"), options.metadataLimits);
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
        const complete =
            declaredLength !== undefined &&
            (!hasContent
                ? declaredLength === 0
                : contentLength !== undefined
                  ? contentLength === declaredLength
                  : true);

        // creation-with-upload content is checksummable like any PATCH content.
        // The declared size is refused from the header alone; the body itself is
        // read for verification only once the policy and `key` admit the
        // creation, so a refused creation never costs a buffered body.
        const checksummed = hasContent && !!checksum && req.headers.get("upload-checksum") !== null;
        if (checksummed && contentLength !== undefined && contentLength > limits.checksumCap) {
            return errorResponse(413, "Content Too Large", "checksummed content too large");
        }

        // Resolved by the orchestrator from the token it mints, before any
        // report names the resource; the follow-up publish reuses the result.
        let auditKey: string | undefined;
        const outcome = await orchestrator.create({
            key: () => options.key({ metadata, request: req, declaredLength, policy: limits.policy }),
            declaredLength,
            contentLength,
            // tus states no completeness: the upload completes when the bytes
            // reach the declared length, and a shorter body leaves it incomplete.
            complete: complete && "infer",
            body: hasContent ? (req.body ?? undefined) : undefined,
            admitBody: checksummed
                ? async (body) => {
                      const verified = await verifyChecksum(req, limits.checksumCap, body);
                      return "response" in verified ? verified.response : verified.body;
                  }
                : undefined,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            auditKey: options.auditKey && ((t) => (auditKey = options.auditKey!({ request: req, uploadToken: t }))),
            signal: req.signal,
            policy: limits.policy,
        });
        // A rejection that names a resource landed AFTER creation allocated it,
        // so bytes may already be durable. The Location is how the client
        // resumes them or deletes them; without it they are unreachable and
        // only a sweep (optional, and meaningless with no max age) reclaims them.
        // The token is store-generated and the URL caller-built: sanitize the
        // composed value like every other computed header on the read side.
        const stranded = "uploadToken" in outcome ? outcome.uploadToken : undefined;
        const located =
            stranded === undefined ? undefined : { Location: sanitizeHeaderValue(options.location(stranded)) };
        if (outcome.kind !== "created") return rejectResponse(outcome, false, limits, located);

        let isComplete = outcome.complete;
        // The publish that completes the upload is whichever call actually made
        // it, so the object it describes travels with that call's outcome.
        let published: PublishedRepresentation = outcome;
        if (!isComplete && declaredLength !== undefined && outcome.offset === declaredLength) {
            const healed = await completeImplicitly(
                outcome.uploadToken,
                outcome.offset,
                auditKey,
                false,
                limits,
                located,
            );
            if (healed instanceof Response) return healed;
            published = healed ?? published;
            isComplete = true;
        }

        const headers: Record<string, string> = {
            "Tus-Resumable": TUS_VERSION,
            ...located,
            // A creation-with-upload that covered the whole declared length
            // published an object; the response that announces it describes it with
            // the same validator and digest the read side serves from then on.
            ...publishedRepresentationHeaders(published),
        };
        // creation-with-upload MUST report the offset after applying accepted
        // bytes; a plain creation carries no offset (there was no data).
        if (hasContent) headers["Upload-Offset"] = String(outcome.offset);
        // Expiration known at creation MUST ride the creation response
        // (expiration extension); a completed upload no longer expires. The
        // deadline is anchored at creation start (outcome.expiresAt), so a slow
        // streaming create does not advertise a deadline inflated by its own
        // duration, which would let a client resume past the real expiry into a 404.
        setUploadExpires(headers, outcome.expiresAt, isComplete);
        return respond(201, "Created", headers);
    }

    /** HEAD: offset probe (tus 1.0 core, HEAD). */
    async function handleHead(req: Request, uploadToken: string, limits: TusLimits): Promise<Response> {
        const auditKey = options.auditKey?.({ request: req, uploadToken });
        let outcome = await orchestrator.probe(uploadToken, {
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "probe"),
            policy: limits.policy,
        });
        if (outcome.kind !== "probed") return rejectResponse(outcome, true, limits);

        // Heal a crash window: if the completing request died after its bytes
        // went durable but before completion (a killed handler on a
        // request-cancelling runtime), the resource sits at offset === length but
        // unpublished. A tus client seeing offset == length concludes "done" and
        // stops, so without this the assembled object is never published and
        // 404s forever. Publish it here, on the very probe that would otherwise
        // mislead the client. (The IETF dialect needs no equivalent: explicit
        // completeness keeps an offset==length probe with `?0` coherent.)
        // Publishing is an append, so it runs under append authorization: a
        // caller admitted only to probe receives the hook's append refusal.
        if (!outcome.complete && outcome.length !== undefined && outcome.offset === outcome.length) {
            const healed = await completeImplicitly(
                uploadToken,
                outcome.offset,
                auditKey,
                true,
                limits,
                undefined,
                bindAuthorize(options.authorize, req, uploadToken, "append"),
            );
            if (healed instanceof Response) return healed;
            outcome = { ...outcome, complete: true };
        }

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
        // Metadata the creation carried rides every HEAD (creation extension
        // MUST, when the upload has any), re-encoded from the values that
        // creation decoded, so a client resuming from a cold start recovers the
        // filename and type it no longer holds.
        if (outcome.metadata !== undefined) {
            const encoded = encodeUploadMetadata(outcome.metadata);
            if (encoded !== undefined) headers["Upload-Metadata"] = encoded;
        }
        setUploadExpires(headers, outcome.expiresAt, outcome.complete);
        return respond(200, "OK", headers);
    }

    /** PATCH: append at offset (tus 1.0 core, PATCH; creation-defer-length length fixing). */
    async function handlePatch(req: Request, uploadToken: string, limits: TusLimits): Promise<Response> {
        if (!isOffsetOctetStream(req.headers.get("content-type"))) {
            // tus 1.0 core, PATCH: all PATCH requests MUST use
            // application/offset+octet-stream; anything else is answered 415.
            return errorResponse(415, "Unsupported Media Type", `PATCH requires Content-Type: ${OFFSET_CONTENT_TYPE}`);
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

        const auditKey = options.auditKey?.({ request: req, uploadToken });
        // Checksum extension: verify before a single byte can reach the store.
        //
        // Verification buffers and hashes the whole request, up to the cap, and
        // that work is worth doing only for a request the append can still
        // accept. Without this gate a refused request buys a full buffer plus
        // digest on every attempt, memory times concurrency and CPU per request,
        // before the append refuses it anyway. Three refusals need no lock and
        // no body: a token that names nothing, an authorize hook that refuses
        // it, and a declared Content-Length past the buffering cap. The offset
        // is deliberately not judged here: it is only coherent under the lock,
        // and a lock-free read could refuse a request the append would accept
        // once an in-flight append yields. The check is lock-free so it cannot
        // preempt an append the way a probe would, and it costs one state read
        // on the path that was about to pay far more.
        if (req.headers.get("upload-checksum") !== null && checksum) {
            const refused = await orchestrator.admit(uploadToken, {
                auditKey,
                signal: req.signal,
                authorize: bindAuthorize(options.authorize, req, uploadToken, "append"),
            });
            if (refused !== undefined) return rejectResponse(refused, false, limits);
            if (contentLength !== undefined && contentLength > limits.checksumCap) {
                return errorResponse(413, "Content Too Large", "checksummed content too large");
            }
        }
        const verified = await verifyChecksum(req, limits.checksumCap, req.body ?? undefined);
        if ("response" in verified) return verified.response;

        // tus has no completion flag on the wire: whether THIS append completes
        // the upload is implicit at offset == length. The orchestrator infers it
        // from the fresh durable state it reads under the append's own lock, so
        // the PATCH hot path costs a single locked state read (a dialect-side
        // pre-probe would double it and could still go stale before the lock).
        const outcome = await orchestrator.append(uploadToken, {
            offset: claimedOffset,
            contentLength,
            complete: "infer",
            declaredLength,
            body: verified.body,
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "append"),
            policy: limits.policy,
        });

        // Idempotent retry of the final request: the claimed offset matched the
        // durable end of a completed upload and the request carried no content,
        // so it is answered like any successful PATCH. A request that DOES carry
        // content there is refused by the engine as a length inconsistency: the
        // total is fixed at `Upload-Length` and bytes past it cannot be stored,
        // so 204 would acknowledge content that reached no store.
        if (outcome.kind === "already-complete") {
            return respond(204, "No Content", {
                "Tus-Resumable": TUS_VERSION,
                "Upload-Offset": String(claimedOffset),
            });
        }
        if (outcome.kind !== "appended") return rejectResponse(outcome, false, limits);

        let isComplete = outcome.complete;
        // The publish that completes the upload is whichever call actually made
        // it, so the object it describes travels with that call's outcome.
        let published: PublishedRepresentation = outcome;
        if (!isComplete && outcome.length !== undefined && outcome.offset === outcome.length) {
            const healed = await completeImplicitly(uploadToken, outcome.offset, auditKey, false, limits);
            if (healed instanceof Response) return healed;
            published = healed ?? published;
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
            // Present only on the append that completed the upload: that is the one
            // that published an object to describe.
            ...publishedRepresentationHeaders(published),
        };
        // Every PATCH response on an upload that will expire MUST say when
        // (expiration extension). The absolute deadline comes from the append
        // outcome (createdAt + max age), so a long-running append cannot inflate
        // it the way `now + remaining` measured before the append would.
        setUploadExpires(headers, outcome.expiresAt, isComplete);
        return respond(204, "No Content", headers);
    }

    /**
     * DELETE: termination extension (204, resource then answers 404/410).
     * Terminates the UPLOAD, never an object it already published: the store
     * contract bars an abort from touching published bytes, so a DELETE that
     * arrives after completion frees bookkeeping and leaves live data alone.
     */
    async function handleDelete(req: Request, uploadToken: string, limits: TusLimits): Promise<Response> {
        const auditKey = options.auditKey?.({ request: req, uploadToken });
        const outcome = await orchestrator.cancel(uploadToken, {
            auditKey,
            signal: req.signal,
            authorize: bindAuthorize(options.authorize, req, uploadToken, "cancel"),
        });
        if (outcome.kind !== "cancelled") return rejectResponse(outcome, false, limits);
        return respond(204, "No Content", { "Tus-Resumable": TUS_VERSION });
    }

    return async function handleTus(req: Request, ctx?: { uploadToken?: string }): Promise<Response> {
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
            if (method === "OPTIONS") return handleOptions(await limitsFor(req));

            // Version gate for everything else (tus 1.0 core, Tus-Resumable): a
            // missing or unsupported version is answered 412 with Tus-Version and
            // the request is not processed.
            if (req.headers.get("tus-resumable") !== TUS_VERSION) {
                return errorResponse(412, "Precondition Failed", "unsupported Tus-Resumable version", {
                    isHead: method === "HEAD",
                    headers: { "Tus-Version": TUS_VERSION },
                });
            }

            const limits = await limitsFor(req);
            if (method === "POST") return await handleCreate(req, limits);

            if (method === "HEAD" || method === "PATCH" || method === "DELETE") {
                const uploadToken = ctx?.uploadToken ?? options.resolveToken?.(req);
                if (uploadToken === undefined || uploadToken === "") {
                    // No token, no resource: same missing-resource answer as an
                    // unknown upload URL, without Upload-Offset (tus 1.0 core, HEAD).
                    return errorResponse(404, "Not Found", "upload not found", { isHead: method === "HEAD" });
                }
                if (method === "HEAD") return await handleHead(req, uploadToken, limits);
                if (method === "PATCH") return await handlePatch(req, uploadToken, limits);
                return await handleDelete(req, uploadToken, limits);
            }

            return errorResponse(405, "Method Not Allowed", "method not allowed", {
                headers: { Allow: "POST, HEAD, PATCH, DELETE, OPTIONS" },
            });
        } catch (err) {
            // Never-throw contract, mirroring the read side: an escaping error (a
            // throwing key/location/resolveToken callback, a runtime body failure)
            // becomes a hardened 500 and is surfaced to onError, never to the client.
            //
            reportHandlerFailure(options, req, ctx?.uploadToken, err);
            return errorResponse(500, "Internal Server Error", "internal error");
        }
    };
}

// ─── Shared upload surface (re-exported for consumers) ──────────────────────
// The write-store contract, errors, locking, and the dialect-agnostic
// orchestrator, from one shared module so /tus and /upload never diverge.
/**
 * Every response header a cross-origin browser upload must be allowed to READ,
 * for an `Access-Control-Expose-Headers` value. This package does not ship CORS
 * middleware (the caller owns their CORS policy), but a resumable upload breaks
 * in non-obvious ways when the list is incomplete: expose `Location` but forget
 * `Upload-Offset` and a client cannot resume; forget `Upload-Expires` and it
 * cannot renew before expiry. Deriving the list by hand is exactly the step
 * that silently drops one header, so each dialect publishes its own beside its handler.
 *
 * Spread into your CORS layer:
 * ```typescript
 * "Access-Control-Expose-Headers": TUS_EXPOSED_HEADERS.join(", ")
 * ```
 *
 * Every name here is a header one of the dialect's responses actually emits,
 * some only when an extension is configured (`Tus-Max-Size`,
 * `Tus-Checksum-Algorithm`); a list that names a header the package never
 * sends is the same defect as an incomplete one, read from the other side,
 * because it describes a wire the caller cannot observe. Request-header
 * allow-lists (`Access-Control-Allow-Headers`) are the mirror image and remain
 * the caller's to assemble from the same protocol surface.
 */
export const TUS_EXPOSED_HEADERS: readonly string[] = Object.freeze([
    "Location",
    "Tus-Resumable",
    "Tus-Version",
    "Tus-Extension",
    "Tus-Max-Size",
    "Tus-Checksum-Algorithm",
    "Upload-Offset",
    "Upload-Length",
    "Upload-Defer-Length",
    "Upload-Metadata",
    "Upload-Expires",
    "ETag",
    "Repr-Digest",
]);

export * from "./upload-shared.ts";
