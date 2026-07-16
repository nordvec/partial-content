/**
 * Resumable-upload write contract: the storage seam under the upload engine.
 *
 * Read side and write side stay independently adoptable: this interface is
 * deliberately NOT part of {@link ObjectStore}. An adapter implements one,
 * the other, or both.
 *
 * The contract's one load-bearing rule: **offsets are backend-derived.**
 * `getUploadState().offset` must be computed from storage bookkeeping the
 * backend itself maintains (a part listing, an uncommitted-block list, an
 * fsynced file size), never from a counter the adapter persisted alongside
 * the data. A stored counter and the bytes it describes cannot be written
 * atomically, and the drift between them after a crash is exactly the
 * corruption class resumable uploads exist to prevent. The engine treats the
 * state an adapter returns as authoritative truth; adapters must make that
 * trust safe.
 *
 * Capability flags are HONEST, per backend, never assumed: the orchestrator
 * reads them to decide what it may promise on the wire (advertised append
 * bounds, digest verification, exact resume).
 *
 * @packageDocumentation
 */

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * The upload resource does not exist (never created, already completed and
 * reaped, cancelled, or expired-and-swept). Dialects answer 404.
 * Matched by `name`, so custom stores can throw equivalently-named errors
 * without importing the class.
 */
export class UploadNotFoundError extends Error {
  readonly status = 404 as const;
  readonly uploadToken: string;
  constructor(uploadToken: string, cause?: unknown) {
    super(`Upload not found: ${uploadToken}`);
    this.name = "UploadNotFoundError";
    this.uploadToken = uploadToken;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * The append's claimed offset lost a race with durable state (defense in
 * depth under the orchestrator's lock; a correct orchestrator makes this
 * unreachable, a buggy caller makes it loud instead of corrupting).
 * The orchestrator re-derives state once and answers offset-mismatch.
 */
export class UploadOffsetConflictError extends Error {
  readonly uploadToken: string;
  readonly durableOffset: number;
  constructor(uploadToken: string, durableOffset: number) {
    super(`Upload ${uploadToken}: claimed offset lost to durable offset ${durableOffset}`);
    this.name = "UploadOffsetConflictError";
    this.uploadToken = uploadToken;
    this.durableOffset = durableOffset;
  }
}

/**
 * Completion-time integrity verification failed: the assembled bytes do not
 * hash to the digest the client asserted. The adapter MUST NOT have
 * published the object (atomic completion means a failed verification
 * leaves nothing visible to readers); the orchestrator aborts the upload
 * and the dialect answers a client error, never a torn object.
 */
export class UploadDigestMismatchError extends Error {
  readonly uploadToken: string;
  readonly expectedDigest: string;
  readonly actualDigest?: string;
  constructor(uploadToken: string, expectedDigest: string, actualDigest?: string) {
    super(`Upload ${uploadToken}: assembled bytes do not match the asserted digest`);
    this.name = "UploadDigestMismatchError";
    this.uploadToken = uploadToken;
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

/** Name-based matchers (cross-package instanceof safety, same as read side). */
export function isUploadNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === "UploadNotFoundError";
}
export function isUploadOffsetConflictError(err: unknown): err is UploadOffsetConflictError {
  return err instanceof Error && err.name === "UploadOffsetConflictError";
}
export function isUploadDigestMismatchError(err: unknown): boolean {
  return err instanceof Error && err.name === "UploadDigestMismatchError";
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** Durable upload-resource state, freshly derived from the backend. */
export interface StoredUploadState {
  /** Bytes provably durable. Backend-derived; see the contract rule above. */
  offset: number;
  /** Declared total length, when known. Immutable once recorded. */
  length?: number;
  /** Completion already happened (idempotent-retry answers). */
  isComplete: boolean;
  /**
   * The resource is terminally dead (bytes lost, or an over-append landed).
   * Adapters record this durably so every later interaction refuses.
   */
  isInvalidated: boolean;
  /** Epoch ms of creation (expiry policy input). */
  createdAt: number;
  /** Epoch ms of the last accepted append, when any. */
  lastAppendAt?: number;
  /** Opaque caller metadata recorded at creation (dialects carry filename/type). */
  metadata?: Record<string, string>;
}

export interface CreateUploadOptions {
  /** Final storage key the completed object will live under. */
  key: string;
  /** Declared total length, when the client sent one. */
  length?: number;
  /** Opaque metadata to record with the resource. */
  metadata?: Record<string, string>;
  /** Creation time, epoch ms. Injected: adapters read no clock. */
  now: number;
  signal?: AbortSignal;
}

export interface AppendChunkOptions {
  /**
   * Hard byte bound from the engine's verdict (remaining length/size room).
   * The adapter MUST stop accepting at the bound and invalidate the resource
   * if the body tries to cross it: bytes past a known length are the
   * spec's terminal fault, and only the adapter sees the stream.
   */
  maxBytes?: number;
  /** Append time, epoch ms (recorded as lastAppendAt). */
  now: number;
  /**
   * Client-disconnect signal. Adapters SHOULD keep flushing already-received
   * bytes briefly after an abort (the orchestrator owns the grace window and
   * passes a signal that reflects it) and must account partial writes
   * truthfully in `bytesWritten`.
   */
  signal?: AbortSignal;
}

export interface CompleteUploadOptions {
  /**
   * Raw base64 SHA-256 the client asserted for the whole representation.
   * When set and the adapter can verify (`digestOnComplete`), a mismatch
   * MUST throw {@link UploadDigestMismatchError} BEFORE publishing.
   * When set and the adapter cannot verify, the orchestrator already knows
   * (capability flag) and has either verified upstream or declined the
   * assertion; adapters never silently ignore a digest they were handed.
   */
  expectedDigest?: string;
  now: number;
  signal?: AbortSignal;
}

export interface CompletedUpload {
  /** Validator of the published object, when the backend reports one. */
  etag?: string;
  /**
   * Raw base64 SHA-256 of the published bytes, when the adapter computed or
   * verified one (feeds the read side's Repr-Digest for the object's whole
   * serving life).
   */
  digest?: string;
}

// ─── Contract ───────────────────────────────────────────────────────────────

/**
 * Storage backend capable of resumable writes. All mutating calls are made
 * by the orchestrator UNDER the upload's lock and after a fresh
 * `getUploadState`; adapters may (and the built-ins do) still verify the
 * claimed offset against durable state where that check is cheap, throwing
 * {@link UploadOffsetConflictError} instead of writing.
 */
export interface ResumableWriteStore {
  /**
   * Allocate a new upload resource and return its opaque token. The token is
   * the ONLY handle later calls receive: fold everything resumption needs
   * into it (the built-ins encode key + backend upload id). The engine and
   * orchestrator never parse it.
   */
  createUpload(opts: CreateUploadOptions): Promise<{ uploadToken: string }>;

  /** Fresh, backend-derived state. Throws {@link UploadNotFoundError}. */
  getUploadState(uploadToken: string, opts?: { signal?: AbortSignal }): Promise<StoredUploadState>;

  /**
   * Append `body` at `offset` (already engine-validated against fresh state).
   * Returns the bytes made DURABLE by this call: on interruption that is the
   * flushed prefix, and the next `getUploadState` must agree with it.
   */
  appendChunk(
    uploadToken: string,
    offset: number,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: AppendChunkOptions,
  ): Promise<{ bytesWritten: number }>;

  /**
   * Atomically publish the assembled object to its key. After success the
   * object is readable and the upload resource answers `isComplete`;
   * after ANY failure nothing new is visible to readers.
   */
  completeUpload(uploadToken: string, opts: CompleteUploadOptions): Promise<CompletedUpload>;

  /** Discard the resource and its partial bytes. Idempotent. */
  abortUpload(uploadToken: string, opts?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Remove upload resources idle since before `olderThanMs` (epoch ms).
   * The storage-limitation GC hook: callers run it on a schedule; adapters
   * whose backend has native lifecycle rules may implement it as a no-op
   * and document the native rule instead.
   */
  sweepExpired?(olderThanMs: number, opts?: { signal?: AbortSignal }): Promise<{ removed: number }>;

  // ── Capability flags (honest, per backend) ──
  /**
   * Backend append granularity in bytes: appends the backend can only
   * accept in multiples/minimums of this size force orchestrator-side
   * buffering. `undefined` = byte-exact appends.
   */
  readonly appendGranularity?: number;
  /** Every non-final part must be the same size (R2's stricter rule). */
  readonly uniformPartSize?: boolean;
  /**
   * The offset from `getUploadState` is byte-exact and crash-durable. When
   * `false` the orchestrator must not advertise exact resume: it re-anchors
   * on its own bookkeeping instead of the backend's answer.
   */
  readonly exactOffsetRecovery: boolean;
  /** `completeUpload` is all-or-nothing (no torn object ever visible). */
  readonly atomicCompletion: boolean;
  /** Integrity primitive available at completion, or `false`. */
  readonly digestOnComplete: "sha256" | "crc32c" | false;
  /** Largest single append the backend accepts, when bounded. */
  readonly maxAppendSize?: number;
}
