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
 * Capability flags are HONEST, per backend, never assumed. Some are read by
 * the orchestrator to decide what it may promise on the wire (advertised
 * append bounds, digest verification) or to refuse construction outright
 * (atomic completion, the at-write offset check). The rest are published for
 * the CONSUMER: an efficiency hint a caller may align chunk sizes to, or a
 * property of the backend worth weighing when choosing one. Each flag's own
 * documentation says which it is; a flag nothing in the engine branches on
 * says so, so nobody reads a disclosure as a behavior switch.
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
    // The token is a capability handle and a candidate log line via onError;
    // keep it OFF the message string (it lives on the property for callers
    // that need it), matching the read side's PII-in-logs discipline.
    super("Upload not found");
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
    super(`Upload append: claimed offset lost to durable offset ${durableOffset}`);
    this.name = "UploadOffsetConflictError";
    this.uploadToken = uploadToken;
    this.durableOffset = durableOffset;
  }
}

/**
 * The body ran past a NON-fatal append bound ({@link
 * AppendChunkOptions.maxBytesFatal} `false`): this request's ceiling, not the
 * representation's. The resource is untouched and healthy; whatever the
 * adapter had already made durable stays durable, and `durableOffset` reports
 * it so the client can resume there.
 *
 * Distinct from {@link UploadOffsetConflictError} because the client did
 * nothing wrong to the upload, only to this request: the orchestrator answers
 * it as a size violation (a 413 on both dialects) rather than a conflict, and
 * the client retries the remainder in smaller chunks. Crossing a
 * REPRESENTATION bound is the other case entirely, and invalidates.
 */
export class UploadAppendBoundError extends Error {
  readonly uploadToken: string;
  readonly durableOffset: number;
  constructor(uploadToken: string, durableOffset: number) {
    super(`Upload append: body exceeded this request's byte ceiling at durable offset ${durableOffset}`);
    this.name = "UploadAppendBoundError";
    this.uploadToken = uploadToken;
    this.durableOffset = durableOffset;
  }
}

/**
 * The body ran past a FATAL append bound ({@link
 * AppendChunkOptions.maxBytesFatal} `true`): the representation's own bound,
 * a known length or the policy's total `maxSize`. The upload can never be
 * completed coherently, so the adapter has already invalidated it durably and
 * every later probe or append refuses.
 *
 * Distinct from {@link UploadAppendBoundError}, whose bound belongs to one
 * request and leaves the resource resumable. The fault is the CLIENT's, so
 * the orchestrator answers a client error rather than a backend failure: a
 * 502 would blame the storage for bytes the client chose to send. Which
 * client error depends on which representation bound was crossed: a body past
 * the length the client itself declared is a length inconsistency (400 on
 * both dialects), while a body past the server's `maxSize` is a size
 * violation (413).
 */
export class UploadOverrunError extends Error {
  readonly uploadToken: string;
  /** The representation bound the body crossed, in bytes. */
  readonly bound: number;
  constructor(uploadToken: string, bound: number) {
    super(`Upload append: body crossed the ${bound}-byte representation bound; resource invalidated`);
    this.name = "UploadOverrunError";
    this.uploadToken = uploadToken;
    this.bound = bound;
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
    super("Upload completion: assembled bytes do not match the asserted digest");
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
export function isUploadAppendBoundError(err: unknown): err is UploadAppendBoundError {
  return err instanceof Error && err.name === "UploadAppendBoundError";
}
export function isUploadOverrunError(err: unknown): err is UploadOverrunError {
  return err instanceof Error && err.name === "UploadOverrunError";
}
export function isUploadDigestMismatchError(err: unknown): boolean {
  return err instanceof Error && err.name === "UploadDigestMismatchError";
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** Durable upload-resource state, freshly derived from the backend. */
export interface StoredUploadState {
  /**
   * The storage key this upload publishes to, as given at creation.
   *
   * Surfaced because the key is decided before a token exists, so a caller
   * that generates one per upload has no way to pair the two afterwards: the
   * creation callback runs before the resource does, and correlating its
   * return with the token by position is a race, not an answer. Every backend
   * already persists the key to publish at all, so reporting it costs nothing
   * and it is the fact a consumer needs to record "this upload became that
   * object".
   */
  key: string;
  /** Bytes provably durable. Backend-derived; see the contract rule above. */
  offset: number;
  /** Declared total length, when known. Immutable once recorded. */
  length?: number;
  /** Completion already happened (idempotent-retry answers). */
  isComplete: boolean;
  /**
   * The resource is terminally dead (bytes lost, or an over-append landed).
   * Adapters record this durably so every later probe and append refuses.
   * Cancellation is the exception: a dead resource must still be discardable,
   * or its partial bytes are stranded until a sweep that may never run.
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
   * Hard byte bound from the engine's verdict. The adapter MUST NOT make more
   * than this many bytes durable: only the adapter sees the stream, so nothing
   * upstream can enforce it.
   *
   * A CEILING, not a target. How close an adapter lands to it is the backend's
   * business, and the difference is visible to a client as the offset it
   * resumes from:
   *
   * - Byte-addressable backends (`memory`, `fs`) admit the crossing chunk's
   *   prefix and land on exactly `maxBytes`.
   * - Part-based backends (`s3`, `r2`, `gcs`, `azure`) land on the last
   *   boundary at or below it. A part-size rule can forbid a short part
   *   mid-upload, so bytes buffered past the last boundary are not durable and
   *   are not counted.
   *
   * Both are correct because `bytesWritten` and the next `getUploadState`
   * agree either way, which is the invariant a resuming client depends on.
   * What an adapter must never do is report bytes it did not make durable:
   * an offset the backend cannot honour sends the client's next append to a
   * position the store will refuse.
   */
  maxBytes?: number;
  /**
   * What crossing {@link maxBytes} means, which is NOT one thing.
   *
   * `true`: the bound came from the representation (room toward a known
   * length, or the policy's total `maxSize`), so bytes past it are the spec's
   * terminal fault. The adapter MUST durably invalidate the resource and
   * throw {@link UploadOverrunError}, because the upload can never be
   * completed coherently again. Returning normally would answer a destroyed
   * upload with a success and an offset the client cannot build on.
   *
   * `false`: the bound is this REQUEST's ceiling (`maxAppendSize`, or a
   * backend's own per-call limit). A body that runs past it has done nothing
   * to the representation, so the adapter stops at the bound, returns the
   * bytes it made durable, and leaves the resource healthy for the client to
   * resume from the truthful offset. Destroying an upload over a per-request
   * cap turns a resumable situation into a lost one.
   *
   * An adapter that ignores this and always invalidates is the bug this field
   * exists to prevent; one that always stops is worse, because it lets bytes
   * past a declared length pass silently.
   *
   * Absent when `maxBytes` is: with no bound there is nothing to cross, so
   * nothing can be fatal, and a caller should not have to state a consequence
   * for a limit it never set. Present whenever `maxBytes` is, which the
   * orchestrator guarantees by deriving the two from one decision. An adapter
   * reading it absent treats a crossing as non-fatal, the direction that keeps
   * the resource.
   */
  maxBytesFatal?: boolean;
  /**
   * A total representation length FIRST declared on this append (the
   * deferred-length flow: creation left it unknown, a later append states
   * it). When present the adapter MUST persist it durably so a subsequent
   * `getUploadState` reports it as `length` and it becomes immutable. The
   * orchestrator only ever sets this once, and only when the resource had no
   * length yet, so an adapter never has to reconcile a conflicting value.
   */
  length?: number;
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
 * Storage backend capable of resumable writes. All mutating calls are made by
 * the orchestrator UNDER the upload's lock and after a fresh
 * `getUploadState`.
 *
 * That lock is not the last line of defense, and an adapter must not treat it
 * as one. Every expiry-based distributed lock can be STOLEN from a holder that
 * stalls past its TTL and then resumes, so a write can still arrive from a
 * holder that no longer owns the resource. `appendChunk` therefore MUST
 * re-derive durable state at the start of the call, compare it against the
 * claimed offset, and throw {@link UploadOffsetConflictError} instead of
 * writing when the two disagree. Declare it via
 * {@link ResumableWriteStore.enforcesOffsetCheck}; the orchestrator refuses a
 * store that reports `false`.
 *
 * Be precise about what that buys, because it is a floor and not a proof. The
 * check is a PREFLIGHT, not a transaction: it makes a stale holder's NEXT
 * append loud, which is the case that actually happens (the holder stalls,
 * its TTL lapses, a new holder appends, the stale one comes back and asks to
 * write at an offset that has moved). It cannot cover a holder that stalls
 * MID-call and resumes, because none of these backends offers a precondition
 * on the write itself: `UploadPart`, `stageBlock`, an R2 part upload and a
 * positional file write all take the bytes unconditionally, and a re-check
 * before each flush would only move the same race a few milliseconds later.
 * That residual is bounded, not absent: the orchestrator threads the lock's
 * signal into the write and every adapter tests it at each chunk boundary, so
 * a resumed holder whose watchdog has already fired stops pulling from the
 * body there. Be exact about what that bounds, because the shorter claim is
 * false: the ceiling is the bytes of ONE already-accepted chunk, not one
 * backend call. An adapter makes those bytes durable in whatever shape its
 * backend takes (several parts, or a part plus a staged remainder), and
 * stopping part-way through the shaping would not make fewer of them durable,
 * only differently arranged. Closing the window entirely needs a fencing token
 * the backend can enforce, which is tracked, not pretended.
 *
 * The bytes are not the whole surface, and this is worth stating because it is
 * easy to read the paragraph above as covering everything. An adapter's own
 * METADATA record is written back the same unconditional way, so a stale holder
 * can revert a flag a newer one set. Where that record holds only flags and
 * write-once facts, a fresh read plus a monotonic merge shrinks the window to
 * one round trip and no terminal flag can be cleared (`s3.ts`, whose offset
 * comes from the backend's own part listing rather than from the record).
 * Where the record IS the offset ledger, that is not enough: two holders each
 * hold their own copy of a parts array, and a merge of those is a
 * reconciliation rather than a rule.
 * // descope: `r2.ts` and `azure.ts` keep the unconditional write, because for
 * // them the right answer is a conditional one (S3 gained If-Match on
 * // PutObject; Azure blobs have had If-Match on setMetadata), not a merge.
 * // Revisit when a `sidecarCas` capability lands, which is the same work that
 * // would give the store a token-independent stale-writer rejection.
 */
export interface ResumableWriteStore {
  /**
   * Allocate a new upload resource and return its opaque token. The token is
   * the ONLY handle later calls receive: fold everything resumption needs
   * into it (the built-ins encode key + backend upload id). The engine and
   * orchestrator never parse it.
   *
   * The token MUST be unguessable, because possession of it IS the
   * authorization. A resumable upload is reached by URL for minutes or days
   * after the request that created it, and nothing in the protocol
   * re-authenticates that follow-up: whoever holds the token can append to,
   * probe, and cancel the upload. Derive it from a CSPRNG with at least the
   * ~122 bits a v4 UUID carries, which is what the built-in stores use
   * (`crypto.randomUUID`, or the backend's own upload id for S3). A token
   * built from a counter, a timestamp, or the storage key turns "authorized
   * the creation" into "authorized everyone who can guess a neighbour".
   */
  createUpload(opts: CreateUploadOptions): Promise<{ uploadToken: string }>;

  /** Fresh, backend-derived state. Throws {@link UploadNotFoundError}. */
  getUploadState(uploadToken: string, opts?: { signal?: AbortSignal }): Promise<StoredUploadState>;

  /**
   * Append `body` at `offset` (already engine-validated against fresh state).
   * Returns the bytes made DURABLE by this call: on interruption that is the
   * flushed prefix, and the next `getUploadState` must agree with it.
   */
  /**
   * A terminal resource refuses every append. The orchestrator answers `gone`
   * from the state it already read, so this refusal is reached only by a
   * caller holding the store directly, and the error it throws is a guard
   * rather than a wire outcome: no dialect maps it, because no dialect gets
   * there. A store may throw whatever names the situation.
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

  /**
   * Discard the resource and its partial bytes. Idempotent.
   *
   * MUST NOT touch an object this upload already published. Once
   * `completeUpload` returns, the object at the key is live data that readers
   * can already be serving, and the upload resource is only the scaffolding
   * that produced it; a DELETE arriving late, retried, or replayed terminates
   * the UPLOAD, never its result. An implementation that deleted the object
   * here would make an idempotent-by-contract call destroy production data on
   * its second invocation, with no way for the caller to tell the difference.
   * Callers that do want the object gone delete it through their own storage
   * API, where the intent is explicit.
   */
  abortUpload(uploadToken: string, opts?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Remove upload resources idle since before `olderThanMs` (epoch ms).
   * The storage-limitation GC hook: callers run it on a schedule; adapters
   * whose backend has native lifecycle rules may implement it as a no-op
   * and document the native rule instead.
   *
   * Three things this contract pins, because each has a wrong answer that
   * looks correct:
   *
   * 1. **It reclaims BYTES, not bookkeeping.** Sweeping a resource MUST have
   *    the same effect as {@link abortUpload} on it: partial data, staged
   *    parts/blocks, sidecars, the lot. A sweep that removes only the metadata
   *    leaves the bytes alive with nothing left pointing at them, so they can
   *    never be found or deleted again. Those bytes are the personal data a
   *    storage-limitation obligation is about, which makes a metadata-only
   *    sweep a compliance gap dressed as a cleanup.
   * 2. **Its clock is IDLENESS, not age.** The cutoff is compared against
   *    `lastAppendAt ?? createdAt`, while {@link UploadPolicy.maxAgeSeconds}
   *    is measured from creation alone. They are different clocks and neither
   *    implements the other: a resource can be refused as expired while a
   *    sweep still considers it active (it was appended to recently), and a
   *    never-appended resource is eligible for both at the same moment. Drive
   *    the sweep from wall-clock minus the retention you actually want.
   * 3. **It runs WITHOUT the upload's lock**, because a store has no locker.
   *    An append in flight has not updated `lastAppendAt` yet, so a resource
   *    being written to right now still looks idle since its last completed
   *    append. Keep the cutoff comfortably longer than the longest single
   *    append the deployment permits (a slow client uploading a large chunk
   *    over a thin link is the case to size for), or the sweep can reap a
   *    resource mid-write and the client's next request answers 404.
   */
  sweepExpired?(olderThanMs: number, opts?: { signal?: AbortSignal }): Promise<{ removed: number }>;

  // ── Capability flags (honest, per backend) ──
  //
  // Every adapter MUST accept an `appendChunk` of ANY size and buffer to its
  // backend's real granularity internally (S3 parks a sub-minimum tail, R2
  // buffers to a fixed part size, etc.). The orchestrator therefore does NOT
  // re-chunk; these two flags are efficiency HINTS a caller or CDN may use to
  // align chunk sizes, not constraints the orchestrator honors.
  /**
   * The backend's natural part size in bytes: aligning appends to a multiple
   * of it avoids the adapter's internal tail buffering. `undefined` = the
   * backend takes arbitrary byte-exact appends with no alignment benefit.
   */
  readonly appendGranularity?: number;
  /** The backend prefers every non-final part to be the same size (R2). */
  readonly uniformPartSize?: boolean;
  /**
   * Where the offset derivation gets its truth. `true`: the backend's own
   * bookkeeping (a file size, a part or block listing), so a reported offset
   * is one the backend can be asked to confirm. `false`: the adapter's own
   * durable ledger, with nothing in the backend to cross-check it against,
   * so after a crash the backend may report an offset a few bytes behind the
   * last acknowledged write (a part landed but its manifest entry did not).
   *
   * Neither value promises the offset never moves backwards. An adapter that
   * stages a sub-minimum remainder separately and later folds it into a part
   * has a crash window of its own, bounded by that remainder, in which the
   * derived offset regresses; that direction is deliberate, because an
   * OVERSTATED offset silently drops the client's bytes while an understated
   * one only re-sends them. What the flag distinguishes is whether the number
   * comes from the backend or from a ledger beside it, and therefore how far
   * behind it can be: a bounded remainder for `true`, one acknowledged write
   * for `false`. Neither is corruption; both cost at most a redundant chunk.
   *
   * A DISCLOSURE, not a behavior switch: nothing in the engine branches on
   * it. It is published so a consumer can weigh that recovery cost when
   * choosing a backend.
   */
  readonly exactOffsetRecovery?: boolean;
  /**
   * `completeUpload` is all-or-nothing: no torn object is ever visible to
   * readers. REQUIRED by the orchestrator (it publishes on a single
   * `completeUpload` and has no rollback of its own); `createUploadOrchestrator`
   * refuses a store that reports `false`.
   */
  readonly atomicCompletion: true;
  /**
   * `appendChunk` re-derives durable state at the start of every call and
   * refuses a claimed offset that disagrees with it, throwing
   * {@link UploadOffsetConflictError} rather than writing.
   *
   * REQUIRED by the orchestrator, which refuses a store that reports `false`.
   * The lock alone cannot carry this guarantee: an expiry-based distributed
   * lock can be stolen from a holder that stalls past its TTL and resumes, and
   * this check is what makes that holder's next append a loud conflict rather
   * than silent interleaving. A single-process deployment cannot opt out of
   * declaring it either, because the store is where the deployment shape stops
   * being knowable: the same store runs behind the in-process locker today and
   * a distributed one tomorrow, with no code change to notice.
   *
   * `true` claims a preflight per call, NOT that the check and the bytes are
   * one atomic step. See the interface docs for the residual window and what
   * bounds it; do not read this flag as "stale writes are impossible".
   */
  readonly enforcesOffsetCheck: true;
  /**
   * Whether the backend can verify a client-asserted SHA-256 over the whole
   * assembled representation at completion (`"sha256"`), or cannot (`false`).
   * SHA-256 is the only algorithm the orchestrator and the read-side
   * `Repr-Digest` wiring speak end to end, so this is a two-value capability,
   * not an algorithm menu.
   */
  readonly digestOnComplete: "sha256" | false;
  /** Largest single append the backend accepts, when bounded. */
  readonly maxAppendSize?: number;
}

/**
 * A {@link ResumableWriteStore} that definitely sweeps. Every built-in store
 * implements `sweepExpired`, so their factories return this: a consumer can
 * call it without a `?.` that would silently become a no-op, which is exactly
 * how a retention obligation goes unmet. Assignable anywhere the wider type is
 * expected, so a custom store that leaves the method out still fits.
 *
 * Declared AFTER the interface on purpose. A doc comment attaches to the next
 * declaration and nothing else, so a type placed between the contract's
 * docblock and `ResumableWriteStore` silently detaches the contract from the
 * thing it describes: rendered API docs and IDE hovers then show a store
 * implementer none of the MUST-re-derive rule the whole locking story rests on.
 */
export type SweepingWriteStore =
  ResumableWriteStore & Required<Pick<ResumableWriteStore, "sweepExpired">>;
