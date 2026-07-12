/**
 * S3-compatible ObjectStore adapter for partial-content.
 *
 * Implements the read-only {@link ObjectStore} interface from the kernel,
 * wrapping `@aws-sdk/client-s3` HeadObject/GetObject commands. Covers:
 *   - AWS S3
 *   - Cloudflare R2 (S3-compatible mode)
 *   - Hetzner Object Storage
 *   - MinIO / Backblaze B2 / Wasabi
 *
 * For native R2 bindings (without the AWS SDK), use `partial-content/r2`.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3Store } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 * ```
 *
 * @packageDocumentation
 */

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
} from "@aws-sdk/client-s3";
import {
  ObjectNotFoundError,
  ObjectChangedError,
  StoreUnavailableError,
  classifyStoreRead,
  nodeStreamToWeb,
  guardStreamLength,
  resolveServedRange,
  parseRetryAfterSeconds,
  buildContentDisposition,
  isOpenEndedRange,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
  type StoreErrorClassifiers,
} from "./index.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

// ─── S3 Body -> Web ReadableStream ──────────────────────────────────────────

/**
 * Convert an S3 SDK response Body to a web ReadableStream.
 *
 * The SDK Body is a web ReadableStream in Bun/Deno, a Node Readable in
 * Node.js, and may expose `transformToWebStream()` as a convenience.
 * We try each path in order of preference.
 */
function toWebStream(body: unknown, signal?: AbortSignal, expectedBytes?: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  // Every branch enforces the committed length: an S3-compatible backend that
  // ends a body cleanly but short of ContentLength (some do in-flight body
  // retries) must error the stream, not silently under-run the response. The
  // web-stream branches are the ones Node aws-sdk v3 and Bun/Deno actually take,
  // so guarding only the Node-Readable fallback would leave the guard dead.
  if (body instanceof ReadableStream) {
    return guardStreamLength(body, expectedBytes);
  }
  if (typeof (body as { transformToWebStream?: () => ReadableStream }).transformToWebStream === "function") {
    return guardStreamLength(
      (body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream(),
      expectedBytes,
    );
  }
  // Node Readable fallback: the shared utility auto-detects destroy() and
  // applies the same length guard internally.
  return nodeStreamToWeb(body as AsyncIterable<Buffer | Uint8Array>, { signal, expectedBytes });
}

// ─── S3 ObjectStore Options ─────────────────────────────────────────────────

export interface S3StoreOptions {
  /** Pre-configured S3Client instance (BYOC, no config coupling). */
  client: S3Client;
  /** The S3 bucket name. */
  bucket: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by an S3-compatible bucket.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3Store } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 *
 * // Use with partial-content's evaluateConditionalRequest:
 * const meta = await store.headObject("reports/q4.pdf");
 * ```
 */
export function s3Store(opts: S3StoreOptions): ObjectStore {
  const { client, bucket } = opts;

  return {
    supportsRange: true,
    // 206 bounds/total are parsed from S3's actual Content-Range: the
    // orchestrator may skip the validating HEAD for plain range requests.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      const response = await classifyStoreRead(key, () => client.send(
        // ChecksumMode is required for S3 to return ChecksumSHA256 at all;
        // without it the digest would silently never be emitted.
        new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
        { abortSignal: opts?.signal },
      ), s3Classifiers);

      if (response.ContentLength == null) {
        throw new Error(`HeadObject returned no ContentLength for ${key}`);
      }

      return {
        contentLength: response.ContentLength,
        etag: response.ETag,
        lastModified: response.LastModified?.toUTCString(),
        digest: toReprDigest(response.ChecksumSHA256),
      };
    },

    async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> {
      const { range, signal, ifMatch } = opts ?? {};
      // Open-ended fast-path ranges (`bytes=a-`) carry the OPEN_ENDED
      // sentinel end; emit the bare open form so no 16-digit last-byte-pos
      // reaches the wire (S3 clamps it, but strict proxies may reject it).
      const rangeHeader = range
        ? (isOpenEndedRange(range) ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end}`)
        : undefined;

      const response = await classifyStoreRead(key, () => client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ChecksumMode: "ENABLED",
          // Pin the read to the validated representation: S3 rejects with
          // 412 PreconditionFailed if the object changed since HEAD.
          ...(ifMatch ? { IfMatch: ifMatch } : {}),
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        }),
        { abortSignal: signal },
      ), s3Classifiers);

      if (!response.Body) {
        throw new Error(`S3 GetObject returned empty body for ${key}`);
      }

      const stream = toWebStream(response.Body, signal, response.ContentLength);

      // A null ContentLength on a GET with a live body is a degenerate response:
      // fabricating `0` would commit `Content-Length: 0` over real bytes (a wire
      // framing error) and silently disable the short-read guard. headObject
      // already fails loudly on this; mirror it -- cancel the body and throw.
      if (response.ContentLength == null) {
        stream.cancel().catch(() => { /* already-errored streams reject cancel */ });
        throw new Error(`S3 GetObject returned no ContentLength for ${key}`);
      }
      const contentLength = response.ContentLength;

      // Extract served bounds + total size from Content-Range
      // (e.g. "bytes 0-999/5000") via the shared resolver, or fall back to
      // ContentLength for full responses. A Content-Range S3 emits but the
      // resolver cannot parse means the byte accounting is untrustworthy:
      // cancel the live body and fail loudly rather than guess.
      let totalSize: number | undefined;
      let served: { start: number; end: number } | undefined;
      if (response.ContentRange) {
        const resolved = resolveServedRange(response.ContentRange);
        if (!resolved) {
          stream.cancel().catch(() => { /* already-errored streams reject cancel */ });
          throw new Error(`S3 returned unparseable Content-Range for ${key}: ${response.ContentRange}`);
        }
        served = resolved.served;
        totalSize = resolved.totalSize;
      } else {
        totalSize = contentLength;
      }

      return {
        body: stream,
        contentLength,
        totalSize,
        range: served,
        etag: response.ETag,
        lastModified: response.LastModified?.toUTCString(),
        // Repr-Digest MUST hash the full representation. AWS omits the checksum
        // on ranged GETs, but a non-conforming S3-compatible backend could
        // return a range-scoped one; never advertise it as a whole-object
        // digest. HEAD (always whole-object) and full 200s still carry it.
        digest: served ? undefined : toReprDigest(response.ChecksumSHA256),
      };
    },

    async createSignedUrl(key, signOpts) {
      try {
        // A signed URL is a 302 redirect target: the client fetches bytes
        // DIRECTLY from S3, bypassing the serve route's security headers
        // (nosniff, CSP, CORP). Force a download disposition AND an inert
        // content type so a stored SVG/HTML polyglot cannot render inline off
        // the header-less origin response. Both are S3 query-parameter
        // overrides honored on the presigned GET; the stored object is
        // untouched. `downloadFilename` only customizes the name.
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: "application/octet-stream",
          ResponseContentDisposition: buildContentDisposition(
            signOpts.downloadFilename ?? "download",
            { type: "attachment" },
          ),
          // Response-header override, not an object mutation: keeps a private
          // document's caching policy authoritative even when the object was
          // uploaded with a public Cache-Control (the CDN-caches-your-private
          // -file footgun).
          ...(signOpts.cacheControl ? { ResponseCacheControl: signOpts.cacheControl } : {}),
        });

        // Lazy import: the presigner is an optional peer needed ONLY for
        // signed URLs. A static import would crash `partial-content/s3` at
        // module load for every consumer who installed just
        // @aws-sdk/client-s3 (the documented baseline) and never presigns.
        const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
        const url = await getSignedUrl(client, command, {
          expiresIn: signOpts.expiresInSeconds,
        });

        return { ok: true as const, url };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** A raw base64-encoded SHA-256 hash: exactly 43 base64 chars plus padding. */
const SHA256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Validate an S3 checksum for use as an RFC 9530 representation digest.
 *
 * Multipart uploads produce composite checksums ("checksum-of-checksums")
 * in the form `<base64>-<partCount>`, which do NOT hash the object bytes
 * and are invalid inside `Repr-Digest: sha-256=:...:`. Only a plain
 * base64 SHA-256 of the full object passes through.
 */
function toReprDigest(checksum: string | undefined): string | undefined {
  return checksum && SHA256_BASE64_RE.test(checksum) ? checksum : undefined;
}

/**
 * Check if an S3 error indicates the object does not exist.
 *
 * Covers:
 *   - AWS SDK v3 `NoSuchKey` and `NotFound` error classes
 *   - Generic S3-compatible providers that set `$metadata.httpStatusCode: 404`
 *   - Providers that set `name: "NotFound"` without using the SDK error classes
 */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof NoSuchKey || err instanceof NotFound) return true;
  if (err instanceof Error && err.name === "NotFound") return true;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  return false;
}

/**
 * Check if an S3 error is a failed IfMatch precondition (object changed).
 * The SDK surfaces this as name "PreconditionFailed" with HTTP 412.
 */
function isPreconditionFailedError(err: unknown): boolean {
  if (err instanceof Error && err.name === "PreconditionFailed") return true;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 412;
}

/**
 * Check if an S3 error is a transient throttle/overload the client should
 * retry (mapped to a 503, not a 502). The AWS SDK exhausts its own adaptive
 * retries first, so reaching here means sustained pressure.
 *
 * Covers:
 *   - `$retryable.throttling` (the SDK's own throttle classification)
 *   - HTTP 503 (`SlowDown`) and 429 (`TooManyRequests`) on `$metadata`
 *   - the named throttle errors S3-compatible backends raise without setting
 *     an HTTP status code
 */
function isThrottledError(err: unknown): boolean | { retryAfterSeconds: number } {
  let throttled = false;
  if ((err as { $retryable?: { throttling?: boolean } }).$retryable?.throttling === true) {
    throttled = true;
  } else {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    if (meta?.httpStatusCode === 503 || meta?.httpStatusCode === 429) {
      throttled = true;
    } else if (err instanceof Error) {
      const name = err.name;
      throttled =
        name === "SlowDown" ||
        name === "ThrottlingException" ||
        name === "TooManyRequestsException" ||
        name === "RequestThrottled" ||
        name === "RequestThrottledException" ||
        name === "ProvisionedThroughputExceededException";
    }
  }
  if (!throttled) return false;
  // Surface the backend's advised back-off when the SDK kept the raw
  // response: the resulting 503 echoes it as Retry-After so clients and
  // shared caches wait the advised interval instead of hammering an origin
  // that is already shedding load.
  const headers = (err as { $response?: { headers?: Record<string, string> } }).$response?.headers;
  const hint = parseRetryAfterSeconds(headers?.["retry-after"], { allowHttpDate: true });
  return hint !== undefined ? { retryAfterSeconds: hint } : true;
}

/** The ordered error-classification set shared by headObject and getObject. */
const s3Classifiers: StoreErrorClassifiers = {
  notFound: isNotFoundError,
  changed: isPreconditionFailedError,
  throttled: isThrottledError,
};
