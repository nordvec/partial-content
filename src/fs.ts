/**
 * Local filesystem ObjectStore adapter for partial-content.
 *
 * {@link fsStore} implements the read-only {@link ObjectStore} interface over
 * the Node.js `fs` primitives.
 * Suitable for:
 *   - Development servers
 *   - Small/medium deployments
 *   - Hybrid architectures (local cache + cloud primary)
 *   - Testing and CI pipelines
 *
 * Security: all keys are resolved relative to a fixed root directory.
 * Path traversal attempts (`..`), absolute paths, and null bytes are
 * rejected with ObjectNotFoundError. A symbolic link or junction under the
 * root is followed only while its target stays inside the root's real path,
 * unless {@link FsStoreOptions.symlinks} is `"follow"`.
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

import { realpath, stat } from "node:fs/promises";
import {
    close as closeDescriptor,
    constants,
    createReadStream,
    fstat as fstatDescriptor,
    open as openDescriptor,
    read as readDescriptor,
    type BigIntStats,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
    ObjectNotFoundError,
    nodeStreamToWeb,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
    reservedKeyGuard,
} from "./index.ts";
import { withoutTrailing } from "./object-store.ts";
export { ObjectNotFoundError };

// ─── Options ────────────────────────────────────────────────────────────────

export interface FsStoreOptions {
    /**
     * Key prefixes this store refuses to serve, because they are where a
     * partial-content 5.x upload store sharing this location keeps its
     * in-flight bytes and the sidecars naming their destination keys. Keys at
     * or under one answer {@link ObjectNotFoundError}. Set to `""` when no
     * upload store shares the location.
     * @default ".uploads/"
     */
    reservedPrefix?: string | readonly string[];
    /**
     * Root directory. All keys are resolved relative to this path.
     * Must be an absolute path.
     */
    root: string;
    /**
     * What a symbolic link or junction under the root may reach.
     *
     * `"contain"` serves a key only when its real path (every link resolved)
     * is inside the root's real path, and opens it without following a link
     * in the final component where the platform supports that. A link from one
     * place in the root to another serves; one that leaves the root, or that
     * reaches the reserved upload workspace, answers {@link ObjectNotFoundError}.
     * The check and the open are two steps, so a writer that can swap a
     * directory under the root for a link between them is outside what it
     * defends against.
     *
     * `"follow"` resolves links wherever they point: for a root whose layout
     * links to content kept elsewhere on purpose.
     * @default "contain"
     */
    symlinks?: "contain" | "follow";
    /**
     * Opt-in hot-object cache (metadata + small bodies): entries revalidate
     * on a TTL rather than a change watcher, so a served representation can
     * lag a filesystem overwrite by up to `ttlMs`. Metadata and bytes are always
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
     * `min(maxEntries * 128 KiB, maxBytes)` plus per-entry metadata. Each
     * value must be a finite number of at least 0, or construction throws.
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

/** Where a partial-content 5.x upload store kept in-flight bytes and their sidecars. */
const UPLOADS_DIR = ".uploads";
const FS_DEFAULT_UPLOAD_PREFIX = `${UPLOADS_DIR}/`;

/**
 * Whether a Windows volume with 8.3 names enabled generates a short-name alias
 * for this path segment. A segment that already fits 8.3 (up to eight
 * characters, an optional extension of up to three, no spaces, no leading dot
 * and no second dot) is its own short name and has no alias.
 */
function needsShortNameAlias(segment: string): boolean {
    return !/^[^ .]{1,8}(\.[^ .]{1,3})?$/.test(segment);
}

/** Whether a segment is shaped like a generated short name (`UPLOAD~1`). */
function isShortNameAlias(segment: string): boolean {
    return /~\d/.test(segment);
}

/**
 * A check refusing, as not found, a path that leaves `base` or lands at or
 * under the `reserved` prefix.
 *
 * The reservation is tested on the path the key RESOLVES to, never on the
 * key's spelling: `./.uploads/x`, `a/../.uploads/x` and, on Windows,
 * `.uploads\x` all name the workspace while none starts with the prefix.
 *
 * The compare folds case and normalizes on EVERY platform. Case sensitivity
 * and normalization are properties of the VOLUME, not of the runtime: a
 * case-insensitive volume mounted under a POSIX runtime answers `.Uploads/x`
 * with the workspace, and a normalizing one answers a decomposed spelling.
 * Deciding that from `sep` asks the wrong question of the wrong layer. What
 * folding always costs is refusing a key whose path differs from the reserved
 * prefix only by case or normal form, which is a refusal, never a disclosure.
 */
function outsideReserved(reserved: string | readonly string[]): (base: string, path: string, key: string) => void {
    // The key was already resolved to a path and checked against `base`, so the
    // plain-key policy would only refuse real file names (`%2e`, `report\`) that
    // are ordinary characters on a POSIX volume.
    const guardRel = reservedKeyGuard(reserved, { keys: "verbatim", foldCase: true });
    // A name that does not itself fit 8.3 also answers to a generated short name
    // on a Windows volume with them enabled (`.uploads` -> `UPLOAD~1`), which
    // opens the same directory under a spelling no folding relates to the
    // prefix. The alias is not derivable, since its suffix depends on what else
    // existed when the directory was created, so what is refused is the alias
    // SHAPE, and only within the prefix's own depth.
    // The depth is that of the deepest prefix with such a segment.
    const aliasDepth =
        sep === "\\"
            ? Math.max(
                  0,
                  ...(typeof reserved === "string" ? [reserved] : reserved).map((prefix) => {
                      const segments = prefix.split("/").filter((segment) => segment !== "");
                      return segments.some(needsShortNameAlias) ? segments.length : 0;
                  }),
              )
            : 0;
    return (base, path, key) => {
        const native = relative(base, path);
        const rel = native.split(sep).join("/");
        if (escapes(native) || (aliasDepth > 0 && rel.split("/").slice(0, aliasDepth).some(isShortNameAlias))) {
            throw new ObjectNotFoundError(key);
        }
        try {
            guardRel(rel);
        } catch {
            throw new ObjectNotFoundError(key);
        }
    };
}

/**
 * A relative root resolves against `process.cwd()`, which is the shell's
 * directory in development and the service manager's in production, so the
 * same configuration points at two different places. Refuse it where the
 * mistake is made rather than serving an empty directory later.
 */
function assertAbsoluteRoot(factory: string, root: unknown): void {
    if (typeof root !== "string" || !isAbsolute(root)) {
        throw new TypeError(
            `${factory}: options.root must be an absolute path, not relative to process.cwd(), got ${JSON.stringify(root)}`,
        );
    }
}

/**
 * Route every async method of a store through {@link redactErrnoPaths}, so no
 * public call rejects with a path whatever its throw site did. Body streams
 * read through a descriptor, whose errors name no path.
 */
function withErrnoPathsRedacted<T extends object>(store: T): T {
    for (const [name, value] of Object.entries(store)) {
        if (typeof value !== "function") continue;
        const method = value as (...args: unknown[]) => Promise<unknown>;
        Object.assign(store, {
            [name]: (...args: unknown[]) =>
                method.apply(store, args).catch((err: unknown) => {
                    throw redactErrnoPaths(err);
                }),
        });
    }
    return store;
}

/** A cache bound that is NaN, infinite or negative would disable the bound it names. */
function assertCacheOptions(cache: FsStoreOptions["cache"]): void {
    for (const name of ["ttlMs", "maxEntries", "maxBytes"] as const) {
        const value = cache?.[name];
        // NaN fails both comparisons, so it is refused with the rest.
        if (value !== undefined && !(value >= 0 && value < Infinity)) {
            throw new TypeError(`fsStore: options.cache.${name} must be a finite number at least 0, got ${value}`);
        }
    }
}

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
    assertAbsoluteRoot("fsStore", opts?.root);
    const root = resolve(opts.root);
    const assertReadable = outsideReserved(opts.reservedPrefix ?? FS_DEFAULT_UPLOAD_PREFIX);
    // Anything but an explicit "follow" contains: an unrecognized value fails closed.
    const follow = opts.symlinks === "follow";
    // Bitwise OR reads a constant the platform lacks (both, on Windows) as 0.
    // O_NONBLOCK makes opening a FIFO return at once instead of parking a
    // threadpool thread until a writer appears; the fstat then refuses it.
    const openFlags = constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW);
    const realPaths = realPathsOf(root);
    /** The key's real path, refused unless it is inside the real root and readable. */
    const contained = async (key: string, resolved: string): Promise<string> => {
        let real: string;
        let base: string;
        try {
            [base, real] = await realPaths(resolved);
        } catch (err) {
            if (isFileNotFound(err)) throw new ObjectNotFoundError(key, err);
            throw err;
        }
        assertReadable(base, real, key);
        return real;
    };
    assertCacheOptions(opts.cache);
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
        cacheBytes -= prev.bytes?.byteLength ?? 0;
        cache!.delete(key);
        return true;
    }

    /**
     * Evict the least recently used entry (first in insertion order), or with
     * `bodiesOnly` the least recently used BODY-carrying one; false when none
     * remains. Only body entries relieve the byte budget: evicting
     * metadata-only entries on the way would free zero bytes while discarding
     * still-valid stat-elision hits (those are bounded by the entry cap, not
     * the byte budget).
     */
    function evictOldest(bodiesOnly: boolean): boolean {
        for (const [key, entry] of cache!) {
            if (!bodiesOnly || entry.bytes) return cacheDelete(key);
        }
        return false;
    }

    function cacheGet(key: string): CacheEntry | null {
        const entry = cache?.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
            cacheDelete(key);
            return null;
        }
        // LRU touch: Map preserves insertion order; re-insert marks as recent.
        // Same entry out and in, so the byte accounting is untouched.
        cache!.delete(key);
        cache!.set(key, entry);
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
        let bytes = entry.bytes ?? (prev?.etag === entry.etag ? prev?.bytes : undefined);
        // A body that alone exceeds the byte budget can never fit: store the
        // entry metadata-only rather than evicting every other body and still
        // failing. The object itself is unaffected (this GET already served it).
        if (bytes && bytes.byteLength > cacheMaxBytes) bytes = undefined;
        // Delete-before-set: Map.set on an existing key keeps its old insertion
        // order, so a refresh must re-insert to reach the most-recent LRU slot.
        // It also makes eviction conditional on genuinely growing the map --
        // refreshing a hot key at capacity must not evict an unrelated entry.
        if (!cacheDelete(key) && cache.size >= cacheMax) evictOldest(false);
        // Byte budget: evict least-recent BODY entries until the new body fits.
        const newBytes = bytes?.byteLength ?? 0;
        while (newBytes > 0 && cacheBytes + newBytes > cacheMaxBytes && evictOldest(true)) {
            // evictOldest(true) did the work; the guard re-checks the budget.
        }
        cache.set(key, { ...entry, bytes, expiresAt: Date.now() + cacheTtl });
        cacheBytes += newBytes;
    }

    return withErrnoPathsRedacted({
        supportsRange: true,
        // Ranged reads qualify as authoritative: getObject opens ONCE and stats,
        // clamps, and reads from that same descriptor (an inode pin, so bounds,
        // validators, and bytes are mutually coherent by construction), and a
        // start beyond EOF is rejected natively. The framework adapter can
        // therefore serve a plain range in a single round-trip with no
        // validating HEAD; its Path A fallback turns the native rejection into
        // a correct 416.
        authoritativeRange: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            const resolved = safeResolve(root, key);
            assertReadable(root, resolved, key);
            opts?.signal?.throwIfAborted();
            let meta: Omit<CacheEntry, "expiresAt"> | null = cacheGet(key);
            if (!meta) {
                let stats;
                try {
                    stats = await stat(follow ? resolved : await contained(key, resolved), { bigint: true });
                } catch (err) {
                    if (isFileNotFound(err)) throw new ObjectNotFoundError(key, err);
                    // An errno such as EACCES or EIO names the resolved file; the
                    // store boundary (withErrnoPathsRedacted) rewrites it.
                    throw err;
                }

                if (!stats.isFile()) {
                    throw new ObjectNotFoundError(key);
                }
                meta = describeFile(stats);
                cacheSet(key, meta);
            }
            return {
                contentLength: meta.totalSize,
                lastModified: meta.lastModified,
                etag: meta.etag,
            };
        },

        async getObject(key: string, opts?: { range?: ReadRange; signal?: AbortSignal }): Promise<ObjectStream> {
            const resolved = safeResolve(root, key);
            assertReadable(root, resolved, key);
            const { range, signal } = opts ?? {};
            signal?.throwIfAborted();

            // Hot path: a cached small body serves ranges and full reads as
            // zero-copy subarray views -- no syscalls at all. Metadata-only
            // entries (from headObject) cannot serve bytes and fall through.
            const cached = cacheGet(key);
            if (cached?.bytes) {
                const { end, contentLength } = servedBounds(range, cached.totalSize);
                // Node fs read buffers are ArrayBuffer-backed; narrow so the body is
                // `new Response(...)`-assignable under DOM lib.
                const bytes = cached.bytes as Uint8Array<ArrayBuffer>;
                return objectStream(
                    range ? bytes.subarray(range.start, end + 1) : bytes,
                    contentLength,
                    cached,
                    range,
                    end,
                );
            }

            const filePath = follow ? resolved : await contained(key, resolved);

            // Open once and both stat and stream from the same descriptor. A
            // stat-then-reopen sequence races against file replacement: the stream
            // could read a different (shorter) file than the one measured, producing
            // a Content-Length that doesn't match the bytes sent.
            const pinned = await pinnedRead(filePath, openFlags, key, range, cache !== null);
            const { file, end, contentLength } = pinned;

            let body: ObjectStream["body"];
            if (pinned.kind === "bytes") {
                body = pinned.buffer;
            } else {
                // Ownership of the descriptor transfers to the stream the moment it
                // constructs: autoClose (default true) closes it when the stream ends or
                // is destroyed, covering completion, cancel, and abort paths. Nothing
                // else would, so every throw across the handoff has to release whichever
                // owner exists. A raw descriptor has no garbage-collection backstop the
                // way a FileHandle does (see pinnedRead), so one leaked here is leaked
                // for the life of the process, and the terminal state is EMFILE.
                let nodeStream: ReturnType<typeof createReadStream> | undefined;
                try {
                    // An abort that landed while the descriptor was being opened is
                    // answered before ownership transfers to the stream (the catch
                    // closes it). The listener the web adapter attaches fires only on
                    // a signal that aborts AFTER it subscribes, so an already-aborted
                    // one would otherwise leave the caller holding an open descriptor
                    // for a client that is gone.
                    signal?.throwIfAborted();
                    // Both bounds always, range or not: an unbounded ReadStream reads to
                    // EOF, so a file that grows after the fstat overruns the
                    // Content-Length already committed from that fstat. The explicit
                    // start also makes every read positional, so the body never depends
                    // on the descriptor's shared file position.
                    nodeStream = createReadStream(filePath, { fd: pinned.fd, start: range?.start ?? 0, end });

                    // expectedBytes mirrors the small-read path's short-read guard onto the
                    // streaming path: an in-place truncation mid-serve ends the ReadStream
                    // early, and without this the body would under-run the committed
                    // Content-Length silently. The atomic write-temp+rename overwrite pattern
                    // does not trip it (the open descriptor keeps reading the original inode).
                    body = nodeStreamToWeb(nodeStream, { signal, expectedBytes: contentLength });
                } catch (err) {
                    if (nodeStream) nodeStream.destroy();
                    else closeQuietly(pinned.fd);
                    throw err;
                }
            }

            // Metadata write-back: every disk read refreshes the entry so
            // HEAD/conditional traffic converges on the representation this GET
            // actually served instead of a stale headObject snapshot. Only a whole
            // body read in one piece carries its bytes; a streamed one is above the
            // single-read limit and stays uncached.
            cacheSet(key, {
                ...file,
                bytes:
                    pinned.kind === "bytes" && bodyIsCacheable(range, contentLength, file.totalSize)
                        ? pinned.buffer
                        : undefined,
            });
            return objectStream(body, contentLength, file, range, end);
        },
    });
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
 * Whether a body this read produced is the WHOLE object, and therefore
 * cacheable. A range slice is not the body: mixing partial bytes into the
 * cache would serve wrong content for every other range of the same key.
 */
function bodyIsCacheable(range: ReadRange | undefined, contentLength: number, totalSize: number): boolean {
    return range === undefined && contentLength === totalSize;
}

/**
 * Close a raw descriptor without disturbing the outcome already decided.
 *
 * `fs.close` requires a callback and this one is deliberately empty: a failed
 * close has nothing to add to the bytes or the error being returned, while a
 * descriptor left open is unrecoverable for the lifetime of the process.
 */
function closeQuietly(fd: number): void {
    closeDescriptor(fd, () => {
        // Best-effort close; the bytes (or the error) already decide the outcome
    });
}

/** Metadata every response header is derived from, pinned to one descriptor. */
interface PinnedReadMetadata {
    file: FileDescription;
    /** Inclusive end offset actually served, clamped to the file's real size. */
    end: number;
    contentLength: number;
}

/** What one stat says about a file: every response header derives from it. */
interface FileDescription {
    totalSize: number;
    lastModified: string;
    etag: string;
}

function describeFile(stats: BigIntStats): FileDescription {
    return {
        totalSize: Number(stats.size),
        lastModified: stats.mtime.toUTCString(),
        // Derived once per stat instead of letting the orchestrator re-parse the
        // Last-Modified string on every request (Date.parse on the serve hot
        // path is measurable at 10k req/s).
        etag: weakFsETag(stats.size, stats.mtimeNs),
    };
}

/**
 * The bounds a read actually serves. An unsatisfiable range is the
 * orchestrator's to reject (parseRangeHeader 416s it first), so a direct
 * caller gets a loud error instead of an empty body with lying bounds; the end
 * is clamped so the reported range is always the one served.
 */
function servedBounds(range: ReadRange | undefined, totalSize: number): { end: number; contentLength: number } {
    if (!range) return { end: totalSize - 1, contentLength: totalSize };
    if (range.start >= totalSize) {
        throw new RangeError(`fsStore: range start ${range.start} is beyond object size ${totalSize}`);
    }
    const end = Math.min(range.end ?? totalSize - 1, totalSize - 1);
    return { end, contentLength: end - range.start + 1 };
}

function objectStream(
    body: ObjectStream["body"],
    contentLength: number,
    file: { totalSize: number; lastModified: string; etag: string | undefined },
    range: ReadRange | undefined,
    end: number,
): ObjectStream {
    return {
        body,
        contentLength,
        totalSize: file.totalSize,
        range: range ? { start: range.start, end } : undefined,
        lastModified: file.lastModified,
        etag: file.etag,
    };
}

/**
 * The whole transfer as bytes (at or below the single-read limit), or the
 * still-open descriptor a larger body streams from.
 */
type PinnedRead =
    // Node fs read buffers are ArrayBuffer-backed; the narrowing keeps the body
    // `new Response(...)`-assignable under DOM lib, which the widened
    // `ArrayBufferLike` default is not.
    | (PinnedReadMetadata & { kind: "bytes"; buffer: Buffer<ArrayBuffer> })
    | (PinnedReadMetadata & { kind: "descriptor"; fd: number });

/**
 * Open, stat, and for a small transfer read, resolved through ONE promise.
 *
 * The callback API is deliberate. Its promise counterpart awaits open, fstat,
 * read and close separately, and each await costs a promise plus a turn of
 * the microtask queue; on a 4 KB GET that scheduling is a large fraction of
 * the per-request cost. Here the sequence runs as one continuation chain and
 * settles once.
 *
 * The price is that the descriptor is raw. A `FileHandle` carries a garbage
 * collection backstop; a number carries none, and a throw inside an fs
 * callback surfaces on the threadpool's callback rather than unwinding into
 * an enclosing `finally`. So every callback body below is wrapped, and every
 * exit closes the descriptor except the streaming one, which transfers
 * ownership to the caller's ReadStream.
 */
function pinnedRead(
    filePath: string,
    flags: number,
    key: string,
    range: ReadRange | undefined,
    cacheBodies: boolean,
): Promise<PinnedRead> {
    return new Promise<PinnedRead>((resolve, reject) => {
        openDescriptor(filePath, flags, (openErr, fd) => {
            if (openErr) {
                reject(isFileNotFound(openErr) ? new ObjectNotFoundError(key, openErr) : openErr);
                return;
            }
            /** Every failure past the open: the descriptor exists and is ours. */
            const fail = (cause: unknown): void => {
                closeQuietly(fd);
                reject(cause);
            };
            try {
                // fstat, never stat(filePath): the descriptor pins the inode, so size,
                // mtime and bytes all describe one file even when the directory entry
                // is replaced mid-request. A path stat would let a Content-Length
                // describe a file the body never came from.
                fstatDescriptor(fd, { bigint: true }, (statErr, stats) => {
                    try {
                        if (statErr) {
                            fail(statErr);
                            return;
                        }
                        if (!stats.isFile()) {
                            fail(new ObjectNotFoundError(key));
                            return;
                        }
                        const file = describeFile(stats);
                        // Throws for an unsatisfiable range; the catch below fails it.
                        const { end, contentLength } = servedBounds(range, file.totalSize);
                        const metadata: PinnedReadMetadata = { file, end, contentLength };

                        // Large transfers keep the descriptor and stream from it.
                        if (contentLength > SMALL_READ_LIMIT) {
                            resolve({ ...metadata, kind: "descriptor", fd });
                            return;
                        }

                        // Small transfers: one exact-length positional read, close, and a
                        // single-chunk body. Skips the ReadStream + async-iterator bridge
                        // machinery entirely, which dominates per-request cost for small
                        // files (the memory bound is SMALL_READ_LIMIT per in-flight
                        // request).
                        //
                        // Cache-destined buffers are allocated off-pool: for small sizes
                        // allocUnsafe returns a view into Node's shared 8 KiB slab, and a
                        // long-lived cache entry would pin the whole slab and expose
                        // adjacent slab bytes to any consumer that reads `.buffer`
                        // without honoring byteOffset.
                        const buffer =
                            cacheBodies && bodyIsCacheable(range, contentLength, file.totalSize)
                                ? Buffer.allocUnsafeSlow(contentLength)
                                : Buffer.allocUnsafe(contentLength);
                        const position = range?.start ?? 0;

                        const finish = (): void => {
                            closeQuietly(fd);
                            resolve({ ...metadata, kind: "bytes", buffer });
                        };
                        /**
                         * Read until filled: POSIX permits a read() to return fewer bytes
                         * than requested even before EOF (network filesystems, signals),
                         * so a single call would misreport a legitimate short read as
                         * truncation. Only bytesRead === 0 is a true EOF.
                         */
                        const readFrom = (filled: number): void => {
                            if (filled >= contentLength) {
                                finish();
                                return;
                            }
                            readDescriptor(
                                fd,
                                buffer,
                                filled,
                                contentLength - filled,
                                position + filled,
                                (readErr, bytesRead) => {
                                    try {
                                        if (readErr) {
                                            fail(readErr);
                                            return;
                                        }
                                        if (bytesRead === 0) {
                                            // The descriptor's own fstat promised these bytes; EOF
                                            // short of them means the file was truncated
                                            // mid-request. Failing here (502, before headers) beats
                                            // the streaming path's only option of a torn body.
                                            fail(
                                                new Error(
                                                    `fsStore: file shrank during read ` +
                                                        `(expected ${contentLength} bytes, got ${filled})`,
                                                ),
                                            );
                                            return;
                                        }
                                        readFrom(filled + bytesRead);
                                    } catch (err) {
                                        fail(err);
                                    }
                                },
                            );
                        };
                        readFrom(0);
                    } catch (err) {
                        fail(err);
                    }
                });
            } catch (err) {
                fail(err);
            }
        });
    });
}

/**
 * `[root's real path, path's real path]`, every link resolved. The root's is
 * memoized once it resolves; a root that does not exist yet is asked again on
 * the next call.
 */
function realPathsOf(root: string): (path: string) => Promise<[string, string]> {
    let base: string | undefined;
    return async (path) => [(base ??= await realpath(root)), await realpath(path)];
}

// ─── Key resolution, validators and errno handling ──────────────────────────

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
        const base = withoutTrailing(key.slice(Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1), ". ");
        if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(base)) {
            throw new ObjectNotFoundError(key);
        }
    }

    const resolved = resolve(root, key);
    if (escapes(relative(root, resolved))) {
        throw new ObjectNotFoundError(key);
    }

    return resolved;
}

/**
 * Whether a path relative to a base leaves it: it climbs out (`..`), or it is
 * itself absolute, which is what relative() returns for a path on another
 * volume and what a bare startsWith("..") check would wave through.
 */
function escapes(rel: string): boolean {
    return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
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

const ERRNO_PATH_REPLACEMENT = "<path>";

/**
 * Rewrite every filesystem path an errno error names, in its message, stack,
 * `path` and anywhere along its cause chain, to a fixed placeholder.
 *
 * A resolved path carries the object key (a user's filename), and an errno
 * such as EACCES, EISDIR or EIO would hand it to every caller that logs the
 * error. Each link is rewritten in place: an errno is made by the failing call
 * and owned by this store until it is thrown, and the read-only calls this
 * store makes name the path in nothing but those three properties. A store
 * error's `key` is the root-relative key, which carries no `path` of its own,
 * so it survives for the caller that asked for it.
 */
function redactErrnoPaths(err: unknown): unknown {
    for (let link = err, depth = 0; depth < 8 && link instanceof Error; link = (link as Error).cause, depth++) {
        const errno = link as Error & { path?: unknown };
        const p = errno.path;
        if (typeof p !== "string") continue;
        errno.path = ERRNO_PATH_REPLACEMENT;
        if (p === "") continue;
        errno.message = errno.message.replaceAll(p, ERRNO_PATH_REPLACEMENT);
        errno.stack = errno.stack?.replaceAll(p, ERRNO_PATH_REPLACEMENT);
    }
    return err;
}

/** The errno code an fs failure carries, if it is one. */
function errnoCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Absent, including a final-component link an O_NOFOLLOW open refused (ELOOP)
 * and a name longer than the filesystem can hold (ENAMETOOLONG), under which
 * no object can exist.
 */
function isFileNotFound(err: unknown): boolean {
    return ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(`${errnoCode(err)}`);
}
