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
 *    // descope: no lock-independent fencing token threaded to the store; the
 *    // required at-write offset check is the guard, and an option no store
 *    // reads would be a documented capability with no call site. Revisit when
 *    // a store implements conditional writes that could reject a stale holder
 *    // by token rather than by offset.
 *
 * Dialects (tus 1.0, IETF draft) translate requests into intents, call one
 * orchestrator method, and translate the returned OUTCOME into statuses and
 * headers. Outcomes are wire-agnostic, like the engine's verdicts they wrap.
 */

import {
  evaluateUploadCreation,
  evaluateUploadIntent,
  type AppendIntent,
  type CreateIntent,
  type UploadAuditEvent,
  type UploadPolicy,
  type UploadState,
  type UploadVerdict,
} from "./upload-engine.ts";
import {
  isUploadDigestMismatchError,
  isUploadNotFoundError,
  isUploadOffsetConflictError,
  isUploadAppendBoundError,
  isUploadOverrunError,
  type ResumableWriteStore,
  type StoredUploadState,
} from "./upload-store.ts";
import { memoryUploadLocker, isUploadLockTimeoutError, type UploadLocker, type UploadLock } from "./upload-locker.ts";
import { redactUploadToken } from "./upload-internals.ts";

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
   * await is only worth something if a failed delivery gets another attempt,
   * and the only retry a resumable protocol has is the client repeating its
   * completing request. That repeat is answered idempotently, and it
   * re-delivers here rather than short-circuiting, so an upload whose first
   * delivery threw is recorded on the retry instead of being lost. A
   * re-delivery reports what durable state knows and may omit `etag` and
   * `digest`; the token does not change, which is why it is the key.
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
  /** Must not throw (there is no sink for a failing error sink). */
  onError?: (error: unknown, context: { uploadToken?: string; auditKey?: string; operation: string }) => void;
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
  /** Clock injection (tests). @default Date.now */
  now?: () => number;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

/**
 * Reject verdicts pass through to the dialect unchanged, plus the resource the
 * rejection concerns when one exists. A creation whose body is refused
 * mid-stream has already allocated its resource and made a prefix durable:
 * without the token those bytes are unreachable, so the client can neither
 * resume them nor delete them and only a sweep (optional, and meaningless
 * without a max age) ever reclaims them.
 */
type UploadRejectOutcome = { uploadToken?: string } & Extract<
  UploadVerdict,
  | { kind: "offset-mismatch" }
  | { kind: "limit-violation" }
  | { kind: "length-inconsistent" }
  | { kind: "gone" }
  | { kind: "contended" }
  | { kind: "already-complete" }
>;

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
      remainingLifetimeSeconds?: number;
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
       * long append cannot inflate (unlike now + remainingLifetimeSeconds).
       */
      expiresAt?: number;
    }
  | { kind: "cancelled" }
  | { kind: "digest-mismatch" }
  | { kind: "not-found" }
  | { kind: "store-error"; error: unknown }
  | UploadRejectOutcome;

// ─── Request shapes (dialect-parsed) ────────────────────────────────────────

export interface CreateUploadRequest {
  key: string;
  declaredLength?: number;
  contentLength?: number;
  complete: boolean;
  body?: ReadableStream<Uint8Array> | Uint8Array;
  metadata?: Record<string, string>;
  expectedDigest?: string;
  auditKey?: string;
  signal?: AbortSignal;
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
   */
  complete: boolean | "infer";
  declaredLength?: number;
  body?: ReadableStream<Uint8Array> | Uint8Array;
  expectedDigest?: string;
  auditKey?: string;
  signal?: AbortSignal;
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
  probe(uploadToken: string, opts?: { auditKey?: string; signal?: AbortSignal }): Promise<UploadOutcome>;
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
  append(uploadToken: string, req: AppendUploadRequest): Promise<UploadOutcome>;
  cancel(uploadToken: string, opts?: { auditKey?: string; signal?: AbortSignal }): Promise<UploadOutcome>;
  /** Effective policy (dialects advertise it as limits). */
  readonly policy: UploadPolicy;
  /** Whether completion-time sha-256 verification is available end to end. */
  readonly canVerifyDigest: boolean;
}

export function createUploadOrchestrator(
  store: ResumableWriteStore,
  opts: UploadOrchestratorOptions = {},
): UploadOrchestrator {
  // The orchestrator publishes on a single `completeUpload` and has no
  // rollback of its own, so a non-atomic store could leave a torn object
  // visible to readers. Refuse it at construction rather than corrupt later.
  if (!store.atomicCompletion) {
    throw new TypeError(
      "createUploadOrchestrator: store must report atomicCompletion: true "
      + "(the orchestrator has no completion rollback of its own)",
    );
  }
  // The lock serializes writers; it cannot prove the writer still holds it.
  // An expiry-based distributed lock is stealable from a holder that stalls
  // past its TTL and resumes, so the store's at-write offset check is what
  // turns that holder's late write into a loud conflict instead of silent
  // interleaving. A store that cannot make that check has no defense left to
  // fall back on, so it is refused here rather than trusted to be deployed
  // single-process forever.
  if (!store.enforcesOffsetCheck) {
    throw new TypeError(
      "createUploadOrchestrator: store must report enforcesOffsetCheck: true "
      + "(appendChunk must refuse a write whose claimed offset disagrees with "
      + "durable state; it is the only guard against a stolen-lock writer)",
    );
  }
  const policy: UploadPolicy = { ...opts.policy };
  if (store.maxAppendSize !== undefined) {
    policy.maxAppendSize = policy.maxAppendSize === undefined
      ? store.maxAppendSize
      : Math.min(policy.maxAppendSize, store.maxAppendSize);
  }
  // Policy is the one input class the engine trusts without a per-request
  // gate; a NaN/negative/fractional bound would silently disable enforcement
  // (`x > NaN` is false) or flow a NaN maxBytes to an adapter. Fail loudly at
  // construction, matching the package's caller-bugs-fail-loudly posture.
  validatePolicy(policy);
  const locker = opts.locker ?? memoryUploadLocker();
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? 10_000;
  const lockTimeoutMs = opts.lockTimeoutMs;
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
        if (ctx.auditKey === undefined) {
          rawOnError(err, ctx);
          return;
        }
        // The error travels to the same sink as the context, so redacting only
        // the context leaves the capability in the message, the errno `path`,
        // or a stack frame.
        rawOnError(
          redactUploadToken(err, ctx.uploadToken, ctx.auditKey),
          { ...ctx, uploadToken: undefined },
        );
      }
    : undefined;
  const emit = opts.onUploadEvent
    ? (uploadToken: string | undefined, auditKey: string | undefined, events: UploadAuditEvent[]): void => {
        // The audit key SUBSTITUTES for the token, it does not accompany it:
        // the token is the capability, and a caller that went to the trouble
        // of supplying a safe identifier for its log records gains nothing
        // from receiving the credential in the same object.
        const reportedToken = auditKey === undefined ? uploadToken : undefined;
        for (const event of events) {
          try {
            opts.onUploadEvent!({ uploadToken: reportedToken, auditKey, event });
          } catch (err) {
            onError?.(err, { uploadToken, auditKey, operation: "audit" });
          }
        }
      }
    : () => {};

  /**
   * Decouple the storage signal from the request signal: on client abort the
   * storage operation gets `graceMs` more to flush before it is cancelled.
   */
  function graceSignal(signal: AbortSignal | undefined, cleanups: Array<() => void>): AbortSignal | undefined {
    if (!signal || graceMs <= 0) return signal;
    const ctl = new AbortController();
    const startTimer = () => {
      const timer = setTimeout(() => ctl.abort(signal.reason), graceMs);
      cleanups.push(() => clearTimeout(timer));
    };
    // An ALREADY-aborted request still opens the window: the abort may have
    // landed between request arrival and the store call, and the received
    // bytes deserve their flush either way.
    if (signal.aborted) {
      startTimer();
    } else {
      signal.addEventListener("abort", startTimer, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", startTimer));
    }
    return ctl.signal;
  }

  /** The final durable size is below the policy floor: refuse to publish. */
  function belowMinSize(finalSize: number): boolean {
    return policy.minSize !== undefined && finalSize < policy.minSize;
  }

  /** Absolute expiry (epoch ms) for a resource, or undefined when no max age. */
  function expiryOf(createdAt: number): number | undefined {
    return policy.maxAgeSeconds === undefined ? undefined : createdAt + policy.maxAgeSeconds * 1000;
  }

  /**
   * Report a publication before the answer goes out.
   *
   * Awaited deliberately: a consumer that records the object in its own
   * database needs that write to happen before the client is told the upload
   * succeeded, or a crash between the two leaves an object nothing points at.
   *
   * AT-LEAST-ONCE, not once. The await above is only worth something if a
   * failed delivery is retried, and the only retry a resumable protocol has is
   * the client repeating its completing request; that repeat is answered
   * idempotently, so it must re-deliver rather than short-circuit. A consumer
   * therefore has to be idempotent on `uploadToken`, which is the key it
   * already holds. A re-delivery carries what durable state knows and may omit
   * `etag` and `digest`.
   */
  async function reportComplete(
    uploadToken: string,
    auditKey: string | undefined,
    key: string,
    length: number,
    metadata: Record<string, string> | undefined,
    etag: string | undefined,
    digest: string | undefined,
  ): Promise<void> {
    if (onUploadComplete === undefined) return;
    await onUploadComplete({ uploadToken, auditKey, key, length, metadata, etag, digest });
  }

  function mapStoreError(
    err: unknown,
    uploadToken: string | undefined,
    operation: string,
    auditKey?: string,
  ): UploadOutcome {
    if (isUploadNotFoundError(err)) return { kind: "not-found" };
    if (isUploadDigestMismatchError(err)) return { kind: "digest-mismatch" };
    onError?.(err, { uploadToken, auditKey, operation });
    return { kind: "store-error", error: err };
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
        throw new Error(`upload orchestrator: unexpected verdict ${verdict.kind} for this intent`);
    }
  }

  function toStateShape(s: StoredUploadState): UploadState {
    return {
      offset: s.offset,
      length: s.length,
      isComplete: s.isComplete,
      isInvalidated: s.isInvalidated,
      createdAt: s.createdAt,
      lastAppendAt: s.lastAppendAt,
    };
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
      lock = await locker.acquire(uploadToken, {
        ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }),
        ...(auditKey === undefined ? {} : { auditKey }),
      });
    } catch (err) {
      if (isUploadLockTimeoutError(err)) return { kind: "contended", events: [] };
      throw err;
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
    signal: AbortSignal | undefined,
    lockSignal: AbortSignal,
  ): Promise<{ bytesWritten: number; interrupted: boolean }> {
    const cleanups: Array<() => void> = [];
    // Two independent yield triggers, composed into the one signal the store
    // sees: `lockSignal` aborts the write AT ONCE (a later acquirer is waiting,
    // so yield now); a client disconnect aborts it only after the grace window
    // (so its already-received bytes still flush and the offset stays truthful).
    const graced = graceSignal(signal, cleanups);
    const writeSignal = linkAbort([lockSignal, graced], cleanups);
    try {
      const { bytesWritten } = await store.appendChunk(uploadToken, atOffset, body, {
        maxBytes,
        maxBytesFatal,
        // A length first declared on this append: the store persists it so the
        // next getUploadState reports it and it becomes immutable (the
        // deferred-length flow). Undefined once the length is already known.
        length: declaredLength,
        now: now(),
        signal: writeSignal,
      });
      return { bytesWritten, interrupted: false };
    } catch (err) {
      // An aborted/preempted/torn body is an INTERRUPTION, not a protocol
      // error: the spec's model is "append as much as possible". The store
      // reports durable bytes via fresh state; anything else rethrows to the
      // caller's error mapping.
      if (writeSignal.aborted) return { bytesWritten: 0, interrupted: true };
      throw err;
    } finally {
      for (const fn of cleanups) fn();
    }
  }

  return {
    policy,
    canVerifyDigest: store.digestOnComplete === "sha256",

    async create(req): Promise<UploadOutcome> {
      // Capture the creation instant ONCE, before any (possibly slow, streaming)
      // work: the resource's createdAt and its advertised expiry must anchor
      // here, not after the body drains, or a long create inflates the deadline.
      const createdAt = now();
      const intent: CreateIntent = {
        kind: "create",
        declaredLength: req.declaredLength,
        contentLength: req.contentLength,
        hasContent: req.body !== undefined,
        complete: req.complete,
      };
      const verdict = evaluateUploadCreation(intent, policy);
      if (verdict.kind !== "create-accepted") {
        emit(undefined, req.auditKey, verdict.events);
        return rejectOutcome(verdict);
      }
      // RFC 9530: a client's Repr-Digest is advisory. A store that cannot
      // verify sha-256 IGNORES the assertion rather than refusing the upload
      // (refusing would 100%-fail every integrity-conscious client on a
      // non-verifying backend, telling it its bytes are corrupt when nothing
      // was compared). Verifying stores still enforce it at completion.
      const expectedDigest = store.digestOnComplete === "sha256" ? req.expectedDigest : undefined;

      let uploadToken: string;
      try {
        ({ uploadToken } = await store.createUpload({
          key: req.key,
          length: verdict.declaredLength,
          metadata: req.metadata,
          now: createdAt,
          signal: req.signal,
        }));
      } catch (err) {
        return mapStoreError(err, undefined, "create", req.auditKey);
      }
      emit(uploadToken, req.auditKey, verdict.events);

      const declaredLength = verdict.declaredLength;
      // Lock the token before streaming so a client that received an early
      // location (a 104 via onResumptionSupported) and resumes cannot race
      // this creation's still-flushing write with no preemption. Invariant 1.
      return withLock(uploadToken, req.auditKey, async (lock) => {
        let offset = 0;
        let interrupted = false;
        if (req.body !== undefined) {
          try {
            const written = await streamAppend(
              uploadToken, 0, req.body, verdict.maxBytes, verdict.maxBytesFatal,
              undefined, req.signal, lock.signal,
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
          } catch (err) {
            // This request's ceiling, not the representation's: the resource
            // is healthy and whatever landed is durable, so the client learns
            // its chunk was too large (413) and resumes rather than losing the
            // upload. Nothing is invalidated.
            if (isUploadAppendBoundError(err)) {
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "append-too-large", atOffset: 0 }]);
              return { kind: "limit-violation", reason: "append-too-large", uploadToken, events: [] };
            }
            if (isUploadOverrunError(err)) {
              // The body ran past a representation bound and the store has
              // invalidated the resource. Which bound decides the answer: past
              // the client's own declared length is that inconsistency
              // arriving mid-stream instead of in the headers, past the
              // server's ceiling is a size violation.
              const reason = verdict.fatalReason === "size" ? "size-exceeded" : "length-inconsistent";
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason, atOffset: 0 }]);
              return reason === "size-exceeded"
                ? { kind: "limit-violation", reason, uploadToken, events: [] }
                : { kind: "length-inconsistent", uploadToken, events: [] };
            }
            if (isUploadOffsetConflictError(err)) {
              // Creation streams at offset 0, so durable bytes already exist:
              // a client that took the early location and won the lock with an
              // append before this creation acquired it. That is a recoverable
              // race with a truthful answer, and answering a store error would
              // report a backend fault for a state the client can resume from.
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "offset-mismatch", atOffset: 0 }]);
              return {
                kind: "offset-mismatch",
                claimedOffset: 0,
                correctOffset: err.durableOffset,
                complete: false,
                events: [],
              };
            }
            return mapStoreError(err, uploadToken, "append", req.auditKey);
          }
        }

        let digest: string | undefined;
        let etag: string | undefined;
        let complete = false;
        if (verdict.completes && !interrupted && (declaredLength === undefined || offset === declaredLength)) {
          if (belowMinSize(offset)) {
            emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "below-min-size" }]);
            return { kind: "limit-violation", reason: "below-min-size", uploadToken, events: [] };
          }
          try {
            ({ digest, etag } = await store.completeUpload(uploadToken, {
              expectedDigest, now: now(), signal: req.signal,
            }));
            complete = true;
            emit(uploadToken, req.auditKey, [{ kind: "completed", length: offset }]);
            await reportComplete(uploadToken, req.auditKey, req.key, offset, req.metadata, etag, digest);
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete", req.auditKey);
          }
        }
        return {
          kind: "created", uploadToken, offset, length: declaredLength, complete, digest, etag, interrupted,
          expiresAt: expiryOf(createdAt),
        };
      });
    },

    async resourceExists(uploadToken, existsOpts): Promise<boolean> {
      try {
        await store.getUploadState(uploadToken, { signal: existsOpts?.signal });
        return true;
      } catch (err) {
        // Only a definitive not-found is an answer. Anything else (a backend
        // outage, a signal abort) must not be reported as "gone": a caller
        // gating work on this would turn a transient failure into a 404.
        if (isUploadNotFoundError(err)) return false;
        // Reported, not swallowed: a backend that fails here fails silently
        // otherwise, and this is the gate a caller relies on to keep work off
        // a token that names nothing.
        onError?.(err, {
          uploadToken, auditKey: existsOpts?.auditKey, operation: "head",
        });
        return true;
      }
    },

    async probe(uploadToken, probeOpts): Promise<UploadOutcome> {
      return withLock(uploadToken, probeOpts?.auditKey, async () => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: probeOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head", probeOpts?.auditKey);
        }
        const verdict = evaluateUploadIntent({ kind: "probe" }, toStateShape(state), policy, { now: now() });
        emit(uploadToken, probeOpts?.auditKey, verdict.events);
        if (verdict.kind !== "probe-result") return rejectOutcome(verdict);
        return {
          kind: "probed",
          offset: verdict.offset,
          length: verdict.length,
          complete: verdict.complete,
          remainingLifetimeSeconds: verdict.remainingLifetimeSeconds,
          expiresAt: expiryOf(state.createdAt),
          metadata: state.metadata,
        };
      });
    },

    async append(uploadToken, req): Promise<UploadOutcome> {
      // RFC 9530: ignore an unverifiable client digest rather than refusing
      // (see create). Verifying stores still enforce it at completion.
      const expectedDigest = store.digestOnComplete === "sha256" ? req.expectedDigest : undefined;
      return withLock(uploadToken, req.auditKey, async (lock) => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: req.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head", req.auditKey);
        }
        // tus-style implicit completion, derived HERE from the same fresh
        // state the engine evaluates (never from a dialect's earlier probe):
        // a known total is reached by this append's math, or an unknown-sized
        // body streams through it (the post-write size check confirms).
        const knownLength = req.declaredLength ?? state.length;
        const complete = req.complete === "infer"
          ? knownLength !== undefined && (req.contentLength !== undefined
              ? req.offset + req.contentLength === knownLength
              : req.body !== undefined)
          : req.complete;
        const intent: AppendIntent = {
          kind: "append",
          offset: req.offset,
          contentLength: req.contentLength,
          complete,
          declaredLength: req.declaredLength,
        };
        const verdict = evaluateUploadIntent(intent, toStateShape(state), policy, { now: now() });
        emit(uploadToken, req.auditKey, verdict.events);

        if (verdict.kind === "complete-now") {
          if (belowMinSize(verdict.length)) {
            emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "below-min-size", atOffset: req.offset }]);
            return { kind: "limit-violation", reason: "below-min-size", events: [] };
          }
          try {
            const done = await store.completeUpload(uploadToken, {
              expectedDigest, now: now(), signal: req.signal,
            });
            // The outcome event follows the store action it describes, so a
            // throwing completeUpload never leaves a `completed` in the audit
            // trail (same ordering as the create and streaming-append paths).
            emit(uploadToken, req.auditKey, [{ kind: "completed", length: verdict.length }]);
            await reportComplete(
              uploadToken, req.auditKey, state.key, verdict.length,
              state.metadata, done.etag, done.digest,
            );
            return {
              kind: "appended", offset: verdict.length, length: verdict.length,
              complete: true, digest: done.digest, etag: done.etag, interrupted: false,
            };
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete", req.auditKey);
          }
        }
        if (verdict.kind === "already-complete") {
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
          await reportComplete(
            uploadToken, req.auditKey, state.key, state.offset, state.metadata,
            undefined, undefined,
          );
          return rejectOutcome(verdict);
        }
        if (verdict.kind !== "append-allowed") return rejectOutcome(verdict);

        // Persist a length first declared on a no-body PATCH too: the write
        // path is what records it, so an empty append carries the length.
        const bodyToWrite = req.body
          ?? (verdict.declaredLength !== undefined ? new Uint8Array(0) : undefined);
        let interrupted = false;
        let bytesWritten = 0;
        if (bodyToWrite !== undefined) {
          try {
            const written = await streamAppend(
              uploadToken, verdict.atOffset, bodyToWrite, verdict.maxBytes,
              verdict.maxBytesFatal, verdict.declaredLength, req.signal, lock.signal,
            );
            interrupted = written.interrupted;
            bytesWritten = written.bytesWritten;
          } catch (err) {
            // This request's ceiling, not the representation's: the resource
            // is healthy and whatever landed is durable, so the client learns
            // its chunk was too large (413) and resumes rather than losing the
            // upload. Nothing is invalidated.
            if (isUploadAppendBoundError(err)) {
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "append-too-large", atOffset: verdict.atOffset }]);
              return { kind: "limit-violation", reason: "append-too-large", events: [] };
            }
            if (isUploadOverrunError(err)) {
              // The body ran past a representation bound and the store has
              // invalidated the resource. Which bound decides the answer: past
              // the client's own declared length is that inconsistency
              // arriving mid-stream instead of in the headers, past the
              // server's ceiling is a size violation.
              const reason = verdict.fatalReason === "size" ? "size-exceeded" : "length-inconsistent";
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason, atOffset: verdict.atOffset }]);
              return reason === "size-exceeded"
                ? { kind: "limit-violation", reason, uploadToken, events: [] }
                : { kind: "length-inconsistent", uploadToken, events: [] };
            }
            if (isUploadOffsetConflictError(err)) {
              // The store refused a claim its own durable state contradicts:
              // the stolen-lock case the offset check exists for, and the one
              // an auditor most needs in the record.
              emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "offset-mismatch", atOffset: req.offset }]);
              return {
                kind: "offset-mismatch",
                claimedOffset: req.offset,
                correctOffset: err.durableOffset,
                complete: false,
                events: [],
              };
            }
            return mapStoreError(err, uploadToken, "append", req.auditKey);
          }
        }
        // A clean append needs no trailing re-probe: the store contract pins
        // `getUploadState` to agree with `atOffset + bytesWritten` after a
        // clean return, the length is the pre-read state's (or the one this
        // append just persisted), and `createdAt` is immutable. Only an
        // interruption leaves the durable prefix unknown and re-reads.
        let durableOffset = verdict.atOffset + bytesWritten;
        let length = state.length ?? verdict.declaredLength;
        let createdAt = state.createdAt;
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
            createdAt = fresh.createdAt;
          } catch (err) {
            return mapStoreError(err, uploadToken, "head", req.auditKey);
          }
        }

        let digest: string | undefined;
        let etag: string | undefined;
        let publishedComplete = false;
        const shouldComplete = verdict.completes && !interrupted
          && (req.contentLength === undefined || durableOffset === verdict.atOffset + req.contentLength)
          && (length === undefined || durableOffset === length);
        if (shouldComplete) {
          // The streaming-completion size floor: a completing append with an
          // unknown content size only reveals the final total here, so this
          // is the one place minSize can gate it before publishing.
          if (belowMinSize(durableOffset)) {
            emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "below-min-size", atOffset: verdict.atOffset }]);
            return { kind: "limit-violation", reason: "below-min-size", events: [] };
          }
          try {
            ({ digest, etag } = await store.completeUpload(uploadToken, {
              expectedDigest, now: now(), signal: req.signal,
            }));
            publishedComplete = true;
            emit(uploadToken, req.auditKey, [{ kind: "completed", length: durableOffset }]);
            await reportComplete(
              uploadToken, req.auditKey, state.key, durableOffset,
              state.metadata, etag, digest,
            );
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete", req.auditKey);
          }
        }
        return {
          kind: "appended", offset: durableOffset, length,
          complete: publishedComplete, digest, etag, interrupted, expiresAt: expiryOf(createdAt),
        };
      });
    },

    async cancel(uploadToken, cancelOpts): Promise<UploadOutcome> {
      return withLock(uploadToken, cancelOpts?.auditKey, async () => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: cancelOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head", cancelOpts?.auditKey);
        }
        const verdict = evaluateUploadIntent({ kind: "cancel" }, toStateShape(state), policy, { now: now() });
        emit(uploadToken, cancelOpts?.auditKey, verdict.events);
        if (verdict.kind !== "cancel-accepted") return rejectOutcome(verdict);
        try {
          await store.abortUpload(uploadToken, { signal: cancelOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "abort", cancelOpts?.auditKey);
        }
        // The outcome event follows the store action it describes, so a
        // throwing abortUpload never leaves a `cancelled` in the audit trail.
        emit(uploadToken, cancelOpts?.auditKey, [{ kind: "cancelled" }]);
        return { kind: "cancelled" };
      });
    },
  };
}

/**
 * Reject a policy the engine would otherwise trust silently: every bound must
 * be a non-negative safe integer, and the floors must not exceed the ceilings.
 * A NaN/negative/fractional value would disable enforcement or flow a NaN
 * byte-bound to an adapter, so this throws at construction rather than corrupt
 * quietly at runtime.
 */
function validatePolicy(policy: UploadPolicy): void {
  const fields: Array<[keyof UploadPolicy, number | undefined]> = [
    ["maxSize", policy.maxSize],
    ["minSize", policy.minSize],
    ["maxAppendSize", policy.maxAppendSize],
    ["minAppendSize", policy.minAppendSize],
    ["maxAgeSeconds", policy.maxAgeSeconds],
  ];
  for (const [name, value] of fields) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`createUploadOrchestrator: policy.${name} must be a non-negative safe integer, got ${value}`);
    }
  }
  if (policy.minSize !== undefined && policy.maxSize !== undefined && policy.minSize > policy.maxSize) {
    throw new TypeError(`createUploadOrchestrator: policy.minSize (${policy.minSize}) exceeds maxSize (${policy.maxSize})`);
  }
  if (policy.minAppendSize !== undefined && policy.maxAppendSize !== undefined
    && policy.minAppendSize > policy.maxAppendSize) {
    throw new TypeError(`createUploadOrchestrator: policy.minAppendSize (${policy.minAppendSize}) exceeds maxAppendSize (${policy.maxAppendSize})`);
  }
}
