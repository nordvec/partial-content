/**
 * Google Cloud Storage ObjectStore adapter for partial-content.
 *
 * Wraps `@google-cloud/storage` to implement the {@link ObjectStore} interface.
 *
 * @example
 * ```typescript
 * import { Storage } from "@google-cloud/storage";
 * import { gcsStore } from "partial-content/gcs";
 *
 * const storage = new Storage();
 * const store = gcsStore({ storage, bucket: "my-bucket" });
 * ```
 *
 * @packageDocumentation
 */

import {
  ObjectNotFoundError,
  ObjectChangedError,
  StoreUnavailableError,
  classifyStoreRead,
  nodeStreamToWeb,
  parseRetryAfterSeconds,
  buildContentDisposition,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
  type StoreErrorClassifiers,
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
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };
export { UploadNotFoundError, UploadOffsetConflictError };

// ─── GCS Types ──────────────────────────────────────────────────────────────

/**
 * Minimal GCS Storage interface.
 *
 * Declared locally to avoid a hard dependency on `@google-cloud/storage`.
 * Users who import `partial-content/gcs` will have it installed as an
 * optional peer dependency.
 */
interface GcsStorage {
  bucket(name: string): GcsBucket;
}

interface GcsBucket {
  file(name: string, opts?: { generation?: string | number }): GcsFile;
}

interface GcsFile {
  getMetadata(): Promise<[GcsFileMetadata]>;
  createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream & AsyncIterable<Buffer>;
  getSignedUrl(config: GcsSignedUrlConfig): Promise<[string]>;
}

/** The V4 read-signing subset of the SDK's `GetSignedUrlConfig`. */
interface GcsSignedUrlConfig {
  version: "v4";
  action: "read";
  expires: Date;
  /** Signed `response-content-disposition` query override. */
  responseDisposition: string;
  /** Signed `response-content-type` query override. */
  responseType: string;
}

interface GcsFileMetadata {
  size: string; // GCS returns size as a string
  etag?: string;
  /** Object generation: changes on every overwrite. Used to pin reads. */
  generation?: string | number;
  updated?: string; // ISO 8601
  /** Consumer-set custom metadata (the `x-goog-meta-*` namespace). */
  metadata?: Record<string, string>;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface GcsStoreOptions {
  /** Pre-configured @google-cloud/storage instance. */
  storage: GcsStorage;
  /** GCS bucket name. */
  bucket: string;
  /**
   * Custom-metadata key holding the object's whole-representation SHA-256
   * digest as raw base64 (written by the uploader, e.g.
   * `file.save(bytes, { metadata: { metadata: { sha256: "<base64>" } } })`
   * with `digestMetadataKey: "sha256"`). When set, `headObject`/`getObject`
   * surface a valid value as {@link ObjectMetadata.digest} /
   * {@link ObjectStream.digest} so the web adapter can emit `Repr-Digest`.
   * An absent or malformed value simply yields no digest, never an error.
   *
   * Exists because GCS has no native whole-object SHA-256 (its checksums are
   * MD5 and CRC32C, neither of which is valid inside
   * `Repr-Digest: sha-256=:...:`), so the digest must travel as consumer
   * metadata.
   */
  digestMetadataKey?: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by a Google Cloud Storage bucket.
 *
 * @example
 * ```typescript
 * import { Storage } from "@google-cloud/storage";
 * import { gcsStore } from "partial-content/gcs";
 *
 * const storage = new Storage();
 * const store = gcsStore({ storage, bucket: "my-bucket" });
 *
 * const meta = await store.headObject("reports/q4.pdf");
 * ```
 */
export function gcsStore(opts: GcsStoreOptions): ObjectStore {
  const bucket = opts.storage.bucket(opts.bucket);
  const { digestMetadataKey } = opts;

  return {
    supportsRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const [metadata] = await classifyStoreRead(key, () => bucket.file(key).getMetadata(), gcsClassifiers);

      const digest = digestFromCustomMetadata(metadata, digestMetadataKey);
      return {
        contentLength: parseInt(metadata.size, 10),
        etag: metadata.etag,
        lastModified: metadata.updated
          ? new Date(metadata.updated).toUTCString()
          : undefined,
        digest,
        // A generation names an immutable object version, so it can carry
        // everything getObject would otherwise re-fetch. No generation
        // (emulators, mocks) means no pin: getObject falls back to its own
        // metadata read.
        pin: metadata.generation !== undefined
          ? encodeGcsPin(metadata, digest)
          : undefined,
      };
    },

    async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string; pin?: string }): Promise<ObjectStream> {
      const { range, signal, ifMatch, pin } = opts ?? {};
      signal?.throwIfAborted();

      // A pin from our own headObject carries the generation, size, and
      // validators of the exact representation the caller validated, so the
      // metadata re-fetch is skipped entirely: one backend read per GET.
      // A pin whose etag disagrees with ifMatch (or that fails to decode)
      // is ignored and the metadata path revalidates from scratch. When an
      // ifMatch is present the pin must carry a matching etag to be trusted:
      // a pin lacking the validator cannot silently satisfy the precondition,
      // it falls through to the metadata path that actually enforces ifMatch.
      const pinned = pin ? decodeGcsPin(pin) : null;
      const usablePin = pinned && (!ifMatch || pinned.etag === ifMatch)
        ? pinned
        : null;

      let generation: string | number | undefined;
      let totalSize: number;
      let etag: string | undefined;
      let lastModified: string | undefined;
      let digest: string | undefined;

      if (usablePin) {
        generation = usablePin.generation;
        totalSize = usablePin.size;
        etag = usablePin.etag;
        lastModified = usablePin.lastModified;
        digest = usablePin.digest;
      } else {
        // GCS streams carry no total size, the ifMatch check needs the
        // current etag, and generation pinning needs the current generation.
        const [metadata] = await classifyStoreRead(key, () => bucket.file(key).getMetadata(), gcsClassifiers);

        // Caller pin: the object must still match the validator captured at
        // HEAD time. GCS etags change on every overwrite, so a mismatch means
        // the representation the caller validated no longer exists.
        if (ifMatch && metadata.etag && metadata.etag !== ifMatch) {
          throw new ObjectChangedError(key);
        }

        generation = metadata.generation;
        totalSize = parseInt(metadata.size, 10);
        etag = metadata.etag;
        lastModified = metadata.updated
          ? new Date(metadata.updated).toUTCString()
          : undefined;
        digest = digestFromCustomMetadata(metadata, digestMetadataKey);
      }

      if (range && range.start >= totalSize) {
        // Unsatisfiable ranges are the orchestrator's job to reject
        // (parseRangeHeader 416s them first); a direct caller gets a loud
        // error instead of a truncated body under an inflated Content-Length.
        throw new RangeError(
          `gcsStore ${key}: range start ${range.start} is beyond object size ${totalSize}`,
        );
      }
      // Clamp the end so contentLength and the reported range match what
      // the backend stream will actually deliver (createReadStream clamps
      // to EOF silently; the reported bounds must not diverge from it).
      const end = range ? Math.min(range.end, totalSize - 1) : totalSize - 1;
      const streamOpts = range
        ? { start: range.start, end }
        : undefined;

      // Pin the stream to the generation just measured (or the caller's
      // pinned generation): metadata and bytes come from the SAME object
      // version even if it is overwritten between the two calls (reading a
      // specific generation is immutable in GCS).
      const pinnedFile = generation !== undefined
        ? bucket.file(key, { generation })
        : bucket.file(key);
      const nodeStream = pinnedFile.createReadStream(streamOpts);

      const contentLength = range
        ? (end - range.start + 1)
        : totalSize;

      // nodeStreamToWeb auto-detects the stream's destroy() capability.
      // expectedBytes guards a graceful short-read: a truncated GCS download
      // that ends cleanly below the committed length errors the body instead
      // of under-running the Content-Length undetected.
      const webStream = nodeStreamToWeb(nodeStream, { signal, expectedBytes: contentLength });

      return {
        body: webStream,
        contentLength,
        totalSize,
        range: range ? { start: range.start, end } : undefined,
        etag,
        lastModified,
        // Unlike S3's range-scoped checksums, a custom-metadata digest names
        // the WHOLE representation by definition, so ranged reads keep it
        // (Repr-Digest is valid on 206 responses).
        digest,
      };
    },

    async createSignedUrl(key, signOpts) {
      try {
        // A signed URL is a 302 redirect target: the client fetches bytes
        // DIRECTLY from GCS, bypassing the serve route's security headers
        // (nosniff, CSP, CORP). Force a download disposition AND an inert
        // content type so a stored SVG/HTML polyglot cannot render inline
        // off the header-less origin response. Both are response-content-*
        // query overrides honored on the signed GET; the stored object is
        // untouched. `downloadFilename` only customizes the name.
        //
        // Cache-Control limitation: GCS signed URLs support only the
        // response-content-disposition and response-content-type overrides;
        // there is no response-cache-control equivalent (unlike S3), so
        // `cacheControl` is deliberately omitted rather than faked. The
        // redirect target serves the Cache-Control baked into the object at
        // upload; uploaders of private documents should store a private
        // Cache-Control on the object itself.
        const [url] = await bucket.file(key).getSignedUrl({
          version: "v4",
          action: "read",
          expires: new Date(Date.now() + signOpts.expiresInSeconds * 1000),
          responseType: "application/octet-stream",
          responseDisposition: buildContentDisposition(
            signOpts.downloadFilename ?? "download",
            { type: "attachment" },
          ),
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

/**
 * A raw base64-encoded SHA-256 hash: exactly 43 base64 chars plus padding.
 * The only shape trusted as an RFC 9530 representation digest; anything else
 * (hex, truncated base64, a composite checksum) is discarded, never emitted.
 */
const SHA256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Extract a consumer-stored whole-object SHA-256 from GCS custom metadata
 * ({@link GcsStoreOptions.digestMetadataKey}). An absent key, an unset
 * option, or a value that is not the raw base64 of a 32-byte SHA-256 yields
 * undefined -- a malformed uploader value degrades to "no digest", it never
 * throws and never frames garbage as a `Repr-Digest`.
 */
function digestFromCustomMetadata(
  metadata: GcsFileMetadata,
  digestMetadataKey: string | undefined,
): string | undefined {
  if (!digestMetadataKey) return undefined;
  const value = metadata.metadata?.[digestMetadataKey];
  return typeof value === "string" && SHA256_BASE64_RE.test(value)
    ? value
    : undefined;
}

/** Shape carried inside the opaque {@link ObjectMetadata.pin} token. */
interface GcsPin {
  generation: string | number;
  size: number;
  etag?: string;
  lastModified?: string;
  /** Whole-representation SHA-256 (raw base64), validated at encode time. */
  digest?: string;
}

function encodeGcsPin(metadata: GcsFileMetadata, digest: string | undefined): string {
  const pin: GcsPin = {
    generation: metadata.generation!,
    size: parseInt(metadata.size, 10),
    etag: metadata.etag,
    lastModified: metadata.updated
      ? new Date(metadata.updated).toUTCString()
      : undefined,
    digest,
  };
  return JSON.stringify(pin);
}

/** Decode a pin token; null for foreign/corrupt tokens (fall back to metadata). */
function decodeGcsPin(pin: string): GcsPin | null {
  try {
    const parsed: unknown = JSON.parse(pin);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      // `size` becomes totalSize: it drives range clamping, Content-Length,
      // and Content-Range framing, so only a non-negative safe integer is
      // honest byte accounting. A forged negative or fractional size would
      // flow straight into stream bounds and the wire framing.
      typeof candidate.size === "number" &&
      Number.isSafeInteger(candidate.size) && candidate.size >= 0 &&
      // `generation` flows straight into bucket.file(key, { generation }) and
      // selects the immutable version served. Only a non-empty string or a
      // finite number is a real generation; anything else (object, array,
      // null) is a corrupt/hostile token that must revalidate from scratch,
      // never index an arbitrary version.
      isValidGeneration(candidate.generation) &&
      // Validators are surfaced verbatim as ETag/Last-Modified response
      // headers: a forged non-string value must fall back to revalidation,
      // never flow a bad type downstream.
      (candidate.etag === undefined || typeof candidate.etag === "string") &&
      (candidate.lastModified === undefined || typeof candidate.lastModified === "string") &&
      // The digest is emitted inside `Repr-Digest: sha-256=:...:`; only the
      // exact raw-base64 SHA-256 shape validated at encode time is trusted.
      (candidate.digest === undefined ||
        (typeof candidate.digest === "string" && SHA256_BASE64_RE.test(candidate.digest)))
    ) {
      return candidate as unknown as GcsPin;
    }
  } catch { /* not our token: revalidate via metadata instead */ }
  return null;
}

/** A GCS generation is a non-empty string or a finite number; nothing else. */
function isValidGeneration(gen: unknown): gen is string | number {
  return (typeof gen === "string" && gen.length > 0) ||
    (typeof gen === "number" && Number.isFinite(gen));
}

function isGcsNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code: unknown }).code === 404;
  }
  return false;
}

/**
 * Whether a GCS error is a transient throttle/overload the client should retry
 * (mapped to a 503, not a 502). The Cloud Storage client surfaces the HTTP
 * status on `err.code`: 429 (rate limit) or 503 (backend unavailable).
 */
function isGcsThrottled(err: unknown): boolean | { retryAfterSeconds: number } {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code !== 429 && code !== 503) return false;
    // Surface the backend's advised back-off when the client library kept
    // the raw response, so the resulting 503 echoes it as Retry-After.
    const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
    const hint = parseRetryAfterSeconds(headers?.["retry-after"], { allowHttpDate: true });
    return hint !== undefined ? { retryAfterSeconds: hint } : true;
  }
  return false;
}

/**
 * The error-classification set shared by both metadata reads. GCS has no
 * `changed` predicate: its pin is an etag comparison (handled inline, throwing
 * {@link ObjectChangedError} directly), not a native conditional error.
 */
const gcsClassifiers: StoreErrorClassifiers = {
  notFound: isGcsNotFound,
  throttled: isGcsThrottled,
};

// ─── Resumable Upload: GCS Types ────────────────────────────────────────────

/**
 * The storage surface the upload store needs. Declared locally (like the
 * read side's {@link GcsStorage}) to avoid a hard dependency on
 * `@google-cloud/storage`; the real `Storage` satisfies it structurally.
 */
interface GcsUploadStorage {
  bucket(name: string): GcsUploadBucket;
}

interface GcsUploadBucket {
  file(name: string): GcsUploadFile;
  getFiles(query: {
    prefix: string;
  }): Promise<[Array<{ name: string; metadata?: { size?: string | number } }>]>;
  /** Server-side compose: concatenates up to 32 sources into the destination. */
  combine(sources: string[], destination: string): Promise<unknown>;
}

interface GcsUploadFile {
  save(data: Uint8Array | string, options?: { resumable?: boolean }): Promise<void>;
  download(): Promise<[Uint8Array]>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  createWriteStream(options?: { resumable?: boolean }): GcsUploadWritable;
  getMetadata(): Promise<[{ size?: string | number; etag?: string }]>;
}

/** The Node-writable subset the chunk pump drives (write/backpressure/finish). */
interface GcsUploadWritable {
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
  once(event: "drain" | "error" | "finish", listener: (arg?: unknown) => void): unknown;
  off(event: "drain" | "error" | "finish", listener: (arg?: unknown) => void): unknown;
}

// ─── Resumable Upload: Options ──────────────────────────────────────────────

export interface GcsUploadStoreOptions {
  /** Pre-configured @google-cloud/storage instance. */
  storage: GcsUploadStorage;
  /** GCS bucket name. */
  bucket: string;
  /**
   * Object-name prefix for the store's staging area: chunk objects live at
   * `<uploadPrefix>/<id>/<n>`, bookkeeping at `<uploadPrefix>/<id>.info`,
   * compose intermediates at `<uploadPrefix>/<id>.compose/<lvl>-<i>`.
   */
  uploadPrefix?: string;
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

const GCS_DEFAULT_UPLOAD_PREFIX = ".partial-content-uploads";
/** GCS caps a single compose call at 32 sources. */
const GCS_MAX_COMPOSE_SOURCES = 32;
/** Chunk-object names are zero-padded so listings read in append order. */
const GCS_CHUNK_NAME_WIDTH = 6;

/** The UUID shape `createUpload` mints; nothing else may name upload objects. */
const GCS_UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function gcsBytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function gcsBase64UrlToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** What the opaque upload token folds in (base64url JSON). */
interface GcsUploadToken {
  key: string;
  id: string;
}

function encodeGcsUploadToken(token: GcsUploadToken): string {
  return gcsBytesToBase64Url(new TextEncoder().encode(JSON.stringify(token)));
}

/**
 * Decode + validate a token. The `id` is interpolated into object names, so
 * only the exact UUID shape minted at creation is accepted: a forged token
 * cannot traverse into foreign objects. Garbage decodes to
 * {@link UploadNotFoundError} (dialects answer 404, never a parse crash).
 */
function decodeGcsUploadToken(uploadToken: string): GcsUploadToken {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(gcsBase64UrlToBytes(uploadToken)),
    );
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.key === "string" && candidate.key.length > 0 &&
        typeof candidate.id === "string" && GCS_UPLOAD_ID_RE.test(candidate.id)
      ) {
        return { key: candidate.key, id: candidate.id };
      }
    }
  } catch (err) {
    throw new UploadNotFoundError(uploadToken, err);
  }
  throw new UploadNotFoundError(uploadToken);
}

/** Durable upload bookkeeping, persisted as the `.info` object's JSON body. */
interface GcsPersistedUpload {
  key: string;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  isComplete: boolean;
  isInvalidated: boolean;
  /** Recorded at completion for idempotent-retry answers. */
  etag?: string;
}

/** Decode + shape-validate persisted state; null for corrupt values. */
function decodeGcsPersistedUpload(raw: Uint8Array): GcsPersistedUpload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  const isCount = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (
    typeof c.key === "string" && c.key.length > 0 &&
    (c.length === undefined || isCount(c.length)) &&
    isCount(c.createdAt) &&
    (c.lastAppendAt === undefined || isCount(c.lastAppendAt)) &&
    typeof c.isComplete === "boolean" &&
    typeof c.isInvalidated === "boolean" &&
    (c.etag === undefined || typeof c.etag === "string") &&
    (c.metadata === undefined ||
      (typeof c.metadata === "object" && c.metadata !== null &&
        Object.values(c.metadata).every((v) => typeof v === "string")))
  ) {
    return c as unknown as GcsPersistedUpload;
  }
  return null;
}

/** Normalize an append body to an async chunk sequence. */
async function* gcsUploadBodyChunks(
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

/**
 * Wait for one stream event, rejecting if `error` fires first. Both listeners
 * detach on settle so repeated waits never stack handlers.
 */
function gcsOnceEvent(stream: GcsUploadWritable, event: "drain" | "finish"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (err?: unknown): void => {
      stream.off(event, onEvent);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.once(event, onEvent);
    stream.once("error", onError);
  });
}

/** A listed size is a string in real GCS responses; tolerate numbers too. */
function gcsSizeToNumber(size: string | number | undefined): number {
  if (typeof size === "number") return size;
  if (typeof size === "string") {
    const parsed = parseInt(size, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// ─── Resumable Upload: Factory ──────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by Google Cloud Storage using
 * the object-per-chunk + compose model.
 *
 * Deliberately NOT GCS's native resumable sessions: those demand 256 KiB
 * append alignment and bind the whole upload to one session URI, which breaks
 * byte-exact appends and stateless crash recovery. Instead:
 * - `appendChunk` writes each append as its own immutable object
 *   `<uploadPrefix>/<id>/<n>` (arbitrary sizes; a single-shot object write is
 *   atomic, so a chunk either fully exists or does not exist at all).
 * - `getUploadState` derives the offset by listing the chunk objects and
 *   summing their sizes: backend bookkeeping, never a stored counter
 *   (`exactOffsetRecovery: true`).
 * - `completeUpload` assembles via server-side compose. Compose accepts at
 *   most 32 sources per call, so larger chunk sets compose level by level
 *   into intermediates under `<uploadPrefix>/<id>.compose/`, deleting each
 *   consumed intermediate level as the next one lands; the FINAL compose onto
 *   the destination key is a single call, so publication is all-or-nothing
 *   (`atomicCompletion: true`). Chunks are deleted only after that final
 *   compose, so a crashed completion retries from intact chunks.
 * - Creation-time facts (final key, declared length, caller metadata,
 *   timestamps) ride a small JSON object `<uploadPrefix>/<id>.info`,
 *   rewritten on each append (lastAppendAt) and at terminal transitions.
 *
 * `digestOnComplete` is `false`: the contract's completion digest is the
 * client-asserted whole-representation SHA-256, and GCS's native checksums
 * are MD5/CRC32C only, so a passed `expectedDigest` throws a clear error and
 * the orchestrator (which reads the flag) verifies upstream. The composed
 * object's CRC32C is not surfaced either: verifying it would require a
 * CRC32C-combine implementation to compute an expected value, real code for a
 * digest no client asserted, so no `"crc32c"` capability is claimed.
 *
 * GC: GCS has no native lifecycle for these plain staging objects (unlike
 * Azure's 7-day uncommitted-block GC), so schedule
 * {@link ResumableWriteStore.sweepExpired} to reap abandoned uploads, or add
 * a bucket lifecycle rule scoped to the `uploadPrefix`.
 *
 * @example
 * ```typescript
 * import { Storage } from "@google-cloud/storage";
 * import { gcsUploadStore } from "partial-content/gcs";
 *
 * const storage = new Storage();
 * const store = gcsUploadStore({ storage, bucket: "my-bucket" });
 * ```
 */
export function gcsUploadStore(opts: GcsUploadStoreOptions): ResumableWriteStore {
  const bucket = opts.storage.bucket(opts.bucket);
  const prefix = (opts.uploadPrefix ?? GCS_DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");

  const infoName = (id: string): string => `${prefix}/${id}.info`;
  const chunkPrefix = (id: string): string => `${prefix}/${id}/`;
  const composePrefix = (id: string): string => `${prefix}/${id}.compose/`;
  const chunkName = (id: string, index: number): string =>
    `${chunkPrefix(id)}${String(index).padStart(GCS_CHUNK_NAME_WIDTH, "0")}`;

  async function saveState(state: GcsPersistedUpload, id: string): Promise<void> {
    await bucket.file(infoName(id)).save(JSON.stringify(state), { resumable: false });
  }

  /** Read + validate the persisted state behind a token. Throws 404-shaped. */
  async function readUpload(uploadToken: string): Promise<{ state: GcsPersistedUpload; id: string }> {
    const token = decodeGcsUploadToken(uploadToken);
    let raw: Uint8Array;
    try {
      [raw] = await bucket.file(infoName(token.id)).download();
    } catch (err) {
      if (isGcsNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
      throw err;
    }
    const state = decodeGcsPersistedUpload(raw);
    // Corrupt bookkeeping, or a token whose key was tampered to point at a
    // different object than the one recorded at creation: both answer 404.
    // The PERSISTED key is authoritative for every backend operation.
    if (!state || state.key !== token.key) {
      throw new UploadNotFoundError(uploadToken);
    }
    return { state, id: token.id };
  }

  /** List this upload's chunk objects, ascending by append sequence. */
  async function listChunks(id: string): Promise<Array<{ name: string; index: number; size: number }>> {
    const [entries] = await bucket.getFiles({ prefix: chunkPrefix(id) });
    const chunks: Array<{ name: string; index: number; size: number }> = [];
    for (const entry of entries) {
      const tail = entry.name.slice(chunkPrefix(id).length);
      if (!/^\d+$/.test(tail)) continue; // foreign object under the prefix: never ours to count
      chunks.push({ name: entry.name, index: parseInt(tail, 10), size: gcsSizeToNumber(entry.metadata?.size) });
    }
    return chunks.toSorted((a, b) => a.index - b.index);
  }

  async function deleteObjects(names: string[]): Promise<void> {
    for (const name of names) {
      await bucket.file(name).delete({ ignoreNotFound: true });
    }
  }

  /** Drop every staging artifact of one upload (chunks, intermediates, info). */
  async function deleteUploadArtifacts(id: string): Promise<void> {
    const [chunkEntries] = await bucket.getFiles({ prefix: chunkPrefix(id) });
    await deleteObjects(chunkEntries.map((entry) => entry.name));
    const [composeEntries] = await bucket.getFiles({ prefix: composePrefix(id) });
    await deleteObjects(composeEntries.map((entry) => entry.name));
    await bucket.file(infoName(id)).delete({ ignoreNotFound: true });
  }

  function toStoredState(state: GcsPersistedUpload, offset: number): StoredUploadState {
    return {
      offset,
      length: state.length,
      isComplete: state.isComplete,
      isInvalidated: state.isInvalidated,
      createdAt: state.createdAt,
      lastAppendAt: state.lastAppendAt,
      metadata: state.metadata,
    };
  }

  return {
    exactOffsetRecovery: true,
    atomicCompletion: true,
    digestOnComplete: false,

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      createOpts.signal?.throwIfAborted();
      const id = crypto.randomUUID();
      const state: GcsPersistedUpload = {
        key: createOpts.key,
        length: createOpts.length,
        metadata: createOpts.metadata,
        createdAt: createOpts.now,
        isComplete: false,
        isInvalidated: false,
      };
      await saveState(state, id);
      return { uploadToken: encodeGcsUploadToken({ key: createOpts.key, id }) };
    },

    async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
      stateOpts?.signal?.throwIfAborted();
      const { state, id } = await readUpload(uploadToken);
      if (state.isInvalidated) {
        // Terminal: the offset is moot (the engine refuses everything anyway).
        return toStoredState(state, 0);
      }
      if (state.isComplete) {
        // Chunks are deleted after publication; the published object itself
        // is the backend bookkeeping now.
        try {
          const [meta] = await bucket.file(state.key).getMetadata();
          return toStoredState(state, gcsSizeToNumber(meta.size));
        } catch (err) {
          if (!isGcsNotFound(err)) throw err;
          // Published object was deleted later; the completion answer stands.
          return toStoredState(state, state.length ?? 0);
        }
      }
      const chunks = await listChunks(id);
      const offset = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      return toStoredState(state, offset);
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      const { state, id } = await readUpload(uploadToken);
      if (state.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; nothing may be appended`);
      }
      if (state.isComplete) {
        throw new Error(`Upload ${uploadToken} is already complete; nothing may be appended`);
      }
      const chunks = await listChunks(id);
      const durableOffset = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      // Cheap defense-in-depth under the orchestrator's lock: the chunk
      // listing was needed anyway (next sequence number), so the claimed
      // offset is verified against the durable sum for free.
      if (offset !== durableOffset) {
        throw new UploadOffsetConflictError(uploadToken, durableOffset);
      }
      const nextIndex = chunks.length > 0 ? chunks[chunks.length - 1]!.index + 1 : 0;

      // The chunk object's write stream opens lazily on the first byte: a
      // zero-byte append records activity without littering empty objects.
      let stream: GcsUploadWritable | undefined;
      let streamFailure: unknown;
      const noteFailure = (err?: unknown): void => {
        streamFailure = err ?? new Error("GCS chunk write stream failed");
        // Keep an error listener armed so a late second emit cannot crash the
        // process; the recorded failure already carries the outcome.
        stream?.once("error", noteFailure);
      };
      let written = 0;
      let consumed = 0;

      const iterator = gcsUploadBodyChunks(body)[Symbol.asyncIterator]();
      while (true) {
        if (appendOpts.signal?.aborted) break;
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch {
          // Body died (client disconnect): end the object with the received
          // prefix below and account it truthfully.
          break;
        }
        if (next.done) break;
        consumed += next.value.length;
        if (appendOpts.maxBytes !== undefined && consumed > appendOpts.maxBytes) {
          // Bytes past the engine's hard bound are the terminal fault. The
          // destroyed single-shot write leaves NO object behind, then the
          // invalidation is recorded durably so every later interaction refuses.
          stream?.destroy(new Error("append crossed the engine's byte bound"));
          await saveState({ ...state, isInvalidated: true }, id);
          throw new Error(
            `Upload ${uploadToken}: body crossed the ${appendOpts.maxBytes}-byte bound; resource invalidated`,
          );
        }
        if (streamFailure) break;
        if (!stream) {
          stream = bucket.file(chunkName(id, nextIndex)).createWriteStream({ resumable: false });
          stream.once("error", noteFailure);
        }
        if (!stream.write(next.value)) {
          try {
            await gcsOnceEvent(stream, "drain");
          } catch {
            break; // recorded by noteFailure; surfaced after the loop
          }
        }
        written += next.value.length;
      }

      if (stream) {
        if (streamFailure) {
          // A failed single-shot object write is atomic: nothing durable
          // landed, so fail loudly and let fresh state tell the truth.
          throw streamFailure instanceof Error
            ? streamFailure
            : new Error(String(streamFailure));
        }
        const finished = gcsOnceEvent(stream, "finish");
        stream.end();
        await finished;
      }
      await saveState({ ...state, lastAppendAt: appendOpts.now }, id);
      return { bytesWritten: stream ? written : 0 };
    },

    async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
      completeOpts.signal?.throwIfAborted();
      const { state, id } = await readUpload(uploadToken);
      if (state.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; it cannot be completed`);
      }
      if (state.isComplete) {
        return { etag: state.etag };
      }
      if (completeOpts.expectedDigest !== undefined) {
        // Orchestrators gate on digestOnComplete === false and never hand a
        // digest here; a digest anyway is a caller bug, never silently ignored.
        throw new Error(
          "gcsUploadStore cannot verify a completion digest (digestOnComplete is false): " +
          "GCS exposes MD5/CRC32C checksums only, not the asserted whole-representation SHA-256",
        );
      }
      const chunks = await listChunks(id);
      if (chunks.length === 0) {
        // Zero-byte completion: compose needs at least one source, so publish
        // an empty object directly (single-shot writes are atomic).
        await bucket.file(state.key).save(new Uint8Array(0), { resumable: false });
      } else {
        // Batched composition: levels of at most 32 sources reduce into
        // intermediates until one final <=32-source compose publishes the key.
        // Consumed INTERMEDIATE levels are deleted as the next level lands;
        // the original chunks survive until after the final compose so a
        // crashed completion can always retry from intact inputs.
        let sources = chunks.map((chunk) => chunk.name);
        let level = 0;
        while (sources.length > GCS_MAX_COMPOSE_SOURCES) {
          const nextLevel: string[] = [];
          for (let i = 0; i < sources.length; i += GCS_MAX_COMPOSE_SOURCES) {
            const group = sources.slice(i, i + GCS_MAX_COMPOSE_SOURCES);
            // Deterministic intermediate names: a retry after a crash simply
            // overwrites the same objects instead of stranding new ones.
            const intermediate = `${composePrefix(id)}${level}-${nextLevel.length}`;
            await bucket.combine(group, intermediate);
            nextLevel.push(intermediate);
          }
          if (level > 0) await deleteObjects(sources);
          sources = nextLevel;
          level += 1;
        }
        await bucket.combine(sources, state.key);
        if (level > 0) await deleteObjects(sources);
        await deleteObjects(chunks.map((chunk) => chunk.name));
      }
      let etag: string | undefined;
      try {
        const [meta] = await bucket.file(state.key).getMetadata();
        etag = meta.etag;
      } catch { /* etag is optional; completion already published */ }
      await saveState({ ...state, isComplete: true, etag }, id);
      return { etag };
    },

    async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
      abortOpts?.signal?.throwIfAborted();
      let token: GcsUploadToken;
      try {
        token = decodeGcsUploadToken(uploadToken);
      } catch {
        return; // idempotent: a token that never named a resource has nothing to discard
      }
      let raw: Uint8Array;
      try {
        [raw] = await bucket.file(infoName(token.id)).download();
      } catch (err) {
        if (isGcsNotFound(err)) return; // already aborted/swept
        throw err;
      }
      const state = decodeGcsPersistedUpload(raw);
      // A token whose key disagrees with the recorded one is forged: it is
      // not this resource's handle, so it may discard NOTHING (state reads
      // answer 404 for it; deleting here would let a tampered token destroy
      // a live upload's bookkeeping).
      if (state && state.key !== token.key) return;
      if (state?.isComplete) {
        // The published object is live data now; only the bookkeeping goes.
        await bucket.file(infoName(token.id)).delete({ ignoreNotFound: true });
        return;
      }
      await deleteUploadArtifacts(token.id);
    },

    async sweepExpired(olderThanMs: number, sweepOpts?: { signal?: AbortSignal }): Promise<{ removed: number }> {
      const [entries] = await bucket.getFiles({ prefix: `${prefix}/` });
      let removed = 0;
      for (const entry of entries) {
        sweepOpts?.signal?.throwIfAborted();
        if (!entry.name.endsWith(".info")) continue;
        const id = entry.name.slice(`${prefix}/`.length, -".info".length);
        if (!GCS_UPLOAD_ID_RE.test(id)) continue; // foreign object: not ours to reap
        let state: GcsPersistedUpload | null = null;
        try {
          const [raw] = await bucket.file(entry.name).download();
          state = decodeGcsPersistedUpload(raw);
        } catch (err) {
          if (!isGcsNotFound(err)) throw err;
          continue; // raced another sweeper/abort; nothing left to remove
        }
        // Corrupt bookkeeping is already unusable (state reads answer 404),
        // so it is swept regardless of age.
        if (state) {
          const idleSince = state.lastAppendAt ?? state.createdAt;
          if (idleSince >= olderThanMs) continue;
          if (state.isComplete) {
            // Never touch the published object; only the bookkeeping goes.
            await bucket.file(entry.name).delete({ ignoreNotFound: true });
            removed += 1;
            continue;
          }
        }
        await deleteUploadArtifacts(id);
        removed += 1;
      }
      return { removed };
    },
  };
}
