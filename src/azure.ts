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
    buildContentDisposition,
    type ObjectStore,
    type ObjectMetadata,
    type ObjectStream,
    type ReadRange,
    type StoreErrorClassifiers,
    representationCoding,
    type KeyPolicy,
} from "./index.ts";
import { BUCKET_KEY_MAX_BYTES, failRead, isInstance, readPath, retryAfterFrom, urlKeyGuard } from "./object-store.ts";
import {
    azureErrorCode,
    azureStatusCode,
    isAzureNotFound,
    isAzurePreconditionFailed,
    restErrorMessageNames,
} from "./azure-errors.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };

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
    /** The stored `Content-Encoding` of the blob, if any. */
    contentEncoding?: string;
}

export interface AzureBlobDownloadResponse {
    readableStreamBody?: NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy?: () => void };
    blobBody?: Promise<Blob>;
    contentLength?: number;
    /** Present on ranged downloads: "bytes 5-9/20". Carries the total size. */
    contentRange?: string;
    etag?: string;
    lastModified?: Date;
    /** The stored `Content-Encoding` of the blob, if any. */
    contentEncoding?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface AzureStoreOptions {
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
     * Whether a key with an empty segment is refused. A blob URL path is built
     * from the key, so the default refuses it; `"verbatim"` serves a
     * container's real `a//b` blob. A `.` or `..` segment is refused under
     * either value: its dot segments are resolved before Azure sees the path,
     * so no blob is named by such a key.
     * @default "plain"
     */
    keys?: KeyPolicy;
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
    const assertReadable = urlKeyGuard(opts.reservedPrefix ?? ".partial-content-uploads/", {
        keys: opts.keys ?? "plain",
        // A blob name is at most 1,024 characters, not bytes, and a character is at most 4 bytes of UTF-8.
        maxKeyBytes: 4 * BUCKET_KEY_MAX_BYTES,
    });

    return {
        supportsRange: true,
        // 206 bounds/total come from Azure's actual contentRange: the
        // orchestrator may skip the validating HEAD for plain range requests.
        authoritativeRange: true,
        // download() carries `conditions.ifMatch`: Azure answers 412 for a changed blob.
        pinsReads: true,

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
                contentEncoding: representationCoding(props.contentEncoding),
            };
        },

        async getObject(
            key: string,
            opts?: { range?: ReadRange; signal?: AbortSignal; ifMatch?: string },
        ): Promise<ObjectStream> {
            assertReadable(key);
            const { range, signal, ifMatch } = opts ?? {};
            signal?.throwIfAborted();

            // Single round-trip: download() carries everything needed. For ranged
            // reads the response's Content-Range ("bytes 5-9/20") supplies the
            // total size; for full reads contentLength IS the total. One response
            // also means one representation -- no metadata/body race to guard.
            const offset = range ? range.start : 0;
            // An open range reads to the end of the blob: count stays undefined so
            // download() streams the tail.
            const count = range?.end === undefined ? undefined : range.end - range.start + 1;

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
                failRead(() => destroyAzureDownload(response), new Error(`Azure download returned no contentLength`));
            }
            const contentLength = response.contentLength;
            const contentEncoding = bodyCoding(response);
            const resolved = response.contentRange ? resolveServedRange(response.contentRange) : null;
            // A Content-Range Azure emits but the resolver cannot parse means the
            // byte accounting is untrustworthy: release the live socket and fail
            // loudly rather than guess.
            if (response.contentRange && !resolved) {
                failRead(
                    () => destroyAzureDownload(response),
                    new Error(`Azure returned unparseable Content-Range: ${response.contentRange}`),
                );
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
                contentEncoding,
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
                const message = isInstance(err, RangeError) ? readPath(err, "message") : undefined;
                if (typeof message !== "string" || !/shared key credential/.test(message)) throw err;
                return { ok: false, error: message, code: "no-credential", cause: err };
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
 * The stored coding of a download's body. A corrupt stored value fails the
 * read, releasing the live socket first.
 */
function bodyCoding(response: AzureBlobDownloadResponse): string | undefined {
    try {
        return representationCoding(response.contentEncoding);
    } catch (err) {
        return failRead(() => destroyAzureDownload(response), err);
    }
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
 * code/status, never by substring. Returns the advised `Retry-After` when set,
 * so the 503 echoes it and shared caches wait the advised interval.
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
            (restErrorMessageNames(err, "ServerBusy") || restErrorMessageNames(err, "OperationTimedOut")));
    if (!throttled) return false;
    const retryAfterSeconds = retryAfterFrom(readPath(err, "response", "headers"));
    return retryAfterSeconds !== undefined ? { retryAfterSeconds } : true;
}

/** The ordered error-classification set shared by getProperties and download. */
const azureClassifiers: StoreErrorClassifiers = {
    notFound: isAzureNotFound,
    changed: isAzurePreconditionFailed,
    throttled: isAzureThrottled,
};
