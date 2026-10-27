/**
 * Under an audit key, an upload failure reaches `onError` as the same
 * allow-listed projection the serving side hands its sink: name, code, status,
 * operation and a projected cause. The message, the stack and every other
 * property stay behind, so neither the token nor the key reaches the sink in
 * any spelling a search would have to know about.
 */
import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { createUploadHandler } from "../upload.ts";
import { memoryUploadStore } from "../memory.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

const KEY = "users/alice/tax-return.pdf";

function failingStore(): ResumableWriteStore {
    const real = memoryUploadStore({ objects: {} });
    return {
        ...real,
        async appendChunk(token) {
            throw Object.assign(new Error(`write failed for ${encodeURIComponent(KEY)}`), {
                code: "EIO",
                status: 503,
                request: { url: `https://backend/${token}` },
                cause: Object.assign(new Error(`socket closed: ${token}`), { name: "SocketError", code: 32 }),
            });
        },
    };
}

describe("upload onError under an audit key receives a projected error", () => {
    test("the orchestrator projects the error on the sink and on the store-error outcome", async () => {
        const seen: unknown[] = [];
        const o = createUploadOrchestrator(failingStore(), {
            policy: { maxSize: 1024 },
            graceMs: 0,
            onError: (err) => seen.push(err),
        });
        const out = await o.create({
            key: () => KEY,
            complete: true,
            body: new TextEncoder().encode("payload"),
            auditKey: "doc-7",
        });
        const projected = {
            name: "Error",
            code: "EIO",
            status: 503,
            operation: "append",
            cause: { name: "SocketError", code: 32 },
        };
        expect(seen).toEqual([projected]);
        expect(out).toMatchObject({ kind: "store-error", error: projected });
    });

    test("without an audit key the raw error arrives unchanged", async () => {
        const seen: unknown[] = [];
        const o = createUploadOrchestrator(failingStore(), {
            policy: { maxSize: 1024 },
            graceMs: 0,
            onError: (err) => seen.push(err),
        });
        await o.create({ key: () => KEY, complete: true, body: new TextEncoder().encode("payload") });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeInstanceOf(Error);
        expect((seen[0] as Error).message).toContain(encodeURIComponent(KEY));
    });

    test("a throwing resumption hook reaches the sink projected, with its operation", async () => {
        const seen: unknown[] = [];
        const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => KEY,
            location: (t) => `/uploads/${t}`,
            policy: { maxSize: 1024 },
            graceMs: 0,
            auditKey: () => "doc-7",
            onResumptionSupported: ({ location }) => {
                throw new TypeError(`cannot announce ${location}`);
            },
            onError: (err) => seen.push(err),
        });
        const res = await handler(
            new Request("http://test/uploads", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?0" },
            }),
        );
        expect(res.status).toBe(201);
        expect(seen).toEqual([{ name: "TypeError", operation: "resumption-hook" }]);
    });
});
