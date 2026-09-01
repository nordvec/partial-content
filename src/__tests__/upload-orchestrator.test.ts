import { describe, test, expect } from "bun:test";
import {
    createUploadOrchestrator,
    type UploadOrchestratorOptions,
    type UploadResourceEvent,
} from "../upload-orchestrator";
import {
    UploadAppendBoundError,
    UploadDigestMismatchError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadOverrunError,
    type ResumableWriteStore,
    type StoredUploadState,
} from "../upload-store";
import { UploadLockTimeoutError, memoryUploadLocker, type UploadLocker } from "../upload-locker";

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
        enforcesOffsetCheck: true,
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
                key: u.key,
                offset: u.bytes.byteLength, length: u.length, isComplete: u.isComplete,
                isInvalidated: u.isInvalidated, createdAt: u.createdAt, lastAppendAt: u.lastAppendAt,
            };
        },
        async appendChunk(token, offset, body, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            let written = 0;
            let crossedBound = false;
            const chunks: Uint8Array[] = [];
            /** Take as much as the bound allows; false = the body crossed it. */
            const accept = (chunk: Uint8Array): boolean => {
                const room = opts.maxBytes === undefined
                    ? chunk.byteLength
                    : Math.min(chunk.byteLength, opts.maxBytes - written);
                if (room > 0) {
                    chunks.push(chunk.subarray(0, room));
                    written += room;
                }
                if (room < chunk.byteLength) {
                    crossedBound = true;
                    return false;
                }
                return true;
            };
            if (body instanceof Uint8Array) {
                accept(body);
            } else {
                const reader = body.getReader();
                try {
                    for (;;) {
                        if (opts.signal?.aborted) break;
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!accept(value)) break;
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
            // Persist a length first declared on this append (deferred-length).
            if (opts.length !== undefined && u.length === undefined) u.length = opts.length;
            if (opts.signal?.aborted) throw new Error("aborted mid-append");
            // Contract: a REPRESENTATION bound is the terminal fault; this
            // request's ceiling only stops the append and leaves the resource
            // healthy. A fake that ignored the distinction would let the
            // orchestrator's handling of it go untested.
            if (crossedBound && opts.maxBytesFatal) {
                u.isInvalidated = true;
                throw new UploadOverrunError(token, opts.maxBytes!);
            } else if (crossedBound) {
                throw new UploadAppendBoundError(token, u.bytes.byteLength);
            }
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

    test("an unverifiable digest is IGNORED, not refused (RFC 9530: advisory)", async () => {
        // A store that cannot verify sha-256 must not fail a client that
        // voluntarily asserts Repr-Digest: nothing was compared, so a refusal
        // would be a lie. The upload completes; the digest is dropped.
        const digestSeen: (string | undefined)[] = [];
        const { store } = fakeStore({
            digestOnComplete: false,
            completeUpload: async (_t, opts) => { digestSeen.push(opts.expectedDigest); return { etag: '"x"' }; },
        });
        const o = orch(store);
        const out = await o.create({ key: "k", complete: true, contentLength: 1, body: bodyOf("x"), expectedDigest: "GOOD" });
        expect(out.kind).toBe("created");
        if (out.kind !== "created") return;
        expect(out.complete).toBe(true);
        expect(digestSeen).toEqual([undefined]); // the store never saw the unverifiable digest
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

    test("a rejected creation-with-upload announces WHY it was rejected", async () => {
        // Each rejection on this path emits its own audit event, and the reason
        // is the whole point of emitting one: a consumer reading its records
        // has to be able to tell a client that overran its request ceiling from
        // one that contradicted its own declared length. The offset is 0
        // because creation streams from the start.
        const cases = [
            {
                label: "a body past this request's ceiling",
                build: () => new UploadAppendBoundError("t", 4),
                reason: "append-too-large",
            },
            {
                label: "a body past a representation bound",
                build: () => new UploadOverrunError("t", 4),
                reason: "size-exceeded",
            },
            {
                label: "a client that won the lock first",
                build: () => new UploadOffsetConflictError("t", 4),
                reason: "offset-mismatch",
            },
        ] as const;

        for (const { label, build, reason } of cases) {
            const events: UploadResourceEvent[] = [];
            const { store } = fakeStore({
                appendChunk: async () => { throw build(); },
            });
            const o = createUploadOrchestrator(store, {
                now: () => NOW, graceMs: 0,
                policy: { maxSize: 4 },
                onUploadEvent: (e) => events.push(e),
            });

            const out = await o.create({ key: "k", complete: false, body: bodyOf("abcdefgh") });

            const rejected = events.map((e) => e.event).filter((e) => e.kind === "append-rejected");
            expect(rejected, label).toEqual([
                { kind: "append-rejected", reason, atOffset: 0 },
            ]);
            expect(out.kind, label).not.toBe("created");
        }
    });

    test("an append rejected at its ceiling announces the offset it stopped at", async () => {
        // The same rejection on the append path, where the offset is a real
        // resume point rather than 0. It is what the consumer's records need to
        // show where the client should continue from, so it has to be the
        // durable offset the append started at and not a placeholder.
        const events: UploadResourceEvent[] = [];
        let failNext = false;
        const { store } = fakeStore({});
        const wrapped: ResumableWriteStore = {
            ...store,
            appendChunk: async (token, offset, body, opts) => {
                if (failNext) throw new UploadAppendBoundError(token, offset);
                return store.appendChunk(token, offset, body, opts);
            },
        };
        const o = createUploadOrchestrator(wrapped, {
            now: () => NOW, graceMs: 0,
            onUploadEvent: (e) => events.push(e),
        });

        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, {
            offset: 0, contentLength: 3, complete: false, body: bodyOf("abc"),
        });

        events.length = 0;
        failNext = true;
        const out = await o.append(created.uploadToken, {
            offset: 3, contentLength: 5, complete: false, body: bodyOf("defgh"),
        });

        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
        // The engine accepts the intent before the store refuses the bytes, so
        // the accepted event precedes the rejection; the rejection is the one
        // carrying the resume point.
        expect(events.map((e) => e.event).filter((e) => e.kind === "append-rejected")).toEqual([
            { kind: "append-rejected", reason: "append-too-large", atOffset: 3 },
        ]);
    });

    test("a creation failure reaches onError verbatim: there is no token to redact yet", async () => {
        // `create` is the one reporting path with no token, since the token is
        // what creation produces. Redaction searches for the token it is given,
        // so a missing one must short-circuit rather than search for the word
        // it stringifies to: backend messages carry "undefined" constantly, and
        // substituting the audit key into one rewrites an unrelated diagnostic.
        const boom = new Error("S3: Cannot read properties of undefined (reading 'UploadId')");
        const seen: { err: unknown; ctx: { uploadToken?: string; auditKey?: string } }[] = [];
        const { store } = fakeStore({
            createUpload: async () => { throw boom; },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (err, ctx) => seen.push({ err, ctx }),
        });

        const out = await o.create({ key: "k", complete: false, auditKey: "doc-7" });

        expect(out.kind).toBe("store-error");
        expect(seen).toHaveLength(1);
        // The same object, not a scrubbed clone of it.
        expect(seen[0]!.err).toBe(boom);
        expect((seen[0]!.err as Error).message).toContain("undefined");
        expect(seen[0]!.ctx.auditKey).toBe("doc-7");
        expect(seen[0]!.ctx.uploadToken).toBeUndefined();
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
        // The audit key SUBSTITUTES for the token rather than accompanying it.
        // The token is the capability: possession of it authorizes appending,
        // probing and cancelling, and this hook is the most log-adjacent
        // surface in the package, so a caller that supplied a safe identifier
        // must not get the credential written beside it.
        expect(events.every((e) => e.uploadToken === undefined)).toBe(true);
        expect(events.some((e) => e.event.kind === "append-accepted")).toBe(true);
        expect(errors).toContain("audit");
    });

    test("without an auditKey the token IS reported, so events stay correlatable", async () => {
        // The substitution is opt-in: a caller that supplied no safe id still
        // needs something to join events on, and it has the token already.
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, contentLength: 2, complete: false, body: bodyOf("ab") });

        const appended = events.find((e) => e.event.kind === "append-accepted");
        expect(appended?.uploadToken).toBe(created.uploadToken);
        expect(appended?.auditKey).toBeUndefined();
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

    test("an unknown-length body past maxAppendSize is a 413, not a destroyed upload", async () => {
        // The known-size case above never reaches storage: the engine refuses
        // it up front. This is the case that cannot be checked in advance, a
        // chunked body with no Content-Length, and it used to invalidate the
        // whole resource over a per-REQUEST ceiling. The representation is
        // untouched by running long, so the upload survives and resumes.
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { maxAppendSize: 4 } });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
        // Alive, not invalidated, with the accepted prefix durable.
        const record = uploads.get(created.uploadToken)!;
        expect(record.isInvalidated).toBe(false);

        const probed = await o.probe(created.uploadToken);
        expect(probed.kind).toBe("probed");
        if (probed.kind !== "probed") return;
        const resumed = await o.append(created.uploadToken, {
            offset: probed.offset, complete: false, body: bodyOf("ab"),
        });
        expect(resumed.kind).toBe("appended");
    });

    test("an unknown-length body past a REPRESENTATION bound still invalidates", async () => {
        // The other half of the same split: maxSize bounds the representation,
        // so bytes past it are the terminal fault and the resource dies. The
        // per-request ceiling must not have softened this.
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { maxSize: 4 } });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });
        expect(uploads.get(created.uploadToken)!.isInvalidated).toBe(true);
    });

    test("canVerifyDigest reflects the store capability", async () => {
        const { store } = fakeStore();
        expect(orch(store).canVerifyDigest).toBe(true);
        const { store: noDigest } = fakeStore({ digestOnComplete: false });
        expect(orch(noDigest).canVerifyDigest).toBe(false);
    });
});

describe("construction guards", () => {
    test("a store reporting atomicCompletion: false is refused", () => {
        const { store } = fakeStore();
        // `atomicCompletion` is typed `true`, so no TypeScript caller can build
        // this store: the guard defends against an untyped consumer and a backend
        // that reports a capability it does not have, which is what this cast
        // reconstructs.
        const nonAtomic = { ...store, atomicCompletion: false } as unknown as ResumableWriteStore;
        expect(() => createUploadOrchestrator(nonAtomic, { now: () => NOW })).toThrow(TypeError);
    });

    test("a store reporting enforcesOffsetCheck: false is refused", () => {
        // The lock serializes writers but cannot prove the writer still holds
        // it: an expiry-based distributed lock is stealable from a holder that
        // stalls past its TTL and resumes. The store's at-write offset check is
        // the only thing that makes that holder's late write loud instead of
        // silently interleaved, so a store admitting it cannot do the check has
        // no defense left and is refused rather than deployed and hoped about.
        const { store } = fakeStore();
        // Typed `true` like `atomicCompletion`, and reached the same way.
        const unchecked = { ...store, enforcesOffsetCheck: false } as unknown as ResumableWriteStore;
        expect(() => createUploadOrchestrator(unchecked, { now: () => NOW }))
            .toThrow(/enforcesOffsetCheck/);
    });

    test("a NaN / negative / fractional / inverted policy is refused", () => {
        const { store } = fakeStore();
        const mk = (policy: object) => () => createUploadOrchestrator(store, { now: () => NOW, policy });
        expect(mk({ maxSize: NaN })).toThrow(TypeError);
        expect(mk({ maxSize: -1 })).toThrow(TypeError);
        expect(mk({ maxAppendSize: 1.5 })).toThrow(TypeError);
        expect(mk({ minSize: 100, maxSize: 10 })).toThrow(TypeError);
        expect(mk({ minAppendSize: 100, maxAppendSize: 10 })).toThrow(TypeError);
        // A clean policy constructs.
        expect(mk({ minSize: 1, maxSize: 10, maxAppendSize: 5 })).not.toThrow();
    });
});

describe("minSize at completion", () => {
    test("a known-total single-shot create below the floor is refused before allocation", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const out = await o.create({ key: "k", contentLength: 3, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        // The engine rejects a known-under-floor total at creation: nothing allocated.
        expect(uploads.size).toBe(0);
    });

    test("a STREAMING completing create below the floor does NOT publish (post-stream check)", async () => {
        // Unknown content size at creation: the floor can only be checked after
        // the bytes land. The object is allocated then must not be published.
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const out = await o.create({ key: "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a deferred-length upload cannot slip under the floor via a tiny completing append", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const created = await o.create({ key: "k", complete: false }); // no length
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: true, body: bodyOf("x"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("at or above the floor completes normally", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minSize: 3 } });
        const out = await o.create({ key: "k", contentLength: 3, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "created", complete: true });
    });
});

describe("deferred-length persistence", () => {
    test("a length declared on a later append persists and drives completion", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false }); // no length
        if (created.kind !== "created") throw new Error("setup");

        // First append carries the length AND the first bytes.
        await o.append(created.uploadToken, {
            offset: 0, contentLength: 5, complete: false, declaredLength: 10, body: bodyOf("01234"),
        });
        // The store now reports the length: a probe sees it, and a wrong
        // second declaration is rejected as immutable.
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 5, length: 10 });
        const conflict = await o.append(created.uploadToken, {
            offset: 5, contentLength: 5, complete: false, declaredLength: 999, body: bodyOf("56789"),
        });
        expect(conflict.kind).toBe("length-inconsistent");

        // The correct completing append reaches the persisted length and publishes.
        const done = await o.append(created.uploadToken, {
            offset: 5, contentLength: 5, complete: true, body: bodyOf("56789"),
        });
        expect(done).toMatchObject({ kind: "appended", offset: 10, complete: true });
    });
});

describe("create runs under the lock", () => {
    test("a resume that races a still-flushing creation is serialized, not concurrent", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const body = controlledStream();
        // Start a completing creation whose body stays open (holds the lock).
        const creating = o.create({ key: "k", complete: false, body: body.stream });
        await new Promise((r) => setTimeout(r, 5));
        body.push("abc");

        // We cannot know the token before create resolves, but the lock is on
        // it; drive the stream to completion and confirm the creation owned the
        // lock for its whole streaming life (no interleave observable, and the
        // result is coherent).
        body.close();
        const created = await creating;
        expect(created.kind).toBe("created");
        if (created.kind !== "created") return;
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 3 });
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

    test("the interrupted re-read is NOT gated on the aborted client signal", async () => {
        // Regression: an interruption IS often the client abort, and the
        // built-in stores throw on an aborted signal, so gating the durable
        // re-read on req.signal downgraded a truthful `interrupted` response to
        // a spurious store error and fired a mislabeled AbortError to onError.
        // Same torn-partial-append shape as the interrupted test above, but
        // with a store that honors the signal exactly like memory/fs do.
        const errors: string[] = [];
        const { store } = fakeStore();
        const origGetState = store.getUploadState.bind(store);
        store.getUploadState = async (token: string, stateOpts?: { signal?: AbortSignal }) => {
            stateOpts?.signal?.throwIfAborted();
            return origGetState(token, stateOpts);
        };
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.append(created.uploadToken, {
            offset: 0, contentLength: 10, complete: true, body: body.stream, signal: ctl.signal,
        });
        body.push("abc");
        await new Promise((r) => setTimeout(r, 5));
        ctl.abort();
        body.error(new Error("gone"));
        const out = await pending;

        // The re-read reported the flushed offset instead of throwing on the
        // aborted signal: a truthful interrupted response, no spurious error.
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: false, interrupted: true });
        expect(errors).toEqual([]);
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

    test("an expired resource answers gone to append but cancel still frees the bytes", async () => {
        const { store, uploads } = fakeStore();
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
        // DELETE is the one verb that must succeed on a dead resource: cancel
        // frees the partial bytes instead of refusing, so an expired upload
        // does not wait for a sweep (which may never run without a max age).
        const cancelled = await o.cancel(created.uploadToken);
        expect(cancelled).toMatchObject({ kind: "cancelled" });
        expect(uploads.has(created.uploadToken)).toBe(false);
    });
});

describe("terminal audit events are emitted only after the store action succeeds", () => {
    test("a complete-now append whose completeUpload throws does NOT emit a completed event", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore({
            completeUpload: async () => { throw new Error("publish failed"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", declaredLength: 3, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") });
        // Zero-content completing tail at offset == length: a complete-now verdict.
        const out = await o.append(created.uploadToken, { offset: 3, contentLength: 0, complete: true });
        expect(out.kind).toBe("store-error");
        // The audit trail must not record a completion that never happened.
        expect(events.some((e) => e.event.kind === "completed")).toBe(false);
    });

    test("a complete-now append emits completed exactly once, after completeUpload returns", async () => {
        const seq: string[] = [];
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            completeUpload: async (t, o2) => { seq.push("store.complete"); return store.completeUpload(t, o2); },
        };
        const completed: UploadResourceEvent[] = [];
        const o = createUploadOrchestrator(spy, {
            now: () => NOW, graceMs: 0,
            onUploadEvent: (e) => { if (e.event.kind === "completed") { seq.push("event.completed"); completed.push(e); } },
        });
        const created = await o.create({ key: "k", declaredLength: 3, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") });
        const out = await o.append(created.uploadToken, { offset: 3, contentLength: 0, complete: true });
        expect(out).toMatchObject({ kind: "appended", complete: true });
        expect(completed).toHaveLength(1);
        expect(completed[0]!.event).toEqual({ kind: "completed", length: 3 });
        // Emission strictly follows the store action it describes.
        expect(seq).toEqual(["store.complete", "event.completed"]);
    });

    test("a cancel whose abortUpload throws does NOT emit a cancelled event", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore({
            abortUpload: async () => { throw new Error("discard failed"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.cancel(created.uploadToken);
        expect(out.kind).toBe("store-error");
        expect(events.some((e) => e.event.kind === "cancelled")).toBe(false);
    });

    test("a successful cancel emits cancelled exactly once, after abortUpload returns", async () => {
        const seq: string[] = [];
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            abortUpload: async (t, o2) => { seq.push("store.abort"); return store.abortUpload(t, o2); },
        };
        const cancelled: UploadResourceEvent[] = [];
        const o = createUploadOrchestrator(spy, {
            now: () => NOW, graceMs: 0,
            onUploadEvent: (e) => { if (e.event.kind === "cancelled") { seq.push("event.cancelled"); cancelled.push(e); } },
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.cancel(created.uploadToken);
        expect(out.kind).toBe("cancelled");
        expect(cancelled).toHaveLength(1);
        expect(seq).toEqual(["store.abort", "event.cancelled"]);
    });
});

describe("created outcome anchors expiry at creation start", () => {
    test("a created outcome carries expiresAt anchored at the creation instant", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { maxAgeSeconds: 100 } });
        const out = await o.create({ key: "k", declaredLength: 10, complete: false });
        expect(out).toMatchObject({ kind: "created", expiresAt: NOW + 100_000 });
    });

    test("expiresAt anchors at creation start, not after a slow streaming create", async () => {
        // A streaming create whose body drains over time advertises a deadline
        // pinned to when creation STARTED, not now()+maxAge measured after the
        // stream completes (which would inflate the deadline past real expiry).
        let t = NOW;
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => t, graceMs: 0, policy: { maxAgeSeconds: 100 },
        });
        const body = controlledStream();
        const creating = o.create({ key: "k", complete: false, body: body.stream });
        await new Promise((r) => setTimeout(r, 5));
        t = NOW + 30_000; // clock advances DURING the slow stream
        body.push("abc");
        body.close();
        const out = await creating;
        expect(out.kind).toBe("created");
        if (out.kind !== "created") return;
        expect(out.expiresAt).toBe(NOW + 100_000);
    });

    test("no max age means no expiresAt on the created outcome", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: "k", declaredLength: 5, complete: false });
        expect(out.kind).toBe("created");
        if (out.kind !== "created") return;
        expect(out.expiresAt).toBeUndefined();
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
        // The second probe aborts the first holder's lock signal while it only
        // READS: a probe never threads the signal into a write, so the abort is
        // a harmless no-op and both probes answer the truth.
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

    test("a failing durable re-read after an INTERRUPTED create maps to store-error", async () => {
        // Only an interruption leaves the durable prefix unknown; the clean
        // path derives the offset from the write's return and never re-reads.
        const { store } = fakeStore({
            getUploadState: async () => { throw new Error("state read failed"); },
        });
        const o = orch(store);
        const ctl = new AbortController();
        ctl.abort();
        const out = await o.create({
            key: "k", contentLength: 3, complete: false, body: bodyOf("abc"), signal: ctl.signal,
        });
        expect(out.kind).toBe("store-error");
    });

    test("a clean create with a body never issues a state read", async () => {
        let reads = 0;
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => { reads++; return store.getUploadState(t, opts); },
        };
        const o = orch(spy);
        const out = await o.create({
            key: "k", contentLength: 5, complete: true, body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 5, complete: true });
        expect(reads).toBe(0);
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
                key: "k", offset: 0, isComplete: false, isInvalidated: true, createdAt: NOW,
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

    test("an unverifiable digest on append is ignored, never handed to the store", async () => {
        const digestSeen: (string | undefined)[] = [];
        const { store } = fakeStore({
            digestOnComplete: false,
            completeUpload: async (_t, opts) => { digestSeen.push(opts.expectedDigest); return { etag: '"x"' }; },
        });
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 1, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: true, body: bodyOf("x"), expectedDigest: "anything",
        });
        expect(out.kind).toBe("appended");
        if (out.kind !== "appended") return;
        expect(out.complete).toBe(true);
        expect(digestSeen).toEqual([undefined]);
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

    test("a failing durable re-read after an INTERRUPTED append maps to store-error", async () => {
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
        const ctl = new AbortController();
        ctl.abort();
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 2, complete: false, body: bodyOf("ab"), signal: ctl.signal,
        });
        expect(out.kind).toBe("store-error");
    });

    test("a clean append answers from the write's return: exactly one state read, correct outcome", async () => {
        const { store } = fakeStore();
        let reads = 0;
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => { reads++; return store.getUploadState(t, opts); },
        };
        const o = orch(spy, { policy: { maxAgeSeconds: 60 } });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        reads = 0;
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 4, complete: false, body: bodyOf("wxyz"),
        });
        // The single pre-evaluation read under the lock; offset, length, and
        // the expiry anchor all come from it plus the write's own return.
        expect(reads).toBe(1);
        expect(out).toMatchObject({
            kind: "appended", offset: 4, length: 10, complete: false,
            interrupted: false, expiresAt: NOW + 60_000,
        });
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

    test("a CREATION whose stream hits durable bytes answers offset-mismatch, not a backend error", async () => {
        // A client that took the early location and won the lock with an append
        // before this creation acquired it leaves durable bytes at some offset.
        // Creation always streams at 0, so the store's preflight refuses. That
        // is a recoverable race with a truthful answer; reporting a store error
        // would tell the client the backend failed for a state it can resume
        // from.
        const { store } = fakeStore();
        const conflicted: ResumableWriteStore = {
            ...store,
            appendChunk: async (token) => { throw new UploadOffsetConflictError(token, 3); },
        };
        const o = orch(conflicted);
        const out = await o.create({ key: "k", complete: false, contentLength: 5, body: bodyOf("hello") });
        expect(out).toMatchObject({
            kind: "offset-mismatch", claimedOffset: 0, correctOffset: 3, complete: false,
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

    test("cancel on an invalidated resource frees the bytes instead of refusing", async () => {
        // DELETE must succeed on a dead resource: a client told its upload is
        // invalidated needs to reclaim the partial bytes, and abortUpload is
        // idempotent, so cancel is answered ahead of the terminal refusals.
        let aborted = false;
        const { store } = fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                key: "k", offset: 0, isComplete: false, isInvalidated: true, createdAt: NOW,
            }),
            abortUpload: async () => { aborted = true; },
        });
        const o = orch(store);
        const out = await o.cancel("dead");
        expect(out).toMatchObject({ kind: "cancelled" });
        expect(aborted).toBe(true);
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

describe("implicit completion inference (complete: 'infer')", () => {
    test("an append whose math reaches the stored length completes and publishes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 5, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 5, complete: "infer", body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: true, etag: '"done"' });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("an append whose math falls short of the length stays incomplete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 5, complete: "infer", body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("inference uses a length declared ON this append (deferred-length fixing PATCH)", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 3, complete: "infer", declaredLength: 3, body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, length: 3, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("no known length means no completion, however much lands", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 3, complete: "infer", body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("an unknown-sized body that delivers exactly through the length completes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 5, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const body = controlledStream();
        body.push("hello");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: "infer", body: body.stream,
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("an unknown-sized body that stops short of the length stays incomplete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const body = controlledStream();
        body.push("hello");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: "infer", body: body.stream,
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a zero-content inferred retry at offset == length publishes the crash-window object", async () => {
        // The completing request died after its bytes went durable but before
        // completeUpload: the client's zero-byte PATCH retry (or the dialect's
        // heal) at offset == length must publish, not answer offset-mismatch.
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", declaredLength: 3, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, {
            offset: 0, contentLength: 3, complete: false, body: bodyOf("abc"),
        });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        const out = await o.append(created.uploadToken, {
            offset: 3, contentLength: 0, complete: "infer",
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
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

        // create complete (clean streams derive their offset, no state read),
        // probe, append head + complete, cancel head + abort: every store
        // touchpoint carries the caller signal.
        expect(calls.map((c) => c.op)).toEqual([
            "complete", "state", "state", "complete", "state", "abort",
        ]);
        for (const c of calls) expect(c.signal).toBe(signal);
    });
});

describe("preemption latches before the write begins", () => {
    test("a preempt that lands during the pre-stream window still aborts the append", async () => {
        // A holds the lock and sits in a slow getUploadState (its write has not
        // started); a concurrent probe arrives and aborts A's lock signal. When
        // A reaches its write, the composed signal is already aborted (latched
        // state, not a lost edge), so the append interrupts rather than streams.
        const { store } = fakeStore();
        const slow: ResumableWriteStore = {
            ...store,
            getUploadState: async (t, opts) => {
                await new Promise((r) => setTimeout(r, 30));
                return store.getUploadState(t, opts);
            },
        };
        const o = orch(slow);
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const [appendA, probeB] = await Promise.all([
            o.append(created.uploadToken, {
                offset: 0, contentLength: 3, complete: false, body: bodyOf("abc"),
            }),
            (async () => {
                await new Promise((r) => setTimeout(r, 5));
                return o.probe(created.uploadToken);
            })(),
        ]);
        expect(appendA).toMatchObject({ kind: "appended", interrupted: true });
        expect(probeB.kind).toBe("probed");
    });
});

describe("minSize gate at completion emits and returns cleanly", () => {
    test("a streaming create below the floor emits the rejection and returns empty events", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { minSize: 10 }, onUploadEvent: (e) => events.push(e),
        });
        const out = await o.create({ key: "k", complete: true, body: bodyOf("abc") });
        // The token travels with a rejection that lands AFTER the resource was
        // allocated: without it the bytes already durable are unreachable, so
        // the client can neither resume them nor delete them.
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", uploadToken: "u1", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(events.some((e) => e.event.kind === "append-rejected" && e.event.reason === "below-min-size")).toBe(true);
    });

    test("a complete-now zero-content append below the floor does NOT publish and emits its offset", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { minSize: 10 }, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false }); // deferred length
        if (created.kind !== "created") throw new Error("setup");
        // First append declares length 2 and lands both bytes: offset === length,
        // still incomplete, so the tail is a zero-content completing append.
        await o.append(created.uploadToken, {
            offset: 0, contentLength: 2, complete: false, declaredLength: 2, body: bodyOf("ab"),
        });
        // That completing tail is a complete-now verdict whose total (2) is under
        // the floor (10): the gate must refuse it before publishing.
        const out = await o.append(created.uploadToken, { offset: 2, contentLength: 0, complete: true });
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(events.some((e) => e.event.kind === "append-rejected"
            && e.event.reason === "below-min-size" && e.event.atOffset === 2)).toBe(true);
    });

    test("a streaming completing append below the floor emits the rejection with its offset", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { minSize: 10 }, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0, contentLength: 1, complete: true, body: bodyOf("x"),
        });
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(events.some((e) => e.event.kind === "append-rejected"
            && e.event.reason === "below-min-size" && e.event.atOffset === 0)).toBe(true);
    });
});

describe("deferred-length threading on an empty append", () => {
    test("a no-body append that declares a length persists it via the write path", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: "k", complete: false }); // deferred length
        if (created.kind !== "created") throw new Error("setup");
        // No body, but this append first declares the total length. The write
        // path is what records the length, so an empty append must still reach
        // it (the store persists the length even for zero bytes).
        const appended = await o.append(created.uploadToken, {
            offset: 0, complete: false, declaredLength: 10,
        });
        expect(appended).toMatchObject({ kind: "appended", offset: 0, length: 10 });
        // A subsequent probe reads the durable length from the store, proving the
        // empty append persisted it rather than only echoing the request value.
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 0, length: 10 });
    });

    test("a no-body append without a declared length never calls the writer", async () => {
        let appendCalls = 0;
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            appendChunk: (t, off, body, opts) => { appendCalls++; return store.appendChunk(t, off, body, opts); },
        };
        const o = orch(spy);
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, { offset: 0, complete: false });
        expect(out).toMatchObject({ kind: "appended", offset: 0, length: 10, interrupted: false });
        // Nothing to write and no length to record: the writer is untouched.
        expect(appendCalls).toBe(0);
    });
});

describe("policy validation field coverage", () => {
    test("each field is validated, zero is allowed, and equal bounds pass", () => {
        const { store } = fakeStore();
        const mk = (policy: object) => () => createUploadOrchestrator(store, { now: () => NOW, policy });
        // Per-field non-negativity: each field has its own row in the table, so a
        // lone invalid value (no inverted-pair to catch it) must still throw.
        expect(mk({ minSize: -1 })).toThrow(TypeError);
        expect(mk({ minAppendSize: -1 })).toThrow(TypeError);
        expect(mk({ maxAgeSeconds: -1 })).toThrow(TypeError);
        // Zero is a valid non-negative bound: the floor is `< 0`, not `<= 0`.
        expect(mk({ minSize: 0, maxSize: 0 })).not.toThrow();
        expect(mk({ minAppendSize: 0, maxAppendSize: 0 })).not.toThrow();
        expect(mk({ maxAgeSeconds: 0 })).not.toThrow();
        // Equal floor and ceiling are allowed: the inverted-pair check is strict
        // `>`, not `>=`.
        expect(mk({ minSize: 5, maxSize: 5 })).not.toThrow();
        expect(mk({ minAppendSize: 5, maxAppendSize: 5 })).not.toThrow();
        // A correctly ordered append window with BOTH bounds present constructs
        // (min below max, both defined).
        expect(mk({ minAppendSize: 3, maxAppendSize: 5 })).not.toThrow();
    });
});

// ─── Fatal append bound: the client's fault, answered as one ────────────────

describe("a body past a REPRESENTATION bound", () => {
    test("a creation whose content exceeds the length it declares is refused before anything is allocated", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });

        const out = await o.create({
            key: "k", declaredLength: 10, contentLength: 50, complete: false, body: bodyOf("x".repeat(50)),
        });

        expect(out.kind).toBe("length-inconsistent");
        // Refusing up front is the whole point: reaching the store would
        // truncate at the bound and destroy an upload the client was just told
        // it had created.
        expect(uploads.size).toBe(0);
    });

    test("a chunked body past the declared length answers 400, names the resource, and records the rejection", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", declaredLength: 4, complete: false });
        if (created.kind !== "created") throw new Error("setup");
        events.length = 0;

        // No content length: the overrun is only discoverable while streaming.
        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        expect(out).toEqual({
            kind: "length-inconsistent",
            uploadToken: created.uploadToken,
            events: [],
        });
        expect(uploads.get(created.uploadToken)!.isInvalidated).toBe(true);
        // An upload destroyed with no audit record is the failure this pins.
        expect(events.map((e) => e.event)).toEqual([
            { kind: "append-accepted", atOffset: 0, completes: false },
            { kind: "append-rejected", reason: "length-inconsistent", atOffset: 0 },
        ]);
    });

    test("a chunked body past the policy maximum is a size violation, not a length one", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 4 },
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        // Both bounds invalidate; only the answer differs, and the client never
        // declared a length to be inconsistent with.
        expect(out).toEqual({
            kind: "limit-violation",
            reason: "size-exceeded",
            uploadToken: created.uploadToken,
            events: [],
        });
    });

    test("a NON-fatal ceiling leaves the resource healthy and hands back its token", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxAppendSize: 4 },
        });

        const out = await o.create({ key: "k", complete: false, body: bodyOf("0123456789") });

        // Without the token the four durable bytes are unreachable: not
        // resumable, not deletable, reclaimed only by a sweep that may never run.
        expect(out.kind).toBe("limit-violation");
        if (out.kind !== "limit-violation") throw new Error("kind");
        expect(out.uploadToken).toBeDefined();
        const live = uploads.get(out.uploadToken!)!;
        expect(live.isInvalidated).toBe(false);
        expect(live.bytes.byteLength).toBe(4);
    });
});

// ─── The offset check the whole capability flag exists for ──────────────────

describe("a store-detected offset conflict", () => {
    test("records the rejection instead of leaving an accepted append in the trail", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore({
            async appendChunk(token) {
                // The stolen-lock case: durable state disagrees with the claim.
                throw new UploadOffsetConflictError(token, 7);
            },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        events.length = 0;

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"),
        });

        expect(out).toMatchObject({ kind: "offset-mismatch", claimedOffset: 0, correctOffset: 7 });
        expect(events.map((e) => e.event)).toEqual([
            { kind: "append-accepted", atOffset: 0, completes: false },
            { kind: "append-rejected", reason: "offset-mismatch", atOffset: 0 },
        ]);
    });
});

// ─── The audit key substitutes on every reporting surface ───────────────────

describe("auditKey and the token", () => {
    test("a store failure reports the audit key, never the capability", async () => {
        const seen: Array<{ uploadToken?: string; auditKey?: string; operation: string }> = [];
        const { store } = fakeStore({
            async appendChunk() { throw new Error("backend down"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (_err, ctx) => seen.push(ctx),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("abc"), auditKey: "safe-id",
        });

        expect(seen).toEqual([{ uploadToken: undefined, auditKey: "safe-id", operation: "append" }]);
    });

    test("without an audit key the token is what identifies the resource", async () => {
        const seen: Array<{ uploadToken?: string; auditKey?: string; operation: string }> = [];
        const { store } = fakeStore({
            async appendChunk() { throw new Error("backend down"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (_err, ctx) => seen.push(ctx),
        });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("abc") });

        expect(seen).toEqual([
            { uploadToken: created.uploadToken, auditKey: undefined, operation: "append" },
        ]);
    });

    test("a resource-existence check reports a backend failure rather than absorbing it", async () => {
        const seen: string[] = [];
        const { store } = fakeStore({
            async getUploadState() { throw new Error("backend down"); },
        });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onError: (_err, ctx) => seen.push(ctx.operation),
        });

        // Fail-open is the right answer, silence is not: a persistent failure
        // on this gate is otherwise completely invisible.
        expect(await o.resourceExists("whatever")).toBe(true);
        expect(seen).toEqual(["head"]);
    });

    test("a backend failure with NO onError configured still answers true", async () => {
        // The hook is optional, so the reporting path has to tolerate its
        // absence: calling an absent sink would turn a backend outage into a
        // TypeError thrown out of the gate a caller uses to avoid one.
        const { store } = fakeStore({
            async getUploadState() { throw new Error("backend down"); },
        });
        const o = orch(store);

        expect(await o.resourceExists("whatever")).toBe(true);
    });
});

// ─── A length declared on the completing append is a fact to record ─────────

describe("deferred length declared at completion", () => {
    test("the length the request declares is persisted, not just acted on", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");
        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("0123456789") });

        // Bodyless completing PATCH that declares the total for the first time.
        const out = await o.append(created.uploadToken, {
            offset: 10, contentLength: 0, complete: true, declaredLength: 10,
        });

        expect(out).toMatchObject({ kind: "appended", complete: true, length: 10 });
        // Publishing an upload whose length the store never learned leaves a
        // completed resource that denies knowing its own size.
        expect(uploads.get(created.uploadToken)!.length).toBe(10);
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", complete: true, length: 10 });
    });
});

// ─── A cancel must survive whatever state the resource is in ────────────────

describe("cancel on malformed bookkeeping", () => {
    test("a resource whose state is nonsense can still be discarded", async () => {
        const { store, uploads } = fakeStore({
            async getUploadState() {
                // Offset past the length, and a non-finite creation time: the
                // shape most likely to have been corrupted is the one most in
                // need of being deletable.
                return {
                    key: "k", offset: 99, length: 10, isComplete: false, isInvalidated: false,
                    createdAt: Number.NaN,
                } satisfies StoredUploadState;
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = await o.create({ key: "k", complete: false });
        if (created.kind !== "created") throw new Error("setup");

        expect(await o.cancel(created.uploadToken)).toEqual({ kind: "cancelled" });
        expect(uploads.has(created.uploadToken)).toBe(false);
    });
});

// ─── Which representation bound binds decides the answer ────────────────────

describe("two representation bounds at once", () => {
    test("the policy maximum below the declared length answers as a size violation", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 4 },
        });
        // A length accepted under the old policy outlives a redeploy that
        // tightens the maximum, so the server ceiling is what the body crosses.
        const lenient = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 100 },
        });
        const created = await lenient.create({ key: "k", declaredLength: 100, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        expect(out).toEqual({
            kind: "limit-violation",
            reason: "size-exceeded",
            uploadToken: created.uploadToken,
            events: [],
        });
    });

    test("the declared length below the policy maximum answers as a length inconsistency", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 100 },
        });
        const created = await o.create({ key: "k", declaredLength: 4, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        expect(out).toEqual({
            kind: "length-inconsistent",
            uploadToken: created.uploadToken,
            events: [],
        });
    });

    test("equal bounds answer as the client's own broken declaration", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 4 },
        });
        // Declaring exactly the maximum is allowed; sending past it breaks the
        // declaration the client made, which is the more specific statement.
        const created = await o.create({ key: "k", declaredLength: 4, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        expect(out).toMatchObject({ kind: "length-inconsistent" });
    });

    test("a per-request ceiling below both stays non-fatal and resumable", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 100, maxAppendSize: 4 },
        });
        const created = await o.create({ key: "k", declaredLength: 50, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const out = await o.append(created.uploadToken, {
            offset: 0, complete: false, body: bodyOf("0123456789"),
        });

        // The representation is untouched: destroying the upload over a
        // per-request cap turns a resumable situation into a lost one.
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
        expect(uploads.get(created.uploadToken)!.isInvalidated).toBe(false);
        expect(uploads.get(created.uploadToken)!.bytes.byteLength).toBe(4);
    });
});

// ─── Learning which object an upload became ─────────────────────────────────

describe("onUploadComplete", () => {
    /**
     * What the completion hook reports, read off the orchestrator's own option
     * type so a field added there fails these assertions instead of being
     * silently dropped from the recorded shape.
     */
    type Landed = Parameters<NonNullable<UploadOrchestratorOptions["onUploadComplete"]>>[0];

    test("a creation that also completes reports its key", async () => {
        const landed: Landed[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadComplete: (info) => { landed.push(info); },
        });

        const out = await o.create({ key: "docs/q4.pdf", complete: true, body: bodyOf("payload") });

        expect(out).toMatchObject({ kind: "created", complete: true });
        // The key is chosen before a token exists, so without this the two
        // cannot be paired afterwards except by racing the creation call.
        expect(landed).toEqual([{
            uploadToken: "u1",
            auditKey: undefined,
            key: "docs/q4.pdf",
            length: 7,
            metadata: undefined,
            etag: '"done"',
            digest: undefined,
        }]);
    });

    test("a streaming upload finished by a later append reports it too", async () => {
        const landed: Landed[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadComplete: (info) => { landed.push(info); },
        });
        const created = await o.create({ key: "docs/big.bin", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        await o.append(created.uploadToken, {
            offset: 0, contentLength: 10, complete: true, body: bodyOf("0123456789"),
            auditKey: "safe-id",
        });

        expect(landed).toHaveLength(1);
        expect(landed[0]).toMatchObject({ key: "docs/big.bin", length: 10, auditKey: "safe-id" });
    });

    test("it fires once, and never for an upload that did not publish", async () => {
        const landed: Landed[] = [];
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadComplete: (info) => { landed.push(info); },
        });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        // A partial append publishes nothing, so there is nothing to record.
        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("01234") });
        expect(landed).toEqual([]);

        await o.append(created.uploadToken, { offset: 5, complete: true, body: bodyOf("56789") });
        expect(landed).toHaveLength(1);
    });

    test("a throwing hook fails the request rather than acknowledging an unrecorded object", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadComplete: () => { throw new Error("database is down"); },
            onError: () => {},
        });

        const out = await o.create({ key: "k", complete: true, body: bodyOf("payload") });

        // Telling the client it landed while the consumer's own records never
        // saw it leaves an object nothing points at.
        expect(out.kind).toBe("store-error");
    });

    test("the client's retry after a failed delivery re-delivers, so the hook is at-least-once", async () => {
        // Without this the hook is at-most-once and its own promise cannot be
        // kept: the publish succeeded, the throw told the client the backend
        // failed, and the client's retry is answered already-complete. The
        // client then believes the upload landed, the consumer's records never
        // saw it, and no protocol path invokes the hook again.
        const { store } = fakeStore();
        const landed: string[] = [];
        let failNext = true;
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0,
            onUploadComplete: (info) => {
                if (failNext) {
                    failNext = false;
                    throw new Error("database is down");
                }
                landed.push(info.key);
            },
            onError: () => {},
        });

        const created = await o.create({ key: "k", complete: false, contentLength: 7, body: bodyOf("payload") });
        if (created.kind !== "created") throw new Error("setup");

        const first = await o.append(created.uploadToken, { offset: 7, complete: true });
        expect(first.kind).toBe("store-error");
        expect(landed).toEqual([]);

        // The same completing request again: the object is already published,
        // so the answer is the idempotent one and the record is finally made.
        const retry = await o.append(created.uploadToken, { offset: 7, complete: true });
        expect(retry.kind).toBe("already-complete");
        expect(landed).toEqual(["k"]);
    });
});

// ─── A policy that contradicts itself is refused where it is written ────────

describe("policy coherence at construction", () => {
    const build = (policy: Record<string, number>) => () =>
        createUploadOrchestrator(fakeStore().store, { now: () => NOW, graceMs: 0, policy });

    test("a floor above its ceiling is refused, on both pairs", () => {
        // Accepting it would mean every upload is rejected at runtime for a
        // reason nothing points back at the configuration that caused it.
        expect(build({ minSize: 10, maxSize: 4 })).toThrow(TypeError);
        expect(build({ minAppendSize: 10, maxAppendSize: 4 })).toThrow(TypeError);
    });

    test("the message names both bounds and their values", () => {
        expect(build({ minSize: 10, maxSize: 4 })).toThrow(/minSize \(10\) exceeds maxSize \(4\)/);
        expect(build({ minAppendSize: 9, maxAppendSize: 2 }))
            .toThrow(/minAppendSize \(9\) exceeds maxAppendSize \(2\)/);
    });

    test("equal bounds are coherent, and one bound alone is never contradictory", () => {
        expect(build({ minSize: 4, maxSize: 4 })).not.toThrow();
        expect(build({ minAppendSize: 4, maxAppendSize: 4 })).not.toThrow();
        expect(build({ minSize: 10 })).not.toThrow();
        expect(build({ maxSize: 4 })).not.toThrow();
        expect(build({ minAppendSize: 10 })).not.toThrow();
        expect(build({ maxAppendSize: 4 })).not.toThrow();
    });
});

// ─── The lock deadline reaches the locker that was installed ────────────────

describe("lockTimeoutMs", () => {
    test("a request that cannot get the lock in time answers contended", async () => {
        const { store } = fakeStore();
        const locker = memoryUploadLocker({ acquireTimeoutMs: 30_000 });
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, locker, lockTimeoutMs: 40,
        });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        // Hold the lock outside the orchestrator so the next call has to wait.
        const held = await locker.acquire(created.uploadToken);
        const out = await o.probe(created.uploadToken);
        held.release();

        // The orchestrator's deadline wins over the locker's own default, so
        // the knob is reachable whichever locker is installed.
        expect(out).toEqual({ kind: "contended", events: [] });
    });

    test("with no deadline configured the locker's own default applies", async () => {
        const { store } = fakeStore();
        const locker = memoryUploadLocker({ acquireTimeoutMs: 40 });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0, locker });
        const created = await o.create({ key: "k", declaredLength: 10, complete: false });
        if (created.kind !== "created") throw new Error("setup");

        const held = await locker.acquire(created.uploadToken);
        const out = await o.probe(created.uploadToken);
        held.release();

        expect(out).toEqual({ kind: "contended", events: [] });
    });
});

// ─── A fatal bound on the creation body answers by which bound it was ───────

describe("a creation body past a representation bound", () => {
    test("past the declared length is a length inconsistency, and names the resource", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });

        // Declared length with no content length: the overrun is only
        // discoverable while the body streams.
        const out = await o.create({ key: "k", declaredLength: 4, complete: false, body: bodyOf("0123456789") });

        expect(out).toMatchObject({ kind: "length-inconsistent" });
        if (out.kind !== "length-inconsistent") throw new Error("kind");
        expect(out.uploadToken).toBe("u1");
        expect(uploads.get("u1")!.isInvalidated).toBe(true);
    });

    test("past the policy maximum is a size violation", async () => {
        const { store } = fakeStore();
        const o = createUploadOrchestrator(store, {
            now: () => NOW, graceMs: 0, policy: { maxSize: 4 },
        });

        const out = await o.create({ key: "k", complete: false, body: bodyOf("0123456789") });

        expect(out).toMatchObject({ kind: "limit-violation", reason: "size-exceeded", uploadToken: "u1" });
    });
});
