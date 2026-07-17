/**
 * Local filesystem ObjectStore and ResumableWriteStore adapters for
 * partial-content.
 *
 * {@link fsStore} implements the read-only {@link ObjectStore} interface
 * using Node.js `fs.stat()` and `fs.createReadStream()`;
 * {@link fsUploadStore} implements the resumable-upload write contract over
 * the same root, publishing completed uploads where an fsStore serves them.
 * Suitable for:
 *   - Development servers
 *   - Small/medium deployments
 *   - Hybrid architectures (local cache + cloud primary)
 *   - Testing and CI pipelines
 *
 * Security: all keys are resolved relative to a fixed root directory.
 * Path traversal attempts (`..`), absolute paths, and null bytes are
 * rejected with ObjectNotFoundError. Symbolic links inside the root ARE
 * followed (matching nginx/caddy defaults); do not place untrusted
 * symlinks under the root if it must be a strict sandbox.
 *
 * @example
 * ```typescript
 * import { fsStore } from "partial-content/fs";
 * import { serveObject } from "partial-content/web";
 *
 * const store = fsStore({ root: "/var/data/uploads" });
 *
 * // Use with the web adapter:
 * const handler = serveObject(store, { disposition: "inline" });
 * ```
 *
 * @packageDocumentation
 */

import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ObjectNotFoundError,
  nodeStreamToWeb,
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

// Re-export for convenience (consumers can catch without importing the kernel)
export { ObjectNotFoundError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDigestMismatchError };

// ─── Options ────────────────────────────────────────────────────────────────

export interface FsStoreOptions {
  /**
   * Root directory. All keys are resolved relative to this path.
   * Must be an absolute path.
   */
  root: string;
  /**
   * Opt-in hot-object cache (metadata + small bodies), following the
   * nginx `open_file_cache` model: entries revalidate on a TTL rather
   * than a change watcher, so a served representation can lag a
   * filesystem overwrite by up to `ttlMs`. Metadata and bytes are always
   * captured together from one read, so responses are internally
   * coherent (headers always describe the bytes actually sent).
   *
   * Off by default: correctness-first. Enable for hot small files
   * (thumbnails, documents, content-addressed assets -- use a long TTL
   * for immutable keys). Bodies at or below the single-read limit
   * (128 KiB) are cached; larger objects always stream fresh from disk.
   *
   * Memory bound: `maxEntries` caps the entry count and `maxBytes` caps
   * the total cached BODY bytes, so the worst case is
   * `min(maxEntries * 128 KiB, maxBytes)` plus per-entry metadata.
   */
  cache?: {
    /** How long an entry may serve before revalidating against disk. */
    ttlMs: number;
    /**
     * Entry cap, evicted least-recently-used.
     * @default 1024
     */
    maxEntries?: number;
    /**
     * Total byte budget for cached bodies, evicted least-recently-used.
     * Metadata-only entries cost nothing against it. A single body larger
     * than the budget is served normally but cached metadata-only, so an
     * oversized object can never flush the whole cache to still not fit.
     * `0` keeps the cache metadata-only (stat elision without body memory).
     * @default 67108864 (64 MiB)
     */
    maxBytes?: number;
  };
}

/** One coherent snapshot of a small object: metadata + bytes from one read. */
interface CacheEntry {
  expiresAt: number;
  totalSize: number;
  lastModified: string;
  /** Weak validator derived once at stat time (size + mtime). */
  etag: string | undefined;
  /** Present only for objects at or below the single-read limit. */
  bytes?: Buffer;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by the local filesystem.
 *
 * @example
 * ```typescript
 * import { fsStore } from "partial-content/fs";
 *
 * const store = fsStore({ root: "/var/data/uploads" });
 * const meta = await store.headObject("reports/q4.pdf");
 * ```
 */
export function fsStore(opts: FsStoreOptions): ObjectStore {
  const root = resolve(opts.root);
  const cacheTtl = opts.cache?.ttlMs ?? 0;
  const cacheMax = opts.cache?.maxEntries ?? 1024;
  const cacheMaxBytes = opts.cache?.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const cache = cacheTtl > 0 ? new Map<string, CacheEntry>() : null;
  // Total bytes held by cached bodies, maintained by cacheDelete/cacheSet.
  // Metadata-only entries contribute zero.
  let cacheBytes = 0;

  /** Remove an entry, keeping the body byte accounting exact. */
  function cacheDelete(key: string): boolean {
    const prev = cache!.get(key);
    if (prev === undefined) return false;
    cacheBytes -= prev.bytes ? prev.bytes.byteLength : 0;
    cache!.delete(key);
    return true;
  }

  /** Evict the least recently used entry (first in insertion order). */
  function evictOldest(): void {
    const oldest = cache!.keys().next();
    if (!oldest.done) cacheDelete(oldest.value);
  }

  /**
   * Evict the least recently used BODY-carrying entry, or report false when
   * none remains. Only body entries relieve the byte budget: evicting
   * metadata-only entries on the way would free zero bytes while discarding
   * still-valid stat-elision hits (those are bounded by the entry cap, not
   * the byte budget).
   */
  function evictOldestBody(): boolean {
    for (const [key, entry] of cache!) {
      if (entry.bytes) {
        cacheDelete(key);
        return true;
      }
    }
    return false;
  }

  function cacheGet(key: string): CacheEntry | null {
    if (!cache) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      cacheDelete(key);
      return null;
    }
    // LRU touch: Map preserves insertion order; re-insert marks as recent.
    // Same entry out and in, so the byte accounting is untouched.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function cacheSet(key: string, entry: Omit<CacheEntry, "expiresAt">): void {
    if (!cache) return;
    const prev = cache.get(key);
    // Preserve a cached body across a metadata-only write-back: a range GET
    // refreshes metadata but carries no bytes, and blindly replacing the
    // entry would evict a still-valid full body (same representation) and
    // force the next full GET back to disk. Keep the bytes when the
    // representation is unchanged (same weak/strong validator); drop them
    // when the etag moved (the file changed -> old bytes are stale).
    const carried = (entry.bytes === undefined && prev?.bytes && prev.etag === entry.etag)
      ? { ...entry, bytes: prev.bytes }
      : entry;
    // A body that alone exceeds the byte budget can never fit: store the
    // entry metadata-only rather than evicting every other body and still
    // failing. The object itself is unaffected (this GET already served it).
    const stored = carried.bytes && carried.bytes.byteLength > cacheMaxBytes
      ? { totalSize: carried.totalSize, lastModified: carried.lastModified, etag: carried.etag }
      : carried;
    // Delete-before-set: Map.set on an existing key keeps its old insertion
    // order, so a refresh must re-insert to reach the most-recent LRU slot.
    // It also makes eviction conditional on genuinely growing the map --
    // refreshing a hot key at capacity must not evict an unrelated entry.
    const existed = cacheDelete(key);
    if (!existed && cache.size >= cacheMax) {
      evictOldest();
    }
    // Byte budget: evict least-recent BODY entries until the new body fits.
    const newBytes = stored.bytes ? stored.bytes.byteLength : 0;
    while (newBytes > 0 && cacheBytes + newBytes > cacheMaxBytes && evictOldestBody()) {
      // evictOldestBody() did the work; the guard re-checks the budget.
    }
    cache.set(key, { ...stored, expiresAt: Date.now() + cacheTtl });
    cacheBytes += newBytes;
  }

  return {
    supportsRange: true,
    // Ranged reads qualify as authoritative: getObject opens ONCE and stats,
    // clamps, and reads from that same handle (an inode pin, so bounds,
    // validators, and bytes are mutually coherent by construction), and a
    // start beyond EOF is rejected natively. The framework adapter can
    // therefore serve a plain range in a single round-trip with no
    // validating HEAD; its Path A fallback turns the native rejection into
    // a correct 416.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      const cached = cacheGet(key);
      if (cached) {
        return {
          contentLength: cached.totalSize,
          lastModified: cached.lastModified,
          etag: cached.etag,
        };
      }
      const filePath = safeResolve(root, key);

      let stats;
      try {
        stats = await stat(filePath, { bigint: true });
      } catch (err) {
        if (isFileNotFound(err)) throw new ObjectNotFoundError(key, err);
        throw err;
      }

      if (!stats.isFile()) {
        throw new ObjectNotFoundError(key);
      }

      const meta = {
        totalSize: Number(stats.size),
        lastModified: stats.mtime.toUTCString(),
        // Derive the weak validator once per stat instead of letting the
        // orchestrator re-parse the Last-Modified string on every request
        // (Date.parse on the serve hot path is measurable at 10k req/s).
        etag: weakFsETag(stats.size, stats.mtimeNs),
      };
      cacheSet(key, meta);
      return {
        contentLength: meta.totalSize,
        lastModified: meta.lastModified,
        etag: meta.etag,
      };
    },

    async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal }): Promise<ObjectStream> {
      const { range, signal } = opts ?? {};
      signal?.throwIfAborted();

      // Hot path: a cached small body serves ranges and full reads as
      // zero-copy subarray views -- no syscalls at all. Metadata-only
      // entries (from headObject) cannot serve bytes and fall through.
      const cached = cacheGet(key);
      if (cached?.bytes) {
        if (range && range.start >= cached.totalSize) {
          // Unsatisfiable ranges are the orchestrator's job to reject
          // (parseRangeHeader 416s them first); a direct caller gets a loud
          // error instead of an empty body with lying bounds.
          throw new RangeError(
            `fsStore ${key}: range start ${range.start} is beyond object size ${cached.totalSize}`,
          );
        }
        // Clamp so ObjectStream.range always reports the bounds actually
        // served, even for a direct caller passing an unclamped range.
        const bytes = range
          ? cached.bytes.subarray(range.start, Math.min(range.end + 1, cached.totalSize))
          : cached.bytes;
        return {
          // Node fs read buffers are ArrayBuffer-backed; narrow so the body is
          // `new Response(...)`-assignable under DOM lib (F5).
          body: bytes as Uint8Array<ArrayBuffer>,
          contentLength: bytes.length,
          totalSize: cached.totalSize,
          range: range ? { start: range.start, end: range.start + bytes.length - 1 } : undefined,
          lastModified: cached.lastModified,
          etag: cached.etag,
        };
      }

      const filePath = safeResolve(root, key);

      // Open once and both stat and stream from the same file handle. A
      // stat-then-reopen sequence races against file replacement: the stream
      // could read a different (shorter) file than the one measured, producing
      // a Content-Length that doesn't match the bytes sent.
      let handle;
      try {
        handle = await open(filePath, "r");
      } catch (err) {
        if (isFileNotFound(err)) throw new ObjectNotFoundError(key, err);
        throw err;
      }

      let stats;
      try {
        stats = await handle.stat({ bigint: true });
        if (!stats.isFile()) throw new ObjectNotFoundError(key);
      } catch (err) {
        await handle.close().catch(() => {
          // Best-effort close; the stat/isFile error is the one that matters
        });
        throw err;
      }

      const totalSize = Number(stats.size);
      const lastModified = stats.mtime.toUTCString();
      const etag = weakFsETag(stats.size, stats.mtimeNs);

      if (range && range.start >= totalSize) {
        await handle.close().catch(() => {
          // Best-effort close; the range error is the one that matters
        });
        throw new RangeError(
          `fsStore ${key}: range start ${range.start} is beyond object size ${totalSize}`,
        );
      }
      // Clamp the end so served bounds always reflect the file's actual
      // size (the orchestrator pre-clamps; direct callers may not).
      const end = range ? Math.min(range.end, totalSize - 1) : totalSize - 1;
      const contentLength = range ? end - range.start + 1 : totalSize;

      // Small transfers: one exact-length positional read, close, and a
      // single-chunk stream. Skips the ReadStream + async-iterator bridge
      // machinery entirely, which dominates per-request cost for small
      // files (the memory bound is SMALL_READ_LIMIT per in-flight request).
      if (contentLength <= SMALL_READ_LIMIT) {
        // Cache-destined buffers are allocated off-pool: for small sizes
        // allocUnsafe returns a view into Node's shared 8 KiB slab, and a
        // long-lived cache entry would pin the whole slab and expose
        // adjacent slab bytes to any consumer that reads `.buffer` without
        // honoring byteOffset. Only full-object reads populate bytes: a
        // range slice is not the whole body, and mixing partial bytes into
        // the cache would serve wrong content for other ranges.
        const willCache = cache !== null && !range && contentLength === totalSize;
        const buffer = willCache
          ? Buffer.allocUnsafeSlow(contentLength)
          : Buffer.allocUnsafe(contentLength);
        try {
          // Loop until filled: POSIX permits a read() to return fewer bytes
          // than requested even before EOF (network filesystems, signals),
          // so a single call would misreport a legitimate short read as
          // truncation. Only bytesRead === 0 is a true EOF.
          let filled = 0;
          while (filled < contentLength) {
            const { bytesRead } = await handle.read(
              buffer, filled, contentLength - filled, (range?.start ?? 0) + filled,
            );
            if (bytesRead === 0) break; // EOF before the promised length
            filled += bytesRead;
          }
          // The handle's own stat promised these bytes; EOF short of them
          // means the file was truncated mid-request. Failing here (502,
          // before headers) beats the streaming path's only option of a
          // torn body.
          if (filled < contentLength) {
            throw new Error(
              `fsStore ${key}: file shrank during read (expected ${contentLength} bytes, got ${filled})`,
            );
          }
        } finally {
          await handle.close().catch(() => {
            // Best-effort close; the bytes (or the read error) already decide the outcome
          });
        }
        if (willCache) {
          cacheSet(key, { totalSize, lastModified, etag, bytes: buffer });
        } else {
          // Metadata write-back: every disk read refreshes the entry so
          // HEAD/conditional traffic converges on the representation this
          // GET actually served instead of a stale headObject snapshot.
          cacheSet(key, { totalSize, lastModified, etag });
        }
        return {
          body: buffer,
          contentLength,
          totalSize,
          range: range ? { start: range.start, end } : undefined,
          lastModified,
          etag,
        };
      }

      // autoClose (default true) closes the handle when the stream ends or
      // is destroyed, covering completion, cancel, and abort paths.
      const nodeStream = handle.createReadStream(
        range ? { start: range.start, end } : {},
      );

      // expectedBytes mirrors the small-read path's short-read guard onto the
      // streaming path: an in-place truncation mid-serve ends the ReadStream
      // early, and without this the body would under-run the committed
      // Content-Length silently. The atomic write-temp+rename overwrite pattern
      // does not trip it (the open handle keeps reading the original inode).
      const webStream = nodeStreamToWeb(nodeStream, { signal, expectedBytes: contentLength });

      // Metadata write-back (bytes stay uncached above the single-read
      // limit): keeps HEAD/conditional responses coherent with the
      // representation this GET is serving.
      cacheSet(key, { totalSize, lastModified, etag });

      return {
        body: webStream,
        contentLength,
        totalSize,
        range: range ? { start: range.start, end } : undefined,
        lastModified,
        etag,
      };
    },
  };
}

// ─── Resumable Uploads: Options ─────────────────────────────────────────────

/** Reserved workspace for in-flight upload bytes and their sidecars. */
const UPLOADS_DIR = ".uploads";

export interface FsUploadStoreOptions {
  /**
   * Root directory completed objects are published under (point an
   * {@link fsStore} at the same root to serve them). In-flight bytes live in
   * a reserved `.uploads/` subdirectory inside it; publish keys are barred
   * from that subtree, and upload tokens are the only handles into it.
   */
  root: string;
}

/**
 * Creation-time facts plus terminal flags, persisted next to the data file.
 * Deliberately NO offset: the offset is always derived from a stat of the
 * fsynced data file, because a stored counter and the bytes it describes
 * cannot be written atomically, and their drift after a crash is exactly
 * the corruption class resumable uploads exist to prevent.
 */
interface UploadSidecar {
  key: string;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  isComplete: boolean;
  isInvalidated: boolean;
  /** Recorded at completion: the data file has been renamed away by then. */
  completedSize?: number;
  digest?: string;
  etag?: string;
}

// ─── Resumable Uploads: Factory ─────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by the local filesystem.
 *
 * Layout: `<root>/.uploads/<token>` holds the in-flight bytes and
 * `<root>/.uploads/<token>.json` the sidecar facts. Completion verifies any
 * asserted SHA-256 by streaming the assembled file, then publishes with a
 * same-volume `rename()` onto the final key: the all-or-nothing primitive,
 * so a failed or crashed completion never leaves a torn object visible.
 *
 * Durability: the data file is fsynced before an append returns, so the
 * offset a later `getUploadState` derives from stat is crash-durable
 * (claiming `exactOffsetRecovery` without that fsync would be a lie). The
 * sidecar is fsynced at create, complete, and invalidate; the advisory
 * `lastAppendAt` refresh is not (losing it only ages the resource toward
 * the sweep slightly early).
 *
 * @example
 * ```typescript
 * import { fsStore, fsUploadStore } from "partial-content/fs";
 *
 * const writes = fsUploadStore({ root: "/var/data/files" });
 * const reads = fsStore({ root: "/var/data/files" }); // serves completions
 * ```
 */
export function fsUploadStore(opts: FsUploadStoreOptions): ResumableWriteStore {
  const root = resolve(opts.root);
  const uploadsDir = join(root, UPLOADS_DIR);

  /**
   * Token -> workspace paths, or null for a token this store cannot have
   * issued. The charset gate doubles as the traversal defense for
   * token-derived paths: no separators, no dots, no null bytes.
   */
  function tokenPaths(uploadToken: string): { data: string; sidecar: string } | null {
    if (!/^[0-9a-f-]+$/.test(uploadToken)) return null;
    return {
      data: join(uploadsDir, uploadToken),
      sidecar: join(uploadsDir, `${uploadToken}.json`),
    };
  }

  function requireTokenPaths(uploadToken: string): { data: string; sidecar: string } {
    const paths = tokenPaths(uploadToken);
    if (!paths) throw new UploadNotFoundError(uploadToken);
    return paths;
  }

  return {
    exactOffsetRecovery: true,
    atomicCompletion: true,
    digestOnComplete: "sha256",

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      createOpts.signal?.throwIfAborted();
      // Reject hostile keys at the door: nothing is allocated for a key
      // that could never publish.
      resolveFinalKeyPath(root, createOpts.key);
      const uploadToken = randomUUID();
      const paths = requireTokenPaths(uploadToken);
      await mkdir(uploadsDir, { recursive: true });
      // "wx": a token collision must fail loudly, never adopt foreign bytes.
      const handle = await open(paths.data, "wx");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await writeSidecar(paths.sidecar, {
        key: createOpts.key,
        length: createOpts.length,
        metadata: createOpts.metadata,
        createdAt: createOpts.now,
        isComplete: false,
        isInvalidated: false,
      }, true);
      return { uploadToken };
    },

    async getUploadState(
      uploadToken: string,
      stateOpts?: { signal?: AbortSignal },
    ): Promise<StoredUploadState> {
      stateOpts?.signal?.throwIfAborted();
      const paths = requireTokenPaths(uploadToken);
      const sidecar = await readSidecar(paths.sidecar, uploadToken);
      const facts = {
        length: sidecar.length,
        createdAt: sidecar.createdAt,
        lastAppendAt: sidecar.lastAppendAt,
        metadata: sidecar.metadata,
      };
      if (sidecar.isComplete) {
        return { ...facts, offset: sidecar.completedSize ?? 0, isComplete: true, isInvalidated: false };
      }
      let size: number;
      try {
        // Backend-derived offset: a stat of the data file appendChunk fsyncs
        // before acking, never a stored counter.
        size = (await stat(paths.data)).size;
      } catch (err) {
        if (!isFileNotFound(err)) throw err;
        // Data file lost under a live sidecar: the bytes are gone, which is
        // the terminal dead state, not a not-found (the resource existed).
        return { ...facts, offset: 0, isComplete: false, isInvalidated: true };
      }
      return { ...facts, offset: size, isComplete: false, isInvalidated: sidecar.isInvalidated };
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      appendOpts.signal?.throwIfAborted();
      const paths = requireTokenPaths(uploadToken);
      const sidecar = await readSidecar(paths.sidecar, uploadToken);
      if (sidecar.isComplete) {
        // Published resources refuse appends; the durable offset is final.
        throw new UploadOffsetConflictError(uploadToken, sidecar.completedSize ?? 0);
      }

      let handle: FileHandle;
      try {
        handle = await open(paths.data, "r+");
      } catch (err) {
        // Data file lost under a live sidecar: nothing to append to.
        if (isFileNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
        throw err;
      }
      try {
        const durableOffset = (await handle.stat()).size;
        // Verify the claim against DURABLE truth (defense in depth under the
        // orchestrator's lock), and refuse invalidated resources outright.
        if (sidecar.isInvalidated || offset !== durableOffset) {
          throw new UploadOffsetConflictError(uploadToken, durableOffset);
        }

        // Deferred-length declaration: the first append to carry a length
        // records it in the sidecar so the next getUploadState (which derives
        // length from the sidecar) reports it and it turns immutable. Only ever
        // set once (the orchestrator guarantees it, and the guard makes it
        // safe): a length already recorded is never overwritten. The write
        // below is fsynced when this fires, matching create/complete durability.
        const lengthDeclared = appendOpts.length !== undefined && sidecar.length === undefined;
        if (lengthDeclared) {
          sidecar.length = appendOpts.length;
        }

        let flushed = 0;
        let crossedBound = false;
        /** Write as much of `chunk` as the byte bound allows; false = crossed. */
        const acceptChunk = async (chunk: Uint8Array): Promise<boolean> => {
          const room = appendOpts.maxBytes === undefined
            ? chunk.length
            : Math.min(chunk.length, appendOpts.maxBytes - flushed);
          if (room > 0) {
            await writeFully(handle, chunk.subarray(0, room), durableOffset + flushed);
            flushed += room;
          }
          if (room < chunk.length) {
            crossedBound = true;
            return false;
          }
          return true;
        };

        if (body instanceof Uint8Array) {
          await acceptChunk(body);
        } else {
          const reader = body.getReader();
          try {
            while (appendOpts.signal?.aborted !== true) {
              let next: Awaited<ReturnType<typeof reader.read>>;
              try {
                next = await reader.read();
              } catch {
                // Torn body (the client vanished mid-request): the flushed
                // prefix is the truthful answer; the stream error itself
                // carries no bytes to account.
                break;
              }
              if (next.done) break;
              if (!(await acceptChunk(next.value))) break;
            }
          } finally {
            // Stop the producer on early exit (bound crossed, abort). On an
            // already-errored stream cancel() rejects with that same error,
            // which the loop above already accounted for.
            void reader.cancel().catch(() => {});
          }
        }

        // Durability BEFORE the offset becomes reportable: exactOffsetRecovery
        // is only honest if a post-crash stat can never see bytes this call
        // acked but never flushed.
        await handle.sync();

        sidecar.lastAppendAt = appendOpts.now;
        if (crossedBound) {
          // Bytes tried to land past the engine's bound: terminal fault,
          // recorded durably so every later interaction refuses.
          sidecar.isInvalidated = true;
          await writeSidecar(paths.sidecar, sidecar, true);
        } else {
          // A newly declared length is a creation fact: fsync it so a crash
          // after the ack cannot lose it (an un-synced length would strand the
          // upload just as its absence did).
          await writeSidecar(paths.sidecar, sidecar, lengthDeclared);
        }
        return { bytesWritten: flushed };
      } finally {
        await handle.close().catch(() => {
          // Best-effort close; the append outcome is already decided
        });
      }
    },

    async completeUpload(
      uploadToken: string,
      completeOpts: CompleteUploadOptions,
    ): Promise<CompletedUpload> {
      completeOpts.signal?.throwIfAborted();
      const paths = requireTokenPaths(uploadToken);
      const sidecar = await readSidecar(paths.sidecar, uploadToken);
      // Idempotent retry: already published; answer the recorded facts.
      if (sidecar.isComplete) return { etag: sidecar.etag, digest: sidecar.digest };
      if (sidecar.isInvalidated) {
        throw new Error(
          `fsUploadStore ${uploadToken}: cannot complete an invalidated upload`,
        );
      }
      // Re-validate the key at publish time: the sidecar sat on disk between
      // create and complete, and a tampered key must not become a traversal.
      const finalPath = resolveFinalKeyPath(root, sidecar.key);

      const digest = await sha256FileBase64(paths.data, uploadToken);
      if (completeOpts.expectedDigest !== undefined && digest !== completeOpts.expectedDigest) {
        // Atomic completion: a failed verification publishes NOTHING; the
        // orchestrator aborts the resource.
        throw new UploadDigestMismatchError(uploadToken, completeOpts.expectedDigest, digest);
      }

      await mkdir(dirname(finalPath), { recursive: true });
      // Every append fsynced its bytes already; rename is the atomic publish.
      await rename(paths.data, finalPath);

      const stats = await stat(finalPath, { bigint: true });
      // The same validator the read side derives, so an fsStore over this
      // root serves the published object under THIS etag.
      const etag = weakFsETag(stats.size, stats.mtimeNs);
      sidecar.isComplete = true;
      sidecar.completedSize = Number(stats.size);
      sidecar.digest = digest;
      sidecar.etag = etag;
      await writeSidecar(paths.sidecar, sidecar, true);
      return { etag, digest };
    },

    async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
      abortOpts?.signal?.throwIfAborted();
      const paths = tokenPaths(uploadToken);
      // Idempotent: a token this store never issued has nothing to discard.
      if (!paths) return;
      await rm(paths.data, { force: true });
      await rm(paths.sidecar, { force: true });
    },

    async sweepExpired(
      olderThanMs: number,
      sweepOpts?: { signal?: AbortSignal },
    ): Promise<{ removed: number }> {
      sweepOpts?.signal?.throwIfAborted();
      let names: string[];
      try {
        names = await readdir(uploadsDir);
      } catch (err) {
        // No uploads workspace yet: nothing was ever created here.
        if (isFileNotFound(err)) return { removed: 0 };
        throw err;
      }
      let removed = 0;
      const sidecarNames = new Set(names.filter((name) => name.endsWith(".json")));
      for (const name of sidecarNames) {
        const sidecarPath = join(uploadsDir, name);
        let idleSince: number;
        try {
          const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as UploadSidecar;
          idleSince = sidecar.lastAppendAt ?? sidecar.createdAt;
        } catch {
          // Unreadable or torn sidecar: age it by mtime, so a crash artifact
          // is still reaped once idle but a sidecar mid-write is not raced.
          try {
            idleSince = (await stat(sidecarPath)).mtimeMs;
          } catch {
            continue; // vanished mid-scan (concurrent abort): nothing to reap
          }
        }
        if (idleSince >= olderThanMs) continue;
        await rm(join(uploadsDir, name.slice(0, -".json".length)), { force: true });
        await rm(sidecarPath, { force: true });
        removed++;
      }
      // Orphaned data files (a crash between data-file creation and sidecar
      // write): without this pass they would leak forever, exactly the
      // storage-limitation failure this hook exists to prevent. The mtime
      // guard keeps a mid-creation file out of reach.
      for (const name of names) {
        if (name.endsWith(".json") || sidecarNames.has(`${name}.json`)) continue;
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(join(uploadsDir, name))).mtimeMs;
        } catch {
          continue; // vanished mid-scan (concurrent abort): nothing to reap
        }
        if (mtimeMs >= olderThanMs) continue;
        await rm(join(uploadsDir, name), { force: true });
        removed++;
      }
      return { removed };
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Transfers at or below this size are served by a single positional read
 * instead of a ReadStream. 128 KiB covers typical documents, thumbnails,
 * and range chunks while bounding per-request buffering.
 */
const SMALL_READ_LIMIT = 128 * 1024;

/**
 * Default total byte budget for cached bodies (64 MiB). Together with the
 * entry cap this bounds the cache's worst-case footprint explicitly, instead
 * of leaving it implied by `maxEntries * SMALL_READ_LIMIT`.
 */
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Resolve a key to an absolute path within the root directory.
 * Rejects path traversal attempts that escape the root.
 */
function safeResolve(root: string, key: string): string {
  // Null bytes are invalid in every filesystem and are a classic probe for
  // C-string truncation bugs in lower layers. Treat as "no such object"
  // rather than letting fs throw ERR_INVALID_ARG_VALUE (which would map
  // to a misleading 502 upstream).
  if (key.includes("\0")) {
    throw new ObjectNotFoundError(key);
  }

  // Windows-only hardening (sep === "\\"). ':' is illegal in a normal
  // Windows filename -- it only appears in a drive designator ("D:\x")
  // or an NTFS alternate-data-stream name ("secret.txt::$DATA"). Rejecting
  // it early stops a cross-volume escape (resolve() would turn "D:\x" into
  // an absolute path on another drive) and hidden-stream access. Reserved
  // device names (NUL, CON, COM1...) map to hardware from ANY directory,
  // so open() on them never touches a file under the root.
  if (sep === "\\") {
    if (key.includes(":")) {
      throw new ObjectNotFoundError(key);
    }
    // Win32 path normalization strips trailing dots and spaces before
    // resolving names, so "CON ", "con." and "con . ." all reach the
    // device; strip them the same way before testing. COM/LPT also
    // reserve the superscript digits U+00B9/U+00B2/U+00B3 ("COM¹").
    const base = key.slice(
      Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1,
    ).replace(/[. ]+$/, "");
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(base)) {
      throw new ObjectNotFoundError(key);
    }
  }

  const resolved = resolve(root, key);
  const rel = relative(root, resolved);

  // rel escapes the root when it climbs out ("..") or is itself absolute.
  // A cross-drive key resolves onto another volume and relative() then
  // returns that absolute path unchanged, which a bare startsWith("..")
  // check would wave through.
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new ObjectNotFoundError(key);
  }

  return resolved;
}

/**
 * Resolve the FINAL publish path for an upload: the read side's traversal
 * defense plus a reservation on the uploads workspace, so a hostile key can
 * never address another upload's partial bytes or a sidecar.
 */
function resolveFinalKeyPath(root: string, key: string): string {
  const resolved = safeResolve(root, key);
  const rel = relative(root, resolved);
  if (rel === UPLOADS_DIR || rel.startsWith(UPLOADS_DIR + sep)) {
    throw new ObjectNotFoundError(key);
  }
  return resolved;
}

async function readSidecar(sidecarPath: string, uploadToken: string): Promise<UploadSidecar> {
  let raw: string;
  try {
    raw = await readFile(sidecarPath, "utf8");
  } catch (err) {
    if (isFileNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
    throw err;
  }
  try {
    return JSON.parse(raw) as UploadSidecar;
  } catch (err) {
    // Torn sidecar (crash mid-write): the bookkeeping is lost and the
    // resource cannot be resumed safely. Gone, with the parse failure as
    // the cause; the sweep reaps the remains by mtime.
    throw new UploadNotFoundError(uploadToken, err);
  }
}

/** Write the sidecar; `durable` fsyncs it (create/complete/invalidate facts). */
async function writeSidecar(sidecarPath: string, sidecar: UploadSidecar, durable: boolean): Promise<void> {
  const handle = await open(sidecarPath, "w");
  try {
    await handle.writeFile(JSON.stringify(sidecar));
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Positional write loop: POSIX permits short writes even without an error. */
async function writeFully(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes, written, bytes.length - written, position + written,
    );
    written += bytesWritten;
  }
}

/** RFC 9530 raw base64 SHA-256, streamed so large uploads stay O(1) memory. */
async function sha256FileBase64(dataPath: string, uploadToken: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(dataPath, "r");
  } catch (err) {
    // Data file lost under a live sidecar: nothing exists to publish.
    if (isFileNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
    throw err;
  }
  const hash = createHash("sha256");
  try {
    // autoClose: false -- the finally below owns the handle either way.
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close().catch(() => {
      // Best-effort close; the hash (or the read error) decides the outcome
    });
  }
  return hash.digest("base64");
}

/**
 * Weak validator from size + NANOSECOND mtime (bigint stat).
 *
 * The kernel's generic formatter floors mtime to whole seconds; on a
 * filesystem store that recreates the classic weak-ETag hazard: two
 * same-length writes within one second are indistinguishable, and a
 * revalidating client gets a false-fresh 304 for changed bytes. Nanosecond
 * resolution closes that window on ext4/APFS/NTFS; filesystems with coarse
 * timestamps (FAT: 2 s) keep a residual window, documented in DESIGN.md.
 */
function weakFsETag(size: bigint, mtimeNs: bigint): string {
  return `W/"${size.toString(16)}-${mtimeNs.toString(16)}"`;
}

function isFileNotFound(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: string }).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
  return false;
}
