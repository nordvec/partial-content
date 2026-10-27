import { describe, test, expect } from "bun:test";
import { isCorruptUploadState } from "../upload-internals";
import { checkResumableWriteStore } from "../conformance";
import { r2UploadStore, UploadAppendBoundError, UploadNotFoundError, UploadOffsetConflictError } from "../r2";
import { UploadDestinationConflictError } from "../upload-store";
import { interleavedStream, expectGarbageTokensNotFound, completeDurable, publishedUpload } from "./helpers";

// ─── Mock R2 Bucket (multipart upload surface) ──────────────────────────────

const NOW = 1_800_000_000_000;
const PART_SIZE = 4;

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
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
    /**
     * Object keys whose delete rejects (a denied or throttled call). Mutable,
     * so a test can name an object the store created and only then arm the
     * failure.
     */
    failDeleteFor?: Set<string>;
    /** Runs after each listing page is read, so a test can act in the window a sweep races. */
    afterList?: () => void;
    /** Fail the Nth uploadPart call (1-based) with a transient error. Mutable. */
    failUploadPartAt?: number;
    /** Reject every multipart abort with this error instead of aborting. Mutable. */
    failAbortWith?: Error;
    /**
     * Awaited after each manifest write is stored, with the manifest written,
     * so a test can act in the window after a seal and before the publish.
     */
    onManifestPut?: (manifest: Record<string, unknown>) => Promise<void> | void;
}

function mockUploadBucket(opts: MockR2UploadOpts = {}) {
    const objects = new Map<string, { content: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
    const mpus = new Map<
        string,
        {
            key: string;
            customMetadata?: Record<string, string>;
            parts: Map<number, { etag: string; bytes: Uint8Array }>;
        }
    >();
    let etagCounter = 0;
    let uploadCounter = 0;
    let manifestPuts = 0;
    let partUploads = 0;

    /**
     * The binding's precondition: a put pinned to a version the object no
     * longer has, or to absence ("*") while one exists, resolves null and
     * writes nothing.
     */
    const refusedByPrecondition = (key: string, onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }) =>
        (onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== onlyIf.etagMatches) ||
        (onlyIf?.etagDoesNotMatch === "*" && objects.has(key));

    /** Counts, journals and (when armed) fails bookkeeping writes. */
    const journalPut = (key: string, value: Uint8Array | string): void => {
        if (key.endsWith(".manifest")) {
            manifestPuts += 1;
            if (opts.failManifestPutAt !== undefined && manifestPuts === opts.failManifestPutAt) {
                throw new Error("mock: manifest put failed");
            }
            opts.journal?.push(`putManifest:${manifestPuts}`);
        } else if (key.endsWith(".part")) {
            opts.journal?.push(`putTail:${value.length}`);
        }
    };

    const bucket = {
        async head(key: string) {
            const obj = objects.get(key);
            return obj ? { etag: obj.etag, customMetadata: obj.customMetadata } : null;
        },
        async get(key: string) {
            const obj = objects.get(key);
            if (!obj) return null;
            return {
                etag: obj.etag,
                text: async () => new TextDecoder().decode(obj.content),
                arrayBuffer: async () => obj.content.slice().buffer,
            };
        },
        async put(
            key: string,
            value: Uint8Array | string,
            options?: {
                onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
                customMetadata?: Record<string, string>;
            },
        ) {
            if (refusedByPrecondition(key, options?.onlyIf)) return null;
            journalPut(key, value);
            etagCounter += 1;
            const etag = `"put${etagCounter}"`;
            objects.set(key, {
                content: typeof value === "string" ? new TextEncoder().encode(value) : value.slice(),
                etag,
                customMetadata: options?.customMetadata,
            });
            if (key.endsWith(".manifest") && typeof value === "string") {
                await opts.onManifestPut?.(JSON.parse(value) as Record<string, unknown>);
            }
            return { etag };
        },
        async delete(key: string) {
            if (opts.failDeleteFor?.has(key)) throw new Error("mock: delete denied");
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
            opts.afterList?.();
            return {
                objects: page.map((key) => ({ key })),
                truncated,
                cursor: truncated ? page[page.length - 1] : undefined,
            };
        },
        async createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }) {
            uploadCounter += 1;
            const uploadId = `mpu-${uploadCounter}`;
            mpus.set(uploadId, { key, customMetadata: options?.customMetadata, parts: new Map() });
            return bucket.resumeMultipartUpload(key, uploadId);
        },
        resumeMultipartUpload(key: string, uploadId: string) {
            return {
                uploadId,
                async uploadPart(partNumber: number, value: Uint8Array) {
                    const mpu = mpus.get(uploadId);
                    if (!mpu || mpu.key !== key) throw multipartGone();
                    partUploads += 1;
                    if (partUploads === opts.failUploadPartAt) throw new Error("mock: part upload failed");
                    etagCounter += 1;
                    const etag = `"part${etagCounter}"`;
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
                    // A multipart object's ETag ends in its part count, as R2's does.
                    const etag = `"mpu${etagCounter}-${uploadedParts.length}"`;
                    objects.set(key, { content: concat(pieces), etag, customMetadata: mpu.customMetadata });
                    mpus.delete(uploadId); // a completed upload cannot be resumed
                    return { etag };
                },
                async abort() {
                    if (opts.failAbortWith) throw opts.failAbortWith;
                    if (!mpus.delete(uploadId)) throw multipartGone();
                },
            };
        },
    };

    return {
        bucket,
        objects,
        mpus,
        resetManifestPutCount() {
            manifestPuts = 0;
        },
        partSizes(uploadId: string): number[] {
            const mpu = mpus.get(uploadId);
            return mpu ? [...mpu.parts.entries()].toSorted((a, b) => a[0] - b[0]).map(([, p]) => p.bytes.length) : [];
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
/** The parked tail objects in the bucket, in key order. */
const tailKeys = (objects: Map<string, unknown>): string[] =>
    [...objects.keys()].filter((key) => key.endsWith(".part")).toSorted();

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
        expect(fresh.status === "complete").toBe(false);
        expect(fresh.createdAt).toBe(NOW);
        expect(fresh.metadata).toEqual({ filename: "report.pdf" });

        // A partSize-multiple append lands whole parts only.
        const first = await store.appendChunk(uploadToken, 0, asciiBytes("01234567"), { now: NOW + 1 });
        expect(first.bytesWritten).toBe(8);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(8);
        expect(mid.lastAppendAt).toBe(NOW + 1);

        // The final append's remainder becomes the (legal) short final part.
        const second = await store.appendChunk(uploadToken, 8, streamOf(asciiBytes("89a"), asciiBytes("bc")), {
            now: NOW + 2,
        });
        expect(second.bytesWritten).toBe(5);

        const completed = await store.completeUpload(uploadToken, { expectedLength: 13, now: NOW + 3 });
        expect(completed.etag).toBeDefined();
        expect(new TextDecoder().decode(objects.get("docs/report.pdf")!.content)).toBe("0123456789abc");

        const final = await store.getUploadState(uploadToken);
        expect(final.status === "complete").toBe(true);
        expect(final.offset).toBe(13);
    });

    test("completion is idempotent and replays the recorded etag", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await completeDurable(store, uploadToken, { now: NOW });
        const replay = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty object and retires the multipart upload", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });
        expect(mpus.size).toBe(1);

        const completed = await completeDurable(store, uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty.bin")!.content.length).toBe(0);
        expect(mpus.size).toBe(0); // aborted, not leaked

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(true);
        expect(state.offset).toBe(0);
    });
});

// ─── Uniform Parts + Manifest Ordering ──────────────────────────────────────

describe("r2UploadStore: uniform-part buffering and manifest ordering", () => {
    test("odd-sized stream chunks re-slice into exact partSize parts plus a parked remainder", async () => {
        const { store, mpus, partSizes, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "b.bin", now: NOW });
        // 3+3+4 = 10 bytes arrive; parts must be exactly 4, 4, and the last 2 parked.
        await store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6), bytes(7, 8, 9, 10)), {
            now: NOW,
        });
        const uploadId = [...mpus.keys()][0]!;
        expect(partSizes(uploadId)).toEqual([4, 4]);
        expect(tailKeys(objects).map((key) => objects.get(key)!.content)).toEqual([bytes(9, 10)]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(10);
    });

    test("the manifest is rewritten after EVERY accepted part, part first", async () => {
        const journal: string[] = [];
        const { store } = makeStore({ journal });
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        journal.length = 0;
        await store.appendChunk(uploadToken, 0, asciiBytes("0123456789"), { now: NOW });
        // Strictly alternating: a part upload or a parked tail, then the
        // manifest record that counts it.
        expect(journal).toEqual([
            "uploadPart:1:4",
            "putManifest:2",
            "uploadPart:2:4",
            "putManifest:3",
            "putTail:2",
            "putManifest:4",
        ]);
    });

    test("a crash between part and manifest orphans the part and the offset honestly excludes it", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, mpus, partSizes, ...mock } = { ...makeStore(mockOpts) };
        const { uploadToken } = await store.createUpload({ key: "d.bin", now: NOW });

        // The manifest write AFTER the first part dies (put #1 was creation).
        mockOpts.failManifestPutAt = 2;
        await expect(store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW })).rejects.toThrow(
            /manifest put failed/,
        );

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
        await completeDurable(store, uploadToken, { now: NOW + 2 });
        expect(mock.objects.get("d.bin")!.content).toEqual(bytes(9, 8, 7, 6));
    });

    test("an aborted body parks the partial buffer as a tail, never as a short part", async () => {
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
        expect(result).toEqual({ bytesWritten: 3, interrupted: true });
        const uploadId = [...mpus.keys()][0]!;
        expect(mpus.get(uploadId)!.parts.size).toBe(0);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
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
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), {
                now: NOW,
                maxBytes: 5,
                maxBytesFatal: true,
            }),
        ).rejects.toThrow(/representation bound/);

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("expectedDigests throws a clear error instead of being silently ignored", async () => {
        const { store, objects } = makeStore();
        expect(store.digestOnComplete).toBe(false);
        const { uploadToken } = await store.createUpload({ key: "h.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            completeDurable(store, uploadToken, { now: NOW, expectedDigests: { "sha-256": "x".repeat(43) + "=" } }),
        ).rejects.toThrow(/digestOnComplete/);
        expect(objects.has("h.bin")).toBe(false); // nothing published
    });

    test("appending to a completed upload throws", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "i.bin", now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
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
        await expectGarbageTokensNotFound(store, NOW);
    });

    test("a corrupt manifest answers UploadNotFoundError", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        objects.set(manifestKey, { content: asciiBytes("not json"), etag: "x" });
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(isCorruptUploadState(await store.getUploadState(uploadToken).catch((e: unknown) => e))).toBe(true);
    });

    test("with a releaseBody handle, every refusal releases through it, never a second mechanism", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        for (const [token, offset, signal] of [
            [uploadToken, 4, undefined],
            ["00000000-0000-4000-8000-000000000000", 0, undefined],
            [uploadToken, 0, AbortSignal.abort()],
        ] as const) {
            let released = 0;
            let cancelled = false;
            const body = new ReadableStream<Uint8Array>({
                pull: (controller) => controller.enqueue(bytes(1)),
                cancel: () => {
                    cancelled = true;
                },
            });
            await store
                .appendChunk(token, offset, body, {
                    now: NOW,
                    ...(signal ? { signal } : {}),
                    releaseBody: async () => void released++,
                })
                .catch(() => undefined);
            expect(released).toBeGreaterThan(0);
            expect(cancelled).toBe(false);
        }
    });

    test("an append refused before its body is read cancels the body", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        const refusals: Array<[string, number, RegExp | typeof UploadNotFoundError]> = [
            ["00000000-0000-4000-8000-000000000000", 0, UploadNotFoundError], // no such upload
            [uploadToken, 4, /offset/i], // offset conflict
        ];
        for (const [token, offset, expected] of refusals) {
            let cancelled = false;
            const body = new ReadableStream<Uint8Array>({
                pull: (controller) => controller.enqueue(bytes(1)),
                cancel: () => {
                    cancelled = true;
                },
            });
            const append = store.appendChunk(token, offset, body, { now: NOW });
            if (expected instanceof RegExp) await expect(append).rejects.toThrow(expected);
            else await expect(append).rejects.toBeInstanceOf(expected);
            expect(cancelled).toBe(true);
            expect(body.locked).toBe(false);
        }
        // An invalidated upload refuses the same way.
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<
            string,
            unknown
        >;
        manifest.isInvalidated = true;
        objects.set(manifestKey, { content: asciiBytes(JSON.stringify(manifest)), etag: "inv" });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        });
        await expect(store.appendChunk(uploadToken, 0, body, { now: NOW })).rejects.toThrow(/invalidated/);
        expect(cancelled).toBe(true);
    });

    test("the token is the resource id and discloses nothing about the key", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "tenants/acme/payroll.csv", now: NOW });
        expect(uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(uploadToken).not.toContain("acme");
    });

    test("a token that is not a minted id answers UploadNotFoundError", async () => {
        const { store } = makeStore();
        await store.createUpload({ key: "victim.bin", now: NOW });
        for (const forged of [
            "00000000-0000-4000-8000-000000000000",
            "eyJrZXkiOiJhdHRhY2tlci5iaW4ifQ",
            "../../etc/passwd",
            "",
        ]) {
            await expect(store.getUploadState(forged)).rejects.toBeInstanceOf(UploadNotFoundError);
        }
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
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/manifest put failed/);
        expect(objects.get("k.bin")!.content).toEqual(bytes(1, 2, 3, 4)); // published

        // Retry: the multipart upload is gone, but the completing marker and
        // the object at the key prove the publish landed.
        mockOpts.failManifestPutAt = undefined;
        const replay = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(objects.get("k.bin")!.etag);
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(true);
    });

    /** A completion whose first complete() fails transiently, after the marker landed. */
    async function markerThenTransientFailure(key: string, seed?: Uint8Array) {
        const mock = makeStore();
        if (seed) await mock.bucket.put(key, seed);
        const { uploadToken } = await mock.store.createUpload({ key, now: NOW });
        await mock.store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4, 5, 6), { now: NOW });
        const resume = mock.bucket.resumeMultipartUpload;
        let failed = false;
        mock.bucket.resumeMultipartUpload = (k: string, uploadId: string) => {
            const handle = resume(k, uploadId);
            return {
                ...handle,
                async complete(parts: Array<{ partNumber: number; etag: string }>) {
                    if (failed) return handle.complete(parts);
                    failed = true;
                    throw new Error("mock: complete throttled");
                },
            };
        };
        await expect(completeDurable(mock.store, uploadToken, { now: NOW })).rejects.toThrow(/throttled/);
        return { ...mock, uploadToken };
    }

    test("an object another writer put at the key after the multipart upload was lost is not this upload's", async () => {
        // The key held a different object before this upload (a replace flow).
        const { store, objects, mpus, uploadToken } = await markerThenTransientFailure("r.bin", bytes(9, 9, 9));
        mpus.clear(); // the multipart upload is lost, never completed
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/does not exist/);
        expect(objects.get("r.bin")!.content).toEqual(bytes(9, 9, 9));
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("an object of the same size but another part count is not this upload's", async () => {
        const { store, objects, mpus, uploadToken } = await markerThenTransientFailure("s.bin");
        mpus.clear();
        objects.set("s.bin", { content: bytes(1, 2, 3, 4, 5, 6), etag: '"other-5"' });
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(objects.get("s.bin")!.etag).toBe('"other-5"');
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("a retry after a transient complete() failure still completes", async () => {
        const { store, objects, uploadToken } = await markerThenTransientFailure("t.bin");
        const done = await completeDurable(store, uploadToken, { now: NOW });
        expect(objects.get("t.bin")!.content).toEqual(bytes(1, 2, 3, 4, 5, 6));
        expect(done.etag).toBe(objects.get("t.bin")!.etag);
    });

    test("a lost multipart upload WITHOUT the completing marker fails loudly", async () => {
        const { store, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "l.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        mpus.clear(); // lifecycle GC reaped the multipart upload mid-flight
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/does not exist/);
    });
});

// ─── Sealed-Plan Completion ──────────────────────────────────────────────────

describe("r2UploadStore: completion seals its plan", () => {
    const PUBLICATION = "partial-content-publication";
    const isSeal = (manifest: Record<string, unknown>): boolean =>
        manifest.completing === true && manifest.isComplete !== true;

    /** Runs `act` once, inside the first manifest write that seals the upload. */
    function afterSeal(mockOpts: MockR2UploadOpts, act: () => Promise<void>): void {
        let fired = false;
        mockOpts.onManifestPut = async (manifest) => {
            if (fired || !isSeal(manifest)) return;
            fired = true;
            await act();
        };
    }

    test("an append that starts after the seal is refused and absent from the published object", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "fence.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        let refusal: unknown;
        afterSeal(mockOpts, async () => {
            refusal = await store.appendChunk(uploadToken, 4, bytes(5, 6, 7, 8), { now: NOW }).catch((err) => err);
        });

        await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW });

        expect(refusal).toBeInstanceOf(UploadOffsetConflictError);
        expect(objects.get("fence.bin")!.content).toEqual(bytes(1, 2, 3, 4));
        expect((await store.getUploadState(uploadToken)).offset).toBe(4);
    });

    test("an append that opened before the seal and writes after it is refused", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "inflight.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let opened!: () => void;
        const reading = new Promise<void>((resolve) => (opened = resolve));
        const body = new ReadableStream<Uint8Array>(
            {
                async pull(controller) {
                    opened();
                    await gate;
                    controller.enqueue(bytes(5, 6, 7, 8));
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const append = store.appendChunk(uploadToken, 4, body, { now: NOW }).catch((err: unknown) => err);
        await reading; // the append has read the unsealed manifest and is streaming
        afterSeal(mockOpts, async () => {
            release();
            await append;
        });

        await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW });

        expect(await append).toBeInstanceOf(UploadOffsetConflictError);
        expect(objects.get("inflight.bin")!.content).toEqual(bytes(1, 2, 3, 4));
    });

    test("a key written between the seal and a multipart publish is a destination conflict and survives", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, mpus, bucket } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "race.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4, 5), { now: NOW });
        afterSeal(mockOpts, async () => {
            await bucket.put("race.bin", bytes(7, 7));
        });

        await expect(store.completeUpload(uploadToken, { expectedLength: 5, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(objects.get("race.bin")!.content).toEqual(bytes(7, 7));
        expect(mpus.size).toBe(1); // nothing was published
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("a key written between the seal and a zero-byte publish is a destination conflict and survives", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, bucket } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "race0.bin", length: 0, now: NOW });
        afterSeal(mockOpts, async () => {
            await bucket.put("race0.bin", bytes(7));
        });

        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(objects.get("race0.bin")!.content).toEqual(bytes(7));
    });

    test("the zero-byte put carries the precondition: a key written after the last check still refuses it", async () => {
        const { store, objects, bucket } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "late.bin", length: 0, now: NOW });
        const head = bucket.head;
        let heads = 0;
        bucket.head = async (key: string) => {
            const found = await head(key);
            // The second read of the key is the check right before the publish.
            if (key === "late.bin" && ++heads === 2) await bucket.put(key, bytes(3));
            return found;
        };

        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(objects.get("late.bin")!.content).toEqual(bytes(3));
    });

    test("a zero-byte upload replaces the object the key held when it was sealed", async () => {
        const { store, objects, bucket } = makeStore();
        await bucket.put("replace.bin", bytes(9, 9));
        const { uploadToken } = await store.createUpload({ key: "replace.bin", length: 0, now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 0, now: NOW });
        expect(objects.get("replace.bin")!.content.length).toBe(0);
        expect(objects.get("replace.bin")!.customMetadata?.[PUBLICATION]).toBeDefined();
    });

    for (const foreignEtag of ['"foreign-1"', '"foreign"']) {
        test(`a same-shape foreign object (etag ${foreignEtag}) is not adopted by a completion retry`, async () => {
            const mockOpts: MockR2UploadOpts = {};
            const { store, objects, resetManifestPutCount } = makeStore(mockOpts);
            const { uploadToken } = await store.createUpload({ key: "shape.bin", now: NOW });
            await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
            // Manifest write #1 seals, #2 records the publish and is lost.
            resetManifestPutCount();
            mockOpts.failManifestPutAt = 2;
            await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toThrow(
                /manifest put failed/,
            );
            mockOpts.failManifestPutAt = undefined;
            // Same size, same single-part shape, carrying no publication id.
            objects.set("shape.bin", { content: bytes(1, 2, 3, 4), etag: foreignEtag });

            await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toBeInstanceOf(
                UploadDestinationConflictError,
            );
            expect(objects.get("shape.bin")!.etag).toBe(foreignEtag);
            expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
        });
    }

    test("a zero-byte completion retried after a lost record does not overwrite a newer object", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, bucket, resetManifestPutCount } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "newer.bin", length: 0, now: NOW });
        resetManifestPutCount();
        mockOpts.failManifestPutAt = 2;
        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toThrow(
            /manifest put failed/,
        );
        mockOpts.failManifestPutAt = undefined;
        await bucket.put("newer.bin", bytes(4, 2));

        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(objects.get("newer.bin")!.content).toEqual(bytes(4, 2));
    });

    test("a length mismatch at snapshot lifts the seal and the upload resumes", async () => {
        const { store, objects, bucket } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "lift.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4, 5, 6), { now: NOW });
        const resume = bucket.resumeMultipartUpload;
        let failed = false;
        bucket.resumeMultipartUpload = (key: string, uploadId: string) => {
            const handle = resume(key, uploadId);
            return {
                ...handle,
                async complete(parts: Array<{ partNumber: number; etag: string }>) {
                    if (failed) return handle.complete(parts);
                    failed = true;
                    throw new Error("mock: complete throttled");
                },
            };
        };
        await expect(store.completeUpload(uploadToken, { expectedLength: 6, now: NOW })).rejects.toThrow(/throttled/);
        // Sealed at 6: appends refuse.
        await expect(store.appendChunk(uploadToken, 6, bytes(7, 8), { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );

        const conflict = await store.completeUpload(uploadToken, { expectedLength: 7, now: NOW }).catch((err) => err);
        expect(conflict).toBeInstanceOf(UploadOffsetConflictError);
        expect((conflict as UploadOffsetConflictError).durableOffset).toBe(6);
        expect(objects.has("lift.bin")).toBe(false);

        // The seal is lifted: the upload takes appends again and completes whole.
        await store.appendChunk(uploadToken, 6, bytes(7, 8), { now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 8, now: NOW });
        expect(objects.get("lift.bin")!.content).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    });

    test("a completion at a length other than the durable one publishes nothing and seals nothing", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "short.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });

        const conflict = await store.completeUpload(uploadToken, { expectedLength: 3, now: NOW }).catch((err) => err);
        expect(conflict).toBeInstanceOf(UploadOffsetConflictError);
        expect((conflict as UploadOffsetConflictError).durableOffset).toBe(4);
        expect(objects.has("short.bin")).toBe(false);
        await store.appendChunk(uploadToken, 4, bytes(5), { now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 5, now: NOW });
        expect(objects.get("short.bin")!.content).toEqual(bytes(1, 2, 3, 4, 5));
    });

    test("the published object carries a random publication id, never the upload token", async () => {
        const { store, objects } = makeStore();
        const token = await publishedUpload(store, "id.bin", bytes(1, 2, 3, 4, 5), NOW);
        const empty = await publishedUpload(store, "id0.bin", bytes(), NOW);
        for (const [key, uploadToken] of [
            ["id.bin", token],
            ["id0.bin", empty],
        ] as const) {
            const id = objects.get(key)!.customMetadata?.[PUBLICATION];
            expect(id).toMatch(/^[0-9a-f-]{36}$/);
            expect(id).not.toBe(uploadToken);
        }
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
        const uploadToken = await publishedUpload(store, "n.bin", bytes(1, 2), NOW);
        await store.abortUpload(uploadToken);
        expect(objects.get("n.bin")!.content).toEqual(bytes(1, 2));
    });

    test("sweepExpired paginates, reaps idle uploads (manifest + multipart), keeps active ones", async () => {
        // One key per page: tokens are random, so a wider page could hold both
        // stale manifests and pass with the pagination never followed.
        const { store, objects, mpus } = makeStore({ pageSize: 1 });
        const staleA = await store.createUpload({ key: "stale-a.bin", now: NOW - 100_000 });
        await store.appendChunk(staleA.uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW - 90_000 });
        const staleB = await store.createUpload({ key: "stale-b.bin", now: NOW - 80_000 });
        const active = await store.createUpload({ key: "active.bin", now: NOW - 100_000 });
        await store.appendChunk(active.uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW - 1_000 });

        const { removed } = await store.sweepExpired!({ idleSinceMs: NOW - 10_000 });
        expect(removed).toBe(2);
        await expect(store.getUploadState(staleA.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.getUploadState(staleB.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(4);
        expect(mpus.size).toBe(1); // only the active upload's multipart survives
        expect([...objects.keys()].filter((key) => key.endsWith(".manifest")).length).toBe(1);
    });

    test("a manifest that cannot be reclaimed is counted, never allowed to end the scan", async () => {
        // A denied delete on one manifest must not cost the resources behind
        // it in the listing: a scheduled sweep would then reclaim nothing for
        // as long as that one resource stayed unreclaimable, and would report
        // success by not throwing, which is a retention control that has
        // stopped working while still looking scheduled.
        const failDeleteFor = new Set<string>();
        const { store, objects, mpus } = makeStore({ failDeleteFor });
        await store.createUpload({ key: "first.bin", now: NOW - 100_000 });
        await store.createUpload({ key: "second.bin", now: NOW - 100_000 });
        // The sweep walks the listing in key order, so the first key it
        // reaches is the one whose failure has resources behind it.
        const manifestKeys = [...objects.keys()].filter((key) => key.endsWith(".manifest")).toSorted();
        expect(manifestKeys).toHaveLength(2);
        failDeleteFor.add(manifestKeys[0]!);

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 1 });
        expect([...objects.keys()]).not.toContain(manifestKeys[1]!);
        expect(mpus.size).toBe(0); // both multiparts aborted: the scan ran on
        // What could not be reclaimed is still listed, so the next pass
        // retries it rather than losing track of its bytes.
        expect([...objects.keys()]).toContain(manifestKeys[0]!);
        failDeleteFor.clear();
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
    });

    test("a manifest reclaimed from under the sweep is not counted as removed", async () => {
        const opts: MockR2UploadOpts = {};
        const { store, objects } = makeStore(opts);
        await store.createUpload({ key: "raced.bin", now: NOW - 100_000 });
        const manifest = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        // Another sweeper got there between the listing and the read.
        opts.afterList = () => {
            objects.delete(manifest);
        };
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
    });

    test("an aborted sweep asks the bucket for no listing at all", async () => {
        let lists = 0;
        const { store } = makeStore({ afterList: () => lists++ });
        await store.createUpload({ key: "idle.bin", now: NOW - 100_000 });
        const sweep = store.sweepExpired!({ idleSinceMs: NOW }, { signal: AbortSignal.abort(new Error("shutdown")) });
        await expect(sweep).rejects.toThrow("shutdown");
        expect(lists).toBe(0);
    });
});

// ─── Manifest Shape Gate ─────────────────────────────────────────────────────

function toBase64Url(text: string): string {
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("r2UploadStore: manifest shape gate", () => {
    /** Create a real upload with one part, then corrupt one manifest field. */
    async function tamperedStore(mutate: (manifest: Record<string, unknown>) => unknown) {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({
            key: "t.bin",
            length: 8,
            metadata: { a: "b" },
            now: NOW,
        });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<
            string,
            unknown
        >;
        const replacement = mutate(manifest);
        objects.set(manifestKey, {
            content: new TextEncoder().encode(JSON.stringify(replacement === undefined ? manifest : replacement)),
            etag: "tampered",
        });
        return { store, uploadToken };
    }

    const corruptions: Array<[string, (manifest: Record<string, unknown>) => unknown]> = [
        [
            "empty key",
            (m) => {
                m.key = "";
            },
        ],
        [
            "empty uploadId",
            (m) => {
                m.uploadId = "";
            },
        ],
        [
            "missing uploadId",
            (m) => {
                delete m.uploadId;
            },
        ],
        [
            "zero partSize",
            (m) => {
                m.partSize = 0;
            },
        ],
        [
            "string partSize",
            (m) => {
                m.partSize = "4";
            },
        ],
        [
            "negative length",
            (m) => {
                m.length = -1;
            },
        ],
        [
            "missing createdAt",
            (m) => {
                delete m.createdAt;
            },
        ],
        [
            "fractional lastAppendAt",
            (m) => {
                m.lastAppendAt = 1.5;
            },
        ],
        [
            "string isComplete",
            (m) => {
                m.isComplete = "no";
            },
        ],
        [
            "numeric isInvalidated",
            (m) => {
                m.isInvalidated = 0;
            },
        ],
        [
            "string completing",
            (m) => {
                m.completing = "yes";
            },
        ],
        [
            "numeric etag",
            (m) => {
                m.etag = 9;
            },
        ],
        [
            "non-string metadata value",
            (m) => {
                m.metadata = { a: 3 };
            },
        ],
        [
            "non-array parts",
            (m) => {
                m.parts = "x";
            },
        ],
        [
            "part number zero",
            (m) => {
                m.parts = [{ partNumber: 0, etag: "e", size: 1 }];
            },
        ],
        [
            "numeric part etag",
            (m) => {
                m.parts = [{ partNumber: 1, etag: 4, size: 1 }];
            },
        ],
        [
            "negative part size",
            (m) => {
                m.parts = [{ partNumber: 1, etag: "e", size: -2 }];
            },
        ],
        [
            "null part entry",
            (m) => {
                m.parts = [null];
            },
        ],
        ["array manifest", () => []],
        ["string manifest", () => "not an object"],
    ];

    for (const [label, mutate] of corruptions) {
        test(`corrupt manifest (${label}) answers UploadNotFoundError`, async () => {
            const { store, uploadToken } = await tamperedStore(mutate);
            // Not-found to the client, damaged storage to the operator.
            expect(isCorruptUploadState(await store.getUploadState(uploadToken).catch((e: unknown) => e))).toBe(true);
            await expect(store.appendChunk(uploadToken, 4, bytes(1), { now: NOW })).rejects.toBeInstanceOf(
                UploadNotFoundError,
            );
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
        const result = await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), {
            now: NOW,
            maxBytes: 4,
            maxBytesFatal: true,
        });
        expect(result.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(false);
    });

    test("an append past R2's part limit is a non-fatal bound and uploads nothing", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "cap.bin", now: NOW });
        // The manifest already records a part at the last permitted number.
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<
            string,
            unknown
        >;
        manifest.parts = [{ partNumber: 10_000, etag: "e", size: 4 }];
        objects.set(manifestKey, { content: new TextEncoder().encode(JSON.stringify(manifest)), etag: "t" });

        await expect(store.appendChunk(uploadToken, 4, bytes(1, 2, 3, 4), { now: NOW })).rejects.toMatchObject({
            name: "UploadAppendBoundError",
            durableOffset: 4,
        });
        expect(mpus.get([...mpus.keys()][0]!)!.parts.size).toBe(0);
    });

    test("a normal completion writes exactly two manifest records: commit marker, then outcome", async () => {
        const journal: string[] = [];
        const { store } = makeStore({ journal });
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        journal.length = 0;
        await completeDurable(store, uploadToken, { now: NOW });
        expect(journal.filter((entry) => entry.startsWith("putManifest")).length).toBe(2);
    });

    test("a lost multipart upload WITH the completing marker but NO object at the key still fails", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "gone.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        // Marker set (a completion began), but the multipart upload vanished
        // and nothing was ever published at the key.
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey)!.content)) as Record<
            string,
            unknown
        >;
        manifest.completing = true;
        objects.set(manifestKey, { content: new TextEncoder().encode(JSON.stringify(manifest)), etag: "t" });
        mpus.clear();

        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/does not exist/);
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(false);
    });

    test("zero-byte completion still publishes when the multipart upload is already gone", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty2.bin", now: NOW });
        mpus.clear(); // lifecycle GC took the multipart upload; nothing was staged anyway
        const completed = await completeDurable(store, uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty2.bin")!.content.length).toBe(0);
    });

    test("abort with an id that names no resource discards nothing", async () => {
        const { store, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });

        await store.abortUpload("00000000-0000-4000-8000-000000000000");
        await store.abortUpload("not-a-token");

        expect(mpus.size).toBe(1); // the victim's multipart upload survives
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("sweep keeps an upload idle EXACTLY at the cutoff and ignores foreign objects", async () => {
        const { store, objects } = makeStore();
        const cutoff = NOW - 10_000;
        const boundary = await store.createUpload({ key: "boundary.bin", now: cutoff });
        // A foreign object under the prefix must be left alone, not decoded or deleted.
        objects.set(".partial-content-uploads/readme.txt", { content: bytes(1), etag: "f" });

        const { removed } = await store.sweepExpired!({ idleSinceMs: cutoff });
        expect(removed).toBe(0);
        expect(objects.has(".partial-content-uploads/readme.txt")).toBe(true);
        expect((await store.getUploadState(boundary.uploadToken)).createdAt).toBe(cutoff);
    });

    test("sweep reaps corrupt bookkeeping regardless of age", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "corrupt.bin", now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"))!;
        objects.set(manifestKey, { content: asciiBytes("garbage"), etag: "t" });

        const { removed } = await store.sweepExpired!({ idleSinceMs: 0 }); // cutoff before every real upload
        expect(removed).toBe(1);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── The manifest write is pinned to the version the writer holds ───────────

describe("r2UploadStore: stale manifest writers lose", () => {
    /**
     * The manifest is the offset ledger, so a holder whose lock was stolen
     * while its body streamed must not write its parts array over the winner's.
     * Every manifest write carries the ETag the writer last read or wrote; the
     * binding refuses a mismatch, and the loser is answered with the winner's
     * durable offset, the same way every stale writer is answered.
     */

    test("a holder that read before the winner's append is refused with the winner's offset", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "contended.bin", now: NOW });

        // The loser's appendChunk reads the manifest (offset 0, version v1),
        // then its body stalls while the winner lands a part and rewrites the
        // manifest (version v2). The loser's own part upload is the byte-level
        // residual the store contract documents; its manifest write is what
        // this pins: it carries v1, loses, and reports the winner's offset.
        const loser = store.appendChunk(
            uploadToken,
            0,
            interleavedStream(
                () => store.appendChunk(uploadToken, 0, asciiBytes("WINN"), { now: NOW + 1 }).then(() => undefined),
                asciiBytes("lose"),
            ),
            { now: NOW + 2 },
        );

        await expect(loser).rejects.toBeInstanceOf(UploadOffsetConflictError);
        await expect(loser).rejects.toMatchObject({ durableOffset: 4 });
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
    });

    test("a manifest deleted under a writer is reported as not found, not as a conflict", async () => {
        // The manifest alone goes (a sweep that reaped the bookkeeping), so the
        // writer's part still lands and its manifest write is the first thing
        // to notice there is no resource left to write to.
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "swept.bin", now: NOW });
        const manifestKey = [...objects.keys()].find((key) => key.endsWith(".manifest"));
        if (manifestKey === undefined) throw new Error("no manifest written");

        const loser = store.appendChunk(
            uploadToken,
            0,
            interleavedStream(async () => {
                objects.delete(manifestKey);
            }, asciiBytes("lose")),
            { now: NOW + 2 },
        );

        await expect(loser).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("an uncontended append chains its writes on the version each one returns", async () => {
        // Two parts in one append are two manifest writes; the second is pinned
        // to the first's result, not to the version the append read, or it
        // would lose to its own earlier write.
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "chain.bin", now: NOW });

        const result = await store.appendChunk(uploadToken, 0, asciiBytes("01234567"), { now: NOW + 1 });

        expect(result.bytesWritten).toBe(8);
        expect((await store.getUploadState(uploadToken)).offset).toBe(8);
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

// ─── The bookkeeping namespace is not a publish destination ─────────────────

describe("r2UploadStore: reserved upload prefix", () => {
    test("a publish key inside the bookkeeping prefix is refused at creation", async () => {
        const { store } = makeStore();
        // A key() that derives from user input would otherwise let a caller
        // name another upload's manifest as its own destination and overwrite
        // it at completion. Tokens are the only handles into that namespace.
        await expect(
            store.createUpload({ key: ".partial-content-uploads/other.manifest", now: 0 }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(store.createUpload({ key: ".partial-content-uploads", now: 0 })).rejects.toBeInstanceOf(TypeError);
    });

    test("a key that merely starts with the same letters is fine", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: ".partial-content-uploadsomething", now: 0 });
        expect(uploadToken).toBeTruthy();
    });
});

// ─── The contract holds for a part-based backend too ────────────────────────

describe("r2UploadStore: write-store conformance", () => {
    test("passes every obligation, part-size rule included", async () => {
        // One bucket across both instances, so the restart obligations are
        // exercised rather than skipped: a part-based store derives its offset
        // from a durable ledger, which is exactly what must survive.
        const mock = mockUploadBucket();
        const report = await checkResumableWriteStore(
            () => r2UploadStore({ bucket: mock.bucket, partSize: PART_SIZE }),
            {
                key: (n) => `conformance/${n}.bin`,
                // The publication obligations are about the object, not the
                // upload resource: what is at the key mid-upload, what a
                // refused append left there, and what survives a cancel. This
                // backend cannot answer any of them from its own bookkeeping.
                readObject: (key) => mock.objects.get(key)?.content,
            },
        );

        const failed = report.checks.filter((c) => !c.ok && !c.skipped);
        expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
        // The one obligation this backend cannot be asked about: R2 multipart
        // exposes no whole-object SHA-256, so there is no verification step to
        // fail. A skip is reported rather than passed, which is the point.
        expect(report.checks.filter((c) => c.skipped).map((c) => c.name)).toEqual([
            "failed-completion-publishes-nothing",
        ]);
        expect(report.ok).toBe(true);
    });
});

// ─── Parked Tail ─────────────────────────────────────────────────────────────

describe("r2UploadStore: an append not aligned to the part size parks its remainder", () => {
    /**
     * R2 requires every non-final part to be the same size, so a remainder
     * below the part size cannot be a part until it is the last one. It is
     * parked as a tail object the manifest names, and the next append or the
     * completion carries it into a part.
     */

    test("6 then 6 bytes at part size 4 complete with all 12 bytes in order", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "u.bin", now: NOW });
        const first = await store.appendChunk(uploadToken, 0, asciiBytes("abcdef"), { now: NOW });
        expect(first.bytesWritten).toBe(6);
        expect((await store.getUploadState(uploadToken)).offset).toBe(6);
        const second = await store.appendChunk(uploadToken, 6, asciiBytes("ghijkl"), { now: NOW + 1 });
        expect(second.bytesWritten).toBe(6);

        await completeDurable(store, uploadToken, { now: NOW + 2 });

        expect(new TextDecoder().decode(objects.get("u.bin")!.content)).toBe("abcdefghijkl");
        expect(tailKeys(objects)).toEqual([]);
    });

    test("a remainder still parked at completion becomes the short final part", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "v.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abcde"), { now: NOW });
        await store.appendChunk(uploadToken, 5, asciiBytes("fg"), { now: NOW });

        await completeDurable(store, uploadToken, { now: NOW });

        expect(new TextDecoder().decode(objects.get("v.bin")!.content)).toBe("abcdefg");
        expect(tailKeys(objects)).toEqual([]);
    });

    test("a part upload that fails after a tail is parked never lowers the offset", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "w.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abcdef"), { now: NOW });

        // The second part carries the parked tail; it fails on the backend.
        mockOpts.failUploadPartAt = 2;
        await expect(store.appendChunk(uploadToken, 6, asciiBytes("gh"), { now: NOW })).rejects.toThrow(
            /part upload failed/,
        );
        expect((await store.getUploadState(uploadToken)).offset).toBe(6);

        const retried = await store.appendChunk(uploadToken, 6, asciiBytes("gh"), { now: NOW });
        expect(retried.bytesWritten).toBe(2);
        await completeDurable(store, uploadToken, { now: NOW });
        expect(new TextDecoder().decode(objects.get("w.bin")!.content)).toBe("abcdefgh");
    });

    test("a zero-byte append leaves the parked tail untouched", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "x.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        const versions = () => tailKeys(objects).map((key) => [key, objects.get(key)!.etag]);
        const before = versions();
        expect(before).toHaveLength(1);

        const result = await store.appendChunk(uploadToken, 3, new Uint8Array(0), { now: NOW + 1 });

        expect(result.bytesWritten).toBe(0);
        expect(versions()).toEqual(before);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(3);
        expect(state.lastAppendAt).toBe(NOW + 1);
    });

    test("a holder whose lock was stolen cannot replace the tail the winner parked", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "y.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });

        const loser = store.appendChunk(
            uploadToken,
            2,
            interleavedStream(
                () => store.appendChunk(uploadToken, 2, asciiBytes("W"), { now: NOW + 1 }).then(() => undefined),
                asciiBytes("l"),
            ),
            { now: NOW + 2 },
        );

        await expect(loser).rejects.toMatchObject({ durableOffset: 3 });
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
        // The loser's own tail object does not outlive its refusal.
        expect(tailKeys(objects)).toHaveLength(1);
        await completeDurable(store, uploadToken, { now: NOW + 3 });
        expect(new TextDecoder().decode(objects.get("y.bin")!.content)).toBe("abW");
    });

    test("an orphan tail is reclaimed by abort", async () => {
        const failDeleteFor = new Set<string>();
        const { store, objects } = makeStore({ failDeleteFor });
        const { uploadToken } = await store.createUpload({ key: "z.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });
        // The replaced tail cannot be removed after the next park, so it is
        // left behind, named by nothing.
        const [first] = tailKeys(objects);
        failDeleteFor.add(first!);
        await store.appendChunk(uploadToken, 2, asciiBytes("c"), { now: NOW });
        expect(tailKeys(objects)).toHaveLength(2);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
        failDeleteFor.clear();

        await store.abortUpload(uploadToken);

        expect([...objects.keys()]).toEqual([]);
    });

    test("an orphan tail whose manifest is gone is reclaimed by the sweep", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "o.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });
        // The bookkeeping went and its tail did not (a discard that died midway).
        for (const key of objects.keys()) if (key.endsWith(".manifest")) objects.delete(key);
        expect(tailKeys(objects)).toHaveLength(1);

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });

        expect(tailKeys(objects)).toEqual([]);
    });

    test("a live upload's tail is never swept as an orphan", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "p.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });

        expect(tailKeys(objects)).toHaveLength(1);
        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
    });

    test("passes the write-store conformance harness with a split that is not aligned", async () => {
        // The harness splits its round-trip payload at 16 bytes; part size 5
        // leaves a remainder at every split.
        const mock = mockUploadBucket();
        const report = await checkResumableWriteStore(() => r2UploadStore({ bucket: mock.bucket, partSize: 5 }), {
            key: (n) => `conformance/${n}.bin`,
            readObject: (key) => mock.objects.get(key)?.content,
        });

        const failed = report.checks.filter((c) => !c.ok && !c.skipped);
        expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
        expect(report.ok).toBe(true);
    });
});

// ─── Discard Failures Surface ────────────────────────────────────────────────

describe("r2UploadStore: a multipart abort that fails is never reported as reclaimed", () => {
    test("abort rejects and keeps the manifest when the multipart abort fails", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, mpus } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        mockOpts.failAbortWith = new Error("mock: throttled");

        await expect(store.abortUpload(uploadToken)).rejects.toThrow(/throttled/);

        expect(mpus.size).toBe(1);
        expect([...objects.keys()].filter((key) => key.endsWith(".manifest"))).toHaveLength(1);
        // The manifest survived, so a retry can still find and reclaim the parts.
        mockOpts.failAbortWith = undefined;
        await store.abortUpload(uploadToken);
        expect(mpus.size).toBe(0);
        expect([...objects.keys()]).toEqual([]);
    });

    test("abort of an upload whose multipart upload is already gone still removes the manifest", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "b.bin", now: NOW });
        mpus.clear();

        await store.abortUpload(uploadToken);

        expect([...objects.keys()]).toEqual([]);
    });

    test("the sweep counts a failed multipart abort as failed and keeps the manifest", async () => {
        const mockOpts: MockR2UploadOpts = {};
        const { store, objects, mpus } = makeStore(mockOpts);
        await store.createUpload({ key: "c.bin", now: NOW - 100_000 });
        mockOpts.failAbortWith = new Error("mock: throttled");

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 1 });

        expect(mpus.size).toBe(1);
        expect([...objects.keys()].filter((key) => key.endsWith(".manifest"))).toHaveLength(1);
    });

    test("a creation whose manifest write fails aborts its multipart upload and rethrows", async () => {
        const { store, mpus } = makeStore({ failManifestPutAt: 1 });

        await expect(store.createUpload({ key: "d.bin", now: NOW })).rejects.toThrow(/manifest put failed/);

        expect(mpus.size).toBe(0);
    });
});

// ─── R2's 10,000-Part Ceiling ───────────────────────────────────────────────

describe("r2UploadStore: R2's 10,000-part ceiling", () => {
    /**
     * R2 assembles at most 10,000 parts, all but the last of one size. A
     * known length sizes the upload's parts so the whole representation fits;
     * a deferred length cannot, so an append that would need part 10,001 is
     * refused as a non-fatal append bound and the upload stays completable.
     */
    const patterned = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);
    const manifestOf = (objects: Map<string, { content: Uint8Array }>) => {
        const key = [...objects.keys()].find((k) => k.endsWith(".manifest"))!;
        return { key, manifest: JSON.parse(new TextDecoder().decode(objects.get(key)!.content)) };
    };

    test("a length known at creation raises the persisted part size so 10,000 parts hold it", async () => {
        const { store, objects, mpus, partSizes } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "k.bin", length: 50_000, now: NOW });

        expect(manifestOf(objects).manifest.partSize).toBe(5);
        await store.appendChunk(uploadToken, 0, patterned(12), { now: NOW });
        expect(partSizes([...mpus.keys()][0]!)).toEqual([5, 5]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(12);
    });

    test("a length that already fits keeps the configured part size", async () => {
        const { store, objects } = makeStore();
        await store.createUpload({ key: "k.bin", length: 40_000, now: NOW });
        expect(manifestOf(objects).manifest.partSize).toBe(PART_SIZE);
    });

    test("a length no 10,000 parts of R2's largest part size can hold is refused at creation", async () => {
        const { store, mpus } = makeStore();
        const tooLong = 10_000 * 5 * 1024 ** 3 + 1;

        await expect(store.createUpload({ key: "k.bin", length: tooLong, now: NOW })).rejects.toBeInstanceOf(
            RangeError,
        );
        expect(mpus.size).toBe(0);
    });

    test("a deferred-length append that would need part 10,001 is a non-fatal bound", async () => {
        const { store, objects, mpus } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        // 9,999 full parts already committed, seeded straight into the backend.
        const uploadId = [...mpus.keys()][0]!;
        const { key: manifestKey, manifest } = manifestOf(objects);
        for (let n = 1; n < 10_000; n++) {
            mpus.get(uploadId)!.parts.set(n, { etag: `"seed${n}"`, bytes: patterned(4, (n - 1) * 4) });
            manifest.parts.push({ partNumber: n, etag: `"seed${n}"`, size: 4 });
        }
        objects.set(manifestKey, { content: asciiBytes(JSON.stringify(manifest)), etag: '"seeded"' });
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(patterned(4, 39_996));
                controller.enqueue(patterned(2, 40_000));
                controller.close();
            },
        });

        const err = await store.appendChunk(uploadToken, 39_996, body, { now: NOW }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UploadAppendBoundError);
        expect((err as UploadAppendBoundError).durableOffset).toBe(40_000);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(40_000);
        expect(state.status).not.toBe("invalidated");
        await completeDurable(store, uploadToken, { now: NOW });
        expect(objects.get("k.bin")?.content).toEqual(patterned(40_000));
    });
});
