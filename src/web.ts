/**
 * Web / Fetch API adapter for partial-content.
 *
 * Composes a partial-content {@link ObjectStore} with the kernel's conditional
 * request evaluation to produce a standards-compliant file-serving handler.
 *
 * Framework-agnostic: works with Next.js App Router, Hono, SvelteKit, Remix,
 * Cloudflare Workers, Bun.serve, Deno.serve, or any runtime that uses the
 * standard Request/Response API.
 *
 * Handles: 200 (full), 206 (partial), 304 (not modified), 412 (precondition
 * failed), 416 (range not satisfiable), and HEAD (headers only).
 *
 * @example
 * ```typescript
 * import { serveObject } from "partial-content/web";
 * import { s3Store } from "partial-content/s3";
 *
 * const store = s3Store({ client, bucket: "documents" });
 * const handler = serveObject(store, { disposition: "inline" });
 *
 * // The handler takes (request, context): the caller resolves the storage
 * // key (and optional mime/filename) and passes them as the ServeContext.
 * export async function GET(req: Request) {
 *   // A key is the object's name, so the request path is percent-decoded first.
 *   let key: string;
 *   try {
 *     key = decodeURIComponent(new URL(req.url).pathname.slice(1));
 *   } catch {
 *     return new Response("Bad Request", { status: 400 });
 *   }
 *   return handler(req, { key });
 * }
 * export const HEAD = GET;
 * ```
 *
 * @packageDocumentation
 */

import {
    isObjectNotFoundError,
    isObjectChangedError,
    isStoreUnavailableError,
    evaluateConditionalRequest,
    buildRangeResponseHeaders,
    buildContentDisposition,
    generateETag,
    clientWantsDigest,
    clientWantsContentDigest,
    sanitizeHeaderValue,
    isRangeFresh,
    parseRanges,
    ObjectChangedError,
    build416Headers,
    buildMultipartHeaders,
    buildMultipartPartHeader,
    multipartEpilogue,
    generateMultipartBoundary,
    MAX_RANGES_DEFAULT,
    parseRetryAfterSeconds,
    negotiateEncoding,
    isCompressibleMime,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectBody,
    type ObjectStream,
    type ParsedRange,
    type ReadRange,
} from "./index.ts";
import { fixedLength, isErrorNamed, projectError, readField } from "./object-store.ts";
import { resolveMediaType, type MediaType } from "./media-type.ts";
import { VariantHits, VariantMisses } from "./variant-misses.ts";
import { guardHook, guardSink, type Hook } from "./hooks.ts";
import { DENY_HEADERS, plainTextErrorParts } from "./error-response.ts";

// Re-export kernel types so consumers only need one import
export type { ObjectStore, ObjectMetadata, ObjectStream, ObjectBody, ParsedRange, ETagSource } from "./index.ts";
export type { ProjectedError } from "./object-store.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * One reusable UTF-8 encoder for the module (multipart part headers), mirroring the kernel's hoisted encoder. `TextEncoder` is
 * stateless, so a single instance is safe to share and avoids a per-response
 * allocation.
 */
const UTF8_ENCODER = new TextEncoder();

/** Reason phrases for HTTP statuses used by this adapter. */
const STATUS_TEXT = {
    200: "OK",
    204: "No Content",
    206: "Partial Content",
    302: "Found",
    304: "Not Modified",
    404: "Not Found",
    405: "Method Not Allowed",
    412: "Precondition Failed",
    416: "Range Not Satisfiable",
    499: "Client Closed Request",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
} as const satisfies Record<number, string>;

/** Response parts for a status this module answers, with its reason phrase. */
function respond(
    status: keyof typeof STATUS_TEXT,
    headers: Record<string, string>,
    body: RawResponseParts["body"] = null,
): RawResponseParts {
    return { status, statusText: STATUS_TEXT[status], headers, body };
}

/**
 * Content codings the `precompressed` option can negotiate, mapped to the
 * sibling-key suffix probed in the store (`report.json` -> `report.json.br`).
 * The suffixes match what every build tool and CDN convention emits.
 */
const PRECOMPRESSED_SUFFIX = {
    br: ".br",
    zstd: ".zst",
    gzip: ".gz",
} as const;

/**
 * A content coding servable from a precompressed sibling object.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type PrecompressedCoding = keyof typeof PRECOMPRESSED_SUFFIX;

/** Narrow a negotiated coding name to one this module serves a sibling for. */
const isPrecompressedCoding = (coding: string): coding is PrecompressedCoding =>
    Object.hasOwn(PRECOMPRESSED_SUFFIX, coding);

/** Default server preference: best ratio first (RFC 9110 lets ties go to us). */
const DEFAULT_PRECOMPRESSED: readonly PrecompressedCoding[] = ["br", "zstd", "gzip"];

/**
 * The response headers this protocol emits that are NOT CORS-safelisted:
 * cross-origin JavaScript cannot read them unless they appear in
 * `Access-Control-Expose-Headers`. Without exposure, range-consuming readers
 * degrade SILENTLY -- pdf.js falls back to full-file download when it cannot
 * read `Accept-Ranges` cross-origin. The value behind
 * `accessControlExposeHeaders: true`, exported for kernel-only consumers.
 */
export const PROTOCOL_EXPOSE_HEADERS =
    "Accept-Ranges, Content-Range, Content-Encoding, ETag, Content-Disposition, Repr-Digest, Content-Digest, Server-Timing";

// ─── Options ────────────────────────────────────────────────────────────────

/**
 * The request surface the orchestrator actually consumes. A standard fetch
 * `Request` satisfies it structurally; server adapters may pass a
 * lightweight view instead, avoiding per-request construction of fetch
 * primitives (an undici `Request` + `Headers` pair costs a measurable
 * fraction of a small-file serve).
 */
export interface ServableRequest {
    /** HTTP method. GET and HEAD are served; anything else gets a 405. */
    method: string;
    /** Case-insensitive header lookup: a `Headers` object or any equivalent view. */
    headers: { get(name: string): string | null };
    /** Client-disconnect signal, forwarded to the storage backend. */
    signal?: AbortSignal;
}

/** Metadata resolved by the consumer before the handler runs. */
export interface ServeContext {
    /**
     * Storage key: the object's name as the store knows it (`reports/q1 2026.pdf`),
     * never URL text (`reports/q1%202026.pdf`). Percent-decode a request path
     * before using it as a key, and authorize the decoded key: a store that
     * builds a URL encodes the key itself.
     */
    key: string;
    /** Override MIME type. When omitted, defaults to "application/octet-stream". */
    mime?: string;
    /**
     * Filename for Content-Disposition. When provided, the header carries the
     * sanitized `filename`/`filename*` parameters; when omitted, a bare
     * `Content-Disposition: attachment` (or `inline`) is still set so the
     * download/preview intent always reaches the browser.
     */
    filename?: string;
    /**
     * Per-request Cache-Control, overriding {@link ServeObjectOptions.cacheControl}.
     * Lets one handler serve mixed cacheability (immutable content-addressed
     * blobs next to private user uploads) without instantiating N handlers.
     * Used verbatim: the `immutable` option is NOT appended to it.
     */
    cacheControl?: string;
    /**
     * Identifier reported as `key` in every `onServe`/`onTransfer`/`onError`
     * event instead of the storage key. Storage keys commonly embed filenames
     * or user paths -- personal data that logging controls (ISO 27001 A.8.15,
     * OWASP ASVS logging) say must stay out of log records. Supply an opaque
     * id (document id, hash) here and the audit trail stays correlatable
     * without carrying the filename; the store still reads by the real `key`.
     * With it set, `onError` receives a `ProjectedError` (`name`, `code`,
     * `status`, `operation`, `cause` projected the same way) instead of the
     * raw error, whose message, stack and properties can carry the key.
     * When omitted, events carry the storage key and errors arrive unchanged.
     * The Node and Hono adapters that take an `auditKey` extractor pass the
     * constant `"unkeyed"` when it returns `undefined`, so a request the
     * extractor yields nothing for never falls back to the storage key.
     */
    auditKey?: string;
}

export interface ServeObjectOptions {
    /**
     * Content-Disposition strategy. A function's result must be `"inline"` or
     * `"attachment"`: anything else (a promise included) answers 500 with
     * `onError` operation `"context"`.
     * - `"inline"` -- render in the browser (PDF, images, video)
     * - `"attachment"` -- force download
     * - A function mapping MIME to disposition type (for per-type policy)
     *
     * @default "attachment"
     */
    disposition?: "inline" | "attachment" | ((mime: string) => "inline" | "attachment");

    /**
     * Cache-Control value for 200/206 responses.
     *
     * The default carries `no-transform`: the responses carry digests and
     * strong validators that describe the exact bytes, and an intermediary that
     * re-compresses or transcodes the payload would make them lie.
     *
     * @default "private, no-cache, no-transform"
     */
    cacheControl?: string;

    /**
     * When true, appends `immutable` to the Cache-Control directive.
     * Use for content-addressed storage where the key contains a hash
     * (e.g. `<sha256>.pdf`) and the resource will never change.
     *
     * @default false
     */
    immutable?: boolean;

    /**
     * Extra headers applied to success responses: 200, 206, and 304.
     * Receives the MIME type so the policy can vary per format (e.g. relaxed
     * CSP for PDF.js, strict sandbox for images).
     *
     * Included on 304 deliberately: RFC 9110 Section 15.4.5 requires a 304 to
     * carry any `Vary` (and `Cache-Control`/`Expires`/`Content-Location`) that
     * the corresponding 200 would have carried, and this option is the
     * mechanism for `Vary`. Security headers riding along on a bodyless 304
     * are harmless.
     *
     * Must return a plain object synchronously: any other result (a promise
     * included) answers 500 with `onError` operation `"context"`.
     *
     * @default No extra headers.
     */
    securityHeaders?: (mime: string) => Record<string, string>;

    /**
     * Emit validators (`ETag`) derived from store metadata. Set `false` for
     * deployments where the derived validator is unstable and would poison
     * revalidation instead of helping it -- the classic case is a
     * filesystem store replicated across servers whose file mtimes differ
     * per replica, so each node computes a different weak ETag for identical
     * bytes and every `If-None-Match` misses. `Last-Modified` (and
     * `If-Modified-Since`/`If-Range` date handling) is unaffected. Disabling
     * ETags also disables the ETag-based HEAD-to-GET drift guard on stores
     * that cannot pin reads; the Last-Modified comparison remains.
     *
     * @default true
     */
    etag?: boolean;

    /**
     * Cross-Origin-Resource-Policy value for success responses.
     *
     * Controls which origins can embed this resource:
     * - `"same-origin"` -- only your origin (most secure)
     * - `"same-site"` -- same registrable domain
     * - `"cross-origin"` -- any origin (for public CDN assets)
     *
     * Required for pages with `Cross-Origin-Embedder-Policy: require-corp`.
     * When omitted, no CORP header is set (caller decides).
     */
    crossOriginResourcePolicy?: "same-origin" | "same-site" | "cross-origin";

    /**
     * Timing-Allow-Origin value for success responses.
     *
     * Allows cross-origin pages to read Server-Timing and Resource Timing data
     * via the PerformanceObserver API. Without this, browser security policy
     * zeros out timing metrics for cross-origin resources.
     *
     * Set to `"*"` for public assets, or a specific origin for private APIs.
     */
    timingAllowOrigin?: string;

    /**
     * When true, every served body (a 200 or 206) carries a `Server-Timing`
     * header with storage and evaluation latency metrics. Also calls
     * `onTiming` if provided.
     *
     * Caution: timing data may leak internal architecture details.
     * Enable only when you control the deployment environment.
     *
     * @default false
     */
    timing?: boolean;

    /**
     * Timing callback for observability.
     *
     * Called once per served body, with the figures its `Server-Timing`
     * header carries; an attempt that re-validates against a changed object
     * does not report. Use to ship metrics to your RUM/APM backend.
     */
    onTiming?: Hook<[metrics: { storeMs: number; evaluateMs: number; totalMs: number }]>;

    /**
     * Fallback filename used by buildContentDisposition when no filename is
     * provided and the disposition needs an ASCII fallback.
     *
     * @default "download"
     */
    fallbackFilename?: string;

    /**
     * Error callback for observability.
     *
     * Called when the storage backend throws during HEAD or GET operations.
     * Use this to log errors with request IDs, correlation tokens, and
     * structured metadata for production monitoring.
     *
     * The error is NOT exposed to the client (the response body is generic).
     *
     * @param error - The error as thrown, or its allow-listed `ProjectedError`
     * when the request set `ServeContext.auditKey`, whatever failed (the
     * store, the context, or one of your own hooks)
     * @param context - Additional context about the failed operation
     * (`sign` = a signed-URL provider threw during a redirect;
     * `audit` = the consumer's own onServe/onTransfer hook threw; the
     * response was still served, the hook failure is surfaced here instead
     * of crashing. `context` = a consumer-supplied key/mime/filename
     * extractor threw in a server adapter; the request became a 500).
     *
     * Every callback option (`onError`, `onServe`, `onTransfer`, `onTiming`)
     * may be async: the returned promise is observed, never awaited. A
     * synchronous throw or a rejected promise from `onServe`, `onTransfer` or
     * `onTiming` is routed HERE (operation `audit`). There is no sink for a
     * failure of the error sink itself: a throwing or rejecting `onError` is
     * swallowed.
     */
    onError?: Hook<[error: unknown, context: ServeErrorContext]>;

    /**
     * Audit callback for compliance logging (SOC 2 CC7.2, ISO 27001 A.8.15).
     *
     * Called on every response that grants access (200, 206, 304, and 302
     * signed-URL redirects) with structured metadata suitable for audit trail
     * ingestion. Not called on errors (use `onError` for those).
     *
     * @example
     * ```ts
     * onServe: (event) => logger.info({ ...event }, "file.served")
     * ```
     */
    onServe?: Hook<[event: ServeAuditEvent]>;

    /**
     * Transfer-completion callback for true egress accounting and truncation
     * detection.
     *
     * `onServe` fires when headers are committed and reports bytes *granted*
     * (the response Content-Length). This fires once when the response body
     * reaches its terminal state and reports bytes *actually transferred*
     * through it, plus whether it drained fully or the client disconnected
     * early. Use it for egress billing (`bytesTransferred`) or abandonment
     * analytics (`completed === false`).
     *
     * Zero-cost when unset: the body is returned untouched, so byte bodies keep
     * the runtime's static-body fast path. When set, the body is routed through
     * a counting stream (byte bodies are wrapped too, so measurement is uniform
     * across stores) -- a deliberate cost you opt into for the metering.
     *
     * Fires only for 200/206 GET responses (a body was served). Never fires for
     * HEAD, 304, 302, 412, 416, or error responses. A throwing callback cannot
     * corrupt the transfer: its error is routed to `onError` (operation
     * `"audit"`).
     *
     * @example
     * ```ts
     * onTransfer: (e) => {
     *   meter.recordEgress(e.key, e.bytesTransferred);
     *   if (!e.completed) log.info({ ...e }, "download.abandoned");
     * }
     * ```
     */
    onTransfer?: Hook<[event: TransferEvent]>;

    /**
     * Maximum number of distinct (coalesced) byte ranges to serve as
     * multipart/byteranges before a multi-range request degrades to a full 200.
     *
     * A range-amplification defense: a client sending thousands of tiny or
     * overlapping ranges would otherwise force a large multipart response.
     * Overlapping/adjacent ranges are coalesced first, and if the result still
     * exceeds this cap the full 200 is served instead (RFC 9110 Section 14.2
     * permits ignoring an abusive range set). A set that coalesces to one range,
     * the whole object included, is served as a single 206. Must be a safe
     * integer of at least 1 (a TypeError at construction otherwise); 1
     * disables multipart.
     *
     * @default 8
     */
    maxRanges?: number;

    /**
     * Maximum number of backend reads one multipart response may issue.
     *
     * Up to this many parts, each part streams from its own ranged read. Past
     * it, the parts are cut from ONE buffered read of the span covering them
     * all when that span is under 256 KiB, whatever the part count, and the
     * full 200 is served otherwise. Must be a safe integer of at least 1 (a
     * TypeError at construction otherwise).
     *
     * @default 8
     */
    maxBackendReads?: number;

    /**
     * When true, appends `; charset=utf-8` to textual Content-Type values
     * (text/*, application/json, application/xml, etc.) if not already present.
     *
     * Prevents UTF-7 encoding-sniffing XSS in legacy browsers that probe for
     * a charset declaration and fall back to auto-detection when none is found.
     *
     * @default true
     */
    enforceCharset?: boolean;

    /**
     * Serve precompressed sibling objects negotiated via `Accept-Encoding`
     * (RFC 9110 Section 12.5.3).
     *
     * When enabled and the resolved MIME is compressible, the handler probes
     * for `<key>.br` / `<key>.zst` / `<key>.gz` (in the order given; `true`
     * means `["br", "zstd", "gzip"]`) and serves the first variant the client
     * accepts, with `Content-Encoding` and `Vary: Accept-Encoding`. The
     * variant is a distinct representation: its OWN validators, digest, and
     * size drive conditionals, `If-Range`, and byte ranges -- `Content-Range`
     * describes the encoded bytes, which is what makes resumed downloads of a
     * `.br` variant byte-correct (a naive fs server computes ranges against
     * the identity size and corrupts them).
     *
     * Authority: a variant is a sibling key the DEPLOYER must control, never
     * one a user can name. The authorization you check for `key` covers its
     * variants, so any party who can write `<key>.br` can replace what every
     * client that accepts `br` receives for `key`. A variant is served only
     * while the identity object exists and is not newer than the variant:
     * deleting the identity stops its variants being served (erasure), and a
     * variant older than a replaced identity is skipped.
     *
     * Scope and cost:
     * - Selection only, never on-the-fly compression (transforming at serve
     *   time breaks byte-exact ranges and digests). You upload the variants.
     * - One `headObject` for the identity object per request, sent in the same
     *   round as the variant probes (no extra round trip), and one probe per
     *   acceptable coding not remembered as missing; a coding the store
     *   confirmed is remembered for 30 s and ends the probing at it. A plain
     *   GET for a remembered variant sends the variant's `getObject` together
     *   with the identity `headObject` (two calls, one round trip) and takes
     *   the variant's validators from that read; a range or conditional
     *   request still probes the variant's `headObject` first, since its
     *   304, 412 or 416 answer opens no body. Probes
     *   are skipped entirely for non-compressible types (media, archives) and
     *   for multi-range requests (multipart of an encoded representation has
     *   no interoperable framing, so those serve the identity bytes).
     * - A probe failure other than not-found falls back to identity and is
     *   reported to `onError` -- a missing optimization never fails a serve.
     *
     * @default false
     */
    precompressed?: boolean | readonly PrecompressedCoding[];

    /**
     * Per-request egress offload: when this predicate returns `true` and the
     * store implements `createSignedUrl`, the handler answers a 302 to a
     * short-lived signed URL instead of proxying bytes through the origin.
     *
     * Lets one route split traffic by shape: proxy Range requests and
     * conditional revalidations (where this library's protocol handling is
     * the point), but redirect large full-file downloads straight to the
     * storage backend. The redirect carries `Cache-Control: no-store` so the
     * expiring URL is never cached.
     *
     * HEAD requests never consult the predicate: a metadata probe answered
     * with a bare 302 defeats exactly the clients that send HEAD (PDF.js size
     * probing, cache priming), so HEAD always serves real headers from the
     * origin and the predicate only ever evaluates GET requests.
     *
     * The redirect is decided before the object's existence is known: a missing
     * key reaches the client as the storage backend's own error page, not this
     * handler's 404. The predicate must return a boolean (a promise included is
     * refused with a 500, operation `"context"`).
     *
     * @example
     * ```ts
     * preferSignedUrl: ({ isRange, isConditional }) => !isRange && !isConditional
     * ```
     */
    preferSignedUrl?: (info: {
        key: string;
        mime: string;
        method: "GET";
        isRange: boolean;
        isConditional: boolean;
    }) => boolean;

    /**
     * Lifetime handed to `createSignedUrl` for redirect responses.
     *
     * Note the adapter contract: backends running under TEMPORARY credentials
     * (STS/Lambda roles) silently cap a presigned URL's life at the
     * credential's remaining lifetime, whatever expiry you request.
     *
     * Must be a safe integer of at least 1 (a TypeError at construction
     * otherwise).
     *
     * @default 60
     */
    signedUrlExpiresSeconds?: number;

    /**
     * Emit `Access-Control-Expose-Headers` on success responses so
     * cross-origin JavaScript can read the protocol headers.
     *
     * `true` exposes {@link PROTOCOL_EXPOSE_HEADERS}; a string is emitted
     * verbatim. Without this, cross-origin readers degrade SILENTLY: pdf.js
     * cannot see `Accept-Ranges` and downloads the whole file instead of
     * range-loading pages.
     *
     * Exposure only; pair it with your platform's CORS layer
     * (`Access-Control-Allow-Origin`), which this library deliberately does
     * not manage. A caller-supplied `securityHeaders` value for the same
     * header wins.
     *
     * @default No header (same-origin consumers need none).
     */
    accessControlExposeHeaders?: boolean | string;
}

/**
 * Context passed to {@link ServeObjectOptions.onError}. `operation` may gain
 * a member in a minor release: give a switch over it a default branch.
 */
export interface ServeErrorContext {
    /** The requested storage key, or `ServeContext.auditKey` when one is set. */
    key: string;
    operation: "head" | "get" | "sign" | "audit" | "context";
}

/**
 * Fields every audit and transfer event carries about what was served.
 */
interface ServedIdentity {
    /** The requested storage key, or `ServeContext.auditKey` when one is set. */
    key: string;
    /**
     * Storage key of the precompressed variant actually read (`key` plus its
     * suffix). Absent for an identity response, and absent whenever
     * `auditKey` is set, since it would name the storage key.
     */
    variantKey?: string;
    /** Content coding of a precompressed variant (`"br"`, `"gzip"`, ...). */
    contentEncoding?: string;
    /**
     * {@link ObjectMetadata.contentType} as the store reported it on the
     * metadata read, if any. Informational: the served type is never taken
     * from it.
     */
    storedContentType?: string;
}

/**
 * Structured audit event for compliance logging. A union-typed field may gain
 * a member in a minor release: give a switch over it a default branch.
 */
export interface ServeAuditEvent extends ServedIdentity {
    /**
     * Request method. Distinguishes a HEAD metadata probe (no bytes transferred)
     * from a GET, which otherwise both surface as `status: 200, bytesServed: 0`
     * for an empty object.
     */
    method: "GET" | "HEAD";
    /**
     * HTTP status code. 302 = access granted via signed-URL redirect.
     * 412/416 = access DENIED (failed precondition / unsatisfiable range):
     * emitted so compliance trails capture denials, not only grants -- a 412
     * is an optimistic-concurrency conflict signal auditors ask for.
     */
    status: 200 | 206 | 302 | 304 | 412 | 416;
    /** MIME type of the served content. */
    mime: string;
    /**
     * Body bytes GRANTED, not confirmed transferred: the body's
     * Content-Length on a 200/206 GET (the event fires when headers are
     * committed, before the stream drains, so a client disconnect can
     * receive fewer bytes). 0 for HEAD, 304, 302, 412, and 416. Treat as
     * access volume, never as exfiltration volume.
     */
    bytesServed: number;
    /** Range start (inclusive), present only on 206. */
    rangeStart?: number;
    /** Range end (inclusive), present only on 206. */
    rangeEnd?: number;
    /** ETag of the served representation, if available. */
    etag?: string;
}

/**
 * Structured transfer-completion event ({@link ServeObjectOptions.onTransfer}).
 * A union-typed field may gain a member in a minor release.
 */
export interface TransferEvent extends ServedIdentity {
    /** Always GET: only GET responses carry a body to transfer. */
    method: "GET";
    /** HTTP status of the served body. */
    status: 200 | 206;
    /**
     * Bytes GRANTED: the response body's Content-Length (206 range span or 200
     * full size). Compare against {@link bytesTransferred} to detect truncation.
     */
    bytesExpected: number;
    /**
     * Bytes ACTUALLY read through the response body before it reached its
     * terminal state. Equals {@link bytesExpected} on a fully-drained transfer;
     * less when the client disconnected or cancelled early.
     */
    bytesTransferred: number;
    /**
     * `true` if the body drained completely, `false` if it was cancelled /
     * the client disconnected before the last byte. The honest signal for
     * egress billing and abandonment analytics.
     */
    completed: boolean;
    /** Range start (inclusive), present only on 206. */
    rangeStart?: number;
    /** Range end (inclusive), present only on 206. */
    rangeEnd?: number;
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * A response as plain parts (status, reason phrase, headers, body) for a
 * server that writes them natively; {@link serveObjectRaw} returns it.
 */
export interface RawResponseParts {
    status: number;
    /** Reason phrase (e.g. "Partial Content", "Client Closed Request"). */
    statusText: string;
    headers: Record<string, string>;
    /**
     * `null` for bodyless statuses (HEAD, 304, 412, 416, 302, 405). Otherwise
     * the same `<ArrayBuffer>`-backed {@link ObjectBody} a store serves, so
     * `new Response(parts.body)` compiles under DOM lib.
     */
    body: ObjectBody | null;
}

/**
 * Serve an object from an {@link ObjectStore} with full conditional-request
 * and range-request support (RFC 9110 Sections 13 and 14).
 *
 * Returns a function that takes a standard `Request` plus {@link ServeContext}
 * and returns a `Response`. This is framework-agnostic: it works with Next.js
 * App Router, Hono, SvelteKit, Remix, or any runtime that uses the Fetch API.
 *
 * The evaluation chain:
 *   1. HEAD -> get metadata (ETag, Last-Modified, size)
 *   2. Preconditions (If-Match / If-Unmodified-Since) -> 412
 *   3. Freshness (If-None-Match / If-Modified-Since) -> 304
 *   4. If-Range validation -> honor or ignore Range
 *   5. Range parsing -> 206 or 416
 *   6. Stream bytes -> 200 or 206
 *
 * TOCTOU guard: ETag/Last-Modified from the GET response are preferred over
 * HEAD values. If the GET response omits Content-Range for a range request,
 * the handler degrades to 200 (never emits a lying 206).
 */
export function serveObject(store: ObjectStore, opts: ServeObjectOptions = {}) {
    const raw = serveObjectRaw(store, opts);
    return async function handleServe(req: ServableRequest, ctx: ServeContext): Promise<Response> {
        const parts = await raw(req, ctx);
        // BodyInit accepts both body forms; byte bodies take the runtime's
        // static-body fast path (no stream machinery).
        const init: WorkersResponseInit = {
            status: parts.status,
            statusText: parts.statusText,
            headers: parts.headers,
        };
        // A body that already carries a content coding must reach the client as
        // is. Cloudflare Workers otherwise compresses a response again
        // according to its Content-Encoding header; other runtimes ignore the
        // member.
        if (parts.headers["Content-Encoding"]) init.encodeBody = "manual";
        return new Response(parts.body, init);
    };
}

/** `ResponseInit` plus the Workers-only `encodeBody` member, typed locally. */
interface WorkersResponseInit extends ResponseInit {
    encodeBody?: "automatic" | "manual";
}

/**
 * The engine behind serveObject, exposed for server adapters: identical
 * protocol behavior, but the result is RawResponseParts instead of a
 * Response. Use this when your server writes status/headers/body natively
 * (the bundled node adapter does) -- constructing a Response + Headers pair
 * per request just to immediately deconstruct them is measurable overhead
 * on hot paths.
 *
 * A response whose headers carry `Content-Encoding` has a body that is already
 * encoded. A consumer building its own `Response` on Cloudflare Workers must
 * pass `encodeBody: "manual"` for it, or the runtime compresses it again.
 */
export function serveObjectRaw(store: ObjectStore, opts: ServeObjectOptions = {}) {
    const {
        disposition: dispositionOpt = "attachment",
        cacheControl: rawCacheControl = "private, no-cache, no-transform",
        immutable: immutableOpt = false,
        etag: etagEnabled = true,
        securityHeaders,
        crossOriginResourcePolicy,
        timingAllowOrigin,
        timing: timingEnabled = false,
        onTiming,
        fallbackFilename = "download",
        onError: rawOnError,
        onServe: rawOnServe,
        onTransfer: rawOnTransfer,
        maxRanges = MAX_RANGES_DEFAULT,
        maxBackendReads = 8,
        enforceCharset = true,
        precompressed = false,
        preferSignedUrl,
        signedUrlExpiresSeconds = 60,
        accessControlExposeHeaders = false,
    } = opts;

    if (
        !(
            Number.isSafeInteger(maxRanges) &&
            maxRanges > 0 &&
            Number.isSafeInteger(maxBackendReads) &&
            maxBackendReads > 0
        )
    ) {
        throw new TypeError("serveObject: maxRanges and maxBackendReads must be integers >= 1");
    }
    if (typeof dispositionOpt !== "function" && dispositionOpt !== "inline" && dispositionOpt !== "attachment") {
        throw new TypeError('serveObject: disposition must be "inline", "attachment" or a function');
    }
    if (!(Number.isSafeInteger(signedUrlExpiresSeconds) && signedUrlExpiresSeconds > 0)) {
        throw new TypeError("serveObject: signedUrlExpiresSeconds must be an integer >= 1");
    }

    // Resolve the exposure list once: `true` means the protocol's own
    // non-safelisted headers; a string is caller-verbatim.
    const exposeHeaders =
        accessControlExposeHeaders === true ? PROTOCOL_EXPOSE_HEADERS : accessControlExposeHeaders || undefined;

    // Resolve and validate the precompressed coding list ONCE. An unknown
    // coding is a configuration bug: fail at setup, not per-request.
    const precompressedCodings: readonly PrecompressedCoding[] | null =
        precompressed === true
            ? DEFAULT_PRECOMPRESSED
            : precompressed === false
              ? null
              : resolvePrecompressedList(precompressed);

    // A consumer's observer hook must never break the never-throw contract. The
    // audit hook fires for bodyless emissions (302/304/412/416/HEAD) outside any
    // guard; the transfer hook fires from inside the body's stream machinery,
    // after the handler has returned, where a throw would error the response
    // mid-flight; an async hook's rejection would be unhandled. Hook failures
    // route to onError and the response is unaffected, and the sink itself is
    // guarded the same way so every consumer callback goes through one runner.
    const onErrorBase = guardSink(rawOnError);
    // The one place that decides what the sink receives. The error travels to
    // the same sink as the context, and the key can sit anywhere in it (a
    // message, an own property, a cause's request descriptor) in any spelling.
    // Under an auditKey the sink receives an allow-listed projection instead,
    // so no search for the key can miss, whatever failed: the store, the
    // context, or one of the caller's own hooks.
    const sinkFor = (auditKey: string | undefined): typeof onErrorBase =>
        onErrorBase && auditKey !== undefined
            ? (err: unknown, context: ServeErrorContext): void =>
                  onErrorBase(projectError(err, context.operation), { ...context, key: auditKey })
            : onErrorBase;

    // Resolve Cache-Control once (append immutable if configured)
    const cacheControl =
        immutableOpt && !rawCacheControl.includes("immutable") ? `${rawCacheControl}, immutable` : rawCacheControl;

    // Variant keys the store recently answered not-found for, so a compressible
    // object with no precompressed sibling does not pay the probes on every
    // request. Scoped to this handler (one store).
    const variantMisses = new VariantMisses(VARIANT_MISS_TTL_MS, VARIANT_MISS_MAX, VARIANT_MISS_KEY_MAX);
    // The variant keys the store recently confirmed, under the same bounds: a
    // repeat request probes down to the first remembered one and no further.
    const variantHits = new VariantHits(VARIANT_MISS_TTL_MS, VARIANT_MISS_MAX, VARIANT_MISS_KEY_MAX);

    // The handler never rejects: a consumer policy callback that throws or
    // returns a value of the wrong shape (disposition, securityHeaders,
    // preferSignedUrl), or a context of the wrong shape, is a 500 reported as
    // operation "context", the same answer the Node and Hono adapters give for
    // a throwing extractor.
    return async function handleServeRaw(req: ServableRequest, ctx: ServeContext): Promise<RawResponseParts> {
        try {
            return await serveRequest(req, ctx);
        } catch (err) {
            if (clientAborted(req.signal)) return clientClosed();
            const key = typeof ctx?.key === "string" ? ctx.key : "";
            sinkFor(ctx?.auditKey)?.(err, { key, operation: "context" });
            return plainTextError(500, "Internal Server Error");
        }
    };

    async function serveRequest(req: ServableRequest, ctx: ServeContext): Promise<RawResponseParts> {
        // The context is caller input a JS caller can get wrong; a wrong shape
        // is the caller's bug, answered as one rather than blamed on the store.
        if (typeof ctx !== "object" || ctx === null) throw new TypeError("serveObject: ctx must be an object");
        if (ctx.cacheControl !== undefined && typeof ctx.cacheControl !== "string") {
            throw new TypeError("serveObject: ctx.cacheControl must be a string");
        }
        if (typeof ctx.key !== "string") throw new TypeError("serveObject: ctx.key must be a string");

        // Method validation: only GET and HEAD are valid for file serving.
        // OPTIONS gets its standard method-discovery answer (204 + Allow, no
        // Content-Length per RFC 9110 Section 8.6); everything else gets 405
        // with Allow per RFC 9110 Section 15.5.6.
        const method = req.method;
        if (method === "OPTIONS") {
            return respond(204, { Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" });
        }
        if (method !== "GET" && method !== "HEAD") {
            return deny(405, { Allow: "GET, HEAD, OPTIONS", "Content-Length": "0" });
        }

        const { key } = ctx;
        const isHead = method === "HEAD";
        // One parse of the declared type decides the emitted header, the
        // sandbox, charset enforcement and compressibility; an off-grammar
        // value (a comma list included) resolves to application/octet-stream.
        const mediaType = resolveMediaType(ctx.mime);
        const mime = mediaType.value;

        // Audit-key substitution, bound once per request: when the caller
        // supplies ctx.auditKey, every hook event reports it as `key` (storage
        // keys commonly embed filenames -- personal data that must stay out of
        // logs), while the pipeline below keeps reading by the real key. The
        // shadowed names mean no downstream code needs to know which is in play.
        // `tag` is spread over every event last, so it decides the identity
        // fields wherever an event is built; negotiation and the metadata read
        // fill in the rest as they learn it.
        const auditKey = ctx.auditKey;
        const tag: ServedIdentity = { key: auditKey ?? key };
        const onError = sinkFor(auditKey);
        // A hook's own failure goes to the sink, and the response is unaffected.
        const hookFailed = (err: unknown): void => onError?.(err, { key, operation: "audit" });
        const onServeGuarded = guardHook(rawOnServe, hookFailed);
        const onTransferGuarded = guardHook(rawOnTransfer, hookFailed);
        const onServe = onServeGuarded && ((event: ServeAuditEvent): void => onServeGuarded({ ...event, ...tag }));
        const onTransfer =
            onTransferGuarded && ((event: TransferEvent): void => onTransferGuarded({ ...event, ...tag }));
        const auditCtx = onServe && { onServe, mime };
        // The timing hook fires while the response is being assembled, where a
        // throw would turn a healthy 200/206 into a 502.
        const onTimingGuarded = guardHook(onTiming, hookFailed);
        // A store error is reported and classified, unless the client already
        // went away: a store whose read fails once the request signal aborted
        // need not throw an AbortError, and the result is a client abort. An
        // AbortError with a live signal is the store's own cancellation
        // (a deadline), which is a store failure.
        const fail = (err: unknown, failedKey: string, operation: "head" | "get"): RawResponseParts => {
            if (clientAborted(req.signal)) return clientClosed();
            onError?.(err, { key: failedKey, operation });
            return storeErrorResponse(err);
        };
        /**
         * Mint a signed URL and answer a 302, sharing one implementation between the
         * range-incapable degradation path and the `preferSignedUrl` offload hook.
         * Only GET reaches it: HEAD always serves real headers from the origin.
         *
         * Returns `null` when the store declines (`{ ok: false }`): the caller then
         * streams the bytes itself, which is a correct response, so a decline is not
         * reported. A throw is a backend failure, reported and answered 502, unless
         * the request signal had aborted (a client abort, 499).
         *
         * The `cacheControl` handed to the provider rides the SIGNED response (S3
         * `response-cache-control`): without it, a private document served off the
         * bucket origin inherits whatever Cache-Control was baked into the object at
         * upload -- the classic footgun being a public/immutable value that a CDN
         * then caches for a year.
         */
        const redirect = async (): Promise<RawResponseParts | null> => {
            let result: Awaited<ReturnType<NonNullable<ObjectStore["createSignedUrl"]>>>;
            try {
                result = await store.createSignedUrl!(key, {
                    expiresInSeconds: signedUrlExpiresSeconds,
                    downloadFilename: ctx.filename,
                    cacheControl: effectiveCacheControl,
                    signal: req.signal,
                });
            } catch (err) {
                // Never-throw contract: a rejecting signed-URL provider becomes a
                // reported 502, never an escaped rejection (which crashes Express 4).
                if (clientAborted(req.signal)) return clientClosed();
                onError?.(err, { key, operation: "sign" });
                return storeErrorResponse(undefined);
            }
            if (!result.ok) return null;
            // A signed-URL redirect grants file access: audit it like a serve.
            onServe?.({ key, method: "GET", status: 302, mime, bytesServed: 0 });
            return respond(302, {
                // The signed URL is backend-derived: sanitize it like every
                // other metadata-sourced header so a malformed provider
                // response cannot inject a header or crash the writer.
                Location: sanitizeHeaderValue(result.url),
                "Cache-Control": "no-store, no-cache",
                "Accept-Ranges": "none",
                "Content-Length": "0",
            });
        };

        // Resolve Content-Disposition
        const dispositionType = typeof dispositionOpt === "function" ? dispositionOpt(mime) : dispositionOpt;
        // A callback's result is read where it is used: a promise or any other
        // value is a caller bug, refused rather than coerced to a disposition
        // the caller did not choose.
        if (dispositionType !== "inline" && dispositionType !== "attachment") {
            throw new TypeError('serveObject: disposition must be "inline" or "attachment"');
        }
        const safeDisposition = dispositionType;
        const disposition = ctx.filename
            ? buildContentDisposition(ctx.filename, { type: safeDisposition, fallback: fallbackFilename })
            : safeDisposition;

        // Active content rendered inline (SVG, HTML, XSLT-capable XML) executes
        // in the serving origin when a user opens it as a top-level document --
        // `nosniff` does not stop a genuine `image/svg+xml` from running its
        // embedded scripts. Put a sandbox CSP on exactly that combination; a
        // caller's own CSP is enforced alongside it, never instead of it.
        // Attachment responses and passive types (images, video, PDF) are
        // unaffected.
        const sandboxInline = safeDisposition === "inline" && isActiveContentMime(mediaType.essence);

        // Extra caller headers for success responses (200/206/304)
        const callerHeaders = securityHeaders?.(mime);
        if (securityHeaders && !isPlainObject(callerHeaders)) {
            throw new TypeError("serveObject: securityHeaders must return a plain object");
        }
        const extraHeaders = withSandboxPolicy(callerHeaders, sandboxInline);

        const effectiveCacheControl = ctx.cacheControl ?? cacheControl;

        // ── Detect request characteristics ──────────────────────────────────
        const headers = store.supportsRange === false ? withoutRangeHeaders(req.headers) : req.headers;
        const hasConditional = Boolean(
            headers.get("if-none-match") ||
            headers.get("if-modified-since") ||
            headers.get("if-match") ||
            headers.get("if-unmodified-since"),
        );
        const rangeHeader = headers.get("range");
        const hasIfRange = Boolean(headers.get("if-range"));
        // Multi-range (comma-separated) is served as multipart/byteranges. It
        // always needs the HEAD-resolved total to clamp bounds and cannot use the
        // single-range fast path.
        const isMultiRange = !isHead && Boolean(rangeHeader && rangeHeader.includes(","));
        // Range requests need HEAD to resolve: parseRangeHeader requires
        // totalSize to clamp bounds and detect unsatisfiable ranges.
        const needsHead = hasConditional || hasIfRange || isHead || Boolean(rangeHeader);

        // ── Range-incapable stores: signed-URL redirect when available ───────
        // A 302 answers a byte DOWNLOAD; it cannot answer a metadata probe or a
        // revalidation. A plain GET redirects immediately (no origin round-trip
        // at all). HEAD and conditional requests continue into the proxied path
        // so the origin answers with real headers, 304, or 412 -- redirecting
        // those would turn every revalidation into a full re-download from the
        // backend and every size probe into a bare Location. A conditional GET
        // whose evaluation still demands the body redirects at that point (the
        // rangelessOffload branch in Path A below).
        const rangelessOffload = store.supportsRange === false && Boolean(store.createSignedUrl);
        // supportsRange === false with no signed-URL path, or a declined
        // signature: serve the FULL representation through the origin instead
        // of failing. Range and If-Range read as absent (RFC 9110 Section 14.2
        // lets a server ignore Range), and every success response advertises
        // `Accept-Ranges: none` (rctx.acceptRanges) so clients stop asking.
        // Conditionals (304/412) still evaluate: they need no byte seeking.
        //
        // ── Per-request egress offload (preferSignedUrl) ─────────────────────
        // Consulted only when the range-incapable redirect does not already
        // apply, so one request asks the provider to sign at most once. HEAD
        // never offloads regardless of the predicate: a metadata probe
        // answered with a bare 302 defeats exactly the clients that send HEAD
        // (PDF.js size probing, cache priming), and costs the backend nothing
        // to answer at the origin.
        let offload = false;
        if (!isHead && store.createSignedUrl) {
            offload = rangelessOffload && !hasConditional;
            if (!offload && preferSignedUrl) {
                const preferred = preferSignedUrl({
                    key,
                    mime,
                    method: "GET",
                    isRange: Boolean(rangeHeader),
                    isConditional: hasConditional || hasIfRange,
                });
                if (typeof preferred !== "boolean") {
                    throw new TypeError("serveObject: preferSignedUrl must return a boolean");
                }
                offload = preferred;
            }
        }
        if (offload) {
            // A declined signature (`null`) falls through to streaming the bytes.
            const redirected = await redirect();
            if (redirected) return redirected;
        }

        // ── Precompressed variant negotiation (RFC 9110 Section 12.5.3) ──────
        // The negotiated sibling (`<key>.br`) is a DISTINCT representation: from
        // here down, its key, size, validators, and digest drive the entire
        // pipeline, so conditionals, If-Range, byte ranges, pinning, and the
        // drift guard are all evaluated against the encoded bytes. Multi-range
        // requests are excluded (multipart framing of an encoded representation
        // has no interoperable definition) and serve the identity object.
        //
        // A variant is served only under the identity object's authority: the
        // identity must exist (a variant of a deleted or never-written key is
        // not served) and the variant must not be older than it (a stale
        // sibling of a replaced object is not served). The identity's HEAD
        // rides the same round as the variant probes.
        let effectiveKey = key;
        let contentEncoding: string | undefined;
        // The metadata of `effectiveKey` the negotiation round already fetched,
        // consumed by the first Path A attempt so it does not HEAD again.
        let probedMeta: ObjectMetadata | undefined;
        let identityMeta: ObjectMetadata | undefined;
        // The variant's read when the negotiation round already opened it; handed
        // to the first response attempt, which owns its body from then on.
        let openedVariant: { stream: ObjectStream; getMs: number } | undefined;
        const negotiating = precompressedCodings !== null && isCompressibleMime(mime);
        if (negotiating && !isMultiRange) {
            const candidates = negotiateEncoding(headers.get("accept-encoding"), precompressedCodings).filter(
                isPrecompressedCoding,
            );
            // Only a plain GET (Path C) opens its body without first needing the
            // variant's metadata; a range or a conditional evaluates against that
            // metadata before any body is opened (304, 412 and 416 open none).
            const probe = await probeVariants(
                store,
                key,
                candidates,
                req.signal,
                variantMisses,
                variantHits,
                !needsHead,
            );
            if (probe.kind === "aborted") return clientClosed();
            if (probe.kind === "identityFailed") return fail(probe.err, key, "head");
            identityMeta = probe.identity;
            probedMeta = identityMeta;
            if (probe.failure) {
                // A probe failure (throttle, outage) must not fail the request --
                // the identity representation is always servable. Surface it for
                // telemetry; the identity read follows.
                onError?.(probe.failure.err, { key: probe.failure.variantKey, operation: probe.failure.operation });
            } else if (probe.hit) {
                probedMeta = probe.hit.meta;
                openedVariant = probe.hit.opened;
                effectiveKey = probe.hit.variantKey;
                contentEncoding = tag.contentEncoding = probe.hit.coding;
                if (auditKey === undefined) tag.variantKey = probe.hit.variantKey;
            }
        }

        // Response-building context shared by all response paths
        const makeContext = (coding: string | undefined): ResponseContext => ({
            mediaType,
            disposition,
            extraHeaders,
            cacheControl: effectiveCacheControl,
            crossOriginResourcePolicy,
            timingAllowOrigin,
            enforceCharset,
            digestWanted: clientWantsDigest(req.headers),
            contentDigestWanted: clientWantsContentDigest(req.headers),
            emitETag: etagEnabled,
            isHead,
            // A range-incapable store is served rangeless: advertise it.
            acceptRanges: store.supportsRange === false ? "none" : "bytes",
            contentEncoding: coding,
            // The response is encoding-negotiated whenever probing is CONFIGURED
            // for this type -- also when identity was chosen (the variant may
            // appear later) and on multi-range identity responses -- so shared
            // caches always key compressible objects on Accept-Encoding.
            varyAcceptEncoding: negotiating,
            exposeHeaders,
        });
        let rctx = makeContext(contentEncoding);

        // A negotiated variant can disappear between the probe and the read (a
        // deploy replacing its siblings). The identity object is still there, so
        // a variant that is gone is answered from it, once: returns whether the
        // request switched, so the caller re-runs against the identity key.
        const dropVariant = (): boolean => {
            if (effectiveKey === key) return false;
            variantHits.delete(effectiveKey);
            variantMisses.add(effectiveKey, Date.now());
            effectiveKey = key;
            probedMeta = identityMeta;
            contentEncoding = undefined;
            delete tag.contentEncoding;
            delete tag.variantKey;
            rctx = makeContext(undefined);
            return true;
        };

        // ── Path B: plain range on an authoritative-range store ──────────────
        // A range GET with no conditionals and no If-Range needs nothing from a
        // HEAD: stores whose 206 bounds/total come from the backend's actual
        // Content-Range can serve the seek in ONE round-trip (validators,
        // bounds, and digest all come from the GET itself -- inherently
        // TOCTOU-atomic). This halves latency on the hottest media path
        // (video seeking, PDF.js chunked loading). Suffix ranges (`bytes=-N`)
        // and anything the strict parser rejects fall through to Path A, whose
        // HEAD-resolved evaluation handles them.
        if (
            rangeHeader &&
            !hasConditional &&
            !hasIfRange &&
            !isHead &&
            store.authoritativeRange &&
            effectiveKey === key
        ) {
            const fastRange = parseFastRange(rangeHeader);
            if (fastRange) {
                let parts: RawResponseParts | null = null;
                // Capture (don't report yet) the speculative failure. A 502 falls
                // through to Path A, which re-runs and reports authoritatively --
                // reporting here too would double-count. But a terminal 404/503 is
                // served straight from Path B and never re-runs, so on the hottest
                // path (every authoritative-range seek) those failures would be
                // invisible to onError -- exactly the telemetry a monitoring
                // consumer wires up. Capture here, report once below if terminal.
                let speculativeErr: unknown;
                try {
                    parts = await streamFromStore({
                        store,
                        key,
                        range: fastRange,
                        ctx: rctx,
                        signal: req.signal,
                        onError: onError
                            ? (err) => {
                                  speculativeErr = err;
                              }
                            : undefined,
                        // A body failing on the wire is the served response's, never
                        // a speculative attempt's: it goes to the real sink.
                        onBodyError: onError && ((err) => onError(err, { key, operation: "get" })),
                        timingCtx: timingEnabled ? { storeMs: 0, evaluateMs: 0, onTiming: onTimingGuarded } : undefined,
                        auditCtx,
                        // A speculative success IS the served response, so it must meter.
                        // A failure returns 502 (no store body) and falls to Path A, which
                        // meters the real transfer -- no double-fire.
                        onTransfer,
                    });
                } catch {
                    // ObjectChangedError without a pin, or any other escape: fall
                    // through to Path A, which reports and responds correctly.
                }
                // A 502 here usually means the backend rejected the range natively
                // (e.g. start beyond EOF -> S3 InvalidRange). Path A's
                // HEAD-resolved evaluation turns that into the correct 416 with
                // real bounds (or surfaces the genuine store failure with full
                // error reporting). The retry only ever costs an extra attempt on
                // error paths.
                if (parts && parts.status !== 502) {
                    // Terminal outcome served from Path B (200/206 success, or a 404/503
                    // that Path A would never revisit): surface a captured 404/503 error
                    // exactly once so throttle/not-found storms stay visible to onError.
                    if ((parts.status === 404 || parts.status === 503) && speculativeErr !== undefined) {
                        onError?.(speculativeErr, { key, operation: "get" });
                    }
                    return parts;
                }
            }
        }

        // ── Path A: HEAD required ───────────────────────────────────────────
        // The GET is pinned to the HEAD's raw ETag (GetObjectOptions.ifMatch),
        // making the HEAD->GET pair atomic on backends with conditional reads.
        // If the object changes in that window the store throws
        // ObjectChangedError; re-validate ONCE against the new state so the
        // client gets a coherent answer (e.g. a stale If-Range now correctly
        // yields a full 200 of the new bytes) instead of an error.
        for (let attempt = 0; needsHead; attempt++) {
            let meta: ObjectMetadata;
            const t0 = timingEnabled ? performance.now() : 0;
            if (attempt === 0 && probedMeta) {
                // The negotiation round already fetched this representation's
                // metadata; a second HEAD would race it for no benefit. Retries
                // (attempt > 0) re-fetch: the object changed under a pinned read.
                meta = probedMeta;
            } else {
                try {
                    meta = await store.headObject(effectiveKey, { signal: req.signal });
                } catch (err) {
                    if (isNotFoundStoreError(err) && dropVariant()) {
                        attempt = -1; // the identity object gets its own full attempt
                        continue;
                    }
                    return fail(err, effectiveKey, "head");
                }
            }
            const storeMs = timingEnabled ? performance.now() - t0 : 0;
            let etag: string | undefined;

            // Full RFC 9110 evaluation chain. Conditionals apply to HEAD
            // exactly as to GET (RFC 9110 Section 13.1) -- a conditional HEAD must
            // still yield 304/412. Range, however, is only defined for GET
            // (RFC 9110 Section 14.2): the kernel ignores it (and If-Range, and
            // suppresses Content-Digest) when told the method is HEAD.
            const t1 = timingEnabled ? performance.now() : 0;
            let evaluation: ReturnType<typeof evaluateConditionalRequest>;
            try {
                tag.storedContentType = meta.contentType;
                // Only the three ETag fields: a custom store's metadata may
                // carry fields of its own under names generateETag reserves.
                etag = etagEnabled
                    ? generateETag({
                          etag: meta.etag,
                          contentLength: meta.contentLength,
                          lastModified: meta.lastModified,
                      })
                    : undefined;
                evaluation = evaluateConditionalRequest(
                    headers,
                    {
                        totalSize: meta.contentLength,
                        contentType: mime,
                        etag,
                        lastModified: meta.lastModified,
                        cacheControl: rctx.cacheControl,
                        digest: meta.digest,
                    },
                    { method: isHead ? "HEAD" : "GET" },
                );
            } catch (err) {
                // The kernel rejects corrupt store metadata (NaN/negative sizes)
                // with a RangeError. That is an adapter bug, but a handler must
                // always produce a Response -- an escaping throw becomes an
                // unhandled rejection (and a process crash under Express 4).
                onError?.(err, { key, operation: "head" });
                return storeErrorResponse(err);
            }
            const evaluateMs = timingEnabled ? performance.now() - t1 : 0;

            // Denials are audit events too: a 412 is an optimistic-concurrency
            // conflict (failed If-Match), exactly what SOC 2 change-control
            // trails want captured alongside grants.
            const audit = (status: 200 | 304 | 412 | 416): void =>
                onServe?.({ key, method: isHead ? "HEAD" : "GET", status, mime, bytesServed: 0, etag });

            // Early exits: 412, 304, 416
            if (evaluation.status === 304) {
                audit(304);
                // Caller extraHeaders ride the 304: RFC 9110 Section 15.4.5
                // requires any Vary (and Cache-Control/Expires) that the 200
                // would have carried to be generated on the 304 too, and
                // securityHeaders is the mechanism that adds Vary to the 200.
                // Negotiated responses add their own Vary member the same way.
                // A cross-origin revalidator needs ETag readable off the 304 too.
                return respond(304, applyNegotiationHeaders({ ...evaluation.headers, ...rctx.extraHeaders }, rctx));
            }
            if (evaluation.status === 412 || evaluation.status === 416) {
                audit(evaluation.status);
                return deny(evaluation.status, evaluation.headers);
            }

            // HEAD method: preconditions passed -- return headers only, no body
            // (PDF.js size probing, cache priming).
            if (isHead) {
                audit(200);
                return buildHeadResponse(meta, etag, rctx);
            }

            // Range-incapable store with a signed-URL path: the conditional
            // evaluation above needed the origin's real validators (its 304/412
            // already returned before this point), but the body itself has no
            // reason to proxy -- offload the would-be-200 download to the backend.
            if (rangelessOffload) {
                const redirected = await redirect();
                if (redirected) return redirected;
            }

            // Stream bytes from store, pinned to the representation just validated.
            // Only STRONG validators pin: RFC 9110 Section 13.1.1 mandates strong
            // comparison for If-Match, so a weak `W/` ETag would fail the
            // precondition on every attempt (guaranteed 412 -> retry -> 502).
            // Weak validators cannot assert byte equality anyway; the response-side
            // guard still protects those reads.
            const pinEtag = meta.etag && !meta.etag.startsWith("W/") ? meta.etag : undefined;
            const timingCtx = timingEnabled ? { storeMs, evaluateMs, onTiming: onTimingGuarded } : undefined;
            let singleRange = evaluation.range ?? undefined;
            let multi: ParsedRange[] | undefined;
            let partStore: Pick<ObjectStore, "getObject" | "pinsReads"> = store;

            // ── Multi-range: serve multipart/byteranges ──────────────────────────
            // evaluateConditionalRequest already settled 412/304 above (conditionals
            // are range-independent) and, because parseRangeHeader rejects comma
            // ranges, left this as a would-be 200. Honor the ranges here. A stale
            // If-Range (validator moved) means ignore the Range -> fall through to
            // the full 200 below; parseRanges returning null (amplification, or
            // malformed syntax) does the same, and one coalesced range (the whole
            // file included) is served as a plain 206.
            // An object stored already encoded has no interoperable multipart
            // framing either (see the negotiation note above): it serves whole.
            if (isMultiRange && !meta.contentEncoding && isRangeFresh(headers, etag, meta.lastModified)) {
                const set = parseRanges(rangeHeader, meta.contentLength, maxRanges);
                if (set === "unsatisfiable") {
                    audit(416);
                    return deny(416, build416Headers(meta.contentLength).headers);
                }
                if (set?.ranges.length === 1) singleRange = set.ranges[0];
                else if (set) {
                    // Within the read cap each part streams from its own read;
                    // past it, one buffered read must cover them all, or the
                    // full 200 is served.
                    const span = set.ranges.length > maxBackendReads ? coalescedSpan(set.ranges) : undefined;
                    if (span) partStore = spanReader(store, span);
                    if (span || set.ranges.length <= maxBackendReads) multi = set.ranges;
                }
            }

            try {
                return await (multi
                    ? serveMultipart({
                          store: partStore,
                          key: effectiveKey,
                          ranges: multi,
                          totalSize: meta.contentLength,
                          etag,
                          lastModified: meta.lastModified,
                          // Same RFC 9530 Section 4 negotiation as every other path: a
                          // client that declined sha-256 gets no digest on multipart.
                          digest: rctx.digestWanted ? meta.digest : undefined,
                          ifMatch: pinEtag,
                          pin: meta.pin,
                          ctx: rctx,
                          signal: req.signal,
                          timingCtx,
                          onError,
                          auditCtx,
                          onTransfer,
                      })
                    : streamFromStore({
                          store,
                          key: effectiveKey,
                          variantFallback: effectiveKey !== key,
                          range: singleRange,
                          ifMatch: pinEtag,
                          pin: meta.pin,
                          headEtag: etag,
                          headLastModified: meta.lastModified,
                          reprDigest: meta.digest,
                          ctx: rctx,
                          signal: req.signal,
                          onError,
                          timingCtx,
                          auditCtx,
                          onTransfer,
                      }));
            } catch (err) {
                // Re-validate ONCE, and only when a pinned read (single range or
                // the first multipart part) lost its race. Any other error
                // that escapes -- e.g. a corrupt-metadata RangeError rethrown from
                // buildHeaders -- is deterministic, so a retry just wastes a
                // HEAD+GET and drops the first failure from onError. Report it now.
                if (isObjectChangedError(err) && attempt === 0) continue;
                if (isNotFoundStoreError(err) && dropVariant()) {
                    attempt = -1; // the identity object gets its own full attempt
                    continue;
                }
                return fail(err, effectiveKey, "get");
            }
        }

        // ── Path C: No Range, no conditional headers ─────────────────────────
        // Same never-throw contract as Path A: corrupt GET metadata (header
        // builder RangeError), a throwing onServe hook, or a store throwing
        // ObjectChangedError without a pin must become a 502, not a rejected
        // handler (which crashes Express 4 processes).
        for (;;) {
            const opened = openedVariant;
            openedVariant = undefined;
            try {
                return await streamFromStore({
                    store,
                    key: effectiveKey,
                    variantFallback: effectiveKey !== key,
                    opened,
                    ctx: rctx,
                    signal: req.signal,
                    onError,
                    timingCtx: timingEnabled ? { storeMs: 0, evaluateMs: 0, onTiming: onTimingGuarded } : undefined,
                    auditCtx,
                    onTransfer,
                });
            } catch (err) {
                if (isNotFoundStoreError(err) && dropVariant()) continue;
                return fail(err, effectiveKey, "get");
            }
        }
    }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * How long a not-found precompressed variant is remembered. A variant uploaded
 * inside this window is served from the next request after it expires; until
 * then the identity object answers, which is always a correct response.
 */
const VARIANT_MISS_TTL_MS = 30_000;
/** Bound on remembered misses per handler; the oldest entry is dropped first. */
const VARIANT_MISS_MAX = 4096;
/** A key longer than this is probed every time: it comes from the request path and must not choose what stays in memory. */
const VARIANT_MISS_KEY_MAX = 1024;

/** The outcome of probing a request's identity object and candidate variants. */
type VariantProbe =
    | { kind: "aborted" }
    /** The identity object's own HEAD failed (not "not found"): the request fails as a store error. */
    | { kind: "identityFailed"; err: unknown }
    | {
          kind: "settled";
          /** The identity object's metadata; absent when it was not probed or does not exist. */
          identity: ObjectMetadata | undefined;
          /** The variant to serve, always one the identity authorizes. */
          hit?: {
              coding: PrecompressedCoding;
              variantKey: string;
              meta: ObjectMetadata;
              /** The variant's read, already opened by a remembered-hit probe; the response is built from it. */
              opened?: { stream: ObjectStream; getMs: number };
          };
          /** A probe failure ranked above the first hit: the identity is served. */
          failure?: { err: unknown; variantKey: string; operation: "head" | "get" };
      };

/** Whether a variant is older than the identity object it stands in for; unknown ages never disqualify. */
function isStaleVariant(variant: Pick<ObjectMetadata, "lastModified">, identity: ObjectMetadata): boolean {
    if (!variant.lastModified || !identity.lastModified) return false;
    return Date.parse(variant.lastModified) < Date.parse(identity.lastModified);
}

/** A candidate variant: its coding and the sibling key that holds it. */
interface VariantCandidate {
    coding: PrecompressedCoding;
    variantKey: string;
}

/**
 * The candidates to ask the store about, in preference order, minus the
 * remembered misses and ending at the first remembered hit. `direct` is that
 * hit when it is read instead of probed: only for `readVariant`, and only when
 * nothing ranks above it.
 */
function planProbes(
    key: string,
    candidates: readonly PrecompressedCoding[],
    misses: VariantMisses,
    hits: VariantHits,
    now: number,
    readVariant: boolean,
): { probes: VariantCandidate[]; direct?: VariantCandidate } {
    const ranked = candidates
        .map((coding) => ({ coding, variantKey: key + PRECOMPRESSED_SUFFIX[coding] }))
        .filter(({ variantKey }) => !misses.has(variantKey, now));
    const remembered = ranked.findIndex(({ variantKey }) => hits.has(variantKey, now));
    const probes = remembered === -1 ? ranked : ranked.slice(0, remembered + 1);
    return { probes, direct: readVariant && remembered === 0 ? ranked[0] : undefined };
}

/**
 * Probe the candidate siblings and the identity object at once, so negotiation
 * costs one round trip however many codings the client accepts, and take the
 * best-ranked hit the identity authorizes. Candidates arrive in preference
 * order, and every probe has been sent by the time the first answer is read, so
 * each not-found is remembered for {@link VARIANT_MISS_TTL_MS} (see
 * {@link VariantMisses}), whatever the outcome ranked above it, and skipped
 * meanwhile. A variant the store confirmed is remembered the same way (see
 * {@link VariantHits}): the probe stops at the first remembered one, since
 * nothing ranked below it can win, so a repeat request sends one variant HEAD
 * plus the identity HEAD. When `readVariant` is set (a plain GET, which needs
 * no variant metadata before it opens the body) and the remembered hit is the
 * only candidate left, the variant is read instead of probed: its GET and the
 * identity HEAD go out together and the GET's own validators stand in for the
 * variant HEAD (see {@link readRememberedVariant}).
 *
 * The verdict is taken in rank order: a client abort, or any other probe
 * failure ranked above the first hit, ends the walk with that outcome and the
 * caller serves identity; the first hit wins, unless the identity object is
 * missing (nothing authorizes a variant) or newer than the variant (the
 * variant is a stale build output, remembered as a miss).
 */
async function probeVariants(
    store: Pick<ObjectStore, "headObject" | "getObject">,
    key: string,
    candidates: readonly PrecompressedCoding[],
    signal: AbortSignal | undefined,
    misses: VariantMisses,
    hits: VariantHits,
    readVariant: boolean,
): Promise<VariantProbe> {
    const now = Date.now();
    const { probes, direct } = planProbes(key, candidates, misses, hits, now, readVariant);
    if (direct) return readRememberedVariant(store, key, direct, signal, misses, hits, now);
    if (probes.length === 0) return { kind: "settled", identity: undefined };
    const [identityOutcome, ...settled] = await Promise.allSettled([
        store.headObject(key, { signal }),
        ...probes.map((p) => store.headObject(p.variantKey, { signal })),
    ]);
    for (const [i, outcome] of settled.entries()) {
        const { variantKey } = probes[i]!;
        if (outcome.status === "fulfilled") misses.delete(variantKey);
        else if (isNotFoundStoreError(outcome.reason)) {
            misses.add(variantKey, now);
            hits.delete(variantKey);
        }
    }
    let identity: ObjectMetadata | undefined;
    if (identityOutcome!.status === "fulfilled") identity = identityOutcome!.value;
    else if (clientAborted(signal)) return { kind: "aborted" };
    else if (!isNotFoundStoreError(identityOutcome!.reason)) {
        return { kind: "identityFailed", err: identityOutcome!.reason };
    }
    for (const [i, outcome] of settled.entries()) {
        const { coding, variantKey } = probes[i]!;
        if (outcome.status === "fulfilled") {
            if (!identity) break;
            if (isStaleVariant(outcome.value, identity)) {
                misses.add(variantKey, now);
                hits.delete(variantKey);
                continue;
            }
            hits.add(variantKey, now);
            return { kind: "settled", identity, hit: { coding, variantKey, meta: outcome.value } };
        }
        if (clientAborted(signal)) return { kind: "aborted" };
        if (!isNotFoundStoreError(outcome.reason)) {
            return { kind: "settled", identity, failure: { err: outcome.reason, variantKey, operation: "head" } };
        }
    }
    return { kind: "settled", identity };
}

/**
 * The remembered-hit form of {@link probeVariants}: the variant's GET and the
 * identity's HEAD are sent together, so the pair costs two calls in one round
 * trip where a HEAD of each and then the GET cost three calls in two.
 *
 * The variant is served only while the identity exists and is not newer than
 * it, judged on the validators the GET itself returned. Every other outcome
 * releases the opened body and answers from the identity object: a missing
 * identity, a newer identity (the variant is remembered as a miss), a variant
 * answered not-found (the memo is cleared and it is remembered as a miss), or
 * a variant read that failed otherwise (reported, never fatal).
 */
async function readRememberedVariant(
    store: Pick<ObjectStore, "headObject" | "getObject">,
    key: string,
    { coding, variantKey }: VariantCandidate,
    signal: AbortSignal | undefined,
    misses: VariantMisses,
    hits: VariantHits,
    now: number,
): Promise<VariantProbe> {
    const t0 = performance.now();
    const [identityOutcome, readOutcome] = await Promise.allSettled([
        store.headObject(key, { signal }),
        store.getObject(variantKey, { signal }),
    ]);
    const release = (): void => {
        if (readOutcome.status === "fulfilled") cancelBody(readOutcome.value.body);
    };
    let identity: ObjectMetadata | undefined;
    if (identityOutcome.status === "fulfilled") identity = identityOutcome.value;
    else if (clientAborted(signal)) {
        release();
        return { kind: "aborted" };
    } else if (!isNotFoundStoreError(identityOutcome.reason)) {
        release();
        return { kind: "identityFailed", err: identityOutcome.reason };
    }
    if (readOutcome.status === "rejected") {
        if (clientAborted(signal)) return { kind: "aborted" };
        if (isNotFoundStoreError(readOutcome.reason)) {
            misses.add(variantKey, now);
            hits.delete(variantKey);
            return { kind: "settled", identity };
        }
        return { kind: "settled", identity, failure: { err: readOutcome.reason, variantKey, operation: "get" } };
    }
    const opened = readOutcome.value;
    if (!identity || isStaleVariant(opened, identity)) {
        release();
        if (identity) {
            misses.add(variantKey, now);
            hits.delete(variantKey);
        }
        return { kind: "settled", identity };
    }
    misses.delete(variantKey);
    hits.add(variantKey, now);
    return {
        kind: "settled",
        identity,
        hit: { coding, variantKey, meta: opened, opened: { stream: opened, getMs: performance.now() - t0 } },
    };
}

/** Whether a Content-Security-Policy value already carries a `sandbox` directive in any of its policies. */
const HAS_SANDBOX_DIRECTIVE = /(?:^|[;,])\s*sandbox(?:\s|;|,|$)/i;

/**
 * The caller's extra headers with the inline-active-content sandbox applied.
 *
 * A Content-Security-Policy field may carry several comma-separated policies
 * and a browser enforces each, so the sandbox is APPENDED as its own policy to
 * a caller's CSP rather than replaced by it: a routine hardening header must
 * not silently remove the sandbox. A caller policy that already has a
 * `sandbox` directive is left as written.
 */
function withSandboxPolicy(caller: Record<string, string> | undefined, sandbox: boolean): Record<string, string> {
    if (!sandbox) return { ...caller };
    const own = Object.entries(caller ?? {}).find(([k]) => k.toLowerCase() === "content-security-policy");
    if (own === undefined) return { ...caller, "Content-Security-Policy": "sandbox" };
    const [name, policy] = own;
    return HAS_SANDBOX_DIRECTIVE.test(policy) ? { ...caller } : { ...caller, [name]: `${policy}, sandbox` };
}

/**
 * Wrap a headers view so Range and If-Range read as absent.
 *
 * Used for range-incapable stores (`supportsRange: false` without a
 * signed-URL path): RFC 9110 Section 14.2 lets a server ignore Range, so
 * the whole pipeline serves the full representation while conditionals
 * still apply. (HEAD needs no masking -- the kernel is method-aware.)
 */
function withoutRangeHeaders(headers: { get(name: string): string | null }): { get(name: string): string | null } {
    return {
        get(name: string): string | null {
            const lower = name.toLowerCase();
            if (lower === "range" || lower === "if-range") return null;
            return headers.get(lower);
        },
    };
}

/** Validate a caller-supplied precompressed coding list at setup time. */
function resolvePrecompressedList(codings: readonly PrecompressedCoding[]): readonly PrecompressedCoding[] | null {
    if (codings.length === 0) return null;
    for (const coding of codings) {
        if (!isPrecompressedCoding(coding)) {
            throw new TypeError(`serveObject: unknown precompressed coding "${coding}"`);
        }
    }
    return codings;
}

/**
 * Active content types, besides every `+xml` type, that can execute script
 * or make outbound requests when rendered inline as a top-level document
 * from the serving origin. XML is included for its XSLT processing
 * instruction, which several browsers still execute, and `text/xsl` is a
 * stylesheet that runs as one.
 */
const ACTIVE_CONTENT_MIMES = new Set(["text/html", "text/xml", "application/xml", "text/xsl"]);

/**
 * Whether a media type's essence is active content a browser renders with script or
 * stylesheet execution. Every `+xml` structured-syntax type (RFC 6839
 * Section 4.1) is included: an XML document can carry an
 * `<?xml-stylesheet?>` processing instruction that runs XSLT, and SVG,
 * XHTML and MathML can carry script.
 */
function isActiveContentMime(essence: string): boolean {
    return essence.endsWith("+xml") || ACTIVE_CONTENT_MIMES.has(essence);
}

/**
 * Append `Accept-Encoding` to a Vary field value without duplicating it.
 * `Vary: *` already covers every header and is left untouched.
 */
function appendVaryAcceptEncoding(existing: string | undefined): string {
    if (!existing) return "Accept-Encoding";
    const members = existing.split(",").map((m) => m.trim().toLowerCase());
    if (members.includes("*") || members.includes("accept-encoding")) return existing;
    return `${existing}, Accept-Encoding`;
}

/**
 * Parse a Range header for the single-round-trip fast path (no totalSize
 * available yet). Accepts only `bytes=a-b` and `bytes=a-` (an open end is left
 * absent; RFC 9110 Section 14.1.2 lets the server clamp a
 * last-byte-pos past EOF, and authoritative-range backends do). Everything
 * else -- suffix ranges, multi-range, malformed specs -- returns null so the
 * validating HEAD path evaluates it with the real object size.
 */
function parseFastRange(header: string): ReadRange | null {
    const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
    if (!m) return null;
    const start = Number(m[1]);
    if (!Number.isSafeInteger(start)) return null;
    const end = m[2] ? Number(m[2]) : undefined;
    if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) return null;
    return { start, end };
}

/** Shared response-building context resolved once per request. */
interface ResponseContext {
    readonly mediaType: MediaType;
    readonly disposition: string;
    readonly extraHeaders: Record<string, string>;
    readonly cacheControl: string;
    readonly crossOriginResourcePolicy?: string;
    readonly timingAllowOrigin?: string;
    readonly enforceCharset: boolean;
    /** RFC 9530 Section 4: does Want-Repr-Digest accept sha-256? */
    readonly digestWanted: boolean;
    /** RFC 9530 Section 4: does Want-Content-Digest accept sha-256? */
    readonly contentDigestWanted: boolean;
    /** Emit derived ETags (ServeObjectOptions.etag). */
    readonly emitETag: boolean;
    /** HEAD request: Content-Digest must not assert the representation hash. */
    readonly isHead: boolean;
    /** "none" for range-incapable stores served rangeless. */
    readonly acceptRanges: "bytes" | "none";
    /** Negotiated content coding of the served variant (`Content-Encoding`). */
    readonly contentEncoding?: string;
    /**
     * Encoding negotiation is configured for this representation: every
     * success response (200/206/304/HEAD, variant or identity) must carry
     * `Vary: Accept-Encoding` so shared caches key on the request coding.
     */
    readonly varyAcceptEncoding: boolean;
    /** Resolved Access-Control-Expose-Headers value, when configured. */
    readonly exposeHeaders?: string;
}

/** Protocol metadata for building response headers. */
interface ProtocolMeta {
    /** Full size, or `undefined` for an unknown-total partial (`bytes a-b/*`). */
    totalSize: number | undefined;
    range?: ParsedRange;
    etag?: string;
    lastModified?: string;
    digest?: string;
    /** Coding the store reports for the stored bytes (`Content-Encoding`). */
    contentEncoding?: string;
}

/**
 * Append `; charset=utf-8` to a textual Content-Type when charset enforcement
 * is on and none is present. Shared by the single-range/200 path and each
 * multipart part so their Content-Type (and thus the precomputed
 * Content-Length) is derived identically.
 */
function withCharset(ctx: ResponseContext): string {
    const { value, essence, charset } = ctx.mediaType;
    return ctx.enforceCharset && isTextualMime(essence) && charset === undefined ? `${value}; charset=utf-8` : value;
}

/**
 * Layer the adapter's success-response header tail (Content-Disposition,
 * nosniff, caller `extraHeaders`, CORP, TAO) onto a protocol header base.
 * Shared by the single-range/200 and multipart paths so a future security
 * header can never be added to one and silently forgotten on the other.
 */
function applyAdapterHeaders(base: Record<string, string>, ctx: ResponseContext): Record<string, string> {
    const headers: Record<string, string> = {
        ...base,
        "Content-Disposition": ctx.disposition,
        "X-Content-Type-Options": "nosniff",
        ...ctx.extraHeaders,
    };
    if (ctx.crossOriginResourcePolicy) headers["Cross-Origin-Resource-Policy"] = ctx.crossOriginResourcePolicy;
    if (ctx.timingAllowOrigin) headers["Timing-Allow-Origin"] = ctx.timingAllowOrigin;
    return applyNegotiationHeaders(headers, ctx);
}

/**
 * The headers a response carries because of the handler's options rather than
 * its status: cross-origin exposure and the Accept-Encoding Vary member. Shared
 * by every success status including the 304, so a header added here reaches
 * them all.
 */
function applyNegotiationHeaders(headers: Record<string, string>, ctx: ResponseContext): Record<string, string> {
    // Caller extraHeaders win (already spread into `headers`): only fill when absent.
    if (ctx.exposeHeaders && !headers["Access-Control-Expose-Headers"]) {
        headers["Access-Control-Expose-Headers"] = ctx.exposeHeaders;
    }
    // Merged LAST so a caller-supplied Vary (extraHeaders) is extended, never
    // clobbered, and vice versa.
    if (ctx.varyAcceptEncoding) headers["Vary"] = appendVaryAcceptEncoding(headers["Vary"]);
    return headers;
}

/**
 * Build response headers by composing the kernel's protocol headers with
 * adapter-specific extras.
 */
function buildHeaders(ctx: ResponseContext, meta: ProtocolMeta): Record<string, string> {
    const { headers: protocol } = buildRangeResponseHeaders({
        totalSize: meta.totalSize,
        range: meta.range ?? null,
        contentType: withCharset(ctx),
        etag: meta.etag,
        lastModified: meta.lastModified,
        // RFC 9530 Section 4: each digest field honors its own Want-* member,
        // independently of the other. A declined Repr-Digest must not swallow a
        // wanted Content-Digest, so the digest value passes through unfiltered
        // and each field carries its own gate.
        digest: meta.digest,
        reprDigest: ctx.digestWanted,
        // Content-Digest requires an actual full body: never on HEAD (empty
        // message content, RFC 9530 Appendix B.2), never when the client
        // declined it via Want-Content-Digest.
        contentDigest: !ctx.isHead && ctx.contentDigestWanted,
        cacheControl: ctx.cacheControl,
    });
    // Range-incapable stores advertise honestly instead of inviting 206s
    // the pipeline will never grant.
    if (ctx.acceptRanges === "none") protocol["Accept-Ranges"] = "none";
    // A negotiated precompressed variant, or an object stored already encoded,
    // IS the representation: its coding is representation metadata, and the
    // surrounding validators/digest/ranges already describe the encoded bytes
    // (RFC 9110 Section 14.2). The negotiated coding names the variant key.
    const coding = ctx.contentEncoding ?? meta.contentEncoding;
    if (coding) protocol["Content-Encoding"] = coding;

    return applyAdapterHeaders(protocol, ctx);
}

/** Build a HEAD-only response (no body). */
function buildHeadResponse(meta: ObjectMetadata, etag: string | undefined, ctx: ResponseContext): RawResponseParts {
    return respond(
        200,
        buildHeaders(ctx, {
            totalSize: meta.contentLength,
            etag,
            lastModified: meta.lastModified,
            digest: meta.digest,
            contentEncoding: meta.contentEncoding,
        }),
    );
}

/** Timing context passed to streamFromStore when timing is enabled. */
/** Fold the GET time into the store phase, report it, and render Server-Timing. */
function reportTiming(t: TimingContext, getMs: number): string {
    const storeMs = t.storeMs + getMs;
    t.onTiming?.({ storeMs, evaluateMs: t.evaluateMs, totalMs: storeMs + t.evaluateMs });
    return `store;dur=${storeMs.toFixed(1)},eval;dur=${t.evaluateMs.toFixed(1)}`;
}

interface TimingContext {
    storeMs: number;
    evaluateMs: number;
    onTiming?: (metrics: { storeMs: number; evaluateMs: number; totalMs: number }) => void;
}

/** Audit context passed to streamFromStore when onServe is configured. */
interface AuditContext {
    onServe: (event: ServeAuditEvent) => void;
    mime: string;
}

/** Options for streamFromStore. */
interface StreamOpts {
    store: ObjectStore;
    key: string;
    range?: ReadRange;
    /** Opaque adapter pin token from the HEAD metadata (GetObjectOptions.pin). */
    pin?: string;
    /**
     * Raw backend ETag to pin the read to (GetObjectOptions.ifMatch). When the
     * store supports it and the object changed, getObject throws
     * ObjectChangedError, which propagates to the caller for re-validation.
     */
    ifMatch?: string;
    /**
     * The key is a negotiated variant with an identity object behind it: a
     * missing variant propagates to the caller, which answers from the identity
     * key instead of reporting a 404 for an object that exists.
     */
    variantFallback?: boolean;
    /** A read of `key` already opened (and timed) by the negotiation round: used instead of a `getObject`. */
    opened?: { stream: ObjectStream; getMs: number };
    /**
     * The range was resolved against a HEAD (a store that is not
     * `authoritativeRange`), so the span the store served must be the span
     * asked for: a different label is an incoherent store, not a clamp.
     */
    exactRange?: boolean;
    /** The store enforces `ifMatch` itself ({@link ObjectStore.pinsReads}). */
    pinsReads?: boolean;
    headEtag?: string;
    headLastModified?: string;
    reprDigest?: string;
    ctx: ResponseContext;
    signal?: AbortSignal;
    onError?: (error: unknown, context: { key: string; operation: "head" | "get" }) => void;
    /**
     * Receives a failure of the response body once it is on the wire (a source
     * that errors mid-stream, a length mismatch). Defaults to `onError`; a caller
     * whose `onError` only captures a speculative attempt passes the real sink.
     */
    onBodyError?: (error: unknown) => void;
    timingCtx?: TimingContext;
    auditCtx?: AuditContext;
    /**
     * Guarded transfer-completion hook. When present, the served body is routed
     * through a counting stream that fires this once on terminal state with the
     * true bytes transferred.
     */
    onTransfer?: (event: TransferEvent) => void;
}

/**
 * Stream bytes from the store, building a proper 200/206 response.
 *
 * Maps store failures to responses internally, with two exceptions rethrown to
 * the caller: ObjectChangedError (a pinned read losing its race, to re-validate
 * against the object's new state) and, for a negotiated variant, a missing
 * object (to answer from the identity key).
 */
async function streamFromStore(opts: StreamOpts): Promise<RawResponseParts> {
    const { store, key, range, ifMatch, variantFallback, pin, signal, onError, timingCtx } = opts;

    if (opts.opened) {
        return respondFromRead(
            { ...opts, exactRange: !store.authoritativeRange, pinsReads: store.pinsReads === true },
            opts.opened.stream,
            opts.opened.getMs,
        );
    }
    const t0 = timingCtx ? performance.now() : 0;
    let result: ObjectStream;
    try {
        result = await store.getObject(key, { range, signal, ifMatch, pin });
    } catch (err) {
        if (isObjectChangedError(err) || (variantFallback && isNotFoundStoreError(err))) throw err;
        if (clientAborted(signal)) return clientClosed();
        onError?.(err, { key, operation: "get" });
        return storeErrorResponse(err);
    }
    return respondFromRead(
        { ...opts, exactRange: !store.authoritativeRange, pinsReads: store.pinsReads === true },
        result,
        timingCtx ? performance.now() - t0 : 0,
    );
}

/**
 * Turn an opened store read into the response, after checking it is coherent
 * and the representation the conditionals were evaluated against. Owns the
 * read's body from here: every path either hands it to the response or
 * cancels it.
 */
function respondFromRead(
    opts: Omit<StreamOpts, "store" | "variantFallback" | "opened">,
    result: ObjectStream,
    getMs: number,
): RawResponseParts {
    const {
        key,
        range,
        ifMatch,
        pin,
        pinsReads,
        headEtag,
        headLastModified,
        reprDigest,
        exactRange,
        ctx,
        signal,
        onError,
        timingCtx,
        auditCtx,
        onTransfer,
    } = opts;
    const onBodyError = opts.onBodyError ?? ((err: unknown) => onError?.(err, { key, operation: "get" }));

    // Derive the response ETag from the GET result itself: strong from the
    // backend's own ETag when present, weak from size + mtime otherwise. This keeps
    // validators consistent between Path A (HEAD-derived) and Path C (GET-only),
    // so plain 200s from stores with no ETag of their own (fs) still carry a
    // revalidator.
    const got = readValidators(ctx, result);
    // TOCTOU guard: the range the backend ACTUALLY served is the source of
    // truth for 206 vs 200 AND for the emitted byte bounds. If a range was
    // requested but the GET result carries none, the store served full
    // content: emit 200, never a lying 206. Incoherent bounds (a custom-store
    // bug) cannot be trusted -- emitting them would corrupt client caches,
    // so fail loudly instead.
    const actualRange = range ? (result.range ?? null) : null;
    const incoherent = (detail: string): RawResponseParts => {
        const err = new Error(`Store returned incoherent ${detail}`);
        // The body was never handed to a response: cancel a stream form or the
        // backing resource (fs file handle, pooled HTTP socket) stays open
        // until GC. Byte bodies hold nothing. Cancelled before the sink is
        // told, so a throwing onError cannot strand it.
        cancelBody(result.body);
        onError?.(err, { key, operation: "get" });
        return storeErrorResponse(err);
    };
    if (actualRange && !isServableRange(actualRange, result.totalSize)) {
        return incoherent(`range ${actualRange.start}-${actualRange.end}/${result.totalSize}`);
    }
    if (exactRange && range && actualRange && (actualRange.start !== range.start || actualRange.end !== range.end)) {
        return incoherent(`range ${actualRange.start}-${actualRange.end} for requested ${range.start}-${range.end}`);
    }
    // Byte-count coherence: the emitted Content-Length is derived from the range
    // span (206) or totalSize (200), but the body streams result.contentLength
    // bytes. A store that reports a contentLength disagreeing with those would
    // commit a Content-Length that over- or under-runs the body -- a truncated
    // response the client cannot distinguish from a complete one. The multipart
    // path enforces this per part (servedSpanMatches); the hotter single-range
    // and 200 paths must guarantee it too. (A 200 with undefined totalSize is an
    // adapter bug the header builder already rejects, so only the defined case
    // is checked here.) A byte body's REAL length is known here as well, so it
    // is held to the same count before headers commit; a stream body settles
    // lazily and is held to it by boundBody below.
    const claimedLength = result.contentLength;
    const incoherentByteCount = actualRange
        ? claimedLength !== actualRange.end - actualRange.start + 1
        : result.totalSize !== undefined && claimedLength !== result.totalSize;
    // A stream body's real length settles later; it reads as the claim here.
    const bodyLength = result.body instanceof Uint8Array ? result.body.byteLength : claimedLength;
    if (incoherentByteCount || bodyLength !== claimedLength) {
        return incoherent(`byte count: contentLength=${claimedLength} body=${bodyLength}`);
    }
    // The body must come from the representation the conditionals and
    // If-Range were just evaluated against, and the validators and digest
    // emitted below describe it. HEAD values stand in for a validator the read
    // omits only when the read is verified to be that representation.
    const verified = acceptRead(key, { etag: headEtag, lastModified: headLastModified }, got, result.body, {
        ifMatch,
        pin,
        pinsReads,
    });
    const finalEtag = ctx.emitETag ? (got.etag ?? (verified ? headEtag : undefined)) : undefined;
    const finalLastModified = got.lastModified ?? (verified ? headLastModified : undefined);
    const finalDigest = result.digest ?? (verified ? reprDigest : undefined);
    const isPartial = actualRange !== null;
    const status = isPartial ? 206 : 200;
    const responseRange = actualRange ?? undefined;
    const totalSize = result.totalSize;

    // Between here and the returned parts the body has an owner only on the
    // happy path: a throw from the audit hook or header builder would
    // otherwise leak a stream form.
    try {
        const headers = buildHeaders(ctx, {
            totalSize,
            range: responseRange,
            etag: finalEtag,
            lastModified: finalLastModified,
            digest: finalDigest,
            contentEncoding: result.contentEncoding,
        });
        // Reported only once the read is accepted and the headers commit, so a
        // re-validated attempt or a refused store result never reports.
        if (timingCtx) headers["Server-Timing"] = reportTiming(timingCtx, getMs);

        // Audit AFTER the headers commit, never before. onServe is the "grant"
        // event, so it must not fire for a response that never materializes: if
        // buildHeaders throws on corrupt metadata this streamFromStore call is
        // discarded (Path A re-runs, or a 502 is returned), and an onServe fired
        // up front would double-count the retry or log a phantom grant on a 502.
        if (auditCtx) {
            // streamFromStore only runs for GET: HEAD returns early via
            // buildHeadResponse, and Path C is unreachable when isHead forces needsHead.
            auditCtx.onServe({
                key,
                method: "GET",
                status: status as 200 | 206,
                mime: auditCtx.mime,
                bytesServed: result.contentLength,
                etag: finalEtag,
                ...(responseRange ? { rangeStart: responseRange.start, rangeEnd: responseRange.end } : {}),
            });
        }

        // A stream body is always bound to the committed Content-Length: a source
        // that ends short of it, or runs past it, errors the response instead of
        // delivering a torn body under a complete-looking status. A byte body was
        // held to the count above and keeps the runtime's static-body fast path
        // unless a transfer hook wants it metered. The wrap happens AFTER
        // buildHeaders and the audit hook, so the catch below still cancels the
        // untouched original on any earlier throw (once wrapped, the source reader
        // is locked and owned by the returned stream).
        const report = onTransfer
            ? (bytesTransferred: number, completed: boolean): void =>
                  onTransfer({
                      key,
                      method: "GET",
                      status: status as 200 | 206,
                      bytesExpected: result.contentLength,
                      bytesTransferred,
                      completed,
                      ...(responseRange ? { rangeStart: responseRange.start, rangeEnd: responseRange.end } : {}),
                  })
            : undefined;
        const body =
            result.body instanceof Uint8Array && !report
                ? result.body
                : boundBody(result.body, {
                      expected: result.contentLength,
                      report,
                      signal,
                      onFailure: onBodyError,
                  });

        return respond(status, headers, body);
    } catch (err) {
        cancelBody(result.body);
        throw err;
    }
}

/** Options for {@link serveMultipart}. */
interface MultipartOpts {
    store: Pick<ObjectStore, "getObject" | "pinsReads">;
    key: string;
    /** Coalesced, satisfiable ranges (length >= 2), clamped to the object size. */
    ranges: ParsedRange[];
    totalSize: number;
    etag?: string;
    lastModified?: string;
    digest?: string;
    ifMatch?: string;
    pin?: string;
    ctx: ResponseContext;
    signal?: AbortSignal;
    onError?: (error: unknown, context: { key: string; operation: "head" | "get" }) => void;
    /** Timing context: measures the eagerly-fetched first part (lazy parts settle after headers). */
    timingCtx?: TimingContext;
    auditCtx?: AuditContext;
    onTransfer?: (event: TransferEvent) => void;
}

/**
 * Serve multiple byte ranges as a `multipart/byteranges` (206) response.
 *
 * The Content-Length is computed exactly by the kernel from the framing and
 * the range spans, so the response is never chunked. The first part is fetched
 * EAGERLY so a pinned-read `ObjectChangedError` surfaces before headers commit
 * (giving the caller the same one-shot re-validation single-range serving
 * gets); the remaining parts stream lazily, one `getObject` per range, each
 * pinned to the same representation via `ifMatch`.
 *
 * Relies on each store serving exactly the requested (already size-clamped)
 * span per range -- which every bundled adapter does -- so the precomputed
 * Content-Length matches the streamed body byte-for-byte.
 */
async function serveMultipart(opts: MultipartOpts): Promise<RawResponseParts> {
    const {
        store,
        key,
        ranges,
        totalSize,
        etag,
        lastModified,
        digest,
        ifMatch,
        pin,
        ctx,
        signal,
        onError,
        timingCtx,
        auditCtx,
        onTransfer,
    } = opts;

    const boundary = generateMultipartBoundary();
    // Each part carries the representation's own Content-Type; apply the same
    // charset enforcement single-range responses use so the value (and thus the
    // precomputed Content-Length) is identical to what the framing emits.
    const partContentType = withCharset(ctx);

    // Fetch the first part up front: a pinned read losing its race throws
    // ObjectChangedError HERE, before any headers are committed, so the caller
    // can re-validate once. Abort and store errors map to responses.
    const t0 = timingCtx ? performance.now() : 0;
    let firstStream: Awaited<ReturnType<ObjectStore["getObject"]>>;
    try {
        firstStream = await store.getObject(key, { range: ranges[0], signal, ifMatch, pin });
    } catch (err) {
        if (isObjectChangedError(err)) throw err;
        if (clientAborted(signal)) return clientClosed();
        onError?.(err, { key, operation: "get" });
        return storeErrorResponse(err);
    }
    const getMs = timingCtx ? performance.now() - t0 : 0;

    // Validate the first part's served span BEFORE headers commit. On a
    // non-pinning store (one that cannot honor ifMatch/pin), a concurrent
    // overwrite between parts would otherwise splice bytes across
    // representations or under-run the precomputed Content-Length. A first-part
    // mismatch re-validates once via the orchestrator's retry loop. A store
    // that ignored the range and answered with the whole representation is
    // served as the 200 RFC 9110 Section 14.2 permits, as the single-range
    // path does.
    if (firstStream.range === undefined) {
        return respondFromRead(
            {
                key,
                ifMatch,
                pin,
                pinsReads: store.pinsReads === true,
                headEtag: etag,
                headLastModified: lastModified,
                reprDigest: digest,
                ctx,
                signal,
                onError,
                timingCtx,
                auditCtx,
                onTransfer,
            },
            firstStream,
            getMs,
        );
    }
    if (!firstPartMatches(firstStream, ranges[0]!)) {
        cancelBody(firstStream.body);
        throw new ObjectChangedError(key);
    }

    // The first part must come from the representation the HEAD described: the
    // headers below carry the HEAD's validators and digest. The same acceptance
    // test as the single-range and full paths decides it.
    const verified = acceptRead(key, { etag, lastModified }, readValidators(ctx, firstStream), firstStream.body, {
        ifMatch,
        pin,
        pinsReads: store.pinsReads === true,
    });
    // From here the first part is owned by this function until the returned
    // body takes it: anything that throws before the return releases it, so a
    // failure never strands a descriptor-backed stream (the rule
    // streamFromStore states for its single body).
    try {
        const headDescribes = verified ? { etag, lastModified, digest } : {};

        const multipart = buildMultipartHeaders({
            boundary,
            ranges,
            totalSize,
            contentType: partContentType,
            etag: headDescribes.etag,
            lastModified: headDescribes.lastModified,
            // RFC 9530 Section 4: respect Want-Repr-Digest negotiation exactly like
            // buildHeaders does for single-range responses; weight 0 or an algorithm
            // list without sha-256 means "do not send".
            digest: ctx.digestWanted ? headDescribes.digest : undefined,
            cacheControl: ctx.cacheControl,
        });

        // Ownership of the eagerly-fetched first part transfers to the generator the
        // moment it takes the part's reader (or yields its bytes). Until then, a
        // consumer cancel would strand firstStream: gen.return() only runs the
        // reader's finally if control already entered the try. Track the handoff so
        // the outer cancel can release it in the pre-handoff window (suspendedStart,
        // or suspended at the part-header yield).
        let firstPartOwned = false;
        const enc = UTF8_ENCODER;
        async function* multipartChunks(): AsyncGenerator<Uint8Array> {
            for (let i = 0; i < ranges.length; i++) {
                const range = ranges[i]!;
                yield enc.encode(buildMultipartPartHeader(boundary, range, totalSize, partContentType));
                const stream = i === 0 ? firstStream : await store.getObject(key, { range, signal, ifMatch, pin });
                // Lazy parts settle AFTER headers commit, so a mismatch can only be
                // surfaced as a stream error (a reset). That still beats splicing bytes
                // from a changed representation or under-running the committed length.
                // The span check alone would miss a SAME-SIZE overwrite (right byte count,
                // different bytes); comparing each part's validator against the first
                // catches that too, since any overwrite changes the fs weak ETag (mtime)
                // and the S3 strong ETag (content hash). Stores that return no GET
                // validator fall back to the span check.
                if (i > 0 && (!servedSpanMatches(stream, range) || !sameRepresentation(firstStream, stream))) {
                    cancelBody(stream.body);
                    throw new ObjectChangedError(key);
                }
                // Handoff point: cleanup is now guaranteed by the reader's finally below.
                // No await or yield sits between here and getReader(), so a cancel
                // cannot interleave. A byte body runs through the same counted path.
                if (i === 0) firstPartOwned = true;
                const partSpan = range.end - range.start + 1;
                const reader = (
                    stream.body instanceof Uint8Array ? new Response(stream.body).body! : stream.body
                ).getReader();
                let partBytes = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        // A chunk that crosses the span is withheld, not framed and
                        // then complained about: bytes past the range (the tail of a
                        // representation that changed under the read) would otherwise
                        // be on the wire inside a well-formed part before the error.
                        if (done || (partBytes += value.byteLength) > partSpan) break;
                        yield value;
                    }
                } finally {
                    // Release the backend resource on normal completion AND on an early
                    // generator return (client cancelled mid-part).
                    reader.cancel().catch(() => {
                        /* already-settled reader */
                    });
                }
                // A short (or long) part means the source diverged from the span the
                // committed Content-Length was computed from. Erroring the stream (a
                // reset the client sees as a failed transfer) beats emitting
                // well-formed framing around a torn part: adapters with internal
                // length guards catch this earlier; this is the store-agnostic
                // backstop at the framing layer.
                if (partBytes !== partSpan) {
                    throw new Error(`multipart part ${range.start}-${range.end} changed mid-read`);
                }
                yield enc.encode("\r\n");
            }
            yield enc.encode(multipartEpilogue(boundary));
        }

        const gen = multipartChunks();
        const rawBody = new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller) {
                try {
                    const { done, value } = await gen.next();
                    if (done) controller.close();
                    // Part headers (encoder output) and part bodies are ArrayBuffer-backed;
                    // narrow so the multipart body stays Response-assignable under the DOM
                    // lib, where BodyInit requires an ArrayBuffer-backed view.
                    else controller.enqueue(value as Uint8Array<ArrayBuffer>);
                } catch (err) {
                    controller.error(err);
                }
            },
            async cancel(reason) {
                await gen.return?.(reason as undefined);
                // Cancelled before the generator took ownership of the eagerly-fetched
                // first part (suspendedStart, or suspended at the part-header yield):
                // gen.return ran no finally, so release it here. A byte-body first part
                // is a no-op in cancelBody; a stream part's file handle/socket is freed.
                if (!firstPartOwned) cancelBody(firstStream.body);
            },
        });

        const headers = applyAdapterHeaders(multipart.headers, ctx);

        // Server-Timing mirrors streamFromStore: the store figure covers the HEAD
        // plus the eagerly-fetched first part (lazy parts settle after headers
        // commit and cannot be measured into a header that has already left).
        if (timingCtx) headers["Server-Timing"] = reportTiming(timingCtx, getMs);

        // Audit reports the multipart body's granted length (framing + all parts).
        auditCtx?.onServe({
            key,
            method: "GET",
            status: 206,
            mime: auditCtx.mime,
            bytesServed: multipart.contentLength,
            etag,
        });

        // The generator holds each part to its span; the committed total rides
        // here too so the runtime receives a fixed-length body (and a framing
        // miscount errors the stream instead of under-running Content-Length).
        const body = boundBody(rawBody, {
            expected: multipart.contentLength,
            signal,
            onFailure: (err) => onError?.(err, { key, operation: "get" }),
            report:
                onTransfer &&
                ((bytesTransferred, completed) =>
                    onTransfer({
                        key,
                        method: "GET",
                        status: 206,
                        bytesExpected: multipart.contentLength,
                        bytesTransferred,
                        completed,
                    })),
        });

        return respond(206, headers, body);
    } catch (err) {
        cancelBody(firstStream.body);
        throw err;
    }
}

/** What {@link boundBody} holds a body to, and whom it tells. */
interface BoundBodyOpts {
    /**
     * The byte count the committed Content-Length promised. When set, a source
     * that closes short of it or produces bytes past it errors the stream.
     */
    expected?: number;
    /** Transfer-completion report; see {@link boundBody}. */
    report?: (bytesTransferred: number, completed: boolean) => void;
    /**
     * The request's abort signal: a source failure while it is aborted is the
     * client leaving, not a store failure, and is not reported.
     */
    signal?: AbortSignal;
    /**
     * The one terminal reporter for a failed body: the source erroring after
     * the headers committed (a lazy multipart part included) and a length
     * mismatch, each before the stream is errored.
     */
    onFailure?: (err: unknown) => void;
}

/**
 * Wrap a response body in a counting stream that holds it to the committed
 * byte count and reports the true bytes transferred exactly once when the
 * body reaches its terminal state.
 *
 * `report(bytesTransferred, completed)` fires on:
 *   - full drain (`completed: true`) -- the consumer read every byte,
 *   - cancel / client disconnect (`completed: false`) -- fewer bytes reached
 *     the client than the Content-Length promised,
 *   - source error (`completed: false`) -- a mid-transfer backend failure,
 *   - length mismatch (`completed: false`) -- the source closed short of
 *     `expected`, or produced bytes past it. The stream is errored (a reset
 *     the client sees as a failed transfer), because the alternative is a
 *     truncated body under a 200/206 that reads as complete; adapters with
 *     internal length guards catch this earlier, this is the store-agnostic
 *     backstop.
 *
 * A byte body is wrapped into a one-shot stream so metering is uniform across
 * stream and byte stores (the caller only pays this when a transfer hook is
 * registered; unmetered byte bodies keep the static-body fast path). The
 * `settled` latch guarantees the report fires once even if the consumer
 * cancels after the stream already closed.
 */
function boundBody(
    source: ObjectBody,
    { expected, report, signal, onFailure }: BoundBodyOpts,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    let transferred = 0;
    let settled = false;
    // Set when the consumer cancels: a source that ends short after that is the
    // consumer leaving, never a store failure.
    let cancelled = false;
    const settle = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        report?.(transferred, completed);
    };
    const lengthMismatch = (what: string): Error => {
        const err = new Error(`body: stream ${what} (${transferred} bytes delivered, ${expected} committed)`);
        if (!cancelled && !clientAborted(signal)) onFailure?.(err);
        settle(false);
        return err;
    };

    // Normalize a byte body to a one-shot stream and meter it through the SAME
    // reader path, so `completed:true` fires only when the consumer has pulled
    // the terminal (done) result -- i.e. after it read the last chunk -- never
    // merely because the chunk was buffered ahead of a read. A dedicated
    // byte-path that settled inside its enqueue would over-report a disconnect
    // that lands after the chunk was queued but before it was consumed.
    const reader = (source instanceof Uint8Array ? new Response(source).body! : source).getReader();
    const bounded = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
            let res: Awaited<ReturnType<typeof reader.read>>;
            try {
                res = await reader.read();
            } catch (err) {
                settle(false);
                if (cancelled) return;
                if (!clientAborted(signal)) onFailure?.(err);
                controller.error(err);
                return;
            }
            // The read was pending when the consumer cancelled: the stream is closed,
            // so there is nothing to enqueue or to report.
            if (cancelled) return;
            if (res.done) {
                if (expected !== undefined && transferred !== expected) {
                    controller.error(lengthMismatch("closed short of the committed length"));
                    return;
                }
                settle(true);
                controller.close();
            } else {
                transferred += res.value.byteLength;
                if (expected !== undefined && transferred > expected) {
                    // The overrunning chunk is withheld: past this point no byte the
                    // source produces belongs to the committed representation.
                    controller.error(lengthMismatch("ran past the committed length"));
                    await reader.cancel().catch(() => {
                        /* already-settled reader */
                    });
                    return;
                }
                // Backend byte chunks are ArrayBuffer-backed; narrow so the metered
                // body stays `new Response(...)`-assignable under the DOM lib, where
                // BodyInit requires an ArrayBuffer-backed view.
                controller.enqueue(res.value as Uint8Array<ArrayBuffer>);
            }
        },
        async cancel(reason) {
            cancelled = true;
            settle(false);
            await reader.cancel(reason);
        },
    });
    return expected === undefined ? bounded : fixedLength(bounded, expected);
}

/**
 * Largest span one buffered read may cover for a multipart response. The
 * span is held in memory while its parts are framed, so the bound is a
 * per-request memory ceiling as much as a waste bound: 256 KiB holds any
 * sparse set of small parts (index probes, page fetches), where per-part
 * round trips dominate, and is a few stream chunks' worth per request.
 */
const SPAN_READ_BYTES = 262_144;

/**
 * The span covering every part, when one buffered read of it fits
 * {@link SPAN_READ_BYTES}; undefined otherwise.
 */
function coalescedSpan(ranges: ParsedRange[]): ParsedRange | undefined {
    const start = Math.min(...ranges.map((r) => r.start));
    const end = Math.max(...ranges.map((r) => r.end));
    return end - start < SPAN_READ_BYTES ? { start, end } : undefined;
}

/**
 * A reader that answers every part from ONE read of `span`: the first call
 * reads and buffers the span (with that call's pin), later calls slice it.
 * A span served with other bounds, or ending short of them, is an object that
 * changed under a non-pinning store: the read throws ObjectChangedError before
 * any header commits, so the caller re-validates once and no part is short.
 * A store that ignored the range and answered the whole representation is
 * passed through unbuffered, as it is on the per-part path, so the caller
 * answers it with a plain 200 (RFC 9110 Section 14.2).
 */
function spanReader(
    store: Pick<ObjectStore, "getObject" | "pinsReads">,
    span: ParsedRange,
): Pick<ObjectStore, "getObject" | "pinsReads"> {
    let read: Promise<ObjectStream> | undefined;
    return {
        pinsReads: store.pinsReads,
        async getObject(key, opts) {
            const whole = await (read ??= store.getObject(key, { ...opts, range: span }).then(async (r) => {
                if (r.range === undefined) return r;
                if (servedSpanMatches(r, span)) {
                    const body = new Uint8Array(await new Response(r.body).arrayBuffer());
                    if (body.byteLength === r.contentLength) return { ...r, body };
                }
                cancelBody(r.body);
                throw new ObjectChangedError(key);
            }));
            if (whole.range === undefined || !(whole.body instanceof Uint8Array)) return whole;
            const { start, end } = opts!.range!;
            // Every multipart part is a closed range.
            if (end === undefined) throw new TypeError("spanReader: a part range has an end");
            const body = whole.body.subarray(start - span.start, end - span.start + 1);
            return { ...whole, range: { start, end }, contentLength: body.byteLength, body };
        },
    };
}

/**
 * True when the first multipart part is exactly its span. A byte body's real
 * length is checkable here too (a stream body settles lazily).
 */
function firstPartMatches(
    stream: { range?: { start: number; end: number }; contentLength: number; body: ObjectStream["body"] },
    range: ParsedRange,
): boolean {
    return (
        servedSpanMatches(stream, range) &&
        (!(stream.body instanceof Uint8Array) || stream.body.byteLength === range.end - range.start + 1)
    );
}

/**
 * True when a store served EXACTLY the requested span: same inclusive bounds
 * and matching byte count. A mismatch means the object changed under a
 * non-pinning store (or the store's accounting is broken), so the committed
 * multipart framing and Content-Length no longer describe the bytes.
 */
function servedSpanMatches(
    stream: { range?: { start: number; end: number }; contentLength: number },
    range: ParsedRange,
): boolean {
    const served = stream.range;
    return (
        !!served &&
        served.start === range.start &&
        served.end === range.end &&
        stream.contentLength === range.end - range.start + 1
    );
}

/**
 * True when two parts of a multipart response came from the same
 * representation, judged by the strongest validator both expose. Any overwrite
 * changes the fs weak ETag (mtime) and the S3 strong ETag (content hash), so an
 * ETag disagreement means the object changed mid-stream. When a store returns
 * no GET ETag (or no Last-Modified) on one side, there is nothing to compare
 * and the caller's span check is the only guard -- so this returns `true` and
 * does not manufacture a mismatch from missing metadata.
 */
function sameRepresentation(
    a: { etag?: string; lastModified?: string },
    b: { etag?: string; lastModified?: string },
): boolean {
    if (a.etag && b.etag) return a.etag === b.etag;
    if (a.lastModified && b.lastModified) return a.lastModified === b.lastModified;
    return true;
}

/**
 * The validators a body read reports, derived exactly like the HEAD's so the
 * two compare: the strong backend ETag when present, weak from size + mtime
 * otherwise.
 */
function readValidators(
    ctx: ResponseContext,
    read: { etag?: string; totalSize?: number; lastModified?: string },
): { etag?: string; lastModified?: string } {
    return {
        etag: ctx.emitETag
            ? generateETag({ etag: read.etag, contentLength: read.totalSize, lastModified: read.lastModified })
            : undefined,
        lastModified: read.lastModified,
    };
}

/**
 * The one acceptance test for a body read that follows a validating HEAD, used
 * by the single-range, full and multipart paths alike. Pinning stores
 * guarantee the read is that representation natively (ifMatch/pin); on stores
 * that cannot pin (fs, an origin that ignores If-Match) the object may change
 * between the HEAD and the GET, so the read's own validators are compared to
 * the HEAD's. A disagreement cancels the body and throws ObjectChangedError,
 * which reuses the caller's one-shot re-validation: a stale If-Range then
 * correctly yields a full 200 of the new bytes instead of splicing them into
 * the client's cached copy. ETags are compared only at equal strength: a store
 * that hands a hash-derived (strong) ETag to HEAD but only size+mtime (weak) to
 * GET would otherwise always mismatch; those fall back to Last-Modified.
 *
 * Returns whether the read is verified to be the HEAD's representation: a
 * validator pair was compared and agreed, or the read was pinned to it (an
 * issued `pin`, or an `ifMatch` the store declares it enforces). A
 * caller emits HEAD values the read omits only for a verified read.
 */
function acceptRead(
    key: string,
    head: { etag?: string; lastModified?: string },
    got: { etag?: string; lastModified?: string },
    body: ReadableStream<Uint8Array> | Uint8Array,
    pins: { ifMatch?: string; pin?: string; pinsReads?: boolean },
): boolean {
    const etagsComparable = !!head.etag && !!got.etag && head.etag.startsWith("W/") === got.etag.startsWith("W/");
    if (
        !sameRepresentation(
            { etag: etagsComparable ? head.etag : undefined, lastModified: head.lastModified },
            { etag: etagsComparable ? got.etag : undefined, lastModified: got.lastModified },
        )
    ) {
        cancelBody(body);
        throw new ObjectChangedError(key);
    }
    const compared = etagsComparable || (!!head.lastModified && !!got.lastModified);
    // A sent `ifMatch` is proof of a pinned read only from a store that enforces it.
    return compared || pins.pin !== undefined || (pins.ifMatch !== undefined && pins.pinsReads === true);
}

/** Release a body that will never reach a response (stream forms only). */
function cancelBody(body: ReadableStream<Uint8Array> | Uint8Array): void {
    if (!(body instanceof ReadableStream)) return;
    try {
        // A locked stream (a reader was taken) throws SYNCHRONOUSLY here rather
        // than rejecting, so .catch alone would let it escape; an already-errored
        // stream rejects. Swallow both -- teardown is best-effort by definition.
        body.cancel().catch(() => {
            /* already-errored streams reject cancel */
        });
    } catch {
        /* locked: the reader owns teardown */
    }
}

/** Bodyless 499 parts, built per return (headers object is caller-owned). */
function clientClosed(): RawResponseParts {
    return respond(499, { "Content-Length": "0" });
}

// ─── Error Helpers ──────────────────────────────────────────────────────────

/**
 * Validate a store-reported served range against the representation size:
 * inclusive integer bounds, ordered, and inside the object. Anything else
 * means the store's byte accounting is broken.
 *
 * When `totalSize` is `undefined` the backend served an unknown-total partial
 * (`bytes a-b/*`): there is no EOF to bound-check against, so the ordered
 * bounds the authoritative backend reported are trusted as-is.
 */
function isServableRange(r: { start: number; end: number }, totalSize: number | undefined): boolean {
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end)) return false;
    if (r.start < 0 || r.start > r.end) return false;
    if (totalSize === undefined) return true;
    return Number.isSafeInteger(totalSize) && r.end < totalSize;
}

/**
 * Whether the client went away. Decided from the request signal alone: an
 * `AbortError` a store raises while the signal is live is the store's own
 * cancellation (a deadline, an SDK abort), a store failure, and is reported as
 * one. With no signal supplied the handler cannot know the client left.
 */
function clientAborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

/** Whether a value is a plain object (a literal or null-prototype record), not a promise, array or class instance. */
function isPlainObject(value: unknown): value is Record<string, string> {
    if (typeof value !== "object" || value === null) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Build a plain-text error response with a computed Content-Length.
 *
 * The body is encoded once and Content-Length comes from the encoded byte
 * count, so the header stays truthful even if a message ever gains
 * non-ASCII characters (String.length counts UTF-16 units, not bytes).
 */
function plainTextError(
    status: 404 | 500 | 502 | 503,
    body: string,
    extraHeaders?: Record<string, string>,
): RawResponseParts {
    const { bytes, headers } = plainTextErrorParts(body);
    return respond(status, { ...headers, ...extraHeaders }, bytes);
}

/**
 * A bodyless denial (405/412/416) carrying {@link DENY_HEADERS}, spread onto
 * the protocol headers the kernel produced for the status: a 416 advertises
 * `Accept-Ranges: bytes` (RFC 9110 Section 14.3) and must not linger in a
 * shared cache.
 */
function deny(status: 405 | 412 | 416, headers: Record<string, string>): RawResponseParts {
    return respond(status, { ...headers, ...DENY_HEADERS });
}

/**
 * Build an error response for store failures.
 *
 * Discriminates three cases: "object not found" (404), "backend transiently
 * unavailable" (503, retryable), and everything else (502, the upstream
 * returned something invalid). A 404 hint comes from a `status` of 404 or an
 * error named `ObjectNotFoundError`/`NotFound`; a 503 hint from a `status` of
 * 503 or an error named `StoreUnavailableError`, which additionally carries an
 * optional `retryAfterSeconds` echoed as `Retry-After`.
 */
function storeErrorResponse(err: unknown): RawResponseParts {
    if (isNotFoundStoreError(err)) {
        return plainTextError(404, "Not Found");
    }
    if (isUnavailableStoreError(err)) {
        const secs = retryAfterSeconds(err);
        return plainTextError(
            503,
            "Storage backend unavailable",
            secs !== undefined ? { "Retry-After": String(secs) } : undefined,
        );
    }
    return plainTextError(502, "Storage backend error");
}

/**
 * Check if a store error represents a missing object (404).
 */
function isNotFoundStoreError(err: unknown): boolean {
    const status = storeErrorField(err, "status");
    if (status !== undefined) return status === 404;
    return isObjectNotFoundError(err) || isErrorNamed(err, "NotFound");
}

/**
 * One field of a store error, or `undefined` when `err` is not an object or
 * the read throws. A store is third-party code and its error an arbitrary
 * value; a classifier that throws on one would answer 500 for a store failure
 * and skip the cleanup that follows the classification.
 */
function storeErrorField(err: unknown, field: string): unknown {
    return typeof err === "object" && err !== null ? readField(err, field) : undefined;
}

/**
 * Check if a store error signals a transient, retryable backend condition
 * (throttling/overload/timeout). Matched by `status` 503 or by name so a
 * third-party store can throw an equivalently-named error without importing
 * the kernel class.
 */
function isUnavailableStoreError(err: unknown): boolean {
    return storeErrorField(err, "status") === 503 || isStoreUnavailableError(err);
}

/**
 * Extract a non-negative integer `Retry-After` (delay-seconds, RFC 9110
 * Section 10.2.3) from a store error's `retryAfterSeconds`, or `undefined`
 * when absent or malformed. Delegates to the shared parser: fractional hints
 * are floored, 0 is kept, and a huge finite hint that would serialize as
 * `1e+21` (a duck-typed third-party error that skipped the StoreUnavailableError
 * constructor's normalization) is rejected rather than emitted as a malformed
 * header.
 */
function retryAfterSeconds(err: unknown): number | undefined {
    return parseRetryAfterSeconds(storeErrorField(err, "retryAfterSeconds"));
}

/**
 * Check if a media type essence is textual and should have charset=utf-8 enforced.
 */
function isTextualMime(mime: string): boolean {
    if (mime.startsWith("text/")) return true;
    if (mime === "application/json" || mime === "application/xml") return true;
    if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;
    if (mime === "application/javascript" || mime === "application/ecmascript") return true;
    // HLS playlists are line-oriented UTF-8 text carrying sibling segment URIs
    // (RFC 8216 Section 4). Without a declared charset they are exactly the
    // encoding-sniffing surface this enforcement exists to close.
    if (mime === "application/vnd.apple.mpegurl") return true;
    return false;
}
