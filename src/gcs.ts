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
    isSha256Base64,
    reservedKeyGuard,
} from "./index.ts";
import { casMerge, mergePersistedState } from "./cas-merge.ts";
import { sweepEach } from "./sweep-each.ts";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    isUploadNotFoundError,
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
} from "./upload-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };
export { UploadNotFoundError, UploadOffsetConflictError, UploadDestinationConflictError };
export { UploadAppendBoundError, UploadOverrunError };
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
import {
    UPLOAD_ID_RE,
    assertUploadWritable,
    decodeUploadId,
    isCount,
    uploadIdForDiscard,
    newUploadId,
    isSweepable,
    requireSweepCutoff,
    admitAppend,
    pumpUploadBody,
    publishKeyGuard,
    toStoredState,
    validatePersistedUploadShape,
    corruptUploadState,
    type PersistedUpload,
    DEFAULT_UPLOAD_PREFIX,
} from "./upload-internals.ts";

// ─── GCS Types ──────────────────────────────────────────────────────────────

/**
 * Minimal GCS Storage interface.
 *
 * Declared locally to avoid a hard dependency on `@google-cloud/storage`.
 * Users who import `partial-content/gcs` will have it installed as an
 * optional peer dependency.
 */
export interface GcsStorage {
    bucket(name: string): GcsBucket;
}

export interface GcsBucket {
    file(name: string, opts?: { generation?: string | number }): GcsFile;
}

export interface GcsFile {
    getMetadata(): Promise<[GcsFileMetadata]>;
    createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream & AsyncIterable<Buffer>;
    getSignedUrl(config: GcsSignedUrlConfig): Promise<[string]>;
}

/** The V4 read-signing subset of the SDK's `GetSignedUrlConfig`. */
export interface GcsSignedUrlConfig {
    version: "v4";
    action: "read";
    expires: Date;
    /** Signed `response-content-disposition` query override. */
    responseDisposition: string;
    /** Signed `response-content-type` query override. */
    responseType: string;
}

export interface GcsFileMetadata {
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
    /**
     * Key prefix this store refuses to serve, because it is where an upload
     * store sharing this location keeps its in-flight bytes and the sidecars
     * naming their destination keys. Keys at or under it answer
     * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
     * @default ".partial-content-uploads/"
     */
    reservedPrefix?: string;
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
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? DEFAULT_UPLOAD_PREFIX);
    const { digestMetadataKey } = opts;

    return {
        supportsRange: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            assertReadable(key);
            opts?.signal?.throwIfAborted();
            const [metadata] = await classifyStoreRead(key, () => bucket.file(key).getMetadata(), gcsClassifiers);

            const described = describeGcsObject(metadata, digestMetadataKey);
            return {
                contentLength: described.size,
                etag: described.etag,
                lastModified: described.lastModified,
                digest: described.digest,
                // A generation names an immutable object version, so it can carry
                // everything getObject would otherwise re-fetch. No generation
                // (emulators, mocks) means no pin: getObject falls back to its own
                // metadata read.
                pin: described.generation !== undefined ? JSON.stringify(described) : undefined,
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string; pin?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
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
            const usablePin = pinned && (!ifMatch || pinned.etag === ifMatch) ? pinned : null;

            let described: ReturnType<typeof describeGcsObject> | null = usablePin;
            if (!described) {
                // GCS streams carry no total size, the ifMatch check needs the
                // current etag, and generation pinning needs the current generation.
                const [metadata] = await classifyStoreRead(key, () => bucket.file(key).getMetadata(), gcsClassifiers);

                // Caller pin: the object must still match the validator captured at
                // HEAD time. GCS etags change on every overwrite, so a mismatch means
                // the representation the caller validated no longer exists.
                if (ifMatch && metadata.etag && metadata.etag !== ifMatch) {
                    throw new ObjectChangedError(key);
                }

                described = describeGcsObject(metadata, digestMetadataKey);
            }
            const { generation, size: totalSize, etag, lastModified, digest } = described;

            if (range && range.start >= totalSize) {
                // Unsatisfiable ranges are the orchestrator's job to reject
                // (parseRangeHeader 416s them first); a direct caller gets a loud
                // error instead of a truncated body under an inflated Content-Length.
                throw new RangeError(`gcsStore: range start is past the ${totalSize}-byte object`);
            }
            // Clamp the end so contentLength and the reported range match what
            // the backend stream will actually deliver (createReadStream clamps
            // to EOF silently; the reported bounds must not diverge from it).
            const end = range ? Math.min(range.end, totalSize - 1) : totalSize - 1;
            const streamOpts = range ? { start: range.start, end } : undefined;

            // Pin the stream to the generation just measured (or the caller's
            // pinned generation): metadata and bytes come from the SAME object
            // version even if it is overwritten between the two calls (reading a
            // specific generation is immutable in GCS).
            const { body, destroy } = await openGcsRead(
                key,
                bucket.file(key, generation !== undefined ? { generation } : undefined).createReadStream(streamOpts),
                generation !== undefined ? gcsPinnedClassifiers : gcsClassifiers,
                signal,
            );

            const contentLength = range ? end - range.start + 1 : totalSize;

            // expectedBytes guards a graceful short-read: a truncated GCS download
            // that ends cleanly below the committed length errors the body instead
            // of under-running the Content-Length undetected.
            const webStream = nodeStreamToWeb(body, { signal, destroy, expectedBytes: contentLength });

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

        async createSignedUrl(key: string, signOpts: GcsSignOptions): Promise<GcsSignResult> {
            assertReadable(key);
            signOpts.signal?.throwIfAborted();
            let url: string;
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
                [url] = await bucket.file(key).getSignedUrl({
                    version: "v4",
                    action: "read",
                    expires: new Date(Date.now() + signOpts.expiresInSeconds * 1000),
                    responseType: "application/octet-stream",
                    responseDisposition: buildContentDisposition(signOpts.downloadFilename ?? "download", {
                        type: "attachment",
                    }),
                });
            } catch (err) {
                // A credential with no service-account identity (user credentials,
                // an API key) cannot sign at all, and the SDK says so naming
                // `client_email`: "this store cannot sign here", so the caller
                // streams instead. Any other failure (an IAM signBlob denial, a
                // network error) is a signer that should have worked, and throws.
                if (!(err instanceof Error && /client_email/.test(err.message))) throw err;
                return { ok: false, error: err.message, code: "no-credential", cause: err };
            }
            // Signing may make an IAM round trip the SDK cannot cancel; a caller
            // that stopped waiting gets its abort, not a URL.
            signOpts.signal?.throwIfAborted();
            return { ok: true, url };
        },
    };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

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
    return isSha256Base64(value) ? value : undefined;
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

/**
 * The representation one metadata read describes, in the pin's shape. With a
 * generation it IS the pin: a generation names an immutable object version.
 */
function describeGcsObject(
    metadata: GcsFileMetadata,
    digestMetadataKey: string | undefined,
): Omit<GcsPin, "generation"> & { generation?: GcsPin["generation"] } {
    return {
        generation: metadata.generation,
        size: gcsSizeToNumber(metadata.size),
        etag: metadata.etag,
        lastModified: metadata.updated ? new Date(metadata.updated).toUTCString() : undefined,
        digest: digestFromCustomMetadata(metadata, digestMetadataKey),
    };
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
            Number.isSafeInteger(candidate.size) &&
            candidate.size >= 0 &&
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
            (candidate.digest === undefined || isSha256Base64(candidate.digest))
        ) {
            return candidate as unknown as GcsPin;
        }
    } catch {
        /* not our token: revalidate via metadata instead */
    }
    return null;
}

/** A GCS generation is a non-empty string or a finite number; nothing else. */
function isValidGeneration(gen: unknown): gen is string | number {
    return (typeof gen === "string" && gen.length > 0) || (typeof gen === "number" && Number.isFinite(gen));
}

/** The HTTP status the Cloud Storage client surfaces on `err.code`, if any. */
function gcsCode(err: unknown): unknown {
    return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

function isGcsNotFound(err: unknown): boolean {
    return gcsCode(err) === 404;
}

/**
 * A conditional write refused by the backend: the object's generation was not
 * the one the request named (`ifGenerationMatch`), which the client library
 * surfaces as HTTP 412 on `err.code`.
 */
function isGcsPreconditionFailed(err: unknown): boolean {
    return gcsCode(err) === 412;
}

/**
 * Whether a GCS error is a transient throttle/overload the client should retry
 * (mapped to a 503, not a 502): 429 (rate limit) or 503 (backend unavailable).
 */
function isGcsThrottled(err: unknown): boolean | { retryAfterSeconds: number } {
    const code = gcsCode(err);
    if (code !== 429 && code !== 503) return false;
    // Surface the backend's advised back-off when the client library kept
    // the raw response, so the resulting 503 echoes it as Retry-After.
    const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
    const hint = parseRetryAfterSeconds(headers?.["retry-after"], { allowHttpDate: true });
    return hint !== undefined ? { retryAfterSeconds: hint } : true;
}

/**
 * The error-classification set for both metadata reads and an unpinned body
 * read. It has no `changed` predicate: the metadata pin is an etag comparison
 * (handled inline, throwing {@link ObjectChangedError} directly), not a native
 * conditional error.
 */
const gcsClassifiers: StoreErrorClassifiers = {
    notFound: isGcsNotFound,
    throttled: isGcsThrottled,
};

/** {@link ObjectStore.createSignedUrl}'s options, with the abort signal it honours. */
interface GcsSignOptions {
    expiresInSeconds: number;
    downloadFilename?: string;
    cacheControl?: string;
    signal?: AbortSignal;
}

/** `{ ok: false }` only when this credential cannot sign; a failed signing throws. */
type GcsSignResult = Awaited<ReturnType<NonNullable<ObjectStore["createSignedUrl"]>>>;

/**
 * A read pinned to a generation: that generation was validated a moment ago,
 * so its absence means the representation changed, never that the key is
 * unknown.
 */
const gcsPinnedClassifiers: StoreErrorClassifiers = {
    notFound: () => false,
    changed: (err) => isGcsNotFound(err) || isGcsPreconditionFailed(err),
    throttled: isGcsThrottled,
};

/**
 * Wait for a read stream's first chunk before the caller commits a status.
 * The SDK reports a missing object or generation only once the response
 * arrives, as a stream error; surfaced after the headers it would break a
 * body already promised as 200/206. The chunk read here is the body's first.
 */
async function openGcsRead(
    key: string,
    stream: AsyncIterable<Uint8Array>,
    classifiers: StoreErrorClassifiers,
    signal: AbortSignal | undefined,
): Promise<{ body: AsyncIterable<Uint8Array>; destroy: () => void }> {
    const destroy = (): void => (stream as { destroy?: () => void }).destroy?.();
    const iterator = stream[Symbol.asyncIterator]();
    signal?.addEventListener("abort", destroy);
    let head: IteratorResult<Uint8Array> | undefined;
    try {
        // An abort that landed before the listener existed fires no event.
        signal?.throwIfAborted();
        head = await classifyStoreRead(key, () => iterator.next(), classifiers);
        signal?.throwIfAborted();
    } catch (err) {
        destroy();
        signal?.throwIfAborted();
        throw err;
    } finally {
        signal?.removeEventListener("abort", destroy);
    }
    const next = (): Promise<IteratorResult<Uint8Array>> => {
        const first = head;
        head = undefined;
        return first ? Promise.resolve(first) : iterator.next();
    };
    return { body: { [Symbol.asyncIterator]: () => ({ next }) }, destroy };
}

// ─── Resumable Upload: GCS Types ────────────────────────────────────────────

/**
 * The storage surface the upload store needs. Declared locally (like the
 * read side's {@link GcsStorage}) to avoid a hard dependency on
 * `@google-cloud/storage`; the real `Storage` satisfies it structurally.
 */
interface GcsUploadStorage {
    bucket(name: string): GcsUploadBucket;
}

/** One page request of an object listing (JSON API `objects.list`). */
interface GcsListQuery {
    prefix: string;
    /** `"/"` returns objects directly under `prefix` and folds deeper names into prefixes. */
    delimiter?: string;
    /** One page per call; the next page is asked for by `pageToken`. */
    autoPaginate: false;
    maxResults: number;
    pageToken?: string;
}

interface GcsUploadBucket {
    file(name: string): GcsUploadFile;
    /** One listing page, then the query naming the next one (absent or null on the last page). */
    getFiles(
        query: GcsListQuery,
    ): Promise<
        [Array<{ name: string; metadata?: { size?: string | number } }>, ({ pageToken?: unknown } | null)?, unknown?]
    >;
    /**
     * Server-side compose: concatenates up to 32 sources into the destination.
     * `ifGenerationMatch` travels as the request's query precondition.
     */
    combine(sources: string[], destination: string, options?: { ifGenerationMatch?: number }): Promise<unknown>;
}

/**
 * The generation precondition GCS implements on every object write: `0` lands
 * only where no object exists, any other value only over that exact
 * generation. Both are refused with 412 rather than overwriting.
 */
interface GcsWritePrecondition {
    preconditionOpts?: { ifGenerationMatch?: number };
}

/** Custom metadata (the `x-goog-meta-*` namespace) a write sets on the new object. */
interface GcsCustomMetadata {
    metadata?: { metadata: Record<string, string> };
}

interface GcsUploadFile {
    save(
        data: Uint8Array | string,
        options?: { resumable?: boolean } & GcsWritePrecondition & GcsCustomMetadata,
    ): Promise<void>;
    download(): Promise<[Uint8Array]>;
    /**
     * The client library spreads these options into the request's query, so
     * the precondition is a top-level `ifGenerationMatch`; a nested
     * `preconditionOpts` would be sent as an unknown parameter and ignored.
     */
    delete(options?: { ignoreNotFound?: boolean; ifGenerationMatch?: number }): Promise<unknown>;
    createWriteStream(options?: { resumable?: boolean } & GcsWritePrecondition): GcsUploadWritable;
    getMetadata(): Promise<
        [{ size?: string | number; etag?: string; generation?: string | number; metadata?: Record<string, string> }]
    >;
    /**
     * Server-side rewrite onto `destination` in the same bucket. The
     * precondition applies to the destination, and the custom metadata given
     * replaces the source's on the new object.
     */
    copy(destination: string, options: GcsWritePrecondition & GcsCustomMetadata): Promise<unknown>;
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
     * `<uploadPrefix>/<id>/<n>`, running composites at
     * `<uploadPrefix>/<id>/f<n>`, bookkeeping at `<uploadPrefix>/<id>.info`.
     */
    uploadPrefix?: string;
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

/** GCS caps a single compose call at 32 sources. */
const GCS_MAX_COMPOSE_SOURCES = 32;
/** Chunk-object names are zero-padded so listings read in append order. */
const GCS_CHUNK_NAME_WIDTH = 6;
/** Objects per listing page: the JSON API's own ceiling. */
const GCS_LIST_PAGE_SIZE = 1000;
/** Custom-metadata key carrying the publication id of an object this store published. */
const GCS_PUBLICATION_METADATA_KEY = "partial-content-publication";

/**
 * A sealed completion plan: the length it publishes, the generation of the
 * object the publish may replace (`0`: only where nothing is), and the
 * publication id the published object carries.
 */
interface GcsSeal {
    length: number;
    destination: number;
    publicationId: string;
}

/**
 * Durable upload bookkeeping, persisted as the `.info` object's JSON body.
 * `folded` is the highest chunk index a running composite covers: no append
 * may land a chunk at or below it.
 */
type GcsPersistedUpload = PersistedUpload & { seal?: GcsSeal; folded?: number };

function isGcsSeal(v: unknown): v is GcsSeal {
    if (typeof v !== "object" || v === null) return false;
    const c = v as Record<string, unknown>;
    return (
        isCount(c.length) && isCount(c.destination) && typeof c.publicationId === "string" && c.publicationId.length > 0
    );
}

/** Decode + shape-validate persisted state; null for corrupt values. */
function decodeGcsPersistedUpload(raw: Uint8Array): GcsPersistedUpload | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return null;
    }
    const base: GcsPersistedUpload | null = validatePersistedUploadShape(parsed);
    if (!base) return null;
    if (base.seal !== undefined && !isGcsSeal(base.seal)) return null;
    if (base.folded !== undefined && !isCount(base.folded)) return null;
    return base;
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

/**
 * An object's size: a decimal string in real GCS responses, tolerated as a
 * number. Served lengths, upload offsets and completion sums are built from
 * it, so an absent or unparseable size fails the call. Read as zero or as its
 * leading digits, it would frame a body at the wrong length, or hand a
 * resuming client an offset short of its durable bytes.
 */
function gcsSizeToNumber(size: string | number | undefined): number {
    const n = typeof size === "string" && /^\d+$/.test(size) ? Number(size) : size;
    if (!isCount(n)) throw new Error("GCS returned an object without a usable size");
    return n;
}

/** An object version's generation; anything but a positive safe integer fails the call. */
function generationOf(meta: { generation?: string | number }): number {
    const generation = Number(meta.generation);
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("GCS returned no usable generation");
    return generation;
}

/** One source of an assembly: a chunk, or a running composite covering every index up to `index`. */
interface GcsPlanSource {
    name: string;
    index: number;
    size: number;
}

/**
 * The assembly the staging objects describe: its sources in order, their
 * total length, and the index the next chunk takes.
 */
interface GcsPlan {
    sources: GcsPlanSource[];
    length: number;
    nextIndex: number;
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
 * - Every 32 sources fold, server-side, into a running composite
 *   `<uploadPrefix>/<id>/f<n>` holding every byte up to chunk `n`, and the
 *   record notes `n` before the folded chunks are deleted. A listing therefore
 *   holds at most 32 sources whatever the upload's length, and no append may
 *   land a chunk at an index a composite already covers.
 * - `getUploadState` derives the offset by listing the newest composite and
 *   the chunks after it and summing their sizes: backend bookkeeping, never a
 *   stored counter (`exactOffsetRecovery: true`).
 * - `completeUpload` is a sealed plan. It records a seal on the `.info`
 *   object (the length, the generation of the object at the key or its
 *   absence, a random publication id), takes the listing only after the seal,
 *   folds it by compose into one composite, and publishes it
 *   with one server-side copy onto the key under `ifGenerationMatch` set to
 *   the sealed generation, writing the publication id into the custom
 *   metadata key `partial-content-publication`. The copy is the single
 *   publishing call, so publication is all-or-nothing
 *   (`atomicCompletion: true`), and a key written by anyone after the seal is
 *   refused, never replaced. Compose cannot set custom metadata, which is why
 *   the copy publishes; the copy sets no content type, so the published
 *   object is `application/octet-stream` unless the bucket says otherwise.
 *   Staging objects are deleted only after the completion is on record, so a
 *   crashed completion retries from intact sources, and one that crashed
 *   after publishing is recovered by the publication id, never by size.
 * - Creation-time facts (final key, declared length, caller metadata,
 *   timestamps) ride a small JSON object `<uploadPrefix>/<id>.info`,
 *   rewritten on each append (lastAppendAt) and at terminal transitions.
 *   Every write of it is conditional on the generation the write's own fresh
 *   read returned (creation on absence), and every chunk write on absence:
 *   a holder whose lock was stolen while its body streamed neither rewrites
 *   the winner's record nor replaces a chunk the winner already wrote.
 *
 * `digestOnComplete` is `false`: the contract's completion digest is the
 * client-asserted whole-representation SHA-256, and GCS's native checksums
 * are MD5/CRC32C only, so a passed `expectedDigests` throws a clear error and
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
export function gcsUploadStore(opts: GcsUploadStoreOptions): PrefixedUploadStore {
    const bucket = opts.storage.bucket(opts.bucket);
    const prefix = (opts.uploadPrefix ?? DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");
    const assertPublishable = publishKeyGuard(`${prefix}/`);

    const infoName = (id: string): string => `${prefix}/${id}.info`;
    const chunkPrefix = (id: string): string => `${prefix}/${id}/`;
    const composePrefix = (id: string): string => `${prefix}/${id}.compose/`;
    const padIndex = (index: number): string => String(index).padStart(GCS_CHUNK_NAME_WIDTH, "0");
    const chunkName = (id: string, index: number): string => `${chunkPrefix(id)}${padIndex(index)}`;
    const foldName = (id: string, index: number): string => `${chunkPrefix(id)}f${padIndex(index)}`;

    /** Every object of a listing, fetched one page at a time. */
    async function* listObjects(
        prefix: string,
        delimiter?: string,
    ): AsyncGenerator<{ name: string; metadata?: { size?: string | number } }> {
        let pageToken: string | undefined;
        do {
            const [objects, next] = await bucket.getFiles({
                prefix,
                autoPaginate: false,
                maxResults: GCS_LIST_PAGE_SIZE,
                ...(delimiter !== undefined ? { delimiter } : {}),
                ...(pageToken !== undefined ? { pageToken } : {}),
            });
            yield* objects;
            const token = next?.pageToken;
            pageToken = typeof token === "string" && token.length > 0 ? token : undefined;
        } while (pageToken !== undefined);
    }

    /**
     * The persisted state behind an id together with the generation it was
     * read at, or `undefined` when there is no `.info` object. The generation
     * is read BEFORE the body: a write that lands in between makes the body
     * newer than the generation, and a merge pinned to that generation is then
     * refused and re-reads. The other order could pair a stale body with the
     * generation of the record that replaced it, and land it.
     */
    async function readState(
        id: string,
    ): Promise<{ state: GcsPersistedUpload | null; generation: number } | undefined> {
        let generation: number;
        try {
            generation = generationOf((await bucket.file(infoName(id)).getMetadata())[0]);
        } catch (err) {
            if (isGcsNotFound(err)) return undefined;
            throw err;
        }
        const state = await downloadRecord(id);
        return state === undefined ? undefined : { state, generation };
    }

    /**
     * The record behind an id: `undefined` when there is none, `null` when it
     * is corrupt. Given the token, an absent record throws
     * {@link UploadNotFoundError} carrying the backend's not-found instead.
     */
    async function downloadRecord(id: string, uploadToken?: string): Promise<GcsPersistedUpload | null | undefined> {
        try {
            const [raw] = await bucket.file(infoName(id)).download();
            return decodeGcsPersistedUpload(raw);
        } catch (err) {
            if (!isGcsNotFound(err)) throw err;
            if (uploadToken !== undefined) throw new UploadNotFoundError(uploadToken, err);
            return undefined;
        }
    }

    /**
     * Rewrite the record from a FRESH read, pinned to the generation that read
     * returned (a 412 re-reads, up to `CAS_MERGE_ATTEMPTS` passes). `compute`
     * returns the record to write, or null to write nothing; it may throw to
     * refuse, and what it decides holds for exactly the version it was shown.
     *
     * A record that is gone or corrupt is not written back: the sweep, an abort
     * or the completion's cleanup ended the resource, or its bookkeeping can no
     * longer be trusted, and a holder that was mid-body learns it here as
     * {@link UploadNotFoundError} rather than recreating the resource from its
     * snapshot.
     */
    async function updateRecord(
        id: string,
        uploadToken: string,
        compute: (fresh: GcsPersistedUpload) => GcsPersistedUpload | null,
    ): Promise<void> {
        await casMerge({
            read: () => readState(id),
            merge: (entry) => {
                const { state, generation } = recordOf(entry, uploadToken);
                const record = compute(state);
                return record === null ? null : { record, generation };
            },
            write: async (next) => {
                if (next === null) return;
                await bucket.file(infoName(id)).save(JSON.stringify(next.record), {
                    resumable: false,
                    preconditionOpts: { ifGenerationMatch: next.generation },
                });
            },
            isConflict: isGcsPreconditionFailed,
        });
    }

    /**
     * Apply a patch to the persisted state by the rules {@link casMerge}
     * states: terminal flags only turn on, and a recorded length and the
     * published ETag come from the fresh copy.
     *
     * The snapshot an append holds was read before the body streamed, which can
     * be minutes, and a holder whose lock was stolen in that time would write
     * back a record from before the new holder's changes; `isInvalidated` lives
     * only here and nothing recomputes it, so re-writing it away resurrects a
     * terminally dead upload. `accept` runs against the same fresh version the
     * write is pinned to, so a refusal it decides (by throwing, or by returning
     * false to write nothing) is decided on the record the write would replace.
     */
    async function persistState(
        id: string,
        uploadToken: string,
        patch: Partial<Pick<GcsPersistedUpload, "length" | "lastAppendAt" | "isInvalidated" | "isComplete" | "etag">>,
        accept?: (fresh: GcsPersistedUpload) => boolean,
    ): Promise<void> {
        await updateRecord(id, uploadToken, (fresh) =>
            accept?.(fresh) === false ? null : mergePersistedState(fresh, patch),
        );
    }

    /** A read's record: a missing one is not found, a corrupt one damage. */
    function recordOf(
        entry: Awaited<ReturnType<typeof readState>>,
        uploadToken: string,
    ): { state: GcsPersistedUpload; generation: number } {
        if (entry === undefined) throw new UploadNotFoundError(uploadToken);
        const { state, generation } = entry;
        if (!state) throw corruptUploadState(uploadToken);
        return { state, generation };
    }

    /** Read + validate the persisted state behind a token. Throws 404-shaped. */
    async function readUpload(uploadToken: string): Promise<{ state: GcsPersistedUpload; id: string }> {
        const id = decodeUploadId(uploadToken);
        const state = await downloadRecord(id, uploadToken);
        // Corrupt bookkeeping answers 404, marked as damage for the operator.
        // There is no key to reconcile here: the token carries none, so the
        // persisted key is the only one that exists.
        if (!state) throw corruptUploadState(uploadToken);
        return { state, id };
    }

    /**
     * The assembly the staging objects hold now: the newest running composite
     * and the chunks after it, ascending. A chunk or older composite at or
     * below the newest composite's index is already inside it and is never
     * counted twice; an object whose name is neither shape is foreign.
     */
    async function readPlan(id: string): Promise<GcsPlan> {
        const base = chunkPrefix(id);
        let fold: GcsPlanSource | undefined;
        const chunks: GcsPlanSource[] = [];
        for await (const entry of listObjects(base)) {
            const match = /^(f?)(\d+)$/.exec(entry.name.slice(base.length));
            if (!match) continue; // foreign object under the prefix: never ours to count
            const source = {
                name: entry.name,
                index: parseInt(match[2]!, 10),
                size: gcsSizeToNumber(entry.metadata?.size),
            };
            if (match[1] === "") chunks.push(source);
            else if (fold === undefined || source.index > fold.index) fold = source;
        }
        const covered = fold?.index ?? -1;
        const live = chunks.filter((chunk) => chunk.index > covered).toSorted((a, b) => a.index - b.index);
        const sources = fold ? [fold, ...live] : live;
        return {
            sources,
            length: sources.reduce((sum, source) => sum + source.size, 0),
            nextIndex: (sources.at(-1)?.index ?? -1) + 1,
        };
    }

    async function deleteObjects(names: string[]): Promise<void> {
        await Promise.all(names.map((name) => bucket.file(name).delete({ ignoreNotFound: true })));
    }

    /**
     * Delete every chunk and composite of one upload, and the compose
     * intermediates an older layout kept beside them; never the record.
     */
    async function deleteStagedObjects(id: string): Promise<void> {
        for (const staged of [chunkPrefix(id), composePrefix(id)]) {
            for await (const { name } of listObjects(staged)) await bucket.file(name).delete({ ignoreNotFound: true });
        }
    }

    /**
     * Drop every staging artifact of one upload (chunks, intermediates, info).
     *
     * The record goes LAST and is pinned to the generation read before the
     * listing. The record is the only thing that names this upload's chunks, so
     * removing it while an append is still landing them would leave those bytes
     * in the bucket with nothing able to reach them, which is a deletion that
     * reports success and retains data. Every append records what it wrote, so
     * a chunk that arrived after the listing also moved the generation and the
     * pinned delete is refused; the refusal repeats the pass, which now sees it.
     */
    async function deleteUploadArtifacts(id: string): Promise<void> {
        // The delete is the conditional write of no record at all.
        await casMerge({
            read: () => readState(id),
            merge: (entry) => entry,
            write: async (entry) => {
                if (entry === undefined) return; // already reclaimed: nothing names these artifacts
                await deleteStagedObjects(id);
                await bucket.file(infoName(id)).delete({ ignoreNotFound: true, ifGenerationMatch: entry.generation });
            },
            isConflict: isGcsPreconditionFailed,
        });
    }

    /**
     * Compose the first 32 sources into the running composite named for the
     * last index they cover, and return the sources with it in their place. A
     * composite holds every byte up to its index whichever grouping built it,
     * so one already at that name (an earlier attempt) is the same bytes, and
     * the write pinned to absence keeps it.
     */
    async function composeFold(id: string, sources: GcsPlanSource[]): Promise<GcsPlanSource[]> {
        const index = sources[Math.min(sources.length, GCS_MAX_COMPOSE_SOURCES) - 1]!.index;
        const fold = { name: foldName(id, index), index, size: 0 };
        try {
            await bucket.combine(
                sources.slice(0, GCS_MAX_COMPOSE_SOURCES).map((source) => source.name),
                fold.name,
                { ifGenerationMatch: 0 },
            );
        } catch (err) {
            if (!isGcsPreconditionFailed(err)) throw err;
        }
        return [fold, ...sources.slice(GCS_MAX_COMPOSE_SOURCES)];
    }

    /**
     * Fold the first 32 sources, note the composite in the record, then delete
     * what it replaced. The note is what refuses a stale append aimed at a
     * covered index, so the covered sources go only after it lands, and never
     * once the upload is sealed or terminal: a completion's plan may name them.
     */
    async function foldSources(id: string, uploadToken: string, sources: GcsPlanSource[]): Promise<void> {
        const { index } = (await composeFold(id, sources))[0]!;
        let noted = false;
        await updateRecord(id, uploadToken, (fresh) => {
            noted = !(fresh.seal || fresh.isComplete || fresh.isInvalidated);
            return noted && (fresh.folded ?? -1) < index ? { ...fresh, folded: index } : null;
        });
        if (noted) await deleteObjects(sources.slice(0, GCS_MAX_COMPOSE_SOURCES).map((source) => source.name));
    }

    /** The object at `key` (generation, etag, publication id), or `undefined` when there is none. */
    async function inspect(
        key: string,
    ): Promise<{ generation: number; etag?: string; publicationId?: string } | undefined> {
        try {
            const [meta] = await bucket.file(key).getMetadata();
            return {
                generation: generationOf(meta),
                etag: meta.etag,
                publicationId: meta.metadata?.[GCS_PUBLICATION_METADATA_KEY],
            };
        } catch (err) {
            if (isGcsNotFound(err)) return undefined;
            throw err;
        }
    }

    /** The object at `key` when it carries `seal`'s publication id, else `undefined`. */
    async function publishedAs(key: string, seal: GcsSeal): Promise<{ etag?: string } | undefined> {
        const found = await inspect(key);
        return found?.publicationId === seal.publicationId ? found : undefined;
    }

    /**
     * Mark the record completing at `length`. A seal at that length is resumed
     * as it stands; one at another length is re-pointed with a new publication
     * id, keeping the destination it recorded, because the key is allowed to be
     * replaced only in the state the FIRST seal found it in. Returns the seal,
     * or the settled answer when a completion recorded itself meanwhile.
     */
    async function sealUpload(
        id: string,
        uploadToken: string,
        key: string,
        length: number,
    ): Promise<{ seal: GcsSeal } | { settled: CompletedUpload }> {
        const destination = (await inspect(key))?.generation ?? 0;
        let outcome: { seal: GcsSeal } | { settled: CompletedUpload } | undefined;
        await updateRecord(id, uploadToken, (fresh) => {
            assertUploadWritable(fresh, "complete");
            if (fresh.isComplete) {
                outcome = { settled: { etag: fresh.etag } };
                return null;
            }
            if (fresh.seal?.length === length) {
                outcome = { seal: fresh.seal };
                return null;
            }
            const seal = { length, destination: fresh.seal?.destination ?? destination, publicationId: newUploadId() };
            outcome = { seal };
            return { ...fresh, seal };
        });
        return outcome!;
    }

    /** Lift `seal` if it is still the record's, so the upload resumes. */
    async function liftSeal(id: string, uploadToken: string, seal: GcsSeal): Promise<void> {
        await updateRecord(id, uploadToken, (fresh) => {
            if (fresh.seal?.publicationId !== seal.publicationId) return null;
            const { seal: _lifted, ...rest } = fresh;
            return rest;
        });
    }

    /**
     * Publish the sealed plan onto `key` in one conditional write carrying the
     * publication id. A refused precondition is a destination conflict unless
     * the key already carries this seal's id: a write whose response was lost
     * and that the client library retried.
     */
    async function publish(
        id: string,
        uploadToken: string,
        key: string,
        sources: GcsPlanSource[],
        seal: GcsSeal,
    ): Promise<{ etag?: string }> {
        const metadata = { metadata: { [GCS_PUBLICATION_METADATA_KEY]: seal.publicationId } };
        const preconditionOpts = { ifGenerationMatch: seal.destination };
        try {
            if (sources.length === 0) {
                // Compose needs at least one source; a single-shot write is atomic.
                await bucket.file(key).save(new Uint8Array(0), { resumable: false, preconditionOpts, metadata });
            } else {
                // Sources fold, 32 at a time, until one object holds the plan. The
                // seal stands from here on (only a snapshot mismatch lifts it, and
                // that comes first), so no append can aim at an index these
                // composites cover.
                while (sources.length > 1) sources = await composeFold(id, sources);
                await bucket.file(sources[0]!.name).copy(key, { preconditionOpts, metadata });
            }
        } catch (err) {
            if (!isGcsPreconditionFailed(err)) throw err;
            const ours = await publishedAs(key, seal);
            if (ours === undefined) throw new UploadDestinationConflictError(uploadToken, err);
            return ours;
        }
        // Read back by identity: a third party may overwrite the key the moment
        // the publish lands, and its etag is not this completion's.
        return (await publishedAs(key, seal)) ?? {};
    }

    /** Record the completion, then drop the staging objects (best-effort). */
    async function recordCompletion(
        id: string,
        uploadToken: string,
        length: number,
        etag: string | undefined,
    ): Promise<CompletedUpload> {
        await persistState(id, uploadToken, {
            isComplete: true,
            length,
            ...(etag !== undefined ? { etag } : {}),
        });
        // A staging object a delete cannot reach is garbage the sweep reaps (it
        // removes every staging artifact of a completed upload without touching
        // the key), never a reason to report the completion failed.
        await deleteStagedObjects(id).catch(() => undefined);
        return { etag };
    }

    return {
        exactOffsetRecovery: true,
        atomicCompletion: true,
        /** Every append verifies the claimed offset against durable state before writing. */
        enforcesOffsetCheck: true,
        digestOnComplete: false,
        uploadPrefix: prefix,

        async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
            createOpts.signal?.throwIfAborted();
            assertPublishable(createOpts.key);
            const id = newUploadId();
            const state: GcsPersistedUpload = {
                key: createOpts.key,
                length: createOpts.length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
                isComplete: false,
                isInvalidated: false,
            };
            // Pinned to absence: an id is minted fresh, so a record already at the
            // name is a collision the write must lose rather than replace.
            await bucket
                .file(infoName(id))
                .save(JSON.stringify(state), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
            return { uploadToken: id };
        },

        async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
            stateOpts?.signal?.throwIfAborted();
            const { state, id } = await readUpload(uploadToken);
            if (state.isInvalidated) {
                // Terminal: the offset is moot (the engine refuses every probe and
                // append, and the one verb still allowed, cancel, does not read it).
                return toStoredState(state, 0);
            }
            if (state.isComplete) {
                // Staging objects are deleted after publication; the published
                // object itself is the backend bookkeeping now.
                try {
                    const [meta] = await bucket.file(state.key).getMetadata();
                    return toStoredState(state, gcsSizeToNumber(meta.size));
                } catch (err) {
                    if (!isGcsNotFound(err)) throw err;
                    // Published object was deleted later; the completion answer stands,
                    // at the length the completion recorded. A record from before
                    // completions recorded a deferred length has no size to answer.
                    if (state.length === undefined) {
                        throw new Error("Completed upload recorded no length and its published object is gone");
                    }
                    return toStoredState(state, state.length);
                }
            }
            return toStoredState(state, (await readPlan(id)).length);
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            const admission = await admitAppend(body, appendOpts, async () => {
                const { state, id } = await readUpload(uploadToken);
                assertUploadWritable(state, "append");
                if (state.seal) throw new UploadOffsetConflictError(uploadToken, state.seal.length);
                const plan = await readPlan(id);
                // Required by the store contract: the lock serializes writers but cannot
                // prove the writer still holds it, so verifying the claim here is what
                // makes a stolen-lock write loud instead of silently interleaved. The
                // listing was needed anyway (next sequence number), so the check
                // against the durable sum costs nothing.
                if (offset !== plan.length) {
                    throw new UploadOffsetConflictError(uploadToken, plan.length);
                }
                return { state, id, plan };
            });
            if ("refused" in admission) return admission.refused;
            const { state, id, plan } = admission.admitted;
            const { nextIndex } = plan;

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

            // The abort check, the body-death handling and both byte ceilings live in
            // pumpUploadBody; what stays here is the only part that is GCS's, which is
            // the single-shot write stream and its backpressure.
            const {
                chunks: bodyChunks,
                outcome,
                finalize,
            } = pumpUploadBody(
                body,
                uploadToken,
                appendOpts,
                // The destroyed single-shot write leaves NO object behind, then the
                // invalidation is recorded durably so every later interaction refuses.
                async () => {
                    stream?.destroy(new Error("append crossed the engine's byte bound"));
                    await persistState(id, uploadToken, { isInvalidated: true });
                },
            );
            for await (const chunk of bodyChunks) {
                // Leaving on a stream failure sets none of the outcome flags, which is
                // correct: the throw below is the answer, not a byte count.
                if (streamFailure) break;
                if (!stream) {
                    // Pinned to absence. The next index was derived from a listing
                    // that can be minutes old by the time the first byte arrives: a
                    // holder whose lock was stolen in between would otherwise write
                    // its bytes over the chunk the winner already put at this index,
                    // and the listing would count the replacement at the winner's
                    // position. Refused, the stale write lands nothing.
                    stream = bucket.file(chunkName(id, nextIndex)).createWriteStream({
                        resumable: false,
                        preconditionOpts: { ifGenerationMatch: 0 },
                    });
                    stream.once("error", noteFailure);
                }
                if (!stream.write(chunk)) {
                    try {
                        await gcsOnceEvent(stream, "drain");
                    } catch {
                        break; // recorded by noteFailure; surfaced after the loop
                    }
                }
                written += chunk.length;
            }

            if (stream) {
                if (streamFailure) {
                    // A failed single-shot object write is atomic: nothing durable
                    // landed, so fail loudly and let fresh state tell the truth.
                    throw streamFailure instanceof Error
                        ? streamFailure
                        : new Error("GCS chunk write stream failed", { cause: streamFailure });
                }
                const finished = gcsOnceEvent(stream, "finish");
                stream.end();
                await finished;
            }
            // Deferred-length declaration: the first append to carry a length records
            // it in the `.info` object so the next getUploadState reports it and it
            // turns immutable. Only ever set once (the orchestrator guarantees it, and
            // the guard makes it safe): a length already recorded is never
            // overwritten. The write is awaited, so the length is durable before the ack.
            const declaresLength = appendOpts.length !== undefined && state.length === undefined;
            // The fence: the chunk is durable now, and the record write that
            // acknowledges it is decided on the version it replaces. A record
            // sealed, completed or invalidated since admission, or a composite
            // that already covers this index, refuses it, so an append either
            // landed before the seal (and the completion's listing counts it) or
            // is refused here; a check before the write alone would leave a third
            // order.
            // The resource was reaped while the body streamed, or refused the
            // chunk, and the chunk this call wrote is part of no plan: removing it
            // is what keeps a reap complete and a refusal unacknowledged. A delete
            // that fails throws in place of the refusal: nothing else reclaims the
            // orphan, so the failure must reach error reporting.
            const dropChunk = (): Promise<unknown> =>
                bucket.file(chunkName(id, nextIndex)).delete({ ignoreNotFound: true });
            let refused = false;
            let foldedPast = false;
            try {
                await persistState(
                    id,
                    uploadToken,
                    { ...(declaresLength ? { length: appendOpts.length } : {}), lastAppendAt: appendOpts.now },
                    (fresh) => {
                        refused = true;
                        assertUploadWritable(fresh, "append");
                        if (fresh.seal) throw new UploadOffsetConflictError(uploadToken, fresh.seal.length);
                        foldedPast = stream !== undefined && nextIndex <= (fresh.folded ?? -1);
                        refused = foldedPast;
                        return !foldedPast;
                    },
                );
            } catch (err) {
                if (stream && (refused || isUploadNotFoundError(err))) await dropChunk();
                throw err;
            }
            if (foldedPast) {
                await dropChunk();
                throw new UploadOffsetConflictError(uploadToken, (await readPlan(id)).length);
            }
            if (stream && plan.sources.length + 1 >= GCS_MAX_COMPOSE_SOURCES) {
                // Best-effort: the append is acknowledged already, and a fold that
                // fails leaves every source in place, so the next append retries it.
                const own = { name: chunkName(id, nextIndex), index: nextIndex, size: written };
                await foldSources(id, uploadToken, [...plan.sources, own]).catch(() => undefined);
            }
            // Reported only after the accepted prefix is durable: the resource is
            // untouched, so the client resumes from here in smaller chunks. The
            // claimed offset is the durable one: the check above refused any other.
            await finalize();
            if (outcome.ceilingHit) throw new UploadAppendBoundError(uploadToken, offset + (stream ? written : 0));
            return { bytesWritten: stream ? written : 0, interrupted: outcome.interrupted };
        },

        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            const { expectedLength, signal } = completeOpts;
            signal?.throwIfAborted();
            const id = decodeUploadId(uploadToken);
            const { state: current } = recordOf(await readState(id), uploadToken);
            assertUploadWritable(current, "complete");
            if (current.isComplete) return { etag: current.etag };
            if (completeOpts.expectedDigests !== undefined) {
                // Orchestrators gate on digestOnComplete === false and never hand a
                // digest here; a digest anyway is a caller bug, never silently ignored.
                throw new Error("gcsUploadStore cannot verify a completion digest (digestOnComplete is false)");
            }
            // RECORD recovery: a completion that published and then failed to
            // record left its seal; the object at the key is adopted only when it
            // carries that seal's publication id, never for its size.
            if (current.seal) {
                const ours = await publishedAs(current.key, current.seal);
                if (ours !== undefined) {
                    const completed = await recordCompletion(id, uploadToken, current.seal.length, ours.etag);
                    if (current.seal.length !== expectedLength) {
                        throw new UploadOffsetConflictError(uploadToken, current.seal.length);
                    }
                    return completed;
                }
            }
            // SEAL. From here every append is refused (see the fence in appendChunk).
            const sealed = await sealUpload(id, uploadToken, current.key, expectedLength);
            if ("settled" in sealed) return sealed.settled;
            const { seal } = sealed;
            // SNAPSHOT, taken only after the seal: no acknowledged append is missing
            // from it, and none can join it.
            const plan = await readPlan(id);
            if (plan.length !== expectedLength) {
                await liftSeal(id, uploadToken, seal);
                throw new UploadOffsetConflictError(uploadToken, plan.length);
            }
            signal?.throwIfAborted();
            // PUBLISH under the sealed destination generation.
            let published: { etag?: string };
            try {
                published = await publish(id, uploadToken, current.key, plan.sources, seal);
            } catch (err) {
                // A completion that resumed this seal and recorded itself while this
                // one assembled has published this plan and reaped its sources; its
                // record is the answer.
                const settled = await downloadRecord(id);
                if (settled?.isComplete) return { etag: settled.etag };
                throw err;
            }
            // RECORD.
            return recordCompletion(id, uploadToken, expectedLength, published.etag);
        },

        async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
            abortOpts?.signal?.throwIfAborted();
            const id = uploadIdForDiscard(uploadToken);
            if (id === null) return; // idempotent: the token named no resource
            // A completed upload is not decoded for: its published object lives
            // outside the staging prefix, and the staging artifacts (any chunk the
            // completion's cleanup could not reach, plus the record) are all that
            // is here to remove. An upload already aborted or swept has no record,
            // which the reclaim reads as nothing left to do.
            await deleteUploadArtifacts(id);
        },

        /**
         * Each resource is isolated and counted (see {@link sweepEach}). The
         * listing is paged and delimited at the prefix, so only the `.info`
         * records directly under it are read, one page at a time; chunk and
         * compose directories come back folded into prefixes and are never
         * expanded. A half-reclaimed resource still has its `.info`, so the
         * next pass finds it again and finishes the job.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            requireSweepCutoff(cutoff);
            return sweepEach(
                listObjects(`${prefix}/`, "/"),
                async (entry) => {
                    const id = entry.name.slice(`${prefix}/`.length, -".info".length);
                    // A foreign object under the prefix is not ours to reap.
                    if (!entry.name.endsWith(".info") || !UPLOAD_ID_RE.test(id)) return false;
                    const state = await downloadRecord(id);
                    // Another sweeper or an abort reclaimed it: nothing to alert on.
                    if (state === undefined) return false;
                    // Corrupt bookkeeping is already unusable (state reads answer 404),
                    // so it is swept regardless of age.
                    if (state && !isSweepable(cutoff, state.createdAt, state.lastAppendAt)) return false;
                    // The published object of a completed upload lives outside the
                    // staging prefix and is never touched; what is under it (a chunk
                    // the completion's cleanup could not reach, the record) all goes.
                    await deleteUploadArtifacts(id);
                    return true;
                },
                sweepOpts,
            );
        },
    };
}
