/**
 * A creation announces its resource as soon as it exists, before the body
 * streams: the orchestrator's `onAllocated` fires once the token is minted and
 * its audit key resolved, and the IETF dialect's `onResumptionSupported`
 * rides it with the headers a `104 (Upload Resumption Supported)` interim
 * response carries, `Upload-Limit` included where the version announces it.
 */
import { describe, test, expect } from "bun:test";
import { memoryUploadStore } from "../memory.ts";
import { createUploadOrchestrator } from "../upload-shared.ts";
import { createUploadHandler } from "../upload.ts";

const enc = new TextEncoder();

/** A body that records, at its first read, what the probe reports; nothing is pulled before a read. */
function observedBody(probe: () => number): { body: ReadableStream<Uint8Array>; seenAtFirstRead: number[] } {
    const seenAtFirstRead: number[] = [];
    let sent = false;
    const body = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (sent) {
                    controller.close();
                    return;
                }
                sent = true;
                seenAtFirstRead.push(probe());
                controller.enqueue(enc.encode("abc"));
            },
        },
        { highWaterMark: 0 },
    );
    return { body, seenAtFirstRead };
}

function request(url: string, init: RequestInit & { duplex?: "half" }): Request {
    return new Request(url, init);
}

describe("orchestrator onAllocated", () => {
    test("fires with the minted token before the body is read", async () => {
        const tokens: string[] = [];
        const orch = createUploadOrchestrator(memoryUploadStore({ objects: {} }), { graceMs: 0 });
        const { body, seenAtFirstRead } = observedBody(() => tokens.length);
        const out = await orch.create({
            key: () => "k",
            complete: false,
            body,
            onAllocated: (t) => tokens.push(t),
        });
        if (out.kind !== "created") throw new Error(out.kind);
        expect(tokens).toEqual([out.uploadToken]);
        expect(seenAtFirstRead).toEqual([1]);
    });

    test("is not called for a creation refused before a resource exists", async () => {
        const calls: string[] = [];
        const orch = createUploadOrchestrator(memoryUploadStore({ objects: {} }), {
            graceMs: 0,
            policy: { maxSize: 2 },
        });
        const refusedByPolicy = await orch.create({
            key: () => "k",
            declaredLength: 10,
            complete: false,
            onAllocated: (t) => calls.push(t),
        });
        expect(refusedByPolicy.kind).not.toBe("created");
        const refusedByKey = await orch.create({
            key: () => new Response(null, { status: 403 }),
            complete: false,
            onAllocated: (t) => calls.push(t),
        });
        expect(refusedByKey.kind).toBe("refused");
        expect(calls).toEqual([]);
    });

    test("a throwing hook is reported under the audit key and the creation proceeds", async () => {
        const reports: Array<{ err: unknown; operation: string; uploadToken?: string; auditKey?: string }> = [];
        const orch = createUploadOrchestrator(memoryUploadStore({ objects: {} }), {
            graceMs: 0,
            onError: (err, ctx) => reports.push({ err, ...ctx }),
        });
        let minted = "";
        const out = await orch.create({
            key: () => "k",
            complete: true,
            body: enc.encode("abc"),
            auditKey: () => "doc-1",
            onAllocated: (t) => {
                minted = t;
                throw new Error(`cannot announce ${t}`);
            },
        });
        expect(out.kind).toBe("created");
        expect(reports).toHaveLength(1);
        expect(reports[0]!.operation).toBe("allocated-hook");
        expect(reports[0]!.auditKey).toBe("doc-1");
        expect(JSON.stringify(reports[0])).not.toContain(minted);
    });
});

describe("IETF onResumptionSupported", () => {
    function handlerWith(seen: Array<{ uploadToken: string; location: string; headers: Record<string, string> }>) {
        return createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/uploads/${t}`,
            policy: { maxSize: 1024 },
            graceMs: 0,
            onResumptionSupported: (info) => seen.push(info),
        });
    }

    test("fires before the creation body is read, with the 104 headers", async () => {
        const seen: Array<{ uploadToken: string; location: string; headers: Record<string, string> }> = [];
        const handler = handlerWith(seen);
        const { body, seenAtFirstRead } = observedBody(() => seen.length);
        const res = await handler(
            request("http://test/uploads", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?0" },
                body,
                duplex: "half",
            }),
        );
        expect(res.status).toBe(201);
        expect(seenAtFirstRead).toEqual([1]);
        expect(seen[0]!.location).toBe(res.headers.get("Location")!);
        expect(seen[0]!.headers).toEqual({
            "Upload-Draft-Interop-Version": "9",
            Location: res.headers.get("Location")!,
            "Upload-Limit": "max-size=1024, min-size=0",
        });
    });

    test("a version that announces no limits carries no Upload-Limit", async () => {
        const seen: Array<{ uploadToken: string; location: string; headers: Record<string, string> }> = [];
        const handler = handlerWith(seen);
        const res = await handler(
            request("http://test/uploads", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "6", "Upload-Complete": "?0" },
            }),
        );
        expect(res.status).toBe(201);
        expect(seen[0]!.headers).toEqual({
            "Upload-Draft-Interop-Version": "6",
            Location: res.headers.get("Location")!,
        });
    });
});
