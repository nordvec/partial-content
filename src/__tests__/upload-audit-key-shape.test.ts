/**
 * Both upload dialects take one `auditKey` shape: a function of the request
 * and, once one exists, the upload token. A creation is asked first without a
 * token (a refusal before allocation) and then with the token the store
 * minted, so a creation's events can carry a key derived from either.
 */
import { describe, test, expect } from "bun:test";
import { createUploadHandler, type UploadAuditKey } from "../upload.ts";
import { createTusHandler } from "../tus.ts";
import { memoryUploadStore } from "../memory.ts";
import type { UploadResourceEvent } from "../upload-shared.ts";

function recorder() {
    const calls: Array<{ method: string; uploadToken?: string }> = [];
    const events: UploadResourceEvent[] = [];
    const auditKey: UploadAuditKey = ({ request, uploadToken }) => {
        calls.push({ method: request.method, uploadToken });
        return uploadToken === undefined ? undefined : `audit:${uploadToken.length}`;
    };
    return { calls, events, auditKey, onUploadEvent: (e: UploadResourceEvent) => events.push(e) };
}

describe("one auditKey shape across both dialects", () => {
    test("IETF: creation and probe both receive the request and the token", async () => {
        const r = recorder();
        const handler = createUploadHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/uploads/${t}`,
            policy: { maxSize: 1024 },
            graceMs: 0,
            auditKey: r.auditKey,
            onUploadEvent: r.onUploadEvent,
        });
        const created = await handler(
            new Request("http://test/uploads", {
                method: "POST",
                headers: { "Upload-Draft-Interop-Version": "9", "Upload-Complete": "?0" },
            }),
        );
        expect(created.status).toBe(201);
        const token = created.headers.get("Location")!.split("/").pop()!;
        await handler(
            new Request("http://test/uploads/x", { method: "HEAD", headers: { "Upload-Draft-Interop-Version": "9" } }),
            { uploadToken: token },
        );
        expect(r.calls.filter((c) => c.uploadToken === token).map((c) => c.method)).toEqual(["POST", "HEAD"]);
        expect(r.events.length).toBeGreaterThan(0);
        for (const e of r.events) expect(e.auditKey).toBe(`audit:${token.length}`);
    });

    test("tus: creation and probe both receive the request and the token", async () => {
        const r = recorder();
        const handler = createTusHandler(memoryUploadStore({ objects: {} }), {
            key: () => "k",
            location: (t) => `/files/${t}`,
            policy: { maxSize: 1024 },
            graceMs: 0,
            auditKey: r.auditKey,
            onUploadEvent: r.onUploadEvent,
        });
        const created = await handler(
            new Request("http://test/files", {
                method: "POST",
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "4" },
            }),
        );
        expect(created.status).toBe(201);
        const token = created.headers.get("Location")!.split("/").pop()!;
        await handler(new Request("http://test/files/x", { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }), {
            uploadToken: token,
        });
        expect(r.calls.filter((c) => c.uploadToken === token).map((c) => c.method)).toEqual(["POST", "HEAD"]);
        for (const e of r.events) expect(e.auditKey).toBe(`audit:${token.length}`);
    });
});
