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
    buildContentDisposition,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
    type StoreErrorClassifiers,
    isSha256Base64,
    reservedKeyGuard,
    representationCoding,
    type KeyPolicy,
} from "./index.ts";
import { BUCKET_KEY_MAX_BYTES, failRead, isInstance, readPath, retryAfterFrom } from "./object-store.ts";
import { gcsCode, isGcsNotFound, isGcsPreconditionFailed } from "./gcs-errors.ts";

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
export interface GcsStorage {
    bucket(name: string): GcsBucket;
}

export interface GcsBucket {
    file(name: string, opts?: { generation?: string | number }): GcsFile;
}

export interface GcsFile {
    getMetadata(): Promise<[GcsFileMetadata]>;
    createReadStream(opts?: {
        start?: number;
        end?: number;
        /**
         * Pass `false` to receive the stored bytes. The client library
         * otherwise gunzips a gzip-encoded object in flight, so the stream
         * would not match `size`.
         */
        decompress?: boolean;
    }): NodeJS.ReadableStream & AsyncIterable<Buffer>;
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
    /** The stored `Content-Encoding`; `size` counts these encoded bytes. */
    contentEncoding?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface GcsStoreOptions {
    /**
     * Key prefixes this store refuses to serve, because they are where a
     * partial-content 5.x upload store sharing this location keeps its
     * in-flight bytes and the records naming their destination keys. Keys at
     * or under one answer {@link ObjectNotFoundError}. Set to `""` when no
     * upload store shares the location.
     * @default ".partial-content-uploads/"
     */
    reservedPrefix?: string | readonly string[];
    /**
     * Whether a key with an empty or dot segment is refused. The GCS client
     * percent-encodes the whole object name, `/` included, so no URL path is
     * resolved from a key and every key names exactly the object it spells.
     * @default "verbatim"
     */
    keys?: KeyPolicy;
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
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? ".partial-content-uploads/", {
        keys: opts.keys ?? "verbatim",
        maxKeyBytes: BUCKET_KEY_MAX_BYTES,
    });
    const { digestMetadataKey } = opts;

    return {
        supportsRange: true,
        // A read is pinned to a generation, or its etag is compared before the
        // stream opens; either way a changed object throws ObjectChangedError.
        pinsReads: true,

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
                contentEncoding: described.contentEncoding,
                // A generation names an immutable object version, so it can carry
                // everything getObject would otherwise re-fetch. No generation
                // (emulators, mocks) means no pin: getObject falls back to its own
                // metadata read.
                pin: described.generation !== undefined ? JSON.stringify(described) : undefined,
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ReadRange; signal?: AbortSignal; ifMatch?: string; pin?: string },
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
            const { generation, size: totalSize, etag, lastModified, digest, contentEncoding } = described;

            if (range && range.start >= totalSize) {
                // Unsatisfiable ranges are the orchestrator's job to reject
                // (parseRangeHeader 416s them first); a direct caller gets a loud
                // error instead of a truncated body under an inflated Content-Length.
                throw new RangeError(`gcsStore: range start is past the ${totalSize}-byte object`);
            }
            // Clamp the end so contentLength and the reported range match what
            // the backend stream will actually deliver (createReadStream clamps
            // to EOF silently; the reported bounds must not diverge from it).
            const end = Math.min(range?.end ?? totalSize - 1, totalSize - 1);
            // Always the stored bytes: `size`, ranges, validators and digest all
            // describe them, so the client library must not decode in flight.
            const streamOpts = readOptions(range && { start: range.start, end });

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
                contentEncoding,
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
                const message = isInstance(err, Error) ? readPath(err, "message") : undefined;
                if (typeof message !== "string" || !/client_email/.test(message)) throw err;
                return { ok: false, error: message, code: "no-credential", cause: err };
            }
            // Signing may make an IAM round trip the SDK cannot cancel; a caller
            // that stopped waiting gets its abort, not a URL.
            signOpts.signal?.throwIfAborted();
            return { ok: true, url };
        },
    };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** A size a store may report: a non-negative safe integer. */
function isCount(v: unknown): v is number {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * An object's size: a decimal string in real GCS responses, tolerated as a
 * number. Served lengths are built from it, so an absent or unparseable size
 * fails the call. Read as zero or as its leading digits, it would frame a body
 * at the wrong length.
 */
function gcsSizeToNumber(size: string | number | undefined): number {
    const n = typeof size === "string" && /^\d+$/.test(size) ? Number(size) : size;
    if (!isCount(n)) throw new Error("GCS returned an object without a usable size");
    return n;
}

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
    /** The stored content coding, normalized by {@link representationCoding}. */
    contentEncoding?: string;
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
        contentEncoding: representationCoding(metadata.contentEncoding),
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
            isAbsentOr(candidate.etag, isString) &&
            isAbsentOr(candidate.lastModified, isString) &&
            // The digest is emitted inside `Repr-Digest: sha-256=:...:`; only the
            // exact raw-base64 SHA-256 shape validated at encode time is trusted.
            isAbsentOr(candidate.digest, isSha256Base64) &&
            // The coding is emitted as `Content-Encoding`: only a value that
            // survives the same normalization a metadata read applies is trusted.
            isAbsentOr(candidate.contentEncoding, isStoredCoding)
        ) {
            return candidate as unknown as GcsPin;
        }
    } catch {
        /* not our token: revalidate via metadata instead */
    }
    return null;
}

const isString = (value: unknown): value is string => typeof value === "string";

/** An optional pin field: absent, or passing its own check. */
function isAbsentOr(value: unknown, check: (v: unknown) => boolean): boolean {
    return value === undefined || check(value);
}

/** The stream options for a read: the clamped span, if any, and never in-flight decoding. */
function readOptions(span: { start: number; end: number } | undefined) {
    return { ...span, decompress: false };
}

/** Whether a pin field is a normalized, non-identity content-coding list. */
function isStoredCoding(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        return representationCoding(value) === value;
    } catch {
        return false;
    }
}

/** A GCS generation is a non-empty string or a finite number; nothing else. */
function isValidGeneration(gen: unknown): gen is string | number {
    return (typeof gen === "string" && gen.length > 0) || (typeof gen === "number" && Number.isFinite(gen));
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
    const hint = retryAfterFrom(readPath(err, "response", "headers"));
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
        // An abort outranks whatever the aborted read happened to throw.
        failRead(destroy, signal?.aborted ? signal.reason : err);
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
