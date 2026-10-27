import { describe, test, expect } from "bun:test";
import { isCorruptUploadState } from "../upload-internals";
import {
    azureUploadStore,
    UploadNotFoundError,
    UploadOffsetConflictError,
    UploadDestinationConflictError,
} from "../azure";
import {
    interleavedStream,
    threeByteUpload,
    expectGarbageTokensNotFound,
    completeDurable,
    publishedUpload,
} from "./helpers";
import { parkedBody } from "../parked-body";

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
    /**
     * Blob names whose delete rejects with a non-404 REST error (a lease, a
     * denied or throttled call). Mutable, so a test can name a blob the store
     * created and only then arm the failure.
     */
    failDeleteFor?: Set<string>;
    /** Every delete as it is asked for, with the precondition it carried. */
    deleteCalls?: Array<{ name: string; ifNoneMatch?: string; ifMatch?: string }>;
    /** Every commit as it is asked for, with the precondition it carried. */
    commitCalls?: Array<{ name: string; blockIds: string[]; ifNoneMatch?: string; ifMatch?: string }>;
    /** Awaited when a commit arrives, before the service evaluates it. */
    beforeCommit?: (name: string) => Promise<void> | void;
    /**
     * How a delete's `If-None-Match: *` reads a blob that exists only as
     * staged blocks. The REST reference leaves it unstated, so the adapter
     * must reclaim under either reading; the default is the RFC 9110 one, a
     * resource with any current representation state is present.
     */
    stagedOnlyIsPresentToDelete?: boolean;
    /** Awaited before a block is staged, once the store has decided to stage it. */
    beforeStage?: (name: string) => Promise<void>;
    /** Runs between the empty commit and the delete that follows it. */
    beforeDelete?: (name: string) => void;
    /** Rejects the next info-blob getProperties with this REST status. */
    failNextInfoRead?: { status: number; afterReads: number };
    /**
     * Which side of the block list getBlockList reports without sizes, as a
     * malformed reply would. Mutable, so a test can arm it once blocks exist.
     */
    sizelessBlocks?: "committed" | "uncommitted";
}

function restError(statusCode: number, code?: string): Error {
    const err = new Error(`azure rest error ${statusCode}`);
    err.name = "RestError";
    (err as unknown as { statusCode: number }).statusCode = statusCode;
    if (code !== undefined) (err as unknown as { code: string }).code = code;
    return err;
}

/**
 * A delete's preconditions as the service evaluates them: `If-None-Match: *`
 * refuses a present blob, `If-Match` refuses any version but the named one.
 */
function deletePrecondition(
    conditions: { ifNoneMatch?: string; ifMatch?: string },
    blob: CommittedBlob | undefined,
    stagedReadsPresent: boolean,
): void {
    if (conditions.ifNoneMatch === "*" && (blob !== undefined || stagedReadsPresent)) {
        throw restError(412, "ConditionNotMet");
    }
    if (conditions.ifMatch !== undefined && blob !== undefined && blob.etag !== conditions.ifMatch) {
        throw restError(412, "ConditionNotMet");
    }
}

/**
 * A commit's preconditions as the service evaluates them, before the block
 * list: a create-only commit over a committed blob answers 409
 * BlobAlreadyExists (staged blocks alone are no blob to it), and `If-Match`
 * refuses any version but the named one, an absent blob included.
 */
function commitPrecondition(
    conditions: { ifNoneMatch?: string; ifMatch?: string },
    blob: CommittedBlob | undefined,
): void {
    if (conditions.ifNoneMatch === "*" && blob !== undefined) throw restError(409, "BlobAlreadyExists");
    if (conditions.ifMatch !== undefined && blob?.etag !== conditions.ifMatch) {
        throw restError(412, "ConditionNotMet");
    }
}

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
                    await opts.beforeStage?.(blobName);
                    let blocks = staged.get(blobName);
                    if (!blocks) {
                        blocks = new Map();
                        staged.set(blobName, blocks);
                    }
                    blocks.set(blockId, body.slice());
                    opts.stagedIds?.push(blockId);
                    return {};
                },
                async commitBlockList(
                    blockIds: string[],
                    commitOpts?: {
                        conditions?: { ifNoneMatch?: string; ifMatch?: string };
                        metadata?: Record<string, string>;
                    },
                ) {
                    const conditions = commitOpts?.conditions ?? {};
                    opts.commitCalls?.push({ name: blobName, blockIds: [...blockIds], ...conditions });
                    await opts.beforeCommit?.(blobName);
                    const blocks = staged.get(blobName) ?? new Map<string, Uint8Array>();
                    const existing = committed.get(blobName);
                    commitPrecondition(conditions, existing);
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
                    committed.set(blobName, {
                        content: concat(pieces),
                        blocks: committedBlocks,
                        etag,
                        ...(commitOpts?.metadata !== undefined ? { metadata: { ...commitOpts.metadata } } : {}),
                    });
                    return { etag };
                },
                async getBlockList(_type: "all") {
                    const blob = committed.get(blobName);
                    const blocks = staged.get(blobName);
                    if (!blob && (!blocks || blocks.size === 0)) throw restError(404);
                    const listed = (side: "committed" | "uncommitted", block: { name: string; size: number }) =>
                        opts.sizelessBlocks === side ? { name: block.name } : block;
                    return {
                        committedBlocks: blob?.blocks.map((b) => listed("committed", { ...b })) ?? [],
                        // Azure returns block lists alphabetically, not in
                        // staging order; reverse to prove the adapter sorts.
                        uncommittedBlocks: [...(blocks ?? new Map()).entries()]
                            .map(([name, bytes]) => listed("uncommitted", { name, size: (bytes as Uint8Array).length }))
                            .toReversed(),
                    };
                },
                async upload(_body: string, contentLength: number, uploadOpts?: { metadata?: Record<string, string> }) {
                    // Put Blob replaces the blob and discards its staged block list.
                    staged.delete(blobName);
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
                    const failure = opts.failNextInfoRead;
                    if (failure && blobName.endsWith(".info")) {
                        if (failure.afterReads === 0) {
                            opts.failNextInfoRead = undefined;
                            throw restError(failure.status);
                        }
                        failure.afterReads -= 1;
                    }
                    const blob = committed.get(blobName);
                    if (!blob) throw restError(404);
                    return { metadata: blob.metadata, etag: blob.etag, contentLength: blob.content.length };
                },
                async setMetadata(metadata: Record<string, string>, setOpts?: { conditions?: { ifMatch?: string } }) {
                    if (opts.failNextSetMetadata) {
                        opts.failNextSetMetadata = false;
                        throw restError(500);
                    }
                    const blob = committed.get(blobName);
                    if (!blob) throw restError(404);
                    // The service's precondition: a write pinned to a version
                    // the blob no longer has is refused, and every metadata
                    // write stamps a new version.
                    const pinned = setOpts?.conditions?.ifMatch;
                    if (pinned !== undefined && pinned !== blob.etag) throw restError(412);
                    blob.metadata = metadata;
                    etagCounter += 1;
                    blob.etag = `"azure-etag-${etagCounter}"`;
                    return {};
                },
                async deleteIfExists(deleteOpts?: { conditions?: { ifNoneMatch?: string; ifMatch?: string } }) {
                    const conditions = deleteOpts?.conditions ?? {};
                    opts.deleteCalls?.push({ name: blobName, ...conditions });
                    opts.beforeDelete?.(blobName);
                    if (opts.failDeleteFor?.has(blobName)) throw restError(403);
                    const blob = committed.get(blobName);
                    const stagedOnly = !blob && (staged.get(blobName)?.size ?? 0) > 0;
                    deletePrecondition(conditions, blob, stagedOnly && opts.stagedOnlyIsPresentToDelete !== false);
                    if (!blob && !stagedOnly) return { succeeded: false }; // 404, swallowed
                    committed.delete(blobName);
                    staged.delete(blobName); // Delete Blob discards the staged block list
                    return { succeeded: true };
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
        wipeStaged(blobName: string) {
            staged.delete(blobName);
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

/** The block-id segment of the upload whose sentinel is staged on `key`. */
function segmentOn(mock: ReturnType<typeof mockUploadContainer>, key: string): string {
    const sentinel = [...(mock.staged.get(key)?.keys() ?? [])].find((id) => atob(id).endsWith("anchr"))!;
    return atob(sentinel).slice(1, 7);
}
const dataBlockId = (segment: string, index: number): string => btoa(`p${segment}${String(index).padStart(5, "0")}`);

/**
 * Fail the record write that follows the next commit: the crash between a
 * publish that landed and the bookkeeping that records it. Armed from the
 * commit itself, because the completion's seal is a record write too.
 */
function failRecordAfterCommit(opts: MockAzureUploadOpts): void {
    opts.beforeCommit = () => {
        opts.beforeCommit = undefined;
        opts.failNextSetMetadata = true;
    };
}

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
        expect(fresh.status === "complete").toBe(false);
        expect(fresh.status === "invalidated").toBe(false);
        expect(fresh.createdAt).toBe(NOW);
        expect(fresh.metadata).toEqual({ filename: "report.pdf" });

        const first = await store.appendChunk(uploadToken, 0, asciiBytes("01234"), { now: NOW + 1 });
        expect(first.bytesWritten).toBe(5);
        const mid = await store.getUploadState(uploadToken);
        expect(mid.offset).toBe(5);
        expect(mid.lastAppendAt).toBe(NOW + 1);

        const second = await store.appendChunk(uploadToken, 5, streamOf(asciiBytes("567"), asciiBytes("89")), {
            now: NOW + 2,
        });
        expect(second.bytesWritten).toBe(5);

        const completed = await store.completeUpload(uploadToken, { expectedLength: 10, now: NOW + 3 });
        expect(completed.etag).toBeDefined();
        expect(new TextDecoder().decode(mock.committed.get("docs/report.pdf")!.content)).toBe("0123456789");

        const final = await store.getUploadState(uploadToken);
        expect(final.status === "complete").toBe(true);
        expect(final.offset).toBe(10);
    });

    test("completion is idempotent and replays the recorded etag without recommitting", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await completeDurable(store, uploadToken, { now: NOW });
        const replay = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty blob (sentinel never committed)", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });

        const completed = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(completed.etag).toBeDefined();
        const blob = mock.committed.get("empty.bin")!;
        expect(blob.content.length).toBe(0);
        expect(blob.blocks).toEqual([]); // no data blocks AND no sentinel in the committed list

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(true);
        expect(state.offset).toBe(0);
    });
});

// ─── Block Ids + Offset Derivation ──────────────────────────────────────────

describe("azureUploadStore: block ids and offset derivation", () => {
    test("data block ids are same-length base64 of the upload's segment and a zero-padded sequence", async () => {
        const stagedIds: string[] = [];
        const mock = mockUploadContainer({ stagedIds });
        // blockSize is a flush THRESHOLD: each stream chunk crossing it stages
        // one block, so two 5-byte chunks over threshold 4 become two blocks.
        const store = azureUploadStore({ containerClient: mock.container, blockSize: 4 });
        const { uploadToken } = await store.createUpload({ key: "multi.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, streamOf(asciiBytes("01234"), asciiBytes("56789")), { now: NOW });

        // First staged id is the creation sentinel; the rest are data blocks.
        const [sentinel, ...dataIds] = stagedIds;
        expect(atob(sentinel!)).toMatch(/^p[A-Za-z0-9_~]{6}anchr$/);
        const segment = atob(sentinel!).slice(1, 7);
        expect(dataIds.map((id) => atob(id))).toEqual([`p${segment}00000`, `p${segment}00001`]);
        const lengths = new Set(stagedIds.map((id) => id.length));
        expect(lengths.size).toBe(1); // Azure requires equal-length ids
        // Twelve raw characters, the width of the earlier release's ids, so a
        // blob still holding those accepts these.
        expect(stagedIds.every((id) => atob(id).length === 12)).toBe(true);

        expect(await store.getUploadState(uploadToken).then((s) => s.offset)).toBe(10);
    });

    test("two uploads to one key derive from their own segment and commit only their own blocks", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const first = await store.createUpload({ key: "shared.bin", now: NOW });
        await store.appendChunk(first.uploadToken, 0, bytes(1, 2, 3, 4), { now: NOW });
        const second = await store.createUpload({ key: "shared.bin", now: NOW });
        await store.appendChunk(second.uploadToken, 0, asciiBytes("xyz"), { now: NOW });

        expect((await store.getUploadState(first.uploadToken)).offset).toBe(4);
        expect((await store.getUploadState(second.uploadToken)).offset).toBe(3);

        await completeDurable(store, second.uploadToken, { now: NOW });
        const published = mock.committed.get("shared.bin")!;
        expect(new TextDecoder().decode(published.content)).toBe("xyz");
        expect(published.blocks).toHaveLength(1);
        // The commit dropped every other staged block, the first upload's
        // sentinel among them: one in-flight upload per key, as documented.
        expect((await store.getUploadState(first.uploadToken)).status === "invalidated").toBe(true);
    });

    test("blocks staged under the earlier release's id width are neither counted nor committed", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "legacy.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        // Left by an upload that was in flight across the upgrade: same raw
        // width, no segment, so they belong to no upload.
        mock.staged.get("legacy.bin")!.set(btoa("pcblk-anchor"), bytes(0));
        mock.staged.get("legacy.bin")!.set(btoa("pcblk-000000"), bytes(9, 9, 9));

        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
        await completeDurable(store, uploadToken, { now: NOW });
        expect(mock.committed.get("legacy.bin")!.content).toEqual(bytes(1, 2));
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
        await completeDurable(store, uploadToken, { now: NOW });
        // Mock returns block lists reversed, so correct assembly proves sorting.
        expect(new TextDecoder().decode(mock.committed.get("seq.bin")!.content)).toBe("abcdef");
        const names = mock.committed.get("seq.bin")!.blocks.map((b) => atob(b.name));
        const segment = names[0]!.slice(1, 7);
        expect(names).toEqual([`p${segment}00000`, `p${segment}00001`, `p${segment}00002`]);
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
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), {
                now: NOW,
                maxBytes: 4,
                maxBytesFatal: true,
            }),
        ).rejects.toThrow(/representation bound/);

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a body of exactly maxBytes is accepted", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "exact.bin", now: NOW });
        const result = await store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), {
            now: NOW,
            maxBytes: 4,
            maxBytesFatal: true,
        });
        expect(result.bytesWritten).toBe(4);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(false);
    });

    test("expectedDigests throws a clear error instead of being silently ignored", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        expect(store.digestOnComplete).toBe(false);
        const { uploadToken } = await store.createUpload({ key: "e.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            completeDurable(store, uploadToken, { now: NOW, expectedDigests: { "sha-256": "x".repeat(43) + "=" } }),
        ).rejects.toThrow(/digestOnComplete/);
        // Nothing was published by the refused completion.
        expect(mock.committed.has("e.bin")).toBe(false);
    });

    test("appending to a completed upload throws", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "f.bin", now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
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
        await expectGarbageTokensNotFound(store, NOW);
    });

    test("a token for a never-created (or swept) upload answers UploadNotFoundError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "h.bin", now: NOW });
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("the token is the resource id and discloses nothing about the key", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "tenants/acme/payroll.csv", now: NOW });
        expect(uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(uploadToken).not.toContain("acme");
    });

    test("a token that is not a minted id answers UploadNotFoundError", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
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

// ─── Crash Recovery ──────────────────────────────────────────────────────────

describe("azureUploadStore: crash recovery", () => {
    test("staged state lost mid-upload (native GC / blob replaced) invalidates durably", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "lost.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        mock.wipeStaged("lost.bin");

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        // Recorded durably: the next read agrees without re-deriving.
        const again = await store.getUploadState(uploadToken);
        expect(again.status === "invalidated").toBe(true);
    });

    /**
     * The persisted bookkeeping for every info blob, as raw metadata.
     *
     * Asserted directly rather than through `getUploadState`, which re-derives
     * invalidation from the block list on every read and therefore answers
     * `true` whether or not anything was ever WRITTEN. That is what makes it
     * unable to tell a durable invalidation from a fresh derivation, and the
     * durable one is the property these two tests exist for.
     */
    function persistedStates(mock: ReturnType<typeof mockUploadContainer>): string[] {
        // Every value, rather than the adapter's metadata key by name: a copy
        // of that key here would be a second place to change it, and what these
        // tests need is only whether the persisted bytes MOVED.
        return [...mock.committed.values()].flatMap((blob) => Object.values(blob.metadata ?? {}));
    }

    test("an APPEND onto lost staged state invalidates durably before it throws", async () => {
        // A throw that outran the durable write would leave an upload that
        // accepts the NEXT append as if nothing had happened.
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "gone-append.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        mock.wipeStaged("gone-append.bin");
        const before = persistedStates(mock);

        await expect(store.appendChunk(uploadToken, 2, bytes(3), { now: NOW })).rejects.toThrow(
            /staged blocks are gone/,
        );
        expect(persistedStates(mock)).not.toEqual(before);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(true);
    });

    test("a COMPLETION onto lost staged state invalidates durably before it throws", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "gone-complete.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        mock.wipeStaged("gone-complete.bin");
        const before = persistedStates(mock);

        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW })).rejects.toThrow(
            /staged blocks are gone/,
        );
        expect(persistedStates(mock)).not.toEqual(before);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(true);
    });

    test("completion crash after commit heals on retry (blocks committed, bookkeeping behind)", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "crash.bin", length: 3, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(7, 8, 9), { now: NOW });

        failRecordAfterCommit(opts);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow();
        // The commit itself landed; only the info update crashed.
        expect(mock.committed.get("crash.bin")!.content).toEqual(bytes(7, 8, 9));

        // State reads report the truth even before the heal...
        const observed = await store.getUploadState(uploadToken);
        expect(observed.status === "complete").toBe(true);
        expect(observed.offset).toBe(3);

        // ...and the completion retry finishes the bookkeeping idempotently.
        const healed = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(healed.etag).toBe(mock.committed.get("crash.bin")!.etag);
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(true);
    });
});

// ─── Abort + Sweep ───────────────────────────────────────────────────────────

describe("azureUploadStore: abort and sweep", () => {
    test("abort discards the bookkeeping, leaves staged blocks to age out, and is idempotent", async () => {
        // An abort that wrote at the key (an empty commit to drop the staged
        // blocks) would make a blob appear there: readable, announced as
        // created, and kept by versioning or a retention policy.
        const commitCalls: Array<{ name: string; blockIds: string[] }> = [];
        const deleteCalls: Array<{ name: string }> = [];
        const mock = mockUploadContainer({ commitCalls, deleteCalls });
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "i.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(commitCalls).toEqual([]);
        expect(deleteCalls.map((c) => c.name).filter((name) => name === "i.bin")).toEqual([]);
        expect(mock.committed.has("i.bin")).toBe(false);
        expect(mock.staged.get("i.bin")?.size).toBe(2); // sentinel + one block, for the service to collect
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

    test("aborting a COMPLETED upload discards the bookkeeping, never the published blob", async () => {
        // Store contract: after completion the blob at the key is live data,
        // and abort is idempotent, so an abort that reached it would destroy
        // production data on a replayed or retried DELETE.
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const uploadToken = await publishedUpload(store, "done.bin", bytes(1, 2), NOW);

        await store.abortUpload(uploadToken);
        await store.abortUpload(uploadToken); // and again: still not destructive
        expect(mock.committed.has("done.bin")).toBe(true);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("sweepExpired reaps idle uploads' bookkeeping without writing at their keys, and keeps active ones", async () => {
        const commitCalls: Array<{ name: string; blockIds: string[] }> = [];
        const mock = mockUploadContainer({ commitCalls });
        const store = azureUploadStore({ containerClient: mock.container });
        const stale = await store.createUpload({ key: "stale.bin", now: NOW - 100_000 });
        await store.appendChunk(stale.uploadToken, 0, bytes(1), { now: NOW - 90_000 });
        const active = await store.createUpload({ key: "active.bin", now: NOW - 100_000 });
        await store.appendChunk(active.uploadToken, 0, bytes(1), { now: NOW - 1_000 });

        const { removed } = await store.sweepExpired!({ idleSinceMs: NOW - 10_000 });
        expect(removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(commitCalls).toEqual([]);
        expect(mock.committed.has("stale.bin")).toBe(false);
        expect(mock.staged.has("stale.bin")).toBe(true); // left to the service's seven-day collection
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);
    });

    test('sweepExpired with discardStaged "commit-empty" reclaims the staged blocks at once', async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container, discardStaged: "commit-empty" });
        const stale = await store.createUpload({ key: "stale.bin", now: NOW - 100_000 });
        await store.appendChunk(stale.uploadToken, 0, bytes(1), { now: NOW - 90_000 });

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
        expect(mock.staged.has("stale.bin")).toBe(false);
        expect(mock.committed.has("stale.bin")).toBe(false);
    });

    test("discardStaged refuses a value it does not name", () => {
        const mock = mockUploadContainer();
        const discardStaged = "delete" as unknown as "age-out";
        expect(() => azureUploadStore({ containerClient: mock.container, discardStaged })).toThrow(RangeError);
    });

    test("sweeping a completed upload removes only the bookkeeping, never the published blob", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "published.bin", now: NOW - 100_000 });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW - 100_000 });
        await completeDurable(store, uploadToken, { now: NOW - 100_000 });

        const { removed } = await store.sweepExpired!({ idleSinceMs: NOW });
        expect(removed).toBe(1);
        expect(mock.committed.get("published.bin")!.content).toEqual(bytes(1, 2));
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a resource that cannot be reclaimed is counted, never allowed to end the scan", async () => {
        // A leased or denied delete on one resource must not cost the
        // resources behind it in the listing: a scheduled sweep would then
        // reclaim nothing for as long as that one resource stayed
        // unreclaimable, and would report success by not throwing, which is a
        // retention control that has stopped working while still looking
        // scheduled.
        const failDeleteFor = new Set<string>();
        const mock = mockUploadContainer({ failDeleteFor });
        const store = azureUploadStore({ containerClient: mock.container });
        await store.createUpload({ key: "first.bin", now: NOW - 100_000 });
        const second = await store.createUpload({ key: "second.bin", now: NOW - 100_000 });
        const infoNames = [...mock.committed.keys()].filter((name) => name.endsWith(".info"));
        expect(infoNames).toHaveLength(2);
        failDeleteFor.add(infoNames[0]!);

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 1 });
        await expect(store.getUploadState(second.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        // What could not be reclaimed is still listed, so the next pass
        // retries it rather than losing track of its bytes.
        expect([...mock.committed.keys()]).toContain(infoNames[0]!);
        failDeleteFor.clear();
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
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
            key: "t.bin",
            length: 10,
            metadata: { a: "b" },
            now: NOW,
        });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        const blob = mock.committed.get(infoName)!;
        const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<string, unknown>;
        const replacement = mutate(state);
        blob.metadata!.pcuploadstate = toBase64Url(JSON.stringify(replacement === undefined ? state : replacement));
        return { store, uploadToken };
    }

    const corruptions: Array<[string, (state: Record<string, unknown>) => unknown]> = [
        [
            "empty key",
            (s) => {
                s.key = "";
            },
        ],
        [
            "missing key",
            (s) => {
                delete s.key;
            },
        ],
        [
            "negative length",
            (s) => {
                s.length = -1;
            },
        ],
        [
            "fractional length",
            (s) => {
                s.length = 1.5;
            },
        ],
        [
            "string createdAt",
            (s) => {
                s.createdAt = "yesterday";
            },
        ],
        [
            "missing createdAt",
            (s) => {
                delete s.createdAt;
            },
        ],
        [
            "negative lastAppendAt",
            (s) => {
                s.lastAppendAt = -3;
            },
        ],
        [
            "string isComplete",
            (s) => {
                s.isComplete = "no";
            },
        ],
        [
            "numeric isInvalidated",
            (s) => {
                s.isInvalidated = 1;
            },
        ],
        [
            "numeric etag",
            (s) => {
                s.etag = 42;
            },
        ],
        [
            "non-string metadata value",
            (s) => {
                s.metadata = { a: 7 };
            },
        ],
        ["array state", () => []],
        ["string state", () => "not an object"],
    ];

    for (const [label, mutate] of corruptions) {
        test(`corrupt state (${label}) answers UploadNotFoundError`, async () => {
            const { store, uploadToken } = await tamperedStore(mutate);
            // Not-found to the client, damaged storage to the operator.
            expect(isCorruptUploadState(await store.getUploadState(uploadToken).catch((e: unknown) => e))).toBe(true);
            await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toBeInstanceOf(
                UploadNotFoundError,
            );
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
    test("zero-byte completion crash heals: state reads complete, retry adopts without recommitting", async () => {
        const commitCalls: Array<{ name: string; blockIds: string[] }> = [];
        const opts: MockAzureUploadOpts = { commitCalls };
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "z.bin", length: 0, now: NOW });

        failRecordAfterCommit(opts);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow();
        expect(mock.committed.get("z.bin")!.content.length).toBe(0); // publish landed

        const observed = await store.getUploadState(uploadToken);
        expect(observed.status === "complete").toBe(true);
        expect(observed.offset).toBe(0);

        const healed = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(healed.etag).toBe(mock.committed.get("z.bin")!.etag);
        expect(commitCalls).toHaveLength(1);
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(true);
    });

    test("a zero-byte completion retried after its blob was replaced never commits over the replacement", async () => {
        // The empty commit landed and its record write was lost; someone then
        // wrote the key. Recommitting an empty list unconditionally would
        // replace their blob with an empty one.
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "z2.bin", length: 0, now: NOW });
        failRecordAfterCommit(opts);
        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW })).rejects.toThrow();

        await mock.container.getBlockBlobClient("z2.bin").upload("", 4, {});
        const replacement = mock.committed.get("z2.bin")!;

        await expect(store.completeUpload(uploadToken, { expectedLength: 0, now: NOW + 1 })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(mock.committed.get("z2.bin")).toBe(replacement);
        expect(replacement.content.length).toBe(4);
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
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
        expect(state.status === "invalidated").toBe(true);
        expect(state.status === "complete").toBe(false);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/invalidated|sentinel/);
    });

    test("a foreign blob shaped exactly like this upload's commit is never adopted by a retry", async () => {
        // The commit landed and its record write was lost; a third party then
        // replaced the key with a blob of the same bytes, the same size and
        // even the same block names. Shape is not identity: only the
        // publication id the seal minted proves a blob is this upload's.
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "twin.bin", length: 3, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        failRecordAfterCommit(opts);
        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow();

        const ours = mock.committed.get("twin.bin")!;
        const twin = { content: ours.content.slice(), blocks: ours.blocks.map((b) => ({ ...b })), etag: '"twin"' };
        mock.committed.set("twin.bin", twin);

        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW + 1 })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(mock.committed.get("twin.bin")).toBe(twin);
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("the published blob carries the seal's publication id, and only that id is adopted", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "id.bin", length: 2, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        failRecordAfterCommit(opts);
        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW })).rejects.toThrow();

        const published = mock.committed.get("id.bin")!;
        const id = published.metadata?.pcpublication;
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        // Another id on the same blob is someone else's publication.
        published.metadata = { pcpublication: crypto.randomUUID() };
        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW + 1 })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        published.metadata = { pcpublication: id! };
        expect(await store.completeUpload(uploadToken, { expectedLength: 2, now: NOW + 2 })).toEqual({
            etag: published.etag,
        });
    });

    test("exceeding Azure's block limit fails loudly instead of minting unequal-length ids", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "cap.bin", now: NOW });
        // A block already sits at the last permitted index.
        mock.staged.get("cap.bin")!.set(dataBlockId(segmentOn(mock, "cap.bin"), 49_999), bytes(1));
        await expect(store.appendChunk(uploadToken, 1, bytes(2), { now: NOW })).rejects.toThrow(/50,000-block/);
    });

    test("abort with an id that names no resource discards nothing", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });

        await store.abortUpload("00000000-0000-4000-8000-000000000000");
        await store.abortUpload("not-a-token");

        // The victim's upload is fully intact.
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("sweep keeps an upload idle EXACTLY at the cutoff (idle strictly before it is reaped)", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const cutoff = NOW - 10_000;
        const boundary = await store.createUpload({ key: "boundary.bin", now: cutoff });
        const { removed } = await store.sweepExpired!({ idleSinceMs: cutoff });
        expect(removed).toBe(0);
        expect((await store.getUploadState(boundary.uploadToken)).createdAt).toBe(cutoff);
    });

    test("sweep reaps corrupt bookkeeping regardless of age", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "corrupt.bin", now: NOW });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        mock.committed.get(infoName)!.metadata = { pcuploadstate: "garbage" };

        const { removed } = await store.sweepExpired!({ idleSinceMs: 0 }); // cutoff before every real upload
        expect(removed).toBe(1);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });
});

// ─── A size nobody reported is never zero ───────────────────────────────────

describe("azureUploadStore: a size the service did not report is never counted as zero", () => {
    /** Rewrite the upload's persisted record in place. */
    function rewriteRecord(
        mock: ReturnType<typeof mockUploadContainer>,
        mutate: (state: Record<string, unknown>) => void,
    ): void {
        const blob = [...mock.committed.entries()].find(([name]) => name.endsWith(".info"))![1];
        const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<string, unknown>;
        mutate(state);
        blob.metadata!.pcuploadstate = toBase64Url(JSON.stringify(state));
    }

    test("a staged data block listed without a size fails the read instead of shortening the offset", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const uploadToken = await threeByteUpload(store, "nosize.bin", NOW, { complete: false });

        opts.sizelessBlocks = "uncommitted";
        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/block without a size/);
        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow(
            /block without a size/,
        );
        // Nothing was published on a sum that could not be taken.
        expect(mock.committed.has("nosize.bin")).toBe(false);
    });

    test("a committed block listed without a size fails the read of a completed upload", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const uploadToken = await threeByteUpload(store, "nosize-done.bin", NOW, { complete: true });

        opts.sizelessBlocks = "committed";
        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/block without a size/);
    });

    test("a deferred-length completion records its size, which answers once the published blob is gone", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const uploadToken = await threeByteUpload(store, "deferred.bin", NOW, { complete: true });

        mock.committed.delete("deferred.bin");
        const state = await store.getUploadState(uploadToken);
        expect(state.status).toBe("complete");
        expect(state.offset).toBe(3);
        expect(state.length).toBe(3);
    });

    test("a completed record that never recorded its size fails once the published blob is gone", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const uploadToken = await threeByteUpload(store, "legacy-done.bin", NOW, { complete: true });
        rewriteRecord(mock, (state) => {
            delete state.length;
        });

        mock.committed.delete("legacy-done.bin");
        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/recorded no length/);
    });

    test("deferred-length bytes lost under a zero-block blob invalidate, never complete empty", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        // The key already holds a blob written whole, which lists no blocks.
        mock.committed.set("replaced.bin", { content: new Uint8Array(0), blocks: [], etag: '"put-etag"' });
        const { uploadToken } = await store.createUpload({ key: "replaced.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        mock.wipeStaged("replaced.bin");

        const state = await store.getUploadState(uploadToken);
        expect(state.status).toBe("invalidated");
    });

    test("completing deferred-length bytes lost under a zero-block blob refuses, never publishes empty over it", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        mock.committed.set("kept.bin", { content: bytes(7), blocks: [], etag: '"put-etag"' });
        const { uploadToken } = await store.createUpload({ key: "kept.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        mock.wipeStaged("kept.bin");

        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW })).rejects.toThrow(
            /sentinel is gone/,
        );
        // The blob already at the key is untouched.
        expect(mock.committed.get("kept.bin")!.etag).toBe('"put-etag"');
        expect(mock.committed.get("kept.bin")!.content).toEqual(bytes(7));
    });

    test("a deferred-length completion healed after a crash records its size too", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "healed.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        failRecordAfterCommit(opts);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow();
        await completeDurable(store, uploadToken, { now: NOW + 1 });

        mock.committed.delete("healed.bin");
        expect((await store.getUploadState(uploadToken)).offset).toBe(3);
    });

    test("a record from before the ledger, with the length deferred, is not taken to have accepted nothing", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        mock.committed.set("unledgered.bin", { content: new Uint8Array(0), blocks: [], etag: '"put-etag"' });
        const { uploadToken } = await store.createUpload({ key: "unledgered.bin", now: NOW });
        rewriteRecord(mock, (state) => {
            delete state.staged;
        });
        mock.wipeStaged("unledgered.bin");

        const state = await store.getUploadState(uploadToken);
        expect(state.status).toBe("invalidated");
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a deferred-length upload completed empty heals a crash after its commit", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "empty-deferred.bin", now: NOW });

        failRecordAfterCommit(opts);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow();
        expect(mock.committed.get("empty-deferred.bin")!.content.length).toBe(0);

        const observed = await store.getUploadState(uploadToken);
        expect(observed.status).toBe("complete");
        expect(observed.offset).toBe(0);
        const healed = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(healed.etag).toBeDefined();
        expect((await store.getUploadState(uploadToken)).length).toBe(0);
    });
});

// ─── The state write is pinned to the version the writer read ───────────────

describe("azureUploadStore: the state write is conditional on the version it read", () => {
    /**
     * The info blob holds the flags and the write-once facts, so a holder whose
     * lock was stolen while its body streamed must not write a record from
     * before the winner's changes over them. Every state write re-reads, merges
     * with the terminal flags one-way, and carries `ifMatch` with the ETag that
     * read returned; a 412 re-reads and retries, and a write that keeps losing
     * fails rather than landing.
     */

    /** The persisted state currently held by the one `.info` blob. */
    function persistedState(mock: ReturnType<typeof mockUploadContainer>) {
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        const blob = mock.committed.get(infoName)!;
        return { blob, state: JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<string, unknown> };
    }

    test("an invalidation landing mid-append refuses the append, and stands", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "contended.bin", now: NOW });

        // Between the append's snapshot read and its first stage, the winner
        // marks the upload terminal. The record is read again before the
        // stage, so the append refuses with nothing staged, and the flag
        // stands.
        await expect(
            store.appendChunk(
                uploadToken,
                0,
                interleavedStream(async () => {
                    const { blob, state } = persistedState(mock);
                    blob.metadata!.pcuploadstate = toBase64Url(JSON.stringify({ ...state, isInvalidated: true }));
                    blob.etag = '"foreign-write"';
                }, asciiBytes("hello")),
                { now: NOW + 5 },
            ),
        ).rejects.toThrow(/invalidated/);

        const { state } = persistedState(mock);
        expect(state.isInvalidated).toBe(true);
        expect(state.lastAppendAt).toBeUndefined();
        expect(mock.staged.get("contended.bin")!.size).toBe(1); // the sentinel alone
    });

    test("a 412 re-reads and retries against the record that won", async () => {
        // The stolen-lock case proper: the winner's write lands between the
        // merge's read and its write. The service refuses the stale write, the
        // retry is computed from the winner's record and pinned to the
        // winner's version, and the winner's terminal flag survives.
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "raced.bin", now: NOW });
        const { blob } = persistedState(mock);
        let mergeReads = 0;
        const realClient = mock.container.getBlockBlobClient.bind(mock.container);
        mock.container.getBlockBlobClient = (blobName: string) => {
            const client = realClient(blobName);
            if (!blobName.endsWith(".info")) return client;
            return {
                ...client,
                async getProperties() {
                    const props = await client.getProperties();
                    mergeReads += 1;
                    // The append's own snapshot is read 1 and its pre-stage check
                    // read 2; the merge's first read is read 3, after which the
                    // winner's write lands.
                    if (mergeReads === 3) {
                        const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<
                            string,
                            unknown
                        >;
                        blob.metadata = {
                            pcuploadstate: toBase64Url(JSON.stringify({ ...state, metadata: { from: "winner" } })),
                        };
                        blob.etag = '"winner"';
                    }
                    return props;
                },
            };
        };

        await store.appendChunk(uploadToken, 0, asciiBytes("hello"), { now: NOW + 5 });

        const { state } = persistedState(mock);
        expect(mergeReads).toBe(4);
        expect(state.metadata).toEqual({ from: "winner" });
        expect(state.lastAppendAt).toBe(NOW + 5);
        expect(state.staged).toEqual({ blocks: 1, bytes: 5 });
    });

    test("a record that keeps changing under the merge fails after three attempts", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "spinning.bin", now: NOW });
        const { blob } = persistedState(mock);
        // Every read returns a version the write will no longer match.
        let reads = 0;
        const getProperties = mock.container.getBlockBlobClient.bind(mock.container);
        mock.container.getBlockBlobClient = (blobName: string) => {
            const client = getProperties(blobName);
            if (!blobName.endsWith(".info")) return client;
            return {
                ...client,
                async getProperties() {
                    reads += 1;
                    blob.etag = `"version-${reads}"`;
                    const props = await client.getProperties();
                    blob.etag = `"version-${reads}-moved"`;
                    return props;
                },
            };
        };

        await expect(store.appendChunk(uploadToken, 0, asciiBytes("hello"), { now: NOW + 5 })).rejects.toThrow(
            /changed under 3 consecutive merges/,
        );
    });

    test("a state write pinned to the version it read is accepted, so the merge is not inert", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "plain.bin", now: NOW });

        await store.appendChunk(uploadToken, 0, asciiBytes("hello"), { now: NOW + 5 });

        const { state } = persistedState(mock);
        expect(state.lastAppendAt).toBe(NOW + 5);
        expect(state.status === "invalidated").toBe(false);
    });

    test("a state read the merge cannot make fails the append rather than writing the snapshot", async () => {
        // The snapshot predates the body, so writing it back with no version to
        // pin to would clear an invalidation that landed in between. That is the
        // loss the fresh read exists to stop, so a read that fails fails the merge.
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "unreadable.bin", now: NOW });
        const { blob } = persistedState(mock);
        let reads = 0;
        const realClient = mock.container.getBlockBlobClient.bind(mock.container);
        mock.container.getBlockBlobClient = (blobName: string) => {
            const client = realClient(blobName);
            if (!blobName.endsWith(".info")) return client;
            return {
                ...client,
                async getProperties() {
                    reads += 1;
                    // Reads 1 and 2 are the append's own; the merge's is read 3. A
                    // holder invalidates the upload just before that read fails.
                    if (reads < 3) return await client.getProperties();
                    const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<string, unknown>;
                    blob.metadata = {
                        pcuploadstate: toBase64Url(JSON.stringify({ ...state, isInvalidated: true })),
                    };
                    throw new Error("info blob unreadable");
                },
            };
        };

        await expect(store.appendChunk(uploadToken, 0, asciiBytes("hello"), { now: NOW + 5 })).rejects.toThrow(
            /info blob unreadable/,
        );

        expect(persistedState(mock).state.isInvalidated).toBe(true);
    });
});

// ─── A stale holder cannot replace an acknowledged block ────────────────────

describe("azureUploadStore: a stage is fenced by the accepted ledger", () => {
    /**
     * Blocks stage under sequence numbers read off the block list before the
     * body streams. A holder whose lock was stolen during that stream would
     * stage its index again, and Azure REPLACES a staged block under an
     * existing id: the new holder's acknowledged bytes, silently swapped.
     * The record counts the accepted prefix, a stage re-reads it first, and
     * the recording write refuses an index it already holds.
     */
    const ledgerOf = (mock: ReturnType<typeof mockUploadContainer>) => {
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        const state = JSON.parse(fromBase64Url(mock.committed.get(infoName)!.metadata!.pcuploadstate!)) as {
            staged?: { blocks: number; bytes: number };
        };
        return state.staged;
    };

    test("the record carries the accepted prefix after every block", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container, blockSize: 4 });
        const { uploadToken } = await store.createUpload({ key: "ledger.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, streamOf(asciiBytes("01234"), asciiBytes("56789")), { now: NOW });
        expect(ledgerOf(mock)).toEqual({ blocks: 2, bytes: 10 });
        await store.appendChunk(uploadToken, 10, asciiBytes("ab"), { now: NOW });
        expect(ledgerOf(mock)).toEqual({ blocks: 3, bytes: 12 });
    });

    test("a stale holder whose index the winner already had acknowledged stages nothing", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "fenced.bin", now: NOW });
        const { body, pulled, release } = parkedBody(asciiBytes("STALE"));
        const stale = store.appendChunk(uploadToken, 0, body, { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        // The winner appends at the same offset, so the same block index.
        await store.appendChunk(uploadToken, 0, asciiBytes("winner"), { now: NOW + 1 });
        release();

        const outcome = await stale;
        expect(outcome).toBeInstanceOf(UploadOffsetConflictError);
        expect((outcome as UploadOffsetConflictError).durableOffset).toBe(6);
        const block = mock.staged.get("fenced.bin")!.get(dataBlockId(segmentOn(mock, "fenced.bin"), 0))!;
        expect(new TextDecoder().decode(block)).toBe("winner");
        expect((await store.getUploadState(uploadToken)).offset).toBe(6);
        await completeDurable(store, uploadToken, { now: NOW + 2 });
        expect(new TextDecoder().decode(mock.committed.get("fenced.bin")!.content)).toBe("winner");
    });

    test("a winner recording the same index between the stage and its record is what the record refuses", async () => {
        // The instant the pre-stage read cannot cover: the winner's record
        // lands after this holder's stage. The recording write is pinned to
        // the version it read, loses, re-reads, and finds its index accepted.
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "instant.bin", now: NOW });
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        const blob = mock.committed.get(infoName)!;
        let reads = 0;
        const realClient = mock.container.getBlockBlobClient.bind(mock.container);
        mock.container.getBlockBlobClient = (blobName: string) => {
            const client = realClient(blobName);
            if (!blobName.endsWith(".info")) return client;
            return {
                ...client,
                async getProperties() {
                    const props = await client.getProperties();
                    reads += 1;
                    // Snapshot, pre-stage check, then the record's read: the
                    // winner's acknowledgement of index 0 lands after it.
                    if (reads === 3) {
                        const state = JSON.parse(fromBase64Url(blob.metadata!.pcuploadstate!)) as Record<
                            string,
                            unknown
                        >;
                        blob.metadata = {
                            pcuploadstate: toBase64Url(JSON.stringify({ ...state, staged: { blocks: 1, bytes: 6 } })),
                        };
                        blob.etag = '"winner"';
                    }
                    return props;
                },
            };
        };

        const outcome = await store.appendChunk(uploadToken, 0, asciiBytes("STALE"), { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        expect(outcome).toBeInstanceOf(UploadOffsetConflictError);
        expect((outcome as UploadOffsetConflictError).durableOffset).toBe(6);
        expect(reads).toBe(4);
        expect(ledgerOf(mock)).toEqual({ blocks: 1, bytes: 6 });
    });

    test("a block replaced under an acknowledged write invalidates the upload instead of publishing it", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "swapped.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abcd"), { now: NOW });
        // A stage that got past the fence in the instant before the winner's
        // record landed: the block list now holds other bytes under index 0.
        mock.staged.get("swapped.bin")!.set(dataBlockId(segmentOn(mock, "swapped.bin"), 0), asciiBytes("xy"));

        await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toThrow(
            /disagree with the accepted ledger/,
        );
        expect(mock.committed.has("swapped.bin")).toBe(false);
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(true);
    });

    test("a state read sees the replacement too", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "seen.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abcd"), { now: NOW });
        mock.staged.get("seen.bin")!.set(dataBlockId(segmentOn(mock, "seen.bin"), 0), asciiBytes("xy"));

        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        await expect(store.appendChunk(uploadToken, 4, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("a block staged by an append that crashed before recording it is counted, and the next append lands after it", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "crashed.bin", now: NOW });
        opts.failNextSetMetadata = true;
        await expect(store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW })).rejects.toThrow();
        // Nothing recorded past the empty ledger creation wrote.
        expect(ledgerOf(mock)).toEqual({ blocks: 0, bytes: 0 });

        // The listing runs ahead of the ledger: the block is durable and counted.
        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
        await store.appendChunk(uploadToken, 2, asciiBytes("cd"), { now: NOW + 1 });
        expect(ledgerOf(mock)).toEqual({ blocks: 2, bytes: 4 });
        await completeDurable(store, uploadToken, { now: NOW + 2 });
        expect(new TextDecoder().decode(mock.committed.get("crashed.bin")!.content)).toBe("abcd");
    });

    test("an append in flight when the resource was reaped stages nothing and writes nothing back", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "reaped.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        const { body, pulled, release } = parkedBody(bytes(3));
        const inFlight = store.appendChunk(uploadToken, 2, body, { now: NOW + 1 }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        await store.abortUpload(uploadToken);
        release();

        expect(await inFlight).toBeInstanceOf(UploadNotFoundError);
        // The sentinel and the one block acknowledged before the reap, left to
        // the service's collection; the in-flight body staged nothing.
        expect(mock.staged.get("reaped.bin")?.size).toBe(2);
        expect([...mock.committed.keys()]).toEqual([]);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a reaped append whose discard of the block it staged fails surfaces that failure", async () => {
        const failDeleteFor = new Set<string>();
        let reap: (() => Promise<void>) | undefined;
        const mock = mockUploadContainer({ failDeleteFor, beforeStage: async () => reap?.() });
        const store = azureUploadStore({ containerClient: mock.container, discardStaged: "commit-empty" });
        const { uploadToken } = await store.createUpload({ key: "reaped.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        // The reap lands after the pre-stage read found the record, so the block
        // is staged and only the record write finds the resource gone.
        reap = async () => {
            reap = undefined;
            await store.abortUpload(uploadToken);
            failDeleteFor.add("reaped.bin");
        };

        // The orphaned block is the operator's to hear about, not a silent 404.
        const err = await store.appendChunk(uploadToken, 2, bytes(3), { now: NOW + 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).not.toBeInstanceOf(UploadNotFoundError);
        expect((err as { statusCode?: number }).statusCode).toBe(403);
        // What the refused delete left: the empty blob the discard committed.
        expect(mock.committed.get("reaped.bin")?.content.length).toBe(0);
    });
});

// ─── The staged-state discard reclaims, and never deletes live data ─────────

describe('azureUploadStore: the staged-state discard (discardStaged "commit-empty")', () => {
    const discardingStore = (mock: ReturnType<typeof mockUploadContainer>) =>
        azureUploadStore({ containerClient: mock.container, discardStaged: "commit-empty" });

    for (const stagedOnlyIsPresentToDelete of [true, false]) {
        test(`abort reclaims staged blocks when a delete reads staged-only state as ${
            stagedOnlyIsPresentToDelete ? "present" : "absent"
        }`, async () => {
            const mock = mockUploadContainer({ stagedOnlyIsPresentToDelete });
            const store = discardingStore(mock);
            const { uploadToken } = await store.createUpload({ key: "reclaim.bin", now: NOW });
            await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });

            await store.abortUpload(uploadToken);
            expect(mock.staged.has("reclaim.bin")).toBe(false);
            expect(mock.committed.has("reclaim.bin")).toBe(false);
        });
    }

    test("the discard commits an empty create-only block list, then deletes that exact version", async () => {
        const deleteCalls: NonNullable<MockAzureUploadOpts["deleteCalls"]> = [];
        const commitCalls: NonNullable<MockAzureUploadOpts["commitCalls"]> = [];
        const mock = mockUploadContainer({ deleteCalls, commitCalls });
        const store = discardingStore(mock);
        const { uploadToken } = await store.createUpload({ key: "seq.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(commitCalls).toEqual([{ name: "seq.bin", blockIds: [], ifNoneMatch: "*" }]);
        const targetDeletes = deleteCalls.filter((c) => c.name === "seq.bin");
        expect(targetDeletes).toHaveLength(1);
        expect(targetDeletes[0]!.ifNoneMatch).toBeUndefined();
        expect(targetDeletes[0]!.ifMatch).toMatch(/^"azure-etag-\d+"$/);
    });

    test("a key with nothing staged is not touched (no zero-byte blob is ever published)", async () => {
        const commitCalls: NonNullable<MockAzureUploadOpts["commitCalls"]> = [];
        const mock = mockUploadContainer({ commitCalls });
        const store = discardingStore(mock);
        const { uploadToken } = await store.createUpload({ key: "gone.bin", now: NOW });
        mock.wipeStaged("gone.bin"); // aged out natively before the abort

        await store.abortUpload(uploadToken);
        expect(commitCalls).toEqual([]);
        expect(mock.committed.has("gone.bin")).toBe(false);
    });

    test("a blob committed at the key before the discard is refused by the service and left alone", async () => {
        // The create-only commit carries the precondition, so the service
        // decides in the request that would have replaced the blob.
        const commitCalls: NonNullable<MockAzureUploadOpts["commitCalls"]> = [];
        const mock = mockUploadContainer({ commitCalls });
        const store = discardingStore(mock);
        // The key holds a committed blob this upload was going to overwrite.
        await mock.container.getBlockBlobClient("raced.bin").upload("", 5, {});
        const { uploadToken } = await store.createUpload({ key: "raced.bin", now: NOW - 100_000 });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW - 100_000 });

        expect((await store.sweepExpired({ idleSinceMs: NOW })).removed).toBe(1);
        expect(commitCalls.find((c) => c.name === "raced.bin")?.ifNoneMatch).toBe("*");
        expect(mock.committed.get("raced.bin")!.content).toHaveLength(5);
    });

    test("a blob committed between the empty commit and the delete is refused by the service and left alone", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        opts.beforeDelete = (name) => {
            if (name !== "late.bin") return;
            opts.beforeDelete = undefined;
            // Another writer publishes at the key in the gap.
            mock.committed.set("late.bin", { content: bytes(9, 9), blocks: [], etag: '"other-writer"' });
        };
        const store = discardingStore(mock);
        const { uploadToken } = await store.createUpload({ key: "late.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });

        await store.abortUpload(uploadToken);
        expect(mock.committed.get("late.bin")!.etag).toBe('"other-writer"');
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a delete of the empty blob the service refuses with a 409 fails the abort instead of passing silently", async () => {
        // A retention policy or legal hold answers the delete with a 409, which
        // leaves the empty blob at the key: the caller must hear of it.
        const mock = mockUploadContainer();
        const realClient = mock.container.getBlockBlobClient.bind(mock.container);
        mock.container.getBlockBlobClient = (blobName: string) => {
            const client = realClient(blobName);
            if (blobName !== "held.bin") return client;
            return {
                ...client,
                async deleteIfExists() {
                    throw restError(409, "BlobImmutableDueToPolicy");
                },
            };
        };
        const store = discardingStore(mock);
        const { uploadToken } = await store.createUpload({ key: "held.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });

        await expect(store.abortUpload(uploadToken)).rejects.toMatchObject({ statusCode: 409 });
        expect(mock.committed.get("held.bin")?.content.length).toBe(0);
    });
});

// ─── The fence read before a stage fails closed ─────────────────────────────

describe("azureUploadStore: the record read before each stage", () => {
    test("a non-404 failure of that read fails the append before any block is staged", async () => {
        const stagedIds: string[] = [];
        // Read 1 is the append's own state read; read 2 is the fence before the stage.
        const opts: MockAzureUploadOpts = { stagedIds };
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "fence.bin", now: NOW });
        stagedIds.length = 0;
        opts.failNextInfoRead = { status: 503, afterReads: 1 };

        await expect(store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW })).rejects.toMatchObject({
            statusCode: 503,
        });
        expect(stagedIds).toEqual([]);
    });
});

// ─── The record cannot outgrow the metadata ceiling ─────────────────────────

describe("azureUploadStore: the record is measured at creation at its widest", () => {
    const infoValue = (mock: ReturnType<typeof mockUploadContainer>) => {
        const infoName = [...mock.committed.keys()].find((name) => name.endsWith(".info"))!;
        return mock.committed.get(infoName)!.metadata!.pcuploadstate!;
    };

    test("a record that would cross the ceiling once appended to is refused before anything is staged", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        await expect(
            store.createUpload({ key: "wide.bin", metadata: { note: "x".repeat(7000) }, now: NOW }),
        ).rejects.toThrow(/ceiling/);
        expect(mock.staged.size).toBe(0);
        expect(mock.committed.size).toBe(0);
    });

    test("a record admitted at creation stays under the ceiling through append and completion", async () => {
        const mock = mockUploadContainer();
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({
            key: "fits.bin",
            metadata: { note: "x".repeat(4000) },
            now: NOW,
        });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        expect(infoValue(mock).length).toBeLessThanOrEqual(7 * 1024);
    });
});

// ─── A refusal before the body is read releases it ──────────────────────────

/** A streaming body that records whether it was cancelled. */
function watchedBody(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(bytes(9));
        },
        cancel() {
            cancelled = true;
        },
    });
    return { body, cancelled: () => cancelled };
}

describe("azureUploadStore: a refusal before the body is read releases it", () => {
    test("an offset conflict cancels the body", async () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        const { uploadToken } = await store.createUpload({ key: "conflict.bin", now: NOW });
        const { body, cancelled } = watchedBody();
        await expect(store.appendChunk(uploadToken, 5, body, { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(cancelled()).toBe(true);
    });

    test("with a releaseBody handle, every refusal releases through it, never a second mechanism", async () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        const { uploadToken } = await store.createUpload({ key: "conflict.bin", now: NOW });
        for (const [token, offset, signal] of [
            [uploadToken, 5, undefined],
            ["AAAA", 0, undefined],
            [uploadToken, 0, AbortSignal.abort()],
        ] as const) {
            let released = 0;
            const { body, cancelled } = watchedBody();
            await store
                .appendChunk(token, offset, body, {
                    now: NOW,
                    ...(signal ? { signal } : {}),
                    releaseBody: async () => void released++,
                })
                .catch(() => undefined);
            expect(released).toBeGreaterThan(0);
            expect(cancelled()).toBe(false);
        }
    });

    test("an unknown upload cancels the body", async () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        const { body, cancelled } = watchedBody();
        await expect(store.appendChunk("AAAA", 0, body, { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(cancelled()).toBe(true);
    });

    test("a completed upload cancels the body", async () => {
        const store = azureUploadStore({ containerClient: mockUploadContainer().container });
        const { uploadToken } = await store.createUpload({ key: "done.bin", now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        const { body, cancelled } = watchedBody();
        await expect(store.appendChunk(uploadToken, 0, body, { now: NOW })).rejects.toThrow();
        expect(cancelled()).toBe(true);
    });
});

// ─── Completion is a sealed plan ─────────────────────────────────────────────

describe("azureUploadStore: completion seals its plan at the acknowledged length", () => {
    /** Settle a promise into its value or its rejection, without throwing. */
    const settle = <T>(p: Promise<T>): Promise<T | unknown> =>
        p.then(
            (v) => v,
            (err: unknown) => err,
        );

    test("an append whose block lands after the seal is refused and absent from the published blob", async () => {
        // The append passed its pre-stage read before the seal and stages after
        // it, while the completion holds its snapshot. Acknowledging it would
        // promise bytes the commit, made from that snapshot, leaves out.
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "sealed.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ab"), { now: NOW });

        const atCommit = Promise.withResolvers<void>();
        let completion: Promise<unknown> | undefined;
        opts.beforeStage = async () => {
            opts.beforeStage = undefined;
            completion = settle(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW + 1 }));
            await atCommit.promise;
        };
        opts.beforeCommit = async (name) => {
            if (name !== "sealed.bin") return;
            opts.beforeCommit = undefined;
            atCommit.resolve();
            await late;
        };
        // The hooks above run only once this append is under way.
        const late = settle(store.appendChunk(uploadToken, 2, asciiBytes("c"), { now: NOW + 1 }));

        const appended = await late;
        expect(appended).toBeInstanceOf(UploadOffsetConflictError);
        expect((appended as UploadOffsetConflictError).durableOffset).toBe(2);
        expect(await completion).toEqual({ etag: mock.committed.get("sealed.bin")!.etag });
        expect(new TextDecoder().decode(mock.committed.get("sealed.bin")!.content)).toBe("ab");
    });

    test("an append is refused before it stages anything while a seal is held", async () => {
        const stagedIds: string[] = [];
        const opts: MockAzureUploadOpts = { stagedIds };
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "held.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        // A completion that sealed and then failed to commit leaves its seal.
        opts.beforeCommit = () => {
            opts.beforeCommit = undefined;
            throw restError(500);
        };
        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW })).rejects.toMatchObject({
            statusCode: 500,
        });

        stagedIds.length = 0;
        const refused = await settle(store.appendChunk(uploadToken, 2, bytes(3), { now: NOW + 1 }));
        expect(refused).toBeInstanceOf(UploadOffsetConflictError);
        expect((refused as UploadOffsetConflictError).durableOffset).toBe(2);
        expect(stagedIds).toEqual([]);

        // The retry resumes the seal and publishes the plan it sealed.
        await store.completeUpload(uploadToken, { expectedLength: 2, now: NOW + 2 });
        expect(mock.committed.get("held.bin")!.content).toEqual(bytes(1, 2));
    });

    test("a snapshot of another length lifts the seal and answers the length it holds", async () => {
        const commitCalls: NonNullable<MockAzureUploadOpts["commitCalls"]> = [];
        const mock = mockUploadContainer({ commitCalls });
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "short.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });

        // A completer whose view predates the last append.
        const refused = await settle(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW }));
        expect(refused).toBeInstanceOf(UploadOffsetConflictError);
        expect((refused as UploadOffsetConflictError).durableOffset).toBe(3);
        expect(commitCalls).toEqual([]);

        // The seal is lifted: the upload resumes and completes at its real length.
        await store.appendChunk(uploadToken, 3, bytes(4), { now: NOW + 1 });
        await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW + 2 });
        expect(mock.committed.get("short.bin")!.content).toEqual(bytes(1, 2, 3, 4));
    });

    test("a blob written at the key between the seal and the commit is never overwritten", async () => {
        const opts: MockAzureUploadOpts = {};
        const mock = mockUploadContainer(opts);
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "raced.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        const foreign = { content: bytes(9, 9, 9), blocks: [], etag: '"foreign"' };
        opts.beforeCommit = () => {
            opts.beforeCommit = undefined;
            mock.committed.set("raced.bin", foreign);
        };

        await expect(store.completeUpload(uploadToken, { expectedLength: 2, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(mock.committed.get("raced.bin")).toBe(foreign);
        expect((await store.getUploadState(uploadToken)).status).not.toBe("complete");
    });

    test("an overwrite is conditioned on the blob the seal found at the key", async () => {
        const commitCalls: NonNullable<MockAzureUploadOpts["commitCalls"]> = [];
        const mock = mockUploadContainer({ commitCalls });
        await mock.container.getBlockBlobClient("over.bin").upload("", 5, {});
        const existing = mock.committed.get("over.bin")!.etag;
        const store = azureUploadStore({ containerClient: mock.container });
        const { uploadToken } = await store.createUpload({ key: "over.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });

        await store.completeUpload(uploadToken, { expectedLength: 1, now: NOW });
        expect(commitCalls.map(({ ifMatch, ifNoneMatch }) => ({ ifMatch, ifNoneMatch }))).toEqual([
            { ifMatch: existing, ifNoneMatch: undefined },
        ]);
        expect(mock.committed.get("over.bin")!.content).toEqual(bytes(1));
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
        expect(() => azureUploadStore({ containerClient: mockUploadContainer().container, blockSize: 0 })).toThrow(
            RangeError,
        );
    });
});
