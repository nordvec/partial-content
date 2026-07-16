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
} from "./index.ts";
import {
  UploadNotFoundError,
  UploadOffsetConflictError,
  type ResumableWriteStore,
  type StoredUploadState,
  type CreateUploadOptions,
  type AppendChunkOptions,
  type CompleteUploadOptions,
  type CompletedUpload,
} from "./upload-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };
export { UploadNotFoundError, UploadOffsetConflictError };

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

// ─── Resumable Upload: R2 Types ─────────────────────────────────────────────

/**
 * The bucket surface the upload store needs from the native Workers binding.
 * Declared locally (like the read side's {@link R2Bucket}) to avoid a
 * dependency on `@cloudflare/workers-types`; `env.MY_BUCKET` satisfies it
 * structurally.
 */
interface R2UploadBucket {
  head(key: string): Promise<{ etag: string } | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: Uint8Array | string): Promise<{ etag: string } | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string): Promise<R2MultipartUploadHandle>;
  /** Synchronous in the real binding: errors surface on the handle's methods. */
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadHandle;
}

interface R2MultipartUploadHandle {
  uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>;
  complete(uploadedParts: Array<{ partNumber: number; etag: string }>): Promise<{ etag: string }>;
  abort(): Promise<void>;
}

// ─── Resumable Upload: Options ──────────────────────────────────────────────

export interface R2UploadStoreOptions {
  /** The R2 bucket binding from the Worker environment. */
  bucket: R2UploadBucket;
  /** Object-key prefix for the store's `.manifest` bookkeeping objects. */
  uploadPrefix?: string;
  /**
   * Fixed size of every non-final multipart part (default 5 MiB, R2's
   * minimum). R2 requires all non-final parts of one upload to be the SAME
   * size, so appends buffer to exactly this granularity; the value is
   * persisted in the manifest at creation and later option changes never
   * tear an in-flight upload.
   */
  partSize?: number;
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

const R2_DEFAULT_UPLOAD_PREFIX = ".partial-content-uploads";
/** R2's minimum non-final part size, and the default uniform part size. */
const R2_DEFAULT_PART_SIZE = 5 * 1024 * 1024;
/** R2 (like S3) caps a multipart upload at 10,000 parts. */
const R2_MAX_PART_NUMBER = 10_000;

/** The UUID shape `createUpload` mints; nothing else may name a manifest. */
const R2_UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function r2BytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function r2Base64UrlToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** What the opaque upload token folds in (base64url JSON). */
interface R2UploadToken {
  key: string;
  id: string;
}

function encodeR2UploadToken(token: R2UploadToken): string {
  return r2BytesToBase64Url(new TextEncoder().encode(JSON.stringify(token)));
}

/**
 * Decode + validate a token. The `id` is interpolated into object keys, so
 * only the exact UUID shape minted at creation is accepted: a forged token
 * cannot traverse into foreign keys. Garbage decodes to
 * {@link UploadNotFoundError} (dialects answer 404, never a parse crash).
 */
function decodeR2UploadToken(uploadToken: string): R2UploadToken {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(r2Base64UrlToBytes(uploadToken)),
    );
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.key === "string" && candidate.key.length > 0 &&
        typeof candidate.id === "string" && R2_UPLOAD_ID_RE.test(candidate.id)
      ) {
        return { key: candidate.key, id: candidate.id };
      }
    }
  } catch (err) {
    throw new UploadNotFoundError(uploadToken, err);
  }
  throw new UploadNotFoundError(uploadToken);
}

/** One accepted part, exactly as recorded after its upload. */
interface R2ManifestPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * The adapter's own durable part ledger (the binding has NO ListParts).
 * Persisted as JSON at `<uploadPrefix>/<id>.manifest` and REWRITTEN after
 * every accepted part, so the recorded parts are always a durable prefix of
 * what actually landed.
 */
interface R2PersistedManifest {
  key: string;
  uploadId: string;
  partSize: number;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  isComplete: boolean;
  isInvalidated: boolean;
  /** Completion attempt entered its commit phase (crash-retry disambiguator). */
  completing?: boolean;
  /** Recorded at completion for idempotent-retry answers. */
  etag?: string;
  parts: R2ManifestPart[];
}

/** Decode + shape-validate a manifest; null for corrupt values. */
function decodeR2Manifest(raw: string): R2PersistedManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  const isCount = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const isPart = (v: unknown): v is R2ManifestPart =>
    typeof v === "object" && v !== null &&
    isCount((v as Record<string, unknown>).partNumber) &&
    (v as Record<string, unknown>).partNumber !== 0 &&
    typeof (v as Record<string, unknown>).etag === "string" &&
    isCount((v as Record<string, unknown>).size);
  if (
    typeof c.key === "string" && c.key.length > 0 &&
    typeof c.uploadId === "string" && c.uploadId.length > 0 &&
    isCount(c.partSize) && c.partSize > 0 &&
    (c.length === undefined || isCount(c.length)) &&
    isCount(c.createdAt) &&
    (c.lastAppendAt === undefined || isCount(c.lastAppendAt)) &&
    typeof c.isComplete === "boolean" &&
    typeof c.isInvalidated === "boolean" &&
    (c.completing === undefined || typeof c.completing === "boolean") &&
    (c.etag === undefined || typeof c.etag === "string") &&
    (c.metadata === undefined ||
      (typeof c.metadata === "object" && c.metadata !== null &&
        Object.values(c.metadata).every((v) => typeof v === "string"))) &&
    Array.isArray(c.parts) && c.parts.every(isPart)
  ) {
    return c as unknown as R2PersistedManifest;
  }
  return null;
}

/** Normalize an append body to an async chunk sequence. */
async function* r2UploadBodyChunks(
  body: ReadableStream<Uint8Array> | Uint8Array,
): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.length > 0) yield body;
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The binding's "multipart upload no longer exists" failure, by message. */
function isR2MultipartGone(err: unknown): boolean {
  return err instanceof Error && /does not exist|no such upload/i.test(err.message);
}

// ─── Resumable Upload: Factory ──────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by Cloudflare R2's native
 * multipart binding (createMultipartUpload / uploadPart / complete / abort).
 *
 * The binding exposes NO ListParts, so the adapter keeps its OWN durable part
 * ledger: a `<uploadPrefix>/<id>.manifest` JSON object rewritten after EVERY
 * accepted part (part number, etag, size), and `getUploadState` derives the
 * offset from that manifest. The write ordering is always part first, then
 * manifest: a crash between the two orphans the just-uploaded part and the
 * derived offset honestly EXCLUDES it (the part slot is simply re-uploaded on
 * resume; same-number uploads replace). That honesty has a hard limit, and it
 * is why `exactOffsetRecovery` is FALSE: the manifest is the adapter's own
 * bookkeeping, not backend-derived truth, and with no ListParts the binding
 * offers nothing to cross-check it against. The orchestrator therefore never
 * advertises exact resume on this store and re-anchors on its own accounting.
 *
 * Part sizing: R2 requires every non-final part of an upload to be the SAME
 * size (`uniformPartSize: true`), minimum 5 MiB. Appends buffer to exactly
 * `partSize` (`appendGranularity`), and any sub-partSize remainder at a
 * body's clean end is uploaded as the presumptive FINAL part. Orchestrators
 * honoring the granularity flags only ever leave a remainder on the last
 * append, which is exactly when a short part is legal; a mid-upload short
 * part (a direct caller ignoring the flags) is rejected by R2 itself at
 * `complete()`. On an aborted body, the partial buffer is deliberately NOT
 * flushed: a short part mid-upload would poison the uniform-size rule, so
 * only whole parts count and `bytesWritten` reports the truth.
 *
 * `completeUpload` publishes atomically via the binding's `complete()`
 * (nothing is visible until it returns). A `completing` marker written to the
 * manifest just before the commit disambiguates the crash window between
 * `complete()` and the final manifest update: on retry, a multipart-gone
 * error with the marker set and the object present at the key is recognized
 * as "already published" instead of failing the replay.
 *
 * Zero-byte completion: multipart requires at least one part, so an upload
 * with no parts publishes via a direct `put` of an empty object and the
 * multipart upload is aborted.
 *
 * GC: R2's default lifecycle aborts incomplete multipart uploads 7 days
 * after creation, so abandoned PART DATA reaps itself; schedule
 * {@link ResumableWriteStore.sweepExpired} to reap the manifest objects (it
 * also aborts still-live multipart state when it gets there first).
 *
 * `digestOnComplete` is `false`: multipart etags are not content hashes and
 * the binding exposes no whole-object SHA-256 for multipart uploads, so a
 * passed `expectedDigest` throws a clear error; the orchestrator reads the
 * flag and verifies upstream instead.
 *
 * @example
 * ```typescript
 * import { r2UploadStore } from "partial-content/r2";
 *
 * export default {
 *   async fetch(request, env) {
 *     const store = r2UploadStore({ bucket: env.MY_BUCKET });
 *     // ...
 *   },
 * };
 * ```
 */
export function r2UploadStore(opts: R2UploadStoreOptions): ResumableWriteStore {
  const { bucket } = opts;
  const prefix = (opts.uploadPrefix ?? R2_DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");
  const partSize = opts.partSize ?? R2_DEFAULT_PART_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new RangeError(`r2UploadStore: partSize must be a positive integer, got ${partSize}`);
  }

  const manifestName = (id: string): string => `${prefix}/${id}.manifest`;

  async function putManifest(id: string, manifest: R2PersistedManifest): Promise<void> {
    await bucket.put(manifestName(id), JSON.stringify(manifest));
  }

  /** Read + validate the manifest behind a token. Throws 404-shaped. */
  async function readUpload(uploadToken: string): Promise<{ manifest: R2PersistedManifest; id: string }> {
    const token = decodeR2UploadToken(uploadToken);
    const obj = await bucket.get(manifestName(token.id));
    if (!obj) throw new UploadNotFoundError(uploadToken);
    const manifest = decodeR2Manifest(await obj.text());
    // Corrupt bookkeeping, or a token whose key was tampered to point at a
    // different key than the one recorded at creation: both answer 404. The
    // PERSISTED key/uploadId are authoritative for every backend operation.
    if (!manifest || manifest.key !== token.key) {
      throw new UploadNotFoundError(uploadToken);
    }
    return { manifest, id: token.id };
  }

  function durableOffsetOf(manifest: R2PersistedManifest): number {
    return manifest.parts.reduce((sum, part) => sum + part.size, 0);
  }

  function toStoredState(manifest: R2PersistedManifest, offset: number): StoredUploadState {
    return {
      offset,
      length: manifest.length,
      isComplete: manifest.isComplete,
      isInvalidated: manifest.isInvalidated,
      createdAt: manifest.createdAt,
      lastAppendAt: manifest.lastAppendAt,
      metadata: manifest.metadata,
    };
  }

  return {
    appendGranularity: partSize,
    uniformPartSize: true,
    exactOffsetRecovery: false,
    atomicCompletion: true,
    digestOnComplete: false,

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      createOpts.signal?.throwIfAborted();
      const id = crypto.randomUUID();
      // Multipart upload FIRST, manifest second: if the manifest write
      // crashes, the caller retries creation and R2's default lifecycle
      // aborts the orphaned multipart upload after 7 days; the reverse order
      // could mint a resource whose multipart upload never existed.
      const mpu = await bucket.createMultipartUpload(createOpts.key);
      const manifest: R2PersistedManifest = {
        key: createOpts.key,
        uploadId: mpu.uploadId,
        partSize,
        length: createOpts.length,
        metadata: createOpts.metadata,
        createdAt: createOpts.now,
        isComplete: false,
        isInvalidated: false,
        parts: [],
      };
      await putManifest(id, manifest);
      return { uploadToken: encodeR2UploadToken({ key: createOpts.key, id }) };
    },

    async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
      stateOpts?.signal?.throwIfAborted();
      const { manifest } = await readUpload(uploadToken);
      return toStoredState(manifest, durableOffsetOf(manifest));
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      const { manifest, id } = await readUpload(uploadToken);
      if (manifest.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; nothing may be appended`);
      }
      if (manifest.isComplete) {
        throw new Error(`Upload ${uploadToken} is already complete; nothing may be appended`);
      }
      const durableOffset = durableOffsetOf(manifest);
      // Defense-in-depth under the orchestrator's lock: the manifest was
      // needed anyway, so the claimed offset is verified for free.
      if (offset !== durableOffset) {
        throw new UploadOffsetConflictError(uploadToken, durableOffset);
      }
      const mpu = bucket.resumeMultipartUpload(manifest.key, manifest.uploadId);
      let nextPartNumber = manifest.parts.reduce((max, part) => Math.max(max, part.partNumber), 0) + 1;
      const uniformSize = manifest.partSize;

      let written = 0;
      let consumed = 0;
      let manifestTouched = false;
      // Exact-size part assembly: R2's uniform-part rule needs precise
      // splitting, not a flush threshold.
      let buffer = new Uint8Array(uniformSize);
      let buffered = 0;

      const flushPart = async (bytes: Uint8Array): Promise<void> => {
        if (nextPartNumber > R2_MAX_PART_NUMBER) {
          throw new Error(
            `Upload ${uploadToken}: exceeds R2's 10,000-part limit; raise partSize`,
          );
        }
        // Part FIRST, manifest second (the load-bearing ordering): a crash
        // between the two orphans this part and the offset honestly excludes
        // it; resume re-uploads the same part number, which replaces.
        const uploaded = await mpu.uploadPart(nextPartNumber, bytes);
        manifest.parts.push({ partNumber: nextPartNumber, etag: uploaded.etag, size: bytes.length });
        manifest.lastAppendAt = appendOpts.now;
        await putManifest(id, manifest);
        manifestTouched = true;
        nextPartNumber += 1;
        written += bytes.length;
      };

      const iterator = r2UploadBodyChunks(body)[Symbol.asyncIterator]();
      let bodyEndedCleanly = false;
      while (true) {
        if (appendOpts.signal?.aborted) break;
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch {
          break; // body died: whole parts already recorded are the durable truth
        }
        if (next.done) {
          bodyEndedCleanly = true;
          break;
        }
        const chunk = next.value;
        consumed += chunk.length;
        if (appendOpts.maxBytes !== undefined && consumed > appendOpts.maxBytes) {
          // Bytes past the engine's hard bound are the terminal fault: record
          // the invalidation marker durably in the manifest, then fail loudly.
          manifest.isInvalidated = true;
          await putManifest(id, manifest);
          throw new Error(
            `Upload ${uploadToken}: body crossed the ${appendOpts.maxBytes}-byte bound; resource invalidated`,
          );
        }
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const take = Math.min(uniformSize - buffered, chunk.length - chunkOffset);
          buffer.set(chunk.subarray(chunkOffset, chunkOffset + take), buffered);
          buffered += take;
          chunkOffset += take;
          if (buffered === uniformSize) {
            await flushPart(buffer);
            buffer = new Uint8Array(uniformSize);
            buffered = 0;
          }
        }
      }
      // A clean body end flushes the remainder as the presumptive final part
      // (see the factory doc). An abort or a dead body does NOT: a short part
      // mid-upload would poison R2's uniform-size rule, so the un-flushed
      // tail is simply not durable and bytesWritten reports the truth.
      if (bodyEndedCleanly && buffered > 0) {
        await flushPart(buffer.subarray(0, buffered));
      }
      if (!manifestTouched) {
        // No part landed (zero-byte body, or nothing reached a part
        // boundary): still record the activity so sweeps see a live upload.
        manifest.lastAppendAt = appendOpts.now;
        await putManifest(id, manifest);
      }
      return { bytesWritten: written };
    },

    async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
      completeOpts.signal?.throwIfAborted();
      const { manifest, id } = await readUpload(uploadToken);
      if (manifest.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; it cannot be completed`);
      }
      if (manifest.isComplete) {
        return { etag: manifest.etag };
      }
      if (completeOpts.expectedDigest !== undefined) {
        // Orchestrators gate on digestOnComplete === false and never hand a
        // digest here; a digest anyway is a caller bug, never silently ignored.
        throw new Error(
          "r2UploadStore cannot verify a completion digest (digestOnComplete is false): " +
          "R2 multipart uploads expose no whole-object SHA-256",
        );
      }
      if (manifest.parts.length === 0) {
        // Zero-byte completion: multipart needs at least one part, so publish
        // an empty object directly and retire the multipart upload.
        const putResult = await bucket.put(manifest.key, new Uint8Array(0));
        try {
          await bucket.resumeMultipartUpload(manifest.key, manifest.uploadId).abort();
        } catch { /* already gone (lifecycle GC or a previous attempt); the publish stands */ }
        const etag = putResult?.etag;
        await putManifest(id, { ...manifest, isComplete: true, etag });
        return { etag };
      }
      const wasCompleting = manifest.completing === true;
      if (!wasCompleting) {
        // Commit-phase marker BEFORE complete(): it is what lets a retry tell
        // "my commit landed but the bookkeeping write crashed" apart from a
        // genuinely lost multipart upload.
        await putManifest(id, { ...manifest, completing: true });
      }
      const mpu = bucket.resumeMultipartUpload(manifest.key, manifest.uploadId);
      const sortedParts = manifest.parts
        .toSorted((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ partNumber: part.partNumber, etag: part.etag }));
      let etag: string | undefined;
      try {
        ({ etag } = await mpu.complete(sortedParts));
      } catch (err) {
        if (wasCompleting && isR2MultipartGone(err)) {
          // Retry of a crashed completion: the multipart upload is gone and
          // the marker says a commit was already attempted. An object at the
          // key confirms the publish landed; finish the bookkeeping.
          const head = await bucket.head(manifest.key);
          if (head) {
            await putManifest(id, { ...manifest, completing: true, isComplete: true, etag: head.etag });
            return { etag: head.etag };
          }
        }
        throw err;
      }
      await putManifest(id, { ...manifest, completing: true, isComplete: true, etag });
      return { etag };
    },

    async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
      abortOpts?.signal?.throwIfAborted();
      let token: R2UploadToken;
      try {
        token = decodeR2UploadToken(uploadToken);
      } catch {
        return; // idempotent: a token that never named a resource has nothing to discard
      }
      const obj = await bucket.get(manifestName(token.id));
      if (!obj) return; // already aborted/swept
      const manifest = decodeR2Manifest(await obj.text());
      // A token whose key disagrees with the recorded one is forged: it is
      // not this resource's handle, so it may discard NOTHING (state reads
      // answer 404 for it; deleting here would let a tampered token destroy
      // a live upload's bookkeeping).
      if (manifest && manifest.key !== token.key) return;
      if (manifest && !manifest.isComplete) {
        try {
          await bucket.resumeMultipartUpload(manifest.key, manifest.uploadId).abort();
        } catch { /* already gone (lifecycle GC or a previous abort); idempotent */ }
      }
      // A completed upload's published object is live data: only the
      // bookkeeping goes. A corrupt manifest has nothing else to discard.
      await bucket.delete(manifestName(token.id));
    },

    async sweepExpired(olderThanMs: number, sweepOpts?: { signal?: AbortSignal }): Promise<{ removed: number }> {
      let removed = 0;
      let cursor: string | undefined;
      do {
        sweepOpts?.signal?.throwIfAborted();
        const page = await bucket.list({ prefix: `${prefix}/`, cursor });
        for (const object of page.objects) {
          sweepOpts?.signal?.throwIfAborted();
          if (!object.key.endsWith(".manifest")) continue;
          const obj = await bucket.get(object.key);
          if (!obj) continue; // raced another sweeper/abort
          const manifest = decodeR2Manifest(await obj.text());
          // A corrupt manifest is already unusable (state reads answer 404),
          // so it is swept regardless of age.
          if (manifest) {
            const idleSince = manifest.lastAppendAt ?? manifest.createdAt;
            if (idleSince >= olderThanMs) continue;
            if (!manifest.isComplete) {
              // R2's default lifecycle aborts the multipart upload after
              // 7 days on its own; aborting here reclaims parts earlier.
              try {
                await bucket.resumeMultipartUpload(manifest.key, manifest.uploadId).abort();
              } catch { /* already gone; idempotent */ }
            }
          }
          await bucket.delete(object.key);
          removed += 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return { removed };
    },
  };
}
