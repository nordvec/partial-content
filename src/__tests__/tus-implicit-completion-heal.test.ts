/**
 * tus completion is implicit at offset == length, so a response showing that
 * offset tells the client it is done. When the publish that makes it true
 * fails, the response must say so instead of showing the offset, and a
 * creation that fails there must still name the resource it allocated.
 */
import { describe, test, expect } from "bun:test";
import { createTusHandler } from "../tus.ts";
import { memoryUploadStore, type MemoryObject } from "../memory.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

function flakyPublishStore() {
    const objects: Record<string, MemoryObject> = {};
    const inner = memoryUploadStore({ objects });
    const state = { failPublish: true, interruptAppends: false };
    const store: ResumableWriteStore = {
        ...inner,
        async appendChunk(token, offset, body, opts) {
            const out = await inner.appendChunk(token, offset, body, opts);
            return state.interruptAppends && out.bytesWritten > 0 ? { ...out, interrupted: true } : out;
        },
        async completeUpload(token, opts) {
            if (state.failPublish) throw new Error("backend refused the publish");
            return inner.completeUpload(token, opts);
        },
    };
    const handler = createTusHandler(store, {
        key: () => "k",
        location: (t) => `/files/${t}`,
        resolveToken: (req) => new URL(req.url).pathname.split("/")[2],
        policy: { maxSize: 1024 },
        graceMs: 0,
        onError: () => undefined,
    });
    return { handler, objects, state };
}

const tus = { "Tus-Resumable": "1.0.0" };

function post(headers: Record<string, string>, body?: string): Request {
    return new Request("http://localhost/files", { method: "POST", headers: { ...tus, ...headers }, body });
}

function patch(token: string, offset: number, body: string): Request {
    return new Request(`http://localhost/files/${token}`, {
        method: "PATCH",
        headers: {
            ...tus,
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(body.length),
        },
        body,
    });
}

const head = (token: string) => new Request(`http://localhost/files/${token}`, { method: "HEAD", headers: tus });

describe("implicit completion that fails to publish", () => {
    test("HEAD answers a bodiless failure instead of offset == length, then reports done once it publishes", async () => {
        const { handler, objects, state } = flakyPublishStore();
        const created = await handler(post({ "Upload-Length": "3" }));
        const token = created.headers.get("Location")!.split("/").pop()!;
        expect((await handler(patch(token, 0, "abc"))).status).toBe(502);

        const failed = await handler(head(token));
        expect(failed.status).toBe(502);
        expect(failed.headers.get("Upload-Offset")).toBeNull();
        expect(await failed.text()).toBe("");
        expect(objects["k"]).toBeUndefined();

        state.failPublish = false;
        const healed = await handler(head(token));
        expect(healed.status).toBe(200);
        expect(healed.headers.get("Upload-Offset")).toBe("3");
        expect(objects["k"]).toBeDefined();
    });

    test("a creation whose implicit publish fails answers the failure with the resource's Location", async () => {
        const { handler, state } = flakyPublishStore();
        state.interruptAppends = true;
        const res = await handler(
            post(
                {
                    "Upload-Length": "3",
                    "Content-Type": "application/offset+octet-stream",
                    "Content-Length": "3",
                },
                "abc",
            ),
        );
        expect(res.status).toBe(502);
        const location = res.headers.get("Location");
        expect(location).toMatch(/^\/files\//);

        state.failPublish = false;
        const token = location!.split("/").pop()!;
        const probe = await handler(head(token));
        expect(probe.status).toBe(200);
        expect(probe.headers.get("Upload-Offset")).toBe("3");
    });
});
