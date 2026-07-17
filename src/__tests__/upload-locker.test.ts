import { describe, test, expect } from "bun:test";
import {
    memoryUploadLocker,
    isUploadLockTimeoutError,
    UploadLockTimeoutError,
    UPLOAD_PREEMPTED,
} from "../upload-locker";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Count how many times a lock's preempt signal fires (the event is one-shot). */
function preemptCounter(signal: AbortSignal): () => number {
    let n = 0;
    signal.addEventListener("abort", () => { n += 1; });
    return () => n;
}

describe("memoryUploadLocker", () => {
    test("a free lock acquires immediately, exposes a fresh signal, releases idempotently", async () => {
        const locker = memoryUploadLocker();
        const lock = await locker.acquire("t1");
        expect(lock.signal).toBeInstanceOf(AbortSignal);
        expect(lock.signal.aborted).toBe(false);
        lock.release();
        lock.release(); // no-op, no throw
        const again = await locker.acquire("t1");
        expect(again.signal.aborted).toBe(false);
        again.release();
    });

    test("tokens are independent", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("a");
        // Acquiring b must not wait on a, and must not preempt a.
        const b = await locker.acquire("b");
        expect(a.signal.aborted).toBe(false);
        a.release();
        b.release();
    });

    test("a second acquirer aborts the holder's signal and waits for release", async () => {
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t");

        let acquired = false;
        const waiting = locker.acquire("t").then((lock) => {
            acquired = true;
            return lock;
        });
        await tick();
        expect(held.signal.aborted).toBe(true);
        expect(held.signal.reason).toBe(UPLOAD_PREEMPTED);
        expect(acquired).toBe(false);

        held.release();
        const lock = await waiting;
        expect(acquired).toBe(true);
        lock.release();
    });

    test("the holder's signal aborts at most once across a contention burst", async () => {
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t");
        const fired = preemptCounter(held.signal);

        const w1 = locker.acquire("t");
        const w2 = locker.acquire("t");
        await tick();
        expect(fired()).toBe(1);
        expect(held.signal.aborted).toBe(true);

        held.release();
        (await w1).release();
        (await w2).release();
    });

    test("waiters are served in FIFO order, each preempted on hand-over while another waits", async () => {
        const locker = memoryUploadLocker();
        const order: string[] = [];

        const held = await locker.acquire("t");
        const w1 = locker.acquire("t").then((l) => { order.push("w1"); return l; });
        const w2 = locker.acquire("t").then((l) => { order.push("w2"); return l; });

        held.release();
        const l1 = await w1;
        // w1 now holds while w2 still waits: its signal must already be aborted
        // on hand-over so it yields promptly too.
        await tick();
        expect(l1.signal.aborted).toBe(true);
        expect(order).toEqual(["w1"]);

        l1.release();
        const l2 = await w2;
        expect(order).toEqual(["w1", "w2"]);
        expect(l2.signal.aborted).toBe(false); // last in line: nobody waiting
        l2.release();
    });

    test("a holder that never yields times the waiter out with UploadLockTimeoutError", async () => {
        const locker = memoryUploadLocker();
        await locker.acquire("t"); // never released
        const started = Date.now();
        try {
            await locker.acquire("t", { timeoutMs: 30 });
            throw new Error("should have timed out");
        } catch (err) {
            expect(err).toBeInstanceOf(UploadLockTimeoutError);
            expect(isUploadLockTimeoutError(err)).toBe(true);
            expect(Date.now() - started).toBeGreaterThanOrEqual(25);
        }
    });

    test("a timed-out waiter is removed: a later release does not resolve it", async () => {
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t");
        const timedOut = locker.acquire("t", { timeoutMs: 20 });
        await expect(timedOut).rejects.toBeInstanceOf(UploadLockTimeoutError);

        held.release();
        // The lock must now be free for a fresh acquire, not handed to the
        // dead waiter (whose fresh signal would otherwise never be observed).
        const fresh = await locker.acquire("t");
        expect(fresh.signal.aborted).toBe(false);
        fresh.release();
    });

    test("isUploadLockTimeoutError matches only same-named Error instances", () => {
        expect(isUploadLockTimeoutError(new UploadLockTimeoutError("t"))).toBe(true);
        expect(isUploadLockTimeoutError(new Error("other failure"))).toBe(false);
        expect(isUploadLockTimeoutError("UploadLockTimeoutError")).toBe(false);
    });

    test("a stale double release cannot free a lock a new holder owns", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t");
        const bP = locker.acquire("t");
        a.release();
        const b = await bP; // b holds now

        a.release(); // stale second release: must be a no-op

        let cAcquired = false;
        const cP = locker.acquire("t").then((lock) => {
            cAcquired = true;
            return lock;
        });
        await tick();
        // c's arrival preempts b, the TRUE holder; c keeps waiting.
        expect(b.signal.aborted).toBe(true);
        expect(cAcquired).toBe(false);

        b.release();
        (await cP).release();
        expect(cAcquired).toBe(true);
    });

    test("hand-over with an empty queue does not abort the new holder's signal", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t");
        const bP = locker.acquire("t");
        a.release();
        const b = await bP;
        await tick();
        // Nobody else wants the lock: the fresh holder must not be told to yield.
        expect(b.signal.aborted).toBe(false);
        b.release();
    });

    test("a handed-over holder facing more waiters is preempted exactly once", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t");
        const bP = locker.acquire("t");
        const cP = locker.acquire("t");
        a.release(); // b holds, c still queued: hand-over aborts b's signal once
        const b = await bP;
        const fired = preemptCounter(b.signal);
        await tick();
        // The signal was aborted on hand-over (before the counter attached), so
        // it is already latched; a later waiter must not re-fire it.
        expect(b.signal.aborted).toBe(true);
        const dP = locker.acquire("t");
        await tick();
        expect(fired()).toBe(0); // already aborted before d arrived; no second edge

        b.release();
        (await cP).release();
        (await dP).release();
    });

    test("the preempt abort reason is the exact UPLOAD_PREEMPTED literal", async () => {
        // Pinned to the literal, not the constant, so a change to the constant's
        // value is caught rather than moving in lockstep with the assertion.
        expect(UPLOAD_PREEMPTED).toBe("upload-lock-preempted");
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t");
        void locker.acquire("t");
        await tick();
        expect(held.signal.reason).toBe("upload-lock-preempted");
        held.release();
    });

    test("the default acquire timeout is large: a contended waiter is not rejected quickly", async () => {
        // No timeoutMs given, so the default applies. A waiter must keep waiting
        // (not reject) far longer than a poll tick, proving the default is a real
        // multi-second budget and not degenerately small.
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t");
        let rejected = false;
        const waiting = locker.acquire("t").then((l) => l, () => { rejected = true; });
        await new Promise((r) => setTimeout(r, 60));
        expect(rejected).toBe(false);
        held.release();
        const lock = await waiting;
        expect(lock).toBeDefined();
        (lock as { release(): void }).release();
    });

    test("a mid-queue timeout removes only that waiter and the lock stays serviceable", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t");
        const w1 = locker.acquire("t", { timeoutMs: 5_000 });
        const w2 = locker.acquire("t", { timeoutMs: 15 }); // times out at queue index 1
        await expect(w2).rejects.toBeInstanceOf(UploadLockTimeoutError);

        a.release();
        const l1 = await w1;
        l1.release();
        // The token must be fully free again: a fresh acquire resolves without
        // getting starved behind the dead waiter's queue slot.
        const fresh = await locker.acquire("t", { timeoutMs: 50 });
        fresh.release();
    });
});
