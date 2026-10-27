/**
 * Local filesystem ObjectStore and ResumableWriteStore adapters for
 * partial-content.
 *
 * {@link fsStore} implements the read-only {@link ObjectStore} interface over
 * the Node.js `fs` primitives; {@link fsUploadStore} implements the
 * resumable-upload write contract over the same root, publishing completed
 * uploads where an fsStore serves them.
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
 * unless {@link FsStoreOptions.symlinks} is `"follow"`; the upload store never
 * writes through a link that leaves it.
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

import {
    copyFile,
    link,
    lstat,
    mkdir,
    opendir,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    type FileHandle,
} from "node:fs/promises";
import {
    close as closeDescriptor,
    constants,
    createReadStream,
    fstat as fstatDescriptor,
    open as openDescriptor,
    read as readDescriptor,
    type BigIntStats,
    type Dir,
    type Dirent,
} from "node:fs";
import { openWithRetry } from "./open-retry.ts";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    ObjectNotFoundError,
    nodeStreamToWeb,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ParsedRange,
    reservedKeyGuard,
} from "./index.ts";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UploadDestinationConflictError,
    UPLOAD_STORE_CONTRACT_VERSION,
    isUploadNotFoundError,
    type UploadStateReadOptions,
    type ResumableWriteStore,
    type SweepingWriteStore,
    type PrefixedUploadStore,
    type StoredUploadState,
    type CreateUploadOptions,
    type AppendChunkOptions,
    type AppendChunkResult,
    type UploadSweepCutoff,
    type CompleteUploadOptions,
    type CompletedUpload,
    type UploadDigestAlgorithm,
} from "./upload-store.ts";
import {
    corruptUploadState,
    isCount,
    releaseUploadBody,
    isSweepable,
    requireSweepCutoff,
    verifyDigests,
    VERIFIED_DIGESTS,
} from "./upload-internals.ts";

// Re-export for convenience (consumers can catch without importing the kernel)
export { ObjectNotFoundError };
export {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UploadDestinationConflictError,
};
export type {
    ResumableWriteStore,
    SweepingWriteStore,
    StoredUploadState,
    CreateUploadOptions,
    AppendChunkOptions,
    AppendChunkResult,
    UploadSweepCutoff,
    CompleteUploadOptions,
    CompletedUpload,
};

// ─── Options ────────────────────────────────────────────────────────────────

export interface FsStoreOptions {
    /**
     * Key prefix this store refuses to serve, because it is where an upload
     * store sharing this location keeps its in-flight bytes and the sidecars
     * naming their destination keys. Keys at or under it answer
     * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
     * @default ".uploads/"
     */
    reservedPrefix?: string;
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

const ERRNO_PATH_REPLACEMENT = "<path>";

/**
 * Rewrite every filesystem path an errno error names, in its message, stack,
 * `path`, `dest` and anywhere along its cause chain, to a fixed placeholder.
 *
 * A resolved path carries the object key (a user's filename) or the upload
 * token (a bearer credential), and an errno such as EACCES, EISDIR or EIO
 * would hand it to every caller that logs the error. Each link is rewritten
 * in place: an errno is made by the failing call and owned by this store
 * until it is thrown, and an engine names the path in nothing but those four
 * properties. A store error's `key` is the root-relative key, which carries no
 * `path` of its own, so it survives for the caller that asked for it.
 */
function redactErrnoPaths(err: unknown): unknown {
    for (let link = err, depth = 0; depth < 8 && link instanceof Error; link = (link as Error).cause, depth++) {
        const errno = link as Error & Record<"path" | "dest", unknown>;
        for (const name of ["path", "dest"] as const) {
            const p = errno[name];
            if (typeof p !== "string") continue;
            errno[name] = ERRNO_PATH_REPLACEMENT;
            if (p === "") continue;
            errno.message = errno.message.replaceAll(p, ERRNO_PATH_REPLACEMENT);
            errno.stack = errno.stack?.replaceAll(p, ERRNO_PATH_REPLACEMENT);
        }
    }
    return err;
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

        async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal }): Promise<ObjectStream> {
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

// ─── Resumable Uploads: Options ─────────────────────────────────────────────

/** Reserved workspace for in-flight upload bytes and their sidecars. */
const UPLOADS_DIR = ".uploads";
const FS_DEFAULT_UPLOAD_PREFIX = `${UPLOADS_DIR}/`;

/**
 * A check refusing, as not found, a path that leaves `base` or lands at or
 * under the `reserved` prefix, which both stores apply to every key.
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
function outsideReserved(reserved: string): (base: string, path: string, key: string) => void {
    const fold = (value: string): string => value.normalize("NFC").toLowerCase();
    const guardRel = reservedKeyGuard(fold(reserved));
    // A name that does not itself fit 8.3 also answers to a generated short name
    // on a Windows volume with them enabled (`.uploads` -> `UPLOAD~1`), which
    // opens the same directory under a spelling no folding relates to the
    // prefix. The alias is not derivable, since its suffix depends on what else
    // existed when the directory was created, so what is refused is the alias
    // SHAPE, and only within the prefix's own depth.
    const reservedSegments = reserved.split("/").filter((segment) => segment !== "");
    const refuseShortNames = sep === "\\" && reservedSegments.some(needsShortNameAlias);
    return (base, path, key) => {
        const native = relative(base, path);
        const rel = native.split(sep).join("/");
        if (
            escapes(native) ||
            (refuseShortNames && rel.split("/").slice(0, reservedSegments.length).some(isShortNameAlias))
        ) {
            throw new ObjectNotFoundError(key);
        }
        try {
            guardRel(fold(rel));
        } catch {
            throw new ObjectNotFoundError(key);
        }
    };
}

/** Refuse a path outside `base` or at or under its uploads workspace. */
const assertPublishable = outsideReserved(FS_DEFAULT_UPLOAD_PREFIX);

export interface FsUploadStoreOptions {
    /**
     * Root directory completed objects are published under (point an
     * {@link fsStore} at the same root to serve them). In-flight bytes live in
     * a reserved `.uploads/` subdirectory inside it; publish keys are barred
     * from that subtree, and upload tokens are the only handles into it.
     */
    root: string;
}

// ─── Resumable Uploads: Layout ──────────────────────────────────────────────

/*
 * One upload is one directory, `<root>/.uploads/<token>/`, and every fact about
 * it is its own file, so no write can undo another:
 *
 *   data              the in-flight bytes, written positionally and fsynced
 *                     before an append returns. Never published: completion
 *                     publishes a copy (see completeUpload).
 *   info.json         creation facts.
 *   progress.json     `lastAppendAt`, the one record ever replaced.
 *   length.json       a length first declared on an append.
 *   seal.json         the length completion sealed at and the destination
 *                     state it may publish over.
 *   publication.json  the identity and digest of the staged copy, recorded
 *                     before the copy is linked at the key.
 *   complete.json, invalidated.json, cancelled.json
 *                     terminal facts.
 *   staged, displaced the copy being published, and the object it replaces
 *                     while the replacement is proven to be the sealed one.
 *
 * Everything but `data` and `progress.json` is created once by
 * {@link createOnce} and never rewritten, so a holder writing from a stale
 * read cannot revert a terminal fact: there is no merge to lose it in. The
 * directory is the resource's identity: a reap renames it away before removing
 * it, so a write still aimed at it fails on the missing path instead of
 * recreating the upload around nothing.
 */
const DATA = "data";
const INFO = "info.json";
const PROGRESS = "progress.json";
const LENGTH = "length.json";
const SEAL = "seal.json";
const PUBLICATION = "publication.json";
const COMPLETE = "complete.json";
const INVALIDATED = "invalidated.json";
const CANCELLED = "cancelled.json";
const STAGED = "staged";
const DISPLACED = "displaced";
/** Sealed uploads the sweep fenced off, kept for an operator for one retention period. */
const QUARANTINE = ".quarantine";
/** Prefix of a directory renamed out of its token's name on its way to removal. */
const REAPING = ".reap-";
/** The names this store mints tokens in; doubles as the traversal gate for token-derived paths. */
const TOKEN_SHAPE = /^[0-9a-f-]+$/;

/**
 * A file's identity: volume, inode, size and nanosecond mtime, as decimal
 * strings (a bigint stat's fields exceed 2^53 on some volumes). The inode
 * alone is not enough, because a filesystem reuses a freed inode number for
 * the next file it creates; a different file with the same number, size AND
 * nanosecond mtime is not a case this store distinguishes. A write in place
 * changes the mtime, so an object modified after it was recorded no longer
 * matches, which is the precondition's point.
 */
interface FileIdentity {
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
}

interface UploadInfo {
    key: string;
    length?: number;
    metadata?: Record<string, string>;
    createdAt: number;
    expiresAt?: number;
}

/** What completion sealed: the length, and the object it may publish over (null: the key was empty). */
interface UploadSeal {
    length: number;
    destination: FileIdentity | null;
}

/** The staged copy completion publishes: the identity recovery adopts, and its SHA-256. */
interface UploadPublication extends FileIdentity {
    digest: string;
}

interface UploadCompletion {
    completedSize: number;
    etag: string;
    digest: string;
}

/** Every record of one upload, read from one listing of its directory. */
interface UploadRecords {
    info: UploadInfo;
    lastAppendAt?: number;
    declaredLength?: number;
    seal?: UploadSeal;
    publication?: UploadPublication;
    completion?: UploadCompletion;
    invalidated: boolean;
}

// ─── Resumable Uploads: Factory ─────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by the local filesystem.
 *
 * Layout: each upload is a directory `<root>/.uploads/<token>/` holding its
 * bytes and one file per fact. Facts that settle (a declared length, the
 * completion seal, the terminal states) are created once and never rewritten,
 * so no write made from a stale read can revert one; only the advisory
 * `lastAppendAt` is ever replaced.
 *
 * Completion is the sealed plan {@link ResumableWriteStore.completeUpload}
 * describes. It seals at the acknowledged length, copies the bytes to a staged
 * file (a copy-on-write clone where the volume supports one), verifies any
 * asserted digest against that copy, and links the copy at the key. The
 * published object is therefore never the inode an append writes through, and
 * `link` refuses an existing name, so a key written after the seal is reported
 * as {@link UploadDestinationConflictError} rather than overwritten. Recovery
 * after a crash adopts the object at the key only when its file identity is
 * the staged copy's.
 *
 * Durability: the data file is fsynced before an append returns, so the offset
 * a later `getUploadState` derives from stat is crash-durable (claiming
 * `exactOffsetRecovery` without that fsync would be a lie). Every write-once
 * record is fsynced and so is its directory; the publication's directory is
 * fsynced after the link, so an object acknowledged as complete survives a
 * power loss. The advisory `lastAppendAt` is not fsynced (losing it only ages
 * the resource toward the sweep slightly early).
 *
 * Requires hard links (every POSIX filesystem, NTFS), and the workspace and
 * every key on the same volume, since publication links and renames across
 * them.
 *
 * @example
 * ```typescript
 * import { fsStore, fsUploadStore } from "partial-content/fs";
 *
 * const writes = fsUploadStore({ root: "/var/data/files" });
 * const reads = fsStore({ root: "/var/data/files" }); // serves completions
 * ```
 */
export function fsUploadStore(opts: FsUploadStoreOptions): PrefixedUploadStore {
    assertAbsoluteRoot("fsUploadStore", opts?.root);
    const root = resolve(opts.root);
    const uploadsDir = join(root, UPLOADS_DIR);
    const realPaths = realPathsOf(root);

    /**
     * The workspace's real path, asked on every operation so a link swapped in
     * after construction is still seen. One that carries it out of the root is
     * a misconfiguration or a planted link, and every operation refuses it
     * loudly rather than reading or writing there.
     */
    async function workspace(): Promise<string> {
        const [base, real] = await realPaths(uploadsDir);
        if (escapes(relative(base, real))) {
            throw new Error("fsUploadStore: workspace outside the root");
        }
        return real;
    }

    /**
     * Token -> its upload directory, refusing a token this store cannot have
     * issued as not found. The charset gate is the traversal defense for
     * token-derived paths: no separators, no dots, no null bytes. The files
     * inside are created exclusively by this store, so a link in their place
     * takes write access to the workspace, which is trusted.
     */
    async function uploadDir(uploadToken: string): Promise<string> {
        if (!TOKEN_SHAPE.test(uploadToken)) throw new UploadNotFoundError(uploadToken);
        // No workspace yet: no upload was ever created here.
        return join(await workspace().catch(uploadGone(uploadToken)), uploadToken);
    }

    /**
     * The path `key` publishes to, creating its parent directories one segment
     * at a time from the real root and resolving each before descending, so no
     * directory is created, and nothing is linked, through a link that leaves
     * the root or lands in the workspace.
     */
    async function publishTarget(key: string): Promise<string> {
        const segments = relative(root, resolveFinalKeyPath(root, key)).split(sep);
        const name = segments.pop()!;
        let [base, dir] = await realPaths(root);
        for (const segment of segments) {
            await mkdir(join(dir, segment), { recursive: true });
            [base, dir] = await realPaths(join(dir, segment));
            assertPublishable(base, dir, key);
        }
        return join(dir, name);
    }

    /**
     * The path `key` publishes to when its parent already exists, creating
     * nothing: what a state read asks, since a read writes no directory. A
     * parent reached through a link that leaves the root, or that lands in the
     * workspace, answers undefined, as no object this store published.
     */
    async function existingTarget(key: string): Promise<string | undefined> {
        try {
            const path = resolveFinalKeyPath(root, key);
            const [base, parent] = await realPaths(dirname(path));
            assertPublishable(base, parent, key);
            return join(parent, basename(path));
        } catch (err) {
            if (err instanceof ObjectNotFoundError || isFileNotFound(err)) return undefined;
            throw err;
        }
    }

    /**
     * Put back an object a publish moved aside and never replaced (a crash
     * between the two steps leaves the key empty), refusing to clobber
     * whatever holds the key now.
     */
    async function restoreDisplacedIn(dir: string): Promise<void> {
        if (!(await pathExists(join(dir, DISPLACED)))) return;
        const raw = await readFile(join(dir, INFO), "utf8").catch((err: unknown) => {
            if (isFileNotFound(err)) return undefined;
            throw err;
        });
        const info = raw === undefined ? undefined : decodeRecord(raw, isUploadInfo);
        // Without the key there is nowhere to restore to.
        if (info === undefined) return;
        await restoreDisplaced(join(dir, DISPLACED), await publishTarget(info.key));
    }

    /**
     * Fence a sealed upload the sweep condemned, instead of deleting it: the
     * rename takes every path a completion still running holds, so it can no
     * longer stage, link or record, and the records stay for an operator,
     * because the publish may have landed and they are the only proof of whose
     * object the key holds. The bytes go (the published object, if any, is its
     * own link at the key), so what is kept is bounded to a few records, and
     * a later sweep reclaims the entry once its own mtime passes the cutoff.
     */
    async function quarantine(ws: string, dir: string, name: string): Promise<void> {
        const pen = join(ws, QUARANTINE);
        await mkdir(pen, { recursive: true });
        const held = join(pen, name);
        await rename(dir, held);
        await restoreDisplacedIn(held);
        for (const bytes of [DATA, STAGED, DISPLACED]) await rm(join(held, bytes), { force: true });
    }

    /** What the sweep does with one workspace entry. */
    async function sweepVerdict(
        entry: Dirent,
        path: string,
        cutoff: UploadSweepCutoff,
    ): Promise<"keep" | "reap" | "quarantine"> {
        // A reclaim cut short: already out of its token's name, so nothing live.
        if (entry.name.startsWith(REAPING)) return "reap";
        // The flat files of the previous layout and anything else a crash left:
        // aged by mtime against both clocks, so a write in flight is never raced.
        if (!entry.isDirectory() || !TOKEN_SHAPE.test(entry.name)) {
            return (await agedPast(path, cutoff)) ? "reap" : "keep";
        }
        if (await pathExists(join(path, CANCELLED))) return "reap";
        let records: UploadRecords;
        try {
            records = await readUploadRecords(path, entry.name);
        } catch (err) {
            if (!isUploadNotFoundError(err)) throw err;
            // Mid-creation, torn by a crash, or damaged: the records' own clocks
            // are not trusted, the directory's mtime is.
            return (await agedPast(path, cutoff)) ? "reap" : "keep";
        }
        if (!isSweepable(cutoff, records.info.createdAt, records.lastAppendAt)) return "keep";
        return records.seal !== undefined && records.completion === undefined ? "quarantine" : "reap";
    }

    return withErrnoPathsRedacted({
        contractVersion: UPLOAD_STORE_CONTRACT_VERSION,
        exactOffsetRecovery: true,
        atomicCompletion: true,
        /** Every append verifies the claimed offset against durable state before writing. */
        enforcesOffsetCheck: true,
        digestOnComplete: VERIFIED_DIGESTS,
        uploadPrefix: FS_DEFAULT_UPLOAD_PREFIX,

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            createOpts.signal?.throwIfAborted();
            // Reject hostile keys at the door: nothing is allocated for a key
            // that could never publish.
            resolveFinalKeyPath(root, createOpts.key);
            const uploadToken = randomUUID();
            await mkdir(uploadsDir, { recursive: true });
            const dir = await uploadDir(uploadToken);
            // Not recursive: a token collision fails loudly (EEXIST), never
            // adopting another upload's directory.
            await mkdir(dir);
            const handle = await openWithRetry(join(dir, DATA), "wx");
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            const info: UploadInfo = {
                key: createOpts.key,
                length: createOpts.length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
            };
            await createOnce(join(dir, INFO), info);
            // The upload's own entry in the workspace, so a crash after this
            // returns cannot lose the resource the client was handed.
            await syncDirectory(dirname(dir));
            return { uploadToken };
        },

        async getUploadState(uploadToken: string, stateOpts?: UploadStateReadOptions): Promise<StoredUploadState> {
            stateOpts?.signal?.throwIfAborted();
            const dir = await uploadDir(uploadToken);
            const records = await readUploadRecords(dir, uploadToken);
            const { info, seal, publication, completion } = records;
            const facts = {
                key: info.key,
                length: declaredLengthOf(records),
                createdAt: info.createdAt,
                expiresAt: info.expiresAt,
                lastAppendAt: records.lastAppendAt,
                metadata: info.metadata,
            };
            if (completion) return { ...facts, offset: completion.completedSize, status: "complete" };
            if (seal && publication) {
                // A plan staged, and possibly published, whose record never
                // landed. It is complete only when the object at the key IS the
                // staged copy, by file identity, never by shape.
                const target = await existingTarget(info.key);
                if (target !== undefined && sameIdentity(await identityAt(target), publication)) {
                    // Finishing the record repairs the store's own bookkeeping. A
                    // caller holding no lock asks for none (`repair: false`): an
                    // unlocked write could race a cancel, and the state it derived
                    // is the answer either way.
                    if (stateOpts?.repair !== false) {
                        await recordCompletion(dir, target, seal, publication, uploadToken);
                    }
                    return { ...facts, offset: seal.length, status: "complete" };
                }
                // The plan is fixed at its length once its copy is staged, so a
                // completion resumed at the offset reported here resumes it.
                return { ...facts, offset: seal.length, status: records.invalidated ? "invalidated" : "incomplete" };
            }
            let size: number;
            try {
                // Backend-derived offset: a stat of the data file appendChunk
                // fsyncs before acking, never a stored counter.
                size = (await stat(join(dir, DATA))).size;
            } catch (err) {
                if (!isFileNotFound(err)) throw err;
                // Data file lost under a live record: the bytes are gone, which is
                // the terminal dead state, not a not-found (the resource existed).
                return { ...facts, offset: 0, status: "invalidated" };
            }
            return { ...facts, offset: size, status: records.invalidated ? "invalidated" : "incomplete" };
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            // The caller hands the body over on entry and never touches it again, so
            // the store owes it a release on every exit that did not read it. An
            // abandoned body is not inert: on a runtime that backs it with the live
            // connection the peer keeps sending into a stream nobody reads, and the
            // routine offset conflict (a resume from a stale saved offset) is the
            // exit that meets that traffic. `taken` flips where the read begins, so
            // every exit before it releases the body and every exit after it owns
            // both the bytes it read and its own teardown.
            let taken = false;
            try {
                // A yield asked for before the call arrived is an interruption with
                // nothing durable, reported rather than raised: a caller must never have
                // to read an exception to tell a yield from a failure.
                if (appendOpts.signal?.aborted === true) {
                    return { bytesWritten: 0, interrupted: true };
                }
                const dir = await uploadDir(uploadToken);
                const records = await readUploadRecords(dir, uploadToken);
                // Published and sealed resources refuse before a byte is written.
                refuseSettled(records, uploadToken);

                // Data file lost under a live record: nothing to append to (ENOENT
                // is non-transient and rethrows on the first attempt).
                const handle = await openWithRetry(join(dir, DATA), "r+").catch(uploadGone(uploadToken));
                try {
                    const durableOffset = (await handle.stat()).size;
                    // Verify the claim against DURABLE truth, and refuse invalidated
                    // resources outright. Required by the store contract: the lock
                    // serializes writers but cannot prove the writer still holds it, so
                    // this is what makes a stolen-lock write loud, not silent.
                    if (records.invalidated || offset !== durableOffset) {
                        throw new UploadOffsetConflictError(uploadToken, durableOffset);
                    }
                    // Deferred-length declaration: the first append to carry a length
                    // records it, once; a length already recorded is never replaced.
                    const declaredLength = declaredLengthOf(records) === undefined ? appendOpts.length : undefined;

                    let flushed = 0;
                    let crossedBound: number | undefined;
                    /** Write as much of `chunk` as the byte bound allows; false = crossed. */
                    const acceptChunk = async (chunk: Uint8Array): Promise<boolean> => {
                        const room =
                            appendOpts.maxBytes === undefined
                                ? chunk.length
                                : Math.min(chunk.length, appendOpts.maxBytes - flushed);
                        if (room > 0) {
                            await writeFully(handle, chunk.subarray(0, room), durableOffset + flushed);
                            flushed += room;
                        }
                        if (room < chunk.length) {
                            crossedBound = appendOpts.maxBytes;
                            return false;
                        }
                        return true;
                    };

                    let interrupted = false;
                    // From here the body is being consumed, and its teardown belongs to
                    // the read below (reader.cancel on an early exit, exhaustion on a
                    // clean one) rather than to the release the entry owes an untouched
                    // body.
                    taken = true;
                    if (body instanceof Uint8Array) {
                        await acceptChunk(body);
                    } else {
                        interrupted = await drainUploadBody(body, appendOpts.signal, acceptChunk);
                    }

                    // Durability BEFORE the offset becomes reportable: exactOffsetRecovery
                    // is only honest if a post-crash stat can never see bytes this call
                    // acked but never flushed.
                    await handle.sync();

                    // A sweep or a cancel can remove a resource this append is still
                    // writing to. Bytes flushed through a handle whose last name is gone
                    // reach no reader, so a handle with no links left IS the gone
                    // resource. Zero links is what a delete-while-open leaves on POSIX,
                    // and on Windows volumes whose deletes carry POSIX semantics (NTFS).
                    if ((await handle.stat()).nlink === 0) {
                        throw new UploadNotFoundError(uploadToken);
                    }

                    // FENCE. The records are read again now that the bytes are
                    // durable: an append either finished before a completion sealed,
                    // and its bytes are in that completion's snapshot, or it sees the
                    // seal here and acknowledges nothing. A check before the write
                    // alone would leave a third order.
                    const settled = await readUploadRecords(dir, uploadToken);
                    if (settled.seal !== undefined && settled.completion === undefined) {
                        // Take back what this call wrote past the sealed length, so the
                        // snapshot finds exactly the plan; bytes up to the seal stay,
                        // since the completer counted them, and bytes before this
                        // call's own start were never this call's to remove.
                        const keep = Math.max(settled.seal.length, durableOffset);
                        if (keep < durableOffset + flushed) {
                            await handle.truncate(keep);
                            await handle.sync();
                        }
                    }
                    refuseSettled(settled, uploadToken);
                    if (settled.invalidated) throw new UploadOffsetConflictError(uploadToken, durableOffset + flushed);

                    // Bytes that tried to land past a REPRESENTATION bound (a known
                    // length, the total maxSize) are a terminal fault, recorded durably
                    // so every later interaction refuses.
                    const overran = crossedBound !== undefined && appendOpts.maxBytesFatal === true;
                    if (overran) await createOnce(join(dir, INVALIDATED), {}).catch(uploadGone(uploadToken));
                    if (declaredLength !== undefined) {
                        await createOnce(join(dir, LENGTH), { length: declaredLength }).catch(uploadGone(uploadToken));
                    }
                    await writeProgress(dir, appendOpts.now, uploadToken);
                    // Otherwise the bound was this request's ceiling, not the
                    // representation's: the prefix that landed is persisted and the
                    // resource stays healthy, so the client resumes from the truthful
                    // offset in smaller chunks.
                    if (crossedBound !== undefined) {
                        throw overran
                            ? new UploadOverrunError(uploadToken, crossedBound)
                            : new UploadAppendBoundError(uploadToken, durableOffset + flushed);
                    }
                    return { bytesWritten: flushed, interrupted };
                } finally {
                    await handle.close().catch(() => {
                        // Best-effort close; the append outcome is already decided
                    });
                }
            } finally {
                if (!taken) await releaseUploadBody(body, appendOpts);
            }
        },

        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            const { signal, expectedLength } = completeOpts;
            signal?.throwIfAborted();
            const dir = await uploadDir(uploadToken);
            const records = await readUploadRecords(dir, uploadToken);
            // Idempotent retry: already published; answer the recorded facts.
            if (records.completion) return { etag: records.completion.etag, digest: records.completion.digest };
            if (records.invalidated) {
                throw new Error(`fsUploadStore cannot complete an invalidated upload`);
            }
            // Re-validated at publish time: the record sat on disk between create
            // and complete, and a tampered key must not become a traversal.
            const finalPath = await publishTarget(records.info.key);

            // SEAL. A seal already present is adopted at its own length; at
            // another, it is re-pointed only while no copy is staged, because a
            // staged copy may already be at the key and a second plan would
            // publish a different object.
            let seal = records.seal;
            let publication = records.publication;
            if (seal !== undefined && seal.length !== expectedLength) {
                if (publication !== undefined) throw new UploadOffsetConflictError(uploadToken, seal.length);
                await liftSeal(dir);
                seal = undefined;
            }
            if (seal === undefined) {
                const fresh: UploadSeal = {
                    length: expectedLength,
                    destination: await destinationAt(finalPath, uploadToken),
                };
                if (await createOnce(join(dir, SEAL), fresh).catch(uploadGone(uploadToken))) {
                    seal = fresh;
                } else {
                    // A concurrent completer sealed first: only the same plan is adopted.
                    const theirs = await readUploadRecords(dir, uploadToken);
                    if (theirs.seal?.length !== expectedLength) {
                        throw new UploadOffsetConflictError(
                            uploadToken,
                            theirs.seal === undefined ? await dataLength(dir, uploadToken) : theirs.seal.length,
                        );
                    }
                    seal = theirs.seal;
                    publication = theirs.publication;
                }
            }

            // RECORD of an earlier attempt: its publish landed when the object at
            // the key is the staged copy by identity. Its digests were verified
            // before that publish, which is the only point verification can stop
            // one.
            if (publication !== undefined && sameIdentity(await identityAt(finalPath), publication)) {
                return completed(await recordCompletion(dir, finalPath, seal, publication, uploadToken));
            }
            signal?.throwIfAborted();

            // SNAPSHOT, taken after the seal: the staged copy is the plan.
            const staged = join(dir, STAGED);
            if (publication === undefined) {
                publication = await stagePublication(dir, seal.length, uploadToken);
            } else if (!sameIdentity(await identityAt(staged), publication)) {
                // The staged copy left the workspace (it was linked at the key and
                // unlinked here) and the key holds something else now.
                throw new UploadDestinationConflictError(uploadToken);
            }
            const plan = publication;
            // Atomic completion: a failed verification publishes NOTHING; the
            // orchestrator aborts the resource.
            await verifyDigests(uploadToken, completeOpts.expectedDigests, async (algorithm) =>
                algorithm === "sha-256" ? plan.digest : hashFileBase64(staged, uploadToken, algorithm),
            );
            signal?.throwIfAborted();

            // PUBLISH under the destination state the seal recorded.
            await publishStaged(dir, finalPath, seal.destination, plan, uploadToken);
            // RECORD.
            return completed(await recordCompletion(dir, finalPath, seal, plan, uploadToken));
        },

        async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
            abortOpts?.signal?.throwIfAborted();
            let dir: string;
            try {
                dir = await uploadDir(uploadToken);
            } catch (err) {
                // Idempotent: a token this store never issued has nothing to discard.
                if (err instanceof UploadNotFoundError) return;
                throw err;
            }
            try {
                // Durable before anything is removed: a removal cut short still
                // answers not-found, and no read finishes a record inside it.
                await createOnce(join(dir, CANCELLED), {});
            } catch (err) {
                // Nothing there: discarded already.
                if (isFileNotFound(err)) return;
                throw err;
            }
            // A completion that crashed between moving the old object aside and
            // linking the new one left the key empty; the cancel puts it back.
            await restoreDisplacedIn(dir);
            await reclaim(dir);
        },

        /**
         * One unreapable entry must not end the scan. A Windows volume refuses to
         * rename a directory while a file in it is open (EPERM), POSIX answers
         * EACCES on a read-only remount or a sticky-bit directory, and
         * propagating that would abandon every entry behind it, so a retention
         * sweep that runs on a schedule could reclaim nothing for as long as one
         * upload stays busy, and report success by not throwing. Each entry is
         * therefore isolated and counted: `failed` is what a caller alerts on.
         *
         * A sealed upload that never recorded its completion is quarantined, not
         * removed (see `quarantine`), and counted in `failed`: a completion that
         * did not finish is for an operator to reconcile.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            const signal = sweepOpts?.signal;
            signal?.throwIfAborted();
            requireSweepCutoff(cutoff);
            let ws: string;
            let dir: Dir;
            try {
                ws = await workspace();
                dir = await opendir(ws);
            } catch (err) {
                // No uploads workspace yet: nothing was ever created here.
                if (isFileNotFound(err)) return { removed: 0, failed: 0 };
                throw err;
            }
            let removed = 0;
            let failed = 0;
            /** Run one entry's removal, counting it instead of letting it end the scan. */
            const attempt = async (work: () => Promise<void>, counted: "removed" | "failed"): Promise<void> => {
                try {
                    await work();
                    if (counted === "removed") removed++;
                    else failed++;
                } catch {
                    // Held open, or unremovable by permission: the entry stays and the
                    // next sweep retries it.
                    failed++;
                }
            };
            // A directory handle yields one name at a time, so the memory this holds
            // does not scale with the backlog it is reclaiming, and the first entry
            // is reaped before the last is read. Abandoning the loop closes the
            // handle: the async-iteration protocol returns the iterator on an abrupt
            // exit, and the directory iterator closes on return.
            for await (const entry of dir) {
                // Per entry, because a sweep runs over a workspace of unbounded size
                // and a caller that revokes it (shutdown, a request timeout) must not
                // wait out the rest of the scan.
                signal?.throwIfAborted();
                const path = join(ws, entry.name);
                if (entry.name === QUARANTINE) {
                    for await (const held of await opendir(path)) {
                        signal?.throwIfAborted();
                        const heldPath = join(path, held.name);
                        if (await agedPast(heldPath, cutoff)) {
                            await attempt(() => rm(heldPath, { recursive: true, force: true }), "removed");
                        }
                    }
                    continue;
                }
                let verdict: "keep" | "reap" | "quarantine";
                try {
                    verdict = await sweepVerdict(entry, path, cutoff);
                } catch {
                    // Unreadable for a reason other than absence: left for the next pass.
                    failed++;
                    continue;
                }
                if (verdict === "reap") await attempt(() => reclaim(path), "removed");
                if (verdict === "quarantine") await attempt(() => quarantine(ws, path, entry.name), "failed");
            }
            return { removed, failed };
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
function bodyIsCacheable(range: ParsedRange | undefined, contentLength: number, totalSize: number): boolean {
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
function servedBounds(range: ParsedRange | undefined, totalSize: number): { end: number; contentLength: number } {
    if (!range) return { end: totalSize - 1, contentLength: totalSize };
    if (range.start >= totalSize) {
        throw new RangeError(`fsStore: range start ${range.start} is beyond object size ${totalSize}`);
    }
    const end = Math.min(range.end, totalSize - 1);
    return { end, contentLength: end - range.start + 1 };
}

function objectStream(
    body: ObjectStream["body"],
    contentLength: number,
    file: { totalSize: number; lastModified: string; etag: string | undefined },
    range: ParsedRange | undefined,
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
    range: ParsedRange | undefined,
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
        const base = key.slice(Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1).replace(/[. ]+$/, "");
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
 * `[root's real path, path's real path]`, every link resolved. The root's is
 * memoized once it resolves; a root that does not exist yet is asked again on
 * the next call.
 */
function realPathsOf(root: string): (path: string) => Promise<[string, string]> {
    let base: string | undefined;
    return async (path) => [(base ??= await realpath(root)), await realpath(path)];
}

/**
 * Resolve the FINAL publish path for an upload: the read side's traversal
 * defense plus a reservation on the uploads workspace, so a hostile key can
 * never address another upload's partial bytes or a sidecar.
 */
function resolveFinalKeyPath(root: string, key: string): string {
    const resolved = safeResolve(root, key);
    assertPublishable(root, resolved, key);
    return resolved;
}

/**
 * Drain a body into `accept`, answering whether the append was interrupted.
 *
 * The yield signal is tested on BOTH sides of every read. Before, so a yield
 * already asked for costs no further read. After, because a read that was
 * already in flight when the yield arrived resolves anyway, and accepting its
 * bytes would write past the point the caller was told this append stopped at:
 * under a lease that is the new holder's acknowledged bytes being written over.
 * A torn body (the client vanished mid-request) answers the same way, since the
 * flushed prefix is truthful and the stream error carries no bytes to account.
 *
 * `accept` returning false is a bound this call refuses to cross, which is a
 * decided outcome and not an interruption.
 */
async function drainUploadBody(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    accept: (chunk: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
    const reader = body.getReader();
    try {
        for (;;) {
            if (signal?.aborted) return true;
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
                next = await reader.read();
            } catch {
                return true;
            }
            if (next.done) return false;
            if (signal?.aborted) return true;
            if (!(await accept(next.value))) return false;
        }
    } finally {
        // Stop the producer on early exit (bound crossed, abort). On an
        // already-errored stream cancel() rejects with that same error, which
        // the loop above already accounted for.
        void reader.cancel().catch(() => {});
    }
}

// ─── Upload records ─────────────────────────────────────────────────────────

/** A JSON object's fields, or undefined for anything else. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

const DECIMAL = /^\d+$/;

function isIdentity(value: unknown): value is FileIdentity {
    const f = fieldsOf(value);
    return f !== undefined && [f.dev, f.ino, f.size, f.mtimeNs].every((v) => typeof v === "string" && DECIMAL.test(v));
}

function isUploadInfo(value: unknown): value is UploadInfo {
    const f = fieldsOf(value);
    const metadata = f?.metadata === undefined ? {} : fieldsOf(f.metadata);
    return (
        f !== undefined &&
        typeof f.key === "string" &&
        f.key !== "" &&
        isCount(f.createdAt) &&
        (f.expiresAt === undefined || isCount(f.expiresAt)) &&
        (f.length === undefined || isCount(f.length)) &&
        metadata !== undefined &&
        Object.values(metadata).every((v) => typeof v === "string")
    );
}

function isSeal(value: unknown): value is UploadSeal {
    const f = fieldsOf(value);
    return f !== undefined && isCount(f.length) && (f.destination === null || isIdentity(f.destination));
}

function isPublication(value: unknown): value is UploadPublication {
    return isIdentity(value) && typeof (value as { digest?: unknown }).digest === "string";
}

function isCompletion(value: unknown): value is UploadCompletion {
    const f = fieldsOf(value);
    return f !== undefined && isCount(f.completedSize) && typeof f.etag === "string" && typeof f.digest === "string";
}

function hasCount<K extends string>(name: K): (value: unknown) => value is Record<K, number> {
    return (value): value is Record<K, number> => isCount(fieldsOf(value)?.[name]);
}
const isProgress = hasCount("lastAppendAt");
const isDeclaredLength = hasCount("length");

/** Record text to its facts, or undefined for text that does not parse or holds a shape this store never writes. */
function decodeRecord<T>(raw: string, isShape: (value: unknown) => value is T): T | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    return isShape(parsed) ? parsed : undefined;
}

/**
 * Every record of the upload in `dir`, from one listing of it, so a record
 * that is absent costs no read.
 *
 * A cancelled upload is not found whether or not its removal finished, and so
 * is one with no creation record (still being created, or being reaped).
 * Every record lands whole, by {@link createOnce} or a rename, so one that
 * does not decode is damage rather than a write in progress: not-found to the
 * client, corrupt to the operator. The parse failure is never the cause,
 * since its text quotes the record, key and all.
 */
async function readUploadRecords(dir: string, uploadToken: string): Promise<UploadRecords> {
    const names = new Set(await readdir(dir).catch(uploadGone(uploadToken)));
    if (names.has(CANCELLED) || !names.has(INFO)) throw new UploadNotFoundError(uploadToken);
    const read = async <T>(name: string, isShape: (value: unknown) => value is T): Promise<T | undefined> => {
        if (!names.has(name)) return undefined;
        let raw: string;
        try {
            raw = await readFile(join(dir, name), "utf8");
        } catch (err) {
            // Listed, then gone: a seal lifted, or the upload reaped meanwhile.
            if (isFileNotFound(err)) return undefined;
            throw err;
        }
        const record = decodeRecord(raw, isShape);
        if (record === undefined) throw corruptUploadState(uploadToken);
        return record;
    };
    const info = await read(INFO, isUploadInfo);
    if (info === undefined) throw new UploadNotFoundError(uploadToken);
    return {
        info,
        lastAppendAt: (await read(PROGRESS, isProgress))?.lastAppendAt,
        declaredLength: (await read(LENGTH, isDeclaredLength))?.length,
        seal: await read(SEAL, isSeal),
        publication: await read(PUBLICATION, isPublication),
        completion: await read(COMPLETE, isCompletion),
        invalidated: names.has(INVALIDATED),
    };
}

/** The representation length: declared at creation, or first on an append. */
function declaredLengthOf(records: UploadRecords): number | undefined {
    return records.info.length ?? records.declaredLength;
}

/**
 * Refuse a write to a published or sealed upload with the length that is
 * final: the published size, or the length the seal holds the plan at.
 */
function refuseSettled(records: UploadRecords, uploadToken: string): void {
    if (records.completion) throw new UploadOffsetConflictError(uploadToken, records.completion.completedSize);
    if (records.seal) throw new UploadOffsetConflictError(uploadToken, records.seal.length);
}

/** The durable length of the data file. */
async function dataLength(dir: string, uploadToken: string): Promise<number> {
    return (await stat(join(dir, DATA)).catch(uploadGone(uploadToken))).size;
}

function completed(record: UploadCompletion): CompletedUpload {
    return { etag: record.etag, digest: record.digest };
}

/**
 * Create `path` holding `record`, once, answering false when the name already
 * exists. The record is written to a temp and fsynced, then hard-linked into
 * place: `link` refuses an existing name, so no later write replaces the
 * record, and a reader never sees it torn. The directory is fsynced after the
 * link, so the record survives a power loss once this returns.
 *
 * A directory that is gone fails the temp's creation with ENOENT, which is
 * what keeps a late write from recreating a reaped upload.
 *
 * descope: needs hard links, which every POSIX filesystem and NTFS provide; a
 * volume without them (FAT, exFAT, some network shares) fails here with the
 * platform's link error. Revisit when node:fs exposes a no-replace rename
 * (renameat2 RENAME_NOREPLACE), which gives the same guarantee without one.
 */
async function createOnce(path: string, record: unknown): Promise<boolean> {
    const text = JSON.stringify(record);
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await openWithRetry(temp, "wx");
    try {
        try {
            await handle.writeFile(text);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await link(temp, path);
        } catch (err) {
            if (errnoCode(err) === "EEXIST") return false;
            throw err;
        }
    } finally {
        await rm(temp, { force: true });
    }
    await syncDirectory(dirname(path));
    return true;
}

/**
 * Record an append's `lastAppendAt`, the one record a write replaces. The
 * temp is created inside the upload's directory and renamed within it, so a
 * directory that was reaped (or renamed away on its way to removal) fails
 * either step on the missing path rather than recreating the upload. A
 * terminal fact landing meanwhile is untouched: it is a file of its own, and
 * this record holds nothing but the timestamp. Not fsynced: losing it only
 * ages the resource toward the sweep slightly early.
 */
async function writeProgress(dir: string, now: number, uploadToken: string): Promise<void> {
    const text = JSON.stringify({ lastAppendAt: now });
    const temp = join(dir, `${PROGRESS}.${randomUUID()}.tmp`);
    try {
        const handle = await openWithRetry(temp, "wx");
        try {
            await handle.writeFile(text);
        } finally {
            await handle.close();
        }
        await rename(temp, join(dir, PROGRESS));
    } catch (err) {
        await rm(temp, { force: true }).catch(() => {
            // Best-effort: the write already failed and decides the outcome, and
            // the temp goes with the upload's directory.
        });
        uploadGone(uploadToken)(err);
    }
}

/** Errnos a filesystem answers when it cannot sync a directory at all. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Make `dir`'s entries durable. A rename or link is complete in the directory,
 * not in the file it names, so without this a power loss right after one can
 * roll it back although the call returned.
 *
 * descope: a no-op on Windows, where node:fs cannot open a directory for the
 * write access a flush needs (EPERM), so a rename there is as durable as the
 * volume's own journal makes it. Revisit when node:fs can flush a directory
 * handle on Windows.
 */
async function syncDirectory(dir: string): Promise<void> {
    if (sep === "\\") return;
    const handle = await openWithRetry(dir, "r");
    try {
        await handle.sync();
    } catch (err) {
        // Some network and FUSE mounts cannot sync a directory and have no
        // stronger primitive to offer.
        if (!DIRECTORY_SYNC_UNSUPPORTED.has(`${errnoCode(err)}`)) throw err;
    } finally {
        await handle.close();
    }
}

/** Remove the seal, so the upload is resumable again. */
async function liftSeal(dir: string): Promise<void> {
    await rm(join(dir, SEAL), { force: true });
    await syncDirectory(dir);
}

function identityOf(stats: BigIntStats): FileIdentity {
    return {
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
        size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(),
    };
}

/** The identity of what `path` names (a link itself, never its target), or undefined when nothing does. */
async function identityAt(path: string): Promise<FileIdentity | undefined> {
    try {
        return identityOf(await lstat(path, { bigint: true }));
    } catch (err) {
        if (isFileNotFound(err)) return undefined;
        throw err;
    }
}

function sameIdentity(a: FileIdentity | undefined, b: FileIdentity): boolean {
    return a !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/**
 * The destination state a seal records: null for an empty key, the identity
 * of the file or link there otherwise. Anything else (a directory) is not an
 * object completion may replace.
 */
async function destinationAt(finalPath: string, uploadToken: string): Promise<FileIdentity | null> {
    let stats: BigIntStats;
    try {
        stats = await lstat(finalPath, { bigint: true });
    } catch (err) {
        if (isFileNotFound(err)) return null;
        throw err;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new UploadDestinationConflictError(uploadToken);
    return identityOf(stats);
}

/**
 * SNAPSHOT: copy the sealed plan to `staged` and record the copy's identity.
 *
 * A copy, never the data file itself. An appender holding a stale descriptor
 * on `data` writes into that inode for as long as it runs, so a published
 * inode it could reach would change after its digest was verified and its
 * completion announced. COPYFILE_FICLONE makes the copy a copy-on-write clone
 * where the volume supports one (btrfs, XFS, APFS, ReFS), costing neither
 * bytes nor time there, and a plain copy elsewhere. The digest is taken from
 * the copy, so it describes exactly the bytes published.
 *
 * A copy of any length but the sealed one lifts the seal and throws
 * {@link UploadOffsetConflictError} with the length found, so the client
 * re-anchors there.
 */
async function stagePublication(dir: string, length: number, uploadToken: string): Promise<UploadPublication> {
    const staged = join(dir, STAGED);
    // A copy an earlier attempt left: no publication record names it, so it
    // was never linked anywhere.
    await rm(staged, { force: true });
    await copyFile(join(dir, DATA), staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE).catch(
        uploadGone(uploadToken),
    );
    const handle = await openWithRetry(staged, "r+");
    let stats: BigIntStats;
    try {
        await handle.sync();
        stats = await handle.stat({ bigint: true });
    } finally {
        await handle.close();
    }
    if (stats.size !== BigInt(length)) {
        await rm(staged, { force: true });
        await liftSeal(dir);
        throw new UploadOffsetConflictError(uploadToken, Number(stats.size));
    }
    const publication: UploadPublication = {
        ...identityOf(stats),
        digest: await hashFileBase64(staged, uploadToken, "sha-256"),
    };
    if (!(await createOnce(join(dir, PUBLICATION), publication).catch(uploadGone(uploadToken)))) {
        // A concurrent completer staged first, and the copy it recorded is the
        // one this call replaced: neither plan can be published now.
        throw new UploadOffsetConflictError(uploadToken, length);
    }
    return publication;
}

/**
 * PUBLISH `staged` at `finalPath`, over exactly the destination the seal
 * recorded, or nothing.
 *
 * Into an empty key, `link` is the precondition: it refuses an existing name,
 * so an object written after the seal is never overwritten. Over an object,
 * that object is first moved aside and its identity compared with the
 * sealed one, so what is replaced is proven to be it; a different one goes
 * back without clobbering, and either way a mismatch is
 * {@link UploadDestinationConflictError} with nothing published. A link that
 * finds this same copy already at the key (a peer's publish) is success.
 *
 * descope: replacing an object leaves the key empty between moving the old
 * one aside and linking the new one, where a reader gets not-found, and the
 * only atomic compare-and-replace is a rename exchange (renameat2
 * RENAME_EXCHANGE), which node:fs does not expose. Revisit when it does.
 */
async function publishStaged(
    dir: string,
    finalPath: string,
    destination: FileIdentity | null,
    publication: UploadPublication,
    uploadToken: string,
): Promise<void> {
    const displaced = join(dir, DISPLACED);
    if (destination !== null) {
        try {
            await rename(finalPath, displaced);
        } catch (err) {
            // Nothing at the key: an earlier attempt moved it aside already, or a
            // third party removed it. The identity check below tells which.
            if (!isFileNotFound(err)) throw err;
        }
        if (!sameIdentity(await identityAt(displaced), destination)) {
            await restoreDisplaced(displaced, finalPath);
            throw new UploadDestinationConflictError(uploadToken);
        }
    }
    try {
        await link(join(dir, STAGED), finalPath);
    } catch (err) {
        if (errnoCode(err) !== "EEXIST") throw err;
        if (!sameIdentity(await identityAt(finalPath), publication)) {
            throw new UploadDestinationConflictError(uploadToken, err);
        }
    }
    await syncDirectory(dirname(finalPath));
    await rm(join(dir, STAGED), { force: true });
    await rm(displaced, { force: true });
}

/**
 * Link a moved-aside object back at the key, unless something holds the key
 * now: then the newer object wins and the moved one stays where it is.
 */
async function restoreDisplaced(displaced: string, finalPath: string): Promise<void> {
    try {
        await link(displaced, finalPath);
    } catch (err) {
        if (isFileNotFound(err) || errnoCode(err) === "EEXIST") return;
        throw err;
    }
    await syncDirectory(dirname(finalPath));
    await rm(displaced, { force: true });
}

/**
 * RECORD a publish: the object at `target` must be the staged copy by
 * identity, and the completion record is created once. A record a peer made
 * first is the one answered. Its validator is the one the read side derives
 * from the same stat, so an fsStore over this root serves the object under
 * THIS etag.
 */
async function recordCompletion(
    dir: string,
    target: string,
    seal: UploadSeal,
    publication: UploadPublication,
    uploadToken: string,
): Promise<UploadCompletion> {
    const stats = await lstat(target, { bigint: true }).catch((err: unknown) => {
        if (isFileNotFound(err)) throw new UploadDestinationConflictError(uploadToken, err);
        throw err;
    });
    if (!sameIdentity(identityOf(stats), publication)) throw new UploadDestinationConflictError(uploadToken);
    const record: UploadCompletion = {
        completedSize: seal.length,
        etag: weakFsETag(stats.size, stats.mtimeNs),
        digest: publication.digest,
    };
    if (!(await createOnce(join(dir, COMPLETE), record).catch(uploadGone(uploadToken)))) {
        const recorded = (await readUploadRecords(dir, uploadToken)).completion;
        if (recorded === undefined) throw corruptUploadState(uploadToken);
        return recorded;
    }
    // Nothing reads the in-flight bytes once the record exists, and they are
    // not the published object.
    await rm(join(dir, DATA), { force: true }).catch(() => {
        // Best-effort: the completion is recorded and decides the outcome, and
        // the bytes go with the upload's directory when the sweep reclaims it.
    });
    return record;
}

/** Errnos a directory rename answers on Windows while a file inside it is open. */
const HELD_OPEN = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Remove an upload directory, renaming it out of its token's name first so a
 * write still aimed at it fails on the missing path instead of landing in a
 * directory half-removed.
 *
 * Windows refuses that rename while a file inside is open, which an append in
 * flight holds; removing in place is still safe there, because the volume
 * deletes an open file with POSIX semantics (the name goes, the handle stays
 * valid, and the append reads zero links and answers not-found).
 */
async function reclaim(dir: string): Promise<void> {
    let target = join(dirname(dir), `${REAPING}${randomUUID()}`);
    try {
        await rename(dir, target);
    } catch (err) {
        if (isFileNotFound(err)) return;
        if (sep !== "\\" || !HELD_OPEN.has(`${errnoCode(err)}`)) throw err;
        target = dir;
    }
    await rm(target, { recursive: true, force: true });
}

/**
 * Whether an entry whose own records cannot be trusted has aged past either
 * cutoff by its mtime; one that vanished meanwhile has not.
 */
async function agedPast(path: string, cutoff: UploadSweepCutoff): Promise<boolean> {
    let mtimeMs: number;
    try {
        mtimeMs = (await stat(path)).mtimeMs;
    } catch {
        return false;
    }
    return isSweepable(cutoff, mtimeMs, mtimeMs);
}

/** Positional write loop: POSIX permits short writes even without an error. */
async function writeFully(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written);
        written += bytesWritten;
    }
}

/** RFC 9530 raw base64 digest, streamed so large uploads stay O(1) memory. */
async function hashFileBase64(
    dataPath: string,
    uploadToken: string,
    algorithm: UploadDigestAlgorithm,
): Promise<string> {
    const hash = createHash(algorithm.replace("-", ""));
    // The stream closes its descriptor on end and on error alike. A data file
    // lost under a live sidecar has nothing to publish: the upload's not-found.
    try {
        for await (const chunk of createReadStream(dataPath)) hash.update(chunk as Uint8Array);
    } catch (err) {
        uploadGone(uploadToken)(err);
    }
    return hash.digest("base64");
}

/** A not-found errno as the upload's not-found; any other error as it is. */
function uploadGone(uploadToken: string): (err: unknown) => never {
    return (err) => {
        throw isFileNotFound(err) ? new UploadNotFoundError(uploadToken, err) : err;
    };
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

/** The errno code an fs failure carries, if it is one. */
function errnoCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Absent, including a final-component link an O_NOFOLLOW open refused (ELOOP). */
function isFileNotFound(err: unknown): boolean {
    return ["ENOENT", "ENOTDIR", "ELOOP"].includes(`${errnoCode(err)}`);
}

/**
 * Whether a path resolves to anything, with absence as the only false.
 *
 * A stat that fails for any other reason (a permission the sweep does not
 * have, a mount that went away) says nothing about whether the file is there,
 * and the sweep asks this to decide whether a data file still has a sidecar.
 * Reading such a failure as absence would orphan the data half of an upload
 * that is very much alive, so an unanswerable question answers "present": the
 * entry stays and the next pass asks again.
 */
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (err) {
        return !isFileNotFound(err);
    }
}
