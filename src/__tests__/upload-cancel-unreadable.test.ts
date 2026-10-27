/**
 * A cancel through the orchestrator discards an upload whose state cannot be
 * read, on every in-repo write store: the read only names the key, so a
 * missing or failing read never strands the bytes the client asked to delete.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";
import { fsUploadStore } from "../fs.ts";
import { UploadNotFoundError, isUploadNotFoundError, type ResumableWriteStore } from "../upload-store.ts";

const roots: string[] = [];
afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
});

const stores: Array<[string, () => Promise<ResumableWriteStore>]> = [
    ["memory", async () => memoryUploadStore({ objects: {} })],
    [
        "fs",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "pc-cancel-"));
            roots.push(root);
            return fsUploadStore({ root });
        },
    ],
];

const failures: Array<[string, (token: string) => Error]> = [
    ["not found", (token) => new UploadNotFoundError(token)],
    ["a backend error", () => new Error("throttled")],
];

describe.each(stores)("cancel with an unreadable state on the %s store", (_name, makeStore) => {
    test.each(failures)(
        "a read failing with %s still discards the upload",
        async (_label: string, failure: (token: string) => Error) => {
            const inner = await makeStore();
            const store: ResumableWriteStore = {
                ...inner,
                getUploadState: async (token) => Promise.reject(failure(token)),
            };
            const writer = createUploadOrchestrator(inner, { graceMs: 0 });
            const created = await writer.create({
                key: () => "doc.bin",
                complete: false,
                contentLength: 3,
                body: new TextEncoder().encode("abc"),
            });
            if (created.kind !== "created") throw new Error(`setup failed: ${created.kind}`);

            await createUploadOrchestrator(store, { graceMs: 0 }).cancel(created.uploadToken);

            const after = await inner.getUploadState(created.uploadToken).catch((err: unknown) => err);
            expect(isUploadNotFoundError(after)).toBe(true);
        },
    );
});
