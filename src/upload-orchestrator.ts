/**
 * Upload orchestrator: the dialect-agnostic core between wire dialects and
 * storage.
 *
 * Sequencing contract (the invariants that make the engine's verdicts safe):
 * 1. Every resource interaction runs UNDER the resource's lock, probes
 *    included (torn multi-call offset reads).
 * 2. State is fetched FRESH from the store inside the lock, immediately
 *    before evaluation. Nothing from an earlier request is reused.
 * 3. The engine decides; the orchestrator executes exactly the verdict's
 *    action and nothing else.
 * 4. Store writes get a GRACE WINDOW past client abort: a dropped append
 *    still flushes the bytes it already received (the offset a later probe
 *    reports must reflect them), so the request signal is decoupled from
 *    the storage signal by `graceMs`.
 * 5. Hooks are guarded: an observability failure is reported to `onError`,
 *    never allowed to corrupt an upload.
 * 6. Preemption is signal-based: the lock hands the holder a
 *    `lock.signal` that aborts when a later acquirer wants the resource, and
 *    the holder threads it into its store write so it yields at once. There is
 *    no callback and no separate "was I preempted" flag; the signal's latched
 *    `.aborted` IS that state, so a preempt landing during hand-over is never
 *    lost. Cooperative preemption has an observation-latency ceiling: a holder
 *    stalled (GC/event-loop) past the point it should have yielded can still
 *    make one already-accepted body chunk durable after a later acquirer
 *    believes it holds the lock. That is a bound on BYTES, not on backend
 *    calls: an adapter shapes those bytes as its backend requires, so the
 *    chunk may become several parts. The
 *    store contract bounds the damage: every store MUST re-check the claimed
 *    offset at write time (`UploadOffsetConflictError`) and declare that it
 *    does via `enforcesOffsetCheck`, so a stale write is refused, not merged,
 *    and a store that cannot promise it is refused at construction.
 *    A store may close the rest with a fencing claim (`claimUpload`, see
 *    `UploadClaim`): the orchestrator claims under the lock before writing
 *    and threads the epoch into every write made under it.
 *    // descope: no built-in adapter mints claims; the at-write offset check
 *    // guards their bytes and conditional metadata writes guard their records.
 *    // Revisit when a backend gains a precondition on its part/block write,
 *    // which is the one write an epoch could still fence.
 *
 * Dialects (tus 1.0, IETF draft) translate requests into intents, call one
 * orchestrator method, and translate the returned OUTCOME into statuses and
 * headers. Outcomes are wire-agnostic, like the engine's verdicts they wrap.
 */

import {
    evaluateUploadCreation,
    evaluateUploadIntent,
    uploadExpiry,
    type AppendIntent,
    type CreateIntent,
    type FatalBoundReason,
    type UploadAuditEvent,
    type UploadPolicy,
    type UploadVerdict,
} from "./upload-engine.ts";
import {
    isUploadDigestMismatchError,
    isUploadDigestUnverifiableError,
    isUploadNotFoundError,
    isUploadOffsetConflictError,
    isUploadDestinationConflictError,
    isUploadAppendBoundError,
    isUploadOverrunError,
    UPLOAD_STORE_CONTRACT_VERSION,
    UploadDigestUnverifiableError,
    type AppendChunkOptions,
    type AppendChunkResult,
    type CompletedUpload,
    type ResumableWriteStore,
    type StoredUploadState,
    type UploadDigestAlgorithm,
    type UploadDigests,
} from "./upload-store.ts";
import { memoryUploadLocker, isUploadLockTimeoutError, type UploadLocker, type UploadLock } from "./upload-locker.ts";
import {
    MAX_TIMER_MS,
    cancelUploadBody,
    intOption,
    isCorruptUploadState,
    type UploadBody,
} from "./upload-internals.ts";
import { projectError } from "./object-store.ts";

// ─── Options ────────────────────────────────────────────────────────────────

export interface UploadResourceEvent {
    /**
     * The upload token the event concerns, present only when no `auditKey` was
     * supplied (and absent for creation rejections, which have no resource yet).
     *
     * The token is the CAPABILITY: possession of it authorizes appending to,
     * probing, and cancelling the upload, because that is the only
     * authorization a resumable protocol carries once the first request is
     * past. This hook is the most log-adjacent surface in the package, so
     * handing it the credential alongside an audit-safe substitute would mean
     * the safe path still writes the capability into log records. Supply an
     * `auditKey` and the token is not reported at all.
     */
    uploadToken?: string;
    /** Audit-safe identifier when the caller supplied one (never the raw key). */
    auditKey?: string;
    event: UploadAuditEvent;
}

export interface UploadOrchestratorOptions {
    /** Server policy the engine enforces and dialects advertise. */
    policy?: UploadPolicy;
    /** Lock provider. Default: in-process cooperative-preemption locker. */
    locker?: UploadLocker;
    /**
     * Structured, content-free audit events (creation, appends, rejections,
     * completion, cancellation). Guarded: a throwing hook is routed to
     * `onError` and never affects the upload.
     */
    onUploadEvent?: (event: UploadResourceEvent) => void;
    /**
     * The upload published, and this is the one hook carrying the storage key.
     *
     * Deliberately NOT the audit stream: that stream is content-free by design,
     * and a key commonly embeds a filename. This is where a consumer records
     * "this upload became that object", which is otherwise impossible to learn,
     * because the key is chosen before the token exists and pairing them by
     * position across the creation call is a race.
     *
     * Awaited before the dialect answers, so a throw becomes a backend error
     * rather than a client that believes an upload landed which the consumer's
     * own records never saw.
     *
     * **Delivered AT-LEAST-ONCE. Make it idempotent on `uploadToken`.** The
     * await is only worth something if a failed delivery gets another attempt.
     * A client recovers a lost completion answer in one of two ways: it repeats
     * its completing request, or it probes the offset (HEAD) and finds the
     * upload complete. Both re-deliver here rather than short-circuiting, and a
     * re-delivery that throws answers the same backend error the completing
     * request did, so the client retries instead of concluding the upload
     * landed. A re-delivery reports what durable state knows and may omit
     * `etag` and `digest`; the token does not change, which is why it is the
     * key.
     *
     * Re-delivery stops once a delivery for that token RESOLVES in this
     * process. Without that, holding the token is enough to drive an unbounded
     * number of awaited invocations by repeating one bodiless request. The
     * record is per-process and bounded (the most recent 1024 tokens), so in a
     * deployment of several processes behind one endpoint, each process that
     * answers a probe or a retry for a completed upload delivers once more, and
     * a restart or a very old token can produce one duplicate too:
     * at-least-once, as stated.
     *
     * A completing creation publishes before this runs, so a throw leaves a
     * published object the hook has not yet recorded. The failure response
     * carries the upload's location, and the client's probe or retry there
     * delivers again; an object whose client never returns stays published and
     * unrecorded, which is the case to reconcile from the store's listing.
     */
    onUploadComplete?: (info: {
        uploadToken: string;
        /** Audit-safe substitute, when the caller supplied one. */
        auditKey?: string;
        key: string;
        length: number;
        metadata?: Record<string, string>;
        /** Absent on a re-delivery: durable state does not carry it. */
        etag?: string;
        /** Absent on a re-delivery: durable state does not carry it. */
        digest?: string;
    }) => void | Promise<void>;
    /**
     * Must not throw (there is no sink for a failing error sink). Under an audit
     * key, `error` arrives as a `ProjectedError` instead of the raw error.
     */
    onError?: (error: unknown, context: { uploadToken?: string; auditKey?: string; operation: string }) => void;
    /**
     * Every error reaching `onError` arrives projected, and no context carries
     * the token, whether or not an audit key was derived for that call. Set it
     * whenever the caller supplies audit keys: a derivation that throws, or one
     * that answers `undefined`, must not be the case that hands the raw error,
     * which can quote the token or the key, to the sink. The dialects set it
     * from their `auditKey` option. @default false
     */
    redactErrors?: boolean;
    /**
     * Post-abort flush window in milliseconds: how long store writes may keep
     * running after the client vanished, so received bytes become durable and
     * the next probe answers truthfully. `0` disables the window.
     * @default 10000
     */
    graceMs?: number;
    /**
     * How long a request waits for the upload lock before answering 423.
     * The orchestrator is the only caller of {@link UploadLocker.acquire}, so
     * this is the knob for it whichever locker is installed; a locker may still
     * carry its own default for callers outside the orchestrator.
     */
    lockTimeoutMs?: number;
    /**
     * Clock injection (tests). A handler computes its expiry headers from the
     * same clock. @default Date.now
     */
    now?: () => number;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

/**
 * Reject verdicts pass through to the dialect, plus the resource the rejection
 * concerns when one exists and, on a limit violation, the offset a refused
 * body is resumable from. A creation whose body is refused mid-stream has
 * already allocated its resource and made a prefix durable: without the token
 * those bytes are unreachable, so the client can neither resume them nor
 * delete them and only a sweep (optional, and meaningless without a max age)
 * ever reclaims them.
 *
 * The resume point is an orchestrator addition rather than a verdict field:
 * the engine decides limits from the request and the pre-read state alone and
 * never learns where a partially accepted body actually stopped, so only a
 * store that refused the bytes can name that offset.
 */
type UploadRejectOutcome = { uploadToken?: string } & (
    | Extract<
          UploadVerdict,
          { kind: "offset-mismatch" } | { kind: "gone" } | { kind: "contended" } | { kind: "already-complete" }
      >
    | (Extract<UploadVerdict, { kind: "limit-violation" }> & {
          /**
           * Where the durable prefix ends, present only when a store reported
           * one. A body stopped at this request's byte ceiling leaves everything
           * before the ceiling durable and the store names that offset as it
           * refuses, so the client resumes there without a further probe. A limit
           * decided before any byte moved has no such number and omits the field:
           * read it as "resume here if it is here", never as a guarantee that a
           * rejected request published a resume point.
           */
          durableOffset?: number;
          /**
           * Absolute expiry (epoch ms) of the resource the rejection concerns,
           * present when one exists and a max age applies. A creation refused
           * before allocating has none, and its limits describe a resource not
           * yet made.
           */
          expiresAt?: number;
      })
    | (Extract<UploadVerdict, { kind: "length-inconsistent" }> & {
          /**
           * Where the durable prefix ends, present when the body ended cleanly
           * short of the length it stated as complete: the prefix stays
           * durable and resumable from here. A conflict decided before any
           * byte moved omits it.
           */
          durableOffset?: number;
      })
);

export type UploadOutcome =
    | {
          kind: "created";
          uploadToken: string;
          offset: number;
          length?: number;
          complete: boolean;
          /** Digest/etag of the published object when creation also completed. */
          digest?: string;
          etag?: string;
          /** The append was cut short (client vanished); offset is truthful. */
          interrupted: boolean;
          /**
           * Absolute expiry (epoch ms), when a max age applies. Anchored at the
           * moment creation STARTED, so a slow streaming create advertises a
           * stable deadline instead of one inflated by its own duration (unlike
           * now + maxAge computed after the stream drains).
           */
          expiresAt?: number;
      }
    | {
          kind: "appended";
          offset: number;
          length?: number;
          complete: boolean;
          digest?: string;
          etag?: string;
          interrupted: boolean;
          /** Absolute expiry (epoch ms), when a max age applies. */
          expiresAt?: number;
      }
    | {
          kind: "probed";
          offset: number;
          length?: number;
          complete: boolean;
          /**
           * Caller metadata recorded at creation, when the store kept any. A
           * dialect whose probe response must echo what the creation carried
           * (tus `Upload-Metadata` on HEAD) reads it here instead of reaching
           * past the orchestrator into the store.
           */
          metadata?: Record<string, string>;
          /**
           * Absolute expiry (epoch ms), when a max age applies. Anchored on the
           * resource's creation time, so a dialect emits a stable deadline that a
           * long append cannot inflate, and counts a remaining lifetime down from
           * the instant it answers rather than the instant the lock was taken.
           */
          expiresAt?: number;
      }
    | { kind: "cancelled" }
    | {
          kind: "digest-mismatch";
          /**
           * The resource the mismatch concerns, when one is in hand.
           *
           * Completion is atomic, so a failed verification published nothing and
           * the orchestrator discards the resource itself. The token rides along
           * because that discard is a store call like any other and can fail: a
           * dialect that emits a `Location` from it leaves the client able to
           * delete what the server could not.
           */
          uploadToken?: string;
      }
    | { kind: "not-found" }
    /**
     * Completion refused to publish over, or to claim, an object at the key
     * this upload did not put there ({@link UploadDestinationConflictError}).
     * Nothing was published and the upload stays sealed; repeating the
     * request cannot succeed, so the dialects answer 409 and the error is
     * reported through `onError` for the operator to reconcile.
     */
    | { kind: "destination-conflict"; uploadToken: string }
    /**
     * `digestPolicy: "require-verifiable"` refused a digest assertion the store
     * cannot verify, before anything was allocated or written.
     */
    | { kind: "digest-unverifiable" }
    /**
     * The caller's own answer: a creation key resolver or a per-upload
     * authorize hook returned a Response, which the dialect sends as-is.
     */
    | { kind: "refused"; response: Response }
    | {
          kind: "store-error";
          error: unknown;
          /**
           * The resource the failed operation concerns, when one exists. A
           * creation that published its object and then failed in the completion
           * hook, or that failed mid-body after a durable prefix landed, has a
           * resource the client can only reach through this token: the dialect
           * renders it as `Location` so the client's repeat of its completing
           * request reaches the idempotent re-delivery, which is the at-least-once
           * mechanism `onUploadComplete` documents.
           */
          uploadToken?: string;
      }
    | UploadRejectOutcome;

// ─── Request shapes (dialect-parsed) ────────────────────────────────────────

/** What an {@link UploadAuditKey} callback is asked about. */
export interface UploadAuditKeyContext {
    /** The request being answered. */
    request: Request;
    /**
     * The upload the request concerns. Absent on a creation refused before a
     * resource exists; a creation that allocated one is asked again with the
     * token the store minted, before any report names the resource.
     */
    uploadToken?: string;
}

/**
 * Audit-safe identifier reported on upload events and error contexts in place
 * of the upload token, which is the capability. One shape for both dialects:
 * an object parameter, so the context can grow without breaking a callback.
 * Return `undefined` to report without one.
 */
export type UploadAuditKey = (ctx: UploadAuditKeyContext) => string | undefined;

/** A storage key with the metadata to record on the resource in place of the client's. */
export interface UploadKeyResolution {
    key: string;
    /**
     * Recorded on the resource and handed to `onUploadComplete` INSTEAD of the
     * metadata the client sent, so the server decides what is kept. Omit it
     * to keep the client's.
     */
    metadata?: Record<string, string>;
}

/**
 * What a creation key resolver answers: the storage key, the key with the
 * metadata to record, or a Response that refuses the creation as-is (an
 * exhausted quota, a failed authorization). Nothing is allocated before it
 * answers.
 */
export type UploadKeyResult = string | UploadKeyResolution | Response;

/** The stored facts a per-upload authorize hook decides on. */
export interface UploadAuthorizeTarget {
    /** The storage key the upload publishes to. */
    key: string;
    /** The metadata recorded at creation. */
    metadata?: Record<string, string>;
}

/** The operation a resource request performs. */
export type UploadOperation = "probe" | "append" | "cancel";

/** What a dialect's per-upload `authorize` hook is asked about. */
export interface UploadAuthorizeContext extends UploadAuthorizeTarget {
    request: Request;
    uploadToken: string;
    operation: UploadOperation;
}

/**
 * Decide whether a resource request may act on its upload. Called under the
 * resource lock with the stored key and metadata, before anything is read
 * back to the client or written. Return a Response to refuse with it, or
 * `undefined` to proceed. A throw is a server error, never a pass.
 */
export type UploadAuthorize = (ctx: UploadAuthorizeContext) => Response | undefined | Promise<Response | undefined>;

/** The orchestrator's view of an authorize hook, bound to its request. */
export type UploadAuthorizer = (upload: UploadAuthorizeTarget) => Response | undefined | Promise<Response | undefined>;

/** Options a resource request carries. */
export interface UploadResourceOptions {
    auditKey?: string;
    signal?: AbortSignal;
    authorize?: UploadAuthorizer;
    /**
     * The policy this request is judged under, in place of the orchestrator's
     * own. Folded and validated exactly like the configured one (a store's
     * `maxAppendSize` still caps it); an invalid policy is a TypeError.
     */
    policy?: UploadPolicy;
}

/**
 * A policy a dialect resolves per request (a tenant's quota, a plan's ceiling)
 * instead of one fixed at construction. Each request is judged under the
 * policy it resolves, except for the lifetime: the creating request's max age
 * fixes the deadline the store records.
 */
export type UploadPolicyResolver = (
    request: Request,
) => (UploadPolicy & { maxSize: number }) | Promise<UploadPolicy & { maxSize: number }>;

export interface CreateUploadRequest {
    /**
     * Resolves the storage key. Called only after the policy accepts the
     * creation and before anything is allocated, so a refused creation never
     * spends the caller's allocation.
     */
    key: () => UploadKeyResult | Promise<UploadKeyResult>;
    declaredLength?: number;
    contentLength?: number;
    /**
     * Whether the creation's content finishes the representation. `true` is a
     * client's assertion: a body that ends cleanly short of `declaredLength`
     * contradicts it and is refused as a length inconsistency. `"infer"` is the
     * tus model: the upload completes exactly when the body delivers the
     * declared length, and a shorter body leaves it incomplete.
     */
    complete: boolean | "infer";
    body?: ReadableStream<Uint8Array> | Uint8Array;
    /**
     * Admits the body before anything is allocated, returning the body to
     * store or a Response that refuses the creation. Called only after the
     * policy accepts the creation and `key` resolves, so work that reads the
     * body (buffering it to verify a checksum) is never spent on a creation
     * the caller's own admission would refuse.
     */
    admitBody?: (
        body: ReadableStream<Uint8Array> | Uint8Array,
    ) => Promise<ReadableStream<Uint8Array> | Uint8Array | Response>;
    metadata?: Record<string, string>;
    /** Client-asserted digests of the whole representation (RFC 9530). */
    expectedDigests?: UploadDigests;
    /**
     * Audit-safe substitute for the token on every reporting surface. A
     * function is called with `undefined` for a creation refused before a
     * resource exists, and with the minted token before the first report that
     * names the resource, so a creation is reported under an identifier derived
     * from its own token. A throw after the resource exists discards it and
     * rejects the call.
     */
    auditKey?: string | ((uploadToken: string | undefined) => string | undefined);
    /**
     * Called once the resource exists (token minted, audit key resolved) and
     * before the body is read, under the resource lock, so a client handed the
     * location here and resuming at once waits for this creation's write
     * instead of racing it. Guarded: a throw is reported to `onError` as
     * `allocated-hook` and the creation proceeds.
     */
    onAllocated?: (uploadToken: string) => void;
    signal?: AbortSignal;
    /**
     * The policy this request is judged under, in place of the orchestrator's
     * own. Folded and validated exactly like the configured one (a store's
     * `maxAppendSize` still caps it); an invalid policy is a TypeError.
     */
    policy?: UploadPolicy;
}

export interface AppendUploadRequest {
    offset: number;
    contentLength?: number;
    /**
     * Whether this append finishes the representation. `"infer"` is the tus
     * model (completion is implicit at offset == length, nothing on the wire):
     * the orchestrator derives it from the FRESH durable state it reads under
     * the append's own lock (a known length is reached by `offset +
     * contentLength`, or an unknown-sized body delivers through it), so a
     * dialect never needs a pre-append probe whose answer can go stale before
     * the lock is held.
     *
     * An inferred completion is marked as such on the intent, and policy
     * exemptions written for a client's assertion (`minAppendSize`) do not
     * extend to it. On a known-length upload the inference holds for every body
     * whose size the request did not declare, so a floor that honored it would
     * bind only on requests that declare a size.
     */
    complete: boolean | "infer";
    declaredLength?: number;
    body?: ReadableStream<Uint8Array> | Uint8Array;
    /** Client-asserted digests of the whole representation (RFC 9530). */
    expectedDigests?: UploadDigests;
    auditKey?: string;
    signal?: AbortSignal;
    authorize?: UploadAuthorizer;
    /**
     * The policy this request is judged under, in place of the orchestrator's
     * own. Folded and validated exactly like the configured one (a store's
     * `maxAppendSize` still caps it); an invalid policy is a TypeError.
     */
    policy?: UploadPolicy;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface UploadOrchestrator {
    create(req: CreateUploadRequest): Promise<UploadOutcome>;
    /**
     * Probe the resource under its lock. Because the lock is cooperatively
     * preempted, a probe ASKS AN IN-FLIGHT APPEND TO YIELD: the running write
     * aborts at its next chunk boundary, flushes what it has, and answers with a
     * truthful shorter offset. No bytes are lost and the client resumes, but a
     * HEAD is therefore not free, and a monitoring loop polling HEAD against an
     * active upload will keep chopping it into small appends.
     *
     * The lock is what makes the answer coherent: deriving an offset can be a
     * multi-call backend read, and a torn snapshot would hand the client an
     * offset its next request fails on. Use {@link resourceExists} when all you
     * need is whether the token resolves.
     */
    probe(uploadToken: string, opts?: UploadResourceOptions): Promise<UploadOutcome>;
    /**
     * Does this token still name a resource? Lock-free and therefore
     * non-preempting: it cannot interrupt an append the way {@link probe} does,
     * and in exchange it answers nothing about the offset, which is the part
     * that needs the lock to be coherent.
     *
     * For gating expensive per-request work on a token that may not exist at
     * all. `true` on any store error other than a definitive not-found, so a
     * transient backend failure delays work rather than fabricating a 404.
     */
    resourceExists(uploadToken: string, opts?: { auditKey?: string; signal?: AbortSignal }): Promise<boolean>;
    /**
     * The refusals an append would meet before it reads a byte that depend only
     * on the token and the resource's immutable key and metadata: the token
     * names nothing (`not-found`), or the authorize hook refuses it
     * (`refused`). Undefined when neither holds, including on a store error
     * other than a definitive not-found.
     *
     * Lock-free and non-preempting, like {@link resourceExists}, so it answers
     * nothing that depends on the offset: that part is only coherent under the
     * lock, and {@link append} stays the authority for it. The authorize hook
     * may therefore run twice for one request (here and inside the append), on
     * the same key and metadata. For gating buffering work that an append
     * would refuse anyway.
     */
    admit(
        uploadToken: string,
        opts?: { auditKey?: string; signal?: AbortSignal; authorize?: UploadAuthorizer },
    ): Promise<UploadOutcome | undefined>;
    append(uploadToken: string, req: AppendUploadRequest): Promise<UploadOutcome>;
    cancel(uploadToken: string, opts?: UploadResourceOptions): Promise<UploadOutcome>;
    /** Effective policy (dialects advertise it as limits). */
    readonly policy: UploadPolicy;
    /**
     * The effective form of a per-request policy: what a request carrying it
     * is judged under, and so what a dialect advertises for that request.
     * Throws a TypeError for a policy the engine refuses.
     */
    effectivePolicy(policy: UploadPolicy): UploadPolicy;
    /** The algorithms the store verifies at completion; empty when it verifies none. */
    readonly verifiedDigests: readonly UploadDigestAlgorithm[];
}

export function createUploadOrchestrator(
    store: ResumableWriteStore,
    opts: UploadOrchestratorOptions = {},
): UploadOrchestrator {
    // atomicCompletion: the orchestrator publishes on a single `completeUpload`
    // and has no rollback of its own, so a non-atomic store could leave a torn
    // object visible to readers. Refuse it at construction rather than corrupt
    // later.
    //
    // enforcesOffsetCheck: the lock serializes writers; it cannot prove the
    // writer still holds it. An expiry-based distributed lock is stealable from
    // a holder that stalls past its TTL and resumes, so the store's at-write
    // offset check is what turns that holder's late write into a loud conflict
    // instead of silent interleaving. A store that cannot make that check has
    // no defense left to fall back on, so it is refused here rather than
    // trusted to be deployed single-process forever.
    for (const flag of ["atomicCompletion", "enforcesOffsetCheck"] as const) {
        if (!store[flag]) throw new TypeError(`createUploadOrchestrator: store must report ${flag}: true`);
    }
    if ((store.contractVersion ?? UPLOAD_STORE_CONTRACT_VERSION) !== UPLOAD_STORE_CONTRACT_VERSION) {
        throw new TypeError(`createUploadOrchestrator: unsupported store contract version ${store.contractVersion}`);
    }
    function effectivePolicy(raw: UploadPolicy | undefined): UploadPolicy {
        const policy: UploadPolicy = { ...raw };
        if (policy.maxSize === Infinity) delete policy.maxSize;
        if (store.maxAppendSize !== undefined) {
            policy.maxAppendSize =
                policy.maxAppendSize === undefined
                    ? store.maxAppendSize
                    : Math.min(policy.maxAppendSize, store.maxAppendSize);
        }
        // Policy is the one input class the engine trusts without a per-request
        // gate; a NaN/negative/fractional bound would silently disable enforcement
        // (`x > NaN` is false) or flow a NaN maxBytes to an adapter. Fail loudly,
        // matching the package's caller-bugs-fail-loudly posture.
        validatePolicy(policy);
        return policy;
    }
    const basePolicy = effectivePolicy(opts.policy);
    const policyOf = (raw: UploadPolicy | undefined): UploadPolicy => (raw ? effectivePolicy(raw) : basePolicy);
    const locker = opts.locker ?? memoryUploadLocker();
    const now = opts.now ?? Date.now;
    const graceMs = opts.graceMs ?? 10_000;
    const lockTimeoutMs = opts.lockTimeoutMs;
    // Both feed a timer, so an oversized or NaN window silently becomes no
    // window; a locker refuses a non-positive acquire timeout.
    intOption("createUploadOrchestrator: graceMs", graceMs, 0, MAX_TIMER_MS);
    intOption("createUploadOrchestrator: lockTimeoutMs", lockTimeoutMs, 1, MAX_TIMER_MS);
    const onUploadComplete = opts.onUploadComplete;
    const rawOnError = opts.onError;
    /**
     * The audit key SUBSTITUTES for the token on every reporting surface. An
     * error sink is at least as log-adjacent as the event sink: a consumer that
     * supplied a safe identifier gains nothing from receiving the capability
     * next to a stack trace.
     */
    const onError = rawOnError
        ? (err: unknown, ctx: { uploadToken?: string; auditKey?: string; operation: string }): void => {
              if (ctx.auditKey === undefined && !opts.redactErrors) {
                  rawOnError(err, ctx);
                  return;
              }
              // The error travels to the same sink as the context, and the token
              // and the key can sit anywhere in it (a message, an errno `path`, a
              // backend client's request descriptor) in any spelling. The sink
              // receives an allow-listed projection, so no search can miss one.
              rawOnError(projectError(err, ctx.operation), {
                  ...ctx,
                  uploadToken: undefined,
              });
          }
        : undefined;
    /** Run a caller hook so that a throw reaches `onError` and nothing else. */
    function guarded(
        hook: () => void,
        uploadToken: string | undefined,
        auditKey: string | undefined,
        operation: string,
    ): void {
        try {
            hook();
        } catch (err) {
            onError?.(err, { uploadToken, auditKey, operation });
        }
    }
    const emit = opts.onUploadEvent
        ? (uploadToken: string | undefined, auditKey: string | undefined, events: UploadAuditEvent[]): void => {
              // The audit key SUBSTITUTES for the token, it does not accompany it:
              // the token is the capability, and a caller that went to the trouble
              // of supplying a safe identifier for its log records gains nothing
              // from receiving the credential in the same object.
              const reportedToken = auditKey === undefined ? uploadToken : undefined;
              for (const event of events) {
                  guarded(
                      () => opts.onUploadEvent!({ uploadToken: reportedToken, auditKey, event }),
                      uploadToken,
                      auditKey,
                      "audit",
                  );
              }
          }
        : () => {};

    /**
     * Run `fn` with the storage signal decoupled from the request signal: on
     * client abort the storage gets `graceMs` more to finish before it is
     * cancelled. Every storage call made on a request's behalf takes this one
     * signal (the state read, the write, the completion), so a client that left
     * while waiting for the lock, or just after its last byte, still has its
     * received bytes recorded and its completion published.
     */
    async function withGrace<T>(
        signal: AbortSignal | undefined,
        fn: (graced: AbortSignal | undefined) => Promise<T>,
    ): Promise<T> {
        if (!signal || graceMs <= 0) return fn(signal);
        const ctl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const startTimer = (): void => {
            timer = setTimeout(() => ctl.abort(signal.reason), graceMs);
        };
        // An ALREADY-aborted request still opens the window: the abort may have
        // landed between request arrival and the store call, and the received
        // bytes deserve their flush either way.
        if (signal.aborted) startTimer();
        else signal.addEventListener("abort", startTimer, { once: true });
        try {
            return await fn(ctl.signal);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", startTimer);
        }
    }

    /**
     * Release a request body this orchestrator will never hand to a store.
     *
     * A refused request still owns its body: an abandoned stream leaves its
     * producer running and the connection reading until the runtime happens to
     * notice, so cancelling is what tells the peer to stop sending. Once a body
     * has reached the store, the `releaseBody` handle `streamAppend` passes it
     * covers every exit instead, and this is not called.
     */
    async function discardBody(body: UploadBody | undefined): Promise<void> {
        if (body === undefined) return;
        await cancelUploadBody(body);
    }

    /**
     * Run `fn` as the owner of a request body, releasing it on every exit that
     * did not hand it to the store.
     *
     * Ownership is one rule, not a list of refusal paths each entry point has to
     * enumerate: a rejected verdict, a store that would not allocate, lock
     * contention that never runs the callback at all, and a locker that throws
     * something other than a timeout all leave a body this layer still holds.
     * `storeTakesBody` is called at the single point the body is passed to the
     * store, after which the store owns it and this releases nothing.
     */
    async function withBodyOwnership(
        body: UploadBody | undefined,
        fn: (storeTakesBody: () => void) => Promise<UploadOutcome>,
    ): Promise<UploadOutcome> {
        let storeOwnsBody = false;
        try {
            return await fn(() => {
                storeOwnsBody = true;
            });
        } finally {
            if (!storeOwnsBody) await discardBody(body);
        }
    }

    /** The final durable size is below the policy floor: refuse to publish. */
    function belowMinSize(policy: UploadPolicy, finalSize: number): boolean {
        return policy.minSize !== undefined && finalSize < policy.minSize;
    }

    /**
     * Stamp a limit rejection about an existing resource with its deadline: a
     * dialect that restates the limits on the rejection would otherwise state
     * the configured lifetime, moving the deadline a client already holds.
     */
    function withDeadline(outcome: UploadOutcome, expiresAt: number | undefined): UploadOutcome {
        if (outcome.kind === "limit-violation" && expiresAt !== undefined) outcome.expiresAt = expiresAt;
        return outcome;
    }

    /**
     * Tokens whose completion hook has already been delivered and resolved.
     *
     * Bounded and lossy by construction: forgetting an entry costs one duplicate
     * delivery, which the hook's own at-least-once contract already requires a
     * consumer to absorb, while remembering every token would grow without limit
     * under a client that keeps retrying. Insertion-ordered, so the oldest entry
     * is the one evicted.
     */
    const deliveredCompletions = new Set<string>();
    const DELIVERED_COMPLETIONS_REMEMBERED = 1024;

    /**
     * Report a publication before the answer goes out.
     *
     * Awaited deliberately: a consumer that records the object in its own
     * database needs that write to happen before the client is told the upload
     * succeeded, or a crash between the two leaves an object nothing points at.
     *
     * AT-LEAST-ONCE, not once. The await above is only worth something if a
     * failed delivery is retried, and a resumable protocol's retries are the
     * client repeating its completing request or probing the offset; both are
     * answered idempotently, so both re-deliver rather than short-circuit. A consumer
     * therefore has to be idempotent on `uploadToken`, which is the key it
     * already holds. A re-delivery carries what durable state knows and may omit
     * `etag` and `digest`.
     *
     * A delivery that RESOLVED is remembered and not repeated. The retry exists
     * for a delivery that failed; repeating a successful one on every later
     * request instead lets a token holder drive unbounded awaited work in a
     * consumer's hook by resending one bodiless request. A throw records nothing,
     * so the next retry delivers again, which is the case the contract is for.
     */
    async function reportComplete(
        uploadToken: string,
        auditKey: string | undefined,
        key: string,
        length: number,
        metadata: Record<string, string> | undefined,
        etag?: string,
        digest?: string,
    ): Promise<void> {
        if (onUploadComplete === undefined) return;
        if (deliveredCompletions.has(uploadToken)) return;
        await onUploadComplete({ uploadToken, auditKey, key, length, metadata, etag, digest });
        deliveredCompletions.add(uploadToken);
        if (deliveredCompletions.size > DELIVERED_COMPLETIONS_REMEMBERED) {
            const oldest = deliveredCompletions.values().next();
            if (!oldest.done) deliveredCompletions.delete(oldest.value);
        }
    }

    /**
     * Discard a resource the orchestrator has just declared terminal.
     *
     * A dead upload is storage no path reclaims: every later request refuses it,
     * and the sweep's idleness clock cannot reach a resource that is still being
     * appended to, so an expired-but-active upload survives both. Discarding it
     * with the verdict is what makes the refusal free the bytes it refuses over.
     *
     * Best effort: the answer to the client is already decided and correct, so a
     * backend that will not discard must not turn a truthful refusal into a 500.
     * The failure goes to `onError`, which is where an operator learns there is
     * storage left to reclaim by hand. Deliberately unsignalled, like the
     * post-interruption state read: the request may be exactly what vanished.
     */
    async function discardResource(
        uploadToken: string,
        auditKey: string | undefined,
        operation: string,
    ): Promise<void> {
        try {
            await store.abortUpload(uploadToken);
        } catch (err) {
            onError?.(err, { uploadToken, auditKey, operation });
        }
    }

    async function mapStoreError(
        err: unknown,
        uploadToken: string | undefined,
        operation: string,
        auditKey?: string,
        atOffset?: number,
    ): Promise<UploadOutcome> {
        // A conflict can surface from any store call that adopts a publication,
        // a state read that recovers one included, not only from completion.
        if (isUploadDestinationConflictError(err)) {
            onError?.(err, { uploadToken, auditKey, operation });
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "destination-conflict", atOffset }]);
            return { kind: "destination-conflict", uploadToken: err.uploadToken };
        }
        if (isUploadNotFoundError(err)) {
            // Damaged bookkeeping is still gone to the client, but it is storage
            // corruption to the operator, not an expired token: reported.
            if (isCorruptUploadState(err)) onError?.(err, { uploadToken, auditKey, operation });
            return { kind: "not-found" };
        }
        if (isUploadDigestUnverifiableError(err)) {
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "digest-unverifiable" }]);
            return { kind: "digest-unverifiable" };
        }
        if (isUploadDigestMismatchError(err)) {
            // Completion is atomic, so the verification failed before anything was
            // published and the staged representation is unreachable scrap: the
            // client cannot append past a length it already filled and has no reason
            // to send a DELETE it was never told to send. Discarding it here is the
            // only path that frees those bytes.
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "digest-mismatch" }]);
            if (uploadToken !== undefined) await discardResource(uploadToken, auditKey, "abort");
            return { kind: "digest-mismatch", uploadToken };
        }
        onError?.(err, { uploadToken, auditKey, operation });
        // The audit key promises the capability reaches no reporting surface, and
        // the error in this outcome travels to the same places the error report
        // does. The token itself travels only to the dialect, which hands it to
        // the client that owns the resource.
        return {
            kind: "store-error",
            error: auditKey === undefined && !opts.redactErrors ? err : projectError(err, operation),
            uploadToken,
        };
    }

    /**
     * Narrow an engine verdict to the reject outcomes dialects render. The
     * action verdicts are all handled before this runs, and the engine never
     * produces `contended` itself: the LOCKER owns contention end to end, so
     * `contended` only ever enters as the orchestrator's own answer to a lock
     * acquire timeout.
     */
    function rejectOutcome(verdict: UploadVerdict): UploadOutcome {
        switch (verdict.kind) {
            case "offset-mismatch":
            case "limit-violation":
            case "length-inconsistent":
            case "gone":
            case "contended":
            case "already-complete":
                return verdict;
            default:
                throw new Error(`upload orchestrator: unexpected verdict ${verdict.kind}`);
        }
    }

    /**
     * The answer to a body that ran past a representation bound. Which bound
     * decides it: past the client's own declared length is that inconsistency
     * arriving mid-stream instead of in the headers, past the server's ceiling
     * is a size violation. Shared by the overrun (resource invalidated) and
     * zero-bound (resource healthy, the bound simply admits no byte) cases,
     * and by a completion that ended cleanly short of its stated length, which
     * invalidated nothing and passes the `durableOffset` the client resumes
     * from.
     */
    function representationBoundOutcome(
        uploadToken: string,
        auditKey: string | undefined,
        fatalReason: FatalBoundReason | undefined,
        atOffset: number,
        durableOffset?: number,
    ): UploadOutcome {
        const reason = fatalReason === "size" ? "size-exceeded" : "length-inconsistent";
        emit(uploadToken, auditKey, [{ kind: "append-rejected", reason, atOffset }]);
        return reason === "size-exceeded"
            ? { kind: "limit-violation", reason, uploadToken, events: [] }
            : { kind: "length-inconsistent", uploadToken, durableOffset, events: [] };
    }

    /** The refusal an authorize hook answers for `state`, if any. */
    async function refusal(
        authorize: UploadAuthorizer | undefined,
        state: StoredUploadState,
    ): Promise<UploadOutcome | undefined> {
        const response = await authorize?.({ key: state.key, metadata: state.metadata });
        return response && { kind: "refused", response };
    }

    /**
     * Whether a request that ASSERTED completion delivered, cleanly, less than
     * the total fixed in advance. The assertion and the bytes then disagree
     * about the representation's length, the inconsistency the IETF draft
     * names, and a 2xx incomplete answer would contradict the request's own
     * completeness field. An inferred completion asserted nothing, and an
     * interrupted body is answered as interrupted. A declared content size the
     * engine already reconciled with the total before the write, so falling
     * short of it is the store's short flush, not the client's inconsistency.
     * The delivered prefix stays durable and resumable.
     */
    function statedShort(
        req: { complete: boolean | "infer"; contentLength?: number },
        interrupted: boolean,
        total: number | undefined,
        delivered: number,
    ): boolean {
        return (
            req.complete === true &&
            req.contentLength === undefined &&
            !interrupted &&
            total !== undefined &&
            delivered !== total
        );
    }

    /**
     * Map what a store write raised to the answer the client gets, shared by
     * the creation body and every append.
     *
     * `stranded` is the token a rejection carries so a dialect can hand the
     * client a location for bytes a creation already made durable.
     */
    async function appendFailure(
        err: unknown,
        uploadToken: string,
        auditKey: string | undefined,
        verdict: { maxBytesFatal: boolean; fatalReason?: FatalBoundReason },
        atOffset: number,
        key: string,
        stranded: string | undefined,
    ): Promise<UploadOutcome> {
        // This request's ceiling, not the representation's: the resource is
        // healthy and whatever landed is durable, so the client learns its chunk
        // was too large (413) and resumes rather than losing the upload. The
        // store knows where the durable prefix ends, so the rejection carries it
        // instead of costing the client a probe to rediscover it.
        if (isUploadAppendBoundError(err)) {
            // A zero representation bound is non-fatal too, but a body that
            // carried bytes into it broke the representation's shape, not this
            // request's ceiling: the answer names that bound so the client does not
            // retry with a smaller chunk that can never fit.
            if (!verdict.maxBytesFatal && verdict.fatalReason !== undefined) {
                return representationBoundOutcome(uploadToken, auditKey, verdict.fatalReason, atOffset);
            }
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "append-too-large", atOffset }]);
            return {
                kind: "limit-violation",
                reason: "append-too-large",
                uploadToken: stranded,
                durableOffset: err.durableOffset,
                events: [],
            };
        }
        // The body ran past a representation bound and the store has invalidated
        // the resource.
        if (isUploadOverrunError(err)) {
            return representationBoundOutcome(uploadToken, auditKey, verdict.fatalReason, atOffset);
        }
        if (isUploadOffsetConflictError(err)) {
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "offset-mismatch", atOffset }]);
            return { kind: "offset-mismatch", claimedOffset: atOffset, correctOffset: err.durableOffset, events: [] };
        }
        return await mapStoreError(err, uploadToken, "append", auditKey);
    }

    /**
     * A signal that aborts as soon as ANY input aborts, propagating the first
     * input's reason. Latched: an already-aborted input aborts the result at
     * once (this is what carries a preempt that landed before the write began).
     * Composed ONCE per append, never per chunk, to keep it leak-free. Cleanup
     * of its listeners is registered into `cleanups`.
     */
    function linkAbort(signals: Array<AbortSignal | undefined>, cleanups: Array<() => void>): AbortSignal {
        const ctl = new AbortController();
        for (const s of signals) {
            if (!s) continue;
            if (s.aborted) {
                ctl.abort(s.reason);
                return ctl.signal;
            }
            const onAbort = () => ctl.abort(s.reason);
            s.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => s.removeEventListener("abort", onAbort));
        }
        return ctl.signal;
    }

    /**
     * Seal and publish under the lock, or `undefined` when the lock's lease
     * is already lost: a holder that cannot prove it still owns the resource
     * starts no completion, and one that loses it mid-completion is stopped
     * through the linked signal at the store's next backend call. The store's
     * seal is the fence; this only keeps a lapsed holder from reaching it.
     */
    async function publish(
        uploadToken: string,
        lock: UploadLock,
        signal: AbortSignal | undefined,
        opts: { expectedDigests: UploadDigests | undefined; expectedLength: number; epoch: number | undefined },
    ): Promise<CompletedUpload | undefined> {
        if (lock.lease.aborted) return undefined;
        const cleanups: Array<() => void> = [];
        try {
            return await store.completeUpload(uploadToken, {
                ...opts,
                now: now(),
                signal: linkAbort([signal, lock.lease], cleanups),
            });
        } finally {
            for (const fn of cleanups) fn();
        }
    }

    /** The answer to a completion whose holder lost its lease before publishing: retryable contention. */
    function lostLease(uploadToken: string, auditKey: string | undefined): UploadOutcome {
        emit(uploadToken, auditKey, [{ kind: "lock-contended" }]);
        return { kind: "contended", events: [] };
    }

    /**
     * Map what a completion raised. A sealed plan of another length than the
     * caller acknowledged is an offset conflict, answered as one so the
     * client resumes from the length the store holds. A destination that
     * changed under the seal is someone's data the store refused to touch: a
     * conflict no retry resolves, reported for the operator.
     */
    async function completeFailure(
        err: unknown,
        uploadToken: string,
        auditKey: string | undefined,
        atOffset: number,
    ): Promise<UploadOutcome> {
        if (isUploadOffsetConflictError(err)) {
            emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "offset-mismatch", atOffset }]);
            return { kind: "offset-mismatch", claimedOffset: atOffset, correctOffset: err.durableOffset, events: [] };
        }
        return await mapStoreError(err, uploadToken, "complete", auditKey, atOffset);
    }

    /** The store's fencing epoch for a write about to happen, when it mints claims ({@link UploadClaim}). */
    async function claim(uploadToken: string, signal: AbortSignal | undefined): Promise<number | undefined> {
        return store.claimUpload && (await store.claimUpload(uploadToken, { signal })).epoch;
    }

    /** Run `fn` holding the resource lock, translating lock timeouts to contention. */
    async function withLock(
        uploadToken: string,
        auditKey: string | undefined,
        fn: (lock: UploadLock) => Promise<UploadOutcome>,
    ): Promise<UploadOutcome> {
        let lock: UploadLock;
        try {
            // The audit key rides the acquire so the locker names the resource the
            // same safe way every other sink here does. A locker cannot invent it,
            // and its own error context is otherwise the one seam where the token
            // reaches a log sink raw.
            // An absent value is no key at all, never a key spelled undefined.
            lock = await locker.acquire(uploadToken, {
                ...(lockTimeoutMs !== undefined && { timeoutMs: lockTimeoutMs }),
                ...(auditKey !== undefined && { auditKey }),
            });
        } catch (err) {
            if (!isUploadLockTimeoutError(err)) throw err;
            emit(uploadToken, auditKey, [{ kind: "lock-contended" }]);
            return { kind: "contended", events: [] };
        }
        try {
            return await fn(lock);
        } finally {
            lock.release();
        }
    }

    async function streamAppend(
        uploadToken: string,
        atOffset: number,
        body: ReadableStream<Uint8Array> | Uint8Array,
        maxBytes: number | undefined,
        maxBytesFatal: boolean,
        declaredLength: number | undefined,
        graced: AbortSignal | undefined,
        lockSignal: AbortSignal,
        fence: Pick<AppendChunkOptions, "epoch" | "snapshot">,
    ): Promise<AppendChunkResult> {
        const cleanups: Array<() => void> = [];
        // Two independent yield triggers, composed into the one signal the store
        // sees: `lockSignal` aborts the write AT ONCE (a later acquirer is waiting,
        // so yield now); `graced`, the caller's grace-window signal, aborts it only
        // after a client disconnect has had its window (so already-received bytes
        // still flush and the offset stays truthful).
        const writeSignal = linkAbort([lockSignal, graced], cleanups);
        const held = yieldableBody(body, writeSignal, cleanups);
        try {
            // Interruption is the STORE's answer, not an inference here: it is the
            // only party that reads the body, so it is the only one that can say
            // whether the read reached the end. Everything else the store raises is
            // a fault the caller maps, and nothing is classified by the signal:
            // preemption is routine (every probe takes the lock), so "a yield was
            // requested" is true of a refused stale write and an overrun alike.
            return await store.appendChunk(uploadToken, atOffset, held.body, {
                maxBytes,
                maxBytesFatal,
                // A length first declared on this append: the store persists it so the
                // next getUploadState reports it and it becomes immutable (the
                // deferred-length flow). Undefined once the length is already known.
                length: declaredLength,
                now: now(),
                signal: writeSignal,
                ...fence,
                releaseBody: held.release,
            });
        } catch (err) {
            // A store that surfaced the yield as a throw rather than reporting it:
            // identified by the thrown VALUE (the signal's own reason, or a standard
            // abort error), never by the signal's state. Nothing is durable past
            // what a fresh state read reports, which the caller takes next.
            if (err === writeSignal.reason || (err instanceof Error && err.name === "AbortError")) {
                return { bytesWritten: 0, interrupted: true };
            }
            throw err;
        } finally {
            // Whatever the store did with the body, nothing reads it after this:
            // a store that threw or stopped early without cancelling must not
            // leave the peer sending. A no-op on a body read to its end.
            await held.release();
            for (const fn of cleanups) fn();
        }
    }

    const verifiedDigests = store.digestOnComplete || [];
    // RFC 9530: a client's Repr-Digest is advisory. An assertion in an algorithm
    // the store cannot verify is DROPPED rather than refused (refusing would fail
    // every integrity-conscious client on a non-verifying backend, telling it its
    // bytes are corrupt when nothing was compared). Verified algorithms are
    // enforced at completion. Under `digestPolicy: "require-verifiable"` an
    // assertion with nothing verifiable in it throws instead of being dropped.
    const verifiable = (asserted: UploadDigests | undefined, policy: UploadPolicy): UploadDigests | undefined => {
        let kept: { -readonly [A in UploadDigestAlgorithm]?: string } | undefined;
        for (const algorithm of verifiedDigests) {
            const value = asserted?.[algorithm];
            if (value !== undefined) (kept ??= {})[algorithm] = value;
        }
        if (!kept && asserted && policy.digestPolicy === "require-verifiable")
            throw new UploadDigestUnverifiableError();
        return kept;
    };

    return {
        policy: basePolicy,
        verifiedDigests,
        effectivePolicy,

        async create(req): Promise<UploadOutcome> {
            // Capture the creation instant ONCE, before any (possibly slow, streaming)
            // work: the resource's createdAt and its advertised expiry must anchor
            // here, not after the body drains, or a long create inflates the deadline.
            const createdAt = now();
            const policy = policyOf(req.policy);
            const expiresAt = uploadExpiry({ createdAt }, policy);
            return await withBodyOwnership(req.body, async (storeTakesBody) => {
                const intent: CreateIntent = {
                    kind: "create",
                    declaredLength: req.declaredLength,
                    contentLength: req.contentLength,
                    complete: req.complete !== false,
                };
                const verdict = evaluateUploadCreation(intent, policy);
                const auditOf =
                    typeof req.auditKey === "function" ? req.auditKey : () => req.auditKey as string | undefined;
                let auditKey = auditOf(undefined);
                if (verdict.kind !== "create-accepted") {
                    emit(undefined, auditKey, verdict.events);
                    return rejectOutcome(verdict);
                }
                let expectedDigests: UploadDigests | undefined;
                try {
                    expectedDigests = verifiable(req.expectedDigests, policy);
                } catch (err) {
                    return await mapStoreError(err, undefined, "create", auditKey);
                }
                const resolved = await req.key();
                if (resolved instanceof Response) return { kind: "refused", response: resolved };
                const { key, metadata = req.metadata } = typeof resolved === "string" ? { key: resolved } : resolved;
                let body = req.body;
                if (body !== undefined && req.admitBody) {
                    const admitted = await req.admitBody(body);
                    if (admitted instanceof Response) return { kind: "refused", response: admitted };
                    body = admitted;
                }

                let uploadToken: string;
                try {
                    // Under the grace window like every other store call a request
                    // makes: a client that leaves mid-creation must not tear the
                    // allocation half-made.
                    ({ uploadToken } = await withGrace(req.signal, (signal) =>
                        store.createUpload({
                            key,
                            length: verdict.declaredLength,
                            metadata,
                            now: createdAt,
                            ...(expiresAt !== undefined && { expiresAt }),
                            signal,
                        }),
                    ));
                } catch (err) {
                    return await mapStoreError(err, undefined, "create", auditKey);
                }
                // Resolved before the first report that names the resource, so the
                // token never precedes its audit-safe substitute onto a sink.
                try {
                    auditKey = auditOf(uploadToken);
                } catch (err) {
                    // No audit-safe identifier exists to report a failed discard
                    // under, and reporting it raw would put the token on the sink.
                    await store.abortUpload(uploadToken).catch(() => undefined);
                    throw err;
                }
                emit(uploadToken, auditKey, verdict.events);

                const declaredLength = verdict.declaredLength;
                // Lock the token before streaming so a client that received an early
                // location (a 104 via onAllocated) and resumes cannot race
                // this creation's still-flushing write with no preemption. Invariant 1.
                const outcome = await withLock(uploadToken, auditKey, (lock) =>
                    withGrace(req.signal, async (signal): Promise<UploadOutcome> => {
                        guarded(() => req.onAllocated?.(uploadToken), uploadToken, auditKey, "allocated-hook");
                        let epoch: number | undefined;
                        try {
                            if (body !== undefined || verdict.completes) epoch = await claim(uploadToken, signal);
                        } catch (err) {
                            return await mapStoreError(err, uploadToken, "claim", auditKey);
                        }
                        let offset = 0;
                        let interrupted = false;
                        if (body !== undefined) {
                            storeTakesBody();
                            try {
                                const written = await streamAppend(
                                    uploadToken,
                                    0,
                                    body,
                                    verdict.maxBytes,
                                    verdict.maxBytesFatal,
                                    undefined,
                                    signal,
                                    lock.signal,
                                    { epoch },
                                );
                                interrupted = written.interrupted;
                                // Clean stream: the store contract pins the durable offset to the
                                // write's own return. An interruption re-reads for the flushed prefix.
                                offset = written.bytesWritten;
                                if (interrupted) {
                                    // Deliberately NOT gated on req.signal. An interruption is often
                                    // the client abort ITSELF (the grace window flushed the received
                                    // prefix, then expired); passing the aborted signal here would
                                    // make the store throw and turn a truthful interrupted response
                                    // into a spurious store error. This read reports the bytes that
                                    // were durably flushed, so it must complete even with the client
                                    // gone -- consistent with the write it reconciles.
                                    const fresh = await store.getUploadState(uploadToken);
                                    offset = fresh.offset;
                                }
                                emit(uploadToken, auditKey, [
                                    { kind: "appended", atOffset: 0, bytes: offset, interrupted },
                                ]);
                            } catch (err) {
                                // An offset conflict here means durable bytes already exist: a
                                // client that took the early location and won the lock with an
                                // append before this creation acquired it, a recoverable race.
                                return await appendFailure(err, uploadToken, auditKey, verdict, 0, key, uploadToken);
                            }
                        }

                        if (statedShort(req, interrupted, declaredLength, offset)) {
                            return representationBoundOutcome(uploadToken, auditKey, "length", 0, offset);
                        }
                        let digest: string | undefined;
                        let etag: string | undefined;
                        let complete = false;
                        if (
                            verdict.completes &&
                            !interrupted &&
                            (declaredLength === undefined || offset === declaredLength)
                        ) {
                            if (belowMinSize(policy, offset)) {
                                emit(uploadToken, auditKey, [{ kind: "append-rejected", reason: "below-min-size" }]);
                                return { kind: "limit-violation", reason: "below-min-size", uploadToken, events: [] };
                            }
                            try {
                                const published = await publish(uploadToken, lock, signal, {
                                    expectedDigests,
                                    expectedLength: offset,
                                    epoch,
                                });
                                if (published === undefined) return lostLease(uploadToken, auditKey);
                                ({ digest, etag } = published);
                                complete = true;
                                emit(uploadToken, auditKey, [{ kind: "completed", length: offset }]);
                                await reportComplete(uploadToken, auditKey, key, offset, metadata, etag, digest);
                            } catch (err) {
                                return await completeFailure(err, uploadToken, auditKey, offset);
                            }
                        }
                        return {
                            kind: "created",
                            uploadToken,
                            offset,
                            length: declaredLength,
                            complete,
                            digest,
                            etag,
                            interrupted,
                            expiresAt,
                        };
                    }),
                );
                // A refusal after allocation concerns the resource just created.
                return withDeadline(outcome, expiresAt);
            });
        },

        async resourceExists(uploadToken, existsOpts): Promise<boolean> {
            try {
                await store.getUploadState(uploadToken, { signal: existsOpts?.signal, repair: false });
                return true;
            } catch (err) {
                // Only a definitive not-found is an answer. Anything else (a backend
                // outage, a signal abort) must not be reported as "gone": a caller
                // gating work on this would turn a transient failure into a 404.
                if (isUploadNotFoundError(err)) {
                    if (isCorruptUploadState(err)) {
                        onError?.(err, { uploadToken, auditKey: existsOpts?.auditKey, operation: "head" });
                    }
                    return false;
                }
                // Reported, not swallowed: a backend that fails here fails silently
                // otherwise, and this is the gate a caller relies on to keep work off
                // a token that names nothing.
                onError?.(err, {
                    uploadToken,
                    auditKey: existsOpts?.auditKey,
                    operation: "head",
                });
                return true;
            }
        },

        async admit(uploadToken, admitOpts): Promise<UploadOutcome | undefined> {
            let state: StoredUploadState;
            try {
                state = await store.getUploadState(uploadToken, { signal: admitOpts?.signal, repair: false });
            } catch (err) {
                // Only a definitive not-found is an answer; any other failure
                // lets the locked append meet it and report it as its own.
                if (isUploadNotFoundError(err)) {
                    return await mapStoreError(err, uploadToken, "head", admitOpts?.auditKey);
                }
                onError?.(err, { uploadToken, auditKey: admitOpts?.auditKey, operation: "head" });
                return undefined;
            }
            return await refusal(admitOpts?.authorize, state);
        },

        async probe(uploadToken, probeOpts): Promise<UploadOutcome> {
            const policy = policyOf(probeOpts?.policy);
            return withLock(uploadToken, probeOpts?.auditKey, async () => {
                let state: StoredUploadState;
                try {
                    state = await store.getUploadState(uploadToken, { signal: probeOpts?.signal });
                } catch (err) {
                    return await mapStoreError(err, uploadToken, "head", probeOpts?.auditKey);
                }
                const refused = await refusal(probeOpts?.authorize, state);
                if (refused) return refused;
                const verdict = evaluateUploadIntent({ kind: "probe" }, state, policy, { now: now() });
                emit(uploadToken, probeOpts?.auditKey, verdict.events);
                // A probe is where an expired resource is usually first noticed, and a
                // resource kept alive by traffic is one the idleness sweep can never
                // reach. Free it with the verdict that condemns it.
                if (verdict.kind === "gone") {
                    await discardResource(uploadToken, probeOpts?.auditKey, "abort");
                }
                if (verdict.kind !== "probe-result") return rejectOutcome(verdict);
                // A conforming client recovers a lost completion answer with this
                // probe, never by repeating its completing request: it reads offset
                // == length and stops. The probe is therefore a delivery path for
                // the at-least-once completion report, and a delivery that throws
                // answers the same backend error the completing request did, so the
                // client probes again instead of concluding the upload landed.
                if (verdict.complete) {
                    try {
                        await reportComplete(uploadToken, probeOpts?.auditKey, state.key, state.offset, state.metadata);
                    } catch (err) {
                        return await mapStoreError(err, uploadToken, "complete", probeOpts?.auditKey);
                    }
                }
                return {
                    kind: "probed",
                    offset: verdict.offset,
                    length: verdict.length,
                    complete: verdict.complete,
                    expiresAt: uploadExpiry(state, policy),
                    metadata: state.metadata,
                };
            });
        },

        async append(uploadToken, req): Promise<UploadOutcome> {
            const policy = policyOf(req.policy);
            return await withBodyOwnership(req.body, async (storeTakesBody) => {
                let expectedDigests: UploadDigests | undefined;
                try {
                    expectedDigests = verifiable(req.expectedDigests, policy);
                } catch (err) {
                    return await mapStoreError(err, uploadToken, "append", req.auditKey);
                }
                // Known once the resource's state is read; a limit rejection reports it.
                let expiresAt: number | undefined;
                const outcome = await withLock(uploadToken, req.auditKey, (lock) =>
                    withGrace(req.signal, async (signal) => {
                        let state: StoredUploadState;
                        try {
                            state = await store.getUploadState(uploadToken, { signal, forAppend: true });
                        } catch (err) {
                            return await mapStoreError(err, uploadToken, "head", req.auditKey);
                        }
                        expiresAt = uploadExpiry(state, policy);
                        const refused = await refusal(req.authorize, state);
                        if (refused) return refused;
                        // tus-style implicit completion, derived HERE from the same fresh
                        // state the engine evaluates (never from a dialect's earlier probe):
                        // a known total is reached by this append's math, or an unknown-sized
                        // body streams through it (the post-condition confirms).
                        const knownLength = req.declaredLength ?? state.length;
                        const completeInferred = req.complete === "infer";
                        const complete = completeInferred
                            ? knownLength !== undefined &&
                              (req.contentLength !== undefined
                                  ? req.offset + req.contentLength === knownLength
                                  : req.body !== undefined)
                            : req.complete === true;
                        const intent: AppendIntent = {
                            kind: "append",
                            offset: req.offset,
                            contentLength: req.contentLength,
                            complete,
                            // The provenance travels with the flag: policy exemptions written
                            // for a client's assertion must not be handed to a conclusion the
                            // orchestrator reached on its own.
                            completeInferred,
                            declaredLength: req.declaredLength,
                        };
                        const verdict = evaluateUploadIntent(intent, state, policy, { now: now() });
                        emit(uploadToken, req.auditKey, verdict.events);

                        // A terminal resource refuses every later request, so nothing else
                        // will ever free its bytes; the sweep's idleness clock cannot reach
                        // one that is still being appended to either.
                        if (verdict.kind === "gone") {
                            await discardResource(uploadToken, req.auditKey, "abort");
                            return rejectOutcome(verdict);
                        }
                        if (verdict.kind === "already-complete") {
                            // The replay is for a retry carrying no byte the representation
                            // lacks. A declared size already answered that in the engine; an
                            // undeclared one is answered by reading to the first byte.
                            // The body yields to a preemption like a store's would; its
                            // listener lives no longer than this lock's signal does.
                            if (
                                req.contentLength === undefined &&
                                req.body &&
                                (await carriesContent(yieldableBody(req.body, lock.signal, []).body))
                            ) {
                                // Content past a fixed length: the length bound, not a size.
                                return representationBoundOutcome(uploadToken, req.auditKey, "length", req.offset);
                            }
                            // The completion hook is AT-LEAST-ONCE, and this is the branch that
                            // makes it so. Without it the hook is at-most-once and its own
                            // promise is unkeepable: publish succeeds, the hook throws, the
                            // client is told the backend failed, the client retries the same
                            // completing request, and the retry lands here and answers the
                            // idempotent success. The client then believes the upload landed,
                            // the consumer's records never saw it, and no protocol path ever
                            // invokes the hook again. That is precisely the failure the await
                            // was built to prevent, deferred by one round trip.
                            //
                            // Re-derived from the state read fresh under this lock, NOT by
                            // calling completeUpload again: this contract documents idempotence
                            // for abortUpload and never for completeUpload, so a speculative
                            // second publish is not something a store promises to tolerate. The
                            // cost is that a re-delivery carries no etag or digest, both already
                            // optional on the hook; a consumer keys on the token, which does not
                            // change.
                            await reportComplete(uploadToken, req.auditKey, state.key, state.offset, state.metadata);
                            return rejectOutcome(verdict);
                        }
                        if (verdict.kind !== "append-allowed") return rejectOutcome(verdict);
                        let epoch: number | undefined;
                        try {
                            epoch = await claim(uploadToken, signal);
                        } catch (err) {
                            return await mapStoreError(err, uploadToken, "claim", req.auditKey);
                        }

                        // Persist a length first declared on a no-body PATCH too, and force a
                        // write for a completing append so the store's own bound decides what
                        // its body carries: the write path is what records the length, and an
                        // empty body satisfies a zero-byte bound while any byte trips it.
                        const bodyToWrite =
                            req.body ??
                            (verdict.declaredLength !== undefined || verdict.completes ? new Uint8Array(0) : undefined);
                        let interrupted = false;
                        let bytesWritten = 0;
                        if (bodyToWrite !== undefined) {
                            storeTakesBody();
                            try {
                                const written = await streamAppend(
                                    uploadToken,
                                    verdict.atOffset,
                                    bodyToWrite,
                                    verdict.maxBytes,
                                    verdict.maxBytesFatal,
                                    verdict.declaredLength,
                                    signal,
                                    lock.signal,
                                    // The state this append was judged on, read under
                                    // this same lock: a store may write against it
                                    // instead of reading it again.
                                    { epoch, snapshot: state.snapshot },
                                );
                                interrupted = written.interrupted;
                                bytesWritten = written.bytesWritten;
                            } catch (err) {
                                // An offset conflict here is the store refusing a claim its own
                                // durable state contradicts: the stolen-lock case the offset
                                // check exists for, and the one an auditor most needs recorded.
                                return await appendFailure(
                                    err,
                                    uploadToken,
                                    req.auditKey,
                                    verdict,
                                    verdict.atOffset,
                                    state.key,
                                    undefined,
                                );
                            }
                        }
                        // A clean append needs no trailing re-probe: the store contract pins
                        // `getUploadState` to agree with `atOffset + bytesWritten` after a
                        // clean return, the length is the pre-read state's (or the one this
                        // append just persisted), and the expiry is immutable. Only an
                        // interruption leaves the durable prefix unknown and re-reads.
                        let durableOffset = verdict.atOffset + bytesWritten;
                        let length = state.length ?? verdict.declaredLength;
                        if (interrupted) {
                            try {
                                // NOT gated on req.signal: an interruption is often the client
                                // abort itself, and this re-read reports the durably-flushed
                                // offset precisely so the interrupted response is truthful. Gating
                                // it on the aborted signal would make the store throw and downgrade
                                // a truthful interrupted outcome to a spurious store error.
                                const fresh = await store.getUploadState(uploadToken);
                                durableOffset = fresh.offset;
                                length = fresh.length ?? req.declaredLength;
                            } catch (err) {
                                return await mapStoreError(err, uploadToken, "head", req.auditKey);
                            }
                        }
                        if (bodyToWrite !== undefined) {
                            const { atOffset } = verdict;
                            emit(uploadToken, req.auditKey, [
                                { kind: "appended", atOffset, bytes: durableOffset - atOffset, interrupted },
                            ]);
                        }

                        let digest: string | undefined;
                        let etag: string | undefined;
                        let publishedComplete = false;
                        // The verdict's post-condition, evaluated against what the store made
                        // durable. This is the whole reason the engine states one: a request
                        // that declared no content size cannot be measured against the total
                        // it promised until its bytes have landed, and only the store counts
                        // them. An absent `completesAt` means nothing fixed the total in
                        // advance, so the delivered bytes ARE the representation.
                        const { completesAt } = verdict.postCondition;
                        if (statedShort(req, interrupted, completesAt, durableOffset)) {
                            return representationBoundOutcome(
                                uploadToken,
                                req.auditKey,
                                "length",
                                verdict.atOffset,
                                durableOffset,
                            );
                        }
                        const shouldComplete =
                            verdict.completes &&
                            !interrupted &&
                            (completesAt === undefined || durableOffset === completesAt);
                        if (shouldComplete) {
                            // The streaming-completion size floor. A total fixed in advance
                            // met the floor before this append was permitted, since the
                            // append is what would make it immutable. What is left is the
                            // total no length indicator fixed: a completing append with an
                            // unknown content size reveals it only by delivering it, and
                            // nothing is frozen, so gating it here is still ahead of
                            // publication.
                            if (belowMinSize(policy, durableOffset)) {
                                emit(uploadToken, req.auditKey, [
                                    { kind: "append-rejected", reason: "below-min-size", atOffset: verdict.atOffset },
                                ]);
                                return { kind: "limit-violation", reason: "below-min-size", events: [] };
                            }
                            try {
                                const published = await publish(uploadToken, lock, signal, {
                                    expectedDigests,
                                    expectedLength: durableOffset,
                                    epoch,
                                });
                                if (published === undefined) return lostLease(uploadToken, req.auditKey);
                                ({ digest, etag } = published);
                                publishedComplete = true;
                                emit(uploadToken, req.auditKey, [{ kind: "completed", length: durableOffset }]);
                                await reportComplete(
                                    uploadToken,
                                    req.auditKey,
                                    state.key,
                                    durableOffset,
                                    state.metadata,
                                    etag,
                                    digest,
                                );
                            } catch (err) {
                                return await completeFailure(err, uploadToken, req.auditKey, durableOffset);
                            }
                        }
                        return {
                            kind: "appended",
                            offset: durableOffset,
                            length,
                            complete: publishedComplete,
                            digest,
                            etag,
                            interrupted,
                            expiresAt,
                        };
                    }),
                );
                return withDeadline(outcome, expiresAt);
            });
        },

        async cancel(uploadToken, cancelOpts): Promise<UploadOutcome> {
            const auditKey = cancelOpts?.auditKey;
            // The discard runs under the grace window: a client that leaves
            // mid-DELETE must not stop the erasure it asked for halfway.
            return withLock(uploadToken, auditKey, () =>
                withGrace(cancelOpts?.signal, async (signal): Promise<UploadOutcome> => {
                    const signalled = { signal };
                    // A cancel is answered whatever the resource's state, so the read
                    // gates nothing: it names the destination key, which an abort error
                    // may carry and redaction must know, and tells a token nothing
                    // recognises apart from a discarded upload. A read that fails (the
                    // multipart is already gone, the bookkeeping is corrupt, a throttle)
                    // is exactly the upload that most needs discarding, so it never
                    // stops the abort, which is idempotent by contract.
                    const read = await store.getUploadState(uploadToken, signalled).then(
                        (state) => ({ state }),
                        (err: unknown) => (isUploadNotFoundError(err) ? null : { err }),
                    );
                    if (cancelOpts?.authorize) {
                        // An authorized cancel decides on the stored facts, so a read that
                        // yields none refuses: discarding on a failed read would let any
                        // holder of a token destroy an upload the hook never saw.
                        if (read === null) return { kind: "not-found" };
                        if ("err" in read) return await mapStoreError(read.err, uploadToken, "head", auditKey);
                        const refused = await refusal(cancelOpts.authorize, read.state);
                        if (refused) return refused;
                    }
                    try {
                        // Claimed only on a resource the read found: a cancel whose read
                        // failed still discards, and has no resource to fence.
                        const epoch = read && "state" in read ? await claim(uploadToken, signalled.signal) : undefined;
                        await store.abortUpload(uploadToken, { ...signalled, epoch });
                    } catch (err) {
                        return await mapStoreError(err, uploadToken, "abort", auditKey);
                    }
                    // Whatever the store still held under an unrecognised token is gone
                    // now, and the answer stays the not-found that token always got.
                    if (read === null) return { kind: "not-found" };
                    // The outcome event follows the store action it describes, so a
                    // throwing abortUpload never leaves a `cancelled` in the audit trail.
                    emit(uploadToken, auditKey, [{ kind: "cancelled" }]);
                    return { kind: "cancelled" };
                }),
            );
        },
    };
}

/**
 * Whether a body of undeclared size carries any byte, read only as far as the
 * first one and then cancelled. A body that fails, or a preemption that lands
 * while the read waits, counts as empty: nothing was learned to refuse.
 */
async function carriesContent(body: UploadBody): Promise<boolean> {
    if (body instanceof Uint8Array) return body.length > 0;
    const reader = body.getReader();
    try {
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
            if (next.value.length > 0) return true;
        }
        return false;
    } catch {
        return false;
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}

/**
 * The body a store reads, made to fail the moment the write is asked to yield.
 *
 * A store observes its signal between chunks, and a half-open connection
 * parks it inside a read that never settles: without this a preempting
 * request waits out the whole lock timeout for a yield nobody can observe.
 * On abort the source is cancelled (telling the peer to stop) and the stream
 * the store holds ERRORS with the signal's reason, never closes: a store reads
 * a clean end as the whole body, and a completing append with no fixed total
 * would publish the truncated prefix. An error is what every store already
 * reports as an interruption, with the flushed prefix durable.
 *
 * `release` is the store's `releaseBody` handle: it cancels the source through
 * the reader this function holds, so it works on a stream the store has
 * locked, and a read after it errors for the same reason a yield does.
 */
function yieldableBody(
    body: UploadBody,
    signal: AbortSignal,
    cleanups: Array<() => void>,
): { body: UploadBody; release: () => Promise<void> } {
    if (body instanceof Uint8Array) return { body, release: async () => {} };
    const reader = body.getReader();
    let released = false;
    const release = async (): Promise<void> => {
        released = true;
        await reader.cancel().catch(() => undefined);
    };
    const yieldable = new ReadableStream<Uint8Array>(
        {
            start() {
                // Cancelling settles a pending read at once: as done when nothing
                // arrived, or with the chunk that already had, which is delivered.
                const onAbort = (): void => void reader.cancel(signal.reason).catch(() => undefined);
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
                cleanups.push(() => signal.removeEventListener("abort", onAbort));
            },
            async pull(ctl) {
                try {
                    const { done, value } = await reader.read();
                    if (!done) ctl.enqueue(value);
                    if (signal.aborted) ctl.error(signal.reason);
                    else if (released) ctl.error(new Error("upload body released"));
                    else if (done) ctl.close();
                } catch (err) {
                    ctl.error(err);
                }
            },
            cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
    );
    return { body: yieldable, release };
}

/**
 * Reject a policy the engine would otherwise trust silently: every bound must
 * be a non-negative safe integer, and the floors must not exceed the ceilings.
 */
function validatePolicy(policy: UploadPolicy): void {
    for (const name of ["maxSize", "minSize", "maxAppendSize", "minAppendSize", "maxAgeSeconds"] as const) {
        intOption(`createUploadOrchestrator: policy.${name}`, policy[name], 0);
    }
    if (![undefined, "advisory", "require-verifiable"].includes(policy.digestPolicy)) {
        throw new TypeError("createUploadOrchestrator: policy.digestPolicy is not a known policy");
    }
    for (const [floor, ceiling] of [
        ["minSize", "maxSize"],
        ["minAppendSize", "maxAppendSize"],
    ] as const) {
        if ((policy[floor] ?? 0) > (policy[ceiling] ?? Infinity)) {
            throw new TypeError(
                `createUploadOrchestrator: policy.${floor} (${policy[floor]}) exceeds ${ceiling} (${policy[ceiling]})`,
            );
        }
    }
}
