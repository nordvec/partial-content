/**
 * In-memory ObjectStore and ResumableWriteStore for partial-content.
 *
 * A complete, spec-faithful read store over a plain object map, plus the
 * matching in-memory write store for resumable uploads. Built for:
 * - **Consumer test suites** -- exercise your serving routes (ranges,
 *   conditionals, pinned-read retries) and upload routes (offset probes,
 *   append/complete flows, digest verification) without a storage backend.
 * - **Demos and examples** -- a working store in three lines.
 * - **Small embedded assets** -- serve a handful of in-process files with
 *   the full 200/206/304 protocol.
 *
 * Faithful to the contract: real Content-Range fabrication, `ifMatch`
 * pinning (mismatch throws {@link ObjectChangedError}, so retry logic is
 * testable), and per-object validators. On the write side, completed
 * uploads publish into the SAME objects map, so an uploaded object is
 * immediately servable by a {@link memoryStore} over that map.
 *
 * @example
 * ```typescript
 * import { memoryStore } from "partial-content/memory";
 * import { serveObject } from "partial-content/web";
 *
 * const store = memoryStore({
 *   objects: {
 *     "hello.txt": { body: "Hello, world!", etag: '"v1"' },
 *   },
 * });
 * const handler = serveObject(store);
 * ```
 *
 * @packageDocumentation
 */

import {
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
  UploadDigestMismatchError,
  type ResumableWriteStore,
  type StoredUploadState,
  type CreateUploadOptions,
  type AppendChunkOptions,
  type CompleteUploadOptions,
  type CompletedUpload,
} from "./upload-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDigestMismatchError };

// ─── Options ────────────────────────────────────────────────────────────────

/** A stored object: body plus optional validators and integrity metadata. */
export interface MemoryObject {
  /** Object content. Strings are encoded as UTF-8. */
  body: Uint8Array | string;
  /** Raw ETag (quoted, like a backend would return). */
  etag?: string;
  /** Last-Modified (any `Date.parse`-able string). */
  lastModified?: string;
  /** RFC 9530 raw base64 SHA-256 digest of the body. */
  digest?: string;
}

export interface MemoryStoreOptions {
  /**
   * Key -> object map. Held BY REFERENCE: mutate it between requests to
   * simulate uploads, overwrites (change `etag` to trigger pinned-read
   * retries), and deletions.
   */
  objects: Record<string, MemoryObject>;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} over an in-memory object map.
 */
export function memoryStore(opts: MemoryStoreOptions): ObjectStore {
  const encoder = new TextEncoder();
  // Cache the UTF-8 encoding of string bodies so a hot-served asset is not
  // re-encoded on every head + get. The map is keyed by the entry and holds
  // the exact string it encoded: the objects map is mutable by reference
  // (the documented way to simulate overwrites), so a changed body misses
  // the cache and re-encodes rather than serving stale bytes.
  const encodeCache = new WeakMap<MemoryObject, { source: string; bytes: Uint8Array }>();

  function lookup(key: string): { entry: MemoryObject; bytes: Uint8Array } {
    // Own-property check: the map is a caller-supplied plain object, so an
    // inherited key ("constructor", "__proto__", "toString") would otherwise
    // return a truthy prototype member and crash downstream as a 502 instead
    // of answering the honest 404.
    const entry = Object.hasOwn(opts.objects, key) ? opts.objects[key] : undefined;
    if (!entry) throw new ObjectNotFoundError(key);
    if (typeof entry.body !== "string") return { entry, bytes: entry.body };
    const cached = encodeCache.get(entry);
    if (cached && cached.source === entry.body) return { entry, bytes: cached.bytes };
    const bytes = encoder.encode(entry.body);
    encodeCache.set(entry, { source: entry.body, bytes });
    return { entry, bytes };
  }

  return {
    supportsRange: true,
    // A single in-memory read is atomic by construction: served bounds are
    // derived from the actual slice, a start beyond EOF is rejected
    // natively, and validators come from the same entry the bytes do. Plain
    // ranges therefore serve in one round-trip with no validating HEAD.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const { entry, bytes } = lookup(key);
      return {
        contentLength: bytes.length,
        etag: entry.etag,
        lastModified: entry.lastModified,
        digest: entry.digest,
      };
    },

    async getObject(
      key: string,
      getOpts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
    ): Promise<ObjectStream> {
      const { range, signal, ifMatch } = getOpts ?? {};
      signal?.throwIfAborted();
      const { entry, bytes } = lookup(key);

      // Pinned read: the object must still match the caller's validator.
      if (ifMatch && entry.etag !== ifMatch) {
        throw new ObjectChangedError(key);
      }

      if (range && range.start >= bytes.length) {
        // Unsatisfiable ranges are the orchestrator's job to reject
        // (parseRangeHeader 416s them first); a direct caller gets a loud
        // error instead of an empty body with lying bounds.
        throw new RangeError(
          `memoryStore ${key}: range start ${range.start} is beyond object size ${bytes.length}`,
        );
      }
      // subarray() clamps to the object size and returns a view (no copy);
      // the served bytes are read-only, so a view is safe. Derive the reported
      // range from the actual slice so ObjectStream.range is the SERVED bounds.
      const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      return {
        // In-memory bytes are ArrayBuffer-backed (TextEncoder output or the
        // caller's view); narrow so the body is `new Response(...)`-assignable
        // under DOM lib (F5).
        body: slice as Uint8Array<ArrayBuffer>,
        contentLength: slice.length,
        totalSize: bytes.length,
        range: range ? { start: range.start, end: range.start + slice.length - 1 } : undefined,
        etag: entry.etag,
        lastModified: entry.lastModified,
        digest: entry.digest,
      };
    },
  };
}

// ─── Resumable Uploads: Options ─────────────────────────────────────────────

export interface MemoryUploadStoreOptions {
  /**
   * Key -> object map completed uploads are PUBLISHED into. Pass the same
   * map a {@link memoryStore} serves and a completed upload becomes readable
   * (ranges, conditionals, Repr-Digest) the moment `completeUpload` returns.
   */
  objects: Record<string, MemoryObject>;
}

/** One in-flight upload resource: accepted bytes plus creation-time facts. */
interface MemoryUploadRecord {
  key: string;
  chunks: Uint8Array[];
  /** Bytes accepted so far: the bookkeeping offsets are derived from. */
  size: number;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  isComplete: boolean;
  isInvalidated: boolean;
  digest?: string;
  etag?: string;
}

// ─── Resumable Uploads: Factory ─────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} over process memory: the write-side
 * counterpart of {@link memoryStore}, for consumer test suites and demos.
 *
 * Faithful to the write contract: offsets derive from the bytes actually
 * held (never a separately persisted counter), a byte bound that the body
 * tries to cross truncates the append and invalidates the resource
 * terminally, completion verifies an asserted SHA-256 (Web Crypto, so any
 * runtime) BEFORE publishing, and publication is atomic: a failed
 * completion leaves the objects map untouched.
 *
 * @example
 * ```typescript
 * import { memoryStore, memoryUploadStore } from "partial-content/memory";
 *
 * const objects = {};
 * const writes = memoryUploadStore({ objects }); // upload target
 * const reads = memoryStore({ objects });        // serves completed uploads
 * ```
 */
export function memoryUploadStore(opts: MemoryUploadStoreOptions): ResumableWriteStore {
  const uploads = new Map<string, MemoryUploadRecord>();

  function lookupUpload(uploadToken: string): MemoryUploadRecord {
    const record = uploads.get(uploadToken);
    if (!record) throw new UploadNotFoundError(uploadToken);
    return record;
  }

  return {
    exactOffsetRecovery: true,
    atomicCompletion: true,
    digestOnComplete: "sha256",

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      createOpts.signal?.throwIfAborted();
      const uploadToken = newUploadToken();
      uploads.set(uploadToken, {
        key: createOpts.key,
        chunks: [],
        size: 0,
        length: createOpts.length,
        metadata: createOpts.metadata,
        createdAt: createOpts.now,
        isComplete: false,
        isInvalidated: false,
      });
      return { uploadToken };
    },

    async getUploadState(
      uploadToken: string,
      stateOpts?: { signal?: AbortSignal },
    ): Promise<StoredUploadState> {
      stateOpts?.signal?.throwIfAborted();
      const record = lookupUpload(uploadToken);
      return {
        offset: record.size,
        length: record.length,
        isComplete: record.isComplete,
        isInvalidated: record.isInvalidated,
        createdAt: record.createdAt,
        lastAppendAt: record.lastAppendAt,
        metadata: record.metadata,
      };
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      appendOpts.signal?.throwIfAborted();
      const record = lookupUpload(uploadToken);
      // Dead or already-published resources refuse every append, and a
      // mismatched claim loses to durable truth. The conflict error is the
      // loud answer (a correct orchestrator re-derives fresh state under its
      // lock and never reaches this branch).
      if (record.isComplete || record.isInvalidated || offset !== record.size) {
        throw new UploadOffsetConflictError(uploadToken, record.size);
      }

      const accepted: Uint8Array[] = [];
      let flushed = 0;
      let crossedBound = false;
      /** Take as much of `chunk` as the byte bound allows; false = crossed. */
      const accept = (chunk: Uint8Array): boolean => {
        const room = appendOpts.maxBytes === undefined
          ? chunk.length
          : Math.min(chunk.length, appendOpts.maxBytes - flushed);
        if (room > 0) {
          // slice(), not subarray(): the store owns its bytes, and a caller
          // reusing its buffer after the call must not rewrite history.
          accepted.push(chunk.slice(0, room));
          flushed += room;
        }
        if (room < chunk.length) {
          crossedBound = true;
          return false;
        }
        return true;
      };

      if (body instanceof Uint8Array) {
        accept(body);
      } else {
        const reader = body.getReader();
        try {
          while (appendOpts.signal?.aborted !== true) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch {
              // Torn body (the client vanished mid-request): the accepted
              // prefix is the truthful answer; the stream error itself
              // carries no bytes to account.
              break;
            }
            if (next.done) break;
            if (!accept(next.value)) break;
          }
        } finally {
          // Stop the producer on early exit (bound crossed, abort). On an
          // already-errored stream cancel() rejects with that same error,
          // which the loop above already accounted for.
          void reader.cancel().catch(() => {});
        }
      }

      for (const chunk of accepted) record.chunks.push(chunk);
      record.size += flushed;
      record.lastAppendAt = appendOpts.now;
      // Bytes tried to land past the engine's bound: the terminal fault the
      // contract reserves invalidation for.
      if (crossedBound) record.isInvalidated = true;
      return { bytesWritten: flushed };
    },

    async completeUpload(
      uploadToken: string,
      completeOpts: CompleteUploadOptions,
    ): Promise<CompletedUpload> {
      completeOpts.signal?.throwIfAborted();
      const record = lookupUpload(uploadToken);
      // Idempotent retry: already published; answer the recorded facts.
      if (record.isComplete) return { etag: record.etag, digest: record.digest };
      if (record.isInvalidated) {
        throw new Error(
          `memoryUploadStore ${uploadToken}: cannot complete an invalidated upload`,
        );
      }

      const bytes = concatChunks(record.chunks, record.size);
      const digest = await sha256Base64(bytes);
      if (completeOpts.expectedDigest !== undefined && digest !== completeOpts.expectedDigest) {
        // Atomic completion: a failed verification publishes NOTHING; the
        // orchestrator aborts the resource.
        throw new UploadDigestMismatchError(uploadToken, completeOpts.expectedDigest, digest);
      }

      const etag = `"${digest}"`;
      // defineProperty, not bracket assignment: the key is caller data on a
      // plain object, and assigning "__proto__" would mutate the prototype
      // instead of publishing an own entry.
      Object.defineProperty(opts.objects, record.key, {
        value: {
          body: bytes,
          etag,
          lastModified: new Date(completeOpts.now).toUTCString(),
          digest,
        } satisfies MemoryObject,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      record.isComplete = true;
      record.digest = digest;
      record.etag = etag;
      record.chunks = []; // the published bytes live in the objects map now
      return { etag, digest };
    },

    async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
      abortOpts?.signal?.throwIfAborted();
      // Idempotent: discarding an unknown or already-discarded resource is a
      // no-op, and a published object outlives its upload resource.
      uploads.delete(uploadToken);
    },

    async sweepExpired(
      olderThanMs: number,
      sweepOpts?: { signal?: AbortSignal },
    ): Promise<{ removed: number }> {
      sweepOpts?.signal?.throwIfAborted();
      let removed = 0;
      for (const [uploadToken, record] of uploads) {
        const idleSince = record.lastAppendAt ?? record.createdAt;
        if (idleSince < olderThanMs) {
          uploads.delete(uploadToken);
          removed++;
        }
      }
      return { removed };
    },
  };
}

// ─── Resumable Uploads: Internal Helpers ────────────────────────────────────

/** Opaque, collision-resistant upload token (UUID where available). */
function newUploadToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Fallback for runtimes without randomUUID: 16 random bytes as hex.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Assemble accepted chunks into one contiguous, ArrayBuffer-backed body. */
function concatChunks(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

/** RFC 9530 raw base64 SHA-256 via Web Crypto (runtime-agnostic). */
async function sha256Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}
