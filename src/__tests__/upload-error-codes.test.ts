/**
 * Every upload error class carries a stable `code` a consumer can switch on
 * without parsing a message, every matcher is a type guard, and the store
 * contract has a version a store can declare and the orchestrator checks.
 */
import { describe, test, expect } from "bun:test";
import {
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
    UploadLockTimeoutError,
    isUploadNotFoundError,
    isUploadDigestMismatchError,
    isUploadLockTimeoutError,
    createUploadOrchestrator,
    UPLOAD_STORE_CONTRACT_VERSION,
    type UploadErrorCode,
} from "../upload.ts";
import { memoryUploadStore } from "../memory.ts";

describe("upload error codes", () => {
    test("each class names its own stable code", () => {
        const codes: Array<[Error & { code: UploadErrorCode }, UploadErrorCode]> = [
            [new UploadNotFoundError("t"), "UPLOAD_NOT_FOUND"],
            [new UploadOffsetConflictError("t", 1), "UPLOAD_OFFSET_CONFLICT"],
            [new UploadAppendBoundError("t", 1), "UPLOAD_APPEND_BOUND"],
            [new UploadOverrunError("t", 1), "UPLOAD_OVERRUN"],
            [new UploadDigestMismatchError("t", "sha-256", "x"), "UPLOAD_DIGEST_MISMATCH"],
            [new UploadLockTimeoutError("t"), "UPLOAD_LOCK_TIMEOUT"],
        ];
        for (const [err, code] of codes) expect(err.code).toBe(code);
    });

    test("the matchers narrow", () => {
        const err: unknown = new UploadDigestMismatchError("t", "sha-256", "expected", "actual");
        if (isUploadDigestMismatchError(err)) expect(err.expectedDigest).toBe("expected");
        else throw new Error("unmatched");
        const missing: unknown = new UploadNotFoundError("t");
        expect(isUploadNotFoundError(missing) && missing.status).toBe(404);
        const timeout: unknown = new UploadLockTimeoutError("t");
        expect(isUploadLockTimeoutError(timeout) && timeout.code).toBe("UPLOAD_LOCK_TIMEOUT");
    });
});

describe("store contract version", () => {
    test("a store declaring the current version is accepted, a different one refused", () => {
        expect(UPLOAD_STORE_CONTRACT_VERSION).toBe(1);
        const store = memoryUploadStore({ objects: {} });
        expect(store.contractVersion).toBe(UPLOAD_STORE_CONTRACT_VERSION);
        expect(() => createUploadOrchestrator(store)).not.toThrow();
        expect(() =>
            createUploadOrchestrator({ ...store, contractVersion: 2 as typeof UPLOAD_STORE_CONTRACT_VERSION }),
        ).toThrow(/contract version/);
    });
});
