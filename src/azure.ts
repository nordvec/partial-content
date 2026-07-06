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
  isOpenEndedRange,
  type ObjectStore,
  type ObjectMetadata,
  type ObjectStream,
  type ParsedRange,
  type StoreErrorClassifiers,
} from "./index.js";

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
interface AzureContainerClient {
  getBlobClient(blobName: string): AzureBlobClient;
}

interface AzureBlobClient {
  getProperties(options?: { abortSignal?: AbortSignal }): Promise<AzureBlobProperties>;
  download(
    offset?: number,
    count?: number,
    options?: { conditions?: { ifMatch?: string }; abortSignal?: AbortSignal },
  ): Promise<AzureBlobDownloadResponse>;
}

interface AzureBlobProperties {
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

interface AzureBlobDownloadResponse {
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

  return {
    supportsRange: true,
    // 206 bounds/total come from Azure's actual contentRange: the
    // orchestrator may skip the validating HEAD for plain range requests.
    authoritativeRange: true,

    async headObject(key: string, opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> {
      opts?.signal?.throwIfAborted();
      // Forward the signal so a client disconnect during the request/header
      // phase cancels the Azure call (the pre-check only covers already-aborted;
      // the body phase is covered by nodeStreamToWeb's signal wiring).
      const props = await classifyStoreRead(key, () => containerClient.getBlobClient(key).getProperties({ abortSignal: opts?.signal }), azureClassifiers);

      if (props.contentLength == null) {
        throw new Error(`Azure getProperties returned no contentLength for ${key}`);
      }

      return {
        contentLength: props.contentLength,
        etag: props.etag,
        lastModified: props.lastModified?.toUTCString(),
      };
    },

    async getObject(key: string, opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> {
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
      const count = range && !isOpenEndedRange(range)
        ? (range.end - range.start + 1)
        : undefined;

      const response = await classifyStoreRead(key, () => containerClient.getBlobClient(key).download(
        offset,
        count,
        {
          // Pin the read to the validated representation: Azure rejects
          // with 412 ConditionNotMet if the blob changed since HEAD.
          ...(ifMatch ? { conditions: { ifMatch } } : {}),
          // Forward the signal so the request/header phase is cancellable too.
          abortSignal: signal,
        },
      ), azureClassifiers);

      if (response.contentLength == null) {
        destroyAzureDownload(response);
        throw new Error(`Azure download returned no contentLength for ${key}`);
      }
      const contentLength = response.contentLength;
      const resolved = response.contentRange
        ? resolveServedRange(response.contentRange)
        : null;
      // A Content-Range Azure emits but the resolver cannot parse means the
      // byte accounting is untrustworthy: release the live socket and fail
      // loudly rather than guess.
      if (response.contentRange && !resolved) {
        destroyAzureDownload(response);
        throw new Error(
          `Azure returned unparseable Content-Range for ${key}: ${response.contentRange}`,
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
        throw new Error(`Azure download returned no body for ${key}`);
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
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

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
 * The back-off Azure advises on a throttle, parsed from the `Retry-After`
 * response header (whole seconds; the HTTP-date form is ignored). Surfaced so
 * the 503 echoes it and shared caches wait the advised interval.
 */
function azureRetryAfterSeconds(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: { get?: (name: string) => string | undefined } } })
    .response?.headers;
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
    code === "ServerBusy" || code === "OperationTimedOut"
    || status === 429 || status === 503
    || (status === undefined && err instanceof Error && err.name === "RestError"
        && (err.message.includes("ServerBusy") || err.message.includes("OperationTimedOut")));
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
