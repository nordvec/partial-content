/**
 * A body stopped at the request's byte ceiling leaves its prefix durable, and
 * the 413 names where that prefix ends in both dialects, so the client
 * resumes from the answer instead of spending a probe to rediscover it.
 */
import { describe, test, expect } from "bun:test";
import { createTusHandler } from "../tus.ts";
import { createUploadHandler } from "../upload.ts";
import { memoryUploadStore } from "../memory.ts";

const POLICY = { maxSize: 1024, maxAppendSize: 4 };

/** A chunked body: no length indicator, so only the store can stop it. */
function chunked(text: string): ReadableStream<Uint8Array> {
    const data = new TextEncoder().encode(text);
    return new ReadableStream({
        start(ctl) {
            for (const byte of data) ctl.enqueue(Uint8Array.of(byte));
            ctl.close();
        },
    });
}

function patch(url: string, headers: Record<string, string>, text: string): Request {
    return new Request(url, { method: "PATCH", headers, body: chunked(text), duplex: "half" } as RequestInit);
}

describe("a 413 at the request's byte ceiling", () => {
    test("tus names the durable offset", async () => {
        const store = memoryUploadStore({ objects: {} });
        const handler = createTusHandler(store, {
            key: () => "k",
            location: (t) => `/files/${t}`,
            resolveToken: (req) => new URL(req.url).pathname.split("/")[2],
            policy: POLICY,
            graceMs: 0,
        });
        const created = await handler(
            new Request("http://localhost/files", {
                method: "POST",
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10" },
            }),
        );
        const location = created.headers.get("Location")!;
        const token = location.split("/").pop()!;

        const res = await handler(
            patch(
                `http://localhost${location}`,
                {
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": "0",
                    "Content-Type": "application/offset+octet-stream",
                },
                "abcdefghij",
            ),
        );

        expect(res.status).toBe(413);
        const durable = (await store.getUploadState(token)).offset;
        expect(res.headers.get("Upload-Offset")).toBe(String(durable));
    });

    test("IETF names the durable offset beside an incomplete marker", async () => {
        const store = memoryUploadStore({ objects: {} });
        const handler = createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/uploads/${t}`,
            policy: POLICY,
            graceMs: 0,
        });
        const created = await handler(
            new Request("http://localhost/uploads", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?0" },
            }),
        );
        const location = created.headers.get("Location")!;
        const token = location.split("/").pop()!;

        const res = await handler(
            patch(
                `http://localhost${location}`,
                {
                    "Upload-Draft-Interop-Version": "9",
                    "Upload-Offset": "0",
                    "Upload-Complete": "?0",
                    "Content-Type": "application/partial-upload",
                },
                "abcdefghij",
            ),
            { uploadToken: token },
        );

        expect(res.status).toBe(413);
        const durable = (await store.getUploadState(token)).offset;
        expect(res.headers.get("Upload-Offset")).toBe(String(durable));
        expect(res.headers.get("Upload-Complete")).toBe("?0");
    });

    test("a limit decided before any byte moved names no offset", async () => {
        const store = memoryUploadStore({ objects: {} });
        const handler = createUploadHandler(store, {
            key: () => "k",
            location: (t) => `/uploads/${t}`,
            policy: POLICY,
            graceMs: 0,
        });
        const res = await handler(
            new Request("http://localhost/uploads", {
                method: "POST",
                headers: {
                    "Upload-Draft-Interop-Version": "9",
                    "Upload-Complete": "?0",
                    "Upload-Length": "2048",
                },
            }),
        );

        expect(res.status).toBe(413);
        expect(res.headers.get("Upload-Offset")).toBeNull();
    });
});
