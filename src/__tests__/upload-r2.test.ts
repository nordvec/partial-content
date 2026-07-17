import { describe, test, expect } from "bun:test";
import { r2UploadStore, UploadNotFoundError, UploadOffsetConflictError } from "../r2";

// ─── Mock R2 Bucket (multipart upload surface) ──────────────────────────────

const NOW = 1_800_000_000_000;
const PART_SIZE = 4;

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
}

function multipartGone(): Error {
    return new Error("The specified multipart upload does not exist.");
}

interface MockR2UploadOpts {
    /** Fail the Nth put to a `.manifest` key (1-based, counted from reset). */
    failManifestPutAt?: number;
    /** Operation journal: proves part-then-manifest write ordering. */
    journal?: string[];
    /** list() page size (exercises cursor pagination). */
    pageSize?: number;
}

function mockUploadBucket(opts: MockR2UploadOpts = {}) {
    const objects = new Map<string, { content: Uint8Array; etag: string }>();
    const mpus = new Map<string, { key: string; parts: Map<number, { etag: string; bytes: Uint8Array }> }>();
    let etagCounter = 0;
    let uploadCounter = 0;
    let manifestPuts = 0;

    const bucket = {
        async head(key: string) {
            const obj = objects.get(key);
            return obj ? { etag: obj.etag } : null;
        },
        async get(key: string) {
            const obj = objects.get(key);
            if (!obj) return null;
            return { text: async () => new TextDecoder().decode(obj.content) };
        },
        async put(key: string, value: Uint8Array | string) {
            if (key.endsWith(".manifest")) {
                manifestPuts += 1;
                if (opts.failManifestPutAt !== undefined && manifestPuts === opts.failManifestPutAt) {
                    throw new Error("mock: manifest put failed");
                }
                opts.journal?.push(`putManifest:${manifestPuts}`);
            }
            etagCounter += 1;
            const etag = `r2-etag-${etagCounter}`;
            objects.set(key, {
                content: typeof value === "string" ? new TextEncoder().encode(value) : value.slice(),
                etag,
            });
            return { etag };
        },
        async delete(key: string) {
            objects.delete(key);
        },
        async list(listOpts?: { prefix?: string; cursor?: string }) {
            // Key-positional cursor, like the real binding: deletions made
            // while paginating never shift what a later page returns.
            const keys = [...objects.keys()]
                .filter((key) => !listOpts?.prefix || key.startsWith(listOpts.prefix))
                .filter((key) => !listOpts?.cursor || key > listOpts.cursor)
                .toSorted();
            const pageSize = opts.pageSize ?? Math.max(keys.length, 1);
            const page = keys.slice(0, pageSize);
            const truncated = page.length < keys.length;
            return {
                objects: page.map((key) => ({ key })),
                truncated,
                cursor: truncated ? page[page.length - 1] : undefined,
            };
        },
        async createMultipartUpload(key: string) {
            uploadCounter += 1;
            const uploadId = `mpu-${uploadCounter}`;
            mpus.set(uploadId, { key, parts: new Map() });
            return bucket.resumeMultipartUpload(key, uploadId);
        },
        resumeMultipartUpload(key: string, uploadId: string) {
            return {
                uploadId,
                async uploadPart(partNumber: number, value: Uint8Array) {
                    const mpu = mpus.get(uploadId);
                    if (!mpu || mpu.key !== key) throw multipartGone();
                    etagCounter += 1;
                    const etag = `part-etag-${etagCounter}`;
                    mpu.parts.set(partNumber, { etag, bytes: value.slice() });
                    opts.journal?.push(`uploadPart:${partNumber}:${value.length}`);
                    return { partNumber, etag };
                },
                async complete(uploadedParts: Array<{ partNumber: number; etag: string }>) {
                    const mpu = mpus.get(uploadId);
                    if (!mpu || mpu.key !== key) throw multipartGone();
                    const pieces: Uint8Array[] = [];
                    for (const [index, listed] of uploadedParts.entries()) {
                        const stored = mpu.parts.get(listed.partNumber);
                        if (!stored || stored.etag !== listed.etag) {
                            throw new Error("mock: listed part was never uploaded");
                        }
                        // R2's rule: every part except the last must be the
                        // same size as the first.
                        if (index < uploadedParts.length - 1) {
                            const firstSize = mpu.parts.get(uploadedParts[0]!.partNumber)!.bytes.length;
                            if (stored.bytes.length !== firstSize) {
                                throw new Error("mock: all non-final parts must be the same size");
                            }
                        }
                        pieces.push(stored.bytes);
                    }
                    etagCounter += 1;
                    const etag = `r2-etag-${etagCounter}`;
                    objects.set(key, { content: concat(pieces), etag });
                    mpus.delete(uploadId); // a completed upload cannot be resumed
                    return { etag };
                },
                async abort() {
                    if (!mpus.delete(uploadId)) throw multipartGone();
                },
            };
        },
    };

    return {
        bucket,
        objects,
        mpus,
        resetManifestPutCount() { manifestPuts = 0; },
        partSizes(uploadId: string): number[] {
            const mpu = mpus.get(uploadId);
            return mpu
                ? [...mpu.parts.entries()].toSorted((a, b) => a[0] - b[0]).map(([, p]) => p.bytes.length)
                : [];
        },
    };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const asciiBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeStore(opts: MockR2UploadOpts = {}) {
    const mock = mockUploadBucket(opts);
    const store = r2UploadStore({ bucket: mock.bucket, partSize: PART_SIZE });
    return { ...mock, store };
}

// ─── Round Trip ──────────────────────────────────────────────────────────────

describe("r2UploadStore: round trip", () => {
    test("create -> state -> append -> append -> complete publishes the assembled object", async () => {
        const { store, objects } = makeStore();

        const { uploadToken } = await store.createUpload({
            key: "docs/report.pdf",
            length: 13,
            metadata: { filename: "report.pdf" },
            now: NOW,
        });

        const fresh = await store.getUploadState(uploadToken);
        expect(fresh.offset).toBe(0);
        expect(fresh.length).toBe(13);
        expect(fresh.isComplete).toBe(false);
        expect(fresh.createdAt).toBe(NOW);
        expect(fresh.metadata).toEqual({ filename: "report.pdf" });

        // A partSize-multiple append lands whole parts only.
        const first = await store.appendChunk(uploadToken, 0, asciiBytes("01234567"), { now: NOW + 1 });
        expect(first.bytesWritten).toBe(8);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(8);
        expect(mid.lastAppendAt).toBe(NOW + 1);

        // The final append's remainder becomes the (legal) short final part.
        const second = await store.appendChunk(uploadToken, 8, streamOf(asciiBytes("89a"), asciiBytes("bc")), { now: NOW + 2 });
        expect(second.bytesWritten).toBe(5);

        const completed = await store.completeUpload(uploadToken, { now: NOW + 3 });
        expect(completed.etag).toBeDefined();
        expect(new TextDecoder().decode(objects.get("docs/report.pdf")!.content)).toBe("0123456789abc");

        const final = await store.getUploadState(uploadToken);
        expect(final.isComplete).toBe(true);
        expect(final.offset).toBe(13);
    });

    test("completion is idempotent and replays the recorded etag", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await store.completeUpload(uploadToken, { now: NOW });
        const replay = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty object and retires the multipart upload", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });
        expect(mpus.size).toBe(1);

        const completed = await store.completeUpload(uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty.bin")!.content.length).toBe(0);
        expect(mpus.size).toBe(0); // aborted, not leaked

        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(true);
        expect(state.offset).toBe(0);
    });
});

// ─── Uniform Parts + Manifest Ordering ──────────────────────────────────────

describe("r2UploadStore: uniform-part buffering and manifest ordering", () => {
    test("odd-sized stream chunks re-slice into exact partSize parts plus a final remainder", async () => {
        const { store, mpus, partSizes } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "b.bin", now: NOW });
        // 3+3+4 = 10 bytes arrive; parts must be exactly 4, 4, then final 2.
        await store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6), bytes(7, 8, 9, 10)), { now: NOW });
        const uploadId = [...mpus.keys()][0]!;
        expect(partSizes(uploadId)).toEqual([4, 4, 2]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(10);
    });

    test("the manifest is rewritten after EVERY accepted part, part first", async () => {
        const journal: string[] = [];
        const { store } = makeStore({ journal });
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        journal.length = 0;
        await store.appendChunk(uploadToken, 0, asciiBytes("0123456789"), { now: NOW });
        // Strictly alternating: a part upload, then its manifest record.
        expect(journal).toEqual([
            "uploadPart:1:4", "putManifest:2",
            "uploadPart:2:4", "putManifest:3",
            "uploadPart:3:2", "putManifest:4",
        ]);
    });

    test("a crash between part and manifest orphans the part and the offset honestly excludes it", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, mpus, partSizes, ...mock } = { ...makeStore(mockOpts) };
        const { uploadToken } = await store.createUpload({ key: "d.bin", now: NOW });

        // The manifest write AFTER the first part dies (put #1 was creation).
        mockOpts.failManifestPutAt = 2;
        await expect(store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW }))
            .rejects.toThrow(/manifest put failed/);

        // The part physically landed, but the ledger never recorded it...
        const uploadId = [...mpus.keys()][0]!;
        expect(partSizes(uploadId)).toEqual([4]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);

        // ...so resume re-sends at offset 0 and the same part number replaces
        // the orphan instead of corrupting anything.
        mockOpts.failManifestPutAt = undefined;
        const retried = await store.appendChunk(uploadToken, 0, bytes(9, 8, 7, 6), { now: NOW + 1 });
        expect(retried.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).offset).toBe(4);
        await store.completeUpload(uploadToken, { now: NOW + 2 });
        expect(mock.objects.get("d.bin")!.content).toEqual(bytes(9, 8, 7, 6));
    });

    test("an aborted body does NOT flush the partial buffer (no short part mid-upload)", async () => {
        const { store, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "e.bin", now: NOW });
        const controller = new AbortController();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(streamController) {
                pulls += 1;
                if (pulls === 1) {
                    streamController.enqueue(bytes(1, 2, 3)); // below partSize
                } else {
                    controller.abort();
                }
            },
        });
        const result = await store.appendChunk(uploadToken, 0, body, { now: NOW, signal: controller.signal });
        expect(result.bytesWritten).toBe(0);
        const uploadId = [...mpus.keys()][0]!;
        expect(mpus.get(uploadId)!.parts.size).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });
});

// ─── Guards ──────────────────────────────────────────────────────────────────

describe("r2UploadStore: guards", () => {
    test("claimed offset that lost to durable state throws UploadOffsetConflictError", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "f.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        const err = await store.appendChunk(uploadToken, 2, bytes(5), { now: NOW }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(4);
    });

    test("crossing maxBytes writes the invalidation marker durably and refuses everything after", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "g.bin", now: NOW });

        await expect(
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), { now: NOW, maxBytes: 5 }),
        ).rejects.toThrow(/byte bound/);

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("expectedDigest throws a clear error instead of being silently ignored", async () => {
        const { store, objects } = makeStore();
        expect(store.digestOnComplete).toBe(false);
        const { uploadToken } = await store.createUpload({ key: "h.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            store.completeUpload(uploadToken, { now: NOW, expectedDigest: "x".repeat(43) + "=" }),
        ).rejects.toThrow(/digestOnComplete/);
        expect(objects.has("h.bin")).toBe(false); // nothing published
    });

    test("appending to a completed upload throws", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "i.bin", now: NOW });
        await store.completeUpload(uploadToken, { now: NOW });
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/complete/);
    });
});

// ─── Deferred Length ─────────────────────────────────────────────────────────

describe("r2UploadStore: deferred-length declaration on append", () => {
    test("a length first declared on a part-flushing append is persisted and reported next", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "deferred.bin", now: NOW });
        expect((await store.getUploadState(uploadToken)).length).toBeUndefined();

        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { length: 4, now: NOW + 1 });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(4);
        expect(state.offset).toBe(4);
    });

    test("a length declared on a zero-byte append (no part landed) is still persisted", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "z.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, new Uint8Array(0), { length: 0, now: NOW + 1 });
        expect((await store.getUploadState(uploadToken)).length).toBe(0);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "fixed.bin", length: 9, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { length: 42, now: NOW + 1 });
        expect((await store.getUploadState(uploadToken)).length).toBe(9);
    });
});

// ─── Not-Found + Token Integrity ─────────────────────────────────────────────

describe("r2UploadStore: not-found and token integrity", () => {
    test("garbage tokens answer UploadNotFoundError, never a parse crash", async () => {
        const { store } = makeStore();
        await expect(store.getUploadState("!!!not-base64!!!")).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.appendChunk("AAAA", 0, bytes(1), { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.completeUpload("e30", { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a corrupt manifest answers UploadNotFoundError", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        objects.set(manifestKey, { content: asciiBytes("not json"), etag: "x" });
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a token whose key was tampered answers UploadNotFoundError", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        const decoded = JSON.parse(new TextDecoder().decode(
            Uint8Array.from(atob(uploadToken.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
        )) as { key: string; id: string };
        const forged = btoa(JSON.stringify({ key: "attacker.bin", id: decoded.id }))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        await expect(store.getUploadState(forged)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Completion Crash Recovery ───────────────────────────────────────────────

describe("r2UploadStore: completion crash recovery", () => {
    test("a crash between complete() and the manifest update replays as success on retry", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, resetManifestPutCount } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });

        // Completion: manifest put #1 is the completing marker (succeeds),
        // put #2 is the final bookkeeping (crashes) AFTER complete() landed.
        resetManifestPutCount();
        mockOpts.failManifestPutAt = 2;
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/manifest put failed/);
        expect(objects.get("k.bin")!.content).toEqual(bytes(1, 2, 3, 4)); // published

        // Retry: the multipart upload is gone, but the completing marker and
        // the object at the key prove the publish landed.
        mockOpts.failManifestPutAt = undefined;
        const replay = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(objects.get("k.bin")!.etag);
        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(true);
    });

    test("a lost multipart upload WITHOUT the completing marker fails loudly", async () => {
        const { store, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "l.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        mpus.clear(); // lifecycle GC reaped the multipart upload mid-flight
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/does not exist/);
    });
});

// ─── Abort + Sweep ───────────────────────────────────────────────────────────

describe("r2UploadStore: abort and sweep", () => {
    test("abort aborts the multipart upload, deletes the manifest, and is idempotent", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "m.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(mpus.size).toBe(0);
        expect([...objects.keys()].filter((key) => key.endsWith(".manifest"))).toEqual([]);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);

        await store.abortUpload(uploadToken); // second abort: silent no-op
        await store.abortUpload("garbage-token"); // never-created: silent no-op
    });

    test("aborting a completed upload keeps the published object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "n.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        await store.completeUpload(uploadToken, { now: NOW });
        await store.abortUpload(uploadToken);
        expect(objects.get("n.bin")!.content).toEqual(bytes(1, 2));
    });

    test("sweepExpired paginates, reaps idle uploads (manifest + multipart), keeps active ones", async () => {
        const { store, objects, mpus } = makeStore({ pageSize: 2 });
        const staleA = await store.createUpload({ key: "stale-a.bin", now: NOW - 100_000 });
        await store.appendChunk(staleA.uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW - 90_000 });
        const staleB = await store.createUpload({ key: "stale-b.bin", now: NOW - 80_000 });
        const active = await store.createUpload({ key: "active.bin", now: NOW - 100_000 });
        await store.appendChunk(active.uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW - 1_000 });

        const { removed } = await store.sweepExpired!(NOW - 10_000);
        expect(removed).toBe(2);
        await expect(store.getUploadState(staleA.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(staleB.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(4);
        expect(mpus.size).toBe(1); // only the active upload's multipart survives
        expect([...objects.keys()].filter((key) => key.endsWith(".manifest")).length).toBe(1);
    });
});

// ─── Manifest Shape Gate ─────────────────────────────────────────────────────

function toBase64Url(text: string): string {
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
}

describe("r2UploadStore: manifest shape gate", () => {
    /** Create a real upload with one part, then corrupt one manifest field. */
    async function tamperedStore(mutate: (manifest: Record<string, unknown>) => unknown) {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({
            key: "t.bin", length: 8, metadata: { a: "b" }, now: NOW,
        });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<string, unknown>;
        const replacement = mutate(manifest);
        objects.set(manifestKey, {
            content: new TextEncoder().encode(JSON.stringify(replacement === undefined ? manifest : replacement)),
            etag: "tampered",
        });
        return { store, uploadToken };
    }

    const corruptions: Array<[string, (manifest: Record<string, unknown>) => unknown]> = [
        ["empty key", (m) => { m.key = ""; }],
        ["empty uploadId", (m) => { m.uploadId = ""; }],
        ["missing uploadId", (m) => { delete m.uploadId; }],
        ["zero partSize", (m) => { m.partSize = 0; }],
        ["string partSize", (m) => { m.partSize = "4"; }],
        ["negative length", (m) => { m.length = -1; }],
        ["missing createdAt", (m) => { delete m.createdAt; }],
        ["fractional lastAppendAt", (m) => { m.lastAppendAt = 1.5; }],
        ["string isComplete", (m) => { m.isComplete = "no"; }],
        ["numeric isInvalidated", (m) => { m.isInvalidated = 0; }],
        ["string completing", (m) => { m.completing = "yes"; }],
        ["numeric etag", (m) => { m.etag = 9; }],
        ["non-string metadata value", (m) => { m.metadata = { a: 3 }; }],
        ["non-array parts", (m) => { m.parts = "x"; }],
        ["part number zero", (m) => { m.parts = [{ partNumber: 0, etag: "e", size: 1 }]; }],
        ["numeric part etag", (m) => { m.parts = [{ partNumber: 1, etag: 4, size: 1 }]; }],
        ["negative part size", (m) => { m.parts = [{ partNumber: 1, etag: "e", size: -2 }]; }],
        ["null part entry", (m) => { m.parts = [null]; }],
        ["array manifest", () => []],
        ["string manifest", () => "not an object"],
    ];

    for (const [label, mutate] of corruptions) {
        test(`corrupt manifest (${label}) answers UploadNotFoundError`, async () => {
            const { store, uploadToken } = await tamperedStore(mutate);
            await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
            await expect(store.appendChunk(uploadToken, 4, bytes(1), { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        });
    }

    test("a fully-populated valid manifest (all optional fields set) still reads", async () => {
        const { store, uploadToken } = await tamperedStore((m) => {
            m.length = 8;
            m.lastAppendAt = NOW;
            m.completing = false;
            m.etag = "some-etag";
            m.metadata = { a: "b" };
        });
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
        expect(state.lastAppendAt).toBe(NOW);
    });

    const forgedTokens: Array<[string, string]> = [
        ["empty key", toBase64Url(JSON.stringify({ key: "", id: "3f8b1c2a-0d4e-4f6a-9b7c-1a2b3c4d5e6f" }))],
        ["non-uuid id", toBase64Url(JSON.stringify({ key: "x.bin", id: "../../etc/passwd" }))],
        ["numeric key", toBase64Url(JSON.stringify({ key: 9, id: "3f8b1c2a-0d4e-4f6a-9b7c-1a2b3c4d5e6f" }))],
        ["array payload", toBase64Url("[]")],
        ["null payload", toBase64Url("null")],
        ["number payload", toBase64Url("42")],
    ];

    for (const [label, token] of forgedTokens) {
        test(`malformed token (${label}) answers UploadNotFoundError`, async () => {
            const { store } = makeStore();
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
        });
    }

    test("tokens are URL-safe even when the key's base64 needs + and /", async () => {
        const { store } = makeStore();
        // ">>>" base64-encodes with "+" and "???" with "/": both must be
        // translated to the URL-safe alphabet and pad-stripped.
        const { uploadToken } = await store.createUpload({ key: ">>>???", now: NOW });
        expect(uploadToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0); // and still round-trips
    });
});

// ─── Limits + Completion Bookkeeping ─────────────────────────────────────────

describe("r2UploadStore: limits and completion bookkeeping", () => {
    test("a body of exactly maxBytes is accepted", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "exact.bin", now: NOW });
        const result = await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW, maxBytes: 4 });
        expect(result.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).isInvalidated).toBe(false);
    });

    test("exceeding R2's part limit fails loudly", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "cap.bin", now: NOW });
        // The manifest already records a part at the last permitted number.
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<string, unknown>;
        manifest.parts = [{ partNumber: 10_000, etag: "e", size: 4 }];
        objects.set(manifestKey, { content: new TextEncoder().encode(JSON.stringify(manifest)), etag: "t" });

        await expect(store.appendChunk(uploadToken, 4, bytes(1, 2, 3, 4), { now: NOW }))
            .rejects.toThrow(/10,000-part/);
    });

    test("a normal completion writes exactly two manifest records: commit marker, then outcome", async () => {
        const journal: string[] = [];
        const { store } = makeStore({ journal });
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        journal.length = 0;
        await store.completeUpload(uploadToken, { now: NOW });
        expect(journal.filter((entry) => entry.startsWith("putManifest")).length).toBe(2);
    });

    test("a lost multipart upload WITH the completing marker but NO object at the key still fails", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "gone.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        // Marker set (a completion began), but the multipart upload vanished
        // and nothing was ever published at the key.
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<string, unknown>;
        manifest.completing = true;
        objects.set(manifestKey, { content: new TextEncoder().encode(JSON.stringify(manifest)), etag: "t" });
        mpus.clear();

        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/does not exist/);
        expect((await store.getUploadState(uploadToken)).isComplete).toBe(false);
    });

    test("zero-byte completion still publishes when the multipart upload is already gone", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty2.bin", now: NOW });
        mpus.clear(); // lifecycle GC took the multipart upload; nothing was staged anyway
        const completed = await store.completeUpload(uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty2.bin")!.content.length).toBe(0);
    });

    test("abort with a forged (valid-id, wrong-key) token discards nothing", async () => {
        const { store, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        const decoded = JSON.parse(fromBase64Url(uploadToken)) as { key: string; id: string };
        const forged = toBase64Url(JSON.stringify({ key: "attacker.bin", id: decoded.id }));

        await store.abortUpload(forged);
        expect(mpus.size).toBe(1); // the victim's multipart upload survives
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("sweep keeps an upload idle EXACTLY at the cutoff and ignores foreign objects", async () => {
        const { store, objects } = makeStore();
        const cutoff = NOW - 10_000;
        const boundary = await store.createUpload({ key: "boundary.bin", now: cutoff });
        // A foreign object under the prefix must be left alone, not decoded or deleted.
        objects.set(".partial-content-uploads/readme.txt", { content: bytes(1), etag: "f" });

        const { removed } = await store.sweepExpired!(cutoff);
        expect(removed).toBe(0);
        expect(objects.has(".partial-content-uploads/readme.txt")).toBe(true);
        expect((await store.getUploadState(boundary.uploadToken)).createdAt).toBe(cutoff);
    });

    test("sweep reaps corrupt bookkeeping regardless of age", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "corrupt.bin", now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        objects.set(manifestKey, { content: asciiBytes("garbage"), etag: "t" });

        const { removed } = await store.sweepExpired!(0); // cutoff before every real upload
        expect(removed).toBe(1);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Capability Flags ────────────────────────────────────────────────────────

describe("r2UploadStore: capability flags", () => {
    test("advertises manifest-based (inexact) recovery, uniform parts, atomic completion, no digest", () => {
        const { store } = makeStore();
        expect(store.exactOffsetRecovery).toBe(false); // the binding has no ListParts to cross-check
        expect(store.uniformPartSize).toBe(true);
        expect(store.appendGranularity).toBe(PART_SIZE);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe(false);
    });

    test("rejects a nonsensical partSize at construction", () => {
        const { bucket } = mockUploadBucket();
        expect(() => r2UploadStore({ bucket, partSize: -1 })).toThrow(RangeError);
    });
});
