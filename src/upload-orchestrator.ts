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
 *    land one write after a later acquirer believes it holds the lock. The
 *    stores bound the damage by re-checking the claimed offset at write time
 *    (`UploadOffsetConflictError`), so a stale write is refused, not merged.
 *    // descope: no lock-independent fencing token on completion; the at-write
 *    // offset check is the guard. Revisit if a store ever needs stronger
 *    // isolation than optimistic offset-CAS under the lock.
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
  type ResumableWriteStore,
  type StoredUploadState,
} from "./upload-store.ts";
import { memoryUploadLocker, isUploadLockTimeoutError, type UploadLocker, type UploadLock } from "./upload-locker.ts";

// ─── Options ────────────────────────────────────────────────────────────────

export interface UploadResourceEvent {
  /** The upload token the event concerns (absent for creation rejections). */
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
  /** Must not throw (there is no sink for a failing error sink). */
  onError?: (error: unknown, context: { uploadToken?: string; operation: string }) => void;
  /**
   * Post-abort flush window in milliseconds: how long store writes may keep
   * running after the client vanished, so received bytes become durable and
   * the next probe answers truthfully. `0` disables the window.
   * @default 10000
   */
  graceMs?: number;
  /** Clock injection (tests). @default Date.now */
  now?: () => number;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

/** Reject verdicts pass through to the dialect unchanged. */
type UploadRejectOutcome = Extract<
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
  probe(uploadToken: string, opts?: { auditKey?: string; signal?: AbortSignal }): Promise<UploadOutcome>;
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
  const onError = opts.onError;
  const emit = opts.onUploadEvent
    ? (uploadToken: string | undefined, auditKey: string | undefined, events: UploadAuditEvent[]): void => {
        for (const event of events) {
          try {
            opts.onUploadEvent!({ uploadToken, auditKey, event });
          } catch (err) {
            onError?.(err, { uploadToken, operation: "audit" });
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

  function mapStoreError(err: unknown, uploadToken: string | undefined, operation: string): UploadOutcome {
    if (isUploadNotFoundError(err)) return { kind: "not-found" };
    if (isUploadDigestMismatchError(err)) return { kind: "digest-mismatch" };
    onError?.(err, { uploadToken, operation });
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
    fn: (lock: UploadLock) => Promise<UploadOutcome>,
  ): Promise<UploadOutcome> {
    let lock: UploadLock;
    try {
      lock = await locker.acquire(uploadToken);
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
          now: now(),
          signal: req.signal,
        }));
      } catch (err) {
        return mapStoreError(err, undefined, "create");
      }
      emit(uploadToken, req.auditKey, verdict.events);

      const declaredLength = verdict.declaredLength;
      // Lock the token before streaming so a client that received an early
      // location (a 104 via onResumptionSupported) and resumes cannot race
      // this creation's still-flushing write with no preemption. Invariant 1.
      return withLock(uploadToken, async (lock) => {
        let offset = 0;
        let interrupted = false;
        if (req.body !== undefined) {
          try {
            const written = await streamAppend(
              uploadToken, 0, req.body, verdict.maxBytes, undefined, req.signal, lock.signal,
            );
            interrupted = written.interrupted;
            // Clean stream: the store contract pins the durable offset to the
            // write's own return. An interruption re-reads for the flushed prefix.
            offset = written.bytesWritten;
            if (interrupted) {
              const fresh = await store.getUploadState(uploadToken, { signal: req.signal });
              offset = fresh.offset;
            }
          } catch (err) {
            return mapStoreError(err, uploadToken, "append");
          }
        }

        let digest: string | undefined;
        let etag: string | undefined;
        let complete = false;
        if (verdict.completes && !interrupted && (declaredLength === undefined || offset === declaredLength)) {
          if (belowMinSize(offset)) {
            emit(uploadToken, req.auditKey, [{ kind: "append-rejected", reason: "below-min-size" }]);
            return { kind: "limit-violation", reason: "below-min-size", events: [] };
          }
          try {
            ({ digest, etag } = await store.completeUpload(uploadToken, {
              expectedDigest, now: now(), signal: req.signal,
            }));
            complete = true;
            emit(uploadToken, req.auditKey, [{ kind: "completed", length: offset }]);
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete");
          }
        }
        return { kind: "created", uploadToken, offset, length: declaredLength, complete, digest, etag, interrupted };
      });
    },

    async probe(uploadToken, probeOpts): Promise<UploadOutcome> {
      return withLock(uploadToken, async () => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: probeOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head");
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
        };
      });
    },

    async append(uploadToken, req): Promise<UploadOutcome> {
      // RFC 9530: ignore an unverifiable client digest rather than refusing
      // (see create). Verifying stores still enforce it at completion.
      const expectedDigest = store.digestOnComplete === "sha256" ? req.expectedDigest : undefined;
      return withLock(uploadToken, async (lock) => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: req.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head");
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
            return {
              kind: "appended", offset: verdict.length, length: verdict.length,
              complete: true, digest: done.digest, etag: done.etag, interrupted: false,
            };
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete");
          }
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
              verdict.declaredLength, req.signal, lock.signal,
            );
            interrupted = written.interrupted;
            bytesWritten = written.bytesWritten;
          } catch (err) {
            if (isUploadOffsetConflictError(err)) {
              return {
                kind: "offset-mismatch",
                claimedOffset: req.offset,
                correctOffset: err.durableOffset,
                complete: false,
                events: [],
              };
            }
            return mapStoreError(err, uploadToken, "append");
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
            const fresh = await store.getUploadState(uploadToken, { signal: req.signal });
            durableOffset = fresh.offset;
            length = fresh.length ?? req.declaredLength;
            createdAt = fresh.createdAt;
          } catch (err) {
            return mapStoreError(err, uploadToken, "head");
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
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete");
          }
        }
        return {
          kind: "appended", offset: durableOffset, length,
          complete: publishedComplete, digest, etag, interrupted, expiresAt: expiryOf(createdAt),
        };
      });
    },

    async cancel(uploadToken, cancelOpts): Promise<UploadOutcome> {
      return withLock(uploadToken, async () => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: cancelOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head");
        }
        const verdict = evaluateUploadIntent({ kind: "cancel" }, toStateShape(state), policy, { now: now() });
        emit(uploadToken, cancelOpts?.auditKey, verdict.events);
        if (verdict.kind !== "cancel-accepted") return rejectOutcome(verdict);
        try {
          await store.abortUpload(uploadToken, { signal: cancelOpts?.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "abort");
        }
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
