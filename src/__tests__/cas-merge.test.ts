import { describe, test, expect } from "bun:test";
import { CAS_MERGE_ATTEMPTS, casMerge, mergePersistedState } from "../cas-merge";
import type { PersistedUpload } from "../upload-internals";

class Conflict extends Error {}

/** A versioned record whose conditional write fails while `refusals` lasts. */
function versioned(initial: number, refusals = 0) {
    const box = { value: initial, version: 1, reads: 0, writes: 0, refusals };
    return {
        box,
        read: async () => {
            box.reads += 1;
            return { value: box.value, version: box.version };
        },
        write: async (next: { value: number; version: number }) => {
            if (box.refusals > 0 || next.version !== box.version) {
                box.refusals -= 1;
                // Another writer landed in between.
                box.value += 100;
                box.version += 1;
                throw new Conflict("moved");
            }
            box.writes += 1;
            box.value = next.value;
            box.version += 1;
        },
    };
}

describe("casMerge", () => {
    test("a refused write re-reads and the merge lands on the newer record", async () => {
        const record = versioned(1, 1);
        await casMerge({
            read: record.read,
            merge: (fresh) => ({ value: fresh.value + 1, version: fresh.version }),
            write: record.write,
            isConflict: (err) => err instanceof Conflict,
            attempts: 3,
        });
        expect(record.box).toMatchObject({ value: 102, reads: 2, writes: 1 });
    });

    test("a record contended on every pass fails after the attempts, never landing", async () => {
        const record = versioned(1, 10);
        const err = await casMerge({
            read: record.read,
            merge: (fresh) => fresh,
            write: record.write,
            isConflict: (e) => e instanceof Conflict,
            attempts: 3,
        }).catch((e: unknown) => e);
        expect((err as Error).message).toMatch(/changed under 3 consecutive merges/);
        expect((err as Error).cause).toBeInstanceOf(Conflict);
        expect(record.box).toMatchObject({ reads: 3, writes: 0 });
    });

    test("a write failure that is not a conflict propagates without a retry", async () => {
        let reads = 0;
        const failure = new Error("denied");
        await expect(
            casMerge({
                read: async () => (reads += 1),
                merge: (fresh) => fresh,
                write: () => Promise.reject(failure),
                isConflict: () => false,
                attempts: 3,
            }),
        ).rejects.toBe(failure);
        expect(reads).toBe(1);
    });

    test("a merge that refuses its fresh record fails the call and is never offered as a conflict", async () => {
        const refusal = new Error("no safe base");
        let offered = 0;
        let writes = 0;
        await expect(
            casMerge({
                read: async () => null,
                merge: () => {
                    throw refusal;
                },
                write: async () => {
                    writes += 1;
                },
                isConflict: () => {
                    offered += 1;
                    return true;
                },
                attempts: 3,
            }),
        ).rejects.toBe(refusal);
        expect({ offered, writes }).toEqual({ offered: 0, writes: 0 });
    });

    test("an aborted signal rejects with its reason before any read", async () => {
        const controller = new AbortController();
        controller.abort(new Error("caller left"));
        let reads = 0;
        await expect(
            casMerge({
                read: async () => (reads += 1),
                merge: (fresh) => fresh,
                write: async () => undefined,
                isConflict: () => true,
                attempts: 3,
                signal: controller.signal,
            }),
        ).rejects.toThrow("caller left");
        expect(reads).toBe(0);
    });

    test("an omitted attempts bound stops after CAS_MERGE_ATTEMPTS refusals", async () => {
        const record = versioned(1, Number.POSITIVE_INFINITY);
        await expect(
            casMerge({
                read: record.read,
                merge: (fresh) => fresh,
                write: record.write,
                isConflict: (err) => err instanceof Conflict,
            }),
        ).rejects.toThrow(`under ${CAS_MERGE_ATTEMPTS} consecutive merges`);
        expect(record.box.reads).toBe(CAS_MERGE_ATTEMPTS);
    });
});

describe("mergePersistedState", () => {
    const fresh: PersistedUpload = { key: "k", createdAt: 1, isInvalidated: false, isComplete: false };

    test("the patch applies over the fresh record", () => {
        expect(mergePersistedState(fresh, { lastAppendAt: 5, length: 10, etag: "e" })).toEqual({
            ...fresh,
            lastAppendAt: 5,
            length: 10,
            etag: "e",
        });
    });

    test("a length and ETag the fresh record holds are kept over the patch", () => {
        const merged = mergePersistedState<PersistedUpload>(
            { ...fresh, length: 10, etag: "won" },
            { length: 99, etag: "stale" },
        );
        expect(merged).toMatchObject({ length: 10, etag: "won" });
    });

    test("a terminal flag the fresh record has set is never cleared", () => {
        const merged = mergePersistedState<PersistedUpload>(
            { ...fresh, isInvalidated: true, isComplete: true },
            { isInvalidated: false, isComplete: false },
        );
        expect(merged).toMatchObject({ isInvalidated: true, isComplete: true });
    });
});
