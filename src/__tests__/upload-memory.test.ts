import { describe, test, expect } from "bun:test";
import { drain, sha256b64, completeWithWrongDigest, streamOf, tornStream, completeDurable } from "./helpers";
import { serveObject } from "../web";
import {
    memoryStore,
    memoryUploadStore,
    ObjectNotFoundError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadAppendBoundError,
    UploadOverrunError,
    UploadDigestMismatchError,
} from "../memory";
import {
    UploadDestinationConflictError,
    isUploadDestinationConflictError,
    isUploadNotFoundError,
    isUploadOffsetConflictError,
} from "../upload-store";
import type { MemoryObject } from "../memory";

const enc = new TextEncoder();

/** A body that delivers `payload` and closes only once `release` is called. */
function gatedStream(payload: string): { body: ReadableStream<Uint8Array>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (sent) return controller.close();
            await gate;
            sent = true;
            controller.enqueue(enc.encode(payload));
        },
    });
    return { body, release };
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
        expect(store.digestOnComplete).toEqual(["sha-256", "sha-512"]);
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
        expect(fresh.status === "complete").toBe(false);
        expect(fresh.status === "invalidated").toBe(false);
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

        const done = await completeDurable(store, uploadToken, { now: 4_000 });
        expect(done.digest).toBe(sha256b64("hellowrld"));
        expect(done.etag).toBe(`"${sha256b64("hellowrld")}"`);

        const after = await store.getUploadState(uploadToken);
        expect(after.status === "complete").toBe(true);
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
        await completeDurable(store, uploadToken, { now: 2 });

        const handler = serveObject(memoryStore({ objects }));
        const res = await handler(new Request("http://localhost/f", { headers: { Range: "bytes=2-4" } }), {
            key: "video.bin",
        });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("234");
        expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    });

    test("a zero-byte upload completes and serves", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: 10 });
        const done = await completeDurable(store, uploadToken, { now: 20 });
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
        expect((await store.sweepExpired!({ idleSinceMs: 0 }, {})).removed).toBe(0);
        await store.abortUpload(uploadToken, {});
    });

    test("tokens still issue on runtimes without crypto.randomUUID", async () => {
        const original = globalThis.crypto.randomUUID;
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
        try {
            const store = memoryUploadStore({ objects: {} });
            const { uploadToken } = await store.createUpload({ key: "a", now: 0 });
            // UUID-shaped on this path too: the object stores accept only that
            // shape, so a fallback-minted token has to be one they can resolve.
            expect(uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
        await completeDurable(store, uploadToken, { now: 2 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("AAAA");
    });
});

describe("memoryUploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is persisted and reported by the next state", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        expect((await store.getUploadState(uploadToken)).length).toBeUndefined();

        await store.appendChunk(uploadToken, 0, enc.encode("hello"), { length: 5, now: 1 });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(5);
        expect(state.offset).toBe(5);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", length: 9, now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { length: 42, now: 1 });
        expect((await store.getUploadState(uploadToken)).length).toBe(9);
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
        await completeDurable(store, uploadToken, { now: 2 });

        const err = await store.appendChunk(uploadToken, 3, enc.encode("x"), { now: 3 }).catch((e) => e);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
    });

    test("a writer whose claim went stale while its body streamed commits nothing", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        // A passes the offset preflight at 0, then parks reading its body.
        const stale = gatedStream("AAAA");
        const pending = store.appendChunk(uploadToken, 0, stale.body, { now: 1 }).catch((e: unknown) => e);
        await Promise.resolve();
        // B claims the same offset and lands first.
        await store.appendChunk(uploadToken, 0, enc.encode("BB"), { now: 2 });
        stale.release();

        const err = await pending;
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(2);
        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
        await completeDurable(store, uploadToken, { now: 3 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("BB");
    });

    test("a writer whose resource completed while its body streamed leaves the published object alone", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("done"), { now: 1 });
        const stale = gatedStream("late");
        const pending = store.appendChunk(uploadToken, 4, stale.body, { now: 2 }).catch((e: unknown) => e);
        await Promise.resolve();
        await completeDurable(store, uploadToken, { now: 3 });
        stale.release();

        expect(isUploadOffsetConflictError(await pending)).toBe(true);
        expect((await store.getUploadState(uploadToken)).offset).toBe(4);
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("done");
    });

    test("a writer whose resource was discarded while its body streamed refuses", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const stale = gatedStream("late");
        const pending = store.appendChunk(uploadToken, 0, stale.body, { now: 1 }).catch((e: unknown) => e);
        await Promise.resolve();
        await store.abortUpload(uploadToken);
        stale.release();

        expect(isUploadNotFoundError(await pending)).toBe(true);
    });

    test("unknown tokens answer UploadNotFoundError on every interaction", async () => {
        const store = memoryUploadStore({ objects: {} });
        const state = await store.getUploadState("nope").catch((e) => e);
        expect(state).toBeInstanceOf(UploadNotFoundError);
        expect(isUploadNotFoundError(state)).toBe(true);
        await expect(store.appendChunk("nope", 0, enc.encode("x"), { now: 0 })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        await expect(store.completeUpload("nope", { expectedLength: 0, now: 0 })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
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
        expect(state.status === "invalidated").toBe(false);

        // Resume exactly where durable truth says, then finish.
        await store.appendChunk(uploadToken, 6, enc.encode("ghi"), { now: 2 });
        await completeDurable(store, uploadToken, { expectedDigests: { "sha-256": sha256b64("abcdefghi") }, now: 3 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("abcdefghi");
    });

    test("an aborted signal mid-body keeps the flushed prefix and stays resumable", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const ac = new AbortController();

        const partial = await store.appendChunk(uploadToken, 0, abortingStream(ac, "abc"), {
            now: 1,
            signal: ac.signal,
        });
        expect(partial.bytesWritten).toBe(3);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);
        expect(state.status === "complete").toBe(false);
        expect(state.status === "invalidated").toBe(false);
    });

    test("a signal aborted before the call reports a yield without touching state", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const ac = new AbortController();
        ac.abort();
        // An abort is an interruption, not a failure: raising it would make the
        // caller classify an exception to tell a preempted write from a broken
        // one, which is the guess the return value exists to delete.
        const result = await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1, signal: ac.signal });
        expect(result).toEqual({ bytesWritten: 0, interrupted: true });
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
    test("a NON-fatal bound keeps the prefix, keeps the resource, and reports the ceiling", async () => {
        // maxAppendSize bounds THIS REQUEST, not the representation. A body
        // that runs past it has done nothing to the upload, so destroying the
        // upload over it would turn a resumable situation into a lost one.
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });

        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("0123456789"), { maxBytes: 4, maxBytesFatal: false, now: 1 }),
        ).rejects.toBeInstanceOf(UploadAppendBoundError);

        const state = await store.getUploadState(uploadToken);
        // The accepted prefix is durable and the resource is alive.
        expect(state.offset).toBe(4);
        expect(state.status === "invalidated").toBe(false);

        // ...so the client simply resumes from there in smaller chunks.
        const resumed = await store.appendChunk(uploadToken, 4, enc.encode("45"), {
            maxBytes: 4,
            maxBytesFatal: false,
            now: 2,
        });
        expect(resumed.bytesWritten).toBe(2);
        expect((await store.getUploadState(uploadToken)).offset).toBe(6);
    });

    test("a body crossing the bound is truncated at it and the resource is invalidated", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });

        // A fatal bound throws: returning an offset would tell the caller to
        // carry on from bytes nothing can ever be built on.
        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("0123456789"), { maxBytes: 4, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);

        const state = await store.getUploadState(uploadToken);
        // The accepted prefix is still durable and still truthful.
        expect(state.offset).toBe(4);
        expect(state.status === "invalidated").toBe(true);

        // Every later interaction refuses.
        await expect(store.appendChunk(uploadToken, 4, enc.encode("x"), { now: 2 })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        await expect(completeDurable(store, uploadToken, { now: 3 })).rejects.toThrow(/invalidated/);
    });

    test("a stream crossing the bound mid-chunk keeps the exact prefix", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await expect(
            store.appendChunk(uploadToken, 0, streamOf("abc", "defg"), { maxBytes: 5, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(5);
        expect(state.status === "invalidated").toBe(true);
    });

    test("a body exactly at the bound is accepted whole and stays valid", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        const result = await store.appendChunk(uploadToken, 0, enc.encode("abcd"), {
            maxBytes: 4,
            maxBytesFatal: true,
            now: 1,
        });
        expect(result.bytesWritten).toBe(4);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.status === "invalidated").toBe(false);
        await completeDurable(store, uploadToken, { now: 2 });
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
        await expect(
            store.appendChunk(uploadToken, 0, body, { maxBytes: 4, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);
        // The producer is told to stop; without the cancel it would sit on
        // an abandoned locked reader forever.
        expect(cancelled).toBe(true);
    });

    test("maxBytes 0 with a non-empty body invalidates without accepting a byte", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await expect(
            store.appendChunk(uploadToken, 0, enc.encode("abc"), { maxBytes: 0, maxBytesFatal: true, now: 1 }),
        ).rejects.toBeInstanceOf(UploadOverrunError);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.status === "invalidated").toBe(true);
    });
});

describe("memoryUploadStore: digest verification at completion", () => {
    test("a matching asserted digest completes and is returned", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });
        const done = await completeDurable(store, uploadToken, {
            expectedDigests: { "sha-256": sha256b64("payload") },
            now: 2,
        });
        expect(done.digest).toBe(sha256b64("payload"));
    });

    test("a mismatch throws with the actual digest and publishes NOTHING", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("payload"), { now: 1 });

        expect(await completeWithWrongDigest(store, uploadToken, "payload")).toBeInstanceOf(UploadDigestMismatchError);

        // Atomic completion: nothing became visible to readers.
        expect(Object.hasOwn(objects, "k")).toBe(false);
        await expect(memoryStore({ objects }).headObject("k")).rejects.toBeInstanceOf(ObjectNotFoundError);

        // The resource is still alive; the orchestrator aborts it.
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(false);
        expect(state.offset).toBe(7);
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("completion is idempotent: a retry answers the recorded facts", async () => {
        const store = memoryUploadStore({ objects: {} });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("abc"), { now: 1 });
        const first = await completeDurable(store, uploadToken, { now: 2 });
        const retry = await completeDurable(store, uploadToken, { now: 3 });
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
        await completeDurable(store, uploadToken, { now: 2 });

        expect(Object.hasOwn(objects, "__proto__")).toBe(true);
        expect(({} as { body?: unknown }).body).toBeUndefined(); // Object.prototype untouched
        expect(await drain((await memoryStore({ objects }).getObject("__proto__")).body)).toBe("evil");
    });

    test("published entries stay caller-mutable: overwrite, enumerate, delete", async () => {
        const objects: Record<string, MemoryObject> = {};
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "doc.txt", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode("v1"), { now: 1 });
        await completeDurable(store, uploadToken, { now: 2 });

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
        await completeDurable(store, uploadToken, { now: 2 });
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

        const swept = await store.sweepExpired!({ idleSinceMs: 5_000 });
        expect(swept.removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);

        // Boundary: idle exactly AT the cutoff is kept (idle since BEFORE it).
        expect((await store.sweepExpired!({ idleSinceMs: 9_000 })).removed).toBe(0);
        expect((await store.sweepExpired!({ idleSinceMs: 9_001 })).removed).toBe(1);
        await expect(store.getUploadState(active.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("the lifetime cutoff reaches a resource idleness never can", async () => {
        // One byte a minute keeps a resource out of an idleness sweep forever
        // while every request against it is already refused as expired: bytes
        // no path reclaims. The two clocks are different, so the sweep takes
        // both and either one condemns.
        const store = memoryUploadStore({ objects: {} });
        const busy = await store.createUpload({ key: "busy", now: 1_000 });
        await store.appendChunk(busy.uploadToken, 0, enc.encode("x"), { now: 100_000 });

        expect((await store.sweepExpired!({ idleSinceMs: 50_000 })).removed).toBe(0);
        expect((await store.sweepExpired!({ createdBeforeMs: 2_000 })).removed).toBe(1);
        await expect(store.getUploadState(busy.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a sweep naming no cutoff is refused rather than reclaiming nothing", async () => {
        // A retention job that runs green while reclaiming nothing is worse
        // than one that is absent: it is mistaken for a control.
        const store = memoryUploadStore({ objects: {} });
        await expect(store.sweepExpired!({})).rejects.toThrow(/idleSinceMs, createdBeforeMs, or both/);
        await expect(store.sweepExpired!({ idleSinceMs: Number.NaN })).rejects.toThrow(/finite epoch-ms instant/);
    });

    test("the sweep reports what it could not reclaim, which here is nothing by construction", async () => {
        // `failed` is the channel a caller alerts on when a scheduled sweep
        // runs and reclaims nothing. Reclamation here is a Map delete over
        // records this process owns outright: no handle can hold one open and
        // no permission can deny one, so no record can resist reclamation or
        // cost the records behind it. Every condemned record goes in one pass.
        const store = memoryUploadStore({ objects: {} });
        for (const key of ["a", "b", "c"]) await store.createUpload({ key, now: 1_000 });

        expect(await store.sweepExpired({ idleSinceMs: 5_000 })).toEqual({ removed: 3, failed: 0 });
    });
});

// ─── A missing required option fails where the mistake was made ─────────────

describe("memoryUploadStore: construction", () => {
    test("a missing objects map is refused before anything can be uploaded", () => {
        // Without this the store accepts creation and every append, then dies
        // at publication, after the whole body has already transferred.
        expect(() => memoryUploadStore(undefined as never)).toThrow(TypeError);
        expect(() => memoryUploadStore({} as never)).toThrow(/options\.objects is required/);
    });

    test("the message names the map and how to pair it with the read store", () => {
        try {
            memoryUploadStore({} as never);
            throw new Error("expected a throw");
        } catch (err) {
            // An error that says what to change beats one that says what broke.
            expect((err as Error).message).toContain("memoryStore");
        }
    });

    test("the factory promises the sweep, so a retention pass needs no optional call", async () => {
        const store = memoryUploadStore({ objects: {} });
        // `store.sweepExpired?.()` would silently become a no-op if the method
        // ever went missing, which is how a retention obligation goes unmet.
        expect(await store.sweepExpired({ idleSinceMs: Date.now() - 1_000 })).toBeDefined();
    });
});

describe("memoryUploadStore: sealed completion", () => {
    /** An upload holding `payload`, ready to complete at its length. */
    async function staged(objects: Record<string, MemoryObject> = {}, payload = "sealed") {
        const store = memoryUploadStore({ objects });
        const { uploadToken } = await store.createUpload({ key: "k", now: 0 });
        await store.appendChunk(uploadToken, 0, enc.encode(payload), { now: 1 });
        return { objects, store, uploadToken, length: payload.length };
    }

    test("a length other than the durable one is refused, publishes nothing, and leaves the upload resumable", async () => {
        const { objects, store, uploadToken, length } = await staged();

        const err = await store.completeUpload(uploadToken, { expectedLength: length - 1, now: 2 }).catch((e) => e);
        expect(isUploadOffsetConflictError(err)).toBe(true);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(length);
        expect(Object.hasOwn(objects, "k")).toBe(false);

        // Nothing stayed sealed: the client re-anchors, appends, and completes.
        await store.appendChunk(uploadToken, length, enc.encode("+"), { now: 3 });
        await store.completeUpload(uploadToken, { expectedLength: length + 1, now: 4 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("sealed+");
    });

    test("an upload swept while its completion hashed publishes nothing", async () => {
        const { objects, store, uploadToken, length } = await staged();

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 2 }).catch((e) => e);
        expect((await store.sweepExpired({ idleSinceMs: 10 })).removed).toBe(1);

        expect(isUploadNotFoundError(await completing)).toBe(true);
        expect(Object.hasOwn(objects, "k")).toBe(false);
    });

    test("an upload aborted while its completion hashed publishes nothing", async () => {
        const { objects, store, uploadToken, length } = await staged();

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 2 }).catch((e) => e);
        await store.abortUpload(uploadToken);

        expect(isUploadNotFoundError(await completing)).toBe(true);
        expect(Object.hasOwn(objects, "k")).toBe(false);
    });

    test("an append arriving after the seal is refused and absent from the published object", async () => {
        const { objects, store, uploadToken, length } = await staged();

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 2 });
        const late = await store.appendChunk(uploadToken, length, enc.encode("LATE"), { now: 3 }).catch((e) => e);
        expect(isUploadOffsetConflictError(late)).toBe(true);
        expect((late as UploadOffsetConflictError).durableOffset).toBe(length);

        await completing;
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("sealed");
    });

    test("an append that passed its preflight before the seal and commits after it is refused", async () => {
        const { objects, store, uploadToken, length } = await staged();
        // The append clears its offset preflight, then parks reading its body.
        const streaming = gatedStream("LATE");
        const pending = store.appendChunk(uploadToken, length, streaming.body, { now: 2 }).catch((e: unknown) => e);
        await Promise.resolve();

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 3 });
        streaming.release();

        // Committing now would acknowledge bytes the sealed plan leaves out.
        expect(isUploadOffsetConflictError(await pending)).toBe(true);
        await completing;
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("sealed");
        expect((await store.getUploadState(uploadToken)).offset).toBe(length);
    });

    test("an entry written to the key after the seal is a destination conflict and stays intact", async () => {
        const { objects, store, uploadToken, length } = await staged();
        const foreign: MemoryObject = { body: "someone else's", etag: '"theirs"' };

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 2 }).catch((e) => e);
        objects.k = foreign;

        const err = await completing;
        expect(isUploadDestinationConflictError(err)).toBe(true);
        expect(err).toBeInstanceOf(UploadDestinationConflictError);
        expect(objects.k).toBe(foreign);
        expect(foreign.body).toBe("someone else's");
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(false);

        // Repetition never resolves it: the upload stays sealed over the state it
        // recorded, so a retry refuses the same way and an append stays fenced.
        const retry = await store.completeUpload(uploadToken, { expectedLength: length, now: 3 }).catch((e) => e);
        expect(isUploadDestinationConflictError(retry)).toBe(true);
        expect(objects.k).toBe(foreign);
        const append = await store.appendChunk(uploadToken, length, enc.encode("x"), { now: 4 }).catch((e) => e);
        expect(isUploadOffsetConflictError(append)).toBe(true);
    });

    test("an entry edited in place after the seal is a destination conflict too", async () => {
        const objects: Record<string, MemoryObject> = { k: { body: "v1", etag: '"v1"' } };
        const { store, uploadToken, length } = await staged(objects);

        const completing = store.completeUpload(uploadToken, { expectedLength: length, now: 2 }).catch((e) => e);
        objects.k.body = "v2";
        objects.k.etag = '"v2"';

        expect(isUploadDestinationConflictError(await completing)).toBe(true);
        expect(objects.k.body).toBe("v2");
    });

    test("an entry the key held before the seal is the state publication replaces", async () => {
        const objects: Record<string, MemoryObject> = { k: { body: "previous version", etag: '"old"' } };
        const { store, uploadToken, length } = await staged(objects);

        await store.completeUpload(uploadToken, { expectedLength: length, now: 2 });
        expect(await drain((await memoryStore({ objects }).getObject("k")).body)).toBe("sealed");
    });

    test("a failed digest verification lifts the seal, so the upload accepts appends again", async () => {
        const { store, uploadToken, length } = await staged();

        expect(await completeWithWrongDigest(store, uploadToken, "sealed")).toBeInstanceOf(UploadDigestMismatchError);
        await store.appendChunk(uploadToken, length, enc.encode("!"), { now: 3 });
        expect((await store.getUploadState(uploadToken)).offset).toBe(length + 1);
    });

    test("a second completer adopts the seal and answers the one publication", async () => {
        const { objects, store, uploadToken, length } = await staged();

        const first = store.completeUpload(uploadToken, { expectedLength: length, now: 2 });
        const second = store.completeUpload(uploadToken, { expectedLength: length, now: 3 });
        const [a, b] = await Promise.all([first, second]);

        expect(b.etag).toBe(a.etag);
        expect(objects.k.lastModified).toBe(new Date(2).toUTCString());
    });
});
