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
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
  type StoreErrorClassifiers,
} from "./index.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

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
}

interface GcsFileMetadata {
  size: string; // GCS returns size as a string
  etag?: string;
  /** Object generation: changes on every overwrite. Used to pin reads. */
  generation?: string | number;
  updated?: string; // ISO 8601
  md5Hash?: string; // base64-encoded MD5
  crc32c?: string;
  metadata?: Record<string, string>;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface GcsStoreOptions {
  /** Pre-configured @google-cloud/storage instance. */
  storage: GcsStorage;
  /** GCS bucket name. */
  bucket: string;
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

  return {
    supportsRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const [metadata] = await classifyStoreRead(key, () => bucket.file(key).getMetadata(), gcsClassifiers);

      return {
        contentLength: parseInt(metadata.size, 10),
        etag: metadata.etag,
        lastModified: metadata.updated
          ? new Date(metadata.updated).toUTCString()
          : undefined,
        // A generation names an immutable object version, so it can carry
        // everything getObject would otherwise re-fetch. No generation
        // (emulators, mocks) means no pin: getObject falls back to its own
        // metadata read.
        pin: metadata.generation !== undefined
          ? encodeGcsPin(metadata)
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

      if (usablePin) {
        generation = usablePin.generation;
        totalSize = usablePin.size;
        etag = usablePin.etag;
        lastModified = usablePin.lastModified;
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
      };
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Shape carried inside the opaque {@link ObjectMetadata.pin} token. */
interface GcsPin {
  generation: string | number;
  size: number;
  etag?: string;
  lastModified?: string;
}

function encodeGcsPin(metadata: GcsFileMetadata): string {
  const pin: GcsPin = {
    generation: metadata.generation!,
    size: parseInt(metadata.size, 10),
    etag: metadata.etag,
    lastModified: metadata.updated
      ? new Date(metadata.updated).toUTCString()
      : undefined,
  };
  return JSON.stringify(pin);
}

/** Decode a pin token; null for foreign/corrupt tokens (fall back to metadata). */
function decodeGcsPin(pin: string): GcsPin | null {
  try {
    const parsed: unknown = JSON.parse(pin);
    if (
      typeof parsed === "object" && parsed !== null &&
      "generation" in parsed && "size" in parsed &&
      typeof (parsed as GcsPin).size === "number" &&
      Number.isFinite((parsed as GcsPin).size) &&
      // `generation` flows straight into bucket.file(key, { generation }) and
      // selects the immutable version served. Only a non-empty string or a
      // finite number is a real generation; anything else (object, array,
      // null) is a corrupt/hostile token that must revalidate from scratch,
      // never index an arbitrary version.
      isValidGeneration((parsed as GcsPin).generation)
    ) {
      return parsed as GcsPin;
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
