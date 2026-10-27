/**
 * Every storage call an append or creation makes on the client's behalf runs
 * under the grace window, not only the body write: a client that vanished
 * while its request waited for the lock, or right after its last byte landed,
 * still has its received bytes recorded and its completion published.
 */
import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A memory store whose request aborts the moment a body write returns. */
function abortingAfterWrite(ctl: AbortController): ResumableWriteStore {
    const inner = memoryUploadStore({ objects: {} });
    return {
        ...inner,
        appendChunk: async (token, offset, body, opts) => {
            const written = await inner.appendChunk(token, offset, body, opts);
            ctl.abort();
            return written;
        },
    };
}

describe("the grace window covers every storage call of a request", () => {
    test("an append whose client left while it waited reads its state and records its bytes", async () => {
        const writer = createUploadOrchestrator(memoryUploadStore({ objects: {} }), { graceMs: 1_000 });
        const created = await writer.create({ key: () => "doc.bin", complete: false, declaredLength: 6 });
        if (created.kind !== "created") throw new Error(`setup failed: ${created.kind}`);
        const ctl = new AbortController();
        ctl.abort();

        const out = await writer.append(created.uploadToken, {
            offset: 0,
            complete: false,
            contentLength: 3,
            body: bytes("abc"),
            signal: ctl.signal,
        });

        expect(out).toMatchObject({ kind: "appended", offset: 3 });
    });

    test("an append whose client left after its last byte still publishes", async () => {
        const ctl = new AbortController();
        const writer = createUploadOrchestrator(abortingAfterWrite(ctl), { graceMs: 1_000 });
        const created = await writer.create({ key: () => "doc.bin", complete: false });
        if (created.kind !== "created") throw new Error(`setup failed: ${created.kind}`);

        const out = await writer.append(created.uploadToken, {
            offset: 0,
            complete: true,
            contentLength: 3,
            body: bytes("abc"),
            signal: ctl.signal,
        });

        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true });
    });

    test("a creation whose client left after its last byte still publishes", async () => {
        const ctl = new AbortController();
        const writer = createUploadOrchestrator(abortingAfterWrite(ctl), { graceMs: 1_000 });

        const out = await writer.create({
            key: () => "doc.bin",
            complete: true,
            contentLength: 3,
            body: bytes("abc"),
            signal: ctl.signal,
        });

        expect(out).toMatchObject({ kind: "created", complete: true });
    });

    test("without a grace window the abort still reaches the store", async () => {
        const writer = createUploadOrchestrator(memoryUploadStore({ objects: {} }), { graceMs: 0 });
        const created = await writer.create({ key: () => "doc.bin", complete: false });
        if (created.kind !== "created") throw new Error(`setup failed: ${created.kind}`);
        const ctl = new AbortController();
        ctl.abort();

        const out = await writer.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bytes("abc"),
            signal: ctl.signal,
        });

        expect(out.kind).not.toBe("appended");
    });
});
