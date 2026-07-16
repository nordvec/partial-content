import { describe, test, expect } from "bun:test";
import { createUploadOrchestrator, type UploadResourceEvent } from "../upload-orchestrator";
import {
    UploadDigestMismatchError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    type ResumableWriteStore,
    type StoredUploadState,
} from "../upload-store";
import { UploadLockTimeoutError, type UploadLocker } from "../upload-locker";

const NOW = 1_800_000_000_000;

interface FakeUpload {
    key: string;
    bytes: Uint8Array;
    length?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    createdAt: number;
    lastAppendAt?: number;
}

/** Minimal in-test store: byte-exact, map-backed, hook points for failures. */
function fakeStore(over: Partial<ResumableWriteStore> = {}) {
    const uploads = new Map<string, FakeUpload>();
    let seq = 0;
    const base: ResumableWriteStore = {
        exactOffsetRecovery: true,
        atomicCompletion: true,
        digestOnComplete: "sha256",
        async createUpload(opts) {
            const uploadToken = `u${++seq}`;
            uploads.set(uploadToken, {
                key: opts.key, bytes: new Uint8Array(0), length: opts.length,
                isComplete: false, isInvalidated: false, createdAt: opts.now,
            });
            return { uploadToken };
        },
        async getUploadState(token): Promise<StoredUploadState> {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            return {
                offset: u.bytes.byteLength, length: u.length, isComplete: u.isComplete,
                isInvalidated: u.isInvalidated, createdAt: u.createdAt, lastAppendAt: u.lastAppendAt,
            };
        },
        async appendChunk(token, offset, body, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            let written = 0;
            const chunks: Uint8Array[] = [];
            if (body instanceof Uint8Array) {
                chunks.push(body);
                written = body.byteLength;
            } else {
                const reader = body.getReader();
                try {
                    for (;;) {
                        if (opts.signal?.aborted) break;
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        written += value.byteLength;
                    }
                } catch {
                    // torn body: keep the flushed prefix
                }
            }
            const merged = new Uint8Array(u.bytes.byteLength + written);
            merged.set(u.bytes, 0);
            let at = u.bytes.byteLength;
            for (const c of chunks) { merged.set(c, at); at += c.byteLength; }
            u.bytes = merged;
            u.lastAppendAt = opts.now;
            if (opts.signal?.aborted) throw new Error("aborted mid-append");
            return { bytesWritten: written };
        },
        async completeUpload(token, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            if (opts.expectedDigest !== undefined && opts.expectedDigest !== "GOOD") {
                throw new UploadDigestMismatchError(token, opts.expectedDigest);
            }
            u.isComplete = true;
            u.length = u.bytes.byteLength;
            return { etag: '"done"', digest: opts.expectedDigest };
        },
        async abortUpload(token) {
            uploads.delete(token);
        },
    };
    return { store: { ...base, ...over } as ResumableWriteStore, uploads };
}

function bodyOf(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** A stream the test releases chunk by chunk. */
function controlledStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return {
        stream,
        push: (text: string) => controller.enqueue(bodyOf(text)),
        close: () => controller.close(),
        error: (e: unknown) => controller.error(e),
    };
}

const orch = (store: ResumableWriteStore, over = {}) =>
    createUploadOrchestrator(store, { now: () => NOW, graceMs: 0, ...over });

describe("create", () => {
    test("allocates and reports the token, offset zero, incomplete", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: "doc.bin", declaredLength: 10, complete: false });
        expect(out).toMatchObject({ kind: "created", offset: 0, length: 10, complete: false, interrupted: false });
    });

    test("single-shot create streams the body and completes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: "doc.bin", contentLength: 5, complete: true, body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 5, complete: true, etag: '"done"' });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("policy rejection passes through before any store call", async () => {
        let created = 0;
        const { store } = fakeStore({
            createUpload: async () => { created++; return { uploadToken: "x" }; },
        });
        const o = orch(store, { policy: { maxSize: 4 } });
        const out = await o.create({ key: "k", declaredLength: 10, complete: false });
        expect(out.kind).toBe("limit-violation");
        expect(created).toBe(0);
    });

    test("an interrupted single-shot create does NOT complete and reports the durable offset", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.create({
            key: "k", contentLength: 10, complete: true, body: body.stream, signal: ctl.signal,
        });
        body.push("hel");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("socket gone"));
        const out = await pending;
        expect(out).toMatchObject({ kind: "created", complete: false, interrupted: true });
        if (out.kind !== "created") return;
        expect(out.offset).toBe(3); // the flushed prefix, from FRESH state
    });

    test("expectedDigest without store support is refused up front", async () => {
        const { store } = fakeStore({ digestOnComplete: false });
        const o = orch(store);
        const out = await o.create({ key: "k", complete: true, contentLength: 1, body: bodyOf("x"), expectedDigest: "GOOD" });
        expect(out.kind).toBe("digest-mismatch");
    });
});

describe("probe and cancel", () => {
    test("probe returns fresh state", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 5, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") });
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 3, length: 5, complete: false });
    });

    test("probe on an unknown token maps to not-found", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        expect((await o.probe("nope")).kind).toBe("not-found");
    });

    test("cancel aborts the resource and later probes are not-found", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        expect((await o.cancel(created.uploadToken)).kind).toBe("cancelled");
        expect((await o.probe(created.uploadToken)).kind).toBe("not-found");
    });
});

describe("append", () => {
    async function withUpload(policy = {}) {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        return { o, token: created.uploadToken, uploads, store };
    }

    test("happy path: bytes land, offset comes from fresh state", async () => {
        const { o, token } = await withUpload();
        const out = await o.append(token, { offset: 0, contentLength: 4, complete: false, body: bodyOf("abcd") });
        expect(out).toMatchObject({ kind: "appended", offset: 4, complete: false, interrupted: false });
        // The stored length wins even when the request restates nothing.
        if (out.kind !== "appended") return;
        expect(out.length).toBe(10);
    });

    test("stale offset answers offset-mismatch with the correct offset", async () => {
        const { o, token } = await withUpload();
        await o.append(token, { offset: 0, contentLength: 4, complete: false, body: bodyOf("abcd") });
        const out = await o.append(token, { offset: 0, contentLength: 2, complete: false, body: bodyOf("xy") });
        expect(out).toMatchObject({ kind: "offset-mismatch", claimedOffset: 0, correctOffset: 4 });
    });

    test("the completing tail completes exactly at the declared length", async () => {
        const { o, token } = await withUpload();
        await o.append(token, { offset: 0, contentLength: 6, complete: false, body: bodyOf("abcdef") });
        const out = await o.append(token, { offset: 6, contentLength: 4, complete: true, body: bodyOf("ghij") });
        expect(out).toMatchObject({ kind: "appended", offset: 10, complete: true, etag: '"done"' });
    });

    test("an interrupted completing append does NOT complete", async () => {
        const { o, token } = await withUpload();
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.append(token, {
            offset: 0, contentLength: 10, complete: true, body: body.stream, signal: ctl.signal,
        });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("gone"));
        const out = await pending;
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: false, interrupted: true });
    });

    test("zero-content completion at the length completes now", async () => {
        const { o, token } = await withUpload();
        await o.append(token, { offset: 0, contentLength: 10, complete: false, body: bodyOf("0123456789") });
        const out = await o.append(token, { offset: 10, contentLength: 0, complete: true });
        expect(out).toMatchObject({
            kind: "appended", offset: 10, length: 10, complete: true, etag: '"done"', interrupted: false,
        });
    });

    test("digest mismatch from the store maps to digest-mismatch, never a torn publish", async () => {
        const { o, token, uploads } = await withUpload();
        await o.append(token, { offset: 0, contentLength: 10, complete: false, body: bodyOf("0123456789") });
        const out = await o.append(token, { offset: 10, contentLength: 0, complete: true, expectedDigest: "BAD" });
        expect(out.kind).toBe("digest-mismatch");
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("store failures surface as store-error and report to onError", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            appendChunk: async () => { throw new Error("backend down"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"),
        });
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["append"]);
    });
});

describe("concurrency and hooks", () => {
    test("a concurrent probe preempts a hung append instead of waiting it out", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const body = controlledStream();
        const hungAppend = o.append(created.uploadToken, {
            offset: 0, complete: false, body: body.stream,
        });
        await new Promise((r) => setTimeout(r, 5));
        body.push("abc");

        // The probe arrives while the append holds the lock: cooperative
        // preemption must abort the append at the next chunk boundary and let
        // the probe answer the durable truth.
        const probePending = o.probe(created.uploadToken);
        const appended = await hungAppend;
        expect(appended).toMatchObject({ kind: "appended", interrupted: true });
        const probed = await probePending;
        expect(probed).toMatchObject({ kind: "probed", offset: 3 });
    });

    test("upload events are emitted with the auditKey and a throwing hook routes to onError", async () => {
        const events: UploadResourceEvent[] = [];
        const errors: string[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadEvent: (e) => {
                events.push(e);
                if (e.event.kind === "created") throw new Error("audit sink down");
            },
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const created = await o.create({ key: "secret-name.pdf", complete: false, auditKey: "doc-7" });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, contentLength: 2, complete: false, body: bodyOf("ab"), auditKey: "doc-7" });

        expect(events[0]).toMatchObject({ auditKey: "doc-7", event: { kind: "created" } });
        expect(events.some((e) => e.event.kind === "append-accepted")).toBe(true);
        expect(errors).toContain("audit");
    });

    test("store maxAppendSize tightens the effective policy", async () => {
        const { store } = fakeStore();
        const bounded = { ...store, maxAppendSize: 4 } as ResumableWriteStore;
        const o = orch(bounded);
        expect(o.policy.maxAppendSize).toBe(4);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 5, complete: false, body: bodyOf("abcde"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
    });

    test("canVerifyDigest reflects the store capability", async () => {
        const { store } = fakeStore();
        expect(orch(store).canVerifyDigest).toBe(true);
        const { store: noDigest } = fakeStore({ digestOnComplete: false });
        expect(orch(noDigest).canVerifyDigest).toBe(false);
    });
});

describe("grace window", () => {
    test("with a grace window, a client abort does not abort the store signal immediately", async () => {
        let sawAbortedSignal: boolean | undefined;
        const { store } = fakeStore({
            appendChunk: async (_t, _o, _b, opts) => {
                await new Promise((r) => setTimeout(r, 15));
                sawAbortedSignal = opts.signal?.aborted ?? false;
                return { bytesWritten: 0 };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 60_000 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        ctl.abort();
        await pending;
        // The store finished its flush INSIDE the grace window: its signal
        // never fired even though the request signal did.
        expect(sawAbortedSignal).toBe(false);
    });

    test("with graceMs 0 the abort reaches the store immediately", async () => {
        let sawAbortedSignal: boolean | undefined;
        const { store } = fakeStore({
            appendChunk: async (_t, _o, _b, opts) => {
                await new Promise((r) => setTimeout(r, 15));
                sawAbortedSignal = opts.signal?.aborted ?? false;
                return { bytesWritten: 0 };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        ctl.abort();
        await pending;
        expect(sawAbortedSignal).toBe(true);
    });

    test("graceMs defaults to a real window when omitted", async () => {
        let sawAbortedSignal: boolean | undefined;
        const { store } = fakeStore({
            appendChunk: async (_t, _o, _b, opts) => {
                await new Promise((r) => setTimeout(r, 15));
                sawAbortedSignal = opts.signal?.aborted ?? false;
                return { bytesWritten: 0 };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        ctl.abort();
        await pending;
        // The default window (10s) absorbs the abort: the store flush finishes.
        expect(sawAbortedSignal).toBe(false);
    });

    /** appendChunk that waits for its signal to abort (bounded fallback). */
    function abortAwaitingAppend(record: { sawAbort?: boolean }) {
        return async (
            _t: string, _o: number, _b: ReadableStream<Uint8Array> | Uint8Array,
            opts: { signal?: AbortSignal },
        ) => {
            await new Promise<void>((resolve) => {
                if (opts.signal?.aborted) return resolve();
                opts.signal?.addEventListener("abort", () => resolve(), { once: true });
                setTimeout(resolve, 500);
            });
            record.sawAbort = opts.signal?.aborted ?? false;
            return { bytesWritten: 0 };
        };
    }

    test("the grace window ENDS: a mid-append client abort reaches the store after graceMs", async () => {
        const record: { sawAbort?: boolean } = {};
        let begun!: () => void;
        const begunP = new Promise<void>((r) => { begun = r; });
        const inner = abortAwaitingAppend(record);
        const { store } = fakeStore({
            appendChunk: async (t, o2, b, opts) => { begun(); return inner(t, o2, b, opts); },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 20 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.append(created.uploadToken, {
            offset: 0, complete: false, body: body.stream, signal: ctl.signal,
        });
        await begunP;
        ctl.abort();
        const out = await pending;
        expect(record.sawAbort).toBe(true);
        expect(out.kind).toBe("appended");
    });

    test("an ALREADY-aborted request still opens the window before cutting the store off", async () => {
        const record: { sawAbort?: boolean } = {};
        const { store } = fakeStore({ appendChunk: abortAwaitingAppend(record) });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 20 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        ctl.abort();
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        expect(record.sawAbort).toBe(true);
        expect(out.kind).toBe("appended");
    });

    test("a live (never aborted) request signal never trips the grace timer", async () => {
        let sawAbortedSignal: boolean | undefined;
        const { store } = fakeStore({
            appendChunk: async (_t, _o, _b, opts) => {
                await new Promise((r) => setTimeout(r, 60));
                sawAbortedSignal = opts.signal?.aborted ?? false;
                return { bytesWritten: 0 };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 15 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        expect(sawAbortedSignal).toBe(false);
        expect(out.kind).toBe("appended");
    });
});

describe("policy merge", () => {
    test("policy maxAppendSize stands alone when the store has no bound", () => {
        const { store } = fakeStore();
        expect(orch(store, { policy: { maxAppendSize: 3 } }).policy.maxAppendSize).toBe(3);
        expect(orch(store).policy.maxAppendSize).toBeUndefined();
    });

    test("the tighter of policy and store maxAppendSize wins, both ways", () => {
        const { store } = fakeStore();
        const bounded = { ...store, maxAppendSize: 4 } as ResumableWriteStore;
        expect(orch(bounded, { policy: { maxAppendSize: 3 } }).policy.maxAppendSize).toBe(3);
        expect(orch(bounded, { policy: { maxAppendSize: 6 } }).policy.maxAppendSize).toBe(4);
    });
});

describe("clock injection", () => {
    test("the injected clock stamps creation time", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        await o.create({ key: "k", complete: false });
        expect([...uploads.values()][0]!.createdAt).toBe(NOW);
    });

    test("probe reports the exact remaining lifetime from the injected clock", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { maxAgeSeconds: 100 } });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.probe(created.uploadToken);
        expect(out).toMatchObject({ kind: "probed" });
        if (out.kind !== "probed") return;
        expect(out.remainingLifetimeSeconds).toBe(100);
    });

    test("an expired resource answers gone to append and cancel", async () => {
        const { store } = fakeStore();
        let t = NOW;
        const o = createUploadOrchestrator(store, {
            now: () => t, graceMs: 0, policy: { maxAgeSeconds: 100 },
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        t = NOW + 200_000;
        const appended = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"),
        });
        expect(appended).toMatchObject({ kind: "gone", reason: "expired" });
        const cancelled = await o.cancel(created.uploadToken);
        expect(cancelled).toMatchObject({ kind: "gone", reason: "expired" });
    });
});

describe("hook guards without onError", () => {
    test("a throwing event hook with no onError never corrupts the upload", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadEvent: () => { throw new Error("sink down"); },
        });
        const out = await o.create({ key: "k", complete: false });
        expect(out.kind).toBe("created");
    });

    test("a store failure with no onError still answers store-error", async () => {
        const { store } = fakeStore({
            appendChunk: async () => { throw new Error("backend down"); },
        });
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"),
        });
        expect(out.kind).toBe("store-error");
    });
});

describe("locking", () => {
    test("a lock timeout answers contended with empty events", async () => {
        const { store } = fakeStore();
        const locker: UploadLocker = {
            acquire: async () => { throw new UploadLockTimeoutError("tok"); },
        };
        const o = orch(store, { locker });
        const out = await o.probe("tok");
        expect(out).toEqual({ kind: "contended", events: [] });
    });

    test("a non-timeout locker failure propagates instead of masquerading as contention", async () => {
        const { store } = fakeStore();
        const locker: UploadLocker = {
            acquire: async () => { throw new Error("locker down"); },
        };
        const o = orch(store, { locker });
        await expect(o.probe("tok")).rejects.toThrow("locker down");
    });

    test("preempting a holder with no store write in flight is a safe no-op", async () => {
        const { store } = fakeStore();
        const slow: ResumableWriteStore = {
            ...store,
            getUploadState: async (t, opts) => {
                await new Promise((r) => setTimeout(r, 20));
                return store.getUploadState(t, opts);
            },
        };
        const o = orch(slow);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        // The second probe preempts the first while it only READS: the
        // preempt callback must tolerate the absent abort controller.
        const [p1, p2] = await Promise.all([
            o.probe(created.uploadToken),
            o.probe(created.uploadToken),
        ]);
        expect(p1.kind).toBe("probed");
        expect(p2.kind).toBe("probed");
    });
});

describe("create edge paths", () => {
    test("minAppendSize applies to a non-completing creation WITH content", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 5 } });
        const out = await o.create({
            key: "k", contentLength: 2, complete: false, body: bodyOf("ab"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-small" });
    });

    test("minAppendSize exempts a bodyless creation even with a zero Content-Length", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 5 } });
        const out = await o.create({ key: "k", contentLength: 0, complete: false });
        expect(out.kind).toBe("created");
    });

    test("a matching expectedDigest on a verifying store completes and reports the digest", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: "k", contentLength: 5, complete: true, body: bodyOf("hello"), expectedDigest: "GOOD",
        });
        expect(out).toMatchObject({
            kind: "created", offset: 5, complete: true, digest: "GOOD", etag: '"done"',
        });
    });

    test("a failing expectedDigest on create maps to digest-mismatch, never a publish", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: "k", contentLength: 3, complete: true, body: bodyOf("abc"), expectedDigest: "BAD",
        });
        expect(out.kind).toBe("digest-mismatch");
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a failing createUpload maps to store-error and reports operation create", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            createUpload: async () => { throw new Error("alloc failed"); },
        });
        const o = orch(store, { onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation) });
        const out = await o.create({ key: "k", complete: false });
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["create"]);
    });

    test("a failing post-stream state read on create maps to store-error", async () => {
        const { store } = fakeStore({
            getUploadState: async () => { throw new Error("state read failed"); },
        });
        const o = orch(store);
        const out = await o.create({
            key: "k", contentLength: 3, complete: false, body: bodyOf("abc"),
        });
        expect(out.kind).toBe("store-error");
    });

    test("a completing create short of its declared length does NOT complete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: "k", declaredLength: 10, complete: true, body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 3, length: 10, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a completing create with NO length indicators completes at whatever landed", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "created", offset: 3, complete: true, etag: '"done"' });
    });

    test("completion on create emits a completed event carrying the final length", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        await o.create({ key: "k", contentLength: 5, complete: true, body: bodyOf("hello") });
        const completed = events.filter((e) => e.event.kind === "completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]!.event).toEqual({ kind: "completed", length: 5 });
    });
});

describe("probe edge paths", () => {
    test("probe on an invalidated resource answers gone", async () => {
        const { store } = fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                offset: 0, isComplete: false, isInvalidated: true, createdAt: NOW,
            }),
        });
        const o = orch(store);
        const out = await o.probe("dead");
        expect(out).toMatchObject({ kind: "gone", reason: "invalidated" });
    });
});

describe("append edge paths", () => {
    test("a matching expectedDigest on a completing append reports the digest", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 10, complete: true, body: bodyOf("0123456789"), expectedDigest: "GOOD",
        });
        expect(out).toMatchObject({
            kind: "appended", offset: 10, complete: true, digest: "GOOD", etag: '"done"',
        });
    });

    test("a failing expectedDigest on a streaming completing append maps to digest-mismatch", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 10, complete: true, body: bodyOf("0123456789"), expectedDigest: "BAD",
        });
        expect(out.kind).toBe("digest-mismatch");
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("expectedDigest on a non-verifying store is refused before any store call", async () => {
        let stateReads = 0;
        const { store } = fakeStore({ digestOnComplete: false });
        const counting: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => { stateReads++; return store.getUploadState(t, opts); },
        };
        const o = orch(counting);
        const out = await o.append("tok", {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"), expectedDigest: "anything",
        });
        expect(out.kind).toBe("digest-mismatch");
        expect(stateReads).toBe(0);
    });

    test("no expectedDigest on a non-verifying store appends normally", async () => {
        const { store } = fakeStore({ digestOnComplete: false });
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 2, complete: false, body: bodyOf("ab"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 2 });
    });

    test("a failing head read on append maps to store-error and reports operation head", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            getUploadState: async () => { throw new Error("head down"); },
        });
        const o = orch(store, { onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation) });
        const out = await o.append("tok", {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"),
        });
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["head"]);
    });

    test("a failing post-stream state read on append maps to store-error", async () => {
        const { store } = fakeStore();
        let reads = 0;
        const flaky: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => {
                reads++;
                if (reads > 1) throw new Error("re-derive failed");
                return store.getUploadState(t, opts);
            },
        };
        const o = orch(flaky);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 2, complete: false, body: bodyOf("ab"),
        });
        expect(out.kind).toBe("store-error");
    });

    test("an append without a body answers the durable offset without touching the writer", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, { offset: 0, complete: false });
        expect(out).toMatchObject({
            kind: "appended", offset: 0, length: 10, complete: false, interrupted: false,
        });
    });

    test("a store offset conflict answers offset-mismatch carrying the durable offset", async () => {
        const { store } = fakeStore();
        const conflicted: ResumableWriteStore = {
            ...store,
            appendChunk: async (token) => { throw new UploadOffsetConflictError(token, 7); },
        };
        const o = orch(conflicted);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: false, body: bodyOf("x"),
        });
        expect(out).toEqual({
            kind: "offset-mismatch", claimedOffset: 0, correctOffset: 7, complete: false, events: [],
        });
    });

    test("a short store flush (no abort) does NOT complete a completing append", async () => {
        const { store, uploads } = fakeStore();
        const partial: ResumableWriteStore = {
            ...store,
            appendChunk: async (token, _off, _body, opts) => {
                const u = uploads.get(token)!;
                const merged = new Uint8Array(u.bytes.byteLength + 2);
                merged.set(u.bytes, 0);
                merged.set(bodyOf("ab"), u.bytes.byteLength);
                u.bytes = merged;
                u.lastAppendAt = opts.now;
                return { bytesWritten: 2 };
            },
        };
        const o = orch(partial);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 4, complete: true, body: bodyOf("abcd"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 2, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a chunked completing append (no Content-Length) completes at what landed", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: true, body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true, etag: '"done"' });
        const completed = events.filter((e) => e.event.kind === "completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]!.event).toEqual({ kind: "completed", length: 3 });
    });

    test("a completing append short of the declared length does NOT complete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: true, body: bodyOf("abcd"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 4, length: 10, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });
});

describe("cancel edge paths", () => {
    test("a failing head read on cancel maps to store-error", async () => {
        const { store } = fakeStore({
            getUploadState: async () => { throw new Error("head down"); },
        });
        const o = orch(store);
        const out = await o.cancel("tok");
        expect(out.kind).toBe("store-error");
    });

    test("cancel on an invalidated resource answers gone, not cancelled", async () => {
        const { store } = fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                offset: 0, isComplete: false, isInvalidated: true, createdAt: NOW,
            }),
        });
        const o = orch(store);
        const out = await o.cancel("dead");
        expect(out).toMatchObject({ kind: "gone", reason: "invalidated" });
    });

    test("a failing abortUpload maps to store-error and reports operation abort", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            abortUpload: async () => { throw new Error("discard failed"); },
        });
        const o = orch(store, { onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation) });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.cancel(created.uploadToken);
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["abort"]);
    });
});

describe("signal propagation", () => {
    test("the request signal reaches every store read, completion, and abort", async () => {
        const calls: Array<{ op: string; signal: AbortSignal | undefined }> = [];
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => {
                calls.push({ op: "state", signal: opts?.signal });
                return store.getUploadState(t, opts);
            },
            completeUpload: (t, opts) => {
                calls.push({ op: "complete", signal: opts.signal });
                return store.completeUpload(t, opts);
            },
            abortUpload: (t, opts) => {
                calls.push({ op: "abort", signal: opts?.signal });
                return store.abortUpload(t, opts);
            },
        };
        const o = orch(spy);
        const { signal } = new AbortController();

        const created = await o.create({
            key: "k", contentLength: 3, complete: true, body: bodyOf("abc"), signal,
        });
        if (created.kind !== "created") throw new Error("setup");
        const again = await o.create({ key: "k2", declaredLength: 4, complete: false, signal });
        if (again.kind !== "created") throw new Error("setup");
        await o.probe(again.uploadToken, { signal });
        await o.append(again.uploadToken, {
            offset: 0, contentLength: 4, complete: true, body: bodyOf("wxyz"), signal,
        });
        await o.cancel(created.uploadToken, { signal });

        // create fresh-read + complete, probe, append head + fresh + complete,
        // cancel head + abort: every store touchpoint carries the caller signal.
        expect(calls.map((c) => c.op)).toEqual([
            "state", "complete", "state", "state", "state", "complete", "state", "abort",
        ]);
        for (const c of calls) expect(c.signal).toBe(signal);
    });
});
