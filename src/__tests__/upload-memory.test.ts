import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { serveObject } from "../web";
import {
    memoryStore,
    memoryUploadStore,
    ObjectNotFoundError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDigestMismatchError,
} from "../memory";
import {
    isUploadNotFoundError,
    isUploadOffsetConflictError,
    isUploadDigestMismatchError,
} from "../upload-store";
import type { MemoryObject } from "../memory";

const enc = new TextEncoder();

function sha256b64(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("base64");
}

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

/** A well-behaved stream delivering the given chunks, then closing. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else controller.close();
        },
    });
}

/** Delivers the chunks, then errors: a client that vanished mid-request. */
function tornStream(...chunks: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else controller.error(new Error("connection reset"));
        },
    });
}

/**
 * Delivers ONE chunk, then aborts the controller and never yields again.
 * The adapter must notice the abort between reads, not hang on the pull.
 */
function abortingStream(ac: AbortController, first: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(first));
        },
        pull() {
            ac.abort();
            return new Promise<void>(() => {
                // never settles: the abort signal is the only exit
            });
        },
    });
}

describe("memoryUploadStore: capability flags", () => {
    test("advertises exact offsets, atomic completion, sha-256, byte-exact appends", () => {
        const store = memoryUploadStore({ objects: {} });
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe("sha256");
        expect(store.appendGranularity).toBeUndefined();
        expect(store.uniformPartSize).toBeUndefined();
        expect(store.maxAppendSize).toBeUndefined();
    });
});

describe("memoryUploadStore: create / state / append / complete round trip", () => {
    test("full lifecycle publishes into the shared map and the read side serves it", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });

        const { uploadToken } = await store.createUpload({
            key: "docs/report.txt",
            length: 9,
            metadata: { filename: "report.txt" },
            now: 1_000,
        });
        expect(uploadToken.length).toBeGreaterThan(0);

        const fresh = await store.getUploadState(uploadToken);
        expect(fresh.offset).toBe(0);
        expect(fresh.length).toBe(9);
        expect(fresh.isComplete).toBe(false);
        expect(fresh.isInvalidated).toBe(false);
        expect(fresh.createdAt).toBe(1_000);
        expect(fresh.lastAppendAt).toBeUndefined();
        expect(fresh.metadata).toEqual({ filename: "report.txt" });

        const first = await store.appendChunk(uploadToken, 0, enc.encode("hello"), { now: 2_000 });
        expect(first.bytesWritten).toBe(5);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(5);
        expect(mid.lastAppendAt).toBe(2_000);

        const second = await store.appendChunk(uploadToken, 5, streamOf("wr", "ld"), { now: 3_000 });
        expect(second.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).offset).toBe(9);

        const done = await store.completeUpload(uploadToken, { now: 4_000 });
        expect(done.digest).toBe(sha256b64("hellowrld"));
        expect(done.etag).toBe(`"${sha256b64("hellowrld")}"`);

        const after = await store.getUploadState(uploadToken);
        expect(after.isComplete).toBe(true);
        expect(after.offset).toBe(9);

        // The read side serves the published object immediately.
        const reads = memoryStore({ objects });
        const meta = await reads.headObject("docs/report.txt");
        expect(meta.contentLength).toBe(9);
        expect(meta.etag).toBe(done.etag!);
        expect(meta.digest).toBe(done.digest!);
        expect(meta.lastModified).toBe(new Date(4_000).toUTCString());
        expect(await drain((await reads.getObject("docs/report.txt")).body)).toBe("hellowrld");
    });

    test("a published upload serves ranges end-to-end through the web adapter", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "video.bin", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("0123456789"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });

        const handler = serveObject(memoryStore({ objects }));
        const res = await handler(
            new Request("http://localhost/f", { headers: { Range: "bytes=2-4" } }),
            { key: "video.bin" },
        );
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("234");
        expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    });

    test("a zero-byte upload completes and serves", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: 10 });
        const done = await store.completeUpload(uploadToken, { now: 20 });
        expect(done.digest).toBe(sha256b64(""));

        const reads = memoryStore({ objects });
        const served = await reads.getObject("empty.bin");
        expect(served.contentLength).toBe(0);
        expect(await drain(served.body)).toBe("");
    });

    test("two creations issue distinct UUID tokens", async () => {
        const store = memoryUploadStore({ objects: {} });
        const a = await store.createUpload({ key: "a", now: 0 });
        const b = await store.createUpload({ key: "b", now: 0 });
        expect(a.uploadToken).not.toBe(b.uploadToken);
        // Where randomUUID exists (every supported runtime) the token IS a
        // UUID; the hex fallback is only for runtimes without it.
        expect(a.uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test("accepts empty options objects (no signal) on every read-only call", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        expect((await store.getUploadState(uploadToken, {})).offset).toBe(0);
        expect((await store.sweepExpired!(0, {})).removed).toBe(0);
        await store.abortUpload(uploadToken, {});
    });

    test("tokens still issue on runtimes without crypto.randomUUID", async () => {
        const original = globalThis.crypto.randomUUID;
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
        try {
            const store = memoryUploadStore({ objects: {} });
            const { uploadToken } = await store.createUpload({ key: "a", now: 0 });
            expect(uploadToken).toMatch(/^[0-9a-f]{32}$/);
            expect((await store.getUploadState(uploadToken)).offset).toBe(0);
        } finally {
            Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
        }
    });

    test("the store copies appended bytes: reusing the caller's buffer cannot rewrite history", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const buffer = enc.encode("AAAA");
        await store.appendChunk(uploadToken, 0, buffer, { now: 1 });
        buffer.fill(0x42); // caller reuses its buffer
        await store.completeUpload(uploadToken, { now: 2 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("AAAA");
    });
});

describe("memoryUploadStore: offset conflicts and dead resources", () => {
    test("a mismatched claimed offset throws with the durable offset attached", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abcde"), { now: 1 });

        const err = await store.appendChunk(uploadToken, 3, enc.encode("x"), { now: 2 }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(5);
        // Nothing landed: durable state is unchanged.
        expect((await store.getUploadState(uploadToken)).offset).toBe(5);
    });

    test("appending to a completed upload refuses with the final offset", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });

        const err = await store.appendChunk(uploadToken, 3, enc.encode("x"), { now: 3 }).catch((e) => e);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
    });

    test("unknown tokens answer UploadNotFoundError on every interaction", async () => {
        const store = memoryUploadStore({ objects: {} });
        const state = await store.getUploadState("nope").catch((e) => e);
        expect(state).toBeInstanceOf(UploadNotFoundError);
        expect(isUploadNotFoundError(state)).toBe(true);
        await expect(store.appendChunk("nope", 0, enc.encode("x"), { now: 0 }))
            .rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.completeUpload("nope", { now: 0 }))
            .rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

describe("memoryUploadStore: partial-write accounting", () => {
    test("a torn body reports the flushed prefix and fresh state agrees; resume then completes", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });

        const partial = await store.appendChunk(uploadToken, 0, tornStream("abc", "def"), { now: 1 });
        expect(partial.bytesWritten).toBe(6);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(6);
        expect(state.isInvalidated).toBe(false);

        // Resume exactly where durable truth says, then finish.
        await store.appendChunk(uploadToken, 6, enc.encode("ghi"), { now: 2 });
        await store.completeUpload(uploadToken, { expectedDigest: sha256b64("abcdefghi"), now: 3 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("abcdefghi");
    });

    test("an aborted signal mid-body keeps the flushed prefix and stays resumable", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const ac = new AbortController();

        const partial = await store.appendChunk(
            uploadToken, 0, abortingStream(ac, "abc"), { now: 1, signal: ac.signal },
        );
        expect(partial.bytesWritten).toBe(3);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);
        expect(state.isComplete).toBe(false);
        expect(state.isInvalidated).toBe(false);
    });

    test("a signal aborted before the call rejects without touching state", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const ac = new AbortController();
        ac.abort();
        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1, signal: ac.signal }),
        ).rejects.toThrow();
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("a zero-byte append is accepted and refreshes lastAppendAt", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(0), { now: 7 });
        expect(result.bytesWritten).toBe(0);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.lastAppendAt).toBe(7);
    });
});

describe("memoryUploadStore: maxBytes bound", () => {
    test("a body crossing the bound is truncated at it and the resource is invalidated", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });

        const result = await store.appendChunk(
            uploadToken, 0, enc.encode("0123456789"), { maxBytes: 4, now: 1 },
        );
        expect(result.bytesWritten).toBe(4);

        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.isInvalidated).toBe(true);

        // Every later interaction refuses.
        await expect(store.appendChunk(uploadToken, 4, enc.encode("x"), { now: 2 }))
            .rejects.toBeInstanceOf(UploadOffsetConflictError);
        await expect(store.completeUpload(uploadToken, { now: 3 })).rejects.toThrow(/invalidated/);
    });

    test("a stream crossing the bound mid-chunk keeps the exact prefix", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const result = await store.appendChunk(
            uploadToken, 0, streamOf("abc", "defg"), { maxBytes: 5, now: 1 },
        );
        expect(result.bytesWritten).toBe(5);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(5);
        expect(state.isInvalidated).toBe(true);
    });

    test("a body exactly at the bound is accepted whole and stays valid", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const result = await store.appendChunk(
            uploadToken, 0, enc.encode("abcd"), { maxBytes: 4, now: 1 },
        );
        expect(result.bytesWritten).toBe(4);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.isInvalidated).toBe(false);
        await store.completeUpload(uploadToken, { now: 2 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("abcd");
    });

    test("crossing the bound cancels the producer stream", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(enc.encode("0123456789"));
            },
            cancel() {
                cancelled = true;
            },
        });
        await store.appendChunk(uploadToken, 0, body, { maxBytes: 4, now: 1 });
        // The producer is told to stop; without the cancel it would sit on
        // an abandoned locked reader forever.
        expect(cancelled).toBe(true);
    });

    test("maxBytes 0 with a non-empty body invalidates without accepting a byte", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const result = await store.appendChunk(
            uploadToken, 0, enc.encode("abc"), { maxBytes: 0, now: 1 },
        );
        expect(result.bytesWritten).toBe(0);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.isInvalidated).toBe(true);
    });
});

describe("memoryUploadStore: digest verification at completion", () => {
    test("a matching asserted digest completes and is returned", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });
        const done = await store.completeUpload(uploadToken, {
            expectedDigest: sha256b64("payload"),
            now: 2,
        });
        expect(done.digest).toBe(sha256b64("payload"));
    });

    test("a mismatch throws with the actual digest and publishes NOTHING", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });

        const wrong = sha256b64("tampered");
        const err = await store.completeUpload(uploadToken, { expectedDigest: wrong, now: 2 }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadDigestMismatchError);
        expect(isUploadDigestMismatchError(err)).toBe(true);
        expect((err as UploadDigestMismatchError).expectedDigest).toBe(wrong);
        expect((err as UploadDigestMismatchError).actualDigest).toBe(sha256b64("payload"));

        // Atomic completion: nothing became visible to readers.
        expect(Object.hasOwn(objects, "k")).toBe(false);
        await expect(memoryStore({ objects }).headObject("k")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The resource is still alive; the orchestrator aborts it.
        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(false);
        expect(state.offset).toBe(7);
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("completion is idempotent: a retry answers the recorded facts", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        const first = await store.completeUpload(uploadToken, { now: 2 });
        const retry = await store.completeUpload(uploadToken, { now: 3 });
        expect(retry.digest).toBe(first.digest!);
        expect(retry.etag).toBe(first.etag!);
    });
});

describe("memoryUploadStore: publishing into a caller-owned plain-object map", () => {
    test('a "__proto__" key publishes an own entry, never prototype pollution', async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "__proto__", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("evil"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });

        expect(Object.hasOwn(objects, "__proto__")).toBe(true);
        expect(({} as { body?: unknown }).body).toBeUndefined(); // Object.prototype untouched
        expect(await drain((await memoryStore({ objects }).getObject("__proto__")).body)).toBe("evil");
    });

    test("published entries stay caller-mutable: overwrite, enumerate, delete", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "doc.txt", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("v1"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });

        // Enumerable: the documented map contract (inspection, iteration).
        expect(Object.keys(objects)).toContain("doc.txt");
        // Writable: the documented overwrite-simulation contract.
        objects["doc.txt"] = { body: "v2!", etag: '"v2"' };
        expect(await drain((await memoryStore({ objects }).getObject("doc.txt")).body)).toBe("v2!");
        // Configurable: the documented deletion contract.
        delete objects["doc.txt"];
        await expect(memoryStore({ objects }).getObject("doc.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("memoryUploadStore: abort and sweep", () => {
    test("abort is idempotent and unknown tokens are a no-op", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken); // second discard: no-op
        await store.abortUpload("never-existed");
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("aborting a completed upload discards the resource but not the published object", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        await store.completeUpload(uploadToken, { now: 2 });
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("abc");
    });

    test("sweep removes only resources idle since strictly before the cutoff", async () => {
        const store = memoryUploadStore({ objects: {} });
        const stale = await store.createUpload({ key: "stale", now: 1_000 });
        const active = await store.createUpload({ key: "active", now: 1_000 });
        // Activity moves the idle anchor from createdAt to lastAppendAt.
        await store.appendChunk(active.uploadToken, 0, enc.encode("x"), { now: 9_000 });

        const swept = await store.sweepExpired!(5_000);
        expect(swept.removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);

        // Boundary: idle exactly AT the cutoff is kept (idle since BEFORE it).
        expect((await store.sweepExpired!(9_000)).removed).toBe(0);
        expect((await store.sweepExpired!(9_001)).removed).toBe(1);
        await expect(store.getUploadState(active.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});
