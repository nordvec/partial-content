/**
 * Upload lifecycle is one `status` field, so "complete and invalidated" is not
 * a state a store can report. Persisted flag pairs project onto it with
 * invalidation winning, since a dead resource refuses every later request.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { uploadStatus } from "../upload-internals.ts";
import type { StoredUploadState, UploadStatus } from "../upload.ts";
import { completeDurable } from "./helpers";

describe("upload status", () => {
    test("persisted flags project onto exactly one status", () => {
        const cases: Array<[boolean, boolean, UploadStatus]> = [
            [false, false, "incomplete"],
            [true, false, "complete"],
            [false, true, "invalidated"],
            [true, true, "invalidated"],
        ];
        for (const [isComplete, isInvalidated, status] of cases) {
            expect(uploadStatus({ isComplete, isInvalidated })).toBe(status);
        }
    });

    test("a store reports status through the lifecycle, and no boolean flags", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 1 });
        const fresh: StoredUploadState = await store.getUploadState(uploadToken);
        expect(fresh.status).toBe("incomplete");
        expect(Object.keys(fresh)).not.toContain("isComplete");
        expect(Object.keys(fresh)).not.toContain("isInvalidated");
        await store.appendChunk(uploadToken, 0, new TextEncoder().encode("ab"), { now: 2 });
        await completeDurable(store, uploadToken, { now: 3 });
        expect((await store.getUploadState(uploadToken)).status).toBe("complete");
    });
});
