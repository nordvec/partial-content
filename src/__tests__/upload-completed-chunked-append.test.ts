/**
 * An append to a completed upload is replayable only when it carries no byte
 * the representation does not already hold. A chunked body declares no size,
 * so whether it carries content is learned by reading as far as its first
 * byte: one that does is refused like a declared one, one that does not is
 * the retry the replay exists for.
 */
import { describe, test, expect } from "bun:test";
import { createUploadHandler } from "../upload.ts";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { memoryUploadStore } from "../memory.ts";

function chunked(...parts: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(ctl) {
            for (const part of parts) ctl.enqueue(new TextEncoder().encode(part));
            ctl.close();
        },
    });
}

async function completedUpload() {
    const store = memoryUploadStore({ objects: {} });
    const handler = createUploadHandler(store, {
        key: () => "k",
        location: (t) => `/uploads/${t}`,
        policy: { maxSize: 1024 },
        graceMs: 0,
    });
    const created = await handler(
        new Request("http://localhost/uploads", {
            method: "POST",
            headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?1", "Content-Length": "3" },
            body: "abc",
        }),
    );
    expect(created.status).toBe(201);
    const token = created.headers.get("Location")!.split("/").pop()!;
    const append = (body: ReadableStream<Uint8Array>) =>
        handler(
            new Request(`http://localhost/uploads/${token}`, {
                method: "PATCH",
                headers: {
                    "Upload-Draft-Interop-Version": "9",
                    "Upload-Offset": "3",
                    "Upload-Complete": "?1",
                    "Content-Type": "application/partial-upload",
                },
                body,
                duplex: "half",
            } as RequestInit),
            { uploadToken: token },
        );
    return { store, token, append };
}

describe("a chunked append to a completed upload", () => {
    test("carrying content is refused, never replayed", async () => {
        const { append } = await completedUpload();
        const res = await append(chunked("", "x"));
        expect(res.status).toBe(400);
    });

    test("carrying nothing is the replayable retry", async () => {
        const { append } = await completedUpload();
        const res = await append(chunked("", ""));
        expect(res.status).toBe(200);
        expect(res.headers.get("Upload-Complete")).toBe("?1");
    });

    test("the orchestrator answers length-inconsistent and cancels the body", async () => {
        const store = memoryUploadStore({ objects: {} });
        const writer = createUploadOrchestrator(store, { graceMs: 0 });
        const created = await writer.create({
            key: () => "k",
            complete: true,
            contentLength: 3,
            body: new TextEncoder().encode("abc"),
        });
        if (created.kind !== "created") throw new Error(`setup failed: ${created.kind}`);
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(ctl) {
                ctl.enqueue(Uint8Array.of(1));
            },
            cancel() {
                cancelled = true;
            },
        });

        const out = await writer.append(created.uploadToken, { offset: 3, complete: true, body });

        expect(out.kind).toBe("length-inconsistent");
        expect(cancelled).toBe(true);
    });
});
