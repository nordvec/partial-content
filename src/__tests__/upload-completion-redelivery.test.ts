/**
 * The completion hook is at-least-once, and a client that follows either
 * protocol recovers a lost completion answer with an offset probe, not by
 * repeating its completing request. So the probe is a delivery path: a
 * completed resource whose report has not resolved in this process is
 * reported again before the probe answers, and a hook that throws answers a
 * server error the client retries, exactly as the completing append does.
 */
import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator } from "../upload-orchestrator.ts";
import { createUploadHandler } from "../upload.ts";
import { createTusHandler } from "../tus.ts";
import { memoryUploadStore } from "../memory.ts";

const NOW = 1_800_000_000_000;

function flakyHook() {
    const landed: string[] = [];
    let failures = 1;
    return {
        landed,
        hook: (info: { key: string }) => {
            if (failures > 0) {
                failures--;
                throw new Error("records database unavailable");
            }
            landed.push(info.key);
        },
    };
}

describe("probe re-delivers a completion report whose first delivery failed", () => {
    test("orchestrator: the probe delivers once, then stops", async () => {
        const { landed, hook } = flakyHook();
        const o = createUploadOrchestrator(memoryUploadStore({ objects: {} }), {
            policy: { maxSize: 1024 },
            now: () => NOW,
            graceMs: 0,
            onUploadComplete: hook,
            onError: () => {},
        });
        const out = await o.create({ key: () => "k", complete: true, body: new TextEncoder().encode("payload") });
        expect(out.kind).toBe("store-error");
        if (out.kind !== "store-error" || out.uploadToken === undefined) throw new Error("no token");

        const probed = await o.probe(out.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", complete: true, offset: 7 });
        expect(landed).toEqual(["k"]);

        // A resolved delivery is not repeated on later probes.
        await o.probe(out.uploadToken);
        expect(landed).toEqual(["k"]);
    });

    test("orchestrator: a probe whose delivery throws answers a store error, and the next probe delivers", async () => {
        const landed: string[] = [];
        let failures = 2;
        const o = createUploadOrchestrator(memoryUploadStore({ objects: {} }), {
            policy: { maxSize: 1024 },
            now: () => NOW,
            graceMs: 0,
            onUploadComplete: (info) => {
                if (failures-- > 0) throw new Error("records database unavailable");
                landed.push(info.key);
            },
            onError: () => {},
        });
        const out = await o.create({ key: () => "k", complete: true, body: new TextEncoder().encode("abc") });
        if (out.kind !== "store-error" || out.uploadToken === undefined) throw new Error("no token");
        const first = await o.probe(out.uploadToken);
        expect(first).toMatchObject({ kind: "store-error", uploadToken: out.uploadToken });
        expect(landed).toEqual([]);
        expect(await o.probe(out.uploadToken)).toMatchObject({ kind: "probed", complete: true });
        expect(landed).toEqual(["k"]);
    });

    test("IETF: HEAD after a failed completion hook re-delivers, and a failing HEAD answers 500", async () => {
        const landed: string[] = [];
        let failures = 2;
        const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => "doc.bin",
            location: (t) => `/uploads/${t}`,
            policy: { maxSize: 1024 },
            now: () => NOW,
            graceMs: 0,
            onUploadComplete: (info) => {
                if (failures-- > 0) throw new Error("records database unavailable");
                landed.push(info.key);
            },
            onError: () => {},
        });
        const created = await handler(
            new Request("http://test/upload", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?1" },
                body: new TextEncoder().encode("payload"),
            }),
        );
        expect(created.status).toBe(500);
        const token = created.headers.get("Location")!.split("/").pop()!;
        const head = () =>
            handler(
                new Request("http://test/uploads/x", {
                    method: "HEAD",
                    headers: { "Upload-Draft-Interop-Version": "9" },
                }),
                { uploadToken: token },
            );

        // The same status the completing request answered for the same fault.
        expect((await head()).status).toBe(500);
        expect(landed).toEqual([]);
        const ok = await head();
        expect(ok.status).toBe(204);
        expect(ok.headers.get("Upload-Complete")).toBe("?1");
        expect(landed).toEqual(["doc.bin"]);
    });

    test("tus: HEAD after a failed completion hook re-delivers, and a failing HEAD answers 502", async () => {
        const landed: string[] = [];
        let failures = 2;
        const handler = createTusHandler(memoryUploadStore({ objects: {} }), {
            key: () => "server-key.bin",
            location: (t) => `/files/${t}`,
            policy: { maxSize: 1024 },
            now: () => NOW,
            graceMs: 0,
            onUploadComplete: (info) => {
                if (failures-- > 0) throw new Error("records database unavailable");
                landed.push(info.key);
            },
            onError: () => {},
        });
        const created = await handler(
            new Request("http://localhost/files", {
                method: "POST",
                headers: {
                    "Tus-Resumable": "1.0.0",
                    "Upload-Length": "7",
                    "Content-Type": "application/offset+octet-stream",
                    "Content-Length": "7",
                },
                body: new TextEncoder().encode("payload"),
            }),
        );
        expect(created.status).toBe(502);
        const token = created.headers.get("Location")!.split("/").pop()!;
        const head = () =>
            handler(
                new Request("http://localhost/files/x", { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }),
                {
                    uploadToken: token,
                },
            );

        expect((await head()).status).toBe(502);
        expect(landed).toEqual([]);
        const ok = await head();
        expect(ok.status).toBe(200);
        expect(ok.headers.get("Upload-Offset")).toBe("7");
        expect(landed).toEqual(["server-key.bin"]);
    });
});
