import { describe, test, expect } from "bun:test";
import { azureUploadStore, UploadNotFoundError, UploadOffsetConflictError } from "../azure";

// ─── Mock Azure Container (block-blob upload surface) ───────────────────────

const NOW = 1_800_000_000_000;

interface CommittedBlob {
    content: Uint8Array;
    blocks: Array<{ name: string; size: number }>;
    metadata?: Record<string, string>;
    etag: string;
}

interface MockAzureUploadOpts {
    /** Throw on the next setMetadata call (crash-between-commit-and-bookkeeping). */
    failNextSetMetadata?: boolean;
    /** Record staged block ids in staging order. */
    stagedIds?: string[];
}

function restError(statusCode: number): Error {
    const err = new Error(`azure rest error ${statusCode}`);
    err.name = "RestError";
    (err as unknown as { statusCode: number }).statusCode = statusCode;
    return err;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
}

/**
 * In-memory model of the container's block-blob semantics: staged blocks are
 * invisible until commit, commit drops every unlisted staged block, deleting
 * a blob discards its staged block list, and getBlockList 404s when the blob
 * exists in no form at all.
 */
function mockUploadContainer(opts: MockAzureUploadOpts = {}) {
    const committed = new Map<string, CommittedBlob>();
    const staged = new Map<string, Map<string, Uint8Array>>();
    let etagCounter = 0;

    const container = {
        getBlockBlobClient(blobName: string) {
            return {
                async stageBlock(blockId: string, body: Uint8Array, contentLength: number) {
                    expect(contentLength).toBe(body.length);
                    let blocks = staged.get(blobName);
                    if (!blocks) {
                        blocks = new Map();
                        staged.set(blobName, blocks);
                    }
                    blocks.set(blockId, body.slice());
                    opts.stagedIds?.push(blockId);
                    return {};
                },
                async commitBlockList(blockIds: string[]) {
                    const blocks = staged.get(blobName) ?? new Map<string, Uint8Array>();
                    const existing = committed.get(blobName);
                    const pieces: Uint8Array[] = [];
                    const committedBlocks: Array<{ name: string; size: number }> = [];
                    for (const id of blockIds) {
                        const stagedBlock = blocks.get(id);
                        const committedBlock = existing?.blocks.find((b) => b.name === id);
                        if (stagedBlock) {
                            pieces.push(stagedBlock);
                            committedBlocks.push({ name: id, size: stagedBlock.length });
                        } else if (committedBlock) {
                            throw new Error("mock: re-committing committed blocks is not modeled");
                        } else {
                            throw restError(400);
                        }
                    }
                    // Commit drops EVERY staged block, listed or not.
                    staged.delete(blobName);
                    etagCounter += 1;
                    const etag = `"azure-etag-${etagCounter}"`;
                    committed.set(blobName, { content: concat(pieces), blocks: committedBlocks, etag });
                    return { etag };
                },
                async getBlockList(_type: "all") {
                    const blob = committed.get(blobName);
                    const blocks = staged.get(blobName);
                    if (!blob && (!blocks || blocks.size === 0)) throw restError(404);
                    return {
                        committedBlocks: blob?.blocks.map((b) => ({ ...b })) ?? [],
                        // Azure returns block lists alphabetically, not in
                        // staging order; reverse to prove the adapter sorts.
                        uncommittedBlocks: [...(blocks ?? new Map()).entries()]
                            .map(([name, bytes]) => ({ name, size: (bytes as Uint8Array).length }))
                            .toReversed(),
                    };
                },
                async upload(_body: string, contentLength: number, uploadOpts?: { metadata?: Record<string, string> }) {
                    etagCounter += 1;
                    committed.set(blobName, {
                        content: new Uint8Array(contentLength),
                        blocks: [],
                        metadata: uploadOpts?.metadata,
                        etag: `"azure-etag-${etagCounter}"`,
                    });
                    return {};
                },
                async getProperties() {
                    const blob = committed.get(blobName);
                    if (!blob) throw restError(404);
                    return { metadata: blob.metadata, etag: blob.etag, contentLength: blob.content.length };
                },
                async setMetadata(metadata: Record<string, string>) {
                    if (opts.failNextSetMetadata) {
                        opts.failNextSetMetadata = false;
                        throw restError(500);
                    }
                    const blob = committed.get(blobName);
                    if (!blob) throw restError(404);
                    blob.metadata = metadata;
                    return {};
                },
                async deleteIfExists() {
                    committed.delete(blobName);
                    staged.delete(blobName); // Delete Blob discards the staged block list
                    return {};
                },
            };
        },
        async *listBlobsFlat(listOpts?: { prefix?: string; includeMetadata?: boolean }) {
            for (const [name, blob] of committed) {
                if (listOpts?.prefix && !name.startsWith(listOpts.prefix)) continue;
                yield { name, metadata: blob.metadata };
            }
        },
    };

    return {
        container,
        committed,
        staged,
        /** Simulate Azure's 7-day GC / a foreign overwrite wiping staged state. */
        wipeStaged(blobName: string) { staged.delete(blobName); },
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

// ─── Round Trip ──────────────────────────────────────────────────────────────

describe("azureUploadStore: round trip", () => {
    test("create -> state -> append -> append -> complete publishes the assembled blob", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });

        const { uploadToken } = await store.createUpload({
            key: "docs/report.pdf",
            length: 10,
            metadata: { filename: "report.pdf" },
            now: NOW,
        });

        const fresh = await store.getUploadState(uploadToken);
        expect(fresh.offset).toBe(0); // sentinel staged but NEVER counted
        expect(fresh.length).toBe(10);
        expect(fresh.isComplete).toBe(false);
        expect(fresh.isInvalidated).toBe(false);
        expect(fresh.createdAt).toBe(NOW);
        expect(fresh.metadata).toEqual({ filename: "report.pdf" });

        const first = await store.appendChunk(uploadToken, 0, asciiBytes("01234"), { now: NOW + 1 });
        expect(first.bytesWritten).toBe(5);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(5);
        expect(mid.lastAppendAt).toBe(NOW + 1);

        const second = await store.appendChunk(uploadToken, 5, streamOf(asciiBytes("567"), asciiBytes("89")), { now: NOW + 2 });
        expect(second.bytesWritten).toBe(5);

        const completed = await store.completeUpload(uploadToken, { now: NOW + 3 });
        expect(completed.etag).toBeDefined();
        expect(new TextDecoder().decode(mock.committed.get("docs/report.pdf")!.content)).toBe("0123456789");

        const final = await store.getUploadState(uploadToken);
        expect(final.isComplete).toBe(true);
        expect(final.offset).toBe(10);
    });

    test("completion is idempotent and replays the recorded etag without recommitting", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await store.completeUpload(uploadToken, { now: NOW });
        const replay = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty blob (sentinel never committed)", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });

        const completed = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(completed.etag).toBeDefined();
        const blob = mock.committed.get("empty.bin")!;
        expect(blob.content.length).toBe(0);
        expect(blob.blocks).toEqual([]); // no data blocks AND no sentinel in the committed list

        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(true);
        expect(state.offset).toBe(0);
    });
});

// ─── Block Ids + Offset Derivation ──────────────────────────────────────────

describe("azureUploadStore: block ids and offset derivation", () => {
    test("data block ids are same-length base64 embedding a zero-padded sequence", async () => {
        const stagedIds: string[] = [];
        const mock = mockUploadContainer({ stagedIds });
        // blockSize is a flush THRESHOLD: each stream chunk crossing it stages
        // one block, so two 5-byte chunks over threshold 4 become two blocks.
        const store = azureUploadStore({ containerClient: mock.container, blockSize: 4 });
        const { uploadToken } = await store.createUpload({ key: "multi.bin", now: NOW });
        await store.appendChunk(
            uploadToken,
            0,
            streamOf(asciiBytes("01234"), asciiBytes("56789")),
            { now: NOW },
        );

        // First staged id is the creation sentinel; the rest are data blocks.
        const [sentinel, ...dataIds] = stagedIds;
        expect(atob(sentinel!)).toBe("pcblk-anchor");
        expect(dataIds.map((id) => atob(id))).toEqual(["pcblk-000000", "pcblk-000001"]);
        const lengths = new Set(stagedIds.map((id) => id.length));
        expect(lengths.size).toBe(1); // Azure requires equal-length ids

        expect(await store.getUploadState(uploadToken).then((s) => s.offset)).toBe(10);
    });

    test("offset sums only OUR uncommitted data blocks: sentinel and foreign blocks excluded", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "shared.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });

        // A foreign writer stages an unrelated block on the same blob.
        mock.staged.get("shared.bin")!.set(btoa("someone-else!"), bytes(9, 9, 9, 9, 9));

        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(4);
    });

    test("append resumes numbering after existing blocks and commits in sequence order", async () => {
        const stagedIds: string[] = [];
        const mock = mockUploadContainer({ stagedIds });
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "seq.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });
        await store.appendChunk(uploadToken, 2, asciiBytes("cd"), { now: NOW });
        await store.appendChunk(uploadToken, 4, asciiBytes("ef"), { now: NOW });
        await store.completeUpload(uploadToken, { now: NOW });
        // Mock returns block lists reversed, so correct assembly proves sorting.
        expect(new TextDecoder().decode(mock.committed.get("seq.bin")!.content)).toBe("abcdef");
        expect(mock.committed.get("seq.bin")!.blocks.map((b) => atob(b.name))).toEqual([
            "pcblk-000000", "pcblk-000001", "pcblk-000002",
        ]);
    });
});

// ─── Guards ──────────────────────────────────────────────────────────────────

describe("azureUploadStore: guards", () => {
    test("claimed offset that lost to durable state throws UploadOffsetConflictError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });

        const err = await store.appendChunk(uploadToken, 7, bytes(4), { now: NOW }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
    });

    test("crossing maxBytes invalidates the resource durably and refuses everything after", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "d.bin", now: NOW });

        await expect(
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), { now: NOW, maxBytes: 4 }),
        ).rejects.toThrow(/byte bound/);

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a body of exactly maxBytes is accepted", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "exact.bin", now: NOW });
        const result = await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW, maxBytes: 4 });
        expect(result.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).isInvalidated).toBe(false);
    });

    test("expectedDigest throws a clear error instead of being silently ignored", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        expect(store.digestOnComplete).toBe(false);
        const { uploadToken } = await store.createUpload({ key: "e.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            store.completeUpload(uploadToken, { now: NOW, expectedDigest: "x".repeat(43) + "=" }),
        ).rejects.toThrow(/digestOnComplete/);
        // Nothing was published by the refused completion.
        expect(mock.committed.has("e.bin")).toBe(false);
    });

    test("appending to a completed upload throws", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "f.bin", now: NOW });
        await store.completeUpload(uploadToken, { now: NOW });
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/complete/);
    });

    test("an aborted signal stops consumption but flushes already-received bytes", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "g.bin", now: NOW });

        const controller = new AbortController();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(streamController) {
                pulls += 1;
                if (pulls === 1) {
                    streamController.enqueue(bytes(1, 2, 3));
                } else {
                    // One chunk was received, then the client vanished; the
                    // stream never produces (or closes) again.
                    controller.abort();
                }
            },
        });
        const result = await store.appendChunk(uploadToken, 0, body, { now: NOW, signal: controller.signal });
        expect(result.bytesWritten).toBe(3);
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });
});

// ─── Deferred Length ─────────────────────────────────────────────────────────

describe("azureUploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is persisted and reported by the next state", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "deferred.bin", now: NOW });
        expect((await store.getUploadState(uploadToken)).length).toBeUndefined();

        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { length: 3, now: NOW + 1 });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(3);
        expect(state.offset).toBe(3);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "fixed.bin", length: 9, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { length: 42, now: NOW + 1 });
        expect((await store.getUploadState(uploadToken)).length).toBe(9);
    });
});

// ─── Not-Found + Token Integrity ─────────────────────────────────────────────

describe("azureUploadStore: not-found and token integrity", () => {
    test("garbage tokens answer UploadNotFoundError, never a parse crash", async () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        await expect(store.getUploadState("!!!not-base64!!!")).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.appendChunk("AAAA", 0, bytes(1), { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.completeUpload("e30", { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a token for a never-created (or swept) upload answers UploadNotFoundError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "h.bin", now: NOW });
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a token whose key was tampered answers UploadNotFoundError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        const decoded = JSON.parse(new TextDecoder().decode(
            Uint8Array.from(atob(uploadToken.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
        )) as { key: string; id: string };
        const forged = btoa(JSON.stringify({ key: "attacker.bin", id: decoded.id }))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        await expect(store.getUploadState(forged)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Crash Recovery ──────────────────────────────────────────────────────────

describe("azureUploadStore: crash recovery", () => {
    test("staged state lost mid-upload (native GC / blob replaced) invalidates durably", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "lost.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        mock.wipeStaged("lost.bin");

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        // Recorded durably: the next read agrees without re-deriving.
        const again = await store.getUploadState(uploadToken);
        expect(again.isInvalidated).toBe(true);
    });

    test("completion crash after commit heals on retry (blocks committed, bookkeeping behind)", async () => {
        const opts: { failNextSetMetadata?: boolean } = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "crash.bin", length: 3, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(7, 8, 9), { now: NOW });

        opts.failNextSetMetadata = true;
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow();
        // The commit itself landed; only the info update crashed.
        expect(mock.committed.get("crash.bin")!.content).toEqual(bytes(7, 8, 9));

        // State reads report the truth even before the heal...
        const observed = await store.getUploadState(uploadToken);
        expect(observed.isComplete).toBe(true);
        expect(observed.offset).toBe(3);

        // ...and the completion retry finishes the bookkeeping idempotently.
        const healed = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(healed.etag).toBe(mock.committed.get("crash.bin")!.etag);
        expect((await store.getUploadState(uploadToken)).isComplete).toBe(true);
    });
});

// ─── Abort + Sweep ───────────────────────────────────────────────────────────

describe("azureUploadStore: abort and sweep", () => {
    test("abort discards staged state and bookkeeping, and is idempotent", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "i.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(mock.staged.has("i.bin")).toBe(false);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);

        await store.abortUpload(uploadToken); // second abort: silent no-op
        await store.abortUpload("garbage-token"); // never-created: silent no-op
    });

    test("abort never deletes a pre-existing committed blob at the target key", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        // The key already holds live data (this upload was an overwrite).
        await mock.container.getBlockBlobClient("live.bin").upload("", 5, {});
        const { uploadToken } = await store.createUpload({ key: "live.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(mock.committed.has("live.bin")).toBe(true); // live data untouched
    });

    test("sweepExpired reaps idle uploads (info + staged state) and keeps active ones", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const stale = await store.createUpload({ key: "stale.bin", now: NOW - 100_000 });
        await store.appendChunk(stale.uploadToken, 0, bytes(1), { now: NOW - 90_000 });
        const active = await store.createUpload({ key: "active.bin", now: NOW - 100_000 });
        await store.appendChunk(active.uploadToken, 0, bytes(1), { now: NOW - 1_000 });

        const { removed } = await store.sweepExpired!(NOW - 10_000);
        expect(removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(mock.staged.has("stale.bin")).toBe(false);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);
    });

    test("sweeping a completed upload removes only the bookkeeping, never the published blob", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "published.bin", now: NOW - 100_000 });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW - 100_000 });
        await store.completeUpload(uploadToken, { now: NOW - 100_000 });

        const { removed } = await store.sweepExpired!(NOW);
        expect(removed).toBe(1);
        expect(mock.committed.get("published.bin")!.content).toEqual(bytes(1, 2));
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Persisted-State Shape Gate ──────────────────────────────────────────────

function toBase64Url(text: string): string {
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
}

describe("azureUploadStore: persisted-state shape gate", () => {
    /** Create a real upload, then corrupt one field of its persisted state. */
    async function tamperedStore(mutate: (state: Record<string, unknown>) => unknown) {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({
            key: "t.bin", length: 10, metadata: { a: "b" }, now: NOW,
        });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        const blob = mock.committed.get(infoName)!;
        const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<string, unknown>;
        const replacement = mutate(state);
        blob.metadata!.pcuploadstate = toBase64Url(JSON.stringify(replacement === undefined ? state : replacement));
        return { store, uploadToken };
    }

    const corruptions: Array<[string, (state: Record<string, unknown>) => unknown]> = [
        ["empty key", (s) => { s.key = ""; }],
        ["missing key", (s) => { delete s.key; }],
        ["negative length", (s) => { s.length = -1; }],
        ["fractional length", (s) => { s.length = 1.5; }],
        ["string createdAt", (s) => { s.createdAt = "yesterday"; }],
        ["missing createdAt", (s) => { delete s.createdAt; }],
        ["negative lastAppendAt", (s) => { s.lastAppendAt = -3; }],
        ["string isComplete", (s) => { s.isComplete = "no"; }],
        ["numeric isInvalidated", (s) => { s.isInvalidated = 1; }],
        ["numeric etag", (s) => { s.etag = 42; }],
        ["non-string metadata value", (s) => { s.metadata = { a: 7 }; }],
        ["array state", () => []],
        ["string state", () => "not an object"],
    ];

    for (const [label, mutate] of corruptions) {
        test(`corrupt state (${label}) answers UploadNotFoundError`, async () => {
            const { store, uploadToken } = await tamperedStore(mutate);
            await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
            await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        });
    }

    test("a metadata value that is not base64 at all answers UploadNotFoundError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "u.bin", now: NOW });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        mock.committed.get(infoName)!.metadata = { pcuploadstate: "%%% not base64 %%%" };
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
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
            const store = azureUploadStore({ containerClient: mockUploadContainer().container });
            await expect(store.getUploadState(token)).rejects.toBeInstanceOf(UploadNotFoundError);
        });
    }

    test("tokens are URL-safe even when the key's base64 needs + and /", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        // ">>>" base64-encodes with "+" and "???" with "/": both must be
        // translated to the URL-safe alphabet and pad-stripped.
        const { uploadToken } = await store.createUpload({ key: ">>>???", now: NOW });
        expect(uploadToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0); // and still round-trips
    });
});

// ─── Heal Variants + Limits ──────────────────────────────────────────────────

describe("azureUploadStore: heal variants and limits", () => {
    test("zero-byte completion crash heals: state reads complete, retry recommits", async () => {
        const opts: { failNextSetMetadata?: boolean } = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "z.bin", length: 0, now: NOW });

        opts.failNextSetMetadata = true;
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow();
        expect(mock.committed.get("z.bin")!.content.length).toBe(0); // publish landed

        const observed = await store.getUploadState(uploadToken);
        expect(observed.isComplete).toBe(true);
        expect(observed.offset).toBe(0);

        const healed = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(healed.etag).toBeDefined();
        expect((await store.getUploadState(uploadToken)).isComplete).toBe(true);
    });

    test("sentinel gone with FOREIGN committed blocks is state loss, never a heal", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        // The key already holds a blob committed from someone else's blocks.
        mock.committed.set("pre.bin", {
            content: bytes(1, 2),
            blocks: [{ name: btoa("foreignblock"), size: 2 }],
            etag: '"pre-etag"',
        });
        const { uploadToken } = await store.createUpload({ key: "pre.bin", now: NOW });
        mock.wipeStaged("pre.bin"); // our sentinel (and any data) is gone

        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        expect(state.isComplete).toBe(false);
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/invalidated|sentinel/);
    });

    test("sentinel gone with OUR committed blocks at the WRONG size is state loss, never a heal", async () => {
        const opts: { failNextSetMetadata?: boolean } = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        // Declared length 5, but the crashed completion committed only 3.
        const { uploadToken } = await store.createUpload({ key: "short.bin", length: 5, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        opts.failNextSetMetadata = true;
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow();

        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(false);
        expect(state.isInvalidated).toBe(true);
    });

    test("exceeding Azure's block limit fails loudly instead of minting unequal-length ids", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "cap.bin", now: NOW });
        // A block already sits at the last permitted index.
        mock.staged.get("cap.bin")!.set(btoa("pcblk-049999"), bytes(1));
        await expect(store.appendChunk(uploadToken, 1, bytes(2), { now: NOW }))
            .rejects.toThrow(/50,000-block/);
    });

    test("abort with a forged (valid-id, wrong-key) token discards nothing", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        const decoded = JSON.parse(fromBase64Url(uploadToken)) as { key: string; id: string };
        const forged = toBase64Url(JSON.stringify({ key: "attacker.bin", id: decoded.id }));

        await store.abortUpload(forged);
        // The victim's upload is fully intact.
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("sweep keeps an upload idle EXACTLY at the cutoff (idle strictly before it is reaped)", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const cutoff = NOW - 10_000;
        const boundary = await store.createUpload({ key: "boundary.bin", now: cutoff });
        const { removed } = await store.sweepExpired!(cutoff);
        expect(removed).toBe(0);
        expect((await store.getUploadState(boundary.uploadToken)).createdAt).toBe(cutoff);
    });

    test("sweep reaps corrupt bookkeeping regardless of age", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "corrupt.bin", now: NOW });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        mock.committed.get(infoName)!.metadata = { pcuploadstate: "garbage" };

        const { removed } = await store.sweepExpired!(0); // cutoff before every real upload
        expect(removed).toBe(1);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── Capability Flags ────────────────────────────────────────────────────────

describe("azureUploadStore: capability flags", () => {
    test("advertises exact offsets, atomic completion, no digest, byte-exact appends", () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe(false);
        expect(store.appendGranularity).toBeUndefined();
        expect(store.uniformPartSize).toBeUndefined();
    });

    test("rejects a nonsensical blockSize at construction", () => {
        expect(() => azureUploadStore({ containerClient: mockUploadContainer().container, blockSize: 0 }))
            .toThrow(RangeError);
    });
});
