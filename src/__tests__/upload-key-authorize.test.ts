/**
 * The creation key resolver runs only after the policy accepts the creation,
 * may be async, sees the declared length and the effective policy, and answers
 * a key, a key with the metadata to record, or a Response that refuses the
 * creation as-is. Resource requests pass a per-upload `authorize` hook that
 * sees the stored key and metadata before anything is read or written on the
 * client's behalf, and a Response from it is the answer.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { createUploadHandler } from "../upload.ts";
import { createTusHandler } from "../tus.ts";
import type { ResumableWriteStore, UploadAuthorizeContext } from "../upload-shared.ts";

const VERSION = "Upload-Draft-Interop-Version";
const TUS = { "Tus-Resumable": "1.0.0" };

function countingStore() {
    const inner = memoryUploadStore({ objects: {} });
    const created: string[] = [];
    const store: ResumableWriteStore = {
        ...inner,
        async createUpload(opts) {
            created.push(opts.key);
            return inner.createUpload(opts);
        },
    };
    return { store, created };
}

describe("creation key resolver", () => {
    test("IETF: not called when the policy refuses the creation", async () => {
        const { store, created } = countingStore();
        let calls = 0;
        const handler = createUploadHandler(store, {
            key: () => {
                calls++;
                return "k";
            },
            location: (t) => `/u/${t}`,
            policy: { maxSize: 4 },
        });
        const res = await handler(
            new Request("http://test/u", {
                method: "POST",
                headers: { [VERSION]: "9", "Upload-Complete": "?0", "Upload-Length": "100" },
            }),
        );
        expect(res.status).toBe(413);
        expect(calls).toBe(0);
        expect(created).toEqual([]);
    });

    test("tus: not called when the policy refuses the creation", async () => {
        const { store, created } = countingStore();
        let calls = 0;
        const handler = createTusHandler(store, {
            key: () => {
                calls++;
                return "k";
            },
            location: (t) => `/files/${t}`,
            policy: { maxSize: 4 },
        });
        const res = await handler(
            new Request("http://localhost/files", { method: "POST", headers: { ...TUS, "Upload-Length": "100" } }),
        );
        expect(res.status).toBe(413);
        expect(calls).toBe(0);
        expect(created).toEqual([]);
    });

    test("IETF: an async resolver sees the length and policy and chooses the recorded metadata", async () => {
        const { store, created } = countingStore();
        const seen: unknown[] = [];
        let published: Record<string, string> | undefined;
        const handler = createUploadHandler(store, {
            key: async (c) => {
                seen.push([c.declaredLength, c.policy.maxSize]);
                return { key: "tenant/obj", metadata: { owner: "u1" } };
            },
            location: (t) => `/u/${t}`,
            policy: { maxSize: 1024 },
            onUploadComplete: (info) => {
                published = info.metadata;
            },
        });
        const res = await handler(
            new Request("http://test/u", {
                method: "POST",
                headers: { [VERSION]: "9", "Upload-Complete": "?1", "Upload-Length": "3", "Content-Type": "a/b" },
                body: "abc",
            }),
        );
        expect(res.status).toBe(201);
        expect(seen).toEqual([[3, 1024]]);
        expect(created).toEqual(["tenant/obj"]);
        expect(published).toEqual({ owner: "u1" });
    });

    test("tus: a Response from the resolver is the answer and allocates nothing", async () => {
        const { store, created } = countingStore();
        const handler = createTusHandler(store, {
            key: async (c) => {
                expect(c.declaredLength).toBe(3);
                expect(c.policy.maxSize).toBe(1024);
                return new Response("quota exhausted", { status: 403 });
            },
            location: (t) => `/files/${t}`,
            policy: { maxSize: 1024 },
        });
        const res = await handler(
            new Request("http://localhost/files", { method: "POST", headers: { ...TUS, "Upload-Length": "3" } }),
        );
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("quota exhausted");
        expect(created).toEqual([]);
    });
});

describe("per-upload authorize", () => {
    test("IETF: a refusal answers probe, append and cancel without touching the upload", async () => {
        const seen: Omit<UploadAuthorizeContext, "request">[] = [];
        let allow = true;
        const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => ({ key: "k", metadata: { owner: "u1" } }),
            location: (t) => `/u/${t}`,
            policy: { maxSize: 1024 },
            authorize: ({ request: _request, ...ctx }) => {
                seen.push(ctx);
                return allow ? undefined : new Response(null, { status: 403 });
            },
        });
        const created = await handler(
            new Request("http://test/u", {
                method: "POST",
                headers: { [VERSION]: "9", "Upload-Complete": "?0", "Upload-Length": "10" },
            }),
        );
        const uploadToken = created.headers.get("Location")!.slice("/u/".length);
        const at = (method: string, headers: Record<string, string> = {}, body?: string) =>
            handler(new Request("http://test/u/x", { method, headers: { [VERSION]: "9", ...headers }, body }), {
                uploadToken,
            });
        const append = () =>
            at(
                "PATCH",
                { "Upload-Offset": "0", "Upload-Complete": "?0", "Content-Type": "application/partial-upload" },
                "abc",
            );

        allow = false;
        expect((await at("HEAD")).status).toBe(403);
        expect((await append()).status).toBe(403);
        expect((await at("DELETE")).status).toBe(403);
        allow = true;
        const head = await at("HEAD");
        expect(head.status).toBe(204);
        expect(head.headers.get("Upload-Offset")).toBe("0");
        expect(seen.map((s) => s.operation)).toEqual(["probe", "append", "cancel", "probe"]);
        expect(seen[0]).toEqual({ uploadToken, operation: "probe", key: "k", metadata: { owner: "u1" } });
    });

    test("tus: a refusal answers HEAD, PATCH and DELETE without touching the upload", async () => {
        let allow = true;
        const ops: string[] = [];
        const handler = createTusHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/files/${t}`,
            resolveToken: (req) => new URL(req.url).pathname.split("/")[2],
            policy: { maxSize: 1024 },
            authorize: ({ operation, key }) => {
                ops.push(`${operation}:${key}`);
                return allow ? undefined : new Response(null, { status: 403 });
            },
        });
        const created = await handler(
            new Request("http://localhost/files", { method: "POST", headers: { ...TUS, "Upload-Length": "10" } }),
        );
        const url = `http://localhost${created.headers.get("Location")}`;
        allow = false;
        expect((await handler(new Request(url, { method: "HEAD", headers: TUS }))).status).toBe(403);
        const patch = await handler(
            new Request(url, {
                method: "PATCH",
                headers: { ...TUS, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
                body: "abc",
            }),
        );
        expect(patch.status).toBe(403);
        expect((await handler(new Request(url, { method: "DELETE", headers: TUS }))).status).toBe(403);
        allow = true;
        const head = await handler(new Request(url, { method: "HEAD", headers: TUS }));
        expect(head.headers.get("Upload-Offset")).toBe("0");
        expect(ops).toEqual(["probe:k", "append:k", "cancel:k", "probe:k"]);
    });
});
