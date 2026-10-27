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
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UPLOAD_STORE_CONTRACT_VERSION,
    type ResumableWriteStore,
    type SweepingWriteStore,
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
    bytesToBase64,
    releaseUploadBody,
    isSweepable,
    newUploadId,
    requireSweepCutoff,
    uploadStatus,
    verifyDigests,
    VERIFIED_DIGESTS,
} from "./upload-internals.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError };
export {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
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
    /** Stored media type, reported as {@link ObjectMetadata.contentType} (informational, never served). */
    contentType?: string;
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
    if (opts?.objects === null || typeof opts?.objects !== "object") {
        throw new TypeError("memoryStore: options.objects is required (the map objects are served from)");
    }
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
                contentType: entry.contentType,
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
                throw new RangeError(`memoryStore: range start ${range.start} is beyond object size ${bytes.length}`);
            }
            // subarray() clamps to the object size and returns a view (no copy);
            // the served bytes are read-only, so a view is safe. Derive the reported
            // range from the actual slice so ObjectStream.range is the SERVED bounds.
            const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
            return {
                // In-memory bytes are ArrayBuffer-backed (TextEncoder output or the
                // caller's view); narrow so the body is `new Response(...)`-assignable
                // under DOM lib, where BodyInit requires an ArrayBuffer-backed view.
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
    expiresAt?: number;
    lastAppendAt?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    /** Present from the moment a completion seals its plan until it publishes or lifts it. */
    seal?: MemorySeal;
    digest?: string;
    etag?: string;
}

/**
 * A completion's sealed plan. While a record carries one, every append is
 * refused, so the bytes the plan snapshotted are the bytes it publishes.
 */
interface MemorySeal {
    /** What the key held when the plan sealed; publication is allowed over exactly this. */
    destination: DestinationState;
}

/**
 * The destination as the seal found it. The entry, its body and its etag are
 * all compared, because the objects map is caller-mutable by reference: a
 * caller simulating an overwrite may replace the entry or edit it in place.
 */
type DestinationState =
    | { present: false }
    | { present: true; entry: MemoryObject; body: MemoryObject["body"]; etag: string | undefined };

function destinationState(objects: Record<string, MemoryObject>, key: string): DestinationState {
    const entry = Object.hasOwn(objects, key) ? objects[key] : undefined;
    if (entry === undefined) return { present: false };
    return { present: true, entry, body: entry.body, etag: entry.etag };
}

function sameDestination(a: DestinationState, b: DestinationState): boolean {
    if (!a.present || !b.present) return a.present === b.present;
    return a.entry === b.entry && a.body === b.body && a.etag === b.etag;
}

// ─── Resumable Uploads: Factory ─────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} over process memory: the write-side
 * counterpart of {@link memoryStore}, for consumer test suites and demos.
 *
 * Faithful to the write contract: offsets derive from the bytes actually
 * held (never a separately persisted counter), every append opens with the
 * offset preflight {@link ResumableWriteStore.enforcesOffsetCheck} declares,
 * a byte bound the body tries to cross truncates the append and then answers
 * per {@link AppendChunkOptions.maxBytesFatal} (a representation bound
 * invalidates the resource terminally and raises {@link UploadOverrunError};
 * a request ceiling keeps the truncated prefix durable, leaves the resource
 * resumable, and raises {@link UploadAppendBoundError}), completion verifies
 * an asserted SHA-256 (Web Crypto, so any runtime) BEFORE publishing, and
 * publication is atomic: a failed completion leaves the objects map
 * untouched. Completion seals its plan at the acknowledged length: any other
 * length raises {@link UploadOffsetConflictError}, an append after the seal
 * is refused, an entry written to the key after the seal raises
 * {@link UploadDestinationConflictError} and is left in place, and an upload
 * swept or aborted mid-completion publishes nothing.
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
export function memoryUploadStore(opts: MemoryUploadStoreOptions): SweepingWriteStore {
    if (opts?.objects === null || typeof opts?.objects !== "object") {
        throw new TypeError(
            "memoryUploadStore: options.objects is required (the map completed uploads publish into). " +
                "Pass the SAME object to memoryStore so the published bytes can be served: " +
                "const objects = {}; memoryUploadStore({ objects }); memoryStore({ objects });",
        );
    }
    const uploads = new Map<string, MemoryUploadRecord>();

    function lookupUpload(uploadToken: string): MemoryUploadRecord {
        const record = uploads.get(uploadToken);
        if (!record) throw new UploadNotFoundError(uploadToken);
        return record;
    }

    return {
        contractVersion: UPLOAD_STORE_CONTRACT_VERSION,
        exactOffsetRecovery: true,
        atomicCompletion: true,
        /** Every append verifies the claimed offset against durable state before writing. */
        enforcesOffsetCheck: true,
        digestOnComplete: VERIFIED_DIGESTS,

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            createOpts.signal?.throwIfAborted();
            const uploadToken = newUploadId();
            uploads.set(uploadToken, {
                key: createOpts.key,
                chunks: [],
                size: 0,
                length: createOpts.length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
                isComplete: false,
                isInvalidated: false,
            });
            return { uploadToken };
        },

        async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
            stateOpts?.signal?.throwIfAborted();
            const record = lookupUpload(uploadToken);
            return {
                key: record.key,
                offset: record.size,
                length: record.length,
                status: uploadStatus(record),
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
                lastAppendAt: record.lastAppendAt,
                metadata: record.metadata,
            };
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            // A yield asked for before the call arrived is an interruption with
            // nothing durable, reported rather than raised: a caller must never have
            // to read an exception to tell a yield from a failure.
            if (appendOpts.signal?.aborted === true) {
                await releaseUploadBody(body, appendOpts);
                return { bytesWritten: 0, interrupted: true };
            }
            // Dead or already-published resources refuse every append, and a
            // mismatched claim loses to durable truth. Required by the store
            // contract, not a nicety: the orchestrator's lock serializes writers but
            // cannot prove the writer still holds it, so this is what turns a
            // stolen-lock holder's late write into a loud conflict. A sealed record
            // is the completion fence: its plan already holds every byte it will
            // publish, so an append is refused, never silently left out.
            const claimHolds = (record: MemoryUploadRecord): void => {
                if (
                    lookupUpload(uploadToken) !== record ||
                    record.isComplete ||
                    record.isInvalidated ||
                    record.seal !== undefined ||
                    offset !== record.size
                ) {
                    throw new UploadOffsetConflictError(uploadToken, record.size);
                }
            };
            let record: MemoryUploadRecord;
            try {
                record = lookupUpload(uploadToken);
                claimHolds(record);
            } catch (err) {
                // A refused append never reads its body, so nothing else stops the peer.
                await releaseUploadBody(body, appendOpts);
                throw err;
            }

            // Deferred-length declaration: the first append to carry a length records
            // it durably so the next getUploadState reports it and it turns immutable.
            // Only ever set once (the orchestrator guarantees it, and the guard makes
            // it safe): a length already on the record is never overwritten.
            if (appendOpts.length !== undefined && record.length === undefined) {
                record.length = appendOpts.length;
            }

            const accepted: Uint8Array[] = [];
            let flushed = 0;
            let crossedBound: number | undefined;
            /** Take as much of `chunk` as the byte bound allows; false = crossed. */
            const accept = (chunk: Uint8Array): boolean => {
                const room =
                    appendOpts.maxBytes === undefined
                        ? chunk.length
                        : Math.min(chunk.length, appendOpts.maxBytes - flushed);
                if (room > 0) {
                    // slice(), not subarray(): the store owns its bytes, and a caller
                    // reusing its buffer after the call must not rewrite history.
                    accepted.push(chunk.slice(0, room));
                    flushed += room;
                }
                if (room < chunk.length) {
                    crossedBound = appendOpts.maxBytes;
                    return false;
                }
                return true;
            };

            let interrupted = false;
            if (body instanceof Uint8Array) {
                accept(body);
            } else {
                const reader = body.getReader();
                try {
                    for (;;) {
                        if (appendOpts.signal?.aborted) {
                            interrupted = true;
                            break;
                        }
                        let next: Awaited<ReturnType<typeof reader.read>>;
                        try {
                            next = await reader.read();
                        } catch {
                            // Torn body (the client vanished mid-request): the accepted
                            // prefix is the truthful answer; the stream error itself
                            // carries no bytes to account.
                            interrupted = true;
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

            // The body read yielded, so the preflight above may be stale: re-check
            // in the same synchronous step as the commit, so a writer that lost its
            // claim while streaming lands nothing.
            claimHolds(record);
            for (const chunk of accepted) record.chunks.push(chunk);
            record.size += flushed;
            record.lastAppendAt = appendOpts.now;
            // Bytes tried to land past the engine's bound. Only a REPRESENTATION
            // bound (a known length, the total maxSize) is the terminal fault that
            // invalidation is reserved for.
            if (crossedBound !== undefined && appendOpts.maxBytesFatal) {
                record.isInvalidated = true;
                throw new UploadOverrunError(uploadToken, crossedBound);
            } else if (crossedBound !== undefined) {
                // This request's ceiling. The prefix above is durable and the resource
                // is healthy, so the client resumes from here in smaller chunks.
                throw new UploadAppendBoundError(uploadToken, record.size);
            }
            return { bytesWritten: flushed, interrupted };
        },

        /**
         * The sealed plan, with the store's only real I/O (hashing) between the
         * seal and the publish. SEAL and SNAPSHOT are one synchronous step before
         * the first await, so a length mismatch never needs a seal lifted. Every
         * fact the publish depends on is re-checked in the synchronous step that
         * publishes: the record is still the one sealed (a sweep or abort that
         * ran during hashing ends the completion), the seal is still this plan,
         * and the destination is what the seal found. The publication identity
         * is the published entry itself: publish and record are the same
         * synchronous step, so no window exists in which an object at the key
         * would have to be recognised as this upload's after the fact.
         */
        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            completeOpts.signal?.throwIfAborted();
            const record = lookupUpload(uploadToken);
            // Idempotent retry: already published; answer the recorded facts.
            if (record.isComplete) return { etag: record.etag, digest: record.digest };
            if (record.isInvalidated) {
                throw new Error(`memoryUploadStore cannot complete an invalidated upload`);
            }
            if (record.size !== completeOpts.expectedLength) {
                throw new UploadOffsetConflictError(uploadToken, record.size);
            }
            // A seal already present is a concurrent completer's plan at this same
            // length (the size is frozen under it), so it is adopted, not replaced.
            const seal = (record.seal ??= {
                destination: destinationState(opts.objects, record.key),
            });
            const bytes = concatChunks(record.chunks, record.size);

            let digest: string;
            try {
                digest = await digestBase64("sha-256", bytes);
                // Atomic completion: a failed verification publishes NOTHING; the
                // orchestrator aborts the resource.
                await verifyDigests(uploadToken, completeOpts.expectedDigests, async (algorithm) =>
                    algorithm === "sha-256" ? digest : digestBase64(algorithm, bytes),
                );
            } catch (err) {
                // Nothing was published, so the upload goes back to accepting appends.
                if (record.seal === seal) record.seal = undefined;
                throw err;
            }

            // No await from here to the return: check and publish are one step.
            const live = lookupUpload(uploadToken);
            if (live !== record) throw new UploadNotFoundError(uploadToken);
            if (record.isComplete) return { etag: record.etag, digest: record.digest };
            if (record.seal !== seal || record.isInvalidated || record.size !== bytes.byteLength) {
                throw new UploadOffsetConflictError(uploadToken, record.size);
            }
            if (!sameDestination(seal.destination, destinationState(opts.objects, record.key))) {
                // The key is someone else's data now. The upload stays sealed and
                // unpublished, so no retry overwrites it.
                throw new UploadDestinationConflictError(uploadToken);
            }

            const etag = `"${digest}"`;
            const published: MemoryObject = {
                body: bytes,
                etag,
                lastModified: new Date(completeOpts.now).toUTCString(),
                digest,
            };
            // defineProperty, not bracket assignment: the key is caller data on a
            // plain object, and assigning "__proto__" would mutate the prototype
            // instead of publishing an own entry.
            Object.defineProperty(opts.objects, record.key, {
                value: published,
                writable: true,
                enumerable: true,
                configurable: true,
            });
            record.isComplete = true;
            record.seal = undefined;
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

        /**
         * Reclamation here is a `Map` delete over records this process owns
         * outright: there is no handle another writer can hold, no permission to
         * be denied, and no backend to answer an error. `failed` is therefore
         * structurally zero rather than a count that happens to be zero today,
         * which is why no entry needs isolating from the ones behind it.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            sweepOpts?.signal?.throwIfAborted();
            requireSweepCutoff(cutoff);
            let removed = 0;
            for (const [uploadToken, record] of uploads) {
                if (!isSweepable(cutoff, record.createdAt, record.lastAppendAt)) continue;
                uploads.delete(uploadToken);
                removed++;
            }
            return { removed, failed: 0 };
        },
    };
}

// ─── Resumable Uploads: Internal Helpers ────────────────────────────────────

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

/** RFC 9530 raw base64 digest via Web Crypto (runtime-agnostic). */
async function digestBase64(algorithm: UploadDigestAlgorithm, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(algorithm.toUpperCase(), bytes);
    return bytesToBase64(new Uint8Array(digest));
}
