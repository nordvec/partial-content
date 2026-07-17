/**
 * Distributed upload locker over Redis-protocol servers (Redis, Valkey,
 * KeyDB, Dragonfly): the multi-instance counterpart to the in-process
 * `memoryUploadLocker`, with the same cooperative-preemption semantics.
 *
 * Zero dependencies, like everything here: the caller passes a client
 * behind the four-command {@link RedisLockerClient} interface instead of the
 * package importing one. Adapting node-redis, ioredis, or Bun's built-in
 * client is a few lines each (see the docs' locking section).
 *
 * How it locks:
 * - **Hold**: `SET key <fencing-id> NX PX <ttl>`. The value is a per-acquire
 *   random id so release and renewal only ever act on the holder's own lock
 *   (compare-and-delete / compare-and-expire via Lua).
 * - **Preempt**: a waiter publishes a preempt request on the resource's
 *   channel and RE-publishes it every poll round. The holder's subscription
 *   fires `onPreemptRequested`, the holder aborts at its next safe boundary
 *   and releases, and the waiter's next poll takes the lock. Re-publishing
 *   makes preemption level-triggered: a request that lands in the gap
 *   between a holder's SET and its subscribe is re-delivered within one poll
 *   interval instead of lost.
 * - **Crash recovery**: the TTL reaps a dead holder's lock. A LIVE holder
 *   renews at ttl/3 via a watchdog; a renewal that fails (connection loss,
 *   TTL already expired, lock taken by someone else) fires
 *   `onPreemptRequested` so the holder stops writing, because it can no
 *   longer prove it holds the lock.
 *
 * Honesty about fencing: expiry-based locks can be STOLEN from a holder that
 * stalls longer than its TTL and then resumes. The write store takes no
 * fencing token, so the engine's protection against such a zombie's late
 * append is the same one it has in-process: every append is validated
 * against fresh durable state under the new holder's lock, and the built-in
 * stores re-check the claimed offset at write time (a stale write answers
 * `UploadOffsetConflictError`, loudly, instead of corrupting). The watchdog
 * and preemption keep the stolen-lock window small; the state validation is
 * what makes it non-corrupting.
 *
 * @packageDocumentation
 */

import { UploadLockTimeoutError, UPLOAD_PREEMPTED, type UploadLock, type UploadLocker } from "./upload-locker.ts";

/**
 * The four commands the locker needs, shaped after node-redis v4/v5. Any
 * Redis-protocol client adapts in a few lines; `subscribe` must deliver
 * messages for ONE channel to the given listener and resolve to an
 * unsubscribe function (dedicated subscriber connections, as real clients
 * require, are the adapter's concern).
 */
export interface RedisLockerClient {
  /** `SET key value NX PX ttl`: resolves "OK" when taken, null when held. */
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  /**
   * The Redis `EVAL` command (server-side Lua), NOT JavaScript `eval`: the
   * locker only ever passes the two static compare-and-delete /
   * compare-and-expire scripts defined in this module, never caller input.
   */
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  /** `PUBLISH channel message`. */
  publish(channel: string, message: string): Promise<unknown>;
  /** Subscribe one channel; resolves to the unsubscribe function. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void | Promise<void>>;
}

export interface RedisUploadLockerOptions {
  /**
   * Lock TTL in ms: the crash-recovery bound. A dead holder blocks the
   * resource for at most this long; a live one renews at ttl/3.
   * @default 30000
   */
  ttlMs?: number;
  /** Default acquire timeout (per-call `AcquireOptions.timeoutMs` wins). @default 15000 */
  acquireTimeoutMs?: number;
  /** Base poll interval while waiting, jittered per round. @default 50 */
  pollIntervalMs?: number;
  /** Key and channel namespace. @default "partial-content:lock:" */
  keyPrefix?: string;
  /**
   * Observability for failures the locker absorbs (failed renewal, failed
   * release DEL, failed unsubscribe). Must not throw.
   */
  onError?: (error: unknown, context: { uploadToken: string; operation: string }) => void;
}

/** Delete the lock only when it is still ours. */
const RELEASE_SCRIPT
  = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
/** Extend the lock only when it is still ours; 0 = we no longer hold it. */
const RENEW_SCRIPT
  = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';

/**
 * Create an {@link UploadLocker} over a Redis-protocol server, for
 * deployments where more than one process serves the same upload resources.
 */
export function redisUploadLocker(
  client: RedisLockerClient,
  opts: RedisUploadLockerOptions = {},
): UploadLocker {
  const ttlMs = opts.ttlMs ?? 30_000;
  const defaultAcquireTimeoutMs = opts.acquireTimeoutMs ?? 15_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const keyPrefix = opts.keyPrefix ?? "partial-content:lock:";
  const onError = opts.onError;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0
    || !Number.isSafeInteger(defaultAcquireTimeoutMs) || defaultAcquireTimeoutMs <= 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError("redisUploadLocker: ttlMs, acquireTimeoutMs, and pollIntervalMs must be positive integers");
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function takeLock(
    uploadToken: string,
    key: string,
    fencingId: string,
  ): Promise<UploadLock> {
    const channel = `${keyPrefix}preempt:${uploadToken}`;
    let released = false;
    // The lock's preemption signal: aborted when a waiter asks the holder to
    // yield, or when the watchdog can no longer prove the hold. `abort()` is
    // idempotent and latches, so no separate "preempted" flag is needed.
    const controller = new AbortController();
    const preempt = () => {
      if (!released && !controller.signal.aborted) controller.abort(UPLOAD_PREEMPTED);
    };

    // Subscribed AFTER the SET: a preempt published into that gap is
    // re-published by the waiter every poll round, so it is delayed by at
    // most one interval, never lost.
    const unsubscribe = await client.subscribe(channel, preempt);

    // Watchdog: renew at ttl/3. A renewal that does not positively confirm
    // the hold means the lock may belong to someone else; the only safe
    // move is to stop writing, which is exactly what preemption means.
    const watchdog = setInterval(() => {
      client.eval(RENEW_SCRIPT, [key], [fencingId, String(ttlMs)])
        .then((renewed) => {
          if (renewed !== 1 && !released) {
            preempt();
            onError?.(new Error("Upload lock renewal found the lock no longer held"),
              { uploadToken, operation: "renew" });
          }
        })
        .catch((err) => {
          preempt();
          onError?.(err, { uploadToken, operation: "renew" });
        });
    }, Math.max(1, Math.floor(ttlMs / 3)));

    return {
      signal: controller.signal,
      release(): void {
        if (released) return;
        released = true;
        clearInterval(watchdog);
        void Promise.resolve()
          .then(() => unsubscribe())
          .catch((err) => onError?.(err, { uploadToken, operation: "unsubscribe" }));
        // A failed DEL is absorbed: the TTL reaps the lock, costing waiters
        // at most the remaining TTL, never a stuck resource.
        client.eval(RELEASE_SCRIPT, [key], [fencingId])
          .catch((err) => onError?.(err, { uploadToken, operation: "release" }));
      },
    };
  }

  return {
    async acquire(uploadToken, acquireOpts): Promise<UploadLock> {
      const timeoutMs = acquireOpts?.timeoutMs ?? defaultAcquireTimeoutMs;
      const key = keyPrefix + uploadToken;
      const channel = `${keyPrefix}preempt:${uploadToken}`;
      const fencingId = crypto.randomUUID();
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const taken = await client.set(key, fencingId, { NX: true, PX: ttlMs });
        if (taken !== null) {
          return takeLock(uploadToken, key, fencingId);
        }
        if (Date.now() >= deadline) throw new UploadLockTimeoutError(uploadToken);
        // Ask the holder to yield, EVERY round: repetition is what makes the
        // preempt level-triggered across subscribe gaps and dropped messages.
        await client.publish(channel, "preempt").catch((err) => {
          onError?.(err, { uploadToken, operation: "preempt-publish" });
        });
        // Jitter breaks convoy effects when several waiters poll one resource.
        const wait = Math.min(pollIntervalMs + Math.floor(Math.random() * pollIntervalMs), deadline - Date.now());
        if (wait > 0) await sleep(wait);
      }
    },
  };
}

// ─── Shared locking surface (re-exported for consumers) ─────────────────────
export { UploadLockTimeoutError, isUploadLockTimeoutError, memoryUploadLocker, UPLOAD_PREEMPTED } from "./upload-locker.ts";
export type { UploadLock, UploadLocker, AcquireOptions } from "./upload-locker.ts";
