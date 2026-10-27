/**
 * Azure Blob Storage ObjectStore adapter for partial-content.
 *
 * Wraps `@azure/storage-blob` to implement the {@link ObjectStore} interface.
 *
 * @example
 * ```typescript
 * import { BlobServiceClient } from "@azure/storage-blob";
 * import { azureStore } from "partial-content/azure";
 *
 * const client = BlobServiceClient.fromConnectionString(connectionString);
 * const store = azureStore({
 *   containerClient: client.getContainerClient("documents"),
 * });
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
    guardStreamLength,
    resolveServedRange,
    parseRetryAfterSeconds,
    buildContentDisposition,
    isOpenEndedRange,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ParsedRange,
    type StoreErrorClassifiers,
    reservedKeyGuard,
} from "./index.ts";
import { casMerge, mergePersistedState } from "./cas-merge.ts";
import { sweepEach } from "./sweep-each.ts";
import {
    UploadNotFoundError,
    isUploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
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
import {
    assertUploadWritable,
    base64UrlToBytes,
    bytesToBase64Url,
    decodeUploadId,
    uploadIdForDiscard,
    newUploadId,
    isSweepable,
    requireSweepCutoff,
    admitAppend,
    pumpUploadBody,
    publishKeyGuard,
    toStoredState,
    validatePersistedUploadShape,
    isCount,
    corruptUploadState,
    type PersistedUpload,
    DEFAULT_UPLOAD_PREFIX,
} from "./upload-internals.ts";

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

// ─── Azure Types ────────────────────────────────────────────────────────────

/**
 * Minimal Azure ContainerClient interface.
 *
 * Declared locally to avoid a hard dependency on `@azure/storage-blob`.
 * Users who import `partial-content/azure` will have it installed as an
 * optional peer dependency.
 */
export interface AzureContainerClient {
    getBlobClient(blobName: string): AzureBlobClient;
}

export interface AzureBlobClient {
    getProperties(options?: { abortSignal?: AbortSignal }): Promise<AzureBlobProperties>;
    download(
        offset?: number,
        count?: number,
        options?: { conditions?: { ifMatch?: string }; abortSignal?: AbortSignal },
    ): Promise<AzureBlobDownloadResponse>;
    generateSasUrl(options: AzureGenerateSasUrlOptions): Promise<string>;
}

/**
 * The read-signing subset of the SDK's `BlobGenerateSasUrlOptions`. The
 * content* / cacheControl fields are the SAS response-header overrides
 * (`rscd`/`rsct`/`rscc` query parameters) honored on the signed GET.
 */
export interface AzureGenerateSasUrlOptions {
    /**
     * SAS permission set. The SDK normalizes this by calling `toString()` and
     * re-parsing (`BlobSASPermissions.parse`, which validates the characters),
     * so a minimal read-only stringifier satisfies the contract without a
     * top-level SDK import.
     */
    permissions: { toString(): string };
    expiresOn: Date;
    contentDisposition?: string;
    contentType?: string;
    cacheControl?: string;
}

export interface AzureBlobProperties {
    contentLength?: number;
    etag?: string;
    lastModified?: Date;
}

export interface AzureBlobDownloadResponse {
    readableStreamBody?: NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy?: () => void };
    blobBody?: Promise<Blob>;
    contentLength?: number;
    /** Present on ranged downloads: "bytes 5-9/20". Carries the total size. */
    contentRange?: string;
    etag?: string;
    lastModified?: Date;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface AzureStoreOptions {
    /**
     * Key prefix this store refuses to serve, because it is where an upload
     * store sharing this location keeps its in-flight bytes and the sidecars
     * naming their destination keys. Keys at or under it answer
     * {@link ObjectNotFoundError}. Set to `""` when no upload store shares it.
     * @default ".partial-content-uploads/"
     */
    reservedPrefix?: string;
    /** Pre-configured Azure ContainerClient. */
    containerClient: AzureContainerClient;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an {@link ObjectStore} backed by an Azure Blob Storage container.
 *
 * @example
 * ```typescript
 * import { BlobServiceClient } from "@azure/storage-blob";
 * import { azureStore } from "partial-content/azure";
 *
 * const blobService = BlobServiceClient.fromConnectionString(conn);
 * const store = azureStore({
 *   containerClient: blobService.getContainerClient("documents"),
 * });
 *
 * const meta = await store.headObject("reports/q4.pdf");
 * ```
 */
export function azureStore(opts: AzureStoreOptions): ObjectStore {
    const { containerClient } = opts;
    const assertReadable = reservedKeyGuard(opts.reservedPrefix ?? DEFAULT_UPLOAD_PREFIX);

    return {
        supportsRange: true,
        // 206 bounds/total come from Azure's actual contentRange: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,

        async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
            assertReadable(key);
            opts?.signal?.throwIfAborted();
            // Forward the signal so a client disconnect during the request/header
            // phase cancels the Azure call (the pre-check only covers already-aborted;
            // the body phase is covered by nodeStreamToWeb's signal wiring).
            const props = await classifyStoreRead(
                key,
                () => containerClient.getBlobClient(key).getProperties({ abortSignal: opts?.signal }),
                azureClassifiers,
            );

            if (props.contentLength == null) {
                throw new Error(`Azure getProperties returned no contentLength`);
            }

            return {
                contentLength: props.contentLength,
                etag: props.etag,
                lastModified: props.lastModified?.toUTCString(),
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, signal, ifMatch } = opts ?? {};
            signal?.throwIfAborted();

            // Single round-trip: download() carries everything needed. For ranged
            // reads the response's Content-Range ("bytes 5-9/20") supplies the
            // total size; for full reads contentLength IS the total. One response
            // also means one representation -- no metadata/body race to guard.
            const offset = range ? range.start : 0;
            // An open-ended fast-path range (OPEN_ENDED sentinel end) reads to the
            // end of the blob: leave count undefined so download() streams the
            // tail rather than requesting ~9e15 bytes.
            const count = range && !isOpenEndedRange(range) ? range.end - range.start + 1 : undefined;

            const response = await classifyStoreRead(
                key,
                () =>
                    containerClient.getBlobClient(key).download(offset, count, {
                        // Pin the read to the validated representation: Azure rejects
                        // with 412 ConditionNotMet if the blob changed since HEAD.
                        ...(ifMatch ? { conditions: { ifMatch } } : {}),
                        // Forward the signal so the request/header phase is cancellable too.
                        abortSignal: signal,
                    }),
                azureClassifiers,
            );

            if (response.contentLength == null) {
                destroyAzureDownload(response);
                throw new Error(`Azure download returned no contentLength`);
            }
            const contentLength = response.contentLength;
            const resolved = response.contentRange ? resolveServedRange(response.contentRange) : null;
            // A Content-Range Azure emits but the resolver cannot parse means the
            // byte accounting is untrustworthy: release the live socket and fail
            // loudly rather than guess.
            if (response.contentRange && !resolved) {
                destroyAzureDownload(response);
                throw new Error(`Azure returned unparseable Content-Range: ${response.contentRange}`);
            }
            // For a full read (no Content-Range) contentLength IS the total; a ranged
            // read carries the resolver's honest total (undefined for `bytes a-b/*`).
            const totalSize = resolved ? resolved.totalSize : contentLength;

            // Azure SDK returns different body types depending on the environment
            let webStream: ReadableStream<Uint8Array<ArrayBuffer>>;
            if (response.readableStreamBody) {
                // Node.js environment: use shared stream conversion
                const nodeStream = response.readableStreamBody;
                // nodeStreamToWeb auto-detects the stream's destroy() capability.
                // expectedBytes guards a graceful short-read: the Azure SDK can end
                // readableStreamBody cleanly when its in-stream retries are exhausted
                // mid-download, which would otherwise under-run the committed
                // Content-Length undetected.
                webStream = nodeStreamToWeb(nodeStream, { signal, expectedBytes: contentLength });
            } else if (response.blobBody) {
                // Browser environment: guard the buffered blob's byte count against the
                // committed length for parity with the Node path's expectedBytes check.
                const blob = await response.blobBody;
                webStream = guardStreamLength(blob.stream() as ReadableStream<Uint8Array>, contentLength);
            } else {
                throw new Error(`Azure download returned no body`);
            }

            return {
                body: webStream,
                contentLength,
                totalSize,
                // The bounds Azure ACTUALLY served, from its response Content-Range.
                range: resolved ? resolved.served : undefined,
                etag: response.etag,
                lastModified: response.lastModified?.toUTCString(),
            };
        },

        async createSignedUrl(key: string, signOpts: AzureSignOptions): Promise<AzureSignResult> {
            assertReadable(key);
            signOpts.signal?.throwIfAborted();
            // A signed URL is a 302 redirect target: the client fetches bytes
            // DIRECTLY from Azure, bypassing the serve route's security headers
            // (nosniff, CSP, CORP). Force a download disposition AND an inert
            // content type so a stored SVG/HTML polyglot cannot render inline off
            // the header-less origin response. All three overrides ride the SAS
            // token as signed response-header parameters; the stored blob is
            // untouched. `downloadFilename` only customizes the name.
            //
            // Signing needs a client constructed with a shared-key credential;
            // without one the SDK refuses with a RangeError naming it. That is
            // "this store cannot sign here", answered { ok: false } so the caller
            // streams instead. Every other failure is a signer that should have
            // worked, and throws.
            let url: string;
            try {
                url = await containerClient.getBlobClient(key).generateSasUrl({
                    permissions: READ_ONLY_SAS_PERMISSIONS,
                    expiresOn: new Date(Date.now() + signOpts.expiresInSeconds * 1000),
                    contentType: "application/octet-stream",
                    contentDisposition: buildContentDisposition(signOpts.downloadFilename ?? "download", {
                        type: "attachment",
                    }),
                    // Response-header override, not a blob mutation: keeps a private
                    // document's caching policy authoritative even when the blob was
                    // uploaded with a public Cache-Control (the CDN-caches-your-private
                    // -file footgun).
                    ...(signOpts.cacheControl ? { cacheControl: signOpts.cacheControl } : {}),
                });
            } catch (err) {
                if (!(err instanceof RangeError && /shared key credential/.test(err.message))) throw err;
                return { ok: false, error: err.message, code: "no-credential", cause: err };
            }
            // Generation is synchronous in the SDK, but an abort that landed while
            // it ran must not hand back a URL the caller stopped waiting for.
            signOpts.signal?.throwIfAborted();
            return { ok: true, url };
        },
    };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** {@link ObjectStore.createSignedUrl}'s options, with the abort signal it honours. */
interface AzureSignOptions {
    expiresInSeconds: number;
    downloadFilename?: string;
    cacheControl?: string;
    signal?: AbortSignal;
}

/** `{ ok: false }` only when this client cannot sign; a failed signing throws. */
type AzureSignResult = Awaited<ReturnType<NonNullable<ObjectStore["createSignedUrl"]>>>;

/**
 * Read-only SAS permission set ("r"): a signed download URL must never grant
 * write/delete. Shaped as a stringifier because the SDK's SAS generation
 * validates permissions via `BlobSASPermissions.parse(permissions.toString())`
 * (see {@link AzureGenerateSasUrlOptions.permissions}).
 */
const READ_ONLY_SAS_PERMISSIONS = Object.freeze({ toString: () => "r" });

/**
 * Azure `RestError`'s numeric HTTP status, when present. This is the
 * AUTHORITATIVE classification signal: when a numeric `statusCode` exists, the
 * classifiers key off it exactly and never fall through to message heuristics,
 * so a `503 ServerBusy` whose message text happens to contain "412" (a request
 * id or timestamp digit run) can never be misread as a 412. A present-but-
 * non-numeric status returns `undefined` so the code/message fallback still runs.
 */
function azureStatusCode(err: unknown): number | undefined {
    if (typeof err === "object" && err !== null && "statusCode" in err) {
        const s = (err as { statusCode: unknown }).statusCode;
        if (typeof s === "number") return s;
    }
    return undefined;
}

/**
 * Azure `RestError`'s stable error code (`BlobNotFound`, `ConditionNotMet`,
 * `ServerBusy`, ...). Matched exactly, so unlike a message substring it cannot
 * collide with arbitrary text in the error message.
 */
function azureErrorCode(err: unknown): string | undefined {
    if (typeof err === "object" && err !== null && "code" in err) {
        const c = (err as { code: unknown }).code;
        if (typeof c === "string") return c;
    }
    return undefined;
}

function isAzureNotFound(err: unknown): boolean {
    const status = azureStatusCode(err);
    if (status !== undefined) return status === 404;
    if (azureErrorCode(err) === "BlobNotFound") return true;
    return err instanceof Error && err.name === "RestError" && err.message.includes("BlobNotFound");
}

/**
 * Release Azure's live download socket before bailing out on a malformed
 * response. `download()` resolves once headers arrive with an OPEN
 * `readableStreamBody`; throwing before that stream is handed to
 * `nodeStreamToWeb` would leak the socket (and its connection-pool slot)
 * until GC. The browser `blobBody` path buffers in memory and needs no
 * teardown.
 */
function destroyAzureDownload(response: AzureBlobDownloadResponse): void {
    response.readableStreamBody?.destroy?.();
}

/**
 * Check if an Azure error is a failed ifMatch condition (blob changed).
 * The SDK surfaces this as a RestError with statusCode 412 (ConditionNotMet).
 * A numeric status is authoritative; the `code`/message fallback only runs for
 * status-less shapes, so a throttle carrying "412" in its message text is never
 * misreported as a precondition failure.
 */
function isAzurePreconditionFailed(err: unknown): boolean {
    const status = azureStatusCode(err);
    if (status !== undefined) return status === 412;
    if (azureErrorCode(err) === "ConditionNotMet") return true;
    return err instanceof Error && err.name === "RestError" && err.message.includes("ConditionNotMet");
}

/**
 * Whether a conditional commit was refused because of the blob at the key:
 * an `If-Match` or `If-None-Match` the service evaluated false (412), or the
 * 409 `BlobAlreadyExists` it may answer a create-only write with. Any other
 * 409 (a lease, an immutability policy) is a failure, not a precondition.
 */
function isAzureDestinationRefusal(err: unknown): boolean {
    return (
        isAzurePreconditionFailed(err) || (azureStatusCode(err) === 409 && azureErrorCode(err) === "BlobAlreadyExists")
    );
}

/**
 * The back-off Azure advises on a throttle, parsed from the `Retry-After`
 * response header (whole seconds; the HTTP-date form is ignored). Surfaced so
 * the 503 echoes it and shared caches wait the advised interval.
 */
function azureRetryAfterSeconds(err: unknown): number | undefined {
    const headers = (err as { response?: { headers?: { get?: (name: string) => string | undefined } } }).response
        ?.headers;
    // The classifier runs on arbitrary (S3-compatible/proxy) error shapes, so
    // harden the structural access: optional-call guards only null/undefined, but
    // a truthy non-function `.get` would throw, and a throwing `.get` propagates
    // -- either way the thrown error would replace the throttle and turn a 429/503
    // into a 502. Gate on the type and swallow a throwing getter.
    const get = headers?.get;
    if (typeof get !== "function") return undefined;
    let raw: string | undefined;
    try {
        raw = get.call(headers, "retry-after");
    } catch {
        return undefined;
    }
    return parseRetryAfterSeconds(raw);
}

/**
 * Whether an Azure error is a transient throttle/overload the client should
 * retry (mapped to a 503, not a 502). Azure's retryable transients are
 * `ServerBusy` (HTTP 503) and `OperationTimedOut` (HTTP **500**), so they are
 * matched by ERROR CODE first: keying only off the numeric status would demote
 * `OperationTimedOut` to a non-retryable 502 (500 is neither 429 nor 503). A
 * numeric 429/503 still catches throttles that arrive without a code, and the
 * message fallback (gated on a status-less shape) preserves the classifier's
 * exclusivity -- a 503 whose message merely contains "412" is classified by
 * code/status, never by substring. Returns the advised `Retry-After` when set.
 */
function isAzureThrottled(err: unknown): boolean | { retryAfterSeconds: number } {
    const code = azureErrorCode(err);
    const status = azureStatusCode(err);
    const throttled =
        code === "ServerBusy" ||
        code === "OperationTimedOut" ||
        status === 429 ||
        status === 503 ||
        (status === undefined &&
            err instanceof Error &&
            err.name === "RestError" &&
            (err.message.includes("ServerBusy") || err.message.includes("OperationTimedOut")));
    if (!throttled) return false;
    const retryAfterSeconds = azureRetryAfterSeconds(err);
    return retryAfterSeconds !== undefined ? { retryAfterSeconds } : true;
}

/** The ordered error-classification set shared by getProperties and download. */
const azureClassifiers: StoreErrorClassifiers = {
    notFound: isAzureNotFound,
    changed: isAzurePreconditionFailed,
    throttled: isAzureThrottled,
};

// ─── Resumable Upload: Azure Types ──────────────────────────────────────────

/**
 * The container surface the upload store needs. Declared locally (like the
 * read side's {@link AzureContainerClient}) to avoid a hard dependency on
 * `@azure/storage-blob`; the real `ContainerClient` satisfies it structurally.
 */
interface AzureUploadContainerClient {
    getBlockBlobClient(blobName: string): AzureBlockBlobClient;
    listBlobsFlat(options?: {
        prefix?: string;
        includeMetadata?: boolean;
    }): AsyncIterable<{ name: string; metadata?: Record<string, string> }>;
}

/** The block-blob subset used for staging, committing, and bookkeeping. */
interface AzureBlockBlobClient {
    stageBlock(
        blockId: string,
        body: Uint8Array,
        contentLength: number,
        options?: { abortSignal?: AbortSignal },
    ): Promise<unknown>;
    commitBlockList(
        blocks: string[],
        options?: {
            conditions?: { ifNoneMatch?: string; ifMatch?: string };
            metadata?: Record<string, string>;
            abortSignal?: AbortSignal;
        },
    ): Promise<{ etag?: string }>;
    getBlockList(listType: "all", options?: { abortSignal?: AbortSignal }): Promise<AzureBlockList>;
    upload(
        body: string,
        contentLength: number,
        options?: { metadata?: Record<string, string>; abortSignal?: AbortSignal },
    ): Promise<unknown>;
    getProperties(options?: { abortSignal?: AbortSignal }): Promise<{
        metadata?: Record<string, string>;
        etag?: string;
        contentLength?: number;
    }>;
    setMetadata(
        metadata: Record<string, string>,
        options?: { conditions?: { ifMatch?: string }; abortSignal?: AbortSignal },
    ): Promise<unknown>;
    deleteIfExists(options?: { conditions?: { ifMatch?: string }; abortSignal?: AbortSignal }): Promise<unknown>;
}

interface AzureBlockList {
    committedBlocks?: Array<{ name?: string; size?: number }>;
    uncommittedBlocks?: Array<{ name?: string; size?: number }>;
}

// ─── Resumable Upload: Options ──────────────────────────────────────────────

export interface AzureUploadStoreOptions {
    /** Pre-configured Azure ContainerClient. */
    containerClient: AzureUploadContainerClient;
    /**
     * Blob-name prefix for the store's `.info` bookkeeping blobs. Data blocks
     * are NOT stored under this prefix: Azure stages uncommitted blocks on the
     * final blob itself, so only the small metadata blobs live here.
     */
    uploadPrefix?: string;
    /**
     * Flush threshold in bytes for staging blocks (default 8 MiB). Incoming
     * body chunks accumulate until at least this many bytes are buffered, then
     * stage as one block. Azure accepts arbitrary block sizes (up to 4000 MiB),
     * so this only bounds adapter memory; appends stay byte-exact.
     */
    blockSize?: number;
    /**
     * What an abort or a sweep does with the blocks an unfinished upload
     * staged on its destination blob.
     *
     * `"age-out"` (the default) leaves them to the service, which discards
     * uncommitted blocks seven days after they were staged. Staged blocks are
     * never readable, so they are retained bytes, not exposed ones; size a
     * storage-limitation schedule to that seven-day ceiling. Nothing is ever
     * created, committed or deleted at the destination key.
     *
     * `"commit-empty"` reclaims them at once. Azure has no operation that
     * drops staged blocks alone, so the store commits an empty block list
     * create-only (`If-None-Match: *`, refused when a committed blob is at the
     * key) and deletes the zero-byte blob that commit created, pinned to its
     * ETag. That blob is a real write at the destination key, and each of its
     * consequences is the caller's to accept: it is briefly readable there; it
     * raises `BlobCreated` (Event Grid, change feed), so a pipeline that
     * ingests on creation sees an empty document for every cancelled upload;
     * container versioning or soft delete keeps a copy; and on a container
     * under a time-based retention policy or legal hold the delete is refused,
     * which leaves the empty blob at the key and fails the abort (a sweep
     * counts it as `failed`).
     * @default "age-out"
     */
    discardStaged?: "age-out" | "commit-empty";
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

const AZURE_DEFAULT_BLOCK_SIZE = 8 * 1024 * 1024;
/** Azure caps a block blob at 50,000 committed blocks. */
const AZURE_MAX_BLOCK_INDEX = 49_999;
/** Blob-metadata key carrying the persisted upload state (base64url JSON). */
const AZURE_STATE_METADATA_KEY = "pcuploadstate";
/**
 * Blob-metadata key the commit writes on the published blob: the sealed
 * plan's publication id. Recovery adopts a blob at the key as this upload's
 * only when it carries the id the seal recorded.
 */
const AZURE_PUBLICATION_METADATA_KEY = "pcpublication";

/**
 * Block-id scheme: base64 of a 12-character raw id, `p` + a 6-character
 * SEGMENT derived from the upload id + a zero-padded 5-digit sequence number.
 *
 * Blocks stage on the FINAL blob, where every upload to the key shares one
 * uncommitted namespace. The segment is what keeps two uploads to one key
 * apart: the derivation counts, commits and heals from the blocks carrying
 * this upload's segment only, so another upload's blocks are never summed
 * into this one's offset, never listed in its commit and never overwritten by
 * its sequence numbers. The segment carries 36 bits of the upload id, which
 * is unguessable, so a collision is not something a second uploader to the
 * key can arrange.
 *
 * Azure requires every block id on a blob to be the same length, and the raw
 * width is the one earlier releases used, so a blob still carrying blocks
 * staged by one of those accepts these ids until those blocks age out. Those
 * blocks carry no segment and are foreign to every upload: an upload that was
 * in flight across the upgrade reads as lost, never as someone else's bytes.
 */
const AZURE_BLOCK_RAW_PREFIX = "p";
const AZURE_BLOCK_SEGMENT_LENGTH = 6;
const AZURE_BLOCK_INDEX_DIGITS = 5;
/** 64 symbols, none of them `-`, so no segment reads as part of an earlier release's `pcblk-` id. */
const AZURE_BLOCK_SEGMENT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_~";
/** The sentinel's suffix: as wide as an index, never digits, so it parses as no data block. */
const AZURE_SENTINEL_SUFFIX = "anchr";

/** The block-id segment of an upload: the id's first 36 bits, six symbols wide. */
function azureBlockSegment(id: string): string {
    let value = parseInt(id.replace(/-/g, "").slice(0, 9), 16);
    let segment = "";
    for (let i = 0; i < AZURE_BLOCK_SEGMENT_LENGTH; i += 1) {
        segment = AZURE_BLOCK_SEGMENT_ALPHABET[value % 64] + segment;
        value = Math.floor(value / 64);
    }
    return segment;
}

function azureDataBlockId(segment: string, index: number): string {
    return btoa(AZURE_BLOCK_RAW_PREFIX + segment + String(index).padStart(AZURE_BLOCK_INDEX_DIGITS, "0"));
}

/**
 * The creation-time sentinel block's id: this upload's segment with a
 * non-numeric suffix, so it collides with no data block of this upload and
 * belongs to no other upload.
 */
function azureSentinelBlockId(segment: string): string {
    return btoa(AZURE_BLOCK_RAW_PREFIX + segment + AZURE_SENTINEL_SUFFIX);
}

/**
 * Parse a listed block name back to this upload's data index; null for
 * anything else (the sentinel, another upload's block, a foreign writer's).
 */
function azureParseDataBlockIndex(name: string | undefined, segment: string): number | null {
    if (!name) return null;
    let raw: string;
    try {
        raw = atob(name);
    } catch {
        return null;
    }
    const owned = AZURE_BLOCK_RAW_PREFIX + segment;
    if (!raw.startsWith(owned)) return null;
    const digits = raw.slice(owned.length);
    if (digits.length !== AZURE_BLOCK_INDEX_DIGITS || !/^\d+$/.test(digits)) return null;
    return parseInt(digits, 10);
}

/**
 * The blocks this upload has ACCEPTED, as a prefix: `blocks` is the count of
 * data-block indexes acknowledged so far (the next index to stage), `bytes`
 * their total. Recorded in the info blob under the same conditional write as
 * the rest of the state, it is what a holder whose lock was stolen while its
 * body streamed is checked against: staging index N once more would REPLACE
 * the block the new holder already had acknowledged, and Azure's block list
 * cannot tell the two apart afterwards.
 *
 * A listing that runs AHEAD of the ledger is a block staged by an append that
 * crashed before recording it; it is counted, as it always was. A listing that
 * disagrees INSIDE the ledger (fewer blocks, or another byte total across the
 * accepted indexes) is a block that was replaced under an acknowledged write,
 * and the upload is invalidated rather than published.
 *
 * Creation records the empty ledger, so a record without one predates it:
 * how many bytes such an upload accepted is unknown, never zero.
 */
interface AzureStagedLedger {
    blocks: number;
    bytes: number;
}

/**
 * A completion's sealed plan, written into the record under the same
 * conditional write as the rest of it before any block list is read for the
 * commit. While it is present no append is acknowledged (see
 * {@link refuseSealed}), so the block list taken after it holds every
 * acknowledged byte and nothing an acknowledged append could still add.
 *
 * - `length`: the length the plan publishes, the completer's acknowledged
 *   length.
 * - `publicationId`: random, minted at the first seal and kept by every
 *   later one; the commit writes it into the published blob's metadata, and
 *   it is the only evidence recovery accepts that a blob at the key is this
 *   upload's.
 * - `destinationEtag`: the committed blob at the key when the plan was first
 *   sealed, or `null` when there was none. The commit is conditioned on it
 *   (`If-Match`, or `If-None-Match: *` for `null`), so a key someone wrote
 *   after the seal is never overwritten. A later seal keeps it: re-reading
 *   the key would bless whatever a third party wrote in between.
 */
interface AzureSeal {
    length: number;
    publicationId: string;
    destinationEtag: string | null;
}

/** The committed blob at an upload's key, as a seal and a recovery read it. */
interface AzureDestination {
    etag: string;
    contentLength: number;
    /** The publication id the commit that made it wrote, when one did. */
    publicationId: string | undefined;
}

/** Durable upload bookkeeping, persisted as info-blob metadata. */
type AzurePersistedUpload = PersistedUpload & { staged?: AzureStagedLedger; completing?: AzureSeal };

function encodeAzurePersistedUpload(state: AzurePersistedUpload): string {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(state)));
}

function isAzureStagedLedger(v: unknown): v is AzureStagedLedger {
    return (
        typeof v === "object" &&
        v !== null &&
        isCount((v as Record<string, unknown>).blocks) &&
        isCount((v as Record<string, unknown>).bytes)
    );
}

function isAzureSeal(v: unknown): v is AzureSeal {
    if (typeof v !== "object" || v === null) return false;
    const c = v as Record<string, unknown>;
    return (
        isCount(c.length) &&
        typeof c.publicationId === "string" &&
        c.publicationId.length > 0 &&
        (c.destinationEtag === null || typeof c.destinationEtag === "string")
    );
}

/** Decode + shape-validate persisted state; null for corrupt values. */
function decodeAzurePersistedUpload(raw: string | undefined): AzurePersistedUpload | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
        const state = validatePersistedUploadShape(parsed);
        if (!state) return null;
        const { staged, completing } = parsed as Record<string, unknown>;
        if (staged !== undefined && !isAzureStagedLedger(staged)) return null;
        if (completing !== undefined && !isAzureSeal(completing)) return null;
        return state as AzurePersistedUpload;
    } catch {
        return null;
    }
}

/**
 * Azure caps a blob's metadata at 8 KiB across every pair. The record is
 * rewritten on every append and at completion, growing only by the fields
 * creation leaves unset (`lastAppendAt`, `etag`, the staged ledger, the seal), so
 * creation measures the record with each of those at its widest and refuses
 * one that could ever cross the ceiling. Without that measure, a key and
 * caller metadata that fit at creation would put the first append's write
 * over the limit: a live upload that no append can advance and no completion
 * can record.
 */
const AZURE_STATE_MAX_ENCODED_BYTES = 7 * 1024;
const AZURE_STATE_WIDEST_ETAG = `"0x${"F".repeat(40)}"`;

function azureWidestEncodedState(state: AzurePersistedUpload): number {
    return encodeAzurePersistedUpload({
        ...state,
        lastAppendAt: Number.MAX_SAFE_INTEGER,
        etag: AZURE_STATE_WIDEST_ETAG,
        staged: { blocks: AZURE_MAX_BLOCK_INDEX + 1, bytes: Number.MAX_SAFE_INTEGER },
        completing: {
            length: Number.MAX_SAFE_INTEGER,
            publicationId: newPublicationId(),
            destinationEtag: AZURE_STATE_WIDEST_ETAG,
        },
    }).length;
}

/** A sealed plan's publication id: a v4 UUID, unguessable, so no other writer can carry it. */
function newPublicationId(): string {
    return crypto.randomUUID();
}

// ─── Resumable Upload: Body Assembly ────────────────────────────────────────

function concatUploadChunks(chunks: Uint8Array[], total: number): Uint8Array {
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

// ─── Resumable Upload: Block-List Derivation ────────────────────────────────

interface AzureDerivedBlocks {
    /** Sum of THIS upload's uncommitted data blocks (sentinel, other uploads' and foreign blocks excluded). */
    uncommittedSum: number;
    /** Ascending data-block indexes currently staged. */
    indexes: number[];
    /** The staged size of each index, aligned with `indexes`. */
    sizes: number[];
    /** The creation sentinel is still staged (the upload's liveness anchor). */
    sentinelPresent: boolean;
    /** Total size of the committed blocks: a completed upload's offset. */
    committedSum: number;
}

/**
 * A listed block's size. Every offset and completion sum is built from these,
 * so a block listed without one is a malformed response that fails the call;
 * counted as zero, it would hand a resuming client an offset short of its
 * durable bytes.
 */
function azureBlockSize(block: { size?: number }): number {
    if (!isCount(block.size)) throw new Error("Azure Get Block List returned a block without a size");
    return block.size;
}

function deriveAzureBlocks(list: AzureBlockList, segment: string): AzureDerivedBlocks {
    const sentinelId = azureSentinelBlockId(segment);
    let uncommittedSum = 0;
    const staged: Array<{ index: number; size: number }> = [];
    let sentinelPresent = false;
    for (const block of list.uncommittedBlocks ?? []) {
        if (block.name === sentinelId) {
            sentinelPresent = true;
            continue;
        }
        const index = azureParseDataBlockIndex(block.name, segment);
        if (index === null) continue; // not this upload's block: never its to count
        const size = azureBlockSize(block);
        uncommittedSum += size;
        staged.push({ index, size });
    }
    staged.sort((a, b) => a.index - b.index);
    let committedSum = 0;
    for (const block of list.committedBlocks ?? []) committedSum += azureBlockSize(block);
    return {
        uncommittedSum,
        indexes: staged.map((b) => b.index),
        sizes: staged.map((b) => b.size),
        sentinelPresent,
        committedSum,
    };
}

/**
 * How a live upload's staged blocks disagree with its accepted ledger, or
 * undefined when they agree (see {@link AzureStagedLedger}). A record from
 * before the ledger existed carries none and is trusted as it was.
 */
function azureLedgerDisagreement(
    derived: AzureDerivedBlocks,
    ledger: AzureStagedLedger | undefined,
): string | undefined {
    if (ledger === undefined || !derived.sentinelPresent) return undefined;
    if (derived.indexes.length < ledger.blocks) {
        return `${derived.indexes.length} blocks staged, ${ledger.blocks} accepted`;
    }
    let sum = 0;
    for (let i = 0; i < ledger.blocks; i += 1) {
        if (derived.indexes[i] !== i) return `accepted block ${i} is not staged`;
        sum += derived.sizes[i]!;
    }
    if (sum !== ledger.bytes) return `${sum} bytes staged across the accepted blocks, ${ledger.bytes} accepted`;
    return undefined;
}

// ─── Resumable Upload: Factory ──────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by Azure Blob Storage's
 * uncommitted-block model.
 *
 * How it maps to Azure primitives:
 * - `appendChunk` stages uncommitted blocks on the FINAL blob (block ids
 *   embed the upload's segment and a zero-padded sequence number; see
 *   {@link azureDataBlockId}). Nothing is visible to readers until commit.
 *   Each block is recorded in the info blob as it is accepted, and a stage
 *   that would land on an index another holder of the token has already had
 *   acknowledged is refused instead (see {@link AzureStagedLedger}).
 * - `getUploadState` derives the offset from Get Block List's uncommitted
 *   sums: backend bookkeeping, never a stored counter
 *   (`exactOffsetRecovery: true`).
 * - `completeUpload` is the sealed plan of {@link ResumableWriteStore.completeUpload}:
 *   it SEALS the record at the acknowledged length ({@link AzureSeal}),
 *   after which every append's record write is refused; reads the block
 *   list only then and refuses (lifting the seal) when it holds another
 *   length; and commits via Put Block List, which atomically publishes
 *   exactly the listed blocks (`atomicCompletion: true`), conditioned on the
 *   destination the seal recorded (`If-None-Match: *` when the key was empty,
 *   `If-Match` on the blob that was there otherwise) and writing the seal's
 *   publication id into the blob's metadata (`pcpublication`). A refused
 *   precondition is {@link UploadDestinationConflictError}; a retry after a
 *   lost record write adopts the blob only when it carries that id.
 * - A freshly created upload with zero data staged would be indistinguishable
 *   from a missing/reaped one (and from a completed one once blob versioning
 *   or an overwrite leaves committed blocks behind), so creation stages a
 *   1-byte SENTINEL block under a reserved id ({@link azureSentinelBlockId}):
 *   excluded from offset sums, never committed, dropped by Azure at commit
 *   time. Azure rejects a zero-length Stage Block, hence the single byte.
 * - Creation-time facts (final key, declared length, caller metadata,
 *   timestamps) ride a zero-byte `<uploadPrefix>/<id>.info` blob, carried in
 *   its blob METADATA (base64url JSON under one key) rather than its body:
 *   state reads are then a single getProperties and state updates a single
 *   setMetadata, with no download-stream handling. Documented choice over a
 *   JSON body.
 *
 * Lifecycle/GC: Azure itself garbage-collects uncommitted blocks seven days
 * after they were staged, and that collection is how an aborted or swept
 * upload's DATA is reclaimed by default: abort and
 * {@link ResumableWriteStore.sweepExpired} remove the `.info` bookkeeping
 * blob Azure will not, and never write to the destination key. Reclaiming the
 * blocks sooner costs a visible write at the key; see
 * {@link AzureUploadStoreOptions.discardStaged}.
 *
 * Concurrency note: blocks stage on the final blob, so Azure permits ONE
 * in-flight upload per key. A second concurrent upload to the same key keeps
 * its blocks apart (each upload counts and commits its own segment only), but
 * whichever commits first drops every staged block on the blob, the other's
 * sentinel included, and with `discardStaged: "commit-empty"` an abort or
 * sweep of either discards the blob's whole staged state. Callers wanting
 * parallel uploads to one key must serialize at completion or use distinct
 * keys.
 *
 * `digestOnComplete` is `false`: Azure has no service-side whole-blob SHA-256
 * (blockwise MD5 only), so a passed `expectedDigests` throws a clear error;
 * the orchestrator reads the flag and verifies upstream instead.
 *
 * @example
 * ```typescript
 * import { BlobServiceClient } from "@azure/storage-blob";
 * import { azureUploadStore } from "partial-content/azure";
 *
 * const blobService = BlobServiceClient.fromConnectionString(conn);
 * const store = azureUploadStore({
 *   containerClient: blobService.getContainerClient("documents"),
 * });
 * ```
 */
export function azureUploadStore(opts: AzureUploadStoreOptions): PrefixedUploadStore {
    const container = opts.containerClient;
    const prefix = (opts.uploadPrefix ?? DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");
    const assertPublishable = publishKeyGuard(`${prefix}/`);
    const blockSize = opts.blockSize ?? AZURE_DEFAULT_BLOCK_SIZE;
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
        throw new RangeError(`azureUploadStore: blockSize must be a positive integer, got ${blockSize}`);
    }
    const discardStaged = opts.discardStaged ?? "age-out";
    if (discardStaged !== "age-out" && discardStaged !== "commit-empty") {
        throw new RangeError(`azureUploadStore: discardStaged must be "age-out" or "commit-empty"`);
    }

    const infoBlobName = (id: string): string => `${prefix}/${id}.info`;

    /** Read + validate the persisted state behind a token. Throws 404-shaped. */
    async function readUpload(
        uploadToken: string,
        signal?: AbortSignal,
    ): Promise<{ state: AzurePersistedUpload; infoClient: AzureBlockBlobClient; segment: string }> {
        const id = decodeUploadId(uploadToken);
        const infoClient = container.getBlockBlobClient(infoBlobName(id));
        const entry = await requireState(infoClient, uploadToken, signal);
        return { state: entry.state, infoClient, segment: azureBlockSegment(id) };
    }

    /**
     * {@link readState} for a caller that cannot proceed without a record: a
     * missing info blob and corrupt bookkeeping both answer 404, the second
     * marked as damage for the operator (an info blob whose metadata decodes
     * to no state is one, absent or malformed alike). There is no
     * key to reconcile: the token carries none, so the persisted key is the
     * only one that exists.
     */
    async function requireState(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        signal?: AbortSignal,
    ): Promise<{ state: AzurePersistedUpload; etag?: string }> {
        const entry = await readState(infoClient, signal).catch((err: unknown) => {
            if (isAzureNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
            throw err;
        });
        if (entry === undefined) throw corruptUploadState(uploadToken);
        return entry;
    }

    /**
     * The info blob's state with the ETag the service stamped on it, which is
     * the version a conditional metadata write is pinned to; `undefined` when
     * the metadata decodes to no state. A missing blob propagates as the
     * service's own not-found.
     */
    async function readState(
        infoClient: AzureBlockBlobClient,
        signal?: AbortSignal,
    ): Promise<{ state: AzurePersistedUpload; etag?: string } | undefined> {
        const props = await infoClient.getProperties({ abortSignal: signal });
        const state = decodeAzurePersistedUpload(props.metadata?.[AZURE_STATE_METADATA_KEY]);
        if (!state) return undefined;
        return { state, ...(props.etag !== undefined ? { etag: props.etag } : {}) };
    }

    /**
     * Apply a patch to the persisted state, based on a FRESH read rather than
     * on the snapshot the caller has been holding, and written back only if the
     * info blob is still the version that read returned.
     *
     * The snapshot an append holds was read before the body streamed, which can
     * be minutes, and a holder whose lock was stolen in that time would write
     * back a record from before the new holder's changes; `isInvalidated` lives
     * only here and nothing recomputes it, so re-writing it away resurrects a
     * terminally dead upload. Three rules make the merge safe for what a stale
     * writer can still do:
     *
     * - The write is CONDITIONAL on the ETag the fresh read returned. A record
     *   that changed between the read and the write is refused with a 412, the
     *   merge re-reads and tries again, and after `CAS_MERGE_ATTEMPTS`
     *   losses it fails rather than landing.
     * - Both terminal flags are MONOTONIC. Once set, no later write clears
     *   them, whichever record it was computed from.
     * - The creation facts, a recorded length and the published ETag come from
     *   the fresh copy. They are write-once by contract, so the fresh copy
     *   either equals the caller's or is the one that won.
     *
     * A read that FAILS supplies none of the three, so it fails the merge. The
     * caller's snapshot is not a base to write from: it predates the body, and
     * an unconditional write of it would clear whatever a live holder recorded
     * since, which is the exact loss the fresh read exists to stop.
     *
     * Every record write an APPEND makes passes `append`. The merge is then
     * also a FENCE: it refuses, with the conflict error the offset check would
     * have raised, when the fresh record is no longer writable, is sealed for
     * completion ({@link AzureSeal}), or, for a block it just staged
     * (`append.accept`), already holds that index (another holder of the token
     * had it acknowledged while this one's body streamed). The ledger it
     * writes covers the accepted prefix through this block, so a listing that
     * ran ahead of the record (an earlier append crashed after staging) is
     * absorbed rather than refused.
     *
     * The seal test sits in this conditional write on purpose. The block is
     * already staged when it runs, and the write and the seal are both pinned
     * to the info blob's ETag, so one of them lands first: the record write,
     * and the block is in the block list the completion reads after its seal;
     * or the seal, and this write is refused and the append acknowledges
     * nothing. A check before the stage alone would leave a third order.
     */
    type AzureStatePatch = Partial<
        Pick<AzurePersistedUpload, "length" | "lastAppendAt" | "isInvalidated" | "isComplete" | "etag">
    >;

    /** What an append's record write is fenced on; see {@link AzureStatePatch}. */
    interface AzureAppendWrite {
        accept?: { index: number; end: number };
    }

    /**
     * The record a merge writes: the fresh record wins on `length` and `etag`
     * (each written once, by the writer that learned it), the terminal flags
     * only ever turn on, the seal is carried untouched, and an accepted block
     * advances the ledger. With `append`, the fresh record must still admit
     * the append: a stale holder's record write, or one that lost the race to
     * a seal, is refused here, after its block landed but before that block
     * counts.
     */
    function mergeAzureState(
        uploadToken: string,
        fresh: AzurePersistedUpload,
        patch: AzureStatePatch,
        append: AzureAppendWrite | undefined,
    ): AzurePersistedUpload {
        if (append !== undefined) {
            assertUploadWritable(fresh, "append");
            refuseSealed(uploadToken, fresh);
            if (append.accept !== undefined) refuseAcceptedIndex(uploadToken, fresh, append.accept.index);
        }
        const merged = mergePersistedState(fresh, patch);
        const accept = append?.accept;
        return accept === undefined ? merged : { ...merged, staged: { blocks: accept.index + 1, bytes: accept.end } };
    }

    /**
     * Write `next(fresh)` over the info blob, conditional on the ETag of the
     * fresh read it was computed from, re-reading on a lost race (see
     * {@link casMerge}). Returns the record that landed.
     */
    async function writeRecord(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        next: (fresh: AzurePersistedUpload) => AzurePersistedUpload,
        signal?: AbortSignal,
    ): Promise<AzurePersistedUpload> {
        let landed: AzurePersistedUpload | undefined;
        await casMerge({
            // Corrupt bookkeeping answers 404 here as it does on a read. Either way
            // there is no fresh record, and the caller's snapshot is not a stand-in
            // for one: it predates the body, so writing it back with no version to
            // pin to would clear whatever a live holder recorded since, which is the
            // loss the fresh read exists to stop.
            read: () => requireState(infoClient, uploadToken, signal),
            merge: ({ state, etag }) => ({ record: next(state), etag }),
            write: async ({ record, etag }) => {
                await infoClient.setMetadata(
                    { [AZURE_STATE_METADATA_KEY]: encodeAzurePersistedUpload(record) },
                    { ...(etag !== undefined ? { conditions: { ifMatch: etag } } : {}), abortSignal: signal },
                );
                landed = record;
            },
            isConflict: isAzurePreconditionFailed,
            signal,
        });
        if (landed === undefined) throw new Error("Azure upload record merge returned without writing");
        return landed;
    }

    async function persistState(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        patch: AzureStatePatch,
        signal?: AbortSignal,
        append?: AzureAppendWrite,
    ): Promise<void> {
        await writeRecord(
            infoClient,
            uploadToken,
            (fresh) => mergeAzureState(uploadToken, fresh, patch, append),
            signal,
        );
    }

    /**
     * SEAL the plan at `length`, or adopt the seal a previous completion left
     * and re-point it at `length`, keeping its publication id and the
     * destination state it recorded. The returned record is the one that
     * landed: a record a concurrent completion finished in between comes back
     * complete, and the caller answers from it.
     */
    async function sealPlan(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        length: number,
        destination: AzureDestination | null,
        signal?: AbortSignal,
    ): Promise<AzurePersistedUpload> {
        return writeRecord(
            infoClient,
            uploadToken,
            (fresh) => {
                assertUploadWritable(fresh, "complete");
                if (fresh.isComplete) return fresh;
                const seal: AzureSeal = fresh.completing
                    ? { ...fresh.completing, length }
                    : {
                          length,
                          publicationId: newPublicationId(),
                          destinationEtag: destination === null ? null : destination.etag,
                      };
                return { ...fresh, completing: seal };
            },
            signal,
        );
    }

    /**
     * Lift the seal so the upload accepts appends again, when the snapshot
     * after it was not the length the completer acknowledged. Only the exact
     * seal this completion wrote is lifted: a record that completed, or whose
     * seal another completion re-pointed at another length (which that
     * completion may be committing under), is left as it is.
     */
    async function liftSeal(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        seal: AzureSeal,
        signal?: AbortSignal,
    ): Promise<void> {
        await writeRecord(
            infoClient,
            uploadToken,
            (fresh) => {
                const held = fresh.completing;
                if (fresh.isComplete || held?.publicationId !== seal.publicationId || held.length !== seal.length) {
                    return fresh;
                }
                const { completing: _lifted, ...open } = fresh;
                return open;
            },
            signal,
        );
    }

    /**
     * The committed blob at the key, or null when there is none: a blob that
     * exists only as staged blocks is no blob to a read, and none to a
     * create-only commit either.
     */
    async function readDestination(
        target: AzureBlockBlobClient,
        signal?: AbortSignal,
    ): Promise<AzureDestination | null> {
        let props: Awaited<ReturnType<AzureBlockBlobClient["getProperties"]>>;
        try {
            props = await target.getProperties({ abortSignal: signal });
        } catch (err) {
            if (isAzureNotFound(err)) return null;
            throw err;
        }
        if (props.etag === undefined) throw new Error("Azure Get Blob Properties returned no ETag");
        if (!isCount(props.contentLength)) throw new Error("Azure Get Blob Properties returned no contentLength");
        return {
            etag: props.etag,
            contentLength: props.contentLength,
            publicationId: props.metadata?.[AZURE_PUBLICATION_METADATA_KEY],
        };
    }

    /**
     * RECORD a publication this upload's sealed plan made, found at the key
     * by its publication id: the commit landed and the record write after it
     * did not, or a concurrent completion under the same seal committed
     * first. The published length goes on record; a completer that
     * acknowledged another length is answered with an offset conflict carrying
     * the published one, because the plan, not its view, is what the fence
     * made complete.
     */
    async function adoptPublication(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        published: AzureDestination,
        expectedLength: number,
    ): Promise<CompletedUpload> {
        await persistState(infoClient, uploadToken, {
            isComplete: true,
            etag: published.etag,
            length: published.contentLength,
        });
        if (published.contentLength !== expectedLength) {
            throw new UploadOffsetConflictError(uploadToken, published.contentLength);
        }
        return { etag: published.etag };
    }

    /**
     * The blob's block list, derived, or an invalidated upload and a loud throw.
     *
     * Staged blocks age out natively after seven days and a competing write to
     * the key drops them outright, so a 404 here is not "no upload", it is "the
     * uncommitted state this upload was built on is gone". Recording the
     * invalidation before throwing is what makes every later interaction refuse
     * rather than rebuild on a foundation that no longer exists.
     *
     * The SENTINEL check stays at the two callers on purpose: append treats a
     * missing sentinel as terminal, while complete first asks whether a blob
     * at the key is someone else's write ({@link refuseLostPlan}), which is a
     * destination conflict rather than a lost upload.
     */
    async function requireAzureBlocks(
        target: AzureBlockBlobClient,
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        state: AzurePersistedUpload,
        segment: string,
        signal?: AbortSignal,
    ): Promise<AzureDerivedBlocks> {
        let list: AzureBlockList;
        try {
            list = await target.getBlockList("all", { abortSignal: signal });
        } catch (err) {
            if (!isAzureNotFound(err)) throw err;
            await persistState(infoClient, uploadToken, { isInvalidated: true });
            throw new Error(`Upload staged blocks are gone (aged out or the blob was replaced); resource invalidated`);
        }
        const derived = deriveAzureBlocks(list, segment);
        const disagreement = azureLedgerDisagreement(derived, state.staged);
        if (disagreement !== undefined) {
            await persistState(infoClient, uploadToken, { isInvalidated: true });
            throw new Error(
                `Upload staged blocks disagree with the accepted ledger (${disagreement}); resource invalidated`,
            );
        }
        return derived;
    }

    /**
     * The conflict an append raises when the index it is about to stage, or
     * has just staged, is one the record already counts as accepted: another
     * holder of the token had that block acknowledged, and staging it again
     * replaces the acknowledged bytes. The offset reported is the ledger's,
     * a floor of the durable offset, so the client re-probes before resuming.
     */
    function refuseAcceptedIndex(uploadToken: string, record: AzurePersistedUpload, index: number): void {
        const ledger = record.staged;
        if (ledger !== undefined && index < ledger.blocks) {
            throw new UploadOffsetConflictError(uploadToken, ledger.bytes);
        }
    }

    /**
     * The FENCE: a record sealed for completion acknowledges no append. The
     * offset reported is the sealed length, the length the plan publishes.
     */
    function refuseSealed(uploadToken: string, record: AzurePersistedUpload): void {
        if (record.completing !== undefined) {
            throw new UploadOffsetConflictError(uploadToken, record.completing.length);
        }
    }

    /**
     * A state read's answer for an upload that lost its uncommitted state:
     * the invalidation is recorded so an append or completion refuses rather
     * than re-derives. Best-effort: the derived answer stands either way, and
     * the next read derives it identically.
     */
    async function recordInvalidated(
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        state: AzurePersistedUpload,
        signal?: AbortSignal,
    ): Promise<StoredUploadState> {
        await persistState(infoClient, uploadToken, { isInvalidated: true }, signal).catch(() => {
            /* best-effort; see above */
        });
        return { ...toStoredState(state, 0), status: "invalidated" };
    }

    /**
     * A state read of an upload whose sentinel is gone. Every commit retires
     * the sentinel, and every commit this store makes is under a seal, so the
     * answer comes from the seal and the blob at the key, never from the
     * blob's shape:
     *
     * - The blob carries the seal's publication id: this upload's commit,
     *   whose record write was lost. Reported complete; a completion retry
     *   records it.
     * - Someone else's blob at a sealed upload's key: the completion answers
     *   the destination conflict, so the upload stays sealed here rather than
     *   being recorded dead under it.
     * - Anything else: the uncommitted state was lost, which is terminal.
     */
    async function stateWithoutSentinel(
        target: AzureBlockBlobClient,
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        state: AzurePersistedUpload,
        signal?: AbortSignal,
    ): Promise<StoredUploadState> {
        const seal = state.completing;
        if (seal === undefined) return recordInvalidated(infoClient, uploadToken, state, signal);
        const destination = await readDestination(target, signal);
        if (destination?.publicationId === seal.publicationId) {
            return { ...toStoredState(state, destination.contentLength), status: "complete" };
        }
        if (destination !== null && destination.etag !== seal.destinationEtag) {
            return toStoredState(state, seal.length);
        }
        return recordInvalidated(infoClient, uploadToken, state, signal);
    }

    /**
     * A sealed completion whose sentinel is gone. Every commit retires the
     * sentinel, and this upload's own commit is adopted by its id before the
     * seal, so it is not this. A blob at the key that is not the state the
     * seal recorded is someone's write: the staged blocks it dropped are gone,
     * and the blob is not this upload's to claim. Otherwise the uncommitted
     * state aged out or was wiped, and the upload is invalidated.
     */
    async function refuseLostPlan(
        target: AzureBlockBlobClient,
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        seal: AzureSeal,
        signal?: AbortSignal,
    ): Promise<never> {
        const now = await readDestination(target, signal);
        if (now !== null && now.etag !== seal.destinationEtag) {
            throw new UploadDestinationConflictError(uploadToken);
        }
        return invalidateLostSentinel(infoClient, uploadToken);
    }

    /**
     * The creation sentinel is gone outside any publication of this upload:
     * the uncommitted state aged out or was wiped, which is terminal, so the
     * invalidation is recorded before the throw and every later interaction
     * refuses.
     */
    async function invalidateLostSentinel(infoClient: AzureBlockBlobClient, uploadToken: string): Promise<never> {
        await persistState(infoClient, uploadToken, { isInvalidated: true });
        throw new Error(`Upload creation sentinel is gone (uncommitted state lost); resource invalidated`);
    }

    /**
     * PUBLISH the sealed plan's blocks under the destination state the seal
     * recorded, writing its publication id into the blob. A refused
     * precondition is either a concurrent completion under this same seal
     * that committed first (adopted by its id) or someone else's write
     * ({@link UploadDestinationConflictError}).
     */
    async function publishPlan(
        target: AzureBlockBlobClient,
        infoClient: AzureBlockBlobClient,
        uploadToken: string,
        seal: AzureSeal,
        blockIds: string[],
        signal?: AbortSignal,
    ): Promise<CompletedUpload> {
        let response: { etag?: string };
        try {
            response = await target.commitBlockList(blockIds, {
                conditions: seal.destinationEtag === null ? { ifNoneMatch: "*" } : { ifMatch: seal.destinationEtag },
                metadata: { [AZURE_PUBLICATION_METADATA_KEY]: seal.publicationId },
                abortSignal: signal,
            });
        } catch (err) {
            if (!isAzureDestinationRefusal(err)) throw err;
            const now = await readDestination(target, signal);
            if (now?.publicationId === seal.publicationId) {
                return adoptPublication(infoClient, uploadToken, now, seal.length);
            }
            throw new UploadDestinationConflictError(uploadToken, err);
        }
        // RECORD. The committed size goes on record as the length (a declared
        // one is kept: the merge writes it once): a deferred-length upload has
        // no other record of its size once the published object is gone.
        await persistState(infoClient, uploadToken, { isComplete: true, etag: response.etag, length: seal.length });
        return { etag: response.etag };
    }

    /**
     * Reclaim an aborted or expired upload's staged blocks at once, when the
     * store was configured to (`discardStaged: "commit-empty"`); by default
     * they are left to the service's seven-day collection and nothing at the
     * key is touched.
     *
     * A blob that exists COMMITTED at the key is live data (this upload was
     * overwriting it), so it is left alone and the staged blocks age out.
     * A delete conditioned on `If-None-Match: *` cannot do this: it may only
     * act on a resource that does not exist (RFC 9110 §13.1.2), and the REST
     * reference leaves unstated whether staged-only state exists for it.
     * Instead an empty block list is committed CREATE-ONLY: Put Block List
     * drops every unlisted staged block, and its `If-None-Match: *` refuses
     * (412, or 409 BlobAlreadyExists) when a committed blob is there, in the
     * request that would replace it. The zero-byte blob it leaves is deleted
     * pinned to the ETag the commit returned, so a writer that commits in
     * between keeps its blob. A key with nothing staged is skipped, so the
     * zero-byte blob appears only when there are blocks to reclaim.
     *
     * Only the commit's refusal is an expected outcome. A delete the service
     * refuses for any reason but a newer version (a retention policy, a legal
     * hold, a lease) leaves the empty blob at the key, and throws so the
     * caller hears of it.
     */
    async function discardUncommittedTarget(key: string, signal?: AbortSignal): Promise<void> {
        if (discardStaged !== "commit-empty") return;
        const target = container.getBlockBlobClient(key);
        let etag: string | undefined;
        try {
            const list = await target.getBlockList("all", { abortSignal: signal });
            if ((list.uncommittedBlocks ?? []).length === 0) return;
            ({ etag } = await target.commitBlockList([], {
                conditions: { ifNoneMatch: "*" },
                abortSignal: signal,
            }));
        } catch (err) {
            // Nothing at the key, or a committed blob the service would not replace.
            if (isAzureNotFound(err) || isAzureDestinationRefusal(err)) return;
            throw err;
        }
        if (etag === undefined) throw new Error("Azure Put Block List returned no ETag");
        try {
            await target.deleteIfExists({ conditions: { ifMatch: etag }, abortSignal: signal });
        } catch (err) {
            // A writer committed over the empty blob in between: its blob stays.
            if (isAzurePreconditionFailed(err)) return;
            throw err;
        }
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
            const target = container.getBlockBlobClient(createOpts.key);
            const state: AzurePersistedUpload = {
                key: createOpts.key,
                length: createOpts.length,
                metadata: createOpts.metadata,
                createdAt: createOpts.now,
                expiresAt: createOpts.expiresAt,
                isComplete: false,
                isInvalidated: false,
                staged: { blocks: 0, bytes: 0 },
            };
            const widest = azureWidestEncodedState(state);
            if (widest > AZURE_STATE_MAX_ENCODED_BYTES) {
                throw new Error(
                    `azureUploadStore: the upload record would reach ${widest} bytes, past the ` +
                        `${AZURE_STATE_MAX_ENCODED_BYTES}-byte ceiling; shorten the key or metadata`,
                );
            }
            // Sentinel FIRST, info second: if the info write crashes, the caller
            // retries creation and the orphaned sentinel ages out natively; the
            // reverse order could mint a resource whose liveness anchor never
            // existed. Azure rejects zero-length Stage Block, hence one byte.
            await target.stageBlock(azureSentinelBlockId(azureBlockSegment(id)), new Uint8Array([0]), 1, {
                abortSignal: createOpts.signal,
            });
            await container.getBlockBlobClient(infoBlobName(id)).upload("", 0, {
                metadata: { [AZURE_STATE_METADATA_KEY]: encodeAzurePersistedUpload(state) },
                abortSignal: createOpts.signal,
            });
            return { uploadToken: id };
        },

        async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
            stateOpts?.signal?.throwIfAborted();
            const { state, infoClient, segment } = await readUpload(uploadToken, stateOpts?.signal);
            if (state.isInvalidated) {
                // Terminal: the offset is moot (the engine refuses every probe and
                // append, and the one verb still allowed, cancel, does not read it).
                return toStoredState(state, 0);
            }
            const target = container.getBlockBlobClient(state.key);
            let list: AzureBlockList;
            try {
                list = await target.getBlockList("all", { abortSignal: stateOpts?.signal });
            } catch (err) {
                if (!isAzureNotFound(err)) throw err;
                if (state.isComplete) {
                    // Published object was deleted later; the completion answer stands,
                    // at the length the completion recorded. A record from before
                    // completions recorded a deferred length has no size to answer.
                    if (state.length === undefined) {
                        throw new Error("Completed upload recorded no length and its published object is gone");
                    }
                    return toStoredState(state, state.length);
                }
                // The blob resource is gone entirely: the staged blocks (and the
                // creation sentinel) aged out or were wiped. Bytes lost; record it.
                return recordInvalidated(infoClient, uploadToken, state, stateOpts?.signal);
            }
            const derived = deriveAzureBlocks(list, segment);
            if (state.isComplete) {
                return toStoredState(state, derived.committedSum);
            }
            if (azureLedgerDisagreement(derived, state.staged) !== undefined) {
                // A block was replaced under an acknowledged write: terminal, and
                // recorded so an append or completion refuses rather than re-derives.
                return recordInvalidated(infoClient, uploadToken, state, stateOpts?.signal);
            }
            if (!derived.sentinelPresent) {
                return stateWithoutSentinel(target, infoClient, uploadToken, state, stateOpts?.signal);
            }
            return toStoredState(state, derived.uncommittedSum);
        },

        async appendChunk(
            uploadToken: string,
            offset: number,
            body: ReadableStream<Uint8Array> | Uint8Array,
            appendOpts: AppendChunkOptions,
        ): Promise<AppendChunkResult> {
            const admission = await admitAppend(body, appendOpts, async () => {
                const { state, infoClient, segment } = await readUpload(uploadToken, appendOpts.signal);
                assertUploadWritable(state, "append");
                refuseSealed(uploadToken, state);
                const target = container.getBlockBlobClient(state.key);
                const derived = await requireAzureBlocks(
                    target,
                    infoClient,
                    uploadToken,
                    state,
                    segment,
                    appendOpts.signal,
                );
                if (!derived.sentinelPresent) await invalidateLostSentinel(infoClient, uploadToken);
                // Required by the store contract: the lock serializes writers but cannot
                // prove the writer still holds it, so verifying the claim here is what
                // makes a stolen-lock write loud instead of silently interleaved. The
                // block list was needed anyway (next sequence number), so the check
                // against the durable sum costs nothing.
                if (offset !== derived.uncommittedSum) {
                    throw new UploadOffsetConflictError(uploadToken, derived.uncommittedSum);
                }
                return { state, infoClient, segment, target, derived };
            });
            if ("refused" in admission) return admission.refused;
            const { state, infoClient, segment, target, derived } = admission.admitted;

            let nextIndex = derived.indexes.length > 0 ? derived.indexes[derived.indexes.length - 1]! + 1 : 0;
            let written = 0;
            let pending: Uint8Array[] = [];
            let pendingBytes = 0;

            const stagePending = async (): Promise<void> => {
                if (pendingBytes === 0) return;
                if (nextIndex > AZURE_MAX_BLOCK_INDEX) {
                    throw new Error(`Upload exceeds Azure's 50,000-block limit; raise blockSize`);
                }
                const block = concatUploadChunks(pending, pendingBytes);
                pending = [];
                pendingBytes = 0;
                // The body may have streamed for minutes since the offset check, and
                // the lock that serialized this append can have been stolen in that
                // time. Staging an index that another holder has since had
                // acknowledged would REPLACE its block, so the record is read again
                // right before the stage: an index the ledger already counts is
                // refused before any byte lands, and a record that is gone (the
                // resource was reaped while the body streamed) stages nothing. A
                // read that fails is no evidence the index is free, so it fails
                // the append before the stage. A record sealed since stages nothing
                // either; the fence itself is the record write after the stage.
                const fresh = await readState(infoClient).catch((err: unknown) => {
                    if (isAzureNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
                    throw err;
                });
                if (fresh !== undefined) {
                    assertUploadWritable(fresh.state, "append");
                    refuseSealed(uploadToken, fresh.state);
                    refuseAcceptedIndex(uploadToken, fresh.state, nextIndex);
                }
                // No abort signal here: post-abort flushing of already-received
                // bytes is the contract (the orchestrator's grace window owns it).
                await target.stageBlock(azureDataBlockId(segment, nextIndex), block, block.length);
                written += block.length;
                // Recorded before the next block is staged, under the conditional
                // write that fences a stale holder's stage of this same index and an
                // append that lost the race to a completion's seal. A record gone by
                // now means the resource was reaped mid-body; the block just staged
                // goes with the rest of its blob's uncommitted state, at once under
                // `discardStaged: "commit-empty"` (a discard that fails throws in
                // place of the not-found, so the caller's error reporting hears of
                // the orphan) and by the service's collection otherwise.
                try {
                    await persistState(infoClient, uploadToken, { lastAppendAt: appendOpts.now }, undefined, {
                        accept: { index: nextIndex, end: derived.uncommittedSum + written },
                    });
                } catch (err) {
                    if (isUploadNotFoundError(err)) await discardUncommittedTarget(state.key);
                    throw err;
                }
                nextIndex += 1;
            };

            // The abort check, the body-death handling and both byte ceilings live in
            // pumpUploadBody; what stays here is the only part that is Azure's, which
            // is buffering chunks up to a block and staging each full one.
            const { chunks, outcome, finalize } = pumpUploadBody(
                body,
                uploadToken,
                appendOpts,
                // Terminal-fault invalidation, recorded durably so every later
                // interaction refuses. Awaited before the throw by the pump.
                () => persistState(infoClient, uploadToken, { isInvalidated: true }),
            );
            for await (const chunk of chunks) {
                pending.push(chunk);
                pendingBytes += chunk.length;
                if (pendingBytes >= blockSize) await stagePending();
            }
            await stagePending();
            // Deferred-length declaration: the first append to carry a length records
            // it in the info blob's metadata so the next getUploadState reports it and
            // it turns immutable. Only ever set once (the orchestrator guarantees it,
            // and the guard makes it safe): a length already recorded is never
            // overwritten. persistState (setMetadata) is awaited, so it is durable
            // before the ack, and fenced like every append's record write.
            const declaresLength = appendOpts.length !== undefined && state.length === undefined;
            if (declaresLength || written === 0) {
                await persistState(
                    infoClient,
                    uploadToken,
                    { ...(declaresLength ? { length: appendOpts.length } : {}), lastAppendAt: appendOpts.now },
                    undefined,
                    {},
                );
            }
            // Reported only after the accepted prefix is durable: the resource is
            // untouched, so the client resumes from here in smaller chunks.
            await finalize();
            if (outcome.ceilingHit) throw new UploadAppendBoundError(uploadToken, derived.uncommittedSum + written);
            return { bytesWritten: written, interrupted: outcome.interrupted };
        },

        async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
            completeOpts.signal?.throwIfAborted();
            const { state, infoClient, segment } = await readUpload(uploadToken, completeOpts.signal);
            assertUploadWritable(state, "complete");
            if (state.isComplete) {
                return { etag: state.etag };
            }
            if (completeOpts.expectedDigests !== undefined) {
                // Orchestrators gate on digestOnComplete === false and never hand a
                // digest here; a digest anyway is a caller bug, never silently ignored.
                throw new Error("azureUploadStore cannot verify a completion digest (digestOnComplete is false)");
            }
            const { expectedLength, signal } = completeOpts;
            const target = container.getBlockBlobClient(state.key);
            const destination = await readDestination(target, signal);
            // RECORD recovery, by identity only: a seal left by an earlier
            // completion whose publication id the blob at the key carries is that
            // completion's commit, landed with its record write lost. A blob of the
            // same size, block count or anything else is not evidence.
            if (state.completing !== undefined && destination?.publicationId === state.completing.publicationId) {
                return adoptPublication(infoClient, uploadToken, destination, expectedLength);
            }
            // SEAL. From here no append is acknowledged, so the block list read next
            // holds every acknowledged byte.
            const sealed = await sealPlan(infoClient, uploadToken, expectedLength, destination, signal);
            if (sealed.isComplete) return { etag: sealed.etag };
            const seal = sealed.completing;
            if (seal === undefined) throw new Error("Azure upload seal did not land on the record");
            // SNAPSHOT, after the seal.
            const derived = await requireAzureBlocks(target, infoClient, uploadToken, sealed, segment, signal);
            if (!derived.sentinelPresent) return refuseLostPlan(target, infoClient, uploadToken, seal, signal);
            if (derived.uncommittedSum !== expectedLength) {
                await liftSeal(infoClient, uploadToken, seal, signal);
                throw new UploadOffsetConflictError(uploadToken, derived.uncommittedSum);
            }
            // Exactly this upload's data blocks, ascending. The sentinel is NEVER
            // listed: Azure drops every unlisted staged block at commit, which is
            // what retires the sentinel, and with it every block another writer
            // staged on the blob. An empty list is a valid commit and publishes a
            // zero-byte blob (zero-byte completion), under the same precondition,
            // so a retry of it never replaces a blob written after the first one.
            const blockIds = derived.indexes.map((index) => azureDataBlockId(segment, index));
            return publishPlan(target, infoClient, uploadToken, seal, blockIds, signal);
        },

        async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
            abortOpts?.signal?.throwIfAborted();
            const id = uploadIdForDiscard(uploadToken);
            if (id === null) return; // idempotent: the token named no resource
            const infoClient = container.getBlockBlobClient(infoBlobName(id));
            let props;
            try {
                props = await infoClient.getProperties({ abortSignal: abortOpts?.signal });
            } catch (err) {
                if (isAzureNotFound(err)) return; // already aborted/swept
                throw err;
            }
            // Corrupt state (null) is garbage bookkeeping: only the info blob goes.
            const state = decodeAzurePersistedUpload(props.metadata?.[AZURE_STATE_METADATA_KEY]);
            // Never touch the key's blob for a COMPLETED upload: that blob is the
            // published object now. An unfinished one's staged blocks are left to
            // the service unless the store was configured to discard them.
            if (state && !state.isComplete) {
                await discardUncommittedTarget(state.key, abortOpts?.signal);
            }
            await infoClient.deleteIfExists({ abortSignal: abortOpts?.signal });
        },

        /**
         * Each resource is isolated and counted (see {@link sweepEach}). The
         * `.info` blob is deleted last, so a resource whose blocks could not be
         * discarded is still listed on the next pass.
         */
        async sweepExpired(
            cutoff: UploadSweepCutoff,
            sweepOpts?: { signal?: AbortSignal },
        ): Promise<{ removed: number; failed: number }> {
            requireSweepCutoff(cutoff);
            return sweepEach(
                container.listBlobsFlat({ prefix: `${prefix}/`, includeMetadata: true }),
                async (item) => {
                    if (!item.name.endsWith(".info")) return false;
                    const state = decodeAzurePersistedUpload(item.metadata?.[AZURE_STATE_METADATA_KEY]);
                    // Corrupt bookkeeping is already unusable (state reads answer 404),
                    // so it is swept regardless of age.
                    if (state && !isSweepable(cutoff, state.createdAt, state.lastAppendAt)) return false;
                    if (state && !state.isComplete) {
                        // Azure's native GC clears uncommitted blocks after 7 days on its
                        // own; `discardStaged: "commit-empty"` reclaims them earlier.
                        await discardUncommittedTarget(state.key, sweepOpts?.signal);
                    }
                    await container.getBlockBlobClient(item.name).deleteIfExists({ abortSignal: sweepOpts?.signal });
                    return true;
                },
                sweepOpts,
            );
        },
    };
}
