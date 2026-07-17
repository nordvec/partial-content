import { describe, test, expect } from "bun:test";
import type { FileHandle } from "node:fs/promises";
import { openWithRetry, isTransientOpenError } from "../open-retry";

/** A stand-in handle: identity is all the retry logic cares about. */
const HANDLE = { fake: true } as unknown as FileHandle;

function errno(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

describe("isTransientOpenError", () => {
    test("retries descriptor-exhaustion, share-violation, and try-again", () => {
        for (const code of ["EMFILE", "ENFILE", "EBUSY", "EAGAIN"]) {
            expect(isTransientOpenError(errno(code))).toBe(true);
        }
    });

    test("does NOT retry collision, missing-file, or permission faults", () => {
        for (const code of ["EEXIST", "ENOENT", "EACCES", "EPERM"]) {
            expect(isTransientOpenError(errno(code))).toBe(false);
        }
    });

    test("a non-errno error (no code) is not transient", () => {
        expect(isTransientOpenError(new Error("boom"))).toBe(false);
        expect(isTransientOpenError(undefined)).toBe(false);
    });
});

describe("openWithRetry", () => {
    test("returns immediately when the first open succeeds (no delay)", async () => {
        let calls = 0;
        const handle = await openWithRetry("/f", "wx", 5, 1000, async () => { calls++; return HANDLE; });
        expect(handle).toBe(HANDLE);
        expect(calls).toBe(1);
    });

    test("retries a transient failure and succeeds on a later attempt", async () => {
        let calls = 0;
        const opener = async (): Promise<FileHandle> => {
            calls++;
            if (calls < 3) throw errno("EBUSY");
            return HANDLE;
        };
        const handle = await openWithRetry("/f", "r+", 5, 1, opener);
        expect(handle).toBe(HANDLE);
        expect(calls).toBe(3);
    });

    test("rethrows a non-transient error on the FIRST attempt, never retrying", async () => {
        let calls = 0;
        const opener = async (): Promise<FileHandle> => { calls++; throw errno("EEXIST"); };
        await expect(openWithRetry("/f", "wx", 5, 1, opener)).rejects.toThrow("EEXIST");
        expect(calls).toBe(1);
    });

    test("gives up after `attempts` transient failures and rethrows the last", async () => {
        let calls = 0;
        const opener = async (): Promise<FileHandle> => { calls++; throw errno("EMFILE"); };
        await expect(openWithRetry("/f", "wx", 3, 1, opener)).rejects.toThrow("EMFILE");
        expect(calls).toBe(3);
    });
});
