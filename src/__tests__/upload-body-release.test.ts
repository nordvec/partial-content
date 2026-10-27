/**
 * Every exit releases the request body. Before the body reaches a store the
 * orchestrator cancels it; once a store holds it, the orchestrator hands the
 * store a `releaseBody` handle that works whether or not the store has locked
 * the stream, and calls it itself once `appendChunk` settles, so a store that
 * throws (a conflict, a backend error) or returns early cannot leave the peer
 * sending. The memory and fs stores release through the handle at the exits
 * where they never read the body.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";
import { fsUploadStore } from "../fs.ts";
import { UploadOffsetConflictError, type AppendChunkOptions, type ResumableWriteStore } from "../upload-store.ts";

const roots: string[] = [];
afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A body that never ends on its own, recording whether its producer was cancelled. */
function endless(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
        {
            pull(c) {
                c.enqueue(new Uint8Array(1));
            },
            cancel() {
                cancelled = true;
            },
        },
        { highWaterMark: 0 },
    );
    return { body, cancelled: () => cancelled };
}

async function withUpload(store: ResumableWriteStore) {
    const orch = createUploadOrchestrator(store, { graceMs: 0, onError: () => {} });
    const made = await orch.create({ key: () => "k", complete: false });
    if (made.kind !== "created") throw new Error(made.kind);
    return { orch, token: made.uploadToken };
}

describe("orchestrator releases a body the store took", () => {
    test("a store that throws without reading", async () => {
        const inner = memoryUploadStore({ objects: {} });
        const store: ResumableWriteStore = {
            ...inner,
            appendChunk: async (token) => {
                throw new Error(`backend down for ${token.length}`);
            },
        };
        const { orch, token } = await withUpload(store);
        const { body, cancelled } = endless();
        const out = await orch.append(token, { offset: 0, complete: false, body });
        expect(out.kind).toBe("store-error");
        expect(cancelled()).toBe(true);
    });

    test("a store that locks the body, reads a chunk, then refuses the claim", async () => {
        const inner = memoryUploadStore({ objects: {} });
        const store: ResumableWriteStore = {
            ...inner,
            appendChunk: async (token, _offset, body) => {
                if (!(body instanceof Uint8Array)) await body.getReader().read();
                throw new UploadOffsetConflictError(token, 0);
            },
        };
        const { orch, token } = await withUpload(store);
        const { body, cancelled } = endless();
        const out = await orch.append(token, { offset: 0, complete: false, body });
        expect(out.kind).toBe("offset-mismatch");
        expect(cancelled()).toBe(true);
    });

    test("releaseBody fails the next read, is idempotent, and never rejects", async () => {
        const inner = memoryUploadStore({ objects: {} });
        let seen: AppendChunkOptions | undefined;
        const store: ResumableWriteStore = {
            ...inner,
            appendChunk: async (_token, _offset, body, opts) => {
                seen = opts;
                if (body instanceof Uint8Array) throw new Error("expected a stream");
                const reader = body.getReader();
                await reader.read();
                await opts.releaseBody!();
                await opts.releaseBody!();
                // An error, never a clean end: a store reads a clean end as the
                // whole body and could publish the prefix.
                await expect(reader.read()).rejects.toBeInstanceOf(Error);
                return { bytesWritten: 0, interrupted: true };
            },
        };
        const { orch, token } = await withUpload(store);
        const { body, cancelled } = endless();
        await orch.append(token, { offset: 0, complete: false, body });
        expect(typeof seen?.releaseBody).toBe("function");
        expect(cancelled()).toBe(true);
    });
});

const stores: Array<[string, () => Promise<ResumableWriteStore>]> = [
    ["memory", async () => memoryUploadStore({ objects: {} })],
    [
        "fs",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "pc-release-"));
            roots.push(root);
            return fsUploadStore({ root });
        },
    ],
];

describe.each(stores)("the %s store releases through the handle", (_name, makeStore) => {
    test("an append to an unknown upload", async () => {
        const store = await makeStore();
        const made = await store.createUpload({ key: "k", now: 0 });
        await store.abortUpload(made.uploadToken);
        let released = 0;
        const { body } = endless();
        await store
            .appendChunk(made.uploadToken, 0, body, { now: 0, releaseBody: async () => void released++ })
            .catch(() => undefined);
        expect(released).toBeGreaterThan(0);
    });

    test("an append whose caller already yielded", async () => {
        const store = await makeStore();
        const made = await store.createUpload({ key: "k", now: 0 });
        let released = 0;
        const { body } = endless();
        const out = await store.appendChunk(made.uploadToken, 0, body, {
            now: 0,
            signal: AbortSignal.abort(),
            releaseBody: async () => void released++,
        });
        expect(out).toEqual({ bytesWritten: 0, interrupted: true });
        expect(released).toBeGreaterThan(0);
    });

    test("an append at a stale offset", async () => {
        const store = await makeStore();
        const made = await store.createUpload({ key: "k", now: 0 });
        let released = 0;
        const { body } = endless();
        await expect(
            store.appendChunk(made.uploadToken, 5, body, { now: 0, releaseBody: async () => void released++ }),
        ).rejects.toBeInstanceOf(UploadOffsetConflictError);
        expect(released).toBeGreaterThan(0);
    });
});
