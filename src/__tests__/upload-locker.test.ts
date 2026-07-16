import { describe, test, expect } from "bun:test";
import { memoryUploadLocker, isUploadLockTimeoutError, UploadLockTimeoutError } from "../upload-locker";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("memoryUploadLocker", () => {
    test("a free lock acquires immediately and releases idempotently", async () => {
        const locker = memoryUploadLocker();
        const lock = await locker.acquire("t1", () => {});
        lock.release();
        lock.release(); // no-op, no throw
        const again = await locker.acquire("t1", () => {});
        again.release();
    });

    test("tokens are independent", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("a", () => {});
        // Acquiring b must not wait on a.
        const b = await locker.acquire("b", () => {});
        a.release();
        b.release();
    });

    test("a second acquirer preempts the holder and waits for release", async () => {
        const locker = memoryUploadLocker();
        let preempted = false;
        const held = await locker.acquire("t", () => { preempted = true; });

        let acquired = false;
        const waiting = locker.acquire("t", () => {}).then((lock) => {
            acquired = true;
            return lock;
        });
        await tick();
        expect(preempted).toBe(true);
        expect(acquired).toBe(false);

        held.release();
        const lock = await waiting;
        expect(acquired).toBe(true);
        lock.release();
    });

    test("the holder is asked to yield at most once per contention burst", async () => {
        const locker = memoryUploadLocker();
        let preempts = 0;
        const held = await locker.acquire("t", () => { preempts++; });

        const w1 = locker.acquire("t", () => {});
        const w2 = locker.acquire("t", () => {});
        await tick();
        expect(preempts).toBe(1);

        held.release();
        (await w1).release();
        (await w2).release();
    });

    test("waiters are served in FIFO order, each preempting the next holder", async () => {
        const locker = memoryUploadLocker();
        const order: string[] = [];
        let preemptFirstWaiter = false;

        const held = await locker.acquire("t", () => {});
        const w1 = locker.acquire("t", () => { preemptFirstWaiter = true; })
            .then((l) => { order.push("w1"); return l; });
        const w2 = locker.acquire("t", () => {})
            .then((l) => { order.push("w2"); return l; });

        held.release();
        const l1 = await w1;
        // w1 now holds while w2 still waits: w1 must have been preempted on
        // hand-over so it yields promptly too.
        await tick();
        expect(preemptFirstWaiter).toBe(true);
        expect(order).toEqual(["w1"]);

        l1.release();
        const l2 = await w2;
        expect(order).toEqual(["w1", "w2"]);
        l2.release();
    });

    test("a holder that never yields times the waiter out with UploadLockTimeoutError", async () => {
        const locker = memoryUploadLocker();
        await locker.acquire("t", () => {}); // never released
        const started = Date.now();
        try {
            await locker.acquire("t", () => {}, { timeoutMs: 30 });
            throw new Error("should have timed out");
        } catch (err) {
            expect(err).toBeInstanceOf(UploadLockTimeoutError);
            expect(isUploadLockTimeoutError(err)).toBe(true);
            expect(Date.now() - started).toBeGreaterThanOrEqual(25);
        }
    });

    test("a timed-out waiter is removed: a later release does not resolve it", async () => {
        const locker = memoryUploadLocker();
        const held = await locker.acquire("t", () => {});
        const timedOut = locker.acquire("t", () => {}, { timeoutMs: 20 });
        await expect(timedOut).rejects.toBeInstanceOf(UploadLockTimeoutError);

        held.release();
        // The lock must now be free for a fresh acquire, not handed to the
        // dead waiter.
        const fresh = await locker.acquire("t", () => {});
        fresh.release();
    });

    test("isUploadLockTimeoutError matches only same-named Error instances", () => {
        expect(isUploadLockTimeoutError(new UploadLockTimeoutError("t"))).toBe(true);
        expect(isUploadLockTimeoutError(new Error("other failure"))).toBe(false);
        expect(isUploadLockTimeoutError("UploadLockTimeoutError")).toBe(false);
    });

    test("a stale double release cannot free a lock a new holder owns", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t", () => {});
        let bPreempted = false;
        const bP = locker.acquire("t", () => { bPreempted = true; });
        a.release();
        const b = await bP; // b holds now
        bPreempted = false;

        a.release(); // stale second release: must be a no-op

        let cAcquired = false;
        const cP = locker.acquire("t", () => {}).then((lock) => {
            cAcquired = true;
            return lock;
        });
        await tick();
        // c's arrival preempts b, the TRUE holder; c keeps waiting.
        expect(bPreempted).toBe(true);
        expect(cAcquired).toBe(false);

        b.release();
        (await cP).release();
        expect(cAcquired).toBe(true);
    });

    test("hand-over with an empty queue does not preempt the new holder", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t", () => {});
        let bPreempted = false;
        const bP = locker.acquire("t", () => { bPreempted = true; });
        a.release();
        const b = await bP;
        await tick();
        // Nobody else wants the lock: the fresh holder must not be told to yield.
        expect(bPreempted).toBe(false);
        b.release();
    });

    test("a handed-over holder facing more waiters is preempted exactly once", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t", () => {});
        let bPreempts = 0;
        const bP = locker.acquire("t", () => { bPreempts++; });
        const cP = locker.acquire("t", () => {});
        a.release(); // b holds, c still queued: hand-over preempts b once
        const b = await bP;
        await tick();
        expect(bPreempts).toBe(1);

        // A later waiter must not re-preempt the already-preempted holder.
        const dP = locker.acquire("t", () => {});
        await tick();
        expect(bPreempts).toBe(1);

        b.release();
        (await cP).release();
        (await dP).release();
    });

    test("a mid-queue timeout removes only that waiter and the lock stays serviceable", async () => {
        const locker = memoryUploadLocker();
        const a = await locker.acquire("t", () => {});
        const w1 = locker.acquire("t", () => {}, { timeoutMs: 5_000 });
        const w2 = locker.acquire("t", () => {}, { timeoutMs: 15 }); // times out at queue index 1
        await expect(w2).rejects.toBeInstanceOf(UploadLockTimeoutError);

        a.release();
        const l1 = await w1;
        l1.release();
        // The token must be fully free again: a fresh acquire resolves without
        // getting starved behind the dead waiter's queue slot.
        const fresh = await locker.acquire("t", () => {}, { timeoutMs: 50 });
        fresh.release();
    });
});
