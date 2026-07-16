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
 *
 * Dialects (tus 1.0, IETF draft) translate requests into intents, call one
 * orchestrator method, and translate the returned OUTCOME into statuses and
 * headers. Outcomes are wire-agnostic, like the engine's verdicts they wrap.
 */

import {
  evaluateUploadCreation,
  evaluateUploadIntent,
  remainingLifetimeSeconds,
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
import { memoryUploadLocker, isUploadLockTimeoutError, type UploadLocker } from "./upload-locker.ts";

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
export type UploadRejectOutcome = Extract<
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
    }
  | {
      kind: "probed";
      offset: number;
      length?: number;
      complete: boolean;
      remainingLifetimeSeconds?: number;
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
  complete: boolean;
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
  const policy: UploadPolicy = { ...opts.policy };
  if (store.maxAppendSize !== undefined) {
    policy.maxAppendSize = policy.maxAppendSize === undefined
      ? store.maxAppendSize
      : Math.min(policy.maxAppendSize, store.maxAppendSize);
  }
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

  function mapStoreError(err: unknown, uploadToken: string | undefined, operation: string): UploadOutcome {
    if (isUploadNotFoundError(err)) return { kind: "not-found" };
    if (isUploadDigestMismatchError(err)) return { kind: "digest-mismatch" };
    onError?.(err, { uploadToken, operation });
    return { kind: "store-error", error: err };
  }

  /**
   * Narrow an engine verdict to the reject outcomes dialects render. The
   * action verdicts are all handled before this runs, and the concurrency
   * verdicts never occur here at all: the LOCKER owns contention (the engine
   * is evaluated with no `hasInFlight`), so `contended` only ever enters via
   * a lock timeout and `preempt-then-retry` never does.
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

  /** Run `fn` holding the resource lock, translating lock timeouts to contention. */
  async function withLock(
    uploadToken: string,
    preemptable: { abort?: AbortController },
    fn: () => Promise<UploadOutcome>,
  ): Promise<UploadOutcome> {
    let lock;
    try {
      lock = await locker.acquire(uploadToken, () => preemptable.abort?.abort(new Error("preempted")));
    } catch (err) {
      if (isUploadLockTimeoutError(err)) return { kind: "contended", events: [] };
      throw err;
    }
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  async function streamAppend(
    uploadToken: string,
    atOffset: number,
    body: ReadableStream<Uint8Array> | Uint8Array,
    maxBytes: number | undefined,
    signal: AbortSignal | undefined,
    preemptable: { abort?: AbortController },
  ): Promise<{ bytesWritten: number; interrupted: boolean }> {
    const cleanups: Array<() => void> = [];
    // The preemption controller chains the (grace-extended) request signal:
    // a preempt aborts the write at the next chunk boundary; a client abort
    // aborts it after the grace window.
    const ctl = new AbortController();
    preemptable.abort = ctl;
    const graced = graceSignal(signal, cleanups);
    const onGraced = () => ctl.abort(graced?.reason);
    if (graced) {
      if (graced.aborted) onGraced();
      else {
        graced.addEventListener("abort", onGraced, { once: true });
        cleanups.push(() => graced.removeEventListener("abort", onGraced));
      }
    }
    try {
      const { bytesWritten } = await store.appendChunk(uploadToken, atOffset, body, {
        maxBytes,
        now: now(),
        signal: ctl.signal,
      });
      return { bytesWritten, interrupted: false };
    } catch (err) {
      // An aborted/preempted/torn body is an INTERRUPTION, not a protocol
      // error: the spec's model is "append as much as possible". The store
      // reports durable bytes via fresh state; anything else rethrows to the
      // caller's error mapping.
      if (ctl.signal.aborted) return { bytesWritten: 0, interrupted: true };
      throw err;
    } finally {
      preemptable.abort = undefined;
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
      if (req.expectedDigest !== undefined && store.digestOnComplete !== "sha256") {
        return { kind: "digest-mismatch" };
      }

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

      let offset = 0;
      let interrupted = false;
      if (req.body !== undefined) {
        const preemptable: { abort?: AbortController } = {};
        try {
          const written = await streamAppend(
            uploadToken, 0, req.body, verdict.maxBytes, req.signal, preemptable,
          );
          interrupted = written.interrupted;
          // Durable truth, not the writer's count: re-derive.
          const fresh = await store.getUploadState(uploadToken, { signal: req.signal });
          offset = fresh.offset;
        } catch (err) {
          return mapStoreError(err, uploadToken, "append");
        }
      }

      let digest: string | undefined;
      let etag: string | undefined;
      let complete = false;
      const declaredLength = verdict.declaredLength;
      if (verdict.completes && !interrupted && (declaredLength === undefined || offset === declaredLength)) {
        try {
          ({ digest, etag } = await store.completeUpload(uploadToken, {
            expectedDigest: req.expectedDigest,
            now: now(),
            signal: req.signal,
          }));
          complete = true;
          emit(uploadToken, req.auditKey, [{ kind: "completed", length: offset }]);
        } catch (err) {
          return mapStoreError(err, uploadToken, "complete");
        }
      }
      return { kind: "created", uploadToken, offset, length: declaredLength, complete, digest, etag, interrupted };
    },

    async probe(uploadToken, probeOpts): Promise<UploadOutcome> {
      const preemptable: { abort?: AbortController } = {};
      return withLock(uploadToken, preemptable, async () => {
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
        };
      });
    },

    async append(uploadToken, req): Promise<UploadOutcome> {
      if (req.expectedDigest !== undefined && store.digestOnComplete !== "sha256") {
        return { kind: "digest-mismatch" };
      }
      const preemptable: { abort?: AbortController } = {};
      return withLock(uploadToken, preemptable, async () => {
        let state: StoredUploadState;
        try {
          state = await store.getUploadState(uploadToken, { signal: req.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head");
        }
        const intent: AppendIntent = {
          kind: "append",
          offset: req.offset,
          contentLength: req.contentLength,
          complete: req.complete,
          declaredLength: req.declaredLength,
        };
        const verdict = evaluateUploadIntent(intent, toStateShape(state), policy, { now: now() });
        emit(uploadToken, req.auditKey, verdict.events);

        if (verdict.kind === "complete-now") {
          try {
            const done = await store.completeUpload(uploadToken, {
              expectedDigest: req.expectedDigest,
              now: now(),
              signal: req.signal,
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

        let interrupted = false;
        if (req.body !== undefined) {
          try {
            const written = await streamAppend(
              uploadToken, verdict.atOffset, req.body, verdict.maxBytes, req.signal, preemptable,
            );
            interrupted = written.interrupted;
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
        let fresh: StoredUploadState;
        try {
          fresh = await store.getUploadState(uploadToken, { signal: req.signal });
        } catch (err) {
          return mapStoreError(err, uploadToken, "head");
        }

        const length = fresh.length ?? req.declaredLength;
        let digest: string | undefined;
        let etag: string | undefined;
        let complete = false;
        const shouldComplete = verdict.completes && !interrupted
          && (req.contentLength === undefined || fresh.offset === verdict.atOffset + req.contentLength)
          && (length === undefined || fresh.offset === length);
        if (shouldComplete) {
          try {
            ({ digest, etag } = await store.completeUpload(uploadToken, {
              expectedDigest: req.expectedDigest,
              now: now(),
              signal: req.signal,
            }));
            complete = true;
            emit(uploadToken, req.auditKey, [{ kind: "completed", length: fresh.offset }]);
          } catch (err) {
            return mapStoreError(err, uploadToken, "complete");
          }
        }
        return {
          kind: "appended", offset: fresh.offset, length,
          complete, digest, etag, interrupted,
        };
      });
    },

    async cancel(uploadToken, cancelOpts): Promise<UploadOutcome> {
      const preemptable: { abort?: AbortController } = {};
      return withLock(uploadToken, preemptable, async () => {
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

export { remainingLifetimeSeconds };
