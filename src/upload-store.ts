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

import type { UploadStatus } from "./upload-engine.ts";

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * The stable `code` every upload error class carries, for a consumer to switch
 * on instead of parsing a message or comparing `name`.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type UploadErrorCode =
    | "UPLOAD_NOT_FOUND"
    | "UPLOAD_OFFSET_CONFLICT"
    | "UPLOAD_DESTINATION_CONFLICT"
    | "UPLOAD_APPEND_BOUND"
    | "UPLOAD_OVERRUN"
    | "UPLOAD_DIGEST_MISMATCH"
    | "UPLOAD_DIGEST_UNVERIFIABLE"
    | "UPLOAD_LOCK_TIMEOUT";

/**
 * The revision of the {@link ResumableWriteStore} contract this build
 * implements. A store declares the revision it was written against as
 * {@link ResumableWriteStore.contractVersion}, and the orchestrator refuses a
 * store that names another, so a contract change surfaces at construction
 * instead of as a misread result mid-upload.
 */
export const UPLOAD_STORE_CONTRACT_VERSION = 1;

/**
 * A digest algorithm a store can verify at completion, by its RFC 9530
 * registered name.
 *
 * May gain a member in a minor release: give a switch over it a default branch.
 */
export type UploadDigestAlgorithm = "sha-256" | "sha-512";

/** Raw base64 digests of a whole representation, keyed by algorithm. */
export type UploadDigests = { readonly [A in UploadDigestAlgorithm]?: string };

/**
 * The upload resource does not exist (never created, already completed and
 * reaped, cancelled, or expired-and-swept). Dialects answer 404.
 * Matched by `name`, so custom stores can throw equivalently-named errors
 * without importing the class.
 */
export class UploadNotFoundError extends Error {
    readonly status = 404 as const;
    readonly code = "UPLOAD_NOT_FOUND" as const;
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
    readonly code = "UPLOAD_OFFSET_CONFLICT" as const;
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
 * Completion found the destination key in a state this upload did not leave
 * it in, and refused to publish over it or to claim it. Two cases raise it:
 * the object at the key changed after the completion sealed its plan (a
 * third party wrote the key between the seal and the publish, which the
 * publish's provider precondition refused), or a completion retried after a
 * lost publish response finds an object at the key that carries no proof of
 * being this upload's publication.
 *
 * Never retried by the store and never resolved by overwriting: the object at
 * the key is someone's data. The upload stays sealed and unpublished, and
 * every dialect answers 409, so a client learns that this completion will not
 * succeed by repetition. An operator reconciles the key (the error is
 * reported through `onError`) and either deletes the upload or the foreign
 * object.
 */
export class UploadDestinationConflictError extends Error {
    readonly code = "UPLOAD_DESTINATION_CONFLICT" as const;
    readonly uploadToken: string;
    constructor(uploadToken: string, cause?: unknown) {
        super("Upload completion: the destination changed under the sealed plan; nothing was published");
        this.name = "UploadDestinationConflictError";
        this.uploadToken = uploadToken;
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
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
    readonly code = "UPLOAD_APPEND_BOUND" as const;
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
    readonly code = "UPLOAD_OVERRUN" as const;
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
    readonly code = "UPLOAD_DIGEST_MISMATCH" as const;
    readonly uploadToken: string;
    /** The algorithm whose digest disagreed. */
    readonly algorithm: UploadDigestAlgorithm;
    readonly expectedDigest: string;
    readonly actualDigest?: string;
    constructor(uploadToken: string, algorithm: UploadDigestAlgorithm, expectedDigest: string, actualDigest?: string) {
        super(`Upload completion: assembled bytes do not match the asserted ${algorithm} digest`);
        this.name = "UploadDigestMismatchError";
        this.uploadToken = uploadToken;
        this.algorithm = algorithm;
        this.expectedDigest = expectedDigest;
        this.actualDigest = actualDigest;
    }
}

/**
 * A request asserted digests and the store verifies none of the asserted
 * algorithms, under `digestPolicy: "require-verifiable"`. Raised before
 * anything is allocated or written.
 */
export class UploadDigestUnverifiableError extends Error {
    readonly code = "UPLOAD_DIGEST_UNVERIFIABLE" as const;
    constructor() {
        super("Upload digest cannot be verified");
        this.name = "UploadDigestUnverifiableError";
    }
}

/**
 * Name-based matchers (cross-package instanceof safety, same as read side).
 * Each narrows to its class by `name`, not `instanceof`, so a custom store
 * can throw an equivalently-named error without importing the class. The
 * narrowing is therefore unsound against a same-named error that lacks the
 * class's fields; that is the accepted cost of matching across copies of
 * the package.
 */
export function isUploadNotFoundError(err: unknown): err is UploadNotFoundError {
    return err instanceof Error && err.name === "UploadNotFoundError";
}
export function isUploadOffsetConflictError(err: unknown): err is UploadOffsetConflictError {
    return err instanceof Error && err.name === "UploadOffsetConflictError";
}
export function isUploadDestinationConflictError(err: unknown): err is UploadDestinationConflictError {
    return err instanceof Error && err.name === "UploadDestinationConflictError";
}
export function isUploadAppendBoundError(err: unknown): err is UploadAppendBoundError {
    return err instanceof Error && err.name === "UploadAppendBoundError";
}
export function isUploadOverrunError(err: unknown): err is UploadOverrunError {
    return err instanceof Error && err.name === "UploadOverrunError";
}
export function isUploadDigestMismatchError(err: unknown): err is UploadDigestMismatchError {
    return err instanceof Error && err.name === "UploadDigestMismatchError";
}
export function isUploadDigestUnverifiableError(err: unknown): err is UploadDigestUnverifiableError {
    return err instanceof Error && err.name === "UploadDigestUnverifiableError";
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
    /**
     * Where the resource is in its lifecycle. `"complete"`: completion already
     * happened (idempotent-retry answers). `"invalidated"`: the resource is
     * terminally dead (bytes lost, or an over-append landed); adapters record
     * this durably so every later probe and append refuses. Cancellation is
     * the exception: a dead resource must still be discardable, or its partial
     * bytes are stranded until a sweep that may never run.
     */
    status: UploadStatus;
    /** Epoch ms of creation. */
    createdAt: number;
    /**
     * Epoch ms at which the resource expires, exactly as handed to
     * {@link CreateUploadOptions.expiresAt}; absent when none was. Expiry is
     * judged from this recorded instant, so a later request resolving a
     * shorter policy cannot shorten a lifetime already granted.
     */
    expiresAt?: number;
    /** Epoch ms of the last accepted append, when any. */
    lastAppendAt?: number;
    /** Opaque caller metadata recorded at creation (dialects carry filename/type). */
    metadata?: Record<string, string>;
    /**
     * What this read saw, for the append that follows it: present only when
     * the read was asked for with {@link UploadStateReadOptions.forAppend} and
     * the store can use it. Opaque to every caller; hand it back unchanged as
     * {@link AppendChunkOptions.snapshot}.
     */
    snapshot?: UploadStateSnapshot;
}

/**
 * A store's own record of a state read, handed back to the same store's
 * `appendChunk`. Nothing outside the store that minted it reads it, and a
 * store ignores one it did not mint.
 */
export type UploadStateSnapshot = object;

export interface UploadStateReadOptions {
    signal?: AbortSignal;
    /**
     * The caller appends next, under the lock it holds now, and passes the
     * returned {@link StoredUploadState.snapshot} along. A store may then read
     * here what that append needs and skip reading it again.
     */
    forAppend?: boolean;
    /**
     * `false` from a caller that holds no lock: the read must not write. A
     * store that heals bookkeeping on read (promoting a matched publication
     * record, rewriting a sidecar) skips the write and reports the state it
     * derived, since an unlocked write can race a completion or a cancel and
     * recreate what that removed. Omitted means a locked caller, which may let
     * the store repair.
     */
    repair?: false;
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
    /**
     * The resource's expiry, epoch ms, derived from the creation policy's
     * max age. A store MUST record it durably and report it unchanged as
     * {@link StoredUploadState.expiresAt}; a store that drops it leaves
     * every later request to judge expiry by the policy that request
     * resolves.
     */
    expiresAt?: number;
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
     * Yield signal: a client disconnect past its grace window, or a later
     * acquirer preempting the resource lock. Adapters SHOULD keep flushing
     * already-received bytes briefly after an abort (the orchestrator owns the
     * grace window and passes a signal that reflects it), must account partial
     * writes truthfully in `bytesWritten`, and must report the yield as
     * {@link AppendChunkResult.interrupted} rather than raising it.
     */
    signal?: AbortSignal;
    /** The claim this write is made under; see {@link UploadClaim}. */
    epoch?: number;
    /**
     * The snapshot of the state read this append was validated against, made
     * under the same lock. A store MAY use it in place of reading that state
     * again, and then MUST fail closed when it is stale: the append's final
     * write is conditioned on what the snapshot saw, and a condition that no
     * longer holds throws {@link UploadOffsetConflictError} with the offset the
     * upload has truly reached. A store without a fence ignores it.
     */
    snapshot?: UploadStateSnapshot;
    /**
     * Release the request body: cancel whatever of it is unread, so the peer
     * stops sending, and free what the caller holds for it.
     *
     * Safe whether or not the store has locked `body` with a reader of its
     * own, which is what `body.cancel()` is not: a locked stream refuses it,
     * and the producer keeps running. Idempotent, never rejects, and a no-op
     * once the body has been read to its end, so a store may call it at every
     * early stop (a yield, a request ceiling, a refused claim, a thrown error)
     * or unconditionally on its way out. A read of `body` after it fails, and
     * is never a clean end: a store reads a clean end as the whole body.
     *
     * The orchestrator always passes it and also calls it itself once
     * `appendChunk` settles, so a store that misses an exit cannot strand the
     * body. A caller holding the store directly may omit it; the store then
     * cancels `body` itself at the exits where it never read it.
     */
    releaseBody?: () => Promise<void>;
}

/**
 * A store-minted fencing claim on one upload resource, from
 * {@link ResumableWriteStore.claimUpload}.
 *
 * The lock decides who SHOULD write; a claim lets the store decide who MAY.
 * The orchestrator claims under the lock, after its fresh state read, only for
 * a request about to write, and passes the epoch on every write made under it
 * (`appendChunk`, `completeUpload`, `abortUpload`). A store that mints claims
 * MUST make each epoch greater than every earlier one for the resource, and
 * MUST refuse a write carrying an epoch below the latest it minted by throwing
 * {@link UploadOffsetConflictError} with the durable offset, which every
 * dialect already answers as a stale writer. That closes the window the
 * at-write offset check leaves open, a holder that stalls mid-call and resumes
 * after its lock was stolen, to the extent the backend can enforce the epoch
 * on the write itself.
 *
 * Adoption stays additive. A store without `claimUpload` is never asked for a
 * claim and never receives an epoch, exactly as before; implementing it is a
 * capability, not a contract version.
 */
export interface UploadClaim {
    /** Monotonic per resource: each claim's epoch exceeds every earlier one. */
    readonly epoch: number;
}

/**
 * Which resources a sweep may reclaim. A resource matching EITHER cutoff is
 * dead, because each names an independent way an upload ends: abandoned
 * mid-transfer, or past the lifetime every request already refuses it for.
 *
 * At least one must be given. A sweep with neither would reclaim nothing while
 * looking like a retention control, which is the failure mode this hook exists
 * to prevent.
 */
export interface UploadSweepCutoff {
    /**
     * Reap a resource whose last append (or, with no append, its creation)
     * predates this epoch-ms instant: the abandoned-transfer clock.
     */
    idleSinceMs?: number;
    /**
     * Reap a resource CREATED before this epoch-ms instant: the lifetime clock
     * {@link UploadPolicy.maxAgeSeconds} enforces per request. Derive it as
     * `now - maxAgeSeconds * 1000` and an expired resource is reclaimable at the
     * same moment it stops being usable.
     */
    createdBeforeMs?: number;
}

/** What one `appendChunk` made durable, and whether it ran to the body's end. */
export interface AppendChunkResult {
    /** Bytes made durable by this call. The next state read must agree with it. */
    bytesWritten: number;
    /**
     * The call stopped before the body was exhausted because something asked it
     * to yield: the abort signal (a client disconnect past its grace window, or
     * a later acquirer preempting the lock), or a torn body. `false` on a body
     * read to its end, which is every clean append.
     */
    interrupted: boolean;
}

export interface CompleteUploadOptions {
    /**
     * Raw base64 digests the client asserted for the whole representation,
     * keyed by algorithm. The orchestrator passes only algorithms the store
     * lists in `digestOnComplete`; a mismatch in ANY of them MUST throw
     * {@link UploadDigestMismatchError} BEFORE publishing. Adapters never
     * silently ignore a digest they were handed.
     */
    expectedDigests?: UploadDigests;
    /**
     * The length the caller judged complete: the durable offset it observed
     * under the lock, which is every byte it acknowledged. The store seals
     * its plan at this length ({@link ResumableWriteStore.completeUpload})
     * and MUST throw {@link UploadOffsetConflictError}, carrying the length
     * the sealed assembly actually holds, instead of publishing an assembly
     * of any other length. That is what makes an acknowledged append
     * impossible to omit: a completer whose view predates a successor's
     * append is refused rather than publishing the shorter object.
     */
    expectedLength: number;
    now: number;
    /**
     * Stop signal. The orchestrator links the request's grace window and the
     * lock's lease (`UploadLock.lease`), so a holder that can no longer
     * prove it holds the resource stops before its next backend call. A
     * cooperative stop, not the fence: the seal is.
     */
    signal?: AbortSignal;
    /** The claim this publish is made under; see {@link UploadClaim}. */
    epoch?: number;
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
 * the backend can enforce: the optional {@link ResumableWriteStore.claimUpload}
 * seam ({@link UploadClaim}), which no built-in adapter implements yet.
 *
 * The bytes are not the whole surface, and this is worth stating because it is
 * easy to read the paragraph above as covering everything. An adapter's own
 * METADATA record is a second write a stale holder can make, and it is the
 * only place a terminal flag lives, so a record written back from a stale
 * snapshot would revert a flag a newer holder set. The three adapters that
 * keep such a record write it CONDITIONALLY on the version they read (S3
 * `If-Match` on the sidecar `PutObject`, R2 `onlyIf` on the manifest, Azure
 * `ifMatch` on the info blob's metadata), so a stale writer's record is refused
 * rather than merged. Where the record holds flags and write-once facts
 * (`s3.ts`, `azure.ts`), the refused writer re-reads, merges with the terminal
 * flags one-way, and retries a bounded number of times; where the record IS
 * the offset ledger (`r2.ts`), two holders' parts arrays cannot be merged, and
 * the loser is answered as every stale writer is, with the winner's durable
 * offset. The residual is per backend and named at each adapter: a backend
 * without the precondition refuses the option-less form loudly (`sidecarCas`
 * on the S3 store) rather than degrading in place.
 */
export interface ResumableWriteStore {
    /**
     * Allocate a new upload resource and return its token. The token is the
     * ONLY handle later calls receive, and it MUST be opaque and encode
     * nothing: keep the object key, any backend upload id, and everything else
     * resumption needs server-side, looked up by the token. A token that
     * carries the key discloses it to every client that holds the upload URL,
     * and a store that decodes the key back out of a presented token lets a
     * client forge one that names another object. The engine and orchestrator
     * never parse it; `checkResumableWriteStore` fails a token that contains
     * its key, plain, percent-encoded or base64.
     *
     * The token MUST be unguessable, because possession of it IS the
     * authorization. A resumable upload is reached by URL for minutes or days
     * after the request that created it, and nothing in the protocol
     * re-authenticates that follow-up: whoever holds the token can append to,
     * probe, and cancel the upload. Derive it from a CSPRNG with at least the
     * ~122 bits a v4 UUID carries, which is what every built-in store mints
     * (`crypto.randomUUID`), never the backend's own upload id. A token
     * built from a counter, a timestamp, or the storage key turns "authorized
     * the creation" into "authorized everyone who can guess a neighbour".
     */
    createUpload(opts: CreateUploadOptions): Promise<{ uploadToken: string }>;

    /** Fresh, backend-derived state. Throws {@link UploadNotFoundError}. */
    getUploadState(uploadToken: string, opts?: UploadStateReadOptions): Promise<StoredUploadState>;

    /**
     * Append `body` at `offset` (already engine-validated against fresh state).
     *
     * `bytesWritten` is the count made DURABLE by this call: on interruption
     * that is the flushed prefix, and the next `getUploadState` must agree with
     * it. `interrupted` says whether the call stopped before the body was
     * exhausted because something asked it to YIELD: the abort signal was
     * already latched on arrival, it fired mid-read, or the body itself tore.
     * `false` means the body was read to its end.
     *
     * The store is the only party that reads the body, so it is the only one
     * that knows this. A caller that inferred it from the signal instead would
     * be reading "something asked for a yield" as "the store yielded", which is
     * also true of a store that threw: an abort is therefore reported here and
     * NOT raised, so a caller never has to classify an exception to tell a
     * yield from a failure.
     *
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
    ): Promise<AppendChunkResult>;

    /**
     * Publish the assembled object to its key. After success the object is
     * readable and the upload resource answers status `"complete"`.
     *
     * Completion is a sealed-plan transaction, in this order:
     *
     * 1. SEAL. Durably mark the resource completing at
     *    {@link CompleteUploadOptions.expectedLength}, with a write
     *    conditioned on the record version the store read (the same
     *    compare-and-swap its other record writes use), and record the
     *    destination state publication is allowed over: the version of the
     *    object at the key now, or its absence. A seal already present is
     *    adopted (a retried completion) and re-pointed at the new length.
     * 2. FENCE. From the seal on, `appendChunk` MUST refuse with
     *    {@link UploadOffsetConflictError} and acknowledge nothing. An append
     *    tests the seal AFTER its bytes are durable and before it returns, so
     *    an append either finished before the seal (and its bytes are in the
     *    snapshot below) or is refused; there is no third order. A check
     *    before the write alone would leave one.
     * 3. SNAPSHOT. Take the assembly plan (parts, chunks, blocks, file
     *    length) only after the seal, and throw
     *    {@link UploadOffsetConflictError} carrying the plan's length when it
     *    is not `expectedLength`, lifting the seal first so the upload stays
     *    resumable.
     * 4. PUBLISH under the provider's own precondition on the destination
     *    state the seal recorded, so a key a third party wrote after the
     *    seal is never overwritten: the store throws
     *    {@link UploadDestinationConflictError} instead. The published object
     *    carries this upload's publication identity (a random id the store
     *    minted, in object metadata, or the file identity on a filesystem).
     * 5. RECORD completion. A failure here leaves a published object and a
     *    sealed record; the next completion or state read recovers it by
     *    identity, never by shape: an object at the key is adopted as this
     *    upload's only when it carries this upload's publication identity,
     *    and anything else raises {@link UploadDestinationConflictError}.
     *
     * A failure before step 4 leaves nothing new visible. A failure after it
     * leaves an object that is exactly the sealed plan, and the upload
     * recoverable to complete; it never leaves a different object published.
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
     * API, where the intent is explicit. `checkResumableWriteStore`
     * (`partial-content/conformance`) asserts this against the object itself
     * when it is given a `readObject` hook, and reports it unverified when it is
     * not: nothing the store says about its own resource can show whether the
     * published object is still there.
     */
    abortUpload(uploadToken: string, opts?: { signal?: AbortSignal; epoch?: number }): Promise<void>;

    /**
     * Mint a fencing claim on the resource ({@link UploadClaim}). Optional: the
     * orchestrator calls it, under the lock, only on a store that implements
     * it, and threads the returned epoch into the writes that follow. Throws
     * {@link UploadNotFoundError} for an unknown token; any other throw is a
     * store failure and nothing is written. No built-in adapter implements it
     * yet.
     */
    claimUpload?(uploadToken: string, opts?: { signal?: AbortSignal }): Promise<UploadClaim>;

    /**
     * Remove upload resources that either cutoff in {@link UploadSweepCutoff}
     * names. The storage-limitation GC hook: callers run it on a schedule;
     * adapters whose backend has native lifecycle rules may implement it as a
     * no-op and document the native rule instead.
     *
     * Four things this contract pins, because each has a wrong answer that
     * looks correct:
     *
     * 1. **It reclaims BYTES, not bookkeeping.** Sweeping a resource MUST have
     *    the same effect as {@link abortUpload} on it: partial data, staged
     *    parts/blocks, sidecars, the lot. A sweep that removes only the metadata
     *    leaves the bytes alive with nothing left pointing at them, so they can
     *    never be found or deleted again. Those bytes are the personal data a
     *    storage-limitation obligation is about, which makes a metadata-only
     *    sweep a compliance gap dressed as a cleanup.
     * 2. **The two cutoffs are different clocks and a resource dies by either.**
     *    Idleness measures from the last append, lifetime from creation, and
     *    neither implements the other. A resource appended to once a minute is
     *    never idle, so an idleness sweep alone can never reach it, while every
     *    request against it is already refused once it passes
     *    {@link UploadPolicy.maxAgeSeconds}: storage that nothing can reclaim
     *    and nothing can use. Pass `createdBeforeMs` derived from the same max
     *    age the policy enforces, and the two agree by construction.
     * 3. **It runs WITHOUT the upload's lock**, because a store has no locker.
     *    An append in flight has not updated `lastAppendAt` yet, so a resource
     *    being written to right now still looks idle since its last completed
     *    append. Keep `idleSinceMs` comfortably longer than the longest single
     *    append the deployment permits (a slow client uploading a large chunk
     *    over a thin link is the case to size for), or the sweep can reap a
     *    resource mid-write and the client's next request answers 404.
     * 4. **One unreclaimable resource must not end the scan, and the count says
     *    so.** `failed` is the resources this pass condemned and could not
     *    remove: a file another handle holds open, a key a permission denies, a
     *    backend that answered an error. Each stays where it is and the next
     *    pass retries it. Propagating the first such failure instead would
     *    abandon every resource behind it, so one busy upload could stop a
     *    scheduled sweep from reclaiming anything, for as long as it stayed
     *    busy. `failed` is what a caller alerts on: a sweep that runs and
     *    reclaims nothing is otherwise indistinguishable from a sweep with
     *    nothing to do, and the difference surfaces later as unexplained
     *    storage growth. What makes the scan itself impossible still rejects:
     *    an unreadable listing cannot be counted resource by resource, and an
     *    aborted signal is the caller stopping the sweep rather than a resource
     *    resisting reclamation.
     */
    sweepExpired?(
        cutoff: UploadSweepCutoff,
        opts?: { signal?: AbortSignal },
    ): Promise<{ removed: number; failed: number }>;

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
     * one can be re-sent, PROVIDED the client still holds the bytes: an
     * acknowledgement is not a licence to discard, and the contract says so
     * (docs/API.md, capability flags), because a client that frees bytes on
     * acknowledgement cannot resume across the window. What the flag
     * distinguishes is whether the number comes from the backend or from a
     * ledger beside it, and therefore how much a client must retain: a bounded
     * remainder for `true`, one acknowledged write for `false`. Neither is
     * corruption; both cost at most a redundant chunk.
     *
     * A DISCLOSURE, not a behavior switch: nothing in the engine branches on
     * it. It is published so a consumer can weigh that recovery cost when
     * choosing a backend.
     */
    readonly exactOffsetRecovery?: boolean;
    /**
     * The contract revision this store was written against,
     * {@link UPLOAD_STORE_CONTRACT_VERSION} at the time. Optional; when
     * present, `createUploadOrchestrator` refuses any value but the current
     * one.
     */
    readonly contractVersion?: typeof UPLOAD_STORE_CONTRACT_VERSION;
    /**
     * `completeUpload` is all-or-nothing: no torn object is ever visible to
     * readers. REQUIRED by the orchestrator (it publishes on a single
     * `completeUpload` and has no rollback of its own); `createUploadOrchestrator`
     * refuses a store that reports `false`.
     *
     * `boolean`, not the literal `true`: a flag a store cannot state falsely is
     * a flag whose guard can never fire, and the refusal above is the whole
     * point of asking. Declaring `true` is a CLAIM about behaviour that nothing
     * at construction can verify, so prove it with
     * `checkResumableWriteStore` (`partial-content/conformance`).
     *
     * What it can prove depends on what it is given, because this claim is
     * about the OBJECT and a write store cannot be asked to look at one. Hand
     * the harness a `readObject` hook and it asserts that the destination key
     * holds nothing while the upload is open, that completion puts the appended
     * bytes there whole, and that a completion which fails verification left the
     * key untouched and the upload still completable. Without that hook it
     * reports each of those unverified rather than met: a store's own
     * bookkeeping saying "not complete" is the claim, not evidence for it.
     */
    readonly atomicCompletion: boolean;
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
     *
     * `boolean`, not the literal `true`: a store that cannot make the check must
     * be able to say so and be refused, and a flag that only admits one value
     * makes the refusal unreachable. Declaring `true` is still only a claim;
     * `checkResumableWriteStore` (`partial-content/conformance`) is what turns
     * it into an assertion. It replays a stalled writer's stale append and
     * requires the conflict, and then requires that the replay changed nothing:
     * the durable offset stayed put, and the bytes did too. Both halves are
     * needed, because a store that writes first and checks afterwards raises
     * exactly the same conflict over an object it has already corrupted. The
     * byte half reads the destination through `readObject`, or through the
     * store's own completion-time digest verification where it has one, and
     * where it has neither the harness reports it unverified.
     */
    readonly enforcesOffsetCheck: boolean;
    /**
     * The algorithms whose client-asserted digest over the whole assembled
     * representation the backend verifies at completion, or `false` when it
     * verifies none. An assertion in an algorithm not listed is advisory and
     * is dropped before it reaches the store (RFC 9530).
     */
    readonly digestOnComplete: readonly UploadDigestAlgorithm[] | false;
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
export type SweepingWriteStore = ResumableWriteStore & Required<Pick<ResumableWriteStore, "sweepExpired">>;

/**
 * A sweeping store that keeps its bookkeeping under a key prefix of the
 * location it shares with a read store.
 *
 * `uploadPrefix` is the EFFECTIVE prefix, the configured one or the default.
 * Hand it to the read store so the two cannot disagree about which keys are
 * the upload store's: `s3Store({ client, bucket, reservedPrefix: uploads.uploadPrefix })`.
 */
export type PrefixedUploadStore = SweepingWriteStore & {
    /** The key prefix the store writes its in-flight bytes and sidecars under. */
    readonly uploadPrefix: string;
};
