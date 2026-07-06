/**
 * Local filesystem ObjectStore adapter for partial-content.
 *
 * Implements the read-only {@link ObjectStore} interface using Node.js
 * `fs.stat()` and `fs.createReadStream()`. Suitable for:
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

import { open, stat } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import {
  ObjectNotFoundError,
  nodeStreamToWeb,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
} from "./index.js";

// Re-export for convenience (consumers can catch without importing the kernel)
export { ObjectNotFoundError };

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
    // Byte budget: evict least-recent entries until the new body fits.
    const newBytes = stored.bytes ? stored.bytes.byteLength : 0;
    while (newBytes > 0 && cacheBytes + newBytes > cacheMaxBytes && cache.size > 0) {
      evictOldest();
    }
    cache.set(key, { ...stored, expiresAt: Date.now() + cacheTtl });
    cacheBytes += newBytes;
  }

  /**
   * Resolve a key to an absolute path within the root directory.
   * Rejects path traversal attempts that escape the root.
   */
  function safePath(key: string): string {
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
      const base = key.slice(
        Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1,
      );
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) {
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

  return {
    supportsRange: true,

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
      const filePath = safePath(key);

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

      const filePath = safePath(key);

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
          const { bytesRead } = await handle.read(buffer, 0, contentLength, range?.start ?? 0);
          // The handle's own stat promised these bytes; a short read means
          // the file was truncated mid-request. Failing here (502, before
          // headers) beats the streaming path's only option of a torn body.
          if (bytesRead < contentLength) {
            throw new Error(
              `fsStore ${key}: file shrank during read (expected ${contentLength} bytes, got ${bytesRead})`,
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
