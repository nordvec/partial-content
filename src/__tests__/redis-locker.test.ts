import { describe, test, expect } from "bun:test";
import { redisUploadLocker, type RedisLockerClient } from "../redis-locker";
import { UploadLockTimeoutError, isUploadLockTimeoutError, UPLOAD_PREEMPTED } from "../upload-locker";

/**
 * In-memory Redis-protocol fake: SET NX PX with real-clock TTLs, the two
 * Lua scripts the locker uses (dispatched on their DEL/PEXPIRE calls), and
 * same-process pub/sub. Enough surface to exercise every locker behavior
 * without a server.
 */
function fakeRedis() {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const channels = new Map<string, Set<(message: string) => void>>();
    const evals: string[] = [];

    function live(key: string): { value: string; expiresAt: number } | undefined {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (Date.now() >= entry.expiresAt) {
            store.delete(key);
            return undefined;
        }
        return entry;
    }

    const client: RedisLockerClient = {
        async set(key, value, options) {
            if (live(key)) return null;
            store.set(key, { value, expiresAt: Date.now() + options.PX });
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
                entry.expiresAt = Date.now() + Number(args[1]);
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
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
        const { client, store, evals } = fakeRedis();
        const errors: string[] = [];
        const locker = redisUploadLocker(client, { ttlMs: 90, onError: (_e, ctx) => errors.push(ctx.operation) });
        const lock = await locker.acquire("tok");
        await sleep(220);
        // Original TTL (90ms) is long gone; renewals kept it alive.
        expect(store.has("partial-content:lock:tok")).toBe(true);
        expect(evals.filter((e) => e === "pexpire").length).toBeGreaterThanOrEqual(2);
        // A healthy hold never preempts itself and never reports.
        expect(lock.signal.aborted).toBe(false);
        expect(errors).toEqual([]);
        lock.release();
    });

    test("a renewal that THROWS preempts the holder and reports operation renew", async () => {
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
        const locker = redisUploadLocker(client, { ttlMs: 5_000 });
        const lock = await locker.acquire("tok");
        lock.release();
        await sleep(5);
        await client.publish("partial-content:lock:preempt:tok", "preempt");
        expect(lock.signal.aborted).toBe(false);
    });

    test("construction refuses non-positive or fractional timings", () => {
        const { client } = fakeRedis();
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
        const { client } = fakeRedis();
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
