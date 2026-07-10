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
 *   return handler(req, { key: new URL(req.url).pathname.slice(1) });
 * }
 * export const HEAD = GET;
 * ```
 *
 * @packageDocumentation
 */

import {
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
  OPEN_ENDED,
  parseRetryAfterSeconds,
  negotiateEncoding,
  isCompressibleMime,
  type ObjectStore,
  type ObjectMetadata,
  type ParsedRange,
} from "./index.js";

// Re-export kernel types so consumers only need one import
export type {
  CancelSignal,
  ObjectStore,
  ObjectMetadata,
  ObjectStream,
  ParsedRange,
  ETagSource,
} from "./index.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * One reusable UTF-8 encoder for the module (multipart part headers, plain-text
 * error bodies), mirroring the kernel's hoisted encoder. `TextEncoder` is
 * stateless, so a single instance is safe to share and avoids a per-response
 * allocation.
 */
const UTF8_ENCODER = new TextEncoder();

/** Reason phrases for HTTP statuses used by this adapter. */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  206: "Partial Content",
  304: "Not Modified",
  412: "Precondition Failed",
  416: "Range Not Satisfiable",
  499: "Client Closed Request",
  502: "Bad Gateway",
};

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

/** A content coding servable from a precompressed sibling object. */
export type PrecompressedCoding = keyof typeof PRECOMPRESSED_SUFFIX;

/** Default server preference: best ratio first (RFC 9110 lets ties go to us). */
const DEFAULT_PRECOMPRESSED: readonly PrecompressedCoding[] = ["br", "zstd", "gzip"];

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
  /** Storage key (path within the bucket). */
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
}

export interface ServeObjectOptions {
  /**
   * Content-Disposition strategy.
   * - `"inline"` -- render in the browser (PDF, images, video)
   * - `"attachment"` -- force download
   * - A function mapping MIME to disposition type (for per-type policy)
   *
   * @default "attachment"
   */
  disposition?: "inline" | "attachment" | ((mime: string) => "inline" | "attachment");

  /**
   * Cache-Control value for 200/206 responses.
   * @default "private, no-cache"
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
   * When true, emits a `Server-Timing` header with storage and evaluation
   * latency metrics. Also calls `onTiming` if provided.
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
   * Called with structured timing data for every request. Use to ship
   * metrics to your RUM/APM backend.
   */
  onTiming?: (metrics: { storeMs: number; evaluateMs: number; totalMs: number }) => void;

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
   * @param error - The original error from the storage backend
   * @param context - Additional context about the failed operation
   * (`audit` = the consumer's own onServe/onTransfer hook threw; the
   * response was still served, the hook failure is surfaced here instead
   * of crashing. `context` = a consumer-supplied key/mime/filename
   * extractor threw in a server adapter; the request became a 500).
   */
  onError?: (error: unknown, context: { key: string; operation: "head" | "get" | "audit" | "context" }) => void;

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
  onServe?: (event: ServeAuditEvent) => void;

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
  onTransfer?: (event: TransferEvent) => void;

  /**
   * Maximum number of distinct (coalesced) byte ranges to serve as
   * multipart/byteranges before a multi-range request degrades to a full 200.
   *
   * A range-amplification defense: a client sending thousands of tiny or
   * overlapping ranges would otherwise force a large multipart response.
   * Overlapping/adjacent ranges are coalesced first, and if the result still
   * exceeds this cap (or already covers the whole object) the full 200 is
   * served instead. Matches the intent of nginx `max_ranges` and Go's
   * sum-of-ranges check.
   *
   * @default 50
   */
  maxRanges?: number;

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
   * Scope and cost:
   * - Selection only, never on-the-fly compression (transforming at serve
   *   time breaks byte-exact ranges and digests). You upload the variants.
   * - One extra `headObject` probe per acceptable coding until a hit; probes
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
   * @example
   * ```ts
   * preferSignedUrl: ({ isRange, isConditional }) => !isRange && !isConditional
   * ```
   */
  preferSignedUrl?: (info: {
    key: string;
    mime: string;
    method: "GET" | "HEAD";
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
   * @default 60
   */
  signedUrlExpiresSeconds?: number;
}

/** Structured audit event for compliance logging. */
export interface ServeAuditEvent {
  /** Storage key that was served. */
  key: string;
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

/** Structured transfer-completion event ({@link ServeObjectOptions.onTransfer}). */
export interface TransferEvent {
  /** Storage key that was served. */
  key: string;
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
 * Serve an object from an {@link ObjectStore} with full RFC 7232/7233 support.
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
export interface RawResponseParts {
  status: number;
  /** Reason phrase (e.g. "Partial Content", "Client Closed Request"). */
  statusText: string;
  headers: Record<string, string>;
  /**
   * `null` for bodyless statuses (HEAD, 304, 412, 416, 302, 405).
   * `<ArrayBuffer>`-backed so `new Response(parts.body)` compiles under DOM lib.
   */
  body: ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer> | null;
}

export function serveObject(
  store: ObjectStore,
  opts: ServeObjectOptions = {},
) {
  const raw = serveObjectRaw(store, opts);
  return async function handleServe(
    req: ServableRequest,
    ctx: ServeContext,
  ): Promise<Response> {
    const parts = await raw(req, ctx);
    // BodyInit accepts both body forms; byte bodies take the runtime's
    // static-body fast path (no stream machinery).
    return new Response(parts.body, {
      status: parts.status,
      statusText: parts.statusText,
      headers: parts.headers,
    });
  };
}

/**
 * The engine behind serveObject, exposed for server adapters: identical
 * protocol behavior, but the result is RawResponseParts instead of a
 * Response. Use this when your server writes status/headers/body natively
 * (the bundled node adapter does) -- constructing a Response + Headers pair
 * per request just to immediately deconstruct them is measurable overhead
 * on hot paths.
 */
export function serveObjectRaw(
  store: ObjectStore,
  opts: ServeObjectOptions = {},
) {
  const {
    disposition: dispositionOpt = "attachment",
    cacheControl: rawCacheControl = "private, no-cache",
    immutable: immutableOpt = false,
    etag: etagEnabled = true,
    securityHeaders,
    crossOriginResourcePolicy,
    timingAllowOrigin,
    timing: timingEnabled = false,
    onTiming,
    fallbackFilename = "download",
    onError,
    onServe: rawOnServe,
    onTransfer: rawOnTransfer,
    maxRanges = MAX_RANGES_DEFAULT,
    enforceCharset = true,
    precompressed = false,
    preferSignedUrl,
    signedUrlExpiresSeconds = 60,
  } = opts;

  // Resolve and validate the precompressed coding list ONCE. An unknown
  // coding is a configuration bug: fail at setup, not per-request.
  const precompressedCodings: readonly PrecompressedCoding[] | null =
    precompressed === true ? DEFAULT_PRECOMPRESSED
    : precompressed === false ? null
    : resolvePrecompressedList(precompressed);

  // A consumer's audit hook must never break the never-throw contract: the
  // bodyless emissions (302/304/412/416/HEAD) fire outside any guard, so a
  // throwing hook would escape the handler. Route hook failures to onError;
  // the response itself is unaffected.
  const onServe = rawOnServe
    ? (event: ServeAuditEvent): void => {
        try {
          rawOnServe(event);
        } catch (err) {
          onError?.(err, { key: event.key, operation: "audit" });
        }
      }
    : undefined;

  // Same guard for the transfer hook, which fires from inside the body's
  // stream machinery (during the runtime's consumption, after the handler has
  // returned). A throw there would error the response stream mid-flight;
  // route it to onError instead so the transfer completes cleanly.
  const onTransfer = rawOnTransfer
    ? (event: TransferEvent): void => {
        try {
          rawOnTransfer(event);
        } catch (err) {
          onError?.(err, { key: event.key, operation: "audit" });
        }
      }
    : undefined;

  // Resolve Cache-Control once (append immutable if configured)
  const cacheControl = immutableOpt && !rawCacheControl.includes("immutable")
    ? `${rawCacheControl}, immutable`
    : rawCacheControl;

  return async function handleServeRaw(
    req: ServableRequest,
    ctx: ServeContext,
  ): Promise<RawResponseParts> {
    // Method validation: only GET and HEAD are valid for file serving.
    // OPTIONS gets its standard method-discovery answer (204 + Allow, no
    // Content-Length per RFC 9110 Section 8.6); everything else gets 405
    // with Allow per RFC 9110 Section 15.5.6.
    const method = req.method;
    if (method === "OPTIONS") {
      return {
        status: 204,
        statusText: "No Content",
        headers: {
          Allow: "GET, HEAD, OPTIONS",
          "Cache-Control": "no-store",
        },
        body: null,
      };
    }
    if (method !== "GET" && method !== "HEAD") {
      return {
        status: 405,
        statusText: "Method Not Allowed",
        headers: {
          Allow: "GET, HEAD, OPTIONS",
          "Content-Length": "0",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        },
        body: null,
      };
    }

    const { key } = ctx;
    const isHead = method === "HEAD";
    const mime = ctx.mime ?? "application/octet-stream";

    // Resolve Content-Disposition
    const dispositionType = typeof dispositionOpt === "function"
      ? dispositionOpt(mime)
      : dispositionOpt;
    // Coerce on BOTH paths. A JS caller's disposition extractor can return an
    // arbitrary computed string; with a filename, buildContentDisposition
    // coerces it, but without one the value would previously reach the header
    // verbatim. Anything but "inline" is "attachment", the safe default.
    const safeDisposition = dispositionType === "inline" ? "inline" : "attachment";
    const disposition = ctx.filename
      ? buildContentDisposition(ctx.filename, { type: safeDisposition, fallback: fallbackFilename })
      : safeDisposition;

    // Active content rendered inline (SVG, HTML, XSLT-capable XML) executes
    // in the serving origin when a user opens it as a top-level document --
    // `nosniff` does not stop a genuine `image/svg+xml` from running its
    // embedded scripts. Default a sandbox CSP onto exactly that combination;
    // a caller's securityHeaders can override it (spread order below).
    // Attachment responses and passive types (images, video, PDF) are
    // unaffected.
    const activeInlineCsp = safeDisposition === "inline" && isActiveContentMime(mime)
      ? { "Content-Security-Policy": "sandbox" }
      : undefined;

    // Extra caller headers for success responses (200/206/304)
    const extraHeaders = activeInlineCsp
      ? { ...activeInlineCsp, ...(securityHeaders ? securityHeaders(mime) : {}) }
      : securityHeaders ? securityHeaders(mime) : {};

    const effectiveCacheControl = ctx.cacheControl ?? cacheControl;

    // ── Range-incapable stores: signed-URL redirect when available ───────
    if (store.supportsRange === false && store.createSignedUrl) {
      return signedUrlRedirect({
        store, key, filename: ctx.filename,
        expiresInSeconds: signedUrlExpiresSeconds,
        cacheControl: effectiveCacheControl,
        isHead, mime, onServe, onError,
      });
    }
    // supportsRange === false with no signed-URL path: serve the FULL
    // representation through the origin instead of failing. Range and
    // If-Range read as absent below (RFC 9110 Section 14.2 lets a server
    // ignore Range), and every success response advertises
    // `Accept-Ranges: none` (rctx.acceptRanges) so clients stop asking.
    // Conditionals (304/412) still evaluate: they need no byte seeking.

    // ── Detect request characteristics ──────────────────────────────────
    const headers = store.supportsRange === false
      ? withoutRangeHeaders(req.headers)
      : req.headers;
    const hasConditional = Boolean(
      headers.get("if-none-match") || headers.get("if-modified-since")
      || headers.get("if-match") || headers.get("if-unmodified-since"),
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

    // ── Per-request egress offload (preferSignedUrl) ─────────────────────
    if (
      preferSignedUrl && store.createSignedUrl
      && preferSignedUrl({
        key, mime,
        method: isHead ? "HEAD" : "GET",
        isRange: Boolean(rangeHeader),
        isConditional: hasConditional || hasIfRange,
      })
    ) {
      return signedUrlRedirect({
        store, key, filename: ctx.filename,
        expiresInSeconds: signedUrlExpiresSeconds,
        cacheControl: effectiveCacheControl,
        isHead, mime, onServe, onError,
      });
    }

    // ── Precompressed variant negotiation (RFC 9110 Section 12.5.3) ──────
    // The negotiated sibling (`<key>.br`) is a DISTINCT representation: from
    // here down, its key, size, validators, and digest drive the entire
    // pipeline, so conditionals, If-Range, byte ranges, pinning, and the
    // drift guard are all evaluated against the encoded bytes. Multi-range
    // requests are excluded (multipart framing of an encoded representation
    // has no interoperable definition) and serve the identity object.
    let effectiveKey = key;
    let contentEncoding: string | undefined;
    let variantMeta: ObjectMetadata | undefined;
    const negotiating = precompressedCodings !== null && isCompressibleMime(mime);
    if (negotiating && !isMultiRange) {
      const candidates = negotiateEncoding(headers.get("accept-encoding"), precompressedCodings);
      for (const coding of candidates) {
        const variantKey = key + PRECOMPRESSED_SUFFIX[coding as PrecompressedCoding];
        try {
          variantMeta = await store.headObject(variantKey, { signal: req.signal });
          effectiveKey = variantKey;
          contentEncoding = coding;
          break;
        } catch (err) {
          if (isAbortError(err)) return clientClosed();
          if (isNotFoundStoreError(err)) continue; // no such variant: next coding
          // Any other probe failure (throttle, outage) must not fail the
          // request -- the identity representation is always servable.
          // Surface it for telemetry and stop probing: an unhealthy backend
          // does not need more speculative HEADs.
          onError?.(err, { key: variantKey, operation: "head" });
          break;
        }
      }
    }

    // Response-building context shared by all response paths
    const rctx: ResponseContext = {
      mime, disposition, extraHeaders,
      cacheControl: effectiveCacheControl,
      crossOriginResourcePolicy, timingAllowOrigin, enforceCharset,
      digestWanted: clientWantsDigest(req.headers),
      contentDigestWanted: clientWantsContentDigest(req.headers),
      emitETag: etagEnabled,
      isHead,
      // A range-incapable store is served rangeless: advertise it.
      acceptRanges: store.supportsRange === false ? "none" : "bytes",
      contentEncoding,
      // The response is encoding-negotiated whenever probing is CONFIGURED
      // for this type -- also when identity was chosen (the variant may
      // appear later) and on multi-range identity responses -- so shared
      // caches always key compressible objects on Accept-Encoding.
      varyAcceptEncoding: negotiating,
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
    if (rangeHeader && !hasConditional && !hasIfRange && !isHead && store.authoritativeRange && !variantMeta) {
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
            store, key, range: fastRange, ctx: rctx, signal: req.signal,
            onError: onError ? (err) => { speculativeErr = err; } : undefined,
            timingCtx: timingEnabled ? { storeMs: 0, evaluateMs: 0, onTiming } : undefined,
            auditCtx: onServe ? { onServe, mime } : undefined,
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
      if (attempt === 0 && variantMeta) {
        // The negotiation probe already fetched this representation's
        // metadata; a second HEAD would race it for no benefit. Retries
        // (attempt > 0) re-fetch: the variant changed under a pinned read.
        meta = variantMeta;
      } else {
        try {
          meta = await store.headObject(effectiveKey, { signal: req.signal });
        } catch (err) {
          if (isAbortError(err)) return clientClosed();
          onError?.(err, { key: effectiveKey, operation: "head" });
          return storeErrorResponse(err);
        }
      }
      const storeMs = timingEnabled ? performance.now() - t0 : 0;
      const etag = etagEnabled ? deriveETag(meta) : undefined;

      // RFC 7232/7233 full evaluation chain. Conditionals apply to HEAD
      // exactly as to GET (RFC 9110 Section 13.1) -- a conditional HEAD must
      // still yield 304/412. Range, however, is only defined for GET
      // (RFC 9110 Section 14.2): the kernel ignores it (and If-Range, and
      // suppresses Content-Digest) when told the method is HEAD.
      const t1 = timingEnabled ? performance.now() : 0;
      let evaluation: ReturnType<typeof evaluateConditionalRequest>;
      try {
        evaluation = evaluateConditionalRequest(headers, {
          totalSize: meta.contentLength,
          contentType: mime,
          etag,
          lastModified: meta.lastModified,
          cacheControl: rctx.cacheControl,
          digest: meta.digest,
        }, { method: isHead ? "HEAD" : "GET" });
      } catch (err) {
        // The kernel rejects corrupt store metadata (NaN/negative sizes)
        // with a RangeError. That is an adapter bug, but a handler must
        // always produce a Response -- an escaping throw becomes an
        // unhandled rejection (and a process crash under Express 4).
        onError?.(err, { key, operation: "head" });
        return storeErrorResponse(err);
      }
      const evaluateMs = timingEnabled ? performance.now() - t1 : 0;

      // Early exits: 412, 304, 416
      if (evaluation.status === 304) {
        onServe?.({ key: effectiveKey, method: isHead ? "HEAD" : "GET", status: 304, mime, bytesServed: 0, etag });
        // Caller extraHeaders ride the 304: RFC 9110 Section 15.4.5
        // requires any Vary (and Cache-Control/Expires) that the 200
        // would have carried to be generated on the 304 too, and
        // securityHeaders is the mechanism that adds Vary to the 200.
        // Negotiated responses add their own Vary member the same way.
        const headers304: Record<string, string> = { ...evaluation.headers, ...rctx.extraHeaders };
        if (rctx.varyAcceptEncoding) headers304["Vary"] = appendVaryAcceptEncoding(headers304["Vary"]);
        return {
          status: 304,
          statusText: STATUS_TEXT[304],
          headers: headers304,
          body: null,
        };
      }
      if (evaluation.status === 412) {
        // Denials are audit events too: a 412 is an optimistic-concurrency
        // conflict (failed If-Match), exactly what SOC 2 change-control
        // trails want captured alongside grants.
        onServe?.({ key: effectiveKey, method: isHead ? "HEAD" : "GET", status: 412, mime, bytesServed: 0, etag });
        return {
          status: 412,
          statusText: STATUS_TEXT[412],
          headers: {
            ...evaluation.headers,
            ...DENY_HEADERS,
          },
          body: null,
        };
      }

      if (evaluation.status === 416) {
        onServe?.({ key: effectiveKey, method: "GET", status: 416, mime, bytesServed: 0, etag });
        return {
          status: evaluation.status,
          statusText: "Range Not Satisfiable",
          headers: {
            ...evaluation.headers,
            ...DENY_HEADERS,
          },
          body: null,
        };
      }

      // HEAD method: preconditions passed -- return headers only, no body
      // (PDF.js size probing, cache priming).
      if (isHead) {
        onServe?.({ key: effectiveKey, method: "HEAD", status: 200, mime, bytesServed: 0, etag });
        return buildHeadResponse(meta, etag, rctx);
      }

      // Stream bytes from store, pinned to the representation just validated.
      // Only STRONG validators pin: RFC 9110 Section 13.1.1 mandates strong
      // comparison for If-Match, so a weak `W/` ETag would fail the
      // precondition on every attempt (guaranteed 412 -> retry -> 502).
      // Weak validators cannot assert byte equality anyway; the response-side
      // guard still protects those reads.
      const pinEtag = meta.etag && !meta.etag.startsWith("W/") ? meta.etag : undefined;

      // ── Multi-range: serve multipart/byteranges ──────────────────────────
      // evaluateConditionalRequest already settled 412/304 above (conditionals
      // are range-independent) and, because parseRangeHeader rejects comma
      // ranges, left this as a would-be 200. Honor the ranges here. A stale
      // If-Range (validator moved) means ignore the Range -> fall through to
      // the full 200 below; parseRanges returning null (amplification, or the
      // ranges cover the whole file) does the same.
      if (isMultiRange && isRangeFresh(headers, etag, meta.lastModified)) {
        const set = parseRanges(rangeHeader, meta.contentLength, maxRanges);
        if (set === "unsatisfiable") {
          onServe?.({ key: effectiveKey, method: "GET", status: 416, mime, bytesServed: 0, etag });
          return {
            status: 416,
            statusText: "Range Not Satisfiable",
            headers: {
              ...build416Headers(meta.contentLength).headers,
              ...DENY_HEADERS,
            },
            body: null,
          };
        }
        if (set !== null) {
          try {
            if (set.ranges.length === 1) {
              // Overlapping ranges coalesced to one: a normal single 206.
              return await streamFromStore({
                store, key: effectiveKey, range: set.ranges[0],
                ifMatch: pinEtag, pin: meta.pin,
                headEtag: etag, headLastModified: meta.lastModified,
                reprDigest: meta.digest, ctx: rctx, signal: req.signal, onError,
                timingCtx: timingEnabled ? { storeMs, evaluateMs, onTiming } : undefined,
                auditCtx: onServe ? { onServe, mime } : undefined,
                onTransfer,
              });
            }
            return await serveMultipart({
              store, key: effectiveKey, ranges: set.ranges, totalSize: meta.contentLength,
              mime, etag, lastModified: meta.lastModified,
              // Same RFC 9530 Section 4 negotiation as every other path: a
              // client that declined sha-256 gets no digest on multipart.
              digest: rctx.digestWanted ? meta.digest : undefined,
              ifMatch: pinEtag, pin: meta.pin, ctx: rctx, signal: req.signal,
              timingCtx: timingEnabled ? { storeMs, evaluateMs, onTiming } : undefined,
              onError, auditCtx: onServe ? { onServe, mime } : undefined, onTransfer,
            });
          } catch (err) {
            // A pinned first-part read lost its race: re-validate once, exactly
            // like single-range serving.
            if (isObjectChangedError(err) && attempt === 0) continue;
            onError?.(err, { key: effectiveKey, operation: "get" });
            return storeErrorResponse(err);
          }
        }
        // set === null: serve the full 200 (fall through).
      }

      try {
        return await streamFromStore({
          store, key: effectiveKey, range: evaluation.range ?? undefined,
          ifMatch: pinEtag, pin: meta.pin,
          headEtag: etag, headLastModified: meta.lastModified,
          reprDigest: meta.digest, ctx: rctx, signal: req.signal, onError,
          timingCtx: timingEnabled ? { storeMs, evaluateMs, onTiming } : undefined,
          auditCtx: onServe ? { onServe, mime } : undefined,
          onTransfer,
        });
      } catch (err) {
        // Re-validate ONCE, and only for a pinned-read race. Any other error
        // that escapes streamFromStore -- e.g. a corrupt-metadata RangeError
        // rethrown from buildHeaders -- is deterministic, so a retry just wastes
        // a HEAD+GET and drops the first failure from onError. Report it now.
        // Mirrors the multipart catch above.
        if (isObjectChangedError(err) && attempt === 0) continue;
        onError?.(err, { key: effectiveKey, operation: "get" });
        return storeErrorResponse(err);
      }
    }

    // ── Path C: No Range, no conditional headers ─────────────────────────
    // Same never-throw contract as Path A: corrupt GET metadata (header
    // builder RangeError), a throwing onServe hook, or a store throwing
    // ObjectChangedError without a pin must become a 502, not a rejected
    // handler (which crashes Express 4 processes).
    try {
      return await streamFromStore({
        store, key: effectiveKey, ctx: rctx, signal: req.signal, onError,
        timingCtx: timingEnabled ? { storeMs: 0, evaluateMs: 0, onTiming } : undefined,
        auditCtx: onServe ? { onServe, mime } : undefined,
        onTransfer,
      });
    } catch (err) {
      onError?.(err, { key: effectiveKey, operation: "get" });
      return storeErrorResponse(err);
    }
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Wrap a headers view so Range and If-Range read as absent.
 *
 * Used for range-incapable stores (`supportsRange: false` without a
 * signed-URL path): RFC 9110 Section 14.2 lets a server ignore Range, so
 * the whole pipeline serves the full representation while conditionals
 * still apply. (HEAD needs no masking -- the kernel is method-aware.)
 */
function withoutRangeHeaders(
  headers: { get(name: string): string | null },
): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      const lower = name.toLowerCase();
      if (lower === "range" || lower === "if-range") return null;
      return headers.get(lower);
    },
  };
}

/** Validate a caller-supplied precompressed coding list at setup time. */
function resolvePrecompressedList(
  codings: readonly PrecompressedCoding[],
): readonly PrecompressedCoding[] | null {
  if (codings.length === 0) return null;
  for (const coding of codings) {
    if (!(coding in PRECOMPRESSED_SUFFIX)) {
      throw new TypeError(
        `serveObject: unknown precompressed coding "${coding}" (supported: ${Object.keys(PRECOMPRESSED_SUFFIX).join(", ")})`,
      );
    }
  }
  return codings;
}

/**
 * Active content types that can execute script or make outbound requests
 * when rendered inline as a top-level document from the serving origin.
 * XML is included for its XSLT processing instruction, which several
 * browsers still execute.
 */
const ACTIVE_CONTENT_MIMES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
]);

/** True when a MIME's essence is active content ({@link ACTIVE_CONTENT_MIMES}). */
function isActiveContentMime(mime: string): boolean {
  const semi = mime.indexOf(";");
  const essence = (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
  return ACTIVE_CONTENT_MIMES.has(essence);
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

/** Arguments for {@link signedUrlRedirect}. */
interface SignedUrlRedirectArgs {
  store: ObjectStore;
  key: string;
  filename?: string;
  expiresInSeconds: number;
  cacheControl: string;
  isHead: boolean;
  mime: string;
  onServe?: (event: ServeAuditEvent) => void;
  onError?: ServeObjectOptions["onError"];
}

/**
 * Mint a signed URL and answer a 302, sharing one implementation between the
 * range-incapable degradation path and the `preferSignedUrl` offload hook.
 *
 * The `cacheControl` handed to the provider rides the SIGNED response (S3
 * `response-cache-control`): without it, a private document served off the
 * bucket origin inherits whatever Cache-Control was baked into the object at
 * upload -- the classic footgun being a public/immutable value that a CDN
 * then caches for a year.
 */
async function signedUrlRedirect(args: SignedUrlRedirectArgs): Promise<RawResponseParts> {
  const { store, key, filename, expiresInSeconds, cacheControl, isHead, mime, onServe, onError } = args;
  let result: Awaited<ReturnType<NonNullable<ObjectStore["createSignedUrl"]>>>;
  try {
    result = await store.createSignedUrl!(key, {
      expiresInSeconds,
      downloadFilename: filename,
      cacheControl,
    });
  } catch (err) {
    // Never-throw contract: a rejecting signed-URL provider becomes a
    // reported 502, never an escaped rejection (which crashes Express 4).
    onError?.(err, { key, operation: "get" });
    return plainTextError(502, "Bad Gateway", "Storage backend error");
  }
  if ("url" in result) {
    // A signed-URL redirect grants file access: audit it like a serve.
    onServe?.({ key, method: isHead ? "HEAD" : "GET", status: 302, mime, bytesServed: 0 });
    return {
      status: 302,
      statusText: "Found",
      headers: {
        // The signed URL is backend-derived: sanitize it like every
        // other metadata-sourced header so a malformed provider
        // response cannot inject a header or crash the writer.
        Location: sanitizeHeaderValue(result.url),
        "Cache-Control": "no-store, no-cache",
        "Accept-Ranges": "none",
        "Content-Length": "0",
      },
      body: null,
    };
  }
  // The provider declined ({ ok: false }): surface the reason to the
  // consumer's telemetry (it never reaches the client) and answer an
  // honest 502.
  onError?.(
    new Error(`createSignedUrl declined for ${key}: ${result.error}`),
    { key, operation: "get" },
  );
  return plainTextError(502, "Bad Gateway", "Storage backend error");
}

/**
 * Parse a Range header for the single-round-trip fast path (no totalSize
 * available yet). Accepts only `bytes=a-b` and `bytes=a-` (open end becomes
 * MAX_SAFE_INTEGER; RFC 9110 Section 14.1.2 lets the server clamp a
 * last-byte-pos past EOF, and authoritative-range backends do). Everything
 * else -- suffix ranges, multi-range, malformed specs -- returns null so the
 * validating HEAD path evaluates it with the real object size.
 */
function parseFastRange(header: string): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return null;
  const end = m[2] ? Number(m[2]) : OPEN_ENDED;
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

/** Derive an ETag from storage metadata using the kernel's formatter. */
function deriveETag(meta: ObjectMetadata): string | undefined {
  return generateETag({
    hash: meta.etag,
    size: meta.contentLength,
    mtime: meta.lastModified,
  });
}

/** Shared response-building context resolved once per request. */
interface ResponseContext {
  readonly mime: string;
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
}

/** Protocol metadata for building response headers. */
interface ProtocolMeta {
  /** Full size, or `undefined` for an unknown-total partial (`bytes a-b/*`). */
  totalSize: number | undefined;
  range?: ParsedRange;
  etag?: string;
  lastModified?: string;
  digest?: string;
  serverTiming?: string;
}

/**
 * Locked-down headers for bodyless denial responses (304 excepted, which
 * carries only validators). A `default-src 'none'` CSP plus `nosniff` so a
 * 412/416 body can never be sniffed or execute anything, and `no-store` so a
 * transient denial is never cached (a 416 in particular advertises
 * `Accept-Ranges: bytes` per RFC 7233 and must not linger in a shared cache).
 * Spread onto the protocol headers the kernel produced for the status.
 */
const DENY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
} as const;

/**
 * Append `; charset=utf-8` to a textual Content-Type when charset enforcement
 * is on and none is present. Shared by the single-range/200 path and each
 * multipart part so their Content-Type (and thus the precomputed
 * Content-Length) is derived identically.
 */
function withCharset(mime: string, ctx: ResponseContext): string {
  return ctx.enforceCharset && isTextualMime(mime) && !mime.includes("charset")
    ? `${mime}; charset=utf-8`
    : mime;
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
  // Merged LAST so a caller-supplied Vary (extraHeaders) is extended, never
  // clobbered, and vice versa.
  if (ctx.varyAcceptEncoding) headers["Vary"] = appendVaryAcceptEncoding(headers["Vary"]);
  return headers;
}

/**
 * Build response headers by composing the kernel's protocol headers with
 * adapter-specific extras.
 */
function buildHeaders(
  ctx: ResponseContext,
  meta: ProtocolMeta,
): Record<string, string> {
  const { headers: protocol } = buildRangeResponseHeaders({
    totalSize: meta.totalSize,
    range: meta.range ?? null,
    contentType: withCharset(ctx.mime, ctx),
    etag: meta.etag,
    lastModified: meta.lastModified,
    // RFC 9530 Section 4: respect Want-Repr-Digest negotiation. Weight 0 or
    // an algorithm list without sha-256 means "do not send"; honoring that
    // here keeps adapter responses consistent with the kernel orchestrator.
    digest: ctx.digestWanted ? meta.digest : undefined,
    // Content-Digest requires an actual full body: never on HEAD (empty
    // message content, RFC 9530 Appendix B.2), never when the client
    // declined it via Want-Content-Digest.
    contentDigest: !ctx.isHead && ctx.contentDigestWanted,
    cacheControl: ctx.cacheControl,
  });
  // Range-incapable stores advertise honestly instead of inviting 206s
  // the pipeline will never grant.
  if (ctx.acceptRanges === "none") protocol["Accept-Ranges"] = "none";
  // A negotiated precompressed variant IS the representation: its coding is
  // representation metadata, and the surrounding validators/digest/ranges
  // already describe the encoded bytes.
  if (ctx.contentEncoding) protocol["Content-Encoding"] = ctx.contentEncoding;

  const headers = applyAdapterHeaders(protocol, ctx);
  if (meta.serverTiming) headers["Server-Timing"] = meta.serverTiming;
  return headers;
}

/** Build a HEAD-only response (no body). */
function buildHeadResponse(meta: ObjectMetadata, etag: string | undefined, ctx: ResponseContext): RawResponseParts {
  return {
    status: 200,
    statusText: "OK",
    headers: buildHeaders(ctx, {
      totalSize: meta.contentLength,
      etag,
      lastModified: meta.lastModified,
      digest: meta.digest,
    }),
    body: null,
  };
}

/** Timing context passed to streamFromStore when timing is enabled. */
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
  range?: { start: number; end: number };
  /** Opaque adapter pin token from the HEAD metadata (GetObjectOptions.pin). */
  pin?: string;
  /**
   * Raw backend ETag to pin the read to (GetObjectOptions.ifMatch). When the
   * store supports it and the object changed, getObject throws
   * ObjectChangedError, which propagates to the caller for re-validation.
   */
  ifMatch?: string;
  headEtag?: string;
  headLastModified?: string;
  reprDigest?: string;
  ctx: ResponseContext;
  signal?: AbortSignal;
  onError?: (error: unknown, context: { key: string; operation: "head" | "get" }) => void;
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
 * Maps store failures to responses internally, with one exception:
 * ObjectChangedError (a pinned read losing its race) is rethrown so the
 * caller can re-validate against the object's new state.
 */
async function streamFromStore(opts: StreamOpts): Promise<RawResponseParts> {
  const {
    store, key, range, ifMatch, pin, headEtag, headLastModified, reprDigest,
    ctx, signal, onError, timingCtx, auditCtx, onTransfer,
  } = opts;

  const t0 = timingCtx ? performance.now() : 0;
  let result: Awaited<ReturnType<ObjectStore["getObject"]>>;
  try {
    result = await store.getObject(key, { range, signal, ifMatch, pin });
  } catch (err) {
    if (isObjectChangedError(err)) throw err;
    if (isAbortError(err)) return clientClosed();
    onError?.(err, { key, operation: "get" });
    return storeErrorResponse(err);
  }
  const getMs = timingCtx ? performance.now() - t0 : 0;

  let serverTiming: string | undefined;
  if (timingCtx) {
    const totalMs = (timingCtx.storeMs + timingCtx.evaluateMs + getMs);
    serverTiming = `store;dur=${(timingCtx.storeMs + getMs).toFixed(1)},eval;dur=${timingCtx.evaluateMs.toFixed(1)}`;
    timingCtx.onTiming?.({
      storeMs: timingCtx.storeMs + getMs,
      evaluateMs: timingCtx.evaluateMs,
      totalMs,
    });
  }

  // Derive the response ETag from the GET result itself: strong from the
  // backend hash when present, weak from size + mtime otherwise. This keeps
  // validators consistent between Path A (HEAD-derived) and Path C (GET-only),
  // so plain 200s from hash-less stores (fs) still carry a revalidator.
  const getEtag = ctx.emitETag
    ? generateETag({
        hash: result.etag,
        size: result.totalSize,
        mtime: result.lastModified,
      })
    : undefined;
  const finalEtag = ctx.emitETag ? getEtag ?? headEtag : undefined;
  const finalLastModified = result.lastModified ?? headLastModified;
  const finalDigest = result.digest ?? reprDigest;

  // TOCTOU guard: the range the backend ACTUALLY served is the source of
  // truth for 206 vs 200 AND for the emitted byte bounds. If a range was
  // requested but the GET result carries none, the store served full
  // content: emit 200, never a lying 206. Incoherent bounds (a custom-store
  // bug) cannot be trusted -- emitting them would corrupt client caches,
  // so fail loudly instead.
  const actualRange = range ? result.range ?? null : null;
  if (actualRange && !isServableRange(actualRange, result.totalSize)) {
    const err = new Error(
      `Store returned invalid served range for ${key}: ` +
      `${actualRange.start}-${actualRange.end}/${result.totalSize}`,
    );
    onError?.(err, { key, operation: "get" });
    // The body was never handed to a response: cancel a stream form or the
    // backing resource (fs file handle, pooled HTTP socket) stays open
    // until GC. Byte bodies hold nothing.
    cancelBody(result.body);
    return storeErrorResponse(err);
  }
  // Byte-count coherence: the emitted Content-Length is derived from the range
  // span (206) or totalSize (200), but the body streams result.contentLength
  // bytes. A store that reports a contentLength disagreeing with those would
  // commit a Content-Length that over- or under-runs the body -- a truncated
  // response the client cannot distinguish from a complete one. The multipart
  // path enforces this per part (servedSpanMatches); the hotter single-range
  // and 200 paths must guarantee it too. (A 200 with undefined totalSize is an
  // adapter bug the header builder already rejects, so only the defined case
  // is checked here.)
  const incoherentByteCount = actualRange
    ? result.contentLength !== actualRange.end - actualRange.start + 1
    : result.totalSize !== undefined && result.contentLength !== result.totalSize;
  if (incoherentByteCount) {
    const err = new Error(
      `Store returned incoherent byte count for ${key}: contentLength=${result.contentLength} ` +
      (actualRange ? `range=${actualRange.start}-${actualRange.end}` : `totalSize=${result.totalSize}`),
    );
    onError?.(err, { key, operation: "get" });
    cancelBody(result.body);
    return storeErrorResponse(err);
  }
  // A partial body must come from the representation the conditionals and
  // If-Range were just evaluated against. Pinning stores guarantee that
  // natively (ifMatch/pin); on stores that cannot pin (fs, an origin that
  // ignores If-Match), the object may change between the validating HEAD
  // and this GET. Comparing the GET's own validators against the HEAD's
  // catches the swap: the throw reuses the caller's one-shot re-validation,
  // so a stale If-Range then correctly yields a full 200 of the new bytes
  // instead of splicing them into the client's cached copy. Full responses
  // are exempt -- a 200 self-describes with its own validators. ETags are
  // compared only at equal strength: a store that hands a hash-derived
  // (strong) ETag to HEAD but only size+mtime (weak) to GET would otherwise
  // always mismatch; those fall back to the Last-Modified comparison.
  const etagsComparable = !!headEtag && !!getEtag
    && headEtag.startsWith("W/") === getEtag.startsWith("W/");
  if (
    actualRange
    && !sameRepresentation(
      { etag: etagsComparable ? headEtag : undefined, lastModified: headLastModified },
      { etag: etagsComparable ? getEtag : undefined, lastModified: result.lastModified },
    )
  ) {
    cancelBody(result.body);
    throw new ObjectChangedError(key);
  }
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
      serverTiming,
    });

    // Audit AFTER the headers commit, never before. onServe is the "grant"
    // event, so it must not fire for a response that never materializes: if
    // buildHeaders throws on corrupt metadata this streamFromStore call is
    // discarded (Path A re-runs, or a 502 is returned), and an onServe fired
    // up front would double-count the retry or log a phantom grant on a 502.
    if (auditCtx) {
      // streamFromStore only runs for GET: HEAD returns early via
      // buildHeadResponse, and Path C is unreachable when isHead forces needsHead.
      auditCtx.onServe({
        key, method: "GET", status: status as 200 | 206, mime: auditCtx.mime,
        bytesServed: result.contentLength, etag: finalEtag,
        ...(responseRange ? { rangeStart: responseRange.start, rangeEnd: responseRange.end } : {}),
      });
    }

    // Metering is opt-in: only wrap the body when a transfer hook is present,
    // so the common path keeps the runtime's static-body fast path. The wrap
    // happens AFTER buildHeaders and the audit hook, so the catch below still
    // cancels the untouched original on any earlier throw (once wrapped, the
    // source reader is locked and owned by the returned stream).
    const body = onTransfer
      ? meterBody(result.body, (bytesTransferred, completed) => onTransfer({
          key,
          method: "GET",
          status: status as 200 | 206,
          bytesExpected: result.contentLength,
          bytesTransferred,
          completed,
          ...(responseRange ? { rangeStart: responseRange.start, rangeEnd: responseRange.end } : {}),
        }))
      : result.body;

    return {
      status,
      statusText: STATUS_TEXT[status],
      headers,
      body,
    };
  } catch (err) {
    cancelBody(result.body);
    throw err;
  }
}

/** Options for {@link serveMultipart}. */
interface MultipartOpts {
  store: ObjectStore;
  key: string;
  /** Coalesced, satisfiable ranges (length >= 2), clamped to the object size. */
  ranges: ParsedRange[];
  totalSize: number;
  /** The representation's own MIME (goes in every part's Content-Type). */
  mime: string;
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
    store, key, ranges, totalSize, mime, etag, lastModified, digest,
    ifMatch, pin, ctx, signal, onError, timingCtx, auditCtx, onTransfer,
  } = opts;

  const boundary = generateMultipartBoundary();
  // Each part carries the representation's own Content-Type; apply the same
  // charset enforcement single-range responses use so the value (and thus the
  // precomputed Content-Length) is identical to what the framing emits.
  const partContentType = withCharset(mime, ctx);

  // Fetch the first part up front: a pinned read losing its race throws
  // ObjectChangedError HERE, before any headers are committed, so the caller
  // can re-validate once. Abort and store errors map to responses.
  const t0 = timingCtx ? performance.now() : 0;
  let firstStream: Awaited<ReturnType<ObjectStore["getObject"]>>;
  try {
    firstStream = await store.getObject(key, { range: ranges[0], signal, ifMatch, pin });
  } catch (err) {
    if (isObjectChangedError(err)) throw err;
    if (isAbortError(err)) return clientClosed();
    onError?.(err, { key, operation: "get" });
    return storeErrorResponse(err);
  }
  const getMs = timingCtx ? performance.now() - t0 : 0;

  // Validate the first part's served span BEFORE headers commit. On a
  // non-pinning store (one that cannot honor ifMatch/pin), a concurrent
  // overwrite between parts would otherwise splice bytes across
  // representations or under-run the precomputed Content-Length. A first-part
  // mismatch re-validates once via the orchestrator's retry loop. A byte
  // body's REAL length is checkable here too (streams settle lazily below).
  if (
    !servedSpanMatches(firstStream, ranges[0]!)
    || (firstStream.body instanceof Uint8Array
      && firstStream.body.byteLength !== ranges[0]!.end - ranges[0]!.start + 1)
  ) {
    cancelBody(firstStream.body);
    throw new ObjectChangedError(key);
  }

  const multipart = buildMultipartHeaders({
    boundary, ranges, totalSize, contentType: partContentType,
    etag, lastModified,
    // RFC 9530 Section 4: respect Want-Repr-Digest negotiation exactly like
    // buildHeaders does for single-range responses; weight 0 or an algorithm
    // list without sha-256 means "do not send".
    digest: ctx.digestWanted ? digest : undefined,
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
      const stream = i === 0
        ? firstStream
        : await store.getObject(key, { range, signal, ifMatch, pin });
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
      const body = stream.body;
      // Handoff point: cleanup is now guaranteed by the reader's finally below
      // (stream body) or is unneeded (byte body holds no resource). No await or
      // yield sits between here and getReader(), so a cancel cannot interleave.
      if (i === 0) firstPartOwned = true;
      const partSpan = range.end - range.start + 1;
      if (body instanceof Uint8Array) {
        // Claimed contentLength was validated above; the byte body's REAL
        // length must match too, or the framing under/over-runs.
        if (body.byteLength !== partSpan) {
          throw new ObjectChangedError(key);
        }
        yield body;
      } else {
        const reader = body.getReader();
        let partBytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            partBytes += value.byteLength;
            yield value;
          }
        } finally {
          // Release the backend resource on normal completion AND on an early
          // generator return (client cancelled mid-part).
          reader.cancel().catch(() => { /* already-settled reader */ });
        }
        // A gracefully-short (or long) part means the source diverged from
        // the span the committed Content-Length was computed from. Erroring
        // the stream (a reset the client sees as a failed transfer) beats
        // emitting well-formed framing around a torn part -- adapters with
        // internal length guards catch this earlier; this is the
        // store-agnostic backstop at the framing layer.
        if (partBytes !== partSpan) {
          throw new Error(
            `multipart part ${range.start}-${range.end} of ${key}: stream delivered `
            + `${partBytes} bytes, expected ${partSpan} (source changed mid-read)`,
          );
        }
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
        // narrow so the multipart body stays Response-assignable under DOM (F5).
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
  if (timingCtx) {
    const totalMs = timingCtx.storeMs + timingCtx.evaluateMs + getMs;
    headers["Server-Timing"] =
      `store;dur=${(timingCtx.storeMs + getMs).toFixed(1)},eval;dur=${timingCtx.evaluateMs.toFixed(1)}`;
    timingCtx.onTiming?.({
      storeMs: timingCtx.storeMs + getMs,
      evaluateMs: timingCtx.evaluateMs,
      totalMs,
    });
  }

  // Audit reports the multipart body's granted length (framing + all parts).
  auditCtx?.onServe({
    key, method: "GET", status: 206, mime: auditCtx.mime,
    bytesServed: multipart.contentLength, etag,
  });

  const body = onTransfer
    ? meterBody(rawBody, (bytesTransferred, completed) => onTransfer({
        key, method: "GET", status: 206,
        bytesExpected: multipart.contentLength, bytesTransferred, completed,
      }))
    : rawBody;

  return { status: 206, statusText: STATUS_TEXT[206], headers, body };
}

/**
 * Wrap a response body in a counting stream that reports the true bytes
 * transferred exactly once when the body reaches its terminal state.
 *
 * `report(bytesTransferred, completed)` fires on:
 *   - full drain (`completed: true`) -- the consumer read every byte,
 *   - cancel / client disconnect (`completed: false`) -- fewer bytes reached
 *     the client than the Content-Length promised,
 *   - source error (`completed: false`) -- a mid-transfer backend failure.
 *
 * A byte body is wrapped into a one-shot stream so metering is uniform across
 * stream and byte stores (the caller only pays this when a transfer hook is
 * registered; unmetered byte bodies keep the static-body fast path). The
 * `settled` latch guarantees the report fires once even if the consumer
 * cancels after the stream already closed.
 */
function meterBody(
  source: ReadableStream<Uint8Array> | Uint8Array,
  report: (bytesTransferred: number, completed: boolean) => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let transferred = 0;
  let settled = false;
  const settle = (completed: boolean): void => {
    if (settled) return;
    settled = true;
    report(transferred, completed);
  };

  // Normalize a byte body to a one-shot stream and meter it through the SAME
  // reader path, so `completed:true` fires only when the consumer has pulled
  // the terminal (done) result -- i.e. after it read the last chunk -- never
  // merely because the chunk was buffered ahead of a read. A dedicated
  // byte-path that settled inside its enqueue would over-report a disconnect
  // that lands after the chunk was queued but before it was consumed.
  const stream = source instanceof Uint8Array
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          if (source.byteLength > 0) controller.enqueue(source);
          controller.close();
        },
      })
    : source;

  const reader = stream.getReader();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      let res: Awaited<ReturnType<typeof reader.read>>;
      try {
        res = await reader.read();
      } catch (err) {
        settle(false);
        controller.error(err);
        return;
      }
      if (res.done) {
        settle(true);
        controller.close();
      } else {
        transferred += res.value.byteLength;
        // Backend byte chunks are ArrayBuffer-backed; narrow so the metered
        // body stays `new Response(...)`-assignable under DOM lib (F5).
        controller.enqueue(res.value as Uint8Array<ArrayBuffer>);
      }
    },
    async cancel(reason) {
      settle(false);
      await reader.cancel(reason);
    },
  });
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
  return !!served
    && served.start === range.start
    && served.end === range.end
    && stream.contentLength === range.end - range.start + 1;
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

/** Release a body that will never reach a response (stream forms only). */
function cancelBody(body: ReadableStream<Uint8Array> | Uint8Array): void {
  if (!(body instanceof ReadableStream)) return;
  try {
    // A locked stream (a reader was taken) throws SYNCHRONOUSLY here rather
    // than rejecting, so .catch alone would let it escape; an already-errored
    // stream rejects. Swallow both -- teardown is best-effort by definition.
    body.cancel().catch(() => { /* already-errored streams reject cancel */ });
  } catch { /* locked: the reader owns teardown */ }
}

/** Bodyless 499 parts, built per return (headers object is caller-owned). */
function clientClosed(): RawResponseParts {
  return {
    status: 499,
    statusText: "Client Closed Request",
    headers: { "Content-Length": "0" },
    body: null,
  };
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
 * Check if an error is an AbortError (client disconnected).
 * Works across runtimes: DOMException in browsers/Workers, AbortError in Node.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/**
 * Check if an error is a pinned-read ObjectChangedError.
 *
 * Matched by name rather than instanceof so third-party stores can throw
 * their own equivalently-named error without importing the kernel class.
 */
function isObjectChangedError(err: unknown): boolean {
  return err instanceof Error && err.name === "ObjectChangedError";
}

/**
 * Build a plain-text error response with a computed Content-Length.
 *
 * The body is encoded once and Content-Length comes from the encoded byte
 * count, so the header stays truthful even if a message ever gains
 * non-ASCII characters (String.length counts UTF-16 units, not bytes).
 */
function plainTextError(
  status: number,
  statusText: string,
  body: string,
  extraHeaders?: Record<string, string>,
): RawResponseParts {
  const bytes = UTF8_ENCODER.encode(body);
  return {
    status,
    statusText,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "Accept-Ranges": "none",
      // 404 is heuristically cacheable (RFC 9111 Section 4.2.2): without
      // this, a CDN can cache a transient miss and keep serving it after
      // the object appears. Errors must never outlive their cause.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      ...extraHeaders,
    },
    body: bytes,
  };
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
    return plainTextError(404, "Not Found", "Not Found");
  }
  if (isUnavailableStoreError(err)) {
    const secs = retryAfterSeconds(err);
    return plainTextError(
      503,
      "Service Unavailable",
      "Storage backend unavailable",
      secs !== undefined ? { "Retry-After": String(secs) } : undefined,
    );
  }
  return plainTextError(502, "Bad Gateway", "Storage backend error");
}

/**
 * Check if a store error represents a missing object (404).
 */
function isNotFoundStoreError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    return (err as { status: unknown }).status === 404;
  }
  if (err instanceof Error) {
    return err.name === "ObjectNotFoundError" || err.name === "NotFound";
  }
  return false;
}

/**
 * Check if a store error signals a transient, retryable backend condition
 * (throttling/overload/timeout). Matched by `status` 503 or by name so a
 * third-party store can throw an equivalently-named error without importing
 * the kernel class.
 */
function isUnavailableStoreError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    if ((err as { status: unknown }).status === 503) return true;
  }
  return err instanceof Error && err.name === "StoreUnavailableError";
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
  if (typeof err !== "object" || err === null || !("retryAfterSeconds" in err)) return undefined;
  return parseRetryAfterSeconds((err as { retryAfterSeconds: unknown }).retryAfterSeconds);
}

/**
 * Check if a MIME type is textual and should have charset=utf-8 enforced.
 */
function isTextualMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml") return true;
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;
  if (mime === "application/javascript" || mime === "application/ecmascript") return true;
  return false;
}
