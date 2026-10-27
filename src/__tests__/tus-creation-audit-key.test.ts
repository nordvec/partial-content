/**
 * With an audit key configured, the raw upload token reaches no reporting
 * surface, creation included. A creation's events fire once the store has
 * minted the token, so the audit key is resolved from that token before any
 * of them is reported, and the follow-up publish a tus creation may run
 * reports under the same key.
 */
import { describe, test, expect } from "bun:test";
import { createTusHandler } from "../tus.ts";
import { memoryUploadStore } from "../memory.ts";
import type { ResumableWriteStore } from "../upload-store.ts";
import type { UploadResourceEvent } from "../upload-orchestrator.ts";

const NOW = 1_800_000_000_000;

function creation(body: string, headers: Record<string, string> = {}): Request {
    const bytes = new TextEncoder().encode(body);
    return new Request("http://localhost/files", {
        method: "POST",
        headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Length": String(bytes.byteLength),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(bytes.byteLength),
            ...headers,
        },
        body: bytes,
    });
}

function recordingHandler(store: ResumableWriteStore) {
    const events: UploadResourceEvent[] = [];
    const errors: Array<{ error: unknown; context: unknown }> = [];
    const handler = createTusHandler(store, {
        key: () => "server-key.bin",
        location: (t) => `/files/${t}`,
        policy: { maxSize: 1024 },
        now: () => NOW,
        graceMs: 0,
        auditKey: ({ uploadToken }) => (uploadToken === undefined ? undefined : `audit-${uploadToken.length}`),
        onUploadEvent: (e) => events.push(e),
        onError: (error, context) => errors.push({ error, context }),
    });
    return { handler, events, errors };
}

function tokenOf(res: Response): string {
    return res.headers.get("Location")!.split("/").pop()!;
}

function serialized(value: unknown): string {
    return JSON.stringify(value, (_k, v: unknown) =>
        v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause } : v,
    );
}

describe("tus creation with an audit key", () => {
    test("creation events carry the audit key and never the token", async () => {
        const { handler, events } = recordingHandler(memoryUploadStore({ objects: {} }));
        const res = await handler(creation("payload"));
        expect(res.status).toBe(201);
        const token = tokenOf(res);
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
            expect(e.uploadToken).toBeUndefined();
            expect(e.auditKey).toBe("audit-36");
        }
        expect(serialized(events)).not.toContain(token);
    });

    test("a creation whose publish fails reports the error without the token", async () => {
        const inner = memoryUploadStore({ objects: {} });
        const store: ResumableWriteStore = {
            ...inner,
            async completeUpload(token) {
                throw new Error(`backend refused staging object for ${token}`);
            },
        };
        const { handler, events, errors } = recordingHandler(store);
        const res = await handler(creation("payload"));
        expect(res.status).toBe(502);
        const token = tokenOf(res);
        expect(errors.length).toBeGreaterThan(0);
        expect(serialized(errors)).not.toContain(token);
        expect(serialized(events)).not.toContain(token);
    });

    test("the implicit-completion publish after an interrupted creation reports under the audit key", async () => {
        const inner = memoryUploadStore({ objects: {} });
        let failPublish = false;
        const store: ResumableWriteStore = {
            ...inner,
            // Every byte lands but the write reports an interruption, so the tus
            // creation finishes the upload with a follow-up publish.
            async appendChunk(token, offset, body, opts) {
                const out = await inner.appendChunk(token, offset, body, opts);
                failPublish = true;
                return { ...out, interrupted: out.bytesWritten > 0 ? true : out.interrupted };
            },
            async completeUpload(token, opts) {
                if (failPublish) throw new Error(`publish failed for ${token}`);
                return inner.completeUpload(token, opts);
            },
        };
        const { handler, events, errors } = recordingHandler(store);
        const res = await handler(creation("payload"));
        expect(res.status).toBe(502);
        expect(errors.length).toBeGreaterThan(0);
        const all = serialized({ events, errors });
        // The token is a UUID; none of it may appear anywhere reported.
        expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        for (const e of events) expect(e.auditKey).toBe("audit-36");
    });
});
