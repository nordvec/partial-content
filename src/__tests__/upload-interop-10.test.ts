/**
 * Interop 10 (draft-ietf-httpbis-resumable-upload-13) is served alongside the
 * earlier revisions. Its one behavioral difference: a 2xx append answer with
 * `Upload-Complete: ?0` acknowledges that the whole request content was
 * received, so an append that stopped short is answered 409 with the durable
 * offset instead.
 *
 * At every IETF version, a request that STATES completion over a body that
 * ends cleanly short of the known length is the length inconsistency the draft
 * names, never a 2xx incomplete answer. tus completion is inferred, so a short
 * tus body still leaves the upload incomplete.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { createUploadHandler } from "../upload.ts";
import { createTusHandler } from "../tus.ts";
import type { ResumableWriteStore } from "../upload-store.ts";

const VERSION = "Upload-Draft-Interop-Version";
const enc = new TextEncoder();

/** Node's fetch requires `duplex` for a stream body; lib.dom does not declare it. */
function request(url: string, init: RequestInit & { duplex?: "half" }): Request {
    return new Request(url, init);
}

/** A body of undeclared size: no Content-Length reaches the handler. */
function chunked(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(c) {
            c.enqueue(enc.encode(text));
            c.close();
        },
    });
}

function ietf(store: ResumableWriteStore = memoryUploadStore({ objects: {} })) {
    return createUploadHandler(store, {
        key: () => "k",
        location: (t) => `/u/${t}`,
        policy: { maxSize: 1024 },
        graceMs: 0,
    });
}

async function createIncomplete(handler: ReturnType<typeof ietf>, version: string, length: number) {
    const res = await handler(
        request("http://test/u", {
            method: "POST",
            headers: { [VERSION]: version, "Upload-Complete": "?0", "Upload-Length": String(length) },
        }),
    );
    expect(res.status).toBe(201);
    return res.headers.get("Location")!.slice("/u/".length);
}

function append(version: string, offset: number, body: string | ReadableStream<Uint8Array>, complete: "?0" | "?1") {
    return request("http://test/u/x", {
        method: "PATCH",
        headers: {
            [VERSION]: version,
            "Upload-Offset": String(offset),
            "Upload-Complete": complete,
            "Content-Type": "application/partial-upload",
        },
        body,
        duplex: "half",
    });
}

describe("interop 10", () => {
    test("is offered by default and answers a creation", async () => {
        const handler = ietf();
        const res = await handler(
            request("http://test/u", {
                method: "POST",
                headers: { [VERSION]: "10", "Upload-Complete": "?1" },
                body: "abc",
            }),
        );
        expect(res.status).toBe(201);
        expect(res.headers.get(VERSION)).toBe("10");
    });

    test("an unsupported version is told the latest is 10", async () => {
        const res = await ietf()(request("http://test/u", { method: "POST", headers: { [VERSION]: "99" } }));
        expect(res.status).toBe(400);
        expect(res.headers.get(VERSION)).toBe("10");
    });

    test("an append that stopped short is 409 with the durable offset, not 204", async () => {
        const inner = memoryUploadStore({ objects: {} });
        const store: ResumableWriteStore = {
            ...inner,
            async appendChunk(token, offset, body, opts) {
                const out = await inner.appendChunk(token, offset, body, opts);
                return { ...out, interrupted: true };
            },
        };
        for (const [version, status] of [
            ["9", 204],
            ["10", 409],
        ] as const) {
            const handler = ietf(store);
            const token = await createIncomplete(handler, version, 10);
            const res = await handler(append(version, 0, "abc", "?0"), { uploadToken: token });
            expect(res.status).toBe(status);
            expect(res.headers.get("Upload-Offset")).toBe("3");
            expect(res.headers.get("Upload-Complete")).toBe("?0");
        }
    });
});

describe("a stated completion that ends short", () => {
    for (const version of ["9", "10"]) {
        test(`append at interop ${version} is 400 length-inconsistent, and the bytes stay resumable`, async () => {
            const handler = ietf();
            const token = await createIncomplete(handler, version, 10);
            const res = await handler(append(version, 0, chunked("abc"), "?1"), { uploadToken: token });
            expect(res.status).toBe(400);
            expect(await res.text()).toContain("inconsistent-upload-length");
            const head = await handler(
                request("http://test/u/x", { method: "HEAD", headers: { [VERSION]: version } }),
                { uploadToken: token },
            );
            expect(head.headers.get("Upload-Offset")).toBe("3");
        });

        test(`creation at interop ${version} is 400 length-inconsistent`, async () => {
            const res = await ietf()(
                request("http://test/u", {
                    method: "POST",
                    headers: { [VERSION]: version, "Upload-Complete": "?1", "Upload-Length": "10" },
                    body: chunked("abc"),
                    duplex: "half",
                }),
            );
            expect(res.status).toBe(400);
            expect(await res.text()).toContain("inconsistent-upload-length");
        });
    }

    test("tus completion is inferred: a short creation body leaves the upload incomplete", async () => {
        const handler = createTusHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/files/${t}`,
            resolveToken: (req) => new URL(req.url).pathname.split("/")[2],
            policy: { maxSize: 1024 },
        });
        const res = await handler(
            request("http://localhost/files", {
                method: "POST",
                headers: {
                    "Tus-Resumable": "1.0.0",
                    "Upload-Length": "10",
                    "Content-Type": "application/offset+octet-stream",
                },
                body: chunked("abc"),
                duplex: "half",
            }),
        );
        expect(res.status).toBe(201);
        expect(res.headers.get("Upload-Offset")).toBe("3");
    });
});
