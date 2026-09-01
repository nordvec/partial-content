import { describe, test, expect } from "bun:test";
import { redisUploadLocker, type RedisLockerClient } from "../redis-locker";
import { UploadLockTimeoutError, isUploadLockTimeoutError, UPLOAD_PREEMPTED } from "../upload-locker";

/**
 * In-memory Redis-protocol fake: SET NX PX with TTLs, the two Lua scripts the
 * locker uses (dispatched on their DEL/PEXPIRE calls), and same-process
 * pub/sub. Enough surface to exercise every locker behavior without a server.
 *
 * `now` supplies the clock TTLs are judged against, defaulting to the wall
 * clock. A test that asserts on expiry passes its own clock so that scheduler
 * jitter cannot decide the outcome. `onRenew` fires after a PEXPIRE that
 * positively extended the holder's own key.
 */
function fakeRedis(
    { now = Date.now, onRenew }: { now?: () => number; onRenew?: () => void } = {},
) {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const channels = new Map<string, Set<(message: string) => void>>();
    const evals: string[] = [];

    function live(key: string): { value: string; expiresAt: number } | undefined {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (now() >= entry.expiresAt) {
            store.delete(key);
            return undefined;
        }
        return entry;
    }

    const client: RedisLockerClient = {
        async set(key, value, options) {
            // NX is what makes the key a lock: without it a SET would overwrite
            // a live holder's entry and hand two acquirers the same resource.
            if (options.NX && live(key)) return null;
            store.set(key, { value, expiresAt: now() + options.PX });
            return "OK";
        },
        async eval(script, keys, args) {
            const key = keys[0]!;
            const entry = live(key);
            if (script.includes('"DEL"')) {
                evals.push("del");
                if (entry && entry.value === args[0]) {
                    store.delete(key);
                    return 1;
                }
                return 0;
            }
            evals.push("pexpire");
            if (entry && entry.value === args[0]) {
                entry.expiresAt = now() + Number(args[1]);
                onRenew?.();
                return 1;
            }
            return 0;
        },
        async publish(channel, message) {
            const subs = channels.get(channel);
            subs?.forEach((fn) => fn(message));
            return subs?.size ?? 0;
        },
        async subscribe(channel, onMessage) {
            let subs = channels.get(channel);
            if (!subs) {
                subs = new Set();
                channels.set(channel, subs);
            }
            subs.add(onMessage);
            return () => {
                subs!.delete(onMessage);
            };
        },
    };
    return { client, store, channels, evals };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("redisUploadLocker", () => {
    test("uncontended acquire takes the key with a TTL and release frees it", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        expect(store.has("partial-content:lock:tok")).toBe(true);
        lock.release();
        await sleep(5);
        expect(store.has("partial-content:lock:tok")).toBe(false);
        // The resource is immediately reacquirable.
        const again = await locker.acquire("tok");
        again.release();
    });

    test("a waiter aborts the holder's signal and takes the lock on yield", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000, pollIntervalMs: 10 });
        const lockA = await locker.acquire("tok");
        // Yield at the "next safe boundary": release when the signal aborts.
        lockA.signal.addEventListener("abort", () => setTimeout(() => lockA.release(), 5));
        const started = Date.now();
        const lockB = await locker.acquire("tok", { timeoutMs: 2_000 });
        // Handover is preempt-speed (a few poll rounds), not TTL/timeout-speed.
        expect(Date.now() - started).toBeLessThan(500);
        expect(lockA.signal.aborted).toBe(true);
        expect(lockA.signal.reason).toBe(UPLOAD_PREEMPTED);
        lockB.release();
    });

    test("the preempt signal aborts at most once across repeated publishes", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        let preempts = 0;
        lock.signal.addEventListener("abort", () => { preempts++; });
        await client.publish("partial-content:lock:preempt:tok", "preempt");
        await client.publish("partial-content:lock:preempt:tok", "preempt");
        await client.publish("partial-content:lock:preempt:tok", "preempt");
        expect(preempts).toBe(1);
        expect(lock.signal.aborted).toBe(true);
        lock.release();
    });

    test("a holder that never yields times the waiter out with UploadLockTimeoutError", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 60_000, pollIntervalMs: 10 });
        const lock = await locker.acquire("tok");
        const started = Date.now();
        await expect(locker.acquire("tok", { timeoutMs: 80 }))
            .rejects.toThrow(UploadLockTimeoutError);
        expect(Date.now() - started).toBeGreaterThanOrEqual(80);
        lock.release();
    });

    test("release only deletes the holder's OWN lock (fencing id compared)", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lockA = await locker.acquire("tok");
        // Steal: the key vanishes (expiry) and another instance takes it.
        store.delete("partial-content:lock:tok");
        await client.set("partial-content:lock:tok", "someone-else", { NX: true, PX: 5_000 });
        lockA.release();
        await sleep(5);
        // A's release must NOT have removed the new holder's lock.
        expect(store.get("partial-content:lock:tok")?.value).toBe("someone-else");
    });

    test("the watchdog renews a held lock past its original TTL, without false preempts", async () => {
        const ttlMs = 300;
        const errors: string[] = [];
        // Expiry is judged on this clock rather than the wall clock, so a
        // stalled scheduler cannot decide the result: only a renewal that
        // actually landed moves it. Each one advances it by two thirds of the
        // TTL, the gap a watchdog renewing at ttl/3 is there to cover, so the
        // hold survives an unbounded number of renewals and expires the moment
        // they stop.
        let clock = 0;
        const { client, store, evals } = fakeRedis({
            now: () => clock,
            onRenew: () => { clock += Math.floor((ttlMs * 2) / 3); },
        });
        const locker = redisUploadLocker(client, { ttlMs, onError: (_e, ctx) => errors.push(ctx.operation) });
        const lock = await locker.acquire("tok");
        await sleep(700);
        expect(evals.filter((e) => e === "pexpire").length).toBeGreaterThanOrEqual(2);
        // Nothing but a renewal advances the clock, so passing the original TTL
        // is itself the proof that they landed and carried the hold past it.
        expect(clock).toBeGreaterThan(ttlMs);
        expect(store.has("partial-content:lock:tok")).toBe(true);
        // A healthy hold never preempts itself and never reports.
        expect(lock.signal.aborted).toBe(false);
        expect(errors).toEqual([]);
        lock.release();
    });

    test("a renewal that THROWS preempts the holder and reports operation renew", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        const throwing: RedisLockerClient = {
            ...client,
            eval: async () => { throw new Error("connection lost"); },
        };
        const locker = redisUploadLocker(throwing, {
            ttlMs: 90,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const lock = await locker.acquire("tok");
        await sleep(120);
        expect(lock.signal.aborted).toBe(true);
        expect(errors).toContain("renew");
        lock.release();
    });

    test("an unrenewable holder's lock expires by TTL and a waiter takes it", async () => {
        // Crash model: the holder's connection is gone (renewals fail), so
        // the SET's PX is what frees the resource. The waiter must get the
        // lock roughly at TTL, well inside its acquire timeout.
        const { client, store } = fakeRedis();
        const holderClient: RedisLockerClient = {
            ...client,
            eval: async () => { throw new Error("connection lost"); },
        };
        const holderLocker = redisUploadLocker(holderClient, { ttlMs: 60 });
        await holderLocker.acquire("tok");

        const locker = redisUploadLocker(client, { ttlMs: 60, pollIntervalMs: 10 });
        const started = Date.now();
        const lock = await locker.acquire("tok", { timeoutMs: 2_000 });
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(40);
        expect(waited).toBeLessThan(1_000);
        lock.release();
    });

    test("a subscribe failure after the SET releases the key and propagates the error", async () => {
        const { client, store, evals } = fakeRedis();
        const failingSubscribe: RedisLockerClient = {
            ...client,
            subscribe: async () => { throw new Error("subscriber connection down"); },
        };
        const locker = redisUploadLocker(failingSubscribe, { ttlMs: 30_000 });
        // The SET won the key, then subscribe failed (a failover downing the
        // subscriber connection). Without a release the key would be held for
        // the full TTL with no watchdog and no release closure, dead-locking
        // the resource, so the locker releases the key it just took and rethrows.
        await expect(locker.acquire("tok")).rejects.toThrow("subscriber connection down");
        // The release is fired without being awaited, so that no cleanup can
        // itself hang; the error surfaces first and the DEL lands right after.
        await sleep(5);
        // The compare-and-delete release ran on the fencing id: the key is free.
        expect(evals).toContain("del");
        expect(store.has("partial-content:lock:tok")).toBe(false);
        // The resource is immediately reacquirable, not blocked until the TTL.
        const okLocker = redisUploadLocker(client, { ttlMs: 30_000 });
        const lock = await okLocker.acquire("tok");
        expect(store.has("partial-content:lock:tok")).toBe(true);
        lock.release();
    });

    test("a SET that never answers times the acquire out instead of parking the caller", async () => {
        const { client, evals } = fakeRedis();
        // Accepted by the server, never answered: a partitioned socket, or a
        // client queueing commands through a reconnect.
        const hangingSet: RedisLockerClient = {
            ...client,
            set: () => new Promise<string | null>(() => {}),
        };
        const locker = redisUploadLocker(hangingSet, { ttlMs: 30_000 });
        const started = Date.now();
        await expect(locker.acquire("tok", { timeoutMs: 60 })).rejects.toThrow(UploadLockTimeoutError);
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(60);
        expect(waited).toBeLessThan(1_000);
        // An abandoned SET may still take the key, and nothing else in the
        // system knows this fencing id, so the acquire frees it on the way out.
        await sleep(5);
        expect(evals).toContain("del");
    });

    test("a subscribe that never answers frees the key within the acquire budget", async () => {
        const { client, store } = fakeRedis();
        const hangingSubscribe: RedisLockerClient = {
            ...client,
            subscribe: () => new Promise<() => void>(() => {}),
        };
        const locker = redisUploadLocker(hangingSubscribe, { ttlMs: 30_000 });
        const started = Date.now();
        await expect(locker.acquire("tok", { timeoutMs: 60 })).rejects.toThrow(UploadLockTimeoutError);
        expect(Date.now() - started).toBeLessThan(1_000);
        await sleep(5);
        // The SET won the key. A subscribe that never answers must not leave it
        // held for the full 30s TTL with no watchdog and no release closure.
        expect(store.has("partial-content:lock:tok")).toBe(false);
    });

    test("a preempt publish that never answers cannot park the acquire past its deadline", async () => {
        const { client, store } = fakeRedis();
        const reports: Array<{ name: unknown; operation: string }> = [];
        const hangingPublish: RedisLockerClient = {
            ...client,
            publish: () => new Promise<number>(() => {}),
        };
        const locker = redisUploadLocker(hangingPublish, {
            ttlMs: 60_000,
            pollIntervalMs: 10,
            onError: (e, ctx) => reports.push({ name: (e as Error | undefined)?.name, operation: ctx.operation }),
        });
        const holder = await locker.acquire("tok");
        const started = Date.now();
        await expect(locker.acquire("tok", { timeoutMs: 60 })).rejects.toThrow(UploadLockTimeoutError);
        // Bounded by the waiter's own timeout, not by the publish answering.
        expect(Date.now() - started).toBeLessThan(1_000);
        // The sink receives a real error, not a bare rejection: an `onError`
        // handed `undefined` cannot be logged or classified.
        expect(reports).toContainEqual({ name: "UploadLockTimeoutError", operation: "preempt-publish" });
        holder.release();
    });

    test("a renewal that never answers preempts the holder, because silence is not confirmation", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        const hangingRenew: RedisLockerClient = {
            ...client,
            eval: (script, keys, args) => (script.includes('"PEXPIRE"')
                ? new Promise<number>(() => {})
                : client.eval(script, keys, args)),
        };
        // Renew interval is ttl/3 = 100ms: the first renewal is issued at 100ms
        // and must be judged unconfirmed by 200ms. Without that bound the holder
        // writes straight through its own TTL believing the hold is good.
        const locker = redisUploadLocker(hangingRenew, {
            ttlMs: 300,
            onError: (e, ctx) => errors.push(`${ctx.operation}: ${(e as Error | undefined)?.message}`),
        });
        const lock = await locker.acquire("tok");
        await sleep(450);
        expect(lock.signal.aborted).toBe(true);
        expect(lock.signal.reason).toBe(UPLOAD_PREEMPTED);
        // Reported as its own cause, distinguishable from a renewal that
        // answered "not yours" and from a connection that refused it.
        expect(errors).toContain("renew: Upload lock renewal did not answer within the renew interval");
        lock.release();
    });

    test("a SET that fails frees any hold it may have taken and hands out no lock", async () => {
        const { client, evals } = fakeRedis();
        const failingSet: RedisLockerClient = {
            ...client,
            set: async () => { throw new Error("SET refused"); },
        };
        const locker = redisUploadLocker(failingSet, { ttlMs: 30_000 });
        // A SET whose answer never arrived is not a lock: treating the failure
        // as anything other than a failure would hand out a hold nobody took.
        await expect(locker.acquire("tok", { timeoutMs: 500 })).rejects.toThrow("SET refused");
        await sleep(5);
        expect(evals).toContain("del");
    });

    test("a preempt arriving after release does not abort the released lock's signal", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        lock.release();
        // release() unsubscribes asynchronously, so a preempt published in that
        // window still reaches this listener. A holder that has already let go
        // must not have its signal aborted: the abort means "yield your write",
        // and a released lock has no write to yield.
        void client.publish("partial-content:lock:preempt:tok", "preempt");
        expect(lock.signal.aborted).toBe(false);
    });

    test("a failing unsubscribe is absorbed and reported with its error and operation", async () => {
        const { client, store } = fakeRedis();
        const reports: Array<{ message: unknown; operation: string }> = [];
        const failingUnsubscribe: RedisLockerClient = {
            ...client,
            subscribe: async () => () => { throw new Error("unsubscribe down"); },
        };
        const locker = redisUploadLocker(failingUnsubscribe, {
            ttlMs: 5_000,
            onError: (e, ctx) => reports.push({ message: (e as Error | undefined)?.message, operation: ctx.operation }),
        });
        const lock = await locker.acquire("tok");
        lock.release();
        await sleep(5);
        expect(reports).toContainEqual({ message: "unsubscribe down", operation: "unsubscribe" });
    });

    test("onError is optional: absorbed failures stay absorbed with no sink configured", async () => {
        const { client, store } = fakeRedis();
        // Four absorbed paths at once and nowhere to report any of them: the
        // watchdog's renewal answers "not yours", the unsubscribe throws, the
        // release DEL cannot delete, and a waiter's preempt publish fails.
        const sinkless: RedisLockerClient = {
            set: client.set,
            eval: async () => 0,
            publish: async () => { throw new Error("publish down"); },
            subscribe: async () => () => { throw new Error("unsubscribe down"); },
        };
        const locker = redisUploadLocker(sinkless, { ttlMs: 300, pollIntervalMs: 10 });
        const holder = await locker.acquire("tok");
        // The waiter cannot publish its preempt request and still times out
        // cleanly rather than crashing on a missing sink.
        await expect(locker.acquire("tok", { timeoutMs: 60 })).rejects.toThrow(UploadLockTimeoutError);
        // The renewal at ttl/3 answers "not held", preempting with no sink.
        await sleep(250);
        expect(holder.signal.aborted).toBe(true);
        holder.release();
        await sleep(10);
    });

    test("a release DEL that rejects needs no sink either", async () => {
        const { client, store } = fakeRedis();
        const failingEval: RedisLockerClient = {
            ...client,
            eval: async () => { throw new Error("eval down"); },
        };
        const locker = redisUploadLocker(failingEval, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        lock.release();
        await sleep(10);
        // Reaching here at all is the assertion: a rejected DEL with no sink
        // must not surface as an unhandled rejection on the upload path.
        expect(lock.signal.aborted).toBe(false);
    });

    test("release unsubscribes the preempt channel", async () => {
        const { client, channels } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        expect(channels.get("partial-content:lock:preempt:tok")?.size).toBe(1);
        lock.release();
        await sleep(5);
        expect(channels.get("partial-content:lock:preempt:tok")?.size ?? 0).toBe(0);
    });

    test("a failed release DEL is absorbed and reported with operation release", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        let acquired = false;
        const flaky: RedisLockerClient = {
            ...client,
            eval: async (script, keys, args) => {
                if (acquired && script.includes('"DEL"')) throw new Error("DEL refused");
                return client.eval(script, keys, args);
            },
        };
        const locker = redisUploadLocker(flaky, {
            ttlMs: 5_000,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const lock = await locker.acquire("tok");
        acquired = true;
        lock.release();
        await sleep(5);
        expect(errors).toContain("release");
    });

    test("a failed preempt publish is absorbed, reported, and waiting continues", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        const mute: RedisLockerClient = {
            ...client,
            publish: async () => { throw new Error("pubsub down"); },
        };
        const locker = redisUploadLocker(mute, {
            ttlMs: 60_000, pollIntervalMs: 10,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const lock = await locker.acquire("tok");
        await expect(locker.acquire("tok", { timeoutMs: 60 }))
            .rejects.toThrow(UploadLockTimeoutError);
        expect(errors).toContain("preempt-publish");
        lock.release();
    });

    test("a renewal that finds the lock lost preempts the holder and reports", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        const locker = redisUploadLocker(client, {
            ttlMs: 90,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const lock = await locker.acquire("tok");
        // The lock is stolen out from under the holder.
        store.delete("partial-content:lock:tok");
        await sleep(120);
        expect(lock.signal.aborted).toBe(true);
        expect(errors).toContain("renew");
        lock.release();
    });

    test("release is idempotent: one DEL however many calls", async () => {
        const { client, evals } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        lock.release();
        lock.release();
        lock.release();
        await sleep(5);
        expect(evals.filter((e) => e === "del")).toHaveLength(1);
    });

    test("after release, a late publish never aborts the old holder's signal", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        lock.release();
        await sleep(5);
        await client.publish("partial-content:lock:preempt:tok", "preempt");
        expect(lock.signal.aborted).toBe(false);
    });

    test("construction refuses non-positive or fractional timings", () => {
        const { client, store } = fakeRedis();
        expect(() => redisUploadLocker(client, { ttlMs: 0 })).toThrow(TypeError);
        expect(() => redisUploadLocker(client, { acquireTimeoutMs: -1 })).toThrow(TypeError);
        expect(() => redisUploadLocker(client, { acquireTimeoutMs: 0 })).toThrow(TypeError);
        expect(() => redisUploadLocker(client, { pollIntervalMs: 1.5 })).toThrow(TypeError);
        expect(() => redisUploadLocker(client, { pollIntervalMs: 0 })).toThrow(TypeError);
    });

    test("keyPrefix namespaces both the key and the preempt channel", async () => {
        const { client, store, channels } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000, keyPrefix: "acme:" });
        const lock = await locker.acquire("tok");
        expect(store.has("acme:tok")).toBe(true);
        expect(channels.has("acme:preempt:tok")).toBe(true);
        lock.release();
    });

    test("timeout errors from this locker match the orchestrator's contention matcher", async () => {
        const { client, store } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 60_000, pollIntervalMs: 10 });
        const lock = await locker.acquire("tok");
        try {
            await locker.acquire("tok", { timeoutMs: 40 });
            throw new Error("should have timed out");
        } catch (err) {
            expect(isUploadLockTimeoutError(err)).toBe(true);
        }
        lock.release();
    });
});

// ─── A subscription that lands after the deadline still has to be undone ────

describe("subscribe that misses the acquire deadline", () => {
    test("the late subscription is unsubscribed instead of living for the process lifetime", async () => {
        const { client, channels, store } = fakeRedis();
        let releaseSubscribe!: () => void;
        const slow: RedisLockerClient = {
            set: (...a) => client.set(...a),
            eval: (...a) => client.eval(...a),
            publish: (...a) => client.publish(...a),
            subscribe(channel, onMessage) {
                // The failover shape: the subscriber connection answers, but
                // only after the caller has already given up on it.
                return new Promise((resolve) => {
                    releaseSubscribe = () => { resolve(client.subscribe(channel, onMessage)); };
                });
            },
        };
        const locker = redisUploadLocker(slow, {
            ttlMs: 30_000, acquireTimeoutMs: 60, pollIntervalMs: 10,
        });

        await expect(locker.acquire("tok")).rejects.toThrow(UploadLockTimeoutError);
        // The key the abandoned acquire took is released, so waiters are not
        // parked for a full TTL.
        expect(store.size).toBe(0);

        releaseSubscribe();
        // Drain the unsubscribe the abandoned promise triggers.
        await new Promise((r) => setTimeout(r, 10));

        const listeners = [...channels.values()].reduce((n, s) => n + s.size, 0);
        // Every acquire in a slow window would otherwise leave a listener and
        // the closure it holds behind, worst exactly when the system is fragile.
        expect(listeners).toBe(0);
    });
});

// ─── A rejected option says which one it was ────────────────────────────────

describe("redisUploadLocker: construction", () => {
    const build = (opts: Record<string, unknown>) => () =>
        redisUploadLocker(fakeRedis().client, opts);

    test("each option is named individually, with the value that was wrong", () => {
        // Listing three option names and leaving the caller to work out which
        // one they got wrong is the message this replaces.
        expect(build({ ttlMs: 0 })).toThrow(/ttlMs must be a positive safe integer, got 0/);
        expect(build({ acquireTimeoutMs: -1 })).toThrow(/acquireTimeoutMs must be a positive safe integer, got -1/);
        expect(build({ pollIntervalMs: 1.5 })).toThrow(/pollIntervalMs must be a positive safe integer, got 1.5/);
    });

    test("every non-integer and non-positive shape is refused", () => {
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
            expect(build({ ttlMs: bad })).toThrow(TypeError);
        }
    });

    test("the defaults construct, and so does a fully specified set", () => {
        expect(build({})).not.toThrow();
        expect(build({ ttlMs: 1000, acquireTimeoutMs: 500, pollIntervalMs: 10 })).not.toThrow();
    });

    test("a deadline already in the past is refused before any round trip", async () => {
        const locker = redisUploadLocker(fakeRedis().client, { pollIntervalMs: 10 });
        // A budget of zero cannot answer, so spending a round trip on it would
        // only delay the same failure.
        await expect(locker.acquire("tok", { timeoutMs: 0 })).rejects.toThrow(UploadLockTimeoutError);
    });
});

// ─── A released lock raises no alarm about its own renewal ──────────────────

describe("renewal after release", () => {
    test("a renewal still in flight when release() runs reports nothing", async () => {
        const { client, store } = fakeRedis();
        const errors: string[] = [];
        const hangingRenew: RedisLockerClient = {
            ...client,
            eval: (script, keys, args) => (script.includes('"PEXPIRE"')
                ? new Promise<number>(() => {})
                : client.eval(script, keys, args)),
        };
        const locker = redisUploadLocker(hangingRenew, {
            ttlMs: 300,
            onError: (e, ctx) => errors.push(`${ctx.operation}: ${(e as Error | undefined)?.message}`),
        });

        const lock = await locker.acquire("tok");
        // Let the first renewal be issued (ttl/3 = 100ms), then let go while it
        // is still unanswered. Its deadline lands after the release.
        await sleep(150);
        lock.release();
        await sleep(250);

        // A lock the holder let go of cleanly is not a lock it lost. Reporting
        // one would page an operator on every release that races the watchdog.
        expect(errors).toEqual([]);
        expect(lock.signal.aborted).toBe(false);
    });

    test("a renewal that answers 'not yours' still reports, with no error sink configured", async () => {
        const { client } = fakeRedis();
        const stolen: RedisLockerClient = {
            ...client,
            eval: (script, keys, args) => (script.includes('"PEXPIRE"')
                // The hold-id no longer matches, which is what a stolen lock
                // looks like from the holder's side.
                ? Promise.resolve(0)
                : client.eval(script, keys, args)),
        };
        // No onError: the optional call must stay optional, or a locker built
        // without a sink throws inside its own watchdog.
        const locker = redisUploadLocker(stolen, { ttlMs: 300 });
        const lock = await locker.acquire("tok");
        await sleep(250);

        expect(lock.signal.aborted).toBe(true);
        expect(lock.signal.reason).toBe(UPLOAD_PREEMPTED);
        // The point is that the optional call stayed optional: a locker built
        // without a sink must not throw inside its own watchdog.
        lock.release();
    });
});

// ─── The token is a capability, so the error sink never sees it ─────────────

describe("acquire auditKey", () => {
    test("an acquire that supplies an auditKey keeps the token out of the error context", async () => {
        const { client } = fakeRedis();
        const contexts: Array<{ uploadToken?: string; auditKey?: string; operation: string }> = [];
        const failingRelease: RedisLockerClient = {
            ...client,
            eval: (script, keys, args) => (script.includes('"DEL"')
                ? Promise.reject(new Error("DEL refused"))
                : client.eval(script, keys, args)),
        };
        const locker = redisUploadLocker(failingRelease, {
            onError: (_e, ctx) => contexts.push(ctx),
        });

        const lock = await locker.acquire("tok-capability", { auditKey: "upload-42" });
        lock.release();
        await sleep(20);

        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.operation).toBe("release");
        // Substitution, not accompaniment: an error sink is at least as
        // log-adjacent as the event sink, and possession of the token IS the
        // authorization to append to, probe and cancel the upload.
        expect(contexts[0]!.auditKey).toBe("upload-42");
        expect(contexts[0]!.uploadToken).toBeUndefined();
    });

    test("an acquire with no auditKey still names the token, because an unnamed failure is not actionable", async () => {
        const { client } = fakeRedis();
        const contexts: Array<{ uploadToken?: string; auditKey?: string; operation: string }> = [];
        const failingRelease: RedisLockerClient = {
            ...client,
            eval: (script, keys, args) => (script.includes('"DEL"')
                ? Promise.reject(new Error("DEL refused"))
                : client.eval(script, keys, args)),
        };
        const locker = redisUploadLocker(failingRelease, {
            onError: (_e, ctx) => contexts.push(ctx),
        });

        const lock = await locker.acquire("tok-plain");
        lock.release();
        await sleep(20);

        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.uploadToken).toBe("tok-plain");
        expect(contexts[0]!.auditKey).toBeUndefined();
    });
});
