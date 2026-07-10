/**
 * Generic HTTP ObjectStore adapter for partial-content.
 *
 * Serves from ANY range-capable HTTP origin using plain `fetch`: Supabase
 * Storage, S3/GCS/Azure presigned URLs, CDN origins, internal file services,
 * or another partial-content server. Zero dependencies, every runtime.
 *
 * Capabilities mapped straight onto HTTP semantics:
 * - `headObject` -> `HEAD` (metadata from Content-Length / ETag / Last-Modified)
 * - `getObject`  -> `GET` with `Range: bytes=...`
 * - Pinned reads -> `If-Match` (origin 412 becomes {@link ObjectChangedError})
 * - RFC 9530     -> `Repr-Digest: sha-256=:...:` response header is extracted
 *
 * Caveats:
 * - The origin must send `Content-Length` (range-capable origins always do).
 * - Presigned URLs are signed per-method: a GET-presigned URL will reject the
 *   HEAD probe. Presign both methods in `url()` (it receives the key only;
 *   return method-agnostic URLs, or front the origin with a service that
 *   accepts both).
 * - Origins that ignore `If-Match` are still safe: the web adapter's
 *   response-side guard (actual Content-Range + GET validators) remains.
 *
 * @example Supabase Storage (authenticated)
 * ```typescript
 * import { httpStore } from "partial-content/http";
 * import { serveObject } from "partial-content/web";
 *
 * const store = httpStore({
 *   url: (key) => `${SUPABASE_URL}/storage/v1/object/documents/${key}`,
 *   headers: { Authorization: `Bearer ${serviceRoleKey}` },
 * });
 *
 * export const GET = serveObject(store, { disposition: "inline" });
 * ```
 *
 * @packageDocumentation
 */

import {
  ObjectNotFoundError,
  ObjectChangedError,
  StoreUnavailableError,
  resolveServedRange,
  parseRetryAfterSeconds,
  isOpenEndedRange,
  guardStreamLength,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
} from "./index.js";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

// ─── Options ────────────────────────────────────────────────────────────────

export interface HttpStoreOptions {
  /** Build the absolute URL for a storage key. */
  url: (key: string) => string | URL;
  /**
   * Request headers (e.g. Authorization). A static record, or a function of
   * the key for per-object credentials.
   */
  headers?: Record<string, string> | ((key: string) => Record<string, string>);
  /**
   * Fetch implementation. Defaults to the global `fetch`.
   * Inject for testing or to add retries/instrumentation. This is also the
   * SSRF hook: when `url()` incorporates untrusted input, supply a fetch
   * that validates resolved addresses (see SECURITY.md).
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Redirect policy for origin requests. Defaults to `"error"`: a serving layer
   * whose `url()` may incorporate untrusted keys must not let a compromised or
   * misconfigured origin bounce the store to internal endpoints (cloud metadata
   * IPs) via a 3xx. Object-storage origins answer GET/HEAD with a direct 200, so
   * the safe default costs nothing there. Set `"follow"` explicitly for origins
   * that legitimately redirect (some presigned-URL or CDN front-door flows);
   * pair it with a validating `fetch` (see SECURITY.md) when keys are untrusted.
   */
  redirect?: "follow" | "error" | "manual";
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by any range-capable HTTP origin.
 */
export function httpStore(opts: HttpStoreOptions): ObjectStore {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const redirect = opts.redirect ?? "error";

  function requestHeaders(key: string): Record<string, string> {
    const base = typeof opts.headers === "function"
      ? opts.headers(key)
      : opts.headers ?? {};
    return {
      ...base,
      // Byte accounting depends on the origin NOT transparently compressing:
      // a gzip'd body would break Content-Length/Content-Range math. Server
      // runtimes (undici, Bun, Deno, Workers) honor this; identity is also
      // what object-storage origins serve anyway.
      "Accept-Encoding": "identity",
    };
  }

  return {
    supportsRange: true,
    // 206 bounds/total are parsed from the origin's actual Content-Range
    // (an origin ignoring Range degrades to 200): the orchestrator may skip
    // the validating HEAD for plain range requests.
    authoritativeRange: true,

    async headObject(key: string, headOpts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      const response = await doFetch(opts.url(key), {
        method: "HEAD",
        headers: requestHeaders(key),
        signal: headOpts?.signal,
        redirect,
      });
      // HEAD bodies are empty; no need to drain before throwing.
      if (response.status === 404) throw new ObjectNotFoundError(key);
      if (isUnavailableStatus(response.status)) {
        throw new StoreUnavailableError(key, { retryAfterSeconds: parseRetryAfter(response) });
      }
      if (!response.ok) {
        throw new Error(`httpStore HEAD ${key} failed: ${response.status}`);
      }

      const headEncoding = nonIdentityEncoding(response);
      if (headEncoding) {
        throw new Error(
          `httpStore HEAD ${key}: origin returned Content-Encoding: ${headEncoding}; ` +
          `Content-Length would report the compressed size, so range serving requires an identity-coded body`,
        );
      }

      const contentLength = parseSize(response.headers.get("content-length"));
      if (contentLength === undefined) {
        throw new Error(
          `httpStore HEAD ${key}: origin sent no Content-Length; range serving requires sized responses`,
        );
      }

      return {
        contentLength,
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
        digest: extractSha256Digest(response.headers.get("repr-digest")),
      };
    },

    async getObject(
      key: string,
      getOpts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
    ): Promise<ObjectStream> {
      const { range, signal, ifMatch } = getOpts ?? {};
      const headers = requestHeaders(key);
      // Open-ended fast-path ranges carry the OPEN_ENDED sentinel end; emit
      // the bare `bytes=a-` form rather than a 16-digit last-byte-pos.
      if (range) {
        headers["Range"] = isOpenEndedRange(range)
          ? `bytes=${range.start}-`
          : `bytes=${range.start}-${range.end}`;
      }
      // Pin the read to the validated representation. Origins that honor
      // If-Match (S3, Azure, nginx, another partial-content server) answer
      // 412 when the object changed; origins that ignore it fall through to
      // the caller's response-side guard. Weak validators are never sent:
      // RFC 9110 mandates strong comparison for If-Match, so a `W/` ETag
      // would be rejected by every compliant origin on every attempt.
      if (ifMatch && !ifMatch.startsWith("W/")) {
        headers["If-Match"] = ifMatch;
      }

      const response = await doFetch(opts.url(key), {
        method: "GET",
        headers,
        signal,
        redirect,
      });

      if (response.status === 404) {
        await drain(response);
        throw new ObjectNotFoundError(key);
      }
      if (response.status === 412) {
        await drain(response);
        throw new ObjectChangedError(key);
      }
      if (isUnavailableStatus(response.status)) {
        const retryAfterSeconds = parseRetryAfter(response);
        await drain(response);
        throw new StoreUnavailableError(key, { retryAfterSeconds });
      }
      if (response.status !== 200 && response.status !== 206) {
        await drain(response);
        throw new Error(`httpStore GET ${key} failed: ${response.status}`);
      }

      // The fetch runtime transparently decodes a compressed body while
      // Content-Length / Content-Range still describe the encoded bytes, so
      // every byte count below would be wrong. Refuse rather than stream a
      // body that disagrees with its own headers.
      const getEncoding = nonIdentityEncoding(response);
      if (getEncoding) {
        await drain(response);
        throw new Error(
          `httpStore GET ${key}: origin returned Content-Encoding: ${getEncoding}; ` +
          `range and length accounting require an identity-coded body`,
        );
      }

      const headerLength = parseSize(response.headers.get("content-length"));
      let served: { start: number; end: number } | undefined;
      let contentLength: number;
      let totalSize: number | undefined;

      if (response.status === 206) {
        // A 206 MUST carry a parseable single-range Content-Range; without
        // one the body's bounds are unknowable and serving it as anything
        // would silently truncate or corrupt the client's view.
        const contentRangeHeader = response.headers.get("content-range");
        const resolved = contentRangeHeader ? resolveServedRange(contentRangeHeader) : null;
        if (!resolved) {
          await drain(response);
          throw new Error(
            `httpStore GET ${key}: origin sent 206 with ${contentRangeHeader ? `unparseable Content-Range "${contentRangeHeader}"` : "no Content-Range"}`,
          );
        }
        served = resolved.served;
        // Content-Length, or derived from the actual Content-Range when the
        // origin streams chunked 206s.
        contentLength = headerLength ?? (resolved.served.end - resolved.served.start + 1);
        // A proxied origin streaming a generated/transcoded body legitimately
        // does not know its full length and sends `bytes a-b/*` (the resolver's
        // `undefined` total). Propagate that so the served response repeats `*`
        // honestly instead of fabricating a total that would draw a spurious
        // 416 on a later range past the invented end.
        totalSize = resolved.totalSize;
      } else {
        if (headerLength === undefined) {
          await drain(response);
          throw new Error(
            `httpStore GET ${key}: origin sent no Content-Length; range serving requires sized responses`,
          );
        }
        contentLength = headerLength;
        totalSize = contentLength;
      }

      return {
        // Same truncation guard every other streaming adapter has: an origin
        // that ends the body cleanly but short of (or past) the Content-Length
        // it declared must error the stream, not close it looking complete
        // under the committed byte count.
        body: response.body
          ? guardStreamLength(response.body, contentLength)
          : emptyStream(),
        contentLength,
        totalSize,
        range: served,
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
        digest: extractSha256Digest(response.headers.get("repr-digest")),
      };
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Return the response's `Content-Encoding` when the origin transfer-compressed
 * the body despite our `Accept-Encoding: identity` request, or `null` when the
 * body is identity-coded. A compressed body is transparently decoded by the
 * fetch runtime, but `Content-Length` keeps reporting the compressed size,
 * which breaks all downstream byte accounting.
 */
function nonIdentityEncoding(response: Response): string | null {
  const enc = response.headers.get("content-encoding");
  return enc && enc.trim().toLowerCase() !== "identity" ? enc : null;
}

/** Parse a Content-Length header into a non-negative integer, or undefined. */
function parseSize(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Whether an origin status means "transiently unavailable, retry" (mapped to
 * a 503, not a 502): `503 Service Unavailable` and `429 Too Many Requests`.
 */
function isUnavailableStatus(status: number): boolean {
  return status === 503 || status === 429;
}

/**
 * Parse this origin response's `Retry-After` (RFC 9110 Section 10.2.3) into
 * whole seconds via the shared parser: delay-seconds directly, or an HTTP-date
 * as the non-negative delta from now. Returns undefined when absent/unparseable.
 */
function parseRetryAfter(response: Response): number | undefined {
  return parseRetryAfterSeconds(response.headers.get("retry-after"), { allowHttpDate: true });
}

/**
 * Extract the raw base64 SHA-256 from an RFC 9530 Repr-Digest header
 * (`sha-256=:BASE64:`), or undefined when absent / different algorithm.
 *
 * Linear manual scan rather than an unanchored `[A-Za-z0-9+/]+=*` regex:
 * on a long hostile header the regex backtracks quadratically, and a header
 * is attacker-influenced input when proxying arbitrary origins.
 */
function extractSha256Digest(header: string | null): string | undefined {
  if (!header) return undefined;
  const marker = "sha-256=:";
  const start = header.toLowerCase().indexOf(marker);
  if (start === -1) return undefined;
  const from = start + marker.length;
  let i = from;
  while (i < header.length && isBase64Char(header.charCodeAt(i))) i++;
  while (i < header.length && header[i] === "=") i++;
  if (i === from || header[i] !== ":") return undefined;
  return header.slice(from, i);
}

/** base64 alphabet: A-Z a-z 0-9 + / */
function isBase64Char(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
    || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;
}

/**
 * Consume up to `maxBytes` of an error/refusal body so the connection can be
 * reused, then cancel. A bare `response.arrayBuffer()` would buffer the ENTIRE
 * body -- and these paths include the malformed-206 and encoding-refusal
 * branches whose body is the real (potentially whole-object) payload, plus the
 * fetch runtime transparently INFLATES a compressed body during buffering. A
 * hostile or misconfigured origin could then drive per-request OOM (a
 * decompression bomb) just to make the adapter throw. Reading a small bounded
 * prefix keeps connection reuse for genuine 404/412 error bodies while capping
 * the cost; anything larger sacrifices one pooled connection, which is cheap.
 */
async function drain(response: Response, maxBytes = 64 * 1024): Promise<void> {
  const body = response.body;
  if (!body) return;
  try {
    const reader = body.getReader();
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // Body already consumed or connection gone; nothing to release.
  }
}

/** A closed empty stream for bodyless 200s (zero-byte objects). */
function emptyStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.close();
    },
  });
}
