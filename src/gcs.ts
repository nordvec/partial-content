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
