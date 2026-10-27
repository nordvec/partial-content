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
 * - **Hold**: `SET key <hold-id> NX PX <ttl>`. The value is a per-acquire
 *   random id so release and renewal only ever act on the holder's own lock
 *   (compare-and-delete / compare-and-expire via Lua). It is deliberately NOT
 *   called a fencing token: it fences this locker's own release and renewal
 *   against a stale holder, and never reaches a store write, so it cannot
 *   fence the thing a fencing token exists to fence.
 * - **Names**: the server never sees an upload token. The key is the prefix
 *   plus the token's SHA-256 in hex, and a preempt request is that digest
 *   published on the locker's one channel (`<prefix>preempt`), which a single
 *   subscription per locker routes to the holder in process.
 * - **Preempt**: a waiter publishes a preempt request on that channel and
 *   RE-publishes it every poll round. The holder's subscription
 *   fires `onPreemptRequested`, the holder aborts at its next safe boundary
 *   and releases, and the waiter's next poll takes the lock. Re-publishing
 *   makes preemption level-triggered: a request that lands in the gap
 *   between a holder's SET and its subscribe is re-delivered within one poll
 *   interval instead of lost.
 * - **Crash recovery**: the TTL reaps a dead holder's lock. A LIVE holder
 *   renews at ttl/3 via a watchdog; a renewal that fails (connection loss,
 *   TTL already expired, lock taken by someone else) or that has not answered
 *   by the time the next one is due fires `onPreemptRequested` so the holder
 *   stops writing, because it can no longer prove it holds the lock.
 * - **Bounded by the clock, not by the server's cooperation**: every round
 *   trip an acquire makes is bounded by that acquire's remaining timeout, and
 *   every renewal by the renew interval. A server that accepts a command and
 *   never answers therefore costs a caller its timeout and no more, and the
 *   one command with a lasting effect (the SET) is followed by a
 *   compare-and-delete whenever it is abandoned, so a late arrival cannot
 *   hold the resource.
 *
 * Honesty about fencing: expiry-based locks can be STOLEN from a holder that
 * stalls longer than its TTL and then resumes. The write store takes no
 * fencing token, so the protection against such a zombie is the same one the
 * engine has in-process: every append is validated against fresh durable state
 * under the new holder's lock, and every conformant store re-derives durable
 * state and refuses a disagreeing claim before it writes (a stale append
 * answers `UploadOffsetConflictError`, loudly, instead of corrupting). That
 * check is a MUST in the store contract precisely because this locker exists,
 * and the orchestrator refuses a store that reports it cannot do it.
 *
 * What that does NOT cover, stated plainly rather than left to be discovered:
 * the check runs once per append call, so it catches a zombie's NEXT append,
 * not the one it was already mid-way through when it stalled. The backends
 * accept their writes unconditionally, so the last defense there is
 * cooperative: the watchdog fires `onPreemptRequested`, the lock's signal
 * aborts, and the store's per-chunk signal test stops it pulling more body.
 * The ceiling is therefore the bytes of one already-accepted chunk, not one
 * backend call, as the orchestrator's sequencing invariants describe. The
 * watchdog and preemption keep the stolen-lock window small; the state
 * validation is what keeps a returning zombie from silently continuing.
 *
 * @packageDocumentation
 */

import {
    UploadLockTimeoutError,
    UPLOAD_LEASE_LOST,
    UPLOAD_PREEMPTED,
    type UploadLock,
    type UploadLocker,
} from "./upload-locker.ts";

/**
 * The four commands the locker needs, shaped after node-redis v4/v5. Any
 * Redis-protocol client adapts in a few lines; `subscribe` must deliver
 * messages for ONE channel to the given listener and resolve to an
 * unsubscribe function (dedicated subscriber connections, as real clients
 * require, are the adapter's concern). The locker keeps at most one
 * subscription open, shared by every hold it has, and closes it when its last
 * hold is released, so a subscriber connection per `subscribe` call costs one
 * connection per busy locker, not one per lock.
 *
 * Commands issued through this client MUST reach the server in issue order.
 * A single connection gives that for free, which is what node-redis and
 * ioredis provide; an adapter over a round-robin POOL, or one that replays
 * buffered commands after a reconnect, does not and must not be used here.
 * The safety argument for an abandoned acquire rests on it: a SET whose reply
 * never arrived is followed by a compare-and-delete, so the lock cannot
 * outlive the attempt. Execute those two out of order and the delete finds
 * nothing, the SET then lands, and the resource is held by nobody for a full
 * TTL while every waiter times out into contention.
 */
export interface RedisLockerClient {
    /** `SET key value NX PX ttl`: resolves "OK" when taken, null when held. */
    set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
    /**
     * The Redis `EVAL` command (server-side Lua), NOT JavaScript `eval`: the
     * locker only ever passes the two static compare-and-delete /
     * compare-and-expire scripts defined in this module, never caller input.
     *
     * Both scripts return a Lua number, so an adapter must resolve to the
     * NUMBER the server sent: `1` when the hold was ours, `0` when it was not.
     * A client that stringifies integer replies has to convert here, or every
     * renewal reads as a lost hold and preempts its own holder.
     */
    eval(script: string, keys: readonly string[], args: readonly string[]): Promise<number>;
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
    /**
     * Default acquire timeout (per-call `AcquireOptions.timeoutMs` wins). It
     * bounds the whole acquire, every round trip to the server included, so a
     * server that stops answering surfaces as retryable contention within this
     * budget rather than as an indefinite hang.
     * @default 15000
     */
    acquireTimeoutMs?: number;
    /** Base poll interval while waiting, jittered per round. @default 50 */
    pollIntervalMs?: number;
    /**
     * Namespace for the lock keys (`<prefix><sha-256 hex>`) and the preempt
     * channel (`<prefix>preempt`). @default "partial-content:lock:"
     */
    keyPrefix?: string;
    /**
     * Observability for failures the locker absorbs (failed renewal, failed
     * release DEL, failed unsubscribe). Must not throw.
     *
     * Exactly one of `uploadToken` and `auditKey` is present. When the acquire
     * supplied an {@link AcquireOptions.auditKey} the key SUBSTITUTES for the
     * token here rather than accompanying it: the token is the capability, and
     * a caller that went to the trouble of naming a safe identifier for its log
     * records gains nothing from receiving the credential beside a stack trace.
     */
    onError?: (error: unknown, context: { uploadToken?: string; auditKey?: string; operation: string }) => void;
}

/**
 * The largest delay a timer accepts. A larger one overflows and fires at once,
 * so an unclamped delay would turn the most generous acquire budget a caller
 * can express into an instant timeout. 24.8 days is indistinguishable from
 * unbounded for a lock acquire, which makes clamping the honest reading of a
 * caller asking to wait effectively forever.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Delete the lock only when it is still ours. */
const RELEASE_SCRIPT =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
/** Extend the lock only when it is still ours; 0 = we no longer hold it. */
const RENEW_SCRIPT =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';

/**
 * Create an {@link UploadLocker} over a Redis-protocol server, for
 * deployments where more than one process serves the same upload resources.
 */
export function redisUploadLocker(client: RedisLockerClient, opts: RedisUploadLockerOptions = {}): UploadLocker {
    const ttlMs = opts.ttlMs ?? 30_000;
    const defaultAcquireTimeoutMs = opts.acquireTimeoutMs ?? 15_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 50;
    const keyPrefix = opts.keyPrefix ?? "partial-content:lock:";
    const onError = opts.onError;

    /** How one acquire names its resource on every sink this locker writes to. */
    interface LockIdent {
        uploadToken: string;
        auditKey?: string;
    }

    /** Report an absorbed failure, naming the resource the safe way. */
    const report = (err: unknown, ident: LockIdent, operation: string): void => {
        onError?.(
            err,
            ident.auditKey === undefined
                ? { uploadToken: ident.uploadToken, operation }
                : { auditKey: ident.auditKey, operation },
        );
    };

    for (const [name, value] of [
        ["ttlMs", ttlMs],
        ["acquireTimeoutMs", defaultAcquireTimeoutMs],
        ["pollIntervalMs", pollIntervalMs],
    ] as const) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new TypeError(`redisUploadLocker: ${name} must be a positive safe integer, got ${value}`);
        }
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // The server never sees the upload token, which is the capability: keys and
    // preempt messages name its SHA-256, and every preempt request travels on
    // ONE channel per locker, so a single subscription serves every hold this
    // instance has open instead of costing a subscriber connection per lock.
    const channel = `${keyPrefix}preempt`;
    // One holder per digest: a second acquire of the same resource on this
    // locker waits for the first release, which leaves synchronously.
    const holders = new Map<string, () => void>();
    let shared: Promise<() => void | Promise<void>> | undefined;

    /** Join the shared subscription, opening it when no hold has it open. */
    function joinPreempts(digest: string, preempt: () => void): Promise<unknown> {
        holders.set(digest, preempt);
        if (!shared) {
            const opening = client.subscribe(channel, (message) => holders.get(message)?.());
            shared = opening;
            opening.catch(() => {
                if (shared === opening) shared = undefined;
            });
        }
        return shared;
    }

    /**
     * Leave the shared subscription; the last hold out closes it. A
     * subscription still opening is closed when it lands, so an abandoned
     * SUBSCRIBE cannot leave a listener behind.
     */
    async function leavePreempts(digest: string, preempt: () => void): Promise<void> {
        if (holders.get(digest) === preempt) holders.delete(digest);
        if (holders.size > 0 || !shared) return;
        const closing = shared;
        shared = undefined;
        const unsubscribe = await closing.catch(() => undefined);
        await unsubscribe?.();
    }

    /**
     * Bound one client round trip. A server that accepts a command and never
     * answers (a partitioned socket, a client queueing through a reconnect) must
     * not park the caller past the budget it was given: `acquireTimeoutMs` is a
     * promise to the caller, not merely a cap on how long this locker polls.
     *
     * The protocol has no client-side cancellation, so an abandoned command may
     * still execute. Only the SET has a lasting effect, and its caller pairs
     * abandonment with the compare-and-delete that makes a late arrival
     * harmless; a preempt PUBLISH that lands late is re-published by the next
     * round anyway, and a SUBSCRIBE that lands late is unsubscribed by the
     * caller that abandoned it.
     */
    async function withinTimeout<T>(op: () => Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
        if (timeoutMs <= 0) throw timeoutError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // race() attaches a handler to `op()`, so a rejection arriving after the
            // timer won is absorbed rather than surfacing as an unhandled rejection.
            return await Promise.race([
                op(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(timeoutError()), Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Let go of the key an acquire took, without waiting for the answer. The
     * compare-and-delete only ever removes OUR hold id, so this is safe on
     * every path that abandons a hold, including one that cannot know whether
     * the SET landed at all. A failed or undeliverable DEL is absorbed: the TTL
     * reaps the key, costing waiters at most the remaining TTL, never a stuck
     * resource. Fire-and-forget by design, so no cleanup can itself hang.
     */
    function releaseKey(ident: LockIdent, key: string, holdId: string): void {
        void Promise.resolve()
            .then(() => client.eval(RELEASE_SCRIPT, [key], [holdId]))
            .catch((err) => report(err, ident, "release"));
    }

    async function takeLock(
        ident: LockIdent,
        digest: string,
        key: string,
        holdId: string,
        deadline: number,
    ): Promise<UploadLock> {
        const { uploadToken } = ident;
        let released = false;
        // The lock's preemption signal: aborted when a waiter asks the holder to
        // yield, or when the watchdog can no longer prove the hold. `abort()` is
        // idempotent and latches, so no separate "preempted" flag is needed.
        const controller = new AbortController();
        const preempt = () => {
            if (!released && !controller.signal.aborted) controller.abort(UPLOAD_PREEMPTED);
        };
        // The lease: aborted only when the watchdog cannot prove the hold, so a
        // holder can tell "asked to yield" (it still owns the resource) from
        // "may no longer own it" (it must not start another write).
        const lease = new AbortController();
        const loseLease = () => {
            if (released) return;
            if (!lease.signal.aborted) lease.abort(UPLOAD_LEASE_LOST);
            if (!controller.signal.aborted) controller.abort(UPLOAD_LEASE_LOST);
        };

        // Subscribed AFTER the SET: a preempt published into that gap is
        // re-published by the waiter every poll round, so it is delayed by at
        // most one interval, never lost.
        //
        // If subscribe fails or does not answer within what is left of the acquire
        // budget (the subscriber connection is down, typically during a failover,
        // exactly when the system is fragile) the key is already held with no
        // release closure and no watchdog yet, so it would dead-lock the resource
        // for the full TTL and every waiter would time out into contention.
        // Release the key we just took, then surface the failure.
        const pending = joinPreempts(digest, preempt);
        try {
            await withinTimeout(
                () => pending,
                deadline - Date.now(),
                () => new UploadLockTimeoutError(uploadToken),
            );
        } catch (err) {
            leavePreempts(digest, preempt).catch(() => undefined);
            releaseKey(ident, key, holdId);
            throw err;
        }

        // Watchdog: renew at ttl/3. A renewal that does not positively confirm the
        // hold means the lock may belong to someone else; the only safe move is to
        // stop writing, which is exactly what preemption means. Silence is not
        // confirmation, so a renewal that has not answered by the time the next one
        // is due counts as a failure to confirm: without that bound a server that
        // accepts renewals and never answers lets a holder write straight through
        // its own TTL believing the hold is good.
        const renewIntervalMs = Math.max(1, Math.floor(ttlMs / 3));
        const watchdog = setInterval(() => {
            withinTimeout(
                () => client.eval(RENEW_SCRIPT, [key], [holdId, String(ttlMs)]),
                renewIntervalMs,
                () => new Error("Upload lock renewal did not answer within the renew interval"),
            )
                .then((renewed) => {
                    if (renewed !== 1 && !released) {
                        loseLease();
                        report(new Error("Upload lock renewal found the lock no longer held"), ident, "renew");
                    }
                })
                .catch((err) => {
                    if (released) return;
                    loseLease();
                    report(err, ident, "renew");
                });
        }, renewIntervalMs);

        return {
            signal: controller.signal,
            lease: lease.signal,
            release(): void {
                if (released) return;
                released = true;
                clearInterval(watchdog);
                leavePreempts(digest, preempt).catch((err) => report(err, ident, "unsubscribe"));
                releaseKey(ident, key, holdId);
            },
        };
    }

    return {
        async acquire(uploadToken, acquireOpts): Promise<UploadLock> {
            const timeoutMs = acquireOpts?.timeoutMs ?? defaultAcquireTimeoutMs;
            const ident: LockIdent = {
                uploadToken,
                ...(acquireOpts?.auditKey === undefined ? {} : { auditKey: acquireOpts.auditKey }),
            };
            const digest = Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uploadToken))),
                (b) => b.toString(16).padStart(2, "0"),
            ).join("");
            const key = keyPrefix + digest;
            const holdId = crypto.randomUUID();
            const deadline = Date.now() + timeoutMs;

            for (;;) {
                // Checked before the SET as well as after it: a round trip issued with
                // no time left to answer can only be abandoned, and abandoning a SET
                // costs a speculative release.
                if (Date.now() >= deadline) throw new UploadLockTimeoutError(uploadToken);
                let taken: string | null;
                try {
                    taken = await withinTimeout(
                        () => client.set(key, holdId, { NX: true, PX: ttlMs }),
                        deadline - Date.now(),
                        () => new UploadLockTimeoutError(uploadToken),
                    );
                } catch (err) {
                    // A SET that was issued may have taken the key even though its answer
                    // never arrived, and nothing else knows this hold id, so the only
                    // moment it can be freed is here. The compare-and-delete is a no-op
                    // when the SET never landed.
                    releaseKey(ident, key, holdId);
                    throw err;
                }
                if (taken !== null) {
                    return takeLock(ident, digest, key, holdId, deadline);
                }
                if (Date.now() >= deadline) throw new UploadLockTimeoutError(uploadToken);
                // Ask the holder to yield, EVERY round: repetition is what makes the
                // preempt level-triggered across subscribe gaps and dropped messages.
                await withinTimeout(
                    () => client.publish(channel, digest),
                    deadline - Date.now(),
                    () => new UploadLockTimeoutError(uploadToken),
                ).catch((err) => {
                    report(err, ident, "preempt-publish");
                });
                // Jitter breaks convoy effects when several waiters poll one
                // resource. Drawn from Web Crypto, present in every runtime this
                // package supports, so no draw in the package is guessable.
                const spread = crypto.getRandomValues(new Uint32Array(1))[0]! % Math.max(pollIntervalMs, 1);
                const wait = Math.min(pollIntervalMs + spread, deadline - Date.now());
                if (wait > 0) await sleep(wait);
            }
        },
    };
}

// ─── Shared locking surface (re-exported for consumers) ─────────────────────
export {
    UploadLockTimeoutError,
    isUploadLockTimeoutError,
    memoryUploadLocker,
    UPLOAD_PREEMPTED,
    UPLOAD_LEASE_LOST,
} from "./upload-locker.ts";
export type { UploadLock, UploadLocker, AcquireOptions } from "./upload-locker.ts";
