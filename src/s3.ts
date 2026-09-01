/**
 * S3-compatible storage adapters for partial-content.
 *
 * Implements the read-only {@link ObjectStore} interface from the kernel
 * (HeadObject/GetObject) and the resumable-write {@link ResumableWriteStore}
 * contract (multipart uploads) over `@aws-sdk/client-s3`. Covers:
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
 * import { s3Store, s3UploadStore } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const store = s3Store({ client, bucket: "documents" });
 * const uploads = s3UploadStore({ client, bucket: "documents" });
 * ```
 *
 * @packageDocumentation
 */

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  NoSuchKey,
  NotFound,
  NoSuchUpload,
  type CompletedPart,
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
  isSha256Base64,
  reservedKeyGuard,
} from "./index.ts";
import {
  UploadNotFoundError,
  UploadOffsetConflictError,
  UploadAppendBoundError,
  UploadOverrunError,
  UploadDigestMismatchError,
  isUploadNotFoundError,
  type ResumableWriteStore,
  type SweepingWriteStore,
  type StoredUploadState,
  type CreateUploadOptions,
  type AppendChunkOptions,
  type CompleteUploadOptions,
  type CompletedUpload,
} from "./upload-store.ts";
import {
  UPLOAD_ID_RE,
  cancelUploadBody,
  newUploadId,
  openUploadBody,
  publishKeyGuard,
} from "./upload-internals.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDigestMismatchError };
export { UploadAppendBoundError, UploadOverrunError };
export type {
  ResumableWriteStore,
  SweepingWriteStore,
  StoredUploadState,
  CreateUploadOptions,
  AppendChunkOptions,
  CompleteUploadOptions,
  CompletedUpload,
} from "./upload-store.ts";


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
  /**
   * Key prefix this store refuses to serve, because it is where an upload
   * store sharing this location keeps its in-flight bytes and the sidecars
   * naming their destination keys. Keys at or under it answer
   * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
   * @default ".uploads/"
   */
  reservedPrefix?: string;
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
/** Both S3 factories need a client and a bucket; neither fails usefully without one. */
function assertS3Target(factory: string, opts: { client?: unknown; bucket?: unknown } | undefined): void {
  if (opts?.client === null || typeof opts?.client !== "object") {
    throw new TypeError(`${factory}: options.client is required (an @aws-sdk/client-s3 S3Client)`);
  }
  if (typeof opts?.bucket !== "string" || opts.bucket === "") {
    throw new TypeError(
      `${factory}: options.bucket is required and must be a non-empty string, got ${JSON.stringify(opts?.bucket)}`,
    );
  }
}

export function s3Store(opts: S3StoreOptions): ObjectStore {
  assertS3Target("s3Store", opts);
  const { client, bucket } = opts;
  const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? ".uploads/");

  return {
    supportsRange: true,
    // 206 bounds/total are parsed from S3's actual Content-Range: the
    // orchestrator may skip the validating HEAD for plain range requests.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      assertReadable(key);
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
      assertReadable(key);
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
      assertReadable(key);
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

/**
 * Validate an S3 checksum for use as an RFC 9530 representation digest.
 *
 * Multipart uploads produce composite checksums ("checksum-of-checksums")
 * in the form `<base64>-<partCount>`, which do NOT hash the object bytes
 * and are invalid inside `Repr-Digest: sha-256=:...:`. Only a plain
 * base64 SHA-256 of the full object passes through.
 */
function toReprDigest(checksum: string | undefined): string | undefined {
  return isSha256Base64(checksum) ? checksum : undefined;
}

/**
 * Check if an S3 error indicates the object does not exist.
 *
 * Covers:
 *   - AWS SDK v3 `NoSuchKey` and `NotFound` error classes
 *   - Generic S3-compatible providers that set `$metadata.httpStatusCode: 404`
 *   - Providers that set `name: "NotFound"` or `name: "NoSuchKey"` without
 *     using the SDK error classes (a second SDK copy in the module graph
 *     makes `instanceof` silently false, so names are matched too)
 */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof NoSuchKey || err instanceof NotFound) return true;
  if (err instanceof Error && (err.name === "NotFound" || err.name === "NoSuchKey")) return true;
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

// ─── Resumable-Upload Write Adapter ─────────────────────────────────────────

/** The multipart part-size floor S3 enforces for every non-final part: 5 MiB. */
const S3_MIN_PART_SIZE = 5 * 1024 * 1024;

/**
 * S3's hard ceiling on parts per multipart upload. The largest object this
 * store can assemble is `S3_MAX_MULTIPART_PARTS * minPartSize` (~48.8 GiB at
 * the 5 MiB default); past it, S3 rejects `CompleteMultipartUpload` with an
 * opaque error. The store instead fails at the crossing part with a message
 * that names the `minPartSize` knob, so the ceiling is diagnosable and liftable
 * (raise `minPartSize` for larger objects) rather than a mystery completion 400.
 */
const S3_MAX_MULTIPART_PARTS = 10_000;

export interface S3UploadStoreOptions {
  /** Pre-configured S3Client instance (BYOC, no config coupling). */
  client: S3Client;
  /** The S3 bucket name. */
  bucket: string;
  /**
   * Part-buffering threshold in bytes. Defaults to 5 MiB, the floor S3 and
   * its compatibles enforce for every non-final multipart part. Appends
   * buffer to this size before committing a part; the sub-minimum remainder
   * is parked in a sidecar object until the next append or completion.
   * Parts are cut at exactly this size and S3 caps a multipart upload at
   * 10,000 parts, so raise it when objects may exceed 10,000 x minPartSize.
   */
  minPartSize?: number;
  /**
   * Key prefix for the upload bookkeeping sidecars (`<token>.info` metadata
   * and `<token>.part` sub-minimum tail). Defaults to `".uploads/"`; a
   * trailing slash is appended when missing.
   */
  uploadPrefix?: string;
  /**
   * Opt into S3 flexible checksums: SHA-256 on every part, verified by the
   * backend at part-upload time (per-part TRANSPORT integrity), with the
   * part checksums restated at completion so the backend validates the
   * assembled part list.
   *
   * This is deliberately NOT whole-object digest verification: multipart
   * SHA-256 checksums are composite only (a hash of per-part hashes), so no
   * S3 backend can verify a caller-asserted whole-representation SHA-256 at
   * completion, and `digestOnComplete` stays `false` either way.
   *
   * Default OFF because the checksum parameters are NOT portable across
   * S3-compatibles: some deployments reject them outright (501). Probe your
   * backend before enabling.
   */
  checksums?: boolean;
}

/**
 * Create a {@link ResumableWriteStore} backed by an S3-compatible bucket,
 * built on multipart uploads.
 *
 * Layout: each upload resource is one multipart upload targeting the final
 * key, plus two bookkeeping sidecars under `uploadPrefix`: `<token>.info`
 * (creation-time facts: declared length, metadata, timestamps, the
 * invalidation flag) and `<token>.part` (tail bytes below the part-size
 * floor, prepended to the next append or committed as the size-exempt final
 * part at completion).
 *
 * The offset is always derived from backend bookkeeping -- the committed
 * part listing plus the tail sidecar's size -- never from a stored counter,
 * so a crashed append can never answer an offset ahead of the durable bytes.
 *
 * @example
 * ```typescript
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { s3UploadStore } from "partial-content/s3";
 *
 * const client = new S3Client({ region: "eu-central-1" });
 * const uploads = s3UploadStore({ client, bucket: "documents" });
 *
 * const { uploadToken } = await uploads.createUpload({
 *   key: "reports/q4.pdf",
 *   length: 12_582_912,
 *   now: Date.now(),
 * });
 * ```
 */
export function s3UploadStore(opts: S3UploadStoreOptions): SweepingWriteStore {
  assertS3Target("s3UploadStore", opts);
  const { client, bucket, checksums = false } = opts;
  const minPartSize = opts.minPartSize ?? S3_MIN_PART_SIZE;
  if (!Number.isSafeInteger(minPartSize) || minPartSize <= 0) {
    throw new RangeError(`s3UploadStore: minPartSize must be a positive safe integer, got ${minPartSize}`);
  }
  const rawPrefix = opts.uploadPrefix ?? ".uploads/";
  const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
  const assertPublishable = publishKeyGuard(prefix);
  // The token is interpolated into object names, so the shape check lives in
  // the builders rather than at each call site: a caller that skipped it could
  // otherwise address `<prefix><anything>.info` and delete or read an object
  // this store never minted, including the foreign objects the sweep
  // deliberately leaves alone. Callers that must tolerate an unknown token
  // (readInfo, abortUpload) test it themselves and never reach here.
  const assertToken = (token: string): string => {
    if (!UPLOAD_ID_RE.test(token)) {
      throw new TypeError("s3UploadStore: refusing to build an object key from a token this store did not mint");
    }
    return token;
  };
  const infoKey = (token: string): string => `${prefix}${assertToken(token)}.info`;
  const partKey = (token: string): string => `${prefix}${assertToken(token)}.part`;

  const classified = <T>(key: string, op: () => Promise<T>): Promise<T> =>
    classifyStoreRead(key, op, uploadOpClassifiers);

  /** Read + parse the metadata sidecar; `undefined` when it does not exist. */
  async function readInfo(token: string, signal?: AbortSignal): Promise<UploadInfoRecord | undefined> {
    // The id is interpolated into object names, so a token that is not one the
    // store minted is refused here rather than sent to the backend as a key.
    if (!UPLOAD_ID_RE.test(token)) return undefined;
    let response;
    try {
      response = await classified(infoKey(token), () => client.send(
        new GetObjectCommand({ Bucket: bucket, Key: infoKey(token) }),
        { abortSignal: signal },
      ));
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
    const bytes = await bodyToBytes(response.Body, `upload metadata ${infoKey(token)}`);
    return parseInfoRecord(new TextDecoder().decode(bytes));
  }

  /**
   * Apply a patch to the sidecar, based on a FRESH read rather than on the
   * snapshot the caller has been holding.
   *
   * A sidecar write is a read-modify-write with no precondition behind it, and
   * the snapshot an append is holding was read before the body streamed, which
   * can be minutes. The lock makes that safe for a live holder and does not
   * make it safe for one whose lock was stolen: such a holder would write back
   * a record from before the new holder's changes, and `invalidated` lives
   * ONLY here, so re-writing it away silently resurrects a terminally dead
   * upload. Unlike `completed`, which the multipart-gone fallback re-derives
   * from the published object, nothing recomputes that flag.
   *
   * Two rules make the merge safe for what a stale writer can still do:
   *
   * - Both terminal flags are MONOTONIC. Once set, no later write clears them,
   *   whichever record it was computed from.
   * - The creation facts and a recorded length come from the fresh copy. They
   *   are write-once by contract, so the fresh copy either equals the caller's
   *   or is the one that won.
   *
   * That shrinks the window from stream-duration to one round trip. It does not
   * close it, and cannot: closing it needs a conditional write (If-Match on the
   * sidecar's ETag), which S3 now supports and the store does not yet use.
   */
  async function mergeInfo(
    token: string,
    fallback: UploadInfoRecord,
    patch: Partial<Pick<UploadInfoRecord, "length" | "lastAppendAt" | "invalidated" | "completed">>,
    signal?: AbortSignal,
  ): Promise<void> {
    // A read that fails leaves the caller's snapshot as the only base there
    // is; writing from it is what the code did unconditionally before, so the
    // fallback is no worse than the old floor and the monotonic rules below
    // still apply to whatever it holds.
    const fresh = await readInfo(token, signal).catch(() => undefined) ?? fallback;
    await writeInfo(token, {
      ...fresh,
      ...patch,
      ...(fresh.length !== undefined ? { length: fresh.length } : {}),
      ...(fresh.invalidated === true || patch.invalidated === true ? { invalidated: true } : {}),
      ...(fresh.completed === true || patch.completed === true ? { completed: true } : {}),
    }, signal);
  }

  async function writeInfo(token: string, record: UploadInfoRecord, signal?: AbortSignal): Promise<void> {
    await classified(infoKey(token), () => client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: infoKey(token),
      Body: JSON.stringify(record),
      ContentType: "application/json",
    }), { abortSignal: signal }));
  }

  /** Download the sub-minimum tail sidecar; `undefined` when absent. */
  async function readTail(token: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    try {
      const response = await classified(partKey(token), () => client.send(
        new GetObjectCommand({ Bucket: bucket, Key: partKey(token) }),
        { abortSignal: signal },
      ));
      return await bodyToBytes(response.Body, `upload tail ${partKey(token)}`);
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /** Size of the tail sidecar without downloading it; 0 when absent. */
  async function headTailSize(token: string, signal?: AbortSignal): Promise<number> {
    let response;
    try {
      response = await classified(partKey(token), () => client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: partKey(token) }),
        { abortSignal: signal },
      ));
    } catch (err) {
      if (isNotFoundError(err)) return 0;
      throw err;
    }
    if (response.ContentLength == null) {
      throw new Error(`HeadObject returned no ContentLength for ${partKey(token)}`);
    }
    return response.ContentLength;
  }

  /** DeleteObject that tolerates already-gone keys (S3 does natively; some compatibles 404). */
  async function deleteObjectIdempotent(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await classified(key, () => client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      ));
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  /** HEAD the final key: the published object's state, or `undefined`. */
  async function finalObjectState(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; etag?: string; lastModifiedMs?: number } | undefined> {
    let response;
    try {
      response = await classified(key, () => client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      ));
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
    if (response.ContentLength == null) {
      throw new Error(`HeadObject returned no ContentLength for ${key}`);
    }
    return {
      size: response.ContentLength,
      ...(response.ETag !== undefined ? { etag: response.ETag } : {}),
      ...(response.LastModified !== undefined ? { lastModifiedMs: response.LastModified.getTime() } : {}),
    };
  }

  /** Every committed part, across every ListParts page. */
  async function listCommittedParts(key: string, uploadId: string, signal?: AbortSignal): Promise<S3CommittedPart[]> {
    const parts: S3CommittedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await classified(key, () => client.send(new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        ...(marker !== undefined ? { PartNumberMarker: marker } : {}),
      }), { abortSignal: signal }));
      for (const part of page.Parts ?? []) {
        if (part.PartNumber == null || part.Size == null) {
          throw new Error(`ListParts returned a part without number/size for ${key}`);
        }
        parts.push({
          partNumber: part.PartNumber,
          size: part.Size,
          ...(part.ETag !== undefined ? { etag: part.ETag } : {}),
          ...(part.ChecksumSHA256 !== undefined ? { checksumSha256: part.ChecksumSHA256 } : {}),
        });
      }
      if (page.IsTruncated !== true) return parts;
      if (page.NextPartNumberMarker === undefined) {
        throw new Error(`ListParts for ${key} reported truncation without a NextPartNumberMarker`);
      }
      marker = page.NextPartNumberMarker;
    }
  }

  async function abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
    const signal = abortOpts?.signal;
    // A token this store never minted names no resource here, so aborting it
    // is a no-op rather than an error: the call is idempotent by contract for
    // an unknown token, and a token that cannot be one is a stronger case of
    // unknown. Tested here rather than relied on downstream, because the two
    // deletes below run even when the sidecar read finds nothing.
    if (!UPLOAD_ID_RE.test(uploadToken)) return;
    // The multipart is named by the sidecar, so a token that names none
    // discards nothing. An unreadable or corrupt sidecar still gets its
    // bookkeeping removed below, the one cleanup left possible.
    const info = await readInfo(uploadToken, signal).catch(() => undefined);
    if (info !== undefined) {
      try {
        await classified(info.key, () => client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: info.key,
          UploadId: info.uploadId,
        }), { abortSignal: signal }));
      } catch (err) {
        // Already aborted, or completed and reaped: idempotent by contract.
        if (!isMultipartGoneError(err)) throw err;
      }
    }
    await deleteObjectIdempotent(partKey(uploadToken), signal);
    await deleteObjectIdempotent(infoKey(uploadToken), signal);
  }

  return {
    // ── Capability flags ──
    /** Byte-exact appends are impossible under the part-size floor; the engine buffers to it. */
    appendGranularity: minPartSize,
    uniformPartSize: false,
    /**
     * Offset derives from ListParts + the tail sidecar's HEAD on every read,
     * both backend facts. The tail-lift's delete-before-rewrite window is the
     * bounded regression the flag's own doc describes: a crash there loses at
     * most the sub-minimum remainder and the client resumes lower.
     */
    exactOffsetRecovery: true,
    /** CompleteMultipartUpload publishes all-or-nothing. */
    atomicCompletion: true,
    /** Every append verifies the claimed offset against durable state before writing. */
    enforcesOffsetCheck: true,
    // Never "sha256": multipart SHA-256 checksums are composite (hash of
    // per-part hashes), so a whole-representation digest is unverifiable
    // server-side regardless of the checksums option.
    digestOnComplete: false,
    // maxAppendSize is deliberately absent: parts stream out as they fill, so
    // one append is never bounded by the backend's single-part size ceiling.

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      const { key, length, metadata, now, signal } = createOpts;
      assertPublishable(key);
      const created = await classified(key, () => client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ...(checksums ? { ChecksumAlgorithm: "SHA256" as const, ChecksumType: "COMPOSITE" as const } : {}),
      }), { abortSignal: signal }));
      if (created.UploadId === undefined) {
        throw new Error(`CreateMultipartUpload returned no UploadId for ${key}`);
      }
      const uploadToken = newUploadId();
      try {
        await writeInfo(uploadToken, {
          key,
          uploadId: created.UploadId,
          ...(length !== undefined ? { length } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          createdAt: now,
        }, signal);
      } catch (err) {
        // Without its metadata sidecar the resource is unreachable; reap the
        // multipart upload instead of leaking it until a lifecycle rule fires.
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId,
        })).catch(() => undefined); // best-effort: the sidecar failure is the story
        throw err;
      }
      return { uploadToken };
    },

    async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
      const signal = stateOpts?.signal;

      const info = await readInfo(uploadToken, signal);
      if (info === undefined) throw new UploadNotFoundError(uploadToken);
      const { key, uploadId } = info;
      if (info.completed === true) {
        const published = await finalObjectState(key, signal);
        if (published !== undefined) return publishedState(key, published, info);
        throw new UploadNotFoundError(uploadToken);
      }

      let parts: S3CommittedPart[];
      try {
        parts = await listCommittedParts(key, uploadId, signal);
      } catch (err) {
        if (isMultipartGoneError(err)) {
          // Multipart gone but metadata present: a completion published the
          // object and crashed before sidecar cleanup, or an external actor
          // (lifecycle rule) aborted the upload. The final key disambiguates.
          const published = await finalObjectState(key, signal);
          if (published !== undefined) return publishedState(key, published, info);
          throw new UploadNotFoundError(uploadToken, err);
        }
        throw err;
      }

      const committed = parts.reduce((sum, part) => sum + part.size, 0);
      const tailSize = await headTailSize(uploadToken, signal);
      return {
        key,
        offset: committed + tailSize,
        ...(info.length !== undefined ? { length: info.length } : {}),
        isComplete: false,
        isInvalidated: info.invalidated === true,
        createdAt: info.createdAt,
        ...(info.lastAppendAt !== undefined ? { lastAppendAt: info.lastAppendAt } : {}),
        ...(info.metadata !== undefined ? { metadata: info.metadata } : {}),
      };
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      const { maxBytes, maxBytesFatal, length: declaredLength, now, signal } = appendOpts;

      const info = await readInfo(uploadToken, signal);
      if (info === undefined) throw new UploadNotFoundError(uploadToken);
      const { key, uploadId } = info;
      if (info.invalidated === true) {
        // Defense in depth: the orchestrator's fresh state read already refused.
        throw new Error(`Upload resource is invalidated and accepts no bytes`);
      }

      let parts: S3CommittedPart[];
      try {
        parts = await listCommittedParts(key, uploadId, signal);
      } catch (err) {
        if (isMultipartGoneError(err)) throw new UploadNotFoundError(uploadToken, err);
        throw err;
      }
      const committed = parts.reduce((sum, part) => sum + part.size, 0);

      // The tail's bytes are needed for prepending, so GET (not HEAD) is the
      // state read here; its exact length feeds the offset verification.
      const tailBytes = await readTail(uploadToken, signal);
      const tailSize = tailBytes?.length ?? 0;
      const durableOffset = committed + tailSize;
      if (offset !== durableOffset) {
        throw new UploadOffsetConflictError(uploadToken, durableOffset);
      }

      // Lift the tail: delete the sidecar BEFORE rewriting its bytes into a
      // part. The crash window between delete and rewrite loses the tail
      // (the derived offset shrinks and the client resumes lower), which is
      // the safe direction; the opposite order double-counts the tail while
      // both copies exist, and an overstated offset is exactly the
      // corruption the backend-derived-offset rule exists to prevent.
      if (tailBytes !== undefined) {
        await deleteObjectIdempotent(partKey(uploadToken));
      }

      const queue = new ByteQueue();
      if (tailBytes !== undefined) queue.push(tailBytes);
      let nextPartNumber = parts.reduce((max, part) => Math.max(max, part.partNumber), 0) + 1;
      let flushed = 0;
      let received = 0;
      let ceilingHit = false;

      // Writes deliberately do not carry the abort signal: an in-progress
      // flush is allowed to finish so already-received bytes become durable
      // (the orchestrator owns the post-disconnect grace window).
      const flushPart = async (bytes: Uint8Array): Promise<void> => {
        // Fail at the crossing part, not at completion: past the ceiling S3
        // rejects CompleteMultipartUpload opaquely, so surface the real cause
        // and the lever (a larger minPartSize) while the token still resolves.
        if (nextPartNumber > S3_MAX_MULTIPART_PARTS) {
          throw new Error(
            `Upload exceeds S3's ${S3_MAX_MULTIPART_PARTS}-part limit `
            + `(max object ~= ${S3_MAX_MULTIPART_PARTS} x minPartSize); raise minPartSize`,
          );
        }
        await classified(key, () => client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: nextPartNumber,
          Body: bytes,
          ...(checksums ? { ChecksumAlgorithm: "SHA256" as const } : {}),
        })));
        nextPartNumber += 1;
        flushed += bytes.length;
      };

      // Reading the body and flushing to the backend get SEPARATE failure
      // handling, because they are separate failures wearing one shape. A body
      // that dies mid-request is the client vanishing: the accepted prefix is
      // the truthful answer and the next probe agrees with it, exactly as the
      // other adapters already treat it. A flush that dies is the backend, and
      // that must surface. One try around both reported a client disconnect as
      // a storage fault, which is a 502 for something the storage never saw.
      const { iterator, finalize } = openUploadBody(body, { cancelBody: false });
      try {
        for (;;) {
          let next: IteratorResult<Uint8Array>;
          try {
            next = await iterator.next();
          } catch {
            // Torn body: keep the prefix and account it truthfully.
            break;
          }
          if (next.done) break;
          const chunk = next.value;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            if (!maxBytesFatal) {
              // This request's ceiling, not the representation's. Stop reading
              // and fall through to the normal durable-flush tail below, so
              // the accepted prefix lands and the resource stays healthy; the
              // ceiling is reported after those bytes are safe.
              ceilingHit = true;
              break;
            }
            // Durably mark the terminal fault before surfacing it, so every
            // later state read refuses, even from a process that never saw
            // this request. No over-bound byte lands: the crossing chunk is
            // dropped, never written.
            await mergeInfo(uploadToken, info, { invalidated: true });
            await finalize();
            throw new UploadOverrunError(uploadToken, maxBytes);
          }
          queue.push(chunk);
          // Drained fully before the signal is consulted, deliberately. One
          // chunk can be several parts, and stopping mid-drain would not make
          // fewer bytes durable: the remainder is parked in the tail sidecar
          // below, which advances the derived offset by exactly as much. What
          // bounds a stalled holder is the chunk boundary, where it stops
          // pulling from the body; the shape those already-accepted bytes take
          // on the backend is not what the bound is about.
          while (queue.size >= minPartSize) {
            await flushPart(queue.take(minPartSize));
          }
          if (signal?.aborted) break;
        }
      } catch (err) {
        await finalize();
        await cancelUploadBody(body);
        throw err;
      }
      await finalize();
      if (signal?.aborted || ceilingHit) await cancelUploadBody(body);

      // Park the sub-minimum remainder (append tail OR abort leftover) in
      // the sidecar so every received byte is durable and counted by the
      // next offset derivation.
      if (queue.size > 0) {
        const remainder = queue.takeAll();
        await classified(partKey(uploadToken), () => client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: partKey(uploadToken),
          Body: remainder,
        })));
        flushed += remainder.length;
      }

      // Deferred-length declaration: the first append to carry a length records
      // it in the `.info` sidecar so the next getUploadState reports it and it
      // turns immutable. Only ever set once (the orchestrator guarantees it, and
      // the guard makes it safe): a length already recorded is never overwritten.
      // The PutObject below is awaited, so the length is durable before the ack.
      const declaresLength = declaredLength !== undefined && info.length === undefined;
      await mergeInfo(uploadToken, info, {
        ...(declaresLength ? { length: declaredLength } : {}),
        lastAppendAt: now,
      });

      // The prepended tail was durable before this call; only the incoming
      // prefix that actually flushed counts. (A flush failure right after
      // the tail delete can leave the derived offset lower than claimed;
      // the engine re-derives fresh state on the next interaction.)
      const bytesWritten = Math.max(0, flushed - tailSize);
      // Reported only now: the accepted prefix is durable and the resource is
      // untouched, so the client resumes from here in smaller chunks.
      if (ceilingHit) throw new UploadAppendBoundError(uploadToken, durableOffset + bytesWritten);
      return { bytesWritten };
    },

    async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
      const { expectedDigest, signal } = completeOpts;

      if (expectedDigest !== undefined) {
        // The orchestrator gates digest assertions on `digestOnComplete`
        // (always false here: multipart SHA-256 is composite-only, so no S3
        // backend can verify a whole-representation digest at completion).
        // Reaching this is a caller bug, and silently skipping verification
        // would launder an unverified digest.
        throw new Error(
          "s3UploadStore cannot verify a whole-object SHA-256: multipart checksums are composite (digestOnComplete is false)",
        );
      }

      const info = await readInfo(uploadToken, signal);
      if (info === undefined) throw new UploadNotFoundError(uploadToken);
      const { key, uploadId } = info;
      if (info.completed === true) {
        // Idempotent retry: the object published on an earlier call, and the
        // marker is the record that says which object was ours.
        const published = await finalObjectState(key, signal);
        if (published !== undefined) {
          return published.etag !== undefined ? { etag: published.etag } : {};
        }
        throw new UploadNotFoundError(uploadToken);
      }
      if (info.invalidated === true) {
        throw new Error(`Upload resource is invalidated and cannot complete`);
      }

      let parts: S3CommittedPart[];
      try {
        parts = await listCommittedParts(key, uploadId, signal);
      } catch (err) {
        if (isMultipartGoneError(err)) {
          // Multipart gone but metadata present: a prior completion
          // published the object and crashed before cleanup. The published
          // object answers the retry idempotently; finish the reap here.
          const published = await finalObjectState(key, signal);
          if (published !== undefined) {
            await deleteObjectIdempotent(partKey(uploadToken), signal);
            await deleteObjectIdempotent(infoKey(uploadToken), signal);
            return published.etag !== undefined ? { etag: published.etag } : {};
          }
          throw new UploadNotFoundError(uploadToken, err);
        }
        throw err;
      }

      const completedParts: CompletedPart[] = parts.map((part) => ({
        PartNumber: part.partNumber,
        ...(part.etag !== undefined ? { ETag: part.etag } : {}),
        ...(checksums && part.checksumSha256 !== undefined ? { ChecksumSHA256: part.checksumSha256 } : {}),
      }));

      const tailBytes = await readTail(uploadToken, signal);
      if (tailBytes !== undefined && tailBytes.length > 0) {
        // S3 exempts only the LAST part from the part-size floor, which is
        // exactly what the parked tail becomes here.
        const partNumber = parts.reduce((max, part) => Math.max(max, part.partNumber), 0) + 1;
        // The same ceiling flushPart enforces. Without it here, an upload of
        // exactly the limit plus a sub-minimum tail flushes its last legal part,
        // parks the remainder, and then fails the completion with S3's opaque
        // part-range error on every retry: uncompletable at 100%, with cancel
        // and a full re-upload as the only exit.
        if (partNumber > S3_MAX_MULTIPART_PARTS) {
          throw new Error(
            `Upload exceeds S3's ${S3_MAX_MULTIPART_PARTS}-part limit `
            + `(max object ~= ${S3_MAX_MULTIPART_PARTS} x minPartSize); raise minPartSize`,
          );
        }
        // Delete the sidecar BEFORE rewriting its bytes into a part, the same
        // ordering appendChunk uses and for the same reason. Committing first
        // leaves a window (a crash, or a throwing delete) where the tail exists
        // BOTH as a committed part and as a live sidecar, and the derived offset
        // then counts it twice: past a declared length that is a permanent
        // RangeError on every later call, and under a deferred length the client
        // resumes above its real progress and the published object silently
        // carries the tail twice while the source bytes at that range are never
        // sent. Losing the tail in the reverse window is the safe direction: the
        // offset shrinks by at most one tail and the client re-sends bytes it
        // still holds.
        await deleteObjectIdempotent(partKey(uploadToken));
        const uploaded = await classified(key, () => client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: tailBytes,
          ...(checksums ? { ChecksumAlgorithm: "SHA256" as const } : {}),
        })));
        completedParts.push({
          PartNumber: partNumber,
          ...(uploaded.ETag !== undefined ? { ETag: uploaded.ETag } : {}),
          ...(checksums && uploaded.ChecksumSHA256 !== undefined ? { ChecksumSHA256: uploaded.ChecksumSHA256 } : {}),
        });
      }

      if (completedParts.length === 0) {
        // S3 rejects a CompleteMultipartUpload with zero parts; a zero-byte
        // upload commits one empty part so an empty object can publish.
        const uploaded = await classified(key, () => client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: new Uint8Array(0),
          ...(checksums ? { ChecksumAlgorithm: "SHA256" as const } : {}),
        })));
        completedParts.push({
          PartNumber: 1,
          ...(uploaded.ETag !== undefined ? { ETag: uploaded.ETag } : {}),
          ...(checksums && uploaded.ChecksumSHA256 !== undefined ? { ChecksumSHA256: uploaded.ChecksumSHA256 } : {}),
        });
      }

      // Restating the per-part checksums in the part list makes the backend
      // validate the assembled sequence at completion; there is no
      // whole-object digest to assert (composite-only, see the options doc).
      const completion = await classified(key, () => client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }), { abortSignal: signal }));

      // Marked, not deleted: the sidecar is the only record of where this
      // upload published, and a retried completion or a late probe needs it to
      // answer. The sweep reaps it once idle. Failing to mark is not a failed
      // completion, since the object is already visible.
      await mergeInfo(uploadToken, info, { completed: true }, signal)
        .catch(() => undefined);

      return completion.ETag !== undefined ? { etag: completion.ETag } : {};
    },

    abortUpload,

    /**
     * Abort upload resources whose bookkeeping shows no activity since
     * before `olderThanMs`. Idleness is read from the metadata sidecar's
     * LastModified (rewritten on every accepted append), so one listing
     * sweeps the whole prefix without a GET per resource.
     *
     * S3's native alternative: a lifecycle rule with
     * `AbortIncompleteMultipartUpload` reaps the multipart uploads
     * themselves without this sweep, but knows nothing about the
     * `.info`/`.part` bookkeeping sidecars. Pair such a rule with an
     * expiration rule on the `uploadPrefix` keys, or keep running this
     * sweep, so the sidecars do not accumulate.
     */
    async sweepExpired(olderThanMs: number, sweepOpts?: { signal?: AbortSignal }): Promise<{ removed: number }> {
      const signal = sweepOpts?.signal;
      let removed = 0;
      let continuationToken: string | undefined;
      for (;;) {
        const page = await classified(prefix, () => client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }), { abortSignal: signal }));
        for (const object of page.Contents ?? []) {
          const objectKey = object.Key;
          if (objectKey === undefined || !objectKey.endsWith(".info")) continue;
          const lastActivityMs = object.LastModified?.getTime();
          if (lastActivityMs === undefined || lastActivityMs >= olderThanMs) continue;
          const token = objectKey.slice(prefix.length, -".info".length);
          if (!UPLOAD_ID_RE.test(token)) continue; // foreign object: not ours to reap
          try {
            await abortUpload(token, sweepOpts);
            removed += 1;
          } catch (err) {
            // A foreign object that merely looks like a sidecar decodes to
            // no upload; skip it rather than fail the whole sweep.
            if (!isUploadNotFoundError(err)) throw err;
          }
        }
        if (page.IsTruncated !== true) break;
        if (page.NextContinuationToken === undefined) {
          throw new Error(`s3UploadStore: truncated listing under ${prefix} without a NextContinuationToken`);
        }
        continuationToken = page.NextContinuationToken;
      }
      return { removed };
    },
  };
}

// ─── Upload Internal Helpers ────────────────────────────────────────────────

/** Creation-time facts persisted in the `.info` metadata sidecar. */
interface UploadInfoRecord {
  /** Held here rather than in the token: a request carries only the id. */
  key: string;
  uploadId: string;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  invalidated?: boolean;
  /**
   * Set once the object has published. The sidecar outlives completion so a
   * retried completion or a late probe still has a record proving this token
   * named this key; the sweep reaps it like any other idle bookkeeping.
   */
  completed?: boolean;
}

/** One committed part from a ListParts page. */
interface S3CommittedPart {
  partNumber: number;
  size: number;
  etag?: string;
  checksumSha256?: string;
}

/**
 * Upload operations reuse the shared classification pipeline for throttles
 * only: what "not found" MEANS differs per call (a missing sidecar, a gone
 * multipart upload, a published object), so each callsite interprets the raw
 * not-found error itself instead of receiving a read-side ObjectNotFoundError.
 */
const uploadOpClassifiers: StoreErrorClassifiers = {
  notFound: () => false,
  throttled: isThrottledError,
};

/**
 * The multipart upload backing a resource no longer exists (completed,
 * aborted, or lifecycle-reaped). AWS raises NoSuchUpload here, but several
 * S3-compatible backends raise NoSuchKey for the same condition, and some
 * SDK versions surface only the wire code as the error name, so the match
 * is name-based on top of the class checks.
 */
function isMultipartGoneError(err: unknown): boolean {
  if (err instanceof NoSuchUpload) return true;
  if (err instanceof Error && err.name === "NoSuchUpload") return true;
  return isNotFoundError(err);
}

/**
 * Parse + sanity-gate the metadata sidecar. Malformed contents are adapter
 * state corruption: fail loudly rather than fabricate protocol answers.
 */
function parseInfoRecord(text: string): UploadInfoRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Upload metadata sidecar holds unparseable JSON`, { cause: err });
  }
  const record = parsed as Partial<UploadInfoRecord> | null;
  if (record === null || typeof record !== "object"
    || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    throw new Error(`Upload metadata sidecar is missing a numeric createdAt`);
  }
  // The sidecar is the only source of the destination: a record without them
  // cannot address the backend, and guessing would defeat the point of keeping
  // them off the token.
  if (typeof record.key !== "string" || record.key === ""
    || typeof record.uploadId !== "string" || record.uploadId === "") {
    throw new Error(`Upload metadata sidecar is missing its key/uploadId`);
  }
  return record as UploadInfoRecord;
}

/** Completed-state answer derived from the published object under the final key. */
function publishedState(
  key: string,
  published: { size: number; lastModifiedMs?: number },
  info: UploadInfoRecord | undefined,
): StoredUploadState {
  return {
    key,
    offset: published.size,
    length: info?.length ?? published.size,
    isComplete: true,
    isInvalidated: false,
    // A reaped sidecar leaves no recorded creation time; the published
    // object's LastModified is the honest stand-in.
    createdAt: info?.createdAt ?? published.lastModifiedMs ?? 0,
    ...(info?.lastAppendAt !== undefined ? { lastAppendAt: info.lastAppendAt } : {}),
    ...(info?.metadata !== undefined ? { metadata: info.metadata } : {}),
  };
}

/**
 * FIFO byte accumulator for part cutting. `take` copies exactly `count`
 * bytes off the front; residual chunks stay as subarray views until cut.
 */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  size = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.chunks[0];
      if (head === undefined) {
        throw new RangeError(`ByteQueue: asked for ${count} bytes with only ${filled} buffered`);
      }
      const needed = count - filled;
      if (head.length <= needed) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, needed), filled);
        this.chunks[0] = head.subarray(needed);
        filled = count;
      }
    }
    this.size -= count;
    return out;
  }

  takeAll(): Uint8Array {
    return this.take(this.size);
  }
}

/** Collect an SDK response body (mixin, web stream, or Node Readable) into bytes. */
async function bodyToBytes(body: unknown, context: string): Promise<Uint8Array> {
  if (body == null) throw new Error(`${context}: response carried no body`);
  if (body instanceof Uint8Array) return body;
  const sdkBody = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof sdkBody.transformToByteArray === "function") {
    return sdkBody.transformToByteArray();
  }
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const queue = new ByteQueue();
    for await (const chunk of body as AsyncIterable<Uint8Array>) queue.push(chunk);
    return queue.takeAll();
  }
  throw new Error(`${context}: unsupported response body shape`);
}
