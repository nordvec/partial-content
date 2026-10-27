import { describe, test, expect } from "bun:test";
import {
    createUploadOrchestrator,
    type UploadOrchestratorOptions,
    type UploadResourceEvent,
} from "../upload-orchestrator";
import {
    UploadAppendBoundError,
    UploadDestinationConflictError,
    UploadDigestMismatchError,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadOverrunError,
    type ResumableWriteStore,
    type StoredUploadState,
} from "../upload-store";
import { UPLOAD_LEASE_LOST, UploadLockTimeoutError, memoryUploadLocker, type UploadLocker } from "../upload-locker";
import { StoreUnavailableError } from "../object-store";
import { corruptUploadState, isCorruptUploadState } from "../upload-internals";

const NOW = 1_800_000_000_000;

interface FakeUpload {
    key: string;
    bytes: Uint8Array;
    length?: number;
    isComplete: boolean;
    isInvalidated: boolean;
    createdAt: number;
    expiresAt?: number;
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
        digestOnComplete: ["sha-256"],
        async createUpload(opts) {
            const uploadToken = `u${++seq}`;
            uploads.set(uploadToken, {
                key: opts.key,
                bytes: new Uint8Array(0),
                length: opts.length,
                isComplete: false,
                isInvalidated: false,
                createdAt: opts.now,
                expiresAt: opts.expiresAt,
            });
            return { uploadToken };
        },
        async getUploadState(token): Promise<StoredUploadState> {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            return {
                key: u.key,
                offset: u.bytes.byteLength,
                length: u.length,
                status: u.isInvalidated ? "invalidated" : u.isComplete ? "complete" : "incomplete",
                createdAt: u.createdAt,
                expiresAt: u.expiresAt,
                lastAppendAt: u.lastAppendAt,
            };
        },
        async appendChunk(token, offset, body, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            let written = 0;
            let crossedBound = false;
            let interrupted = false;
            const chunks: Uint8Array[] = [];
            /** Take as much as the bound allows; false = the body crossed it. */
            const accept = (chunk: Uint8Array): boolean => {
                const room =
                    opts.maxBytes === undefined
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
                        if (opts.signal?.aborted) {
                            interrupted = true;
                            break;
                        }
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!accept(value)) break;
                    }
                } catch {
                    // torn body: keep the flushed prefix
                    interrupted = true;
                }
            }
            const merged = new Uint8Array(u.bytes.byteLength + written);
            merged.set(u.bytes, 0);
            let at = u.bytes.byteLength;
            for (const c of chunks) {
                merged.set(c, at);
                at += c.byteLength;
            }
            u.bytes = merged;
            u.lastAppendAt = opts.now;
            // Persist a length first declared on this append (deferred-length).
            if (opts.length !== undefined && u.length === undefined) u.length = opts.length;
            // The contract reports a yield rather than raising one: an abort
            // that reached this store never surfaces as an exception.
            if (opts.signal?.aborted) return { bytesWritten: written, interrupted: true };
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
            return { bytesWritten: written, interrupted };
        },
        async completeUpload(token, opts) {
            const u = uploads.get(token);
            if (!u) throw new UploadNotFoundError(token);
            if (opts.expectedLength !== u.bytes.byteLength)
                throw new UploadOffsetConflictError(token, u.bytes.byteLength);
            const expected = opts.expectedDigests?.["sha-256"];
            if (expected !== undefined && expected !== "GOOD") {
                throw new UploadDigestMismatchError(token, "sha-256", expected);
            }
            u.isComplete = true;
            u.length = u.bytes.byteLength;
            return { etag: '"done"', digest: opts.expectedDigests?.["sha-256"] };
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
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
    });
    return {
        stream,
        push: (text: string) => controller.enqueue(bodyOf(text)),
        close: () => controller.close(),
        error: (e: unknown) => controller.error(e),
    };
}

/** The orchestrator's own options, so a callback passed by a test keeps its types. */
type OrchOptions = Partial<Parameters<typeof createUploadOrchestrator>[1]>;

const orch = (store: ResumableWriteStore, over: OrchOptions = {}) =>
    createUploadOrchestrator(store, { now: () => NOW, graceMs: 0, ...over });

type CreateResult = Awaited<ReturnType<ReturnType<typeof orch>["create"]>>;

/**
 * The created upload, or a thrown setup failure.
 *
 * `create` answers a union, so every test that goes on to use `uploadToken`
 * has to narrow first, and eighty-six of them wrote the same two lines. It
 * THROWS rather than asserting on purpose: an arrange step that did not
 * succeed is a broken test, not a failing one, and `expect` there sends the
 * reader after the behaviour instead of after the setup. The thrown message
 * names what came back instead, which the bare `"setup"` did not.
 */
/** Creates a 3-byte upload on "k" and appends "abc" at offset 0 as the completing request. */
async function appendAbcAsFinal(o: ReturnType<typeof orch>) {
    const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
    const out = await o.append(created.uploadToken, {
        offset: 0,
        contentLength: 3,
        complete: true,
        body: bodyOf("abc"),
    });
    return { created, out };
}

function createdOk(out: CreateResult): Extract<CreateResult, { kind: "created" }> {
    if (out.kind !== "created") {
        throw new Error(`setup: create answered ${out.kind}, not "created"`);
    }
    return out;
}

/**
 * An orchestrator with one upload already created: the arrangement almost
 * every test below needs before it can act on anything. The creation is
 * narrowed through {@link createdOk}, so a failed arrange step throws.
 *
 * The created result is returned as well as the token, because a few tests
 * assert on the creation itself and re-creating to get at it would be a
 * different upload.
 */
async function startUpload(
    store: ResumableWriteStore,
    over: OrchOptions = {},
    createOpts: Parameters<ReturnType<typeof orch>["create"]>[0] = { key: () => "k", complete: false },
) {
    const o = orch(store, over);
    const created = createdOk(await o.create(createOpts));
    return { o, created, token: created.uploadToken };
}

describe("create", () => {
    test("allocates and reports the token, offset zero, incomplete", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: () => "doc.bin", declaredLength: 10, complete: false });
        expect(out).toMatchObject({ kind: "created", offset: 0, length: 10, complete: false, interrupted: false });
    });

    test("single-shot create streams the body and completes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: () => "doc.bin",
            contentLength: 5,
            complete: true,
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 5, complete: true, etag: '"done"' });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("policy rejection passes through before any store call", async () => {
        let created = 0;
        const { store } = fakeStore({
            createUpload: async () => {
                created++;
                return { uploadToken: "x" };
            },
        });
        const o = orch(store, { policy: { maxSize: 4 } });
        const out = await o.create({ key: () => "k", declaredLength: 10, complete: false });
        expect(out.kind).toBe("limit-violation");
        expect(created).toBe(0);
    });

    test("an interrupted single-shot create does NOT complete and reports the durable offset", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.create({
            key: () => "k",
            contentLength: 10,
            complete: true,
            body: body.stream,
            signal: ctl.signal,
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
            completeUpload: async (_t, opts) => {
                digestSeen.push(opts.expectedDigests?.["sha-256"]);
                return { etag: '"x"' };
            },
        });
        const o = orch(store);
        const out = await o.create({
            key: () => "k",
            complete: true,
            contentLength: 1,
            body: bodyOf("x"),
            expectedDigests: { "sha-256": "GOOD" },
        });
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
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 5, complete: false }));
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
        const { o, created } = await startUpload(store);
        expect((await o.cancel(created.uploadToken)).kind).toBe("cancelled");
        expect((await o.probe(created.uploadToken)).kind).toBe("not-found");
    });
});

describe("append", () => {
    async function withUpload(policy = {}) {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
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
            offset: 0,
            contentLength: 10,
            complete: true,
            body: body.stream,
            signal: ctl.signal,
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
            kind: "appended",
            offset: 10,
            length: 10,
            complete: true,
            etag: '"done"',
            interrupted: false,
        });
    });

    test("digest mismatch from the store maps to digest-mismatch, never a torn publish", async () => {
        const { o, token, uploads } = await withUpload();
        await o.append(token, { offset: 0, contentLength: 10, complete: false, body: bodyOf("0123456789") });
        const out = await o.append(token, {
            offset: 10,
            contentLength: 0,
            complete: true,
            expectedDigests: { "sha-256": "BAD" },
        });
        expect(out).toEqual({ kind: "digest-mismatch", uploadToken: token });
        // Verification runs before publication, so the staged representation is
        // scrap the client has no reason to delete and no way to finish. It is
        // discarded with the verdict rather than left for a sweep.
        expect(uploads.size).toBe(0);
    });

    test("store failures surface as store-error and report to onError", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            appendChunk: async () => {
                throw new Error("backend down");
            },
        });
        const { o, created } = await startUpload(store, { onError: (_e, ctx) => errors.push(ctx.operation) });
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: false,
            body: bodyOf("x"),
        });
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["append"]);
    });
});

describe("concurrency and hooks", () => {
    test("a concurrent probe preempts a hung append instead of waiting it out", async () => {
        const { store } = fakeStore();
        const { o, created } = await startUpload(store);

        const body = controlledStream();
        const hungAppend = o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: body.stream,
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
                appendChunk: async () => {
                    throw build();
                },
            });
            const o = orch(store, {
                policy: { maxSize: 4 },
                onUploadEvent: (e) => events.push(e),
            });

            const out = await o.create({ key: () => "k", complete: false, body: bodyOf("abcdefgh") });

            const rejected = events.map((e) => e.event).filter((e) => e.kind === "append-rejected");
            expect(rejected, label).toEqual([{ kind: "append-rejected", reason, atOffset: 0 }]);
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
        const o = orch(wrapped, {
            onUploadEvent: (e) => events.push(e),
        });

        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
        });

        events.length = 0;
        failNext = true;
        const out = await o.append(created.uploadToken, {
            offset: 3,
            contentLength: 5,
            complete: false,
            body: bodyOf("defgh"),
        });

        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
        // The engine accepts the intent before the store refuses the bytes, so
        // the accepted event precedes the rejection; the rejection is the one
        // carrying the resume point.
        expect(events.map((e) => e.event).filter((e) => e.kind === "append-rejected")).toEqual([
            { kind: "append-rejected", reason: "append-too-large", atOffset: 3 },
        ]);
    });

    test("a ceiling rejection carries the durable offset on both the create and the append path", async () => {
        // A refusal at this request's ceiling is resumable, and the offset the
        // client must resume from is already in the store's hand at the moment
        // it refuses. Carrying it on the outcome is what spares the client the
        // extra probe; naming only the reason would force one on a path where
        // the server already held the number.
        const { store: onCreate } = fakeStore();
        const created = await orch(onCreate, { policy: { maxAppendSize: 4 } }).create({
            key: () => "k",
            complete: false,
            body: bodyOf("0123456789"),
        });
        // The events were emitted as they happened; the outcome carries none.
        expect(created).toEqual({
            kind: "limit-violation",
            reason: "append-too-large",
            uploadToken: expect.any(String),
            durableOffset: 4,
            events: [],
        });

        const { store } = fakeStore();
        const o = orch(store, { policy: { maxAppendSize: 4 } });
        const allocated = createdOk(await o.create({ key: () => "k", complete: false }));
        await o.append(allocated.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
        });

        const refused = await o.append(allocated.uploadToken, {
            offset: 3,
            complete: false,
            body: bodyOf("defghijkl"),
        });
        // Neither the offset the append started at (3) nor the bytes this
        // request managed to land (4): the resume point is where the durable
        // prefix now ends, which is what a probe would have answered.
        expect(refused).toEqual({
            kind: "limit-violation",
            reason: "append-too-large",
            durableOffset: 7,
            events: [],
        });
        expect(await o.probe(allocated.uploadToken)).toMatchObject({ kind: "probed", offset: 7 });
    });

    test("a creation failure naming the storage key reaches onError projected", async () => {
        // Creation has no token yet, but the backend already knows the key and
        // names it in its failure: the audit key promises the key reaches no
        // reporting surface either, so the message stays behind.
        const seen: { err: unknown; ctx: { uploadToken?: string; auditKey?: string } }[] = [];
        const { store } = fakeStore({
            createUpload: async () => {
                throw new Error("bucket: access denied on reports/2026/q3.bin");
            },
        });
        const o = orch(store, {
            onError: (err, ctx) => seen.push({ err, ctx }),
        });

        const out = await o.create({ key: () => "reports/2026/q3.bin", complete: false, auditKey: "doc-7" });

        expect(out.kind).toBe("store-error");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.err).toEqual({ name: "Error", operation: "create" });
        expect(seen[0]!.ctx.uploadToken).toBeUndefined();
        expect(seen[0]!.ctx.auditKey).toBe("doc-7");
    });

    test("upload events are emitted with the auditKey and a throwing hook routes to onError", async () => {
        const events: UploadResourceEvent[] = [];
        const errors: string[] = [];
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadEvent: (e) => {
                events.push(e);
                if (e.event.kind === "created") throw new Error("audit sink down");
            },
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const created = createdOk(await o.create({ key: () => "secret-name.pdf", complete: false, auditKey: "doc-7" }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 2,
            complete: false,
            body: bodyOf("ab"),
            auditKey: "doc-7",
        });

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
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
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
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: false,
            body: bodyOf("abcde"),
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
        const { o, created } = await startUpload(store, { policy: { maxAppendSize: 4 } });

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large" });
        // Alive, not invalidated, with the accepted prefix durable.
        const record = uploads.get(created.uploadToken)!;
        expect(record.isInvalidated).toBe(false);

        const probed = await o.probe(created.uploadToken);
        expect(probed.kind).toBe("probed");
        if (probed.kind !== "probed") return;
        const resumed = await o.append(created.uploadToken, {
            offset: probed.offset,
            complete: false,
            body: bodyOf("ab"),
        });
        expect(resumed.kind).toBe("appended");
    });

    test("an unknown-length body past a REPRESENTATION bound still invalidates", async () => {
        // The other half of the same split: maxSize bounds the representation,
        // so bytes past it are the terminal fault and the resource dies. The
        // per-request ceiling must not have softened this.
        const { store, uploads } = fakeStore();
        const { o, created } = await startUpload(store, { policy: { maxSize: 4 } });

        await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
        });
        expect(uploads.get(created.uploadToken)!.isInvalidated).toBe(true);
    });

    test("verifiedDigests reflects the store capability", async () => {
        const { store } = fakeStore();
        expect(orch(store).verifiedDigests).toEqual(["sha-256"]);
        const { store: noDigest } = fakeStore({ digestOnComplete: false });
        expect(orch(noDigest).verifiedDigests).toEqual([]);
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
        expect(() => createUploadOrchestrator(unchecked, { now: () => NOW })).toThrow(/enforcesOffsetCheck/);
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

    test("a timing option that is not a usable millisecond count is refused, naming the option", () => {
        const { store } = fakeStore();
        const mk = (o: object) => () => createUploadOrchestrator(store, { now: () => NOW, ...o });
        for (const graceMs of [NaN, -1, 1.5, Infinity, 2 ** 31]) {
            expect(mk({ graceMs })).toThrow(
                new TypeError(
                    `createUploadOrchestrator: graceMs must be an integer from 0 to 2147483647, got ${graceMs}`,
                ),
            );
        }
        for (const lockTimeoutMs of [NaN, -1, 0, 1.5, Infinity, 2 ** 31]) {
            expect(mk({ lockTimeoutMs })).toThrow(
                new TypeError(
                    `createUploadOrchestrator: lockTimeoutMs must be an integer from 1 to 2147483647, got ${lockTimeoutMs}`,
                ),
            );
        }
        expect(mk({ graceMs: 0, lockTimeoutMs: 1 })).not.toThrow();
        expect(mk({ graceMs: 2 ** 31 - 1, lockTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
    });
});

describe("minSize at completion", () => {
    test("a known-total single-shot create below the floor is refused before allocation", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const out = await o.create({ key: () => "k", contentLength: 3, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        // The engine rejects a known-under-floor total at creation: nothing allocated.
        expect(uploads.size).toBe(0);
    });

    test("a STREAMING completing create below the floor does NOT publish (post-stream check)", async () => {
        // Unknown content size at creation: the floor can only be checked after
        // the bytes land. The object is allocated then must not be published.
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a deferred-length upload cannot slip under the floor via a tiny completing append", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const created = await o.create({ key: () => "k", complete: false }); // no length
        if (created.kind !== "created") throw new Error("setup");
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: true,
            body: bodyOf("x"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("at or above the floor completes normally", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minSize: 3 } });
        const out = await o.create({ key: () => "k", contentLength: 3, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "created", complete: true });
    });
});

describe("deferred-length persistence", () => {
    test("a length declared on a later append persists and drives completion", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: () => "k", complete: false }); // no length
        if (created.kind !== "created") throw new Error("setup");

        // First append carries the length AND the first bytes.
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: false,
            declaredLength: 10,
            body: bodyOf("01234"),
        });
        // The store now reports the length: a probe sees it, and a wrong
        // second declaration is rejected as immutable.
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 5, length: 10 });
        const conflict = await o.append(created.uploadToken, {
            offset: 5,
            contentLength: 5,
            complete: false,
            declaredLength: 999,
            body: bodyOf("56789"),
        });
        expect(conflict.kind).toBe("length-inconsistent");

        // The correct completing append reaches the persisted length and publishes.
        const done = await o.append(created.uploadToken, {
            offset: 5,
            contentLength: 5,
            complete: true,
            body: bodyOf("56789"),
        });
        expect(done).toMatchObject({ kind: "appended", offset: 10, complete: true });
    });
});

describe("create runs under the lock", () => {
    test("a resume that races a still-flushing creation is serialized, not concurrent", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const body = controlledStream();
        // Start a completing creation whose body stays open (holds the lock).
        const creating = o.create({ key: () => "k", complete: false, body: body.stream });
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
                return { bytesWritten: 0, interrupted: false };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 60_000 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
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
                return { bytesWritten: 0, interrupted: false };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
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
                return { bytesWritten: 0, interrupted: false };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        const pending = o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
        });
        ctl.abort();
        await pending;
        // The default window (10s) absorbs the abort: the store flush finishes.
        expect(sawAbortedSignal).toBe(false);
    });

    /** appendChunk that waits for its signal to abort (bounded fallback). */
    function abortAwaitingAppend(record: { sawAbort?: boolean }) {
        return async (
            _t: string,
            _o: number,
            _b: ReadableStream<Uint8Array> | Uint8Array,
            opts: { signal?: AbortSignal },
        ) => {
            await new Promise<void>((resolve) => {
                if (opts.signal?.aborted) return resolve();
                opts.signal?.addEventListener("abort", () => resolve(), { once: true });
                setTimeout(resolve, 500);
            });
            record.sawAbort = opts.signal?.aborted ?? false;
            return { bytesWritten: 0, interrupted: false };
        };
    }

    test("the grace window ENDS: a mid-append client abort reaches the store after graceMs", async () => {
        const record: { sawAbort?: boolean } = {};
        let begun!: () => void;
        const begunP = new Promise<void>((r) => {
            begun = r;
        });
        const inner = abortAwaitingAppend(record);
        const { store } = fakeStore({
            appendChunk: async (t, o2, b, opts) => {
                begun();
                return inner(t, o2, b, opts);
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 20 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: body.stream,
            signal: ctl.signal,
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
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        ctl.abort();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
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
                return { bytesWritten: 0, interrupted: false };
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 15 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const ctl = new AbortController();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
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
        const o = orch(store, {
            onError: (_e, ctx) => errors.push(ctx.operation),
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));

        const ctl = new AbortController();
        const body = controlledStream();
        const pending = o.append(created.uploadToken, {
            offset: 0,
            contentLength: 10,
            complete: true,
            body: body.stream,
            signal: ctl.signal,
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
        await o.create({ key: () => "k", complete: false });
        expect([...uploads.values()][0]!.createdAt).toBe(NOW);
    });

    test("probe reports the deadline anchored at the injected creation instant", async () => {
        const { store } = fakeStore();
        const { o, created } = await startUpload(store, { policy: { maxAgeSeconds: 100 } });
        const out = await o.probe(created.uploadToken);
        expect(out).toMatchObject({ kind: "probed", expiresAt: NOW + 100_000 });
    });

    test("an expired resource answers gone to append but cancel still frees the bytes", async () => {
        const { store, uploads } = fakeStore();
        let t = NOW;
        const o = orch(store, {
            now: () => t,
            policy: { maxAgeSeconds: 100 },
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        t = NOW + 200_000;
        const appended = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: false,
            body: bodyOf("x"),
        });
        expect(appended).toMatchObject({ kind: "gone", reason: "expired" });
        // The refusal frees the bytes it refuses over. An expired resource is
        // refused by every request and can be kept out of an idleness sweep
        // forever by one byte a minute, so waiting for a sweep is waiting for
        // something that may never come.
        expect(uploads.has(created.uploadToken)).toBe(false);
        // A DELETE arriving afterwards finds nothing, which both dialects
        // already answer 404, the same status a refused dead resource gets.
        expect(await o.cancel(created.uploadToken)).toMatchObject({ kind: "not-found" });
    });
});

describe("terminal audit events are emitted only after the store action succeeds", () => {
    test("a completing tail whose completeUpload throws does NOT emit a completed event", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore({
            completeUpload: async () => {
                throw new Error("publish failed");
            },
        });
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        await o.append(created.uploadToken, { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") });
        // Zero-content completing tail at offset == length: the post-condition
        // is met, so this is the request that publishes.
        const out = await o.append(created.uploadToken, { offset: 3, contentLength: 0, complete: true });
        expect(out.kind).toBe("store-error");
        // The audit trail must not record a completion that never happened.
        expect(events.some((e) => e.event.kind === "completed")).toBe(false);
    });

    test("a completing tail emits completed exactly once, after completeUpload returns", async () => {
        const seq: string[] = [];
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            completeUpload: async (t, o2) => {
                seq.push("store.complete");
                return store.completeUpload(t, o2);
            },
        };
        const completed: UploadResourceEvent[] = [];
        const o = orch(spy, {
            onUploadEvent: (e) => {
                if (e.event.kind === "completed") {
                    seq.push("event.completed");
                    completed.push(e);
                }
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
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
            abortUpload: async () => {
                throw new Error("discard failed");
            },
        });
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.cancel(created.uploadToken);
        expect(out.kind).toBe("store-error");
        expect(events.some((e) => e.event.kind === "cancelled")).toBe(false);
    });

    test("a successful cancel emits cancelled exactly once, after abortUpload returns", async () => {
        const seq: string[] = [];
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            abortUpload: async (t, o2) => {
                seq.push("store.abort");
                return store.abortUpload(t, o2);
            },
        };
        const cancelled: UploadResourceEvent[] = [];
        const o = orch(spy, {
            onUploadEvent: (e) => {
                if (e.event.kind === "cancelled") {
                    seq.push("event.cancelled");
                    cancelled.push(e);
                }
            },
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
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
        const out = await o.create({ key: () => "k", declaredLength: 10, complete: false });
        expect(out).toMatchObject({ kind: "created", expiresAt: NOW + 100_000 });
    });

    test("expiresAt anchors at creation start, not after a slow streaming create", async () => {
        // A streaming create whose body drains over time advertises a deadline
        // pinned to when creation STARTED, not now()+maxAge measured after the
        // stream completes (which would inflate the deadline past real expiry).
        let t = NOW;
        const { store } = fakeStore();
        const o = orch(store, {
            now: () => t,
            policy: { maxAgeSeconds: 100 },
        });
        const body = controlledStream();
        const creating = o.create({ key: () => "k", complete: false, body: body.stream });
        await new Promise((r) => setTimeout(r, 5));
        t = NOW + 30_000; // clock advances DURING the slow stream
        body.push("abc");
        body.close();
        const out = await creating;
        expect(out.kind).toBe("created");
        if (out.kind !== "created") return;
        expect(out.expiresAt).toBe(NOW + 100_000);
    });

    test("expiry is the instant recorded at creation, which a shorter later policy cannot shorten", async () => {
        let t = NOW;
        const { store } = fakeStore();
        const o = orch(store, { now: () => t, policy: { maxAgeSeconds: 86_400 } });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        t = NOW + 7_200_000;
        // A request resolving a one-hour policy two hours in: judged by the
        // recorded deadline, the upload is alive and keeps its bytes.
        const probed = await o.probe(created.uploadToken, { policy: { maxAgeSeconds: 3_600 } });
        expect(probed).toMatchObject({ kind: "probed", expiresAt: NOW + 86_400_000 });
        t = NOW + 86_400_000;
        expect(await o.probe(created.uploadToken)).toMatchObject({ kind: "gone" });
    });

    test("no max age means no expiresAt on the created outcome", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: () => "k", declaredLength: 5, complete: false });
        expect(out.kind).toBe("created");
        if (out.kind !== "created") return;
        expect(out.expiresAt).toBeUndefined();
    });
});

describe("a limit rejection names the deadline of the resource it concerns", () => {
    test("an append refused by a limit carries the resource's deadline, not a fresh one", async () => {
        let t = NOW;
        const { store } = fakeStore();
        const o = orch(store, {
            now: () => t,
            policy: { maxAppendSize: 2, maxAgeSeconds: 100 },
        });
        const created = await o.create({ key: () => "k", complete: false });
        if (created.kind !== "created") throw new Error(`setup: create answered ${created.kind}`);
        t = NOW + 30_000;
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: false,
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-large", expiresAt: NOW + 100_000 });
    });

    test("a creation refused after allocating carries the deadline it was given", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minSize: 10, maxAgeSeconds: 100 } });
        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size", expiresAt: NOW + 100_000 });
    });

    test("a resource no max age applies to has no deadline to carry", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minSize: 10 } });
        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect(out).not.toHaveProperty("expiresAt");
    });

    test("a creation refused before allocating has no resource, so no deadline", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { maxSize: 4, maxAgeSeconds: 100 } });
        const out = await o.create({ key: () => "k", declaredLength: 99, complete: false });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "size-exceeded" });
        expect(out).not.toHaveProperty("expiresAt");
    });

    test("a rejection that is not about a limit carries no deadline", async () => {
        const { store } = fakeStore();
        const { o, token } = await startUpload(store, { policy: { maxAgeSeconds: 100 } });
        const out = await o.append(token, { offset: 7, contentLength: 1, complete: false, body: bodyOf("x") });
        expect(out).toMatchObject({ kind: "offset-mismatch" });
        expect(out).not.toHaveProperty("expiresAt");
    });
});

describe("hook guards without onError", () => {
    test("a throwing event hook with no onError never corrupts the upload", async () => {
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadEvent: () => {
                throw new Error("sink down");
            },
        });
        const out = await o.create({ key: () => "k", complete: false });
        expect(out.kind).toBe("created");
    });

    test("a store failure with no onError still answers store-error", async () => {
        const { store } = fakeStore({
            appendChunk: async () => {
                throw new Error("backend down");
            },
        });
        const { o, created } = await startUpload(store);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: false,
            body: bodyOf("x"),
        });
        expect(out.kind).toBe("store-error");
    });
});

describe("locking", () => {
    test("a lock timeout answers contended with empty events", async () => {
        const { store } = fakeStore();
        const locker: UploadLocker = {
            acquire: async () => {
                throw new UploadLockTimeoutError("tok");
            },
        };
        const o = orch(store, { locker });
        const out = await o.probe("tok");
        expect(out).toEqual({ kind: "contended", events: [] });
    });

    test("a non-timeout locker failure propagates instead of masquerading as contention", async () => {
        const { store } = fakeStore();
        const locker: UploadLocker = {
            acquire: async () => {
                throw new Error("locker down");
            },
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
        const { o, created } = await startUpload(slow);
        // The second probe aborts the first holder's lock signal while it only
        // READS: a probe never threads the signal into a write, so the abort is
        // a harmless no-op and both probes answer the truth.
        const [p1, p2] = await Promise.all([o.probe(created.uploadToken), o.probe(created.uploadToken)]);
        expect(p1.kind).toBe("probed");
        expect(p2.kind).toBe("probed");
    });
});

describe("create edge paths", () => {
    test("minAppendSize applies to a non-completing creation WITH content", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 5 } });
        const out = await o.create({
            key: () => "k",
            contentLength: 2,
            complete: false,
            body: bodyOf("ab"),
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-small" });
    });

    test("minAppendSize exempts a bodyless creation even with a zero Content-Length", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 5 } });
        const out = await o.create({ key: () => "k", contentLength: 0, complete: false });
        expect(out.kind).toBe("created");
    });

    test("a matching expectedDigests on a verifying store completes and reports the digest", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: () => "k",
            contentLength: 5,
            complete: true,
            body: bodyOf("hello"),
            expectedDigests: { "sha-256": "GOOD" },
        });
        expect(out).toMatchObject({
            kind: "created",
            offset: 5,
            complete: true,
            digest: "GOOD",
            etag: '"done"',
        });
    });

    test("a failing expectedDigests on create maps to digest-mismatch, never a publish", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: () => "k",
            contentLength: 3,
            complete: true,
            body: bodyOf("abc"),
            expectedDigests: { "sha-256": "BAD" },
        });
        expect(out.kind).toBe("digest-mismatch");
        // Nothing published, and the scrap goes with the verdict. The token
        // rides the outcome so a dialect can still name the resource if the
        // discard itself failed.
        expect(out).toMatchObject({ uploadToken: expect.any(String) });
        expect(uploads.size).toBe(0);
    });

    test("a failing createUpload maps to store-error and reports operation create", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            createUpload: async () => {
                throw new Error("alloc failed");
            },
        });
        const o = orch(store, { onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation) });
        const out = await o.create({ key: () => "k", complete: false });
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["create"]);
    });

    test("a failing durable re-read after an INTERRUPTED create maps to store-error", async () => {
        // Only an interruption leaves the durable prefix unknown; the clean
        // path derives the offset from the write's return and never re-reads.
        const { store } = fakeStore({
            getUploadState: async () => {
                throw new Error("state read failed");
            },
        });
        const o = orch(store);
        const ctl = new AbortController();
        ctl.abort();
        const out = await o.create({
            key: () => "k",
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
        });
        expect(out.kind).toBe("store-error");
    });

    test("a clean create with a body never issues a state read", async () => {
        let reads = 0;
        const { store } = fakeStore();
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => {
                reads++;
                return store.getUploadState(t, opts);
            },
        };
        const o = orch(spy);
        const out = await o.create({
            key: () => "k",
            contentLength: 5,
            complete: true,
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 5, complete: true });
        expect(reads).toBe(0);
    });

    test("an inferred create short of its declared length does NOT complete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: () => "k",
            declaredLength: 10,
            complete: "infer",
            body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "created", offset: 3, length: 10, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a stated create short of its declared length is length-inconsistent and keeps its bytes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const out = await o.create({
            key: () => "k",
            declaredLength: 10,
            complete: true,
            body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "length-inconsistent" });
        const [upload] = [...uploads.values()];
        expect(upload!.isComplete).toBe(false);
        expect(upload!.bytes.byteLength).toBe(3);
    });

    test("a completing create with NO length indicators completes at whatever landed", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "created", offset: 3, complete: true, etag: '"done"' });
    });

    test("completion on create emits a completed event carrying the final length", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        await o.create({ key: () => "k", contentLength: 5, complete: true, body: bodyOf("hello") });
        const completed = events.filter((e) => e.event.kind === "completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]!.event).toEqual({ kind: "completed", length: 5 });
    });
});

describe("probe edge paths", () => {
    test("probe on an invalidated resource answers gone", async () => {
        const { store } = fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                key: "k",
                offset: 0,
                status: "invalidated",
                createdAt: NOW,
            }),
        });
        const o = orch(store);
        const out = await o.probe("dead");
        expect(out).toMatchObject({ kind: "gone", reason: "invalidated" });
    });
});

describe("append edge paths", () => {
    test("a matching expectedDigests on a completing append reports the digest", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 10,
            complete: true,
            body: bodyOf("0123456789"),
            expectedDigests: { "sha-256": "GOOD" },
        });
        expect(out).toMatchObject({
            kind: "appended",
            offset: 10,
            complete: true,
            digest: "GOOD",
            etag: '"done"',
        });
    });

    test("a failing expectedDigests on a streaming completing append maps to digest-mismatch", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 10,
            complete: true,
            body: bodyOf("0123456789"),
            expectedDigests: { "sha-256": "BAD" },
        });
        expect(out.kind).toBe("digest-mismatch");
        expect(uploads.size).toBe(0);
    });

    test("an unverifiable digest on append is ignored, never handed to the store", async () => {
        const digestSeen: (string | undefined)[] = [];
        const { store } = fakeStore({
            digestOnComplete: false,
            completeUpload: async (_t, opts) => {
                digestSeen.push(opts.expectedDigests?.["sha-256"]);
                return { etag: '"x"' };
            },
        });
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 1, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: true,
            body: bodyOf("x"),
            expectedDigests: { "sha-256": "anything" },
        });
        expect(out.kind).toBe("appended");
        if (out.kind !== "appended") return;
        expect(out.complete).toBe(true);
        expect(digestSeen).toEqual([undefined]);
    });

    test("no expectedDigests on a non-verifying store appends normally", async () => {
        const { store } = fakeStore({ digestOnComplete: false });
        const { o, created } = await startUpload(store);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 2,
            complete: false,
            body: bodyOf("ab"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 2 });
    });

    test("a failing head read on append maps to store-error and reports operation head", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            getUploadState: async () => {
                throw new Error("head down");
            },
        });
        const o = orch(store, { onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation) });
        const out = await o.append("tok", {
            offset: 0,
            contentLength: 1,
            complete: false,
            body: bodyOf("x"),
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
        const { o, created } = await startUpload(flaky);
        const ctl = new AbortController();
        ctl.abort();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 2,
            complete: false,
            body: bodyOf("ab"),
            signal: ctl.signal,
        });
        expect(out.kind).toBe("store-error");
    });

    test("a clean append answers from the write's return: exactly one state read, correct outcome", async () => {
        const { store } = fakeStore();
        let reads = 0;
        const spy: ResumableWriteStore = {
            ...store,
            getUploadState: (t, opts) => {
                reads++;
                return store.getUploadState(t, opts);
            },
        };
        const o = orch(spy, { policy: { maxAgeSeconds: 60 } });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        reads = 0;
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: false,
            body: bodyOf("wxyz"),
        });
        // The single pre-evaluation read under the lock; offset, length, and
        // the expiry anchor all come from it plus the write's own return.
        expect(reads).toBe(1);
        expect(out).toMatchObject({
            kind: "appended",
            offset: 4,
            length: 10,
            complete: false,
            interrupted: false,
            expiresAt: NOW + 60_000,
        });
    });

    test("an append without a body answers the durable offset without touching the writer", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, { offset: 0, complete: false });
        expect(out).toMatchObject({
            kind: "appended",
            offset: 0,
            length: 10,
            complete: false,
            interrupted: false,
        });
    });

    test("a store offset conflict answers offset-mismatch carrying the durable offset", async () => {
        const { store } = fakeStore();
        const conflicted: ResumableWriteStore = {
            ...store,
            appendChunk: async (token) => {
                throw new UploadOffsetConflictError(token, 7);
            },
        };
        const o = orch(conflicted);
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 1,
            complete: false,
            body: bodyOf("x"),
        });
        expect(out).toEqual({
            kind: "offset-mismatch",
            claimedOffset: 0,
            correctOffset: 7,
            events: [],
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
            appendChunk: async (token) => {
                throw new UploadOffsetConflictError(token, 3);
            },
        };
        const o = orch(conflicted);
        const out = await o.create({ key: () => "k", complete: false, contentLength: 5, body: bodyOf("hello") });
        expect(out).toMatchObject({
            kind: "offset-mismatch",
            claimedOffset: 0,
            correctOffset: 3,
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
                return { bytesWritten: 2, interrupted: false };
            },
        };
        const o = orch(partial);
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: true,
            body: bodyOf("abcd"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 2, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a chunked completing append (no Content-Length) completes at what landed", async () => {
        const events: UploadResourceEvent[] = [];
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: true,
            body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true, etag: '"done"' });
        const completed = events.filter((e) => e.event.kind === "completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]!.event).toEqual({ kind: "completed", length: 3 });
    });

    test("an inferred append short of the declared length does NOT complete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: "infer",
            body: bodyOf("abcd"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 4, length: 10, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a stated append short of the declared length is length-inconsistent and keeps its bytes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: true,
            body: bodyOf("abcd"),
        });
        expect(out).toMatchObject({ kind: "length-inconsistent", uploadToken: created.uploadToken });
        const [upload] = [...uploads.values()];
        expect(upload!.isComplete).toBe(false);
        expect(upload!.bytes.byteLength).toBe(4);
    });
});

describe("cancel edge paths", () => {
    test("a failing state read on cancel still discards the upload", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        store.getUploadState = async () => {
            throw new Error("head down");
        };
        expect(await o.cancel(created.uploadToken)).toEqual({ kind: "cancelled" });
        expect(uploads.has(created.uploadToken)).toBe(false);
    });

    test("a cancel whose state read finds nothing still clears what the store holds, and answers not-found", async () => {
        const aborted: string[] = [];
        const { store } = fakeStore({
            getUploadState: async (token) => {
                throw new UploadNotFoundError(token);
            },
            abortUpload: async (token) => {
                aborted.push(token);
            },
        });
        expect(await orch(store).cancel("half-gone")).toEqual({ kind: "not-found" });
        expect(aborted).toEqual(["half-gone"]);
    });

    test("cancel on an invalidated resource frees the bytes instead of refusing", async () => {
        // DELETE must succeed on a dead resource: a client told its upload is
        // invalidated needs to reclaim the partial bytes, and abortUpload is
        // idempotent, so cancel is answered ahead of the terminal refusals.
        let aborted = false;
        const { store } = fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                key: "k",
                offset: 0,
                status: "invalidated",
                createdAt: NOW,
            }),
            abortUpload: async () => {
                aborted = true;
            },
        });
        const o = orch(store);
        const out = await o.cancel("dead");
        expect(out).toMatchObject({ kind: "cancelled" });
        expect(aborted).toBe(true);
    });

    test("a failing abortUpload maps to store-error and reports operation abort", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            abortUpload: async () => {
                throw new Error("discard failed");
            },
        });
        const { o, created } = await startUpload(store, {
            onError: (_e: unknown, ctx: { operation: string }) => errors.push(ctx.operation),
        });
        const out = await o.cancel(created.uploadToken);
        expect(out.kind).toBe("store-error");
        expect(errors).toEqual(["abort"]);
    });
});

describe("implicit completion inference (complete: 'infer')", () => {
    /** An upload of declared length 3 whose bytes are all durable, not yet completed. */
    async function durableThroughLength() {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const { uploadToken } = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        await o.append(uploadToken, { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") });
        return { o, uploads, uploadToken };
    }

    test("an append whose math reaches the stored length completes and publishes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 5, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: "infer",
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: true, etag: '"done"' });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("an append whose math falls short of the length stays incomplete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: "infer",
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("inference uses a length declared ON this append (deferred-length fixing PATCH)", async () => {
        const { store, uploads } = fakeStore();
        const { o, created } = await startUpload(store);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: "infer",
            declaredLength: 3,
            body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, length: 3, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("no known length means no completion, however much lands", async () => {
        const { store, uploads } = fakeStore();
        const { o, created } = await startUpload(store);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: "infer",
            body: bodyOf("abc"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("an unknown-sized body that delivers exactly through the length completes", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 5, complete: false }));
        const body = controlledStream();
        body.push("hello");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: "infer",
            body: body.stream,
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("an unknown-sized body that stops short of the length stays incomplete", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        const body = controlledStream();
        body.push("hello");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: "infer",
            body: body.stream,
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
    });

    test("a zero-content inferred retry at offset == length publishes the crash-window object", async () => {
        // The completing request died after its bytes went durable but before
        // completeUpload: the client's zero-byte PATCH retry (or the dialect's
        // heal) at offset == length must publish, not answer offset-mismatch.
        const { o, uploads, uploadToken } = await durableThroughLength();
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        const out = await o.append(uploadToken, {
            offset: 3,
            contentLength: 0,
            complete: "infer",
        });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true });
        expect([...uploads.values()][0]!.isComplete).toBe(true);
    });

    test("a request stating neither a size nor a body infers no completion", async () => {
        // The inference reads a stated size or a body that may deliver through
        // the length; with neither there is nothing to conclude from. A dialect
        // that knows the message carried zero bytes states contentLength 0, as
        // the retry above does.
        const { o, uploads, uploadToken } = await durableThroughLength();
        const out = await o.append(uploadToken, { offset: 3, complete: "infer" });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: false });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
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
        const controller = new AbortController();
        const { signal } = controller;

        const created = createdOk(
            await o.create({
                key: () => "k",
                contentLength: 3,
                complete: true,
                body: bodyOf("abc"),
                signal,
            }),
        );
        const again = createdOk(await o.create({ key: () => "k2", declaredLength: 4, complete: false, signal }));
        await o.probe(again.uploadToken, { signal });
        await o.append(again.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: true,
            body: bodyOf("wxyz"),
            signal,
        });
        await o.cancel(created.uploadToken, { signal });

        // create complete (clean streams derive their offset, no state read),
        // probe, append head + complete, cancel head + abort: every store
        // touchpoint carries the caller signal. A completion's is the caller's
        // linked with the lock lease, so it is a different object that aborts
        // with the caller's.
        expect(calls.map((c) => c.op)).toEqual(["complete", "state", "state", "complete", "state", "abort"]);
        for (const c of calls) if (c.op !== "complete") expect(c.signal).toBe(signal);
        const completions = calls.filter((c) => c.op === "complete");
        expect(completions.every((c) => c.signal !== undefined && !c.signal.aborted)).toBe(true);
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
        const { o, created } = await startUpload(slow);

        const [appendA, probeB] = await Promise.all([
            o.append(created.uploadToken, {
                offset: 0,
                contentLength: 3,
                complete: false,
                body: bodyOf("abc"),
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
        const o = orch(store, {
            policy: { minSize: 10 },
            onUploadEvent: (e) => events.push(e),
        });
        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("abc") });
        // The token travels with a rejection that lands AFTER the resource was
        // allocated: without it the bytes already durable are unreachable, so
        // the client can neither resume them nor delete them.
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", uploadToken: "u1", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(events.some((e) => e.event.kind === "append-rejected" && e.event.reason === "below-min-size")).toBe(
            true,
        );
    });

    test("a zero-content completing append below the floor does NOT publish and emits its offset", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = orch(store, {
            policy: { minSize: 10 },
            onUploadEvent: (e) => events.push(e),
        });
        const created = await o.create({ key: () => "k", complete: false }); // deferred length
        if (created.kind !== "created") throw new Error("setup");
        // Two bytes land and nothing declares a total, so the representation
        // length stays unknown: the tail is a completing append whose own size
        // is unstated, which is the shape this gate exists for.
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 2,
            complete: false,
            body: bodyOf("ab"),
        });
        // That completing tail reaches a durable total of 2, under the floor
        // of 10: the gate must refuse it before publishing.
        const out = await o.append(created.uploadToken, { offset: 2, complete: true });
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(
            events.some(
                (e) =>
                    e.event.kind === "append-rejected" && e.event.reason === "below-min-size" && e.event.atOffset === 2,
            ),
        ).toBe(true);
    });

    test("a streaming completing append below the floor emits the rejection with its offset", async () => {
        const events: UploadResourceEvent[] = [];
        const { store, uploads } = fakeStore();
        const o = orch(store, {
            policy: { minSize: 10 },
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        // Chunked: nothing states the total in advance, so the delivered byte
        // count is the representation and the floor binds only once it lands.
        const body = controlledStream();
        body.push("x");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: true,
            body: body.stream,
        });
        expect(out).toEqual({ kind: "limit-violation", reason: "below-min-size", events: [] });
        expect([...uploads.values()][0]!.isComplete).toBe(false);
        expect(
            events.some(
                (e) =>
                    e.event.kind === "append-rejected" && e.event.reason === "below-min-size" && e.event.atOffset === 0,
            ),
        ).toBe(true);
    });
});

describe("a sub-floor total never becomes the immutable length", () => {
    test("a completing append below minSize is refused before any byte moves, and the upload continues", async () => {
        // Regression: the derived total was persisted by the write and the
        // floor was checked after it, so a first completing append of 10 bytes
        // under a floor of 20 was refused WITH the length frozen at 10. Every
        // later shape then answered `length-inconsistent` or `below-min-size`,
        // the bytes stayed durable, and only a DELETE or a sweep freed them.
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minSize: 20 } });
        const created = await o.create({ key: () => "k", complete: false }); // deferred length
        if (created.kind !== "created") throw new Error("setup");
        const token = created.uploadToken;

        const refused = await o.append(token, {
            offset: 0,
            contentLength: 10,
            complete: true,
            body: bodyOf("0123456789"),
        });
        expect(refused).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect(uploads.get(token)!.bytes.byteLength).toBe(0);
        expect(uploads.get(token)!.length).toBeUndefined();

        const probed = await o.probe(token);
        expect(probed).toMatchObject({ kind: "probed", offset: 0, complete: false });
        if (probed.kind !== "probed") throw new Error("kind");
        expect(probed.length).toBeUndefined();

        // The client learns the floor from `min-size` and sends a conforming
        // representation; nothing about the resource stands in its way.
        const ok = await o.append(token, {
            offset: 0,
            contentLength: 20,
            complete: true,
            body: bodyOf("x".repeat(20)),
        });
        expect(ok).toMatchObject({ kind: "appended", offset: 20, complete: true });
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("a length declared under the floor is refused rather than recorded", async () => {
        const { store, uploads } = fakeStore();
        const { o, created } = await startUpload(store, { policy: { minSize: 20 } });
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            declaredLength: 10,
        });
        expect(out).toMatchObject({ kind: "limit-violation", reason: "below-min-size" });
        expect(uploads.get(created.uploadToken)!.length).toBeUndefined();
    });
});

describe("a completed upload outlives the expiry clock", () => {
    test("the idempotent retry answers already-complete and re-delivers a failed completion report", async () => {
        // Regression: expiry was evaluated ahead of completeness, so a
        // completed upload past its max age answered `gone` and this path
        // discarded the resource. The client's retry saw not-found for an
        // upload that had succeeded, and the at-least-once completion report,
        // whose only retry is that repeat, could never be delivered.
        let clock = NOW;
        const delivered: number[] = [];
        let failFirst = true;
        const { store, uploads } = fakeStore();
        const o = orch(store, {
            now: () => clock,
            policy: { maxAgeSeconds: 60 },
            onError: () => {},
            onUploadComplete: async ({ length }) => {
                delivered.push(length);
                if (failFirst) {
                    failFirst = false;
                    throw new Error("consumer store unavailable");
                }
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 5, complete: false }));
        const token = created.uploadToken;

        // Published, but the consumer's hook threw, so the client is told the
        // backend failed and will repeat its completing request.
        const first = await o.append(token, {
            offset: 0,
            contentLength: 5,
            complete: true,
            body: bodyOf("hello"),
        });
        expect(first.kind).toBe("store-error");
        expect(uploads.get(token)!.isComplete).toBe(true);

        clock = NOW + 61_000;
        const retry = await o.append(token, { offset: 5, complete: true });
        expect(retry).toMatchObject({ kind: "already-complete", length: 5 });
        expect(delivered).toEqual([5, 5]);
        expect(uploads.has(token)).toBe(true);
        expect(await o.probe(token)).toMatchObject({ kind: "probed", offset: 5, complete: true });
    });

    test("an abandoned upload past its max age is still expired, and its bytes are freed", async () => {
        let clock = NOW;
        const { store, uploads } = fakeStore();
        const o = orch(store, {
            now: () => clock,
            policy: { maxAgeSeconds: 60 },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: false,
            body: bodyOf("abcd"),
        });
        clock = NOW + 61_000;
        expect(await o.probe(created.uploadToken)).toMatchObject({ kind: "gone", reason: "expired" });
        expect(uploads.has(created.uploadToken)).toBe(false);
    });
});

describe("deferred-length threading on an empty append", () => {
    test("a no-body append that declares a length persists it via the write path", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = await o.create({ key: () => "k", complete: false }); // deferred length
        if (created.kind !== "created") throw new Error("setup");
        // No body, but this append first declares the total length. The write
        // path is what records the length, so an empty append must still reach
        // it (the store persists the length even for zero bytes).
        const appended = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            declaredLength: 10,
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
            appendChunk: (t, off, body, opts) => {
                appendCalls++;
                return store.appendChunk(t, off, body, opts);
            },
        };
        const o = orch(spy);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
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
        const o = orch(store);

        const out = await o.create({
            key: () => "k",
            declaredLength: 10,
            contentLength: 50,
            complete: false,
            body: bodyOf("x".repeat(50)),
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
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 4, complete: false }));
        events.length = 0;

        // No content length: the overrun is only discoverable while streaming.
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
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
        const o = orch(store, {
            policy: { maxSize: 4 },
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
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
        const o = orch(store, {
            policy: { maxAppendSize: 4 },
        });

        const out = await o.create({ key: () => "k", complete: false, body: bodyOf("0123456789") });

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
        const o = orch(store, {
            onUploadEvent: (e) => events.push(e),
        });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        events.length = 0;

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
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
            async appendChunk() {
                throw new Error("backend down");
            },
        });
        const { o, created } = await startUpload(store, { onError: (_err, ctx) => seen.push(ctx) });

        await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("abc"),
            auditKey: "safe-id",
        });

        expect(seen).toEqual([{ uploadToken: undefined, auditKey: "safe-id", operation: "append" }]);
    });

    test("without an audit key the token is what identifies the resource", async () => {
        const seen: Array<{ uploadToken?: string; auditKey?: string; operation: string }> = [];
        const { store } = fakeStore({
            async appendChunk() {
                throw new Error("backend down");
            },
        });
        const { o, created } = await startUpload(store, { onError: (_err, ctx) => seen.push(ctx) });

        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("abc") });

        expect(seen).toEqual([{ uploadToken: created.uploadToken, auditKey: undefined, operation: "append" }]);
    });

    test("a resource-existence check reports a backend failure rather than absorbing it", async () => {
        const seen: string[] = [];
        const { store } = fakeStore({
            async getUploadState() {
                throw new Error("backend down");
            },
        });
        const o = orch(store, {
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
            async getUploadState() {
                throw new Error("backend down");
            },
        });
        const o = orch(store);

        expect(await o.resourceExists("whatever")).toBe(true);
    });

    test("a token naming nothing answers false, and the read carries the request signal", async () => {
        const { store } = fakeStore();
        const signals: (AbortSignal | undefined)[] = [];
        const recording: ResumableWriteStore = {
            ...store,
            getUploadState: async (token, opts) => {
                signals.push(opts?.signal);
                return await store.getUploadState(token, opts);
            },
        };
        const o = orch(recording);
        const request = new AbortController();

        expect(await o.resourceExists("missing")).toBe(false);
        expect(await o.resourceExists("missing", { signal: request.signal })).toBe(false);
        expect(signals).toHaveLength(2);
        expect(signals[0]).toBeUndefined();
        expect(signals[1]).toBe(request.signal);
    });

    test("damaged bookkeeping is not-found to the client and reported to the operator", async () => {
        // Corruption on disk must not vanish into the same silence as an expired
        // token: the protocol answer is identical, the error report is not.
        const seen: Array<{ operation: string; corrupt: boolean }> = [];
        const { store } = fakeStore({
            async getUploadState(token) {
                throw corruptUploadState(token);
            },
        });
        const o = orch(store, {
            onError: (err, ctx) => seen.push({ operation: ctx.operation, corrupt: isCorruptUploadState(err) }),
        });

        expect((await o.probe("damaged")).kind).toBe("not-found");
        expect(await o.resourceExists("damaged")).toBe(false);
        expect(seen).toEqual([
            { operation: "head", corrupt: true },
            { operation: "head", corrupt: true },
        ]);
    });

    test("a plain not-found stays silent: an expired token is not an incident", async () => {
        const seen: string[] = [];
        const { store } = fakeStore();
        const o = orch(store, { onError: (_err, ctx) => seen.push(ctx.operation) });

        expect((await o.probe("missing")).kind).toBe("not-found");
        expect(await o.resourceExists("missing")).toBe(false);
        expect(seen).toEqual([]);
    });
});

// ─── A length declared on the completing append is a fact to record ─────────

describe("deferred length declared at completion", () => {
    test("the length the request declares is persisted, not just acted on", async () => {
        const { store, uploads } = fakeStore();
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("0123456789") });

        // Bodyless completing PATCH that declares the total for the first time.
        const out = await o.append(created.uploadToken, {
            offset: 10,
            contentLength: 0,
            complete: true,
            declaredLength: 10,
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
                    key: "k",
                    offset: 99,
                    length: 10,
                    status: "incomplete",
                    createdAt: Number.NaN,
                } satisfies StoredUploadState;
            },
        });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0 });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));

        expect(await o.cancel(created.uploadToken)).toEqual({ kind: "cancelled" });
        expect(uploads.has(created.uploadToken)).toBe(false);
    });
});

// ─── Which representation bound binds decides the answer ────────────────────

describe("two representation bounds at once", () => {
    test("the policy maximum below the declared length answers as a size violation", async () => {
        const { store } = fakeStore();
        const o = orch(store, {
            policy: { maxSize: 4 },
        });
        // A length accepted under the old policy outlives a redeploy that
        // tightens the maximum, so the server ceiling is what the body crosses.
        const lenient = orch(store, {
            policy: { maxSize: 100 },
        });
        const created = createdOk(await lenient.create({ key: () => "k", declaredLength: 100, complete: false }));

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
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
        const o = orch(store, {
            policy: { maxSize: 100 },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 4, complete: false }));

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
        });

        expect(out).toEqual({
            kind: "length-inconsistent",
            uploadToken: created.uploadToken,
            events: [],
        });
    });

    test("equal bounds answer as the client's own broken declaration", async () => {
        const { store } = fakeStore();
        const o = orch(store, {
            policy: { maxSize: 4 },
        });
        // Declaring exactly the maximum is allowed; sending past it breaks the
        // declaration the client made, which is the more specific statement.
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 4, complete: false }));

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
        });

        expect(out).toMatchObject({ kind: "length-inconsistent" });
    });

    test("a per-request ceiling below both stays non-fatal and resumable", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, {
            policy: { maxSize: 100, maxAppendSize: 4 },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 50, complete: false }));

        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: bodyOf("0123456789"),
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
        const o = orch(store, {
            onUploadComplete: (info) => {
                landed.push(info);
            },
        });

        const out = await o.create({ key: () => "docs/q4.pdf", complete: true, body: bodyOf("payload") });

        expect(out).toMatchObject({ kind: "created", complete: true });
        // The key is chosen before a token exists, so without this the two
        // cannot be paired afterwards except by racing the creation call.
        expect(landed).toEqual([
            {
                uploadToken: "u1",
                auditKey: undefined,
                key: "docs/q4.pdf",
                length: 7,
                metadata: undefined,
                etag: '"done"',
                digest: undefined,
            },
        ]);
    });

    test("a streaming upload finished by a later append reports it too", async () => {
        const landed: Landed[] = [];
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadComplete: (info) => {
                landed.push(info);
            },
        });
        const created = createdOk(await o.create({ key: () => "docs/big.bin", declaredLength: 10, complete: false }));

        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 10,
            complete: true,
            body: bodyOf("0123456789"),
            auditKey: "safe-id",
        });

        expect(landed).toHaveLength(1);
        expect(landed[0]).toMatchObject({ key: "docs/big.bin", length: 10, auditKey: "safe-id" });
    });

    test("it fires once, and never for an upload that did not publish", async () => {
        const landed: Landed[] = [];
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadComplete: (info) => {
                landed.push(info);
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));

        // A partial append publishes nothing, so there is nothing to record.
        await o.append(created.uploadToken, { offset: 0, complete: false, body: bodyOf("01234") });
        expect(landed).toEqual([]);

        await o.append(created.uploadToken, { offset: 5, complete: true, body: bodyOf("56789") });
        expect(landed).toHaveLength(1);
    });

    test("a throwing hook fails the request rather than acknowledging an unrecorded object", async () => {
        const { store } = fakeStore();
        const o = orch(store, {
            onUploadComplete: () => {
                throw new Error("database is down");
            },
            onError: () => {},
        });

        const out = await o.create({ key: () => "k", complete: true, body: bodyOf("payload") });

        // Telling the client it landed while the consumer's own records never
        // saw it leaves an object nothing points at.
        expect(out.kind).toBe("store-error");
        // The object is published and the resource is complete, so the outcome
        // carries the token: without it the client has no handle to repeat its
        // completing request through, and the at-least-once re-delivery the
        // hook documents is unreachable for exactly the creation that needs it.
        if (out.kind !== "store-error") return;
        expect(out.uploadToken).toEqual(expect.any(String));
    });

    test("a creation whose hook threw re-delivers on the client's repeat of the completing request", async () => {
        const { store } = fakeStore();
        const landed: string[] = [];
        let failNext = true;
        const o = orch(store, {
            onUploadComplete: (info) => {
                if (failNext) {
                    failNext = false;
                    throw new Error("database is down");
                }
                landed.push(info.key);
            },
            onError: () => {},
        });
        const out = await o.create({ key: () => "k", complete: true, contentLength: 7, body: bodyOf("payload") });
        expect(out.kind).toBe("store-error");
        if (out.kind !== "store-error" || out.uploadToken === undefined) throw new Error("no token on the outcome");
        const retry = await o.append(out.uploadToken, { offset: 7, complete: true, contentLength: 0 });
        expect(retry).toMatchObject({ kind: "already-complete" });
        expect(landed).toEqual(["k"]);
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
        const o = orch(store, {
            onUploadComplete: (info) => {
                if (failNext) {
                    failNext = false;
                    throw new Error("database is down");
                }
                landed.push(info.key);
            },
            onError: () => {},
        });

        const created = createdOk(
            await o.create({ key: () => "k", complete: false, contentLength: 7, body: bodyOf("payload") }),
        );

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
    const build = (policy: Record<string, number>) => () => orch(fakeStore().store, { policy });

    test("a floor above its ceiling is refused, on both pairs", () => {
        // Accepting it would mean every upload is rejected at runtime for a
        // reason nothing points back at the configuration that caused it.
        expect(build({ minSize: 10, maxSize: 4 })).toThrow(TypeError);
        expect(build({ minAppendSize: 10, maxAppendSize: 4 })).toThrow(TypeError);
    });

    test("the message names both bounds and their values", () => {
        expect(build({ minSize: 10, maxSize: 4 })).toThrow(/minSize \(10\) exceeds maxSize \(4\)/);
        expect(build({ minAppendSize: 9, maxAppendSize: 2 })).toThrow(
            /minAppendSize \(9\) exceeds maxAppendSize \(2\)/,
        );
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
        // The locker's own default is far past any test timeout, so a deadline
        // that never reached it hangs the probe instead of racing the timeout.
        const locker = memoryUploadLocker({ acquireTimeoutMs: 600_000 });
        const o = orch(store, {
            locker,
            lockTimeoutMs: 40,
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));

        // Hold the lock outside the orchestrator so the next call has to wait.
        const held = await locker.acquire(created.uploadToken);
        const out = await o.probe(created.uploadToken);
        held.release();

        // The orchestrator's deadline wins over the locker's own default, so
        // the knob is reachable whichever locker is installed.
        expect(out).toEqual({ kind: "contended", events: [] });
    });

    test("the acquire carries the deadline and the audit key, and no key for an absent one", async () => {
        // A locker spreading its options over its defaults would read a
        // present-but-undefined deadline as "no deadline at all".
        const { store } = fakeStore();
        const inner = memoryUploadLocker();
        const seen: unknown[] = [];
        const recording: UploadLocker = {
            acquire: (token, opts) => {
                seen.push(opts);
                return inner.acquire(token, opts);
            },
        };
        const timed = orch(store, { locker: recording, lockTimeoutMs: 40 });
        const created = createdOk(
            await timed.create({ key: () => "k", declaredLength: 3, complete: false, auditKey: "doc-1" }),
        );
        await timed.probe(created.uploadToken);
        expect(seen).toStrictEqual([{ timeoutMs: 40, auditKey: "doc-1" }, { timeoutMs: 40 }]);

        seen.length = 0;
        await orch(store, { locker: recording }).probe(created.uploadToken, { auditKey: "doc-1" });
        expect(seen).toStrictEqual([{ auditKey: "doc-1" }]);
    });

    test("with no deadline configured the locker's own default applies", async () => {
        const { store } = fakeStore();
        const locker = memoryUploadLocker({ acquireTimeoutMs: 40 });
        const o = createUploadOrchestrator(store, { now: () => NOW, graceMs: 0, locker });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));

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
        const o = orch(store);

        // Declared length with no content length: the overrun is only
        // discoverable while the body streams.
        const out = await o.create({ key: () => "k", declaredLength: 4, complete: false, body: bodyOf("0123456789") });

        expect(out).toMatchObject({ kind: "length-inconsistent" });
        if (out.kind !== "length-inconsistent") throw new Error("kind");
        expect(out.uploadToken).toBe("u1");
        expect(uploads.get("u1")!.isInvalidated).toBe(true);
    });

    test("past the policy maximum is a size violation", async () => {
        const { store } = fakeStore();
        const o = orch(store, {
            policy: { maxSize: 4 },
        });

        const out = await o.create({ key: () => "k", complete: false, body: bodyOf("0123456789") });

        expect(out).toMatchObject({ kind: "limit-violation", reason: "size-exceeded", uploadToken: "u1" });
    });

    test("a zero declared length is refused by that bound, and the resource survives", async () => {
        // A zero bound admits no byte, so nothing landed past it and the store
        // refuses without invalidating. The answer still names the declared
        // length: a per-request ceiling would send the client after a smaller
        // chunk that can never fit.
        const { store, uploads } = fakeStore();
        const body = controlledStream();
        body.push("more");
        body.close();
        const out = await orch(store).create({ key: () => "k", declaredLength: 0, complete: true, body: body.stream });

        expect(out).toMatchObject({ kind: "length-inconsistent", uploadToken: "u1" });
        expect(uploads.get("u1")!.isInvalidated).toBe(false);
    });

    test("a creation the policy refuses reports why, before any token exists", async () => {
        const events: UploadResourceEvent[] = [];
        const o = orch(fakeStore().store, { policy: { maxSize: 4 }, onUploadEvent: (e) => events.push(e) });
        const out = await o.create({ key: () => "k", declaredLength: 8, complete: false, auditKey: "doc-1" });

        expect(out).toMatchObject({ kind: "limit-violation", reason: "size-exceeded" });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ uploadToken: undefined, auditKey: "doc-1" });
        expect(events[0]!.event).toMatchObject({ kind: "append-rejected", reason: "size-exceeded" });
    });
});

// ─── The post-condition, and what it replaced ───────────────────────────────

describe("a completing append at the durable end", () => {
    async function atEnd(body?: Uint8Array | ReadableStream<Uint8Array>, contentLength?: number) {
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 4, complete: false }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: false,
            body: bodyOf("abcd"),
        });
        const out = await o.append(created.uploadToken, {
            offset: 4,
            complete: true,
            contentLength,
            body,
        });
        return { out, uploads, token: created.uploadToken };
    }

    test("a bodiless retry publishes: the post-condition is met by zero bytes", async () => {
        const { out, uploads, token } = await atEnd();
        expect(out).toMatchObject({ kind: "appended", offset: 4, complete: true });
        expect(uploads.get(token)!.isComplete).toBe(true);
    });

    test("a body of undeclared size carrying bytes is refused WITHOUT destroying the upload", async () => {
        // Regression: this answered `length-inconsistent` AND invalidated the
        // resource, so a byte-complete upload lost its four durable bytes to a
        // duplicate chunked retry after a lost response. The zero-byte bound
        // admits nothing, so nothing landed past a representation bound and
        // there is nothing to condemn: the request is refused and the upload is
        // still there, still completable. The refusal names the bound the body
        // crossed, the declared length, which is what the same request carrying
        // a Content-Length has always been told; a per-request-ceiling answer
        // would send the client looking for a smaller chunk that can never fit.
        const body = controlledStream();
        body.push("more");
        body.close();
        const { out, uploads, token } = await atEnd(body.stream);
        expect(out).toMatchObject({ kind: "length-inconsistent", uploadToken: token });
        expect(uploads.get(token)!.isComplete).toBe(false);
        expect(uploads.get(token)!.isInvalidated).toBe(false);
        expect(uploads.get(token)!.bytes.byteLength).toBe(4);
    });

    test("the refused upload still completes on the retry that carries no bytes", async () => {
        // The whole point of refusing non-destructively: the client resumes
        // from the truthful offset and finishes.
        const { store, uploads } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 4, complete: false }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 4,
            complete: false,
            body: bodyOf("abcd"),
        });
        const dup = controlledStream();
        dup.push("more");
        dup.close();
        const refused = await o.append(created.uploadToken, {
            offset: 4,
            complete: true,
            body: dup.stream,
        });
        expect(refused).toMatchObject({ kind: "length-inconsistent" });
        const probed = await o.probe(created.uploadToken);
        expect(probed).toMatchObject({ kind: "probed", offset: 4, length: 4, complete: false });
        const done = await o.append(created.uploadToken, { offset: 4, complete: true });
        expect(done).toMatchObject({ kind: "appended", offset: 4, complete: true });
        expect(uploads.get(created.uploadToken)!.isComplete).toBe(true);
    });

    test("a body of undeclared size carrying nothing still publishes", async () => {
        // The other half of the same unknown, and the reason it cannot be
        // decided before the read: this request is indistinguishable from the
        // one above until its bytes (none) arrive.
        const body = controlledStream();
        body.close();
        const { out } = await atEnd(body.stream);
        expect(out).toMatchObject({ kind: "appended", offset: 4, complete: true });
    });
});

describe("the min-append floor binds on a size, or refuses the request", () => {
    test("an append that declares no content size is refused before any byte moves", async () => {
        const { store, uploads } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 8 } });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 100, complete: false }));
        const body = controlledStream();
        body.push("abc");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: false,
            body: body.stream,
        });
        // Advertised in `min-append-size` and now enforced: the delivered size
        // is knowable only once the bytes are durable, and rejecting content
        // the resource kept is not a rejection.
        expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-small" });
        expect(uploads.get(created.uploadToken)!.bytes.byteLength).toBe(0);
    });

    test("a completing append is exempt, so an undeclared size can still finish", async () => {
        const { store } = fakeStore();
        const { o, created } = await startUpload(store, { policy: { minAppendSize: 8 } });
        const body = controlledStream();
        body.push("abc");
        body.close();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            complete: true,
            body: body.stream,
        });
        expect(out).toMatchObject({ kind: "appended", complete: true, offset: 3 });
    });
});

describe("a completing append's Content-Length fixes the representation length", () => {
    test("a deferred-length upload finished with a plain Content-Length records the total", async () => {
        // A content size on a completing request is a length indicator
        // wherever it appears, not only at creation: unrecorded, the upload
        // publishes with its length still unknown and every later probe
        // answers a deferred length for a representation that has one.
        const { store, uploads } = fakeStore();
        const { o, created } = await startUpload(store);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: true,
            body: bodyOf("hello"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, length: 5, complete: true });
        expect(uploads.get(created.uploadToken)!.length).toBe(5);
    });
});

describe("the completion hook is retried until one delivery succeeds, then not again", () => {
    test("a repeated bodiless retry does not re-invoke a hook that already resolved", async () => {
        // The retry exists for a delivery that FAILED. Repeating a successful
        // one on every later request lets a token holder drive unbounded
        // awaited work in a consumer's hook with one request it can resend.
        const { store } = fakeStore();
        let calls = 0;
        const o = orch(store, {
            onUploadComplete: () => {
                calls += 1;
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: true,
            body: bodyOf("abc"),
        });
        expect(calls).toBe(1);
        for (let i = 0; i < 5; i++) {
            const replay = await o.append(created.uploadToken, {
                offset: 3,
                contentLength: 0,
                complete: true,
            });
            expect(replay.kind).toBe("already-complete");
        }
        expect(calls).toBe(1);
    });

    test("a hook that threw is delivered again on the client's retry", async () => {
        const { store } = fakeStore();
        let calls = 0;
        const o = orch(store, {
            onError: () => {},
            onUploadComplete: () => {
                calls += 1;
                if (calls === 1) throw new Error("consumer database down");
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        const failed = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: true,
            body: bodyOf("abc"),
        });
        expect(failed.kind).toBe("store-error");
        const retry = await o.append(created.uploadToken, {
            offset: 3,
            contentLength: 0,
            complete: true,
        });
        expect(retry.kind).toBe("already-complete");
        expect(calls).toBe(2);
    });

    test("the memory of resolved deliveries keeps 1024 tokens and forgets the oldest", async () => {
        // Forgetting costs one duplicate delivery, which the at-least-once
        // contract already has a consumer absorb; remembering every token
        // grows without limit under a client that keeps completing uploads.
        const { store } = fakeStore();
        const delivered: string[] = [];
        const o = orch(store, {
            onUploadComplete: ({ uploadToken }) => {
                delivered.push(uploadToken);
            },
        });
        const tokens: string[] = [];
        for (let i = 0; i < 1025; i += 1) {
            tokens.push(
                createdOk(await o.create({ key: () => `k${i}`, contentLength: 0, complete: true })).uploadToken,
            );
        }
        expect(delivered).toHaveLength(1025);
        const replay = (token: string) => o.append(token, { offset: 0, contentLength: 0, complete: true });

        expect((await replay(tokens[1]!)).kind).toBe("already-complete");
        expect(delivered).toHaveLength(1025);
        expect((await replay(tokens[0]!)).kind).toBe("already-complete");
        expect(delivered.slice(1025)).toEqual([tokens[0]!]);
    });
});

describe("a refused request does not abandon its body", () => {
    test("an append the engine refuses cancels the request body", async () => {
        const { store } = fakeStore();
        const o = orch(store);
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 10, complete: false }));
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bodyOf("abc"));
            },
            cancel() {
                cancelled = true;
            },
        });
        // A stale offset: nothing reaches the store, so this layer still owns
        // the body. Left open it keeps its producer alive and the connection
        // reading until the runtime happens to notice.
        const out = await o.append(created.uploadToken, {
            offset: 7,
            contentLength: 3,
            complete: false,
            body,
        });
        expect(out.kind).toBe("offset-mismatch");
        expect(cancelled).toBe(true);
    });

    test("a creation the policy refuses cancels the request body", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { maxSize: 4 } });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bodyOf("abcdefgh"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const out = await o.create({ key: () => "k", declaredLength: 8, complete: true, body });
        expect(out.kind).toBe("limit-violation");
        expect(cancelled).toBe(true);
    });

    test("a creation that loses the lock race cancels the request body", async () => {
        // Contention answers 423 without ever running the locked callback, so
        // the body never reaches a store and is still this layer's to release.
        const { store } = fakeStore();
        const contended: UploadLocker = {
            acquire: async (token) => {
                throw new UploadLockTimeoutError(token);
            },
        };
        const o = orch(store, { locker: contended });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bodyOf("abc"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const out = await o.create({
            key: () => "k",
            declaredLength: 3,
            contentLength: 3,
            complete: true,
            body,
        });
        expect(out.kind).toBe("contended");
        expect(cancelled).toBe(true);
    });

    test("a locker failure that is not a timeout propagates and still cancels the body", async () => {
        const { store } = fakeStore();
        const broken: UploadLocker = {
            acquire: async () => {
                throw new Error("lock service unreachable");
            },
        };
        const o = orch(store, { locker: broken });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bodyOf("abc"));
            },
            cancel() {
                cancelled = true;
            },
        });
        await expect(
            o.create({
                key: () => "k",
                declaredLength: 3,
                contentLength: 3,
                complete: true,
                body,
            }),
        ).rejects.toThrow("lock service unreachable");
        expect(cancelled).toBe(true);
    });

    test("a creation the store will not allocate cancels the request body", async () => {
        const { store } = fakeStore({
            createUpload: async () => {
                throw new Error("backend down");
            },
        });
        const o = orch(store, { onError: () => {} });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bodyOf("abc"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const out = await o.create({
            key: () => "k",
            declaredLength: 3,
            contentLength: 3,
            complete: true,
            body,
        });
        expect(out.kind).toBe("store-error");
        expect(cancelled).toBe(true);
    });
});

describe("the min-append floor binds on an inferred completion", () => {
    // A request that omits its content size infers as completing on any
    // known-length upload. While that inference carried the completing
    // exemption, each such append wrote its byte, failed the post-condition,
    // answered 204 and cost a durable write, so `min-append-size` bound only
    // the clients that declared a size. The same loophole under another
    // header: the client sets the completion header on every one-byte chunked
    // append. The engine cannot hold that statement to the post-condition
    // before the write and the short body would stay durable, so both shapes
    // are refused before any byte moves.
    for (const [shape, complete] of [
        ["an inferred completion", "infer"],
        ["an asserted completion", true],
    ] as const) {
        test(`undeclared one-byte appends under ${shape} are refused before any byte moves`, async () => {
            const { store, uploads } = fakeStore();
            let appendCalls = 0;
            const counting: ResumableWriteStore = {
                ...store,
                appendChunk: async (token, offset, body, opts) => {
                    appendCalls += 1;
                    return await store.appendChunk(token, offset, body, opts);
                },
            };
            const o = orch(counting, { policy: { minAppendSize: 1024 } });
            const created = createdOk(await o.create({ key: () => "k", declaredLength: 10_000, complete: false }));
            for (let i = 0; i < 3; i += 1) {
                const out = await o.append(created.uploadToken, { offset: 0, complete, body: bodyOf("x") });
                expect(out).toMatchObject({ kind: "limit-violation", reason: "append-too-small" });
            }
            expect(appendCalls).toBe(0);
            expect(uploads.get(created.uploadToken)!.bytes.byteLength).toBe(0);
        });
    }

    test("a deferred-length upload finished by a chunked completing append keeps the exemption", async () => {
        // The delivered bytes ARE the representation, so the completion cannot
        // fail the post-condition: a client that cannot size its body finishes.
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 1024 } });
        const created = createdOk(await o.create({ key: () => "k", complete: false }));
        const out = await o.append(created.uploadToken, { offset: 0, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "appended", offset: 3, complete: true });
    });

    test("a client that states this request is the last one still finishes under the floor", async () => {
        const { store } = fakeStore();
        const o = orch(store, { policy: { minAppendSize: 1024 } });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 5, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 5,
            complete: true,
            body: bodyOf("abcde"),
        });
        expect(out).toMatchObject({ kind: "appended", offset: 5, complete: true });
    });
});

describe("the store reports interruption; the orchestrator does not infer it", () => {
    test("a store that yields with no signal aborted is believed, and nothing publishes", async () => {
        // The signal says only that something ASKED for a yield, never what
        // the store did with the body. Only the store reads it, so only the
        // store can say whether it reached the end.
        const { store, uploads } = fakeStore();
        const yielding: ResumableWriteStore = {
            ...store,
            appendChunk: async (token, offset, body, opts) => {
                const result = await store.appendChunk(token, offset, body, opts);
                return { bytesWritten: result.bytesWritten, interrupted: true };
            },
        };
        const o = orch(yielding);
        const { created, out } = await appendAbcAsFinal(o);
        expect(out).toMatchObject({ kind: "appended", interrupted: true, complete: false });
        expect(uploads.get(created.uploadToken)!.isComplete).toBe(false);
    });

    test("a store error raised while a yield was requested stays an error", async () => {
        const { store } = fakeStore();
        const failing: ResumableWriteStore = {
            ...store,
            appendChunk: async () => {
                throw new Error("backend down");
            },
        };
        const errors: unknown[] = [];
        const o = orch(failing, {
            onError: (err: unknown) => {
                errors.push(err);
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        const ctl = new AbortController();
        ctl.abort();
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
            signal: ctl.signal,
        });
        expect(out.kind).toBe("store-error");
        expect(errors).toHaveLength(1);
    });

    test("a store that throws a standard abort error for its yield answers interrupted", async () => {
        // Identified by the thrown value, not the signal: none was aborted here.
        const { store } = fakeStore();
        const throwing: ResumableWriteStore = {
            ...store,
            appendChunk: async (token, offset, body, opts) => {
                await store.appendChunk(token, offset, body, opts);
                throw new DOMException("The operation was aborted.", "AbortError");
            },
        };
        const errors: unknown[] = [];
        const o = orch(throwing, { onError: (err: unknown) => errors.push(err) });
        const { out } = await appendAbcAsFinal(o);
        // The flushed prefix comes from a fresh state read, and an interrupted
        // completing append publishes nothing.
        expect(out).toMatchObject({ kind: "appended", offset: 3, interrupted: true, complete: false });
        expect(errors).toEqual([]);
    });

    test("a store that throws the write signal's own reason answers interrupted, whatever the reason is", async () => {
        const { store } = fakeStore();
        const request = new AbortController();
        const throwing: ResumableWriteStore = {
            ...store,
            appendChunk: async (_token, _offset, _body, opts) => {
                request.abort("client went away");
                throw opts.signal!.reason;
            },
        };
        const errors: unknown[] = [];
        const o = orch(throwing, { onError: (err: unknown) => errors.push(err) });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
            signal: request.signal,
        });
        expect(out).toMatchObject({ kind: "appended", offset: 0, interrupted: true });
        expect(errors).toEqual([]);
    });
});

describe("a terminal resource whose discard fails still answers its refusal", () => {
    // The answer is decided and truthful; the failed discard is storage an
    // operator reclaims by hand, so it is reported, never raised.
    const KEY = "reports/2026/q3.bin";
    const deadStore = () =>
        fakeStore({
            getUploadState: async (): Promise<StoredUploadState> => ({
                key: KEY,
                offset: 0,
                status: "invalidated",
                createdAt: NOW,
            }),
            abortUpload: async () => {
                throw new Error("discard failed");
            },
        }).store;
    const append = { offset: 0, contentLength: 3, complete: false, body: bodyOf("abc") } as const;

    test("the failure reaches onError under the audit key", async () => {
        const seen: { err: unknown; ctx: unknown }[] = [];
        const o = orch(deadStore(), { onError: (err, ctx) => seen.push({ err, ctx }) });
        const out = await o.append("dead", { ...append, auditKey: "doc-7" });
        expect(out).toMatchObject({ kind: "gone", reason: "invalidated" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.ctx).toEqual({ auditKey: "doc-7", operation: "abort" });
        // Under an audit key the sink receives the projection: the class, never the text.
        expect(seen[0]!.err).toEqual({ name: "Error", operation: "abort" });
    });

    test("with no onError installed the refusal still answers", async () => {
        const out = await orch(deadStore()).append("dead", append);
        expect(out).toMatchObject({ kind: "gone", reason: "invalidated" });
    });
});

describe("the store-error outcome honors the auditKey promise", () => {
    test("the error on the outcome is projected, not only the copy sent to onError", async () => {
        // The outcome travels to the same places the error report does, so
        // projecting one and not the other hands the capability to a log sink
        // by the other door.
        const { store } = fakeStore();
        const failing: ResumableWriteStore = {
            ...store,
            appendChunk: async (token) => {
                throw new Error(`write failed for ${token}`);
            },
        };
        const o = orch(failing, { onError: () => {} });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: false,
            body: bodyOf("abc"),
            auditKey: "audit-1",
        });
        expect(out).toMatchObject({ kind: "store-error", error: { name: "Error", operation: "append" } });
        expect(JSON.stringify(out)).not.toContain("write failed");
    });

    test("a failing abort reaches both sinks projected, carrying its class and status", async () => {
        // `cancel` reads state before it aborts, so the destination key is known
        // by the time the abort runs, and the store error names it. Only the
        // fields that classify the failure pass.
        const KEY = "reports/2026/q3.bin";
        const { store } = fakeStore();
        const failing: ResumableWriteStore = {
            ...store,
            abortUpload: async () => {
                throw new StoreUnavailableError(KEY);
            },
        };
        const seen: { err: unknown; ctx: { uploadToken?: string; auditKey?: string; operation: string } }[] = [];
        const o = orch(failing, { onError: (err, ctx) => seen.push({ err, ctx }) });
        const created = createdOk(await o.create({ key: () => KEY, declaredLength: 3, complete: false }));
        const out = await o.cancel(created.uploadToken, { auditKey: "doc-7" });

        const projected = { name: "StoreUnavailableError", status: 503, operation: "abort" };
        expect(out).toMatchObject({ kind: "store-error", error: projected });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.err).toMatchObject(projected);
        expect(JSON.stringify(seen[0]!.err)).not.toContain(KEY);
    });
});

describe("a store that cannot make the guarantees is refused at construction", () => {
    test("enforcesOffsetCheck: false is refused", () => {
        const { store } = fakeStore();
        expect(() => createUploadOrchestrator({ ...store, enforcesOffsetCheck: false })).toThrow(/enforcesOffsetCheck/);
    });

    test("atomicCompletion: false is refused", () => {
        const { store } = fakeStore();
        expect(() => createUploadOrchestrator({ ...store, atomicCompletion: false })).toThrow(/atomicCompletion/);
    });
});

describe("completion under the seal", () => {
    test("completion carries the acknowledged length as expectedLength", async () => {
        const seen: number[] = [];
        const { store } = fakeStore();
        const o = orch({
            ...store,
            completeUpload: (t, opts) => {
                seen.push(opts.expectedLength);
                return store.completeUpload(t, opts);
            },
        });
        createdOk(await o.create({ key: () => "k", contentLength: 3, complete: true, body: bodyOf("abc") }));
        const again = createdOk(await o.create({ key: () => "k2", declaredLength: 4, complete: false }));
        await o.append(again.uploadToken, { offset: 0, contentLength: 2, complete: false, body: bodyOf("wx") });
        await o.append(again.uploadToken, { offset: 2, contentLength: 2, complete: true, body: bodyOf("yz") });
        expect(seen).toEqual([3, 4]);
    });

    test("a sealed plan of another length answers the offset mismatch, not a store failure", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            completeUpload: async (t) => {
                throw new UploadOffsetConflictError(t, 9);
            },
        });
        const o = orch(store, { onError: (e) => errors.push(String(e)) });
        const { out } = await appendAbcAsFinal(o);
        expect(out).toMatchObject({ kind: "offset-mismatch", claimedOffset: 3, correctOffset: 9 });
        expect(errors).toEqual([]);
    });

    test("a destination conflict answers destination-conflict and reaches onError", async () => {
        const errors: string[] = [];
        const { store } = fakeStore({
            completeUpload: async (t) => {
                throw new UploadDestinationConflictError(t);
            },
        });
        const o = orch(store, { onError: (e, ctx) => errors.push(`${ctx.operation}:${(e as Error).name}`) });
        const out = await o.create({ key: () => "k", contentLength: 3, complete: true, body: bodyOf("abc") });
        expect(out).toMatchObject({ kind: "destination-conflict" });
        expect(errors).toEqual(["complete:UploadDestinationConflictError"]);
    });

    test("a destination conflict from a state read answers destination-conflict, not a store failure", async () => {
        const errors: string[] = [];
        const { store } = fakeStore();
        const o = orch(
            {
                ...store,
                getUploadState: async (t) => {
                    throw new UploadDestinationConflictError(t);
                },
            },
            { onError: (e, ctx) => errors.push(`${ctx.operation}:${(e as Error).name}`) },
        );
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        const out = await o.probe(created.uploadToken);
        expect(out).toMatchObject({ kind: "destination-conflict", uploadToken: created.uploadToken });
        expect(errors).toEqual(["head:UploadDestinationConflictError"]);
    });

    test("a holder whose lease is lost does not start a completion", async () => {
        let completions = 0;
        const { store } = fakeStore();
        const lease = new AbortController();
        const locker: UploadLocker = {
            async acquire() {
                // The yield signal stays live so only the lease check can refuse.
                return { signal: new AbortController().signal, lease: lease.signal, release() {} };
            },
        };
        const o = orch(
            {
                ...store,
                completeUpload: (t, opts) => {
                    completions++;
                    return store.completeUpload(t, opts);
                },
            },
            { locker },
        );
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        lease.abort(UPLOAD_LEASE_LOST);
        const out = await o.append(created.uploadToken, {
            offset: 0,
            contentLength: 3,
            complete: true,
            body: bodyOf("abc"),
        });
        expect(out.kind).toBe("contended");
        expect(completions).toBe(0);
    });
});

describe("lock-free reads", () => {
    test("admit and resourceExists ask the store not to repair; a locked probe may", async () => {
        const seen: Array<boolean | undefined> = [];
        const { store } = fakeStore();
        const o = orch({
            ...store,
            getUploadState: (t, opts) => {
                seen.push(opts?.repair);
                return store.getUploadState(t, opts);
            },
        });
        const created = createdOk(await o.create({ key: () => "k", declaredLength: 3, complete: false }));
        seen.length = 0;
        await o.admit(created.uploadToken);
        await o.resourceExists(created.uploadToken);
        await o.probe(created.uploadToken);
        expect(seen).toEqual([false, false, undefined]);
    });
});

describe("redactErrors", () => {
    test("projects a store error reported without an audit key, and drops the token", async () => {
        const reports: Array<{ err: unknown; ctx: { uploadToken?: string } }> = [];
        const { store } = fakeStore({
            getUploadState: async (t) => {
                throw new Error(`backend failed for ${t}`);
            },
        });
        const o = orch(store, { redactErrors: true, onError: (err, ctx) => reports.push({ err, ctx }) });
        const out = await o.probe("tok-secret");
        expect(out.kind).toBe("store-error");
        expect(reports).toHaveLength(1);
        expect(reports[0]!.ctx.uploadToken).toBeUndefined();
        expect(JSON.stringify(reports[0]!.err)).not.toContain("tok-secret");
        expect(out.kind === "store-error" ? JSON.stringify(out.error) : "").not.toContain("tok-secret");
    });
});
