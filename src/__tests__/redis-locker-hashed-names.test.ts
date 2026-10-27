/**
 * The Redis locker never writes the upload token (the capability) to the
 * server: the lock key is the prefix plus the token's SHA-256 in hex, and the
 * preempt request travels on one locker-wide channel naming the same digest.
 * One subscription serves every lock the instance holds at once, so a burst of
 * acquisitions costs one subscriber connection, not one per request.
 */
import { describe, test, expect } from "bun:test";
import { redisUploadLocker, type RedisLockerClient } from "../redis-locker.ts";
import { UPLOAD_PREEMPTED } from "../upload-locker.ts";

async function sha256Hex(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function recordingRedis() {
    const held = new Map<string, string>();
    const listeners = new Map<string, Set<(message: string) => void>>();
    const written: string[] = [];
    let subscribes = 0;
    let unsubscribes = 0;
    const client: RedisLockerClient = {
        async set(key, value, options) {
            written.push(key);
            if (options.NX && held.has(key)) return null;
            held.set(key, value);
            return "OK";
        },
        async eval(script, keys, args) {
            written.push(...keys, ...args);
            const key = keys[0]!;
            if (held.get(key) !== args[0]) return 0;
            if (script.includes('"DEL"')) held.delete(key);
            return 1;
        },
        async publish(channel, message) {
            written.push(channel, message);
            listeners.get(channel)?.forEach((fn) => fn(message));
            return 1;
        },
        async subscribe(channel, onMessage) {
            written.push(channel);
            subscribes++;
            let set = listeners.get(channel);
            if (!set) listeners.set(channel, (set = new Set()));
            set.add(onMessage);
            return () => {
                unsubscribes++;
                set!.delete(onMessage);
            };
        },
    };
    return { client, held, written, counts: () => ({ subscribes, unsubscribes }) };
}

describe("redisUploadLocker names resources by digest", () => {
    test("no key, channel or message carries the raw token", async () => {
        const token = "upload-token-under-test";
        const redis = recordingRedis();
        const locker = redisUploadLocker(redis.client, { pollIntervalMs: 1, acquireTimeoutMs: 2_000 });
        const first = await locker.acquire(token);
        expect([...redis.held.keys()]).toEqual([`partial-content:lock:${await sha256Hex(token)}`]);
        // A contended acquire publishes the preempt request the holder obeys.
        const second = locker.acquire(token);
        await new Promise<void>((resolve) => first.signal.addEventListener("abort", () => resolve()));
        expect(first.signal.reason).toBe(UPLOAD_PREEMPTED);
        first.release();
        (await second).release();
        expect(redis.written.length).toBeGreaterThan(0);
        for (const value of redis.written) expect(value).not.toContain(token);
    });

    test("concurrent holds share one subscription and a preempt reaches only its own holder", async () => {
        const redis = recordingRedis();
        const locker = redisUploadLocker(redis.client, { pollIntervalMs: 1, acquireTimeoutMs: 2_000 });
        const a = await locker.acquire("token-a");
        const b = await locker.acquire("token-b");
        const c = await locker.acquire("token-c");
        expect(redis.counts().subscribes).toBe(1);
        const waiter = locker.acquire("token-b");
        await new Promise<void>((resolve) => b.signal.addEventListener("abort", () => resolve()));
        expect(a.signal.aborted).toBe(false);
        expect(c.signal.aborted).toBe(false);
        b.release();
        (await waiter).release();
        a.release();
        c.release();
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        // The last release lets the shared subscription go.
        expect(redis.counts().unsubscribes).toBe(1);
    });
});
