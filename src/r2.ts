/**
 * Cloudflare R2 native ObjectStore adapter for partial-content.
 *
 * Uses Cloudflare's native R2 bindings (`R2Bucket`) directly, without the
 * AWS SDK. This eliminates the ~50-package `@aws-sdk/client-s3` dependency
 * and its cold-start overhead in Workers.
 *
 * For S3-compatible access to R2 (e.g. from Node.js outside Workers),
 * use `partial-content/s3` instead.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 * import { serveObject } from "partial-content/hono";
 *
 * // In a Cloudflare Worker with R2 binding:
 * app.get("/files/:key", serveObject(
 *   r2Store({ bucket: env.MY_BUCKET }),
 *   { key: (c) => c.req.param("key") },
 * ));
 * ```
 *
 * @packageDocumentation
 */

import {
  isOpenEndedRange,
  guardStreamLength,
  ObjectNotFoundError,
  ObjectChangedError,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
} from "./index.js";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };

// ─── R2 Types ───────────────────────────────────────────────────────────────

/**
 * Minimal R2Bucket interface from Cloudflare Workers types.
 *
 * Declared locally to avoid a dependency on `@cloudflare/workers-types`.
 * The shapes match the runtime behavior; type-checking is the caller's
 * responsibility (their Worker project imports the full types).
 */
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  /**
   * With `onlyIf`, a failed precondition resolves to a body-less `R2Object`
   * (not null, not an error) -- callers must check for `body`.
   */
  get(key: string, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null>;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  checksums: R2Checksums;
  httpMetadata?: R2HttpMetadata;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  range: R2Range;
}

interface R2Range {
  offset: number;
  length: number;
}

interface R2GetOptions {
  // `length` is optional in the real R2 binding: offset alone reads to the
  // end of the object (the open-ended fast-path form).
  range?: { offset: number; length?: number };
  onlyIf?: { etagMatches?: string };
}

interface R2Checksums {
  sha256?: ArrayBuffer;
}

interface R2HttpMetadata {
  contentType?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface R2StoreOptions {
  /** The R2 bucket binding from the Worker environment. */
  bucket: R2Bucket;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer SHA-256 checksum to base64 for RFC 9530 Repr-Digest.
 *
 * `checksums.sha256` is R2's whole-object SHA-256 as raw bytes, so unlike the
 * S3 adapter there is no `<base64>-<partCount>` composite string form to
 * reject: a 32-byte buffer always describes the full representation. If R2
 * ever exposes a per-part checksum in this field, this digest would need the
 * same whole-object guard S3 applies.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by a Cloudflare R2 bucket.
 *
 * @example
 * ```typescript
 * import { r2Store } from "partial-content/r2";
 *
 * export default {
 *   async fetch(request, env) {
 *     const store = r2Store({ bucket: env.MY_BUCKET });
 *     const meta = await store.headObject("reports/q4.pdf");
 *     // ...
 *   },
 * };
 * ```
 */
export function r2Store(opts: R2StoreOptions): ObjectStore {
  const { bucket } = opts;

  // No `classifyStoreRead` here (unlike s3/gcs/azure): the R2 Workers binding
  // signals its recoverable outcomes structurally, not as classifiable errors.
  // Not-found is a `null` return, a failed `onlyIf` pin is a body-less object,
  // and both are handled inline below. R2 exposes NO documented throttle/503
  // error shape on the native binding (rate limiting surfaces at the Workers
  // platform layer, before the handler runs), so there is nothing to map to
  // `StoreUnavailableError`. Inventing a classifier for an undocumented error
  // shape would be guessing; the README correctly omits R2 from the throttle-
  // classification list. Use `partial-content/s3` (R2's S3 endpoint) if you
  // need SlowDown/429 -> 503 mapping.
  return {
    supportsRange: true,
    // 206 bounds/total come from the R2ObjectBody's actual size/offset: the
    // orchestrator may skip the validating HEAD for plain range requests.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const obj = await bucket.head(key);
      if (!obj) throw new ObjectNotFoundError(key);

      return {
        contentLength: obj.size,
        etag: obj.etag,
        lastModified: obj.uploaded.toUTCString(),
        digest: obj.checksums.sha256
          ? arrayBufferToBase64(obj.checksums.sha256)
          : undefined,
      };
    },

    async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> {
      const { range, ifMatch } = opts ?? {};
      opts?.signal?.throwIfAborted();
      // An open-ended fast-path range (OPEN_ENDED sentinel end) reads to the
      // end of the object: pass offset alone so R2 streams the tail rather
      // than requesting a ~9e15 length.
      const r2Range = range
        ? (isOpenEndedRange(range)
            ? { offset: range.start }
            : { offset: range.start, length: range.end - range.start + 1 })
        : undefined;

      const getOptions: R2GetOptions | undefined = r2Range || ifMatch
        ? {
          ...(r2Range ? { range: r2Range } : {}),
          // Pin the read to the validated representation. On mismatch R2
          // returns the object WITHOUT a body (checked below).
          ...(ifMatch ? { onlyIf: { etagMatches: ifMatch } } : {}),
        }
        : undefined;

      const obj = await bucket.get(key, getOptions);
      if (!obj) throw new ObjectNotFoundError(key);

      // onlyIf precondition failed: R2 resolves with metadata but no body.
      if (!("body" in obj) || !obj.body) {
        throw new ObjectChangedError(key);
      }

      const body = obj as R2ObjectBody;
      const totalSize = obj.size;

      // Content-Range must reflect what R2 ACTUALLY returned, not what was
      // requested. `body.range` is R2's authoritative offset/length for this
      // response; if R2 clamped the range (object changed between HEAD and
      // GET), fabricating from the request would corrupt the client's bytes.
      const returned = range ? body.range : undefined;
      const start = returned?.offset ?? range?.start;
      const length = returned?.length
        ?? (range
          ? (isOpenEndedRange(range) ? totalSize - range.start : range.end - range.start + 1)
          : undefined);

      const isRanged = start !== undefined && length !== undefined;
      const contentLength = isRanged ? length : totalSize;

      return {
        // Guard the committed length: if R2 ever ends the body short of the
        // computed contentLength, error the stream rather than under-run it.
        body: guardStreamLength(body.body, contentLength),
        contentLength,
        totalSize,
        range: isRanged ? { start, end: start + length - 1 } : undefined,
        etag: obj.etag,
        lastModified: obj.uploaded.toUTCString(),
        digest: obj.checksums.sha256
          ? arrayBufferToBase64(obj.checksums.sha256)
          : undefined,
      };
    },
  };
}
