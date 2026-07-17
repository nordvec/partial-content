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
} from "./index.ts";
import {
  UploadNotFoundError,
  UploadOffsetConflictError,
  type ResumableWriteStore,
  type StoredUploadState,
  type CreateUploadOptions,
  type AppendChunkOptions,
  type CompleteUploadOptions,
  type CompletedUpload,
} from "./upload-store.ts";

// Re-export for convenience
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError };
export { UploadNotFoundError, UploadOffsetConflictError };

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
  generateSasUrl(options: AzureGenerateSasUrlOptions): Promise<string>;
}

/**
 * The read-signing subset of the SDK's `BlobGenerateSasUrlOptions`. The
 * content* / cacheControl fields are the SAS response-header overrides
 * (`rscd`/`rsct`/`rscc` query parameters) honored on the signed GET.
 */
interface AzureGenerateSasUrlOptions {
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

    async createSignedUrl(key, signOpts) {
      // A signed URL is a 302 redirect target: the client fetches bytes
      // DIRECTLY from Azure, bypassing the serve route's security headers
      // (nosniff, CSP, CORP). Force a download disposition AND an inert
      // content type so a stored SVG/HTML polyglot cannot render inline off
      // the header-less origin response. All three overrides ride the SAS
      // token as signed response-header parameters; the stored blob is
      // untouched. `downloadFilename` only customizes the name.
      //
      // Signing requires the containerClient to have been constructed with a
      // shared-key credential; without one, generateSasUrl throws a
      // RangeError with a clear message. That error propagates deliberately:
      // the web adapter treats a throwing createSignedUrl as a reported 502
      // (onError), the same terminal outcome as a declined { ok: false }.
      const url = await containerClient.getBlobClient(key).generateSasUrl({
        permissions: READ_ONLY_SAS_PERMISSIONS,
        expiresOn: new Date(Date.now() + signOpts.expiresInSeconds * 1000),
        contentType: "application/octet-stream",
        contentDisposition: buildContentDisposition(
          signOpts.downloadFilename ?? "download",
          { type: "attachment" },
        ),
        // Response-header override, not a blob mutation: keeps a private
        // document's caching policy authoritative even when the blob was
        // uploaded with a public Cache-Control (the CDN-caches-your-private
        // -file footgun).
        ...(signOpts.cacheControl ? { cacheControl: signOpts.cacheControl } : {}),
      });

      return { ok: true as const, url };
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

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
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ etag?: string }>;
  getBlockList(
    listType: "all",
    options?: { abortSignal?: AbortSignal },
  ): Promise<AzureBlockList>;
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
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
  deleteIfExists(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
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
}

// ─── Resumable Upload: Internal Constants + Codecs ──────────────────────────

const AZURE_DEFAULT_UPLOAD_PREFIX = ".partial-content-uploads";
const AZURE_DEFAULT_BLOCK_SIZE = 8 * 1024 * 1024;
/** Azure caps a block blob at 50,000 committed blocks. */
const AZURE_MAX_BLOCK_INDEX = 49_999;
/** Blob-metadata key carrying the persisted upload state (base64url JSON). */
const AZURE_STATE_METADATA_KEY = "pcuploadstate";

/**
 * Block-id scheme: base64 of `pcblk-` + a zero-padded 6-digit sequence
 * number. Azure requires every block id on a blob to be the same length, and
 * base64 over equal-length ASCII inputs is order-preserving, so ids sort like
 * their sequence numbers. The distinctive prefix also lets the adapter tell
 * its own blocks from blocks staged by any other writer.
 */
const AZURE_BLOCK_RAW_PREFIX = "pcblk-";

function azureDataBlockId(index: number): string {
  return btoa(AZURE_BLOCK_RAW_PREFIX + String(index).padStart(6, "0"));
}

/**
 * The creation-time sentinel block's id: same raw length as a data id (so
 * Azure's equal-length rule holds) with a non-numeric suffix, so it can never
 * collide with any data block and never parses as one.
 */
const AZURE_SENTINEL_BLOCK_ID = btoa(AZURE_BLOCK_RAW_PREFIX + "anchor");

/** Parse a listed block name back to its data index; null for anything else. */
function azureParseDataBlockIndex(name: string | undefined): number | null {
  if (!name) return null;
  let raw: string;
  try {
    raw = atob(name);
  } catch {
    return null;
  }
  if (!raw.startsWith(AZURE_BLOCK_RAW_PREFIX)) return null;
  const digits = raw.slice(AZURE_BLOCK_RAW_PREFIX.length);
  if (!/^\d{6}$/.test(digits)) return null;
  return parseInt(digits, 10);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** What the opaque upload token folds in (base64url JSON). */
interface AzureUploadToken {
  key: string;
  id: string;
}

function encodeAzureUploadToken(token: AzureUploadToken): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(token)));
}

/**
 * Decode + validate a token. The `id` is interpolated into blob names, so
 * only the exact UUID shape minted at creation is accepted: a forged token
 * cannot traverse into foreign blobs. Garbage decodes to
 * {@link UploadNotFoundError} (dialects answer 404, never a parse crash).
 */
function decodeAzureUploadToken(uploadToken: string): AzureUploadToken {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(uploadToken)),
    );
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.key === "string" && candidate.key.length > 0 &&
        typeof candidate.id === "string" && UPLOAD_ID_RE.test(candidate.id)
      ) {
        return { key: candidate.key, id: candidate.id };
      }
    }
  } catch (err) {
    throw new UploadNotFoundError(uploadToken, err);
  }
  throw new UploadNotFoundError(uploadToken);
}

/** The UUID shape `createUpload` mints; nothing else may name an info blob. */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Durable upload bookkeeping, persisted as info-blob metadata. */
interface AzurePersistedUpload {
  key: string;
  length?: number;
  metadata?: Record<string, string>;
  createdAt: number;
  lastAppendAt?: number;
  isComplete: boolean;
  isInvalidated: boolean;
  /** Recorded at completion for idempotent-retry answers. */
  etag?: string;
}

function encodeAzurePersistedUpload(state: AzurePersistedUpload): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(state)));
}

/** Decode + shape-validate persisted state; null for corrupt values. */
function decodeAzurePersistedUpload(raw: string | undefined): AzurePersistedUpload | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
    return validatePersistedUploadShape(parsed);
  } catch {
    return null;
  }
}

/**
 * Shape gate for persisted upload state. Numbers feed offset math and expiry
 * policy, so only non-negative safe integers pass; a forged or corrupt value
 * yields null and the caller answers not-found rather than flowing bad state
 * into the engine.
 */
function validatePersistedUploadShape(parsed: unknown): AzurePersistedUpload | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  const isCount = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (
    typeof c.key === "string" && c.key.length > 0 &&
    (c.length === undefined || isCount(c.length)) &&
    isCount(c.createdAt) &&
    (c.lastAppendAt === undefined || isCount(c.lastAppendAt)) &&
    typeof c.isComplete === "boolean" &&
    typeof c.isInvalidated === "boolean" &&
    (c.etag === undefined || typeof c.etag === "string") &&
    (c.metadata === undefined ||
      (typeof c.metadata === "object" && c.metadata !== null &&
        Object.values(c.metadata).every((v) => typeof v === "string")))
  ) {
    return c as unknown as AzurePersistedUpload;
  }
  return null;
}

// ─── Resumable Upload: Shared Body Iteration ────────────────────────────────

/** Normalize an append body to an async chunk sequence. */
async function* uploadBodyChunks(
  body: ReadableStream<Uint8Array> | Uint8Array,
): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.length > 0) yield body;
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

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
  /** Sum of OUR uncommitted data blocks (sentinel + foreign blocks excluded). */
  uncommittedSum: number;
  /** Ascending data-block indexes currently staged. */
  indexes: number[];
  /** The creation sentinel is still staged (the upload's liveness anchor). */
  sentinelPresent: boolean;
  /** Committed-side summary (completion-crash healing input). */
  committed: { sum: number; count: number; allOurs: boolean };
}

function deriveAzureBlocks(list: AzureBlockList): AzureDerivedBlocks {
  let uncommittedSum = 0;
  const indexes: number[] = [];
  let sentinelPresent = false;
  for (const block of list.uncommittedBlocks ?? []) {
    if (block.name === AZURE_SENTINEL_BLOCK_ID) {
      sentinelPresent = true;
      continue;
    }
    const index = azureParseDataBlockIndex(block.name);
    if (index === null) continue; // foreign writer's block: never ours to count
    uncommittedSum += block.size ?? 0;
    indexes.push(index);
  }
  let committedSum = 0;
  let committedCount = 0;
  let allOurs = true;
  for (const block of list.committedBlocks ?? []) {
    committedSum += block.size ?? 0;
    committedCount += 1;
    if (azureParseDataBlockIndex(block.name) === null) allOurs = false;
  }
  return {
    uncommittedSum,
    indexes: indexes.toSorted((a, b) => a - b),
    sentinelPresent,
    committed: { sum: committedSum, count: committedCount, allOurs },
  };
}

// ─── Resumable Upload: Factory ──────────────────────────────────────────────

/**
 * Create a {@link ResumableWriteStore} backed by Azure Blob Storage's
 * uncommitted-block model.
 *
 * How it maps to Azure primitives:
 * - `appendChunk` stages uncommitted blocks on the FINAL blob (block ids
 *   embed a zero-padded sequence number; see {@link azureDataBlockId}).
 *   Nothing is visible to readers until commit.
 * - `getUploadState` derives the offset from Get Block List's uncommitted
 *   sums: backend bookkeeping, never a stored counter
 *   (`exactOffsetRecovery: true`).
 * - `completeUpload` commits via Put Block List, which atomically publishes
 *   exactly the listed blocks (`atomicCompletion: true`).
 * - A freshly created upload with zero data staged would be indistinguishable
 *   from a missing/reaped one (and from a completed one once blob versioning
 *   or an overwrite leaves committed blocks behind), so creation stages a
 *   1-byte SENTINEL block under a reserved id ({@link AZURE_SENTINEL_BLOCK_ID}):
 *   excluded from offset sums, never committed, dropped by Azure at commit
 *   time. Azure rejects a zero-length Stage Block, hence the single byte.
 * - Creation-time facts (final key, declared length, caller metadata,
 *   timestamps) ride a zero-byte `<uploadPrefix>/<id>.info` blob, carried in
 *   its blob METADATA (base64url JSON under one key) rather than its body:
 *   state reads are then a single getProperties and state updates a single
 *   setMetadata, with no download-stream handling. Documented choice over a
 *   JSON body.
 *
 * Lifecycle/GC: Azure itself garbage-collects uncommitted blocks after
 * 7 days, so abandoned DATA needs no sweeping. {@link ResumableWriteStore.sweepExpired}
 * exists to reap what Azure will not: the `.info` bookkeeping blobs (and it
 * clears still-live uncommitted state when it gets there first).
 *
 * Concurrency note: blocks stage on the final blob, so Azure permits ONE
 * in-flight upload per key; a second concurrent upload to the same key shares
 * (and corrupts) the same uncommitted-block namespace. Callers wanting
 * parallel uploads to one key must serialize at completion or use distinct keys.
 *
 * `digestOnComplete` is `false`: Azure has no service-side whole-blob SHA-256
 * (blockwise MD5 only), so a passed `expectedDigest` throws a clear error;
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
export function azureUploadStore(opts: AzureUploadStoreOptions): ResumableWriteStore {
  const container = opts.containerClient;
  const prefix = (opts.uploadPrefix ?? AZURE_DEFAULT_UPLOAD_PREFIX).replace(/\/+$/, "");
  const blockSize = opts.blockSize ?? AZURE_DEFAULT_BLOCK_SIZE;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new RangeError(`azureUploadStore: blockSize must be a positive integer, got ${blockSize}`);
  }

  const infoBlobName = (id: string): string => `${prefix}/${id}.info`;

  /** Read + validate the persisted state behind a token. Throws 404-shaped. */
  async function readUpload(
    uploadToken: string,
    signal?: AbortSignal,
  ): Promise<{ state: AzurePersistedUpload; infoClient: AzureBlockBlobClient }> {
    const token = decodeAzureUploadToken(uploadToken);
    const infoClient = container.getBlockBlobClient(infoBlobName(token.id));
    let props;
    try {
      props = await infoClient.getProperties({ abortSignal: signal });
    } catch (err) {
      if (isAzureNotFound(err)) throw new UploadNotFoundError(uploadToken, err);
      throw err;
    }
    const state = decodeAzurePersistedUpload(props.metadata?.[AZURE_STATE_METADATA_KEY]);
    // Corrupt bookkeeping, or a token whose key was tampered to point at a
    // different blob than the one recorded at creation: both answer 404. The
    // PERSISTED key is authoritative for every backend operation.
    if (!state || state.key !== token.key) {
      throw new UploadNotFoundError(uploadToken);
    }
    return { state, infoClient };
  }

  async function persistState(
    infoClient: AzureBlockBlobClient,
    state: AzurePersistedUpload,
    signal?: AbortSignal,
  ): Promise<void> {
    await infoClient.setMetadata(
      { [AZURE_STATE_METADATA_KEY]: encodeAzurePersistedUpload(state) },
      { abortSignal: signal },
    );
  }

  function toStoredState(state: AzurePersistedUpload, offset: number): StoredUploadState {
    return {
      offset,
      length: state.length,
      isComplete: state.isComplete,
      isInvalidated: state.isInvalidated,
      createdAt: state.createdAt,
      lastAppendAt: state.lastAppendAt,
      metadata: state.metadata,
    };
  }

  /**
   * Clear an aborted/expired upload's staged blocks. A blob that exists ONLY
   * as uncommitted blocks answers 404 to getProperties; deleting it discards
   * the staged block list immediately. A blob that exists COMMITTED at the
   * key is live data (this upload was overwriting it), so it is left alone
   * and the staged blocks age out via Azure's native 7-day uncommitted GC.
   */
  async function discardUncommittedTarget(key: string, signal?: AbortSignal): Promise<void> {
    const target = container.getBlockBlobClient(key);
    try {
      await target.getProperties({ abortSignal: signal });
      return; // committed blob: never delete live data
    } catch (err) {
      if (!isAzureNotFound(err)) throw err;
    }
    await target.deleteIfExists({ abortSignal: signal });
  }

  return {
    exactOffsetRecovery: true,
    atomicCompletion: true,
    digestOnComplete: false,

    async createUpload(createOpts: CreateUploadOptions): Promise<{ uploadToken: string }> {
      createOpts.signal?.throwIfAborted();
      const id = crypto.randomUUID();
      const target = container.getBlockBlobClient(createOpts.key);
      // Sentinel FIRST, info second: if the info write crashes, the caller
      // retries creation and the orphaned sentinel ages out natively; the
      // reverse order could mint a resource whose liveness anchor never
      // existed. Azure rejects zero-length Stage Block, hence one byte.
      await target.stageBlock(AZURE_SENTINEL_BLOCK_ID, new Uint8Array([0]), 1, {
        abortSignal: createOpts.signal,
      });
      const state: AzurePersistedUpload = {
        key: createOpts.key,
        length: createOpts.length,
        metadata: createOpts.metadata,
        createdAt: createOpts.now,
        isComplete: false,
        isInvalidated: false,
      };
      await container.getBlockBlobClient(infoBlobName(id)).upload("", 0, {
        metadata: { [AZURE_STATE_METADATA_KEY]: encodeAzurePersistedUpload(state) },
        abortSignal: createOpts.signal,
      });
      return { uploadToken: encodeAzureUploadToken({ key: createOpts.key, id }) };
    },

    async getUploadState(uploadToken: string, stateOpts?: { signal?: AbortSignal }): Promise<StoredUploadState> {
      stateOpts?.signal?.throwIfAborted();
      const { state, infoClient } = await readUpload(uploadToken, stateOpts?.signal);
      if (state.isInvalidated) {
        // Terminal: the offset is moot (the engine refuses everything anyway).
        return toStoredState(state, 0);
      }
      const target = container.getBlockBlobClient(state.key);
      let list: AzureBlockList;
      try {
        list = await target.getBlockList("all", { abortSignal: stateOpts?.signal });
      } catch (err) {
        if (!isAzureNotFound(err)) throw err;
        if (state.isComplete) {
          // Published object was deleted later; the completion answer stands.
          return toStoredState(state, state.length ?? 0);
        }
        // The blob resource is gone entirely: the staged blocks (and the
        // creation sentinel) aged out or were wiped. Bytes lost; record it.
        await persistState(infoClient, { ...state, isInvalidated: true }, stateOpts?.signal)
          .catch(() => { /* best-effort: the derived answer stands; re-derived identically next read */ });
        return { ...toStoredState(state, 0), isInvalidated: true };
      }
      const derived = deriveAzureBlocks(list);
      if (state.isComplete) {
        return toStoredState(state, derived.committed.sum);
      }
      if (!derived.sentinelPresent) {
        // No sentinel + our blocks committed at the recorded size: completion
        // landed but the info update crashed. Report the truth; a
        // completeUpload retry heals the metadata.
        if (
          derived.committed.count > 0 && derived.committed.allOurs &&
          (state.length === undefined || derived.committed.sum === state.length)
        ) {
          return { ...toStoredState(state, derived.committed.sum), isComplete: true };
        }
        // A zero-block committed blob and a zero-length upload: an empty
        // commit landed (crash before the info update). Anything else means
        // the uncommitted state (sentinel included) was lost: terminal.
        if (derived.committed.count === 0 && (state.length ?? 0) === 0) {
          return { ...toStoredState(state, 0), isComplete: true };
        }
        await persistState(infoClient, { ...state, isInvalidated: true }, stateOpts?.signal)
          .catch(() => { /* best-effort; see above */ });
        return { ...toStoredState(state, 0), isInvalidated: true };
      }
      return toStoredState(state, derived.uncommittedSum);
    },

    async appendChunk(
      uploadToken: string,
      offset: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
      appendOpts: AppendChunkOptions,
    ): Promise<{ bytesWritten: number }> {
      const { state, infoClient } = await readUpload(uploadToken, appendOpts.signal);
      if (state.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; nothing may be appended`);
      }
      if (state.isComplete) {
        throw new Error(`Upload ${uploadToken} is already complete; nothing may be appended`);
      }
      const target = container.getBlockBlobClient(state.key);
      let list: AzureBlockList;
      try {
        list = await target.getBlockList("all", { abortSignal: appendOpts.signal });
      } catch (err) {
        if (!isAzureNotFound(err)) throw err;
        await persistState(infoClient, { ...state, isInvalidated: true });
        throw new Error(
          `Upload ${uploadToken}: staged blocks are gone (aged out or the blob was replaced); resource invalidated`,
        );
      }
      const derived = deriveAzureBlocks(list);
      if (!derived.sentinelPresent) {
        await persistState(infoClient, { ...state, isInvalidated: true });
        throw new Error(
          `Upload ${uploadToken}: creation sentinel is gone (uncommitted state lost); resource invalidated`,
        );
      }
      // Cheap defense-in-depth under the orchestrator's lock: the block list
      // was needed anyway (next sequence number), so the claimed offset is
      // verified against the durable sum for free.
      if (offset !== derived.uncommittedSum) {
        throw new UploadOffsetConflictError(uploadToken, derived.uncommittedSum);
      }

      let nextIndex = derived.indexes.length > 0
        ? derived.indexes[derived.indexes.length - 1]! + 1
        : 0;
      let written = 0;
      let consumed = 0;
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;

      const stagePending = async (): Promise<void> => {
        if (pendingBytes === 0) return;
        if (nextIndex > AZURE_MAX_BLOCK_INDEX) {
          throw new Error(
            `Upload ${uploadToken}: exceeds Azure's 50,000-block limit; raise blockSize`,
          );
        }
        const block = concatUploadChunks(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        // No abort signal here: post-abort flushing of already-received
        // bytes is the contract (the orchestrator's grace window owns it).
        await target.stageBlock(azureDataBlockId(nextIndex), block, block.length);
        nextIndex += 1;
        written += block.length;
      };

      const iterator = uploadBodyChunks(body)[Symbol.asyncIterator]();
      while (true) {
        if (appendOpts.signal?.aborted) break;
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch {
          // Body died (client disconnect): flush the received prefix and
          // account it truthfully; the next getUploadState agrees.
          break;
        }
        if (next.done) break;
        consumed += next.value.length;
        if (appendOpts.maxBytes !== undefined && consumed > appendOpts.maxBytes) {
          // Bytes past the engine's hard bound are the terminal fault: record
          // it durably so every later interaction refuses, then fail loudly.
          await persistState(infoClient, { ...state, isInvalidated: true });
          throw new Error(
            `Upload ${uploadToken}: body crossed the ${appendOpts.maxBytes}-byte bound; resource invalidated`,
          );
        }
        pending.push(next.value);
        pendingBytes += next.value.length;
        if (pendingBytes >= blockSize) await stagePending();
      }
      await stagePending();
      // Deferred-length declaration: the first append to carry a length records
      // it in the info blob's metadata so the next getUploadState reports it and
      // it turns immutable. Only ever set once (the orchestrator guarantees it,
      // and the guard makes it safe): a length already recorded is never
      // overwritten. persistState (setMetadata) is awaited, so it is durable
      // before the ack.
      const declaresLength = appendOpts.length !== undefined && state.length === undefined;
      await persistState(infoClient, {
        ...state,
        ...(declaresLength ? { length: appendOpts.length } : {}),
        lastAppendAt: appendOpts.now,
      });
      return { bytesWritten: written };
    },

    async completeUpload(uploadToken: string, completeOpts: CompleteUploadOptions): Promise<CompletedUpload> {
      completeOpts.signal?.throwIfAborted();
      const { state, infoClient } = await readUpload(uploadToken, completeOpts.signal);
      if (state.isInvalidated) {
        throw new Error(`Upload ${uploadToken} is invalidated; it cannot be completed`);
      }
      if (state.isComplete) {
        return { etag: state.etag };
      }
      if (completeOpts.expectedDigest !== undefined) {
        // Orchestrators gate on digestOnComplete === false and never hand a
        // digest here; a digest anyway is a caller bug, never silently ignored.
        throw new Error(
          "azureUploadStore cannot verify a completion digest (digestOnComplete is false): " +
          "Azure Blob Storage has no service-side whole-blob SHA-256",
        );
      }
      const target = container.getBlockBlobClient(state.key);
      let list: AzureBlockList;
      try {
        list = await target.getBlockList("all", { abortSignal: completeOpts.signal });
      } catch (err) {
        if (!isAzureNotFound(err)) throw err;
        await persistState(infoClient, { ...state, isInvalidated: true });
        throw new Error(
          `Upload ${uploadToken}: staged blocks are gone (aged out or the blob was replaced); resource invalidated`,
        );
      }
      const derived = deriveAzureBlocks(list);
      if (!derived.sentinelPresent) {
        // Completion-retry healing: a commit that landed drops ALL staged
        // blocks (sentinel included). If the committed blocks are ours at the
        // recorded size, the previous attempt's commit succeeded and only the
        // info update crashed; finish that bookkeeping instead of failing.
        if (
          derived.committed.count > 0 && derived.committed.allOurs &&
          (state.length === undefined || derived.committed.sum === state.length)
        ) {
          let etag: string | undefined;
          try {
            etag = (await target.getProperties({ abortSignal: completeOpts.signal })).etag;
          } catch { /* etag is optional; the heal proceeds without it */ }
          await persistState(infoClient, { ...state, isComplete: true, etag });
          return { etag };
        }
        // Zero-byte uploads leave a zero-block blob after commit; recommitting
        // an empty list is idempotent, so fall through and commit again.
        if (!(derived.committed.count === 0 && (state.length ?? 0) === 0)) {
          await persistState(infoClient, { ...state, isInvalidated: true });
          throw new Error(
            `Upload ${uploadToken}: creation sentinel is gone (uncommitted state lost); resource invalidated`,
          );
        }
      }
      // Commit exactly the data blocks, ascending. The sentinel is NEVER
      // listed: Azure drops every unlisted staged block at commit, which is
      // what retires the sentinel. An empty list is a valid commit and
      // publishes a zero-byte blob (zero-byte completion).
      const blockIds = derived.indexes.map(azureDataBlockId);
      const response = await target.commitBlockList(blockIds, { abortSignal: completeOpts.signal });
      await persistState(infoClient, { ...state, isComplete: true, etag: response.etag });
      return { etag: response.etag };
    },

    async abortUpload(uploadToken: string, abortOpts?: { signal?: AbortSignal }): Promise<void> {
      abortOpts?.signal?.throwIfAborted();
      let token: AzureUploadToken;
      try {
        token = decodeAzureUploadToken(uploadToken);
      } catch {
        return; // idempotent: a token that never named a resource has nothing to discard
      }
      const infoClient = container.getBlockBlobClient(infoBlobName(token.id));
      let props;
      try {
        props = await infoClient.getProperties({ abortSignal: abortOpts?.signal });
      } catch (err) {
        if (isAzureNotFound(err)) return; // already aborted/swept
        throw err;
      }
      const state = decodeAzurePersistedUpload(props.metadata?.[AZURE_STATE_METADATA_KEY]);
      // A token whose key disagrees with the recorded one is forged: it is
      // not this resource's handle, so it may discard NOTHING (state reads
      // answer 404 for it; deleting here would let a tampered token destroy
      // a live upload's bookkeeping). Corrupt state (null) is garbage
      // bookkeeping and only the info blob itself goes.
      if (state && state.key !== token.key) return;
      // Never touch the key's blob for a COMPLETED upload: that blob is the
      // published object now.
      if (state && !state.isComplete) {
        await discardUncommittedTarget(state.key, abortOpts?.signal);
      }
      await infoClient.deleteIfExists({ abortSignal: abortOpts?.signal });
    },

    async sweepExpired(olderThanMs: number, sweepOpts?: { signal?: AbortSignal }): Promise<{ removed: number }> {
      let removed = 0;
      for await (const item of container.listBlobsFlat({
        prefix: `${prefix}/`,
        includeMetadata: true,
      })) {
        sweepOpts?.signal?.throwIfAborted();
        if (!item.name.endsWith(".info")) continue;
        const state = decodeAzurePersistedUpload(item.metadata?.[AZURE_STATE_METADATA_KEY]);
        // Corrupt bookkeeping is already unusable (state reads answer 404),
        // so it is swept regardless of age.
        if (state) {
          const idleSince = state.lastAppendAt ?? state.createdAt;
          if (idleSince >= olderThanMs) continue;
          if (!state.isComplete) {
            // Azure's native GC clears uncommitted blocks after 7 days on its
            // own; clearing here just reclaims them earlier when possible.
            await discardUncommittedTarget(state.key, sweepOpts?.signal);
          }
        }
        await container.getBlockBlobClient(item.name).deleteIfExists({
          abortSignal: sweepOpts?.signal,
        });
        removed += 1;
      }
      return { removed };
    },
  };
}
