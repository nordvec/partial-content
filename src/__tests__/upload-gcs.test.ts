import { describe, test, expect } from "bun:test";
import { isCorruptUploadState } from "../upload-internals";
import { gcsUploadStore, UploadNotFoundError, UploadOffsetConflictError, UploadDestinationConflictError } from "../gcs";
import { parkedBody } from "../parked-body";
import { threeByteUpload, expectGarbageTokensNotFound, completeDurable, publishedUpload } from "./helpers";

// ─── Mock GCS Storage (upload surface) ───────────────────────────────────────

const NOW = 1_800_000_000_000;

/** The 412 the client library surfaces when `ifGenerationMatch` does not hold. */
function gcsPreconditionFailed(): Error {
    const err = new Error("mock: precondition failed") as Error & { code: number };
    err.code = 412;
    return err;
}

function gcsNotFound(): Error {
    const err = new Error("No such object");
    (err as unknown as { code: number }).code = 404;
    return err;
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

interface MockGcsUploadOpts {
    /** Record every combine call's source count. */
    combineCalls?: Array<{ sources: string[]; destination: string }>;
    /** Emit an error on the chunk write stream after this many writes. */
    failStreamAfterWrites?: number;
    /** Return getFiles entries in reverse name order (proves numeric sorting). */
    reverseListings?: boolean;
    /** Override the size a listing reports for an object (undefined drops the field). */
    listedSize?: (name: string, actual: number) => string | undefined;
    /** Throw on the next combine call (crash mid-completion). */
    failNextCombine?: boolean;
    /**
     * Object names whose delete rejects with a non-404 backend error (a denied
     * or throttled call). Mutable, so a test can name an object the store
     * created and only then arm the failure.
     */
    failDeleteFor?: Set<string>;
    /** Observe every delete as it is asked for, before the fake acts on it. */
    onDelete?: (name: string) => void;
    /** Runs before every `.info` save, so a test can change the record under a merge. */
    beforeInfoSave?: (name: string) => void;
    /** Runs after every chunk listing, so a test can act in the window a completion races. */
    afterListing?: (prefix: string) => Promise<void> | void;
    /**
     * What listings and object metadata report in place of the real size, as
     * a malformed reply would: no size, or one that is not a decimal count.
     * Mutable, so a test can arm it once objects exist.
     */
    reportedSize?: "absent" | "unparseable";
    /** Record every copy (the publishing write). */
    copyCalls?: Array<{ source: string; destination: string }>;
    /** Combines onto a destination matching this pattern fail, as a backend error would. */
    failCombineTo?: RegExp;
    /** Every listing page as served: its query and how many objects it returned. */
    listings?: Array<{ prefix: string; delimiter?: string; returned: number }>;
    /** Serve at most this many objects per page whatever the query asks for. */
    pageSize?: number;
}

/**
 * Tiny once/off event target matching the adapter's writable surface. A
 * single-shot write is atomic: `onFinish` either stores the whole object or
 * refuses it, and a refusal is delivered as the stream's error.
 */
function makeWritable(onFinish: (content: Uint8Array) => void, opts: MockGcsUploadOpts) {
    const listeners = new Map<string, Array<(arg?: unknown) => void>>();
    const chunks: Uint8Array[] = [];
    let writes = 0;
    let destroyed = false;
    const emit = (event: string, arg?: unknown): void => {
        const queue = listeners.get(event) ?? [];
        listeners.set(event, []);
        for (const listener of queue) listener(arg);
    };
    return {
        write(chunk: Uint8Array): boolean {
            writes += 1;
            if (opts.failStreamAfterWrites !== undefined && writes > opts.failStreamAfterWrites) {
                queueMicrotask(() => emit("error", new Error("mock stream failure")));
                return true;
            }
            chunks.push(chunk.slice());
            return true;
        },
        end(): void {
            if (destroyed) return;
            try {
                onFinish(concat(chunks));
            } catch (err) {
                emit("error", err);
                return;
            }
            emit("finish");
        },
        destroy(_error?: Error): void {
            destroyed = true; // single-shot upload aborted: nothing durable
        },
        once(event: "drain" | "error" | "finish", listener: (arg?: unknown) => void): void {
            const queue = listeners.get(event) ?? [];
            queue.push(listener);
            listeners.set(event, queue);
        },
        off(event: "drain" | "error" | "finish", listener: (arg?: unknown) => void): void {
            const queue = listeners.get(event) ?? [];
            listeners.set(
                event,
                queue.filter((l) => l !== listener),
            );
        },
    };
}

function mockUploadStorage(opts: MockGcsUploadOpts = {}) {
    const objects = new Map<string, Uint8Array>();
    let etagCounter = 0;
    const etags = new Map<string, string>();
    /** Every write of a name mints the next generation, as the backend does. */
    const generations = new Map<string, number>();
    /** Custom metadata of the current version of each object; a new version starts with what its write set. */
    const customMetadata = new Map<string, Record<string, string>>();

    /**
     * The one precondition the store uses, as the backend applies it: `0` lands
     * only where nothing is, any other value only over that exact generation.
     */
    const requirePrecondition = (name: string, precondition?: { ifGenerationMatch?: number }): void => {
        const expected = precondition?.ifGenerationMatch;
        if (expected === undefined) return;
        const current = generations.get(name);
        if (expected === 0 ? current !== undefined : current !== expected) throw gcsPreconditionFailed();
    };
    const put = (name: string, content: Uint8Array, custom?: Record<string, string>): void => {
        etagCounter += 1;
        objects.set(name, content);
        if (custom) customMetadata.set(name, { ...custom });
        else customMetadata.delete(name);
        etags.set(name, `"gcs-etag-${etagCounter}"`);
        generations.set(name, etagCounter);
    };

    /** The size field as the fake reports it (see {@link MockGcsUploadOpts.reportedSize}). */
    const sizeField = (content: Uint8Array): { size?: string } =>
        opts.reportedSize === "absent"
            ? {}
            : { size: opts.reportedSize === "unparseable" ? `${content.length}abc` : String(content.length) };

    const bucket = {
        file(name: string) {
            return {
                async save(
                    data: Uint8Array | string,
                    saveOpts?: {
                        preconditionOpts?: { ifGenerationMatch?: number };
                        metadata?: { metadata: Record<string, string> };
                    },
                ) {
                    if (name.endsWith(".info")) opts.beforeInfoSave?.(name);
                    requirePrecondition(name, saveOpts?.preconditionOpts);
                    put(
                        name,
                        typeof data === "string" ? new TextEncoder().encode(data) : data.slice(),
                        saveOpts?.metadata?.metadata,
                    );
                },
                async copy(
                    destination: string,
                    copyOpts: {
                        preconditionOpts?: { ifGenerationMatch?: number };
                        metadata?: { metadata: Record<string, string> };
                    },
                ) {
                    const content = objects.get(name);
                    if (!content) throw gcsNotFound();
                    requirePrecondition(destination, copyOpts.preconditionOpts);
                    opts.copyCalls?.push({ source: name, destination });
                    put(destination, content.slice(), copyOpts.metadata?.metadata ?? customMetadata.get(name));
                    return {};
                },
                async download(): Promise<[Uint8Array]> {
                    const content = objects.get(name);
                    if (!content) throw gcsNotFound();
                    return [content.slice()];
                },
                async delete(deleteOpts?: { ignoreNotFound?: boolean; ifGenerationMatch?: number }) {
                    // The SDK's File.delete spreads its options into the query string, so a
                    // nested `preconditionOpts` is sent as an unknown parameter and the delete
                    // lands unconditionally; only a top-level `ifGenerationMatch` is a precondition.
                    if (deleteOpts && "preconditionOpts" in deleteOpts) {
                        throw new Error("mock: File.delete takes ifGenerationMatch at the top level");
                    }
                    opts.onDelete?.(name);
                    // Not a 404: `ignoreNotFound` must not paper over it.
                    if (opts.failDeleteFor?.has(name)) throw new Error("mock: delete denied");
                    if (objects.has(name)) requirePrecondition(name, deleteOpts);
                    if (!objects.has(name) && !deleteOpts?.ignoreNotFound) throw gcsNotFound();
                    objects.delete(name);
                    // A deleted name has no live generation: `ifGenerationMatch: 0` lands there again.
                    generations.delete(name);
                    customMetadata.delete(name);
                    return {};
                },
                createWriteStream(streamOpts?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
                    return makeWritable((content) => {
                        requirePrecondition(name, streamOpts?.preconditionOpts);
                        put(name, content);
                    }, opts);
                },
                async getMetadata(): Promise<
                    [{ size?: string; etag?: string; generation?: string; metadata?: Record<string, string> }]
                > {
                    const content = objects.get(name);
                    if (!content) throw gcsNotFound();
                    const custom = customMetadata.get(name);
                    return [
                        {
                            ...sizeField(content),
                            etag: etags.get(name),
                            generation: String(generations.get(name)),
                            ...(custom ? { metadata: { ...custom } } : {}),
                        },
                    ];
                },
            };
        },
        /**
         * One page of an `objects.list`: names after `pageToken`, in name order,
         * with names past a `delimiter` folded into prefixes and never returned.
         */
        async getFiles(query: {
            prefix: string;
            delimiter?: string;
            autoPaginate?: false;
            maxResults?: number;
            pageToken?: string;
        }): Promise<
            [
                Array<{ name: string; metadata?: { size?: string } }>,
                { pageToken: string } | null,
                { prefixes: string[] },
            ]
        > {
            const prefixes = new Set<string>();
            const matching = [...objects.entries()]
                .filter(([name]) => name.startsWith(query.prefix))
                .filter(([name]) => {
                    if (query.delimiter === undefined) return true;
                    const cut = name.indexOf(query.delimiter, query.prefix.length);
                    if (cut === -1) return true;
                    prefixes.add(name.slice(0, cut + query.delimiter.length));
                    return false;
                })
                .filter(([name]) => query.pageToken === undefined || name > query.pageToken)
                .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            const limit = Math.min(query.maxResults ?? Infinity, opts.pageSize ?? Infinity);
            const page = matching.slice(0, limit).map(([name, content]) => ({
                name,
                metadata: opts.listedSize ? { size: opts.listedSize(name, content.length) } : sizeField(content),
            }));
            opts.listings?.push({
                prefix: query.prefix,
                ...(query.delimiter !== undefined ? { delimiter: query.delimiter } : {}),
                returned: page.length,
            });
            await opts.afterListing?.(query.prefix);
            const next = matching.length > limit ? { pageToken: page.at(-1)!.name } : null;
            return [opts.reverseListings ? page.toReversed() : page, next, { prefixes: [...prefixes] }];
        },
        async combine(sources: string[], destination: string, combineOpts?: { ifGenerationMatch?: number }) {
            if (sources.length === 0) throw new Error("mock: compose requires at least one source");
            if (sources.length > 32) throw new Error("mock: compose accepts at most 32 sources");
            if (opts.failNextCombine) {
                opts.failNextCombine = false;
                throw new Error("mock: compose backend failure");
            }
            if (opts.failCombineTo?.test(destination)) throw new Error("mock: compose refused");
            requirePrecondition(destination, combineOpts);
            opts.combineCalls?.push({ sources: [...sources], destination });
            const pieces = sources.map((name) => {
                const content = objects.get(name);
                if (!content) throw gcsNotFound();
                return content;
            });
            put(destination, concat(pieces));
            return {};
        },
    };

    const storage = { bucket: (_name: string) => bucket };
    return { storage, objects, generations, customMetadata };
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

function makeStore(opts: MockGcsUploadOpts = {}) {
    const mock = mockUploadStorage(opts);
    const store = gcsUploadStore({ storage: mock.storage, bucket: "test-bucket" });
    return { ...mock, store };
}

// ─── Round Trip ──────────────────────────────────────────────────────────────

describe("gcsUploadStore: round trip", () => {
    test("create -> state -> append -> append -> complete composes onto the key and cleans chunks", async () => {
        const { store, objects } = makeStore();

        const { uploadToken } = await store.createUpload({
            key: "docs/report.pdf",
            length: 10,
            metadata: { filename: "report.pdf" },
            now: NOW,
        });

        const fresh = await store.getUploadState(uploadToken);
        expect(fresh.offset).toBe(0);
        expect(fresh.length).toBe(10);
        expect(fresh.status === "complete").toBe(false);
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
        expect(new TextDecoder().decode(objects.get("docs/report.pdf")!)).toBe("0123456789");

        // Every staging object is gone: only the published key and the info remain.
        const chunkKeys = [...objects.keys()].filter(
            (name) =>
                name.includes("/report") === false && name.endsWith(".info") === false && name !== "docs/report.pdf",
        );
        expect(chunkKeys).toEqual([]);

        const final = await store.getUploadState(uploadToken);
        expect(final.status === "complete").toBe(true);
        expect(final.offset).toBe(10);
    });

    test("completion is idempotent and replays the recorded etag", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await completeDurable(store, uploadToken, { now: NOW });
        const replay = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });
        const completed = await completeDurable(store, uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty.bin")!.length).toBe(0);
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "complete").toBe(true);
        expect(state.offset).toBe(0);
    });
});

// ─── Offset Derivation ───────────────────────────────────────────────────────

describe("gcsUploadStore: offset derivation from chunk listings", () => {
    test("offset is the sum of listed chunk-object sizes, foreign objects excluded", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "b.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        await store.appendChunk(uploadToken, 3, bytes(4, 5), { now: NOW });

        // A foreign object lands under the chunk prefix: never counted.
        const chunkName = [...objects.keys()].find((name) => /\/000000$/.test(name))!;
        const chunkDir = chunkName.slice(0, chunkName.lastIndexOf("/") + 1);
        objects.set(`${chunkDir}not-a-chunk`, bytes(9, 9, 9, 9, 9, 9, 9));

        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(5);
    });

    test("chunk objects are named by zero-padded append sequence", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "c.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await store.appendChunk(uploadToken, 1, bytes(2), { now: NOW });
        const chunkNames = [...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).toSorted();
        expect(chunkNames.map((name) => name.slice(-6))).toEqual(["000000", "000001"]);
    });

    test("a zero-byte append records activity without littering an empty chunk object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "d.bin", now: NOW });
        const result = await store.appendChunk(uploadToken, 0, new Uint8Array(0), { now: NOW + 5 });
        expect(result.bytesWritten).toBe(0);
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name))).toEqual([]);
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.lastAppendAt).toBe(NOW + 5);
    });
});

// ─── Recursive Compose ───────────────────────────────────────────────────────

describe("gcsUploadStore: recursive compose", () => {
    const appendSeventy = async (store: ReturnType<typeof makeStore>["store"], uploadToken: string) => {
        let offset = 0;
        for (let i = 0; i < 70; i++) {
            const chunk = asciiBytes(`[${String(i).padStart(2, "0")}]`);
            await store.appendChunk(uploadToken, offset, chunk, { now: NOW });
            offset += chunk.length;
        }
    };
    const expectOnlyBig = (objects: Map<string, Uint8Array>): void => {
        expect(new TextDecoder().decode(objects.get("big.bin")!)).toBe(seventy);
        expect([...objects.keys()].filter((name) => name !== "big.bin" && !name.endsWith(".info"))).toEqual([]);
    };

    const seventy = Array.from({ length: 70 }, (_, i) => `[${String(i).padStart(2, "0")}]`).join("");

    test("every 32 sources fold into a running composite, so completion composes at most 32", async () => {
        const combineCalls: Array<{ sources: string[]; destination: string }> = [];
        const copyCalls: Array<{ source: string; destination: string }> = [];
        // reverseListings proves the order comes from numeric sorting, not the listing order.
        const { store, objects } = makeStore({ combineCalls, copyCalls, reverseListings: true });
        const { uploadToken } = await store.createUpload({ key: "big.bin", now: NOW });
        await appendSeventy(store, uploadToken);

        // Chunks 0-31 fold into f000031; it and chunks 32-62 into f000062.
        expect(combineCalls.map((call) => call.destination.slice(-7))).toEqual(["f000031", "f000062"]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(seventy.length);

        await completeDurable(store, uploadToken, { now: NOW });
        // f000062 and chunks 63-69 fold once more, and one copy publishes it.
        expect(combineCalls.map((call) => call.sources.length)).toEqual([32, 32, 8]);
        expect(copyCalls.map((call) => call.destination)).toEqual(["big.bin"]);
        expectOnlyBig(objects);
    });

    test("an upload whose folds failed is reduced 32 sources at a time at completion, and every composite goes", async () => {
        const combineCalls: Array<{ sources: string[]; destination: string }> = [];
        // A fold that fails leaves its sources in place and the append acknowledged.
        const opts: MockGcsUploadOpts = { combineCalls, reverseListings: true, failCombineTo: /\/f\d{6}$/ };
        const { store, objects } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "big.bin", now: NOW });
        await appendSeventy(store, uploadToken);
        expect(combineCalls).toEqual([]);
        expect((await store.getUploadState(uploadToken)).offset).toBe(seventy.length);
        opts.failCombineTo = undefined;

        await completeDurable(store, uploadToken, { now: NOW });

        // 70 -> f000031 + 38; f000031 + 31 -> f000062 + 7; 8 -> f000069, which is published.
        expect(combineCalls.map((call) => [call.sources.length, call.destination.slice(-7)])).toEqual([
            [32, "f000031"],
            [32, "f000062"],
            [8, "f000069"],
        ]);
        expectOnlyBig(objects);
    });

    test("a crashed completion retries from intact chunks (chunks deleted only after the final compose)", async () => {
        const mockOpts: MockGcsUploadOpts = {};
        const { store, objects } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "retry.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("hello "), { now: NOW });
        await store.appendChunk(uploadToken, 6, asciiBytes("world"), { now: NOW });

        // The compose backend dies mid-completion.
        mockOpts.failNextCombine = true;
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/compose backend failure/);

        // The chunks survived the crash (deleted only after the final compose
        // succeeds), the resource is still incomplete, and a retry finishes.
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).length).toBe(2);
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(false);
        const completed = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(completed.etag).toBeDefined();
        expect(new TextDecoder().decode(objects.get("retry.bin")!)).toBe("hello world");
    });
});

// ─── Guards ──────────────────────────────────────────────────────────────────

describe("gcsUploadStore: guards", () => {
    test("claimed offset that lost to durable state throws UploadOffsetConflictError", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "e.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const err = await store.appendChunk(uploadToken, 5, bytes(4), { now: NOW }).catch((e) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
    });

    test("crossing maxBytes invalidates durably, leaves no chunk object, refuses everything after", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "f.bin", now: NOW });

        await expect(
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), {
                now: NOW,
                maxBytes: 4,
                maxBytesFatal: true,
            }),
        ).rejects.toThrow(/representation bound/);

        // The destroyed single-shot write left nothing durable.
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name))).toEqual([]);
        const state = await store.getUploadState(uploadToken);
        expect(state.status === "invalidated").toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(completeDurable(store, uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("expectedDigests throws a clear error instead of being silently ignored", async () => {
        const { store, objects } = makeStore();
        const store2 = store;
        expect(store2.digestOnComplete).toBe(false);
        const { uploadToken } = await store2.createUpload({ key: "g.bin", now: NOW });
        await store2.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            completeDurable(store2, uploadToken, { now: NOW, expectedDigests: { "sha-256": "x".repeat(43) + "=" } }),
        ).rejects.toThrow(/digestOnComplete/);
        expect(objects.has("g.bin")).toBe(false); // nothing published
    });

    test("a failing chunk write stream surfaces loudly and leaves the offset unchanged", async () => {
        const { store } = makeStore({ failStreamAfterWrites: 1 });
        const { uploadToken } = await store.createUpload({ key: "h.bin", now: NOW });
        await expect(
            store.appendChunk(uploadToken, 0, streamOf(bytes(1), bytes(2), bytes(3)), { now: NOW }),
        ).rejects.toThrow(/mock stream failure/);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0);
    });

    test("an aborted signal stops consumption but flushes already-received bytes", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "i.bin", now: NOW });
        const controller = new AbortController();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(streamController) {
                pulls += 1;
                if (pulls === 1) {
                    streamController.enqueue(bytes(1, 2, 3));
                } else {
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

describe("gcsUploadStore: deferred-length declaration on append", () => {
    test("a length first declared on an append is persisted and reported by the next state", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "deferred.bin", now: NOW });
        expect((await store.getUploadState(uploadToken)).length).toBeUndefined();

        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { length: 3, now: NOW + 1 });

        const state = await store.getUploadState(uploadToken);
        expect(state.length).toBe(3);
        expect(state.offset).toBe(3);
    });

    test("a length already recorded at creation is never overwritten by an append", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "fixed.bin", length: 9, now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { length: 42, now: NOW + 1 });
        expect((await store.getUploadState(uploadToken)).length).toBe(9);
    });
});

// ─── Not-Found + Token Integrity ─────────────────────────────────────────────

describe("gcsUploadStore: not-found and token integrity", () => {
    test("garbage tokens answer UploadNotFoundError, never a parse crash", async () => {
        const { store } = makeStore();
        await expectGarbageTokensNotFound(store, NOW);
    });

    test("aborted uploads answer UploadNotFoundError afterwards", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        await store.abortUpload(uploadToken);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a token that is not a minted id answers UploadNotFoundError", async () => {
        const { store } = makeStore();
        await store.createUpload({ key: "victim.bin", now: NOW });
        for (const forged of [
            "00000000-0000-4000-8000-000000000000", // well-formed, names nothing
            "eyJrZXkiOiJhdHRhY2tlci5iaW4ifQ", // the old key-bearing shape
            "../../etc/passwd",
            "",
        ]) {
            await expect(store.getUploadState(forged)).rejects.toBeInstanceOf(UploadNotFoundError);
        }
    });

    test("corrupt info content answers UploadNotFoundError", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        const infoName = [...objects.keys()].find((name) => name.endsWith(".info"))!;
        objects.set(infoName, asciiBytes("not json at all"));
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(isCorruptUploadState(await store.getUploadState(uploadToken).catch((e: unknown) => e))).toBe(true);
    });
});

// ─── Completion is recorded before the chunks go ─────────────────────────────

describe("gcsUploadStore: the completion record precedes the chunk cleanup", () => {
    const infoOf = (objects: Map<string, Uint8Array>) => {
        const name = [...objects.keys()].find((n) => n.endsWith(".info"))!;
        return JSON.parse(new TextDecoder().decode(objects.get(name))) as { isComplete: boolean; etag?: string };
    };

    test("the record is complete by the time the first chunk delete is asked for", async () => {
        // The other order leaves, after a crash between the compose and the
        // record, a live record over a partial chunk set: the retry recomposes
        // the survivors onto the key, a shorter object over the complete one.
        let recordAtFirstDelete: { isComplete: boolean } | undefined;
        const { store, objects } = makeStore({
            onDelete: (name) => {
                if (/\/\d{6}$/.test(name) && recordAtFirstDelete === undefined) recordAtFirstDelete = infoOf(objects);
            },
        });
        const { uploadToken } = await store.createUpload({ key: "rec.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        expect(recordAtFirstDelete?.isComplete).toBe(true);
    });

    test("a chunk the cleanup cannot delete does not fail the completion, and the retry answers from the record", async () => {
        const combineCalls: Array<{ sources: string[]; destination: string }> = [];
        const failDeleteFor = new Set<string>();
        const { store, objects } = makeStore({ combineCalls, failDeleteFor });
        const { uploadToken } = await store.createUpload({ key: "leftover.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        await store.appendChunk(uploadToken, 2, bytes(3), { now: NOW });
        const chunk = [...objects.keys()].find((n) => n.endsWith("/000001"))!;
        failDeleteFor.add(chunk);

        const first = await completeDurable(store, uploadToken, { now: NOW });
        expect(objects.get("leftover.bin")).toEqual(bytes(1, 2, 3));
        expect(objects.has(chunk)).toBe(true);
        expect(infoOf(objects)).toMatchObject({ isComplete: true, etag: first.etag });

        // The retry does not recompose the survivor onto the key.
        const again = await completeDurable(store, uploadToken, { now: NOW + 1 });
        expect(again.etag).toBe(first.etag);
        expect(combineCalls).toHaveLength(1);
        expect(objects.get("leftover.bin")).toEqual(bytes(1, 2, 3));
        expect((await store.getUploadState(uploadToken)).status === "complete").toBe(true);
    });

    for (const reap of ["abort", "sweep"] as const) {
        test(`${reap} of a completed upload reaps the chunk the cleanup left, never the object`, async () => {
            const failDeleteFor = new Set<string>();
            const { store, objects } = makeStore({ failDeleteFor });
            const { uploadToken } = await store.createUpload({ key: "done.bin", now: NOW - 100_000 });
            await store.appendChunk(uploadToken, 0, bytes(7), { now: NOW - 100_000 });
            const chunk = [...objects.keys()].find((n) => /\/\d{6}$/.test(n))!;
            failDeleteFor.add(chunk);
            await completeDurable(store, uploadToken, { now: NOW - 100_000 });
            expect(objects.has(chunk)).toBe(true);
            failDeleteFor.clear();

            if (reap === "abort") await store.abortUpload(uploadToken);
            else expect((await store.sweepExpired({ idleSinceMs: NOW })).removed).toBe(1);

            expect(objects.get("done.bin")).toEqual(bytes(7));
            expect([...objects.keys()]).toEqual(["done.bin"]);
        });
    }
});

// ─── A size nobody reported is never zero ───────────────────────────────────

describe("gcsUploadStore: a size the backend did not report is never counted", () => {
    const infoNameOf = (objects: Map<string, Uint8Array>) => [...objects.keys()].find((n) => n.endsWith(".info"))!;

    for (const reportedSize of ["absent", "unparseable"] as const) {
        test(`a chunk listed with an ${reportedSize} size fails the read and publishes nothing`, async () => {
            const opts: MockGcsUploadOpts = {};
            const { store, objects } = makeStore(opts);
            const uploadToken = await threeByteUpload(store, "nosize.bin", NOW, { complete: false });

            opts.reportedSize = reportedSize;
            await expect(store.getUploadState(uploadToken)).rejects.toThrow(/without a usable size/);
            await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow(
                /without a usable size/,
            );
            expect(objects.has("nosize.bin")).toBe(false);
        });
    }

    test("a published object whose metadata carries no size fails the completed read", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store } = makeStore(opts);
        const uploadToken = await threeByteUpload(store, "nosize-done.bin", NOW, { complete: true });

        opts.reportedSize = "absent";
        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/without a usable size/);
    });

    test("a deferred-length completion records its size, which answers once the published object is gone", async () => {
        const { store, objects } = makeStore();
        const uploadToken = await threeByteUpload(store, "deferred.bin", NOW, { complete: true });

        objects.delete("deferred.bin");
        const state = await store.getUploadState(uploadToken);
        expect(state.status).toBe("complete");
        expect(state.offset).toBe(3);
        expect(state.length).toBe(3);
    });

    test("an empty deferred-length completion records a length of zero", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty-deferred.bin", now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });

        objects.delete("empty-deferred.bin");
        const state = await store.getUploadState(uploadToken);
        expect(state.offset).toBe(0);
        expect(state.length).toBe(0);
    });

    test("a completed record that never recorded its size fails once the published object is gone", async () => {
        const { store, objects } = makeStore();
        const uploadToken = await threeByteUpload(store, "legacy-done.bin", NOW, { complete: true });
        const infoName = infoNameOf(objects);
        const record = JSON.parse(new TextDecoder().decode(objects.get(infoName))) as Record<string, unknown>;
        delete record.length;
        objects.set(infoName, new TextEncoder().encode(JSON.stringify(record)));

        objects.delete("legacy-done.bin");
        await expect(store.getUploadState(uploadToken)).rejects.toThrow(/recorded no length/);
    });
});

// ─── Writes pin to what they read ────────────────────────────────────────────

describe("gcsUploadStore: a stale holder's writes are refused", () => {
    /**
     * A holder whose lock was stolen while its body streamed acts on a
     * snapshot and a chunk index that are both minutes old. Its chunk write
     * pins to absence and its record write to the generation its own fresh
     * read returned, so neither lands over what the winner wrote.
     */

    test("the record is created on absence, and every later write pins to the generation it read", async () => {
        const { store, generations, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "pin.bin", now: NOW });
        const info = [...objects.keys()].find((n) => n.endsWith(".info"))!;
        const created = generations.get(info)!;
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW + 1 });
        expect(generations.get(info)).toBeGreaterThan(created);
    });

    test("a stale chunk write onto the index the winner already holds lands nothing", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "idx.bin", now: NOW });
        const { body, pulled, release } = parkedBody(asciiBytes("STALE"));
        const stale = store.appendChunk(uploadToken, 0, body, { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        // The winner appends at the same offset with the same next index.
        await store.appendChunk(uploadToken, 0, asciiBytes("winner"), { now: NOW + 1 });
        release();

        expect(await stale).toBeInstanceOf(Error);
        const chunk = [...objects.keys()].find((n) => n.endsWith("/000000"))!;
        expect(new TextDecoder().decode(objects.get(chunk))).toBe("winner");
        expect((await store.getUploadState(uploadToken)).offset).toBe(6);
        await completeDurable(store, uploadToken, { now: NOW + 2 });
        expect(new TextDecoder().decode(objects.get("idx.bin"))).toBe("winner");
    });

    test("a completion that lands during the chunk listing is answered from, not composed over", async () => {
        // The compose publishes whatever the listing returned, and the state that
        // authorised it was read before that listing. A completion in between has
        // already published the whole object and reaped the chunks it consumed,
        // so composing this listing would publish a SHORTER object over the
        // complete one and answer success for it.
        const opts: MockGcsUploadOpts = {};
        const copyCalls: Array<{ source: string; destination: string }> = [];
        opts.copyCalls = copyCalls;
        const { store, objects } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "race.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("first"), { now: NOW + 1 });
        await store.appendChunk(uploadToken, 5, asciiBytes("second"), { now: NOW + 2 });

        let winner: Awaited<ReturnType<typeof store.completeUpload>> | undefined;
        // Set BEFORE the inner call, which lists too and would otherwise re-enter
        // this hook forever.
        let raced = false;
        opts.afterListing = async () => {
            if (raced) return;
            raced = true;
            // The winner completes while the loser holds its listing.
            winner = await completeDurable(store, uploadToken, { now: NOW + 3 });
        };
        const loser = await completeDurable(store, uploadToken, { now: NOW + 4 });

        expect(new TextDecoder().decode(objects.get("race.bin"))).toBe("firstsecond");
        // The loser answers from the settled record instead of composing again.
        expect(winner?.etag).toBeDefined();
        expect(loser.etag).toBe(winner!.etag);
        expect(copyCalls.filter((c) => c.destination === "race.bin")).toHaveLength(1);
    });

    test("a stale record write cannot clear an invalidation the winner recorded", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "inv.bin", now: NOW });
        const { body, pulled, release } = parkedBody(bytes(9));
        const stale = store.appendChunk(uploadToken, 0, body, { now: NOW }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        // The winner crosses the representation bound: terminal, recorded.
        await expect(
            store.appendChunk(uploadToken, 0, bytes(1, 2, 3, 4), { maxBytes: 2, maxBytesFatal: true, now: NOW + 1 }),
        ).rejects.toThrow(/representation bound/);
        release();
        await stale;

        const info = [...objects.keys()].find((n) => n.endsWith(".info"))!;
        expect(JSON.parse(new TextDecoder().decode(objects.get(info))) as { isInvalidated: boolean }).toMatchObject({
            isInvalidated: true,
        });
        expect((await store.getUploadState(uploadToken)).status === "invalidated").toBe(true);
    });

    test("a record that changed under the merge is re-read and the merge lands on the new version", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store, objects, generations } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "cas.bin", now: NOW });
        const info = [...objects.keys()].find((n) => n.endsWith(".info"))!;
        let interposed = 0;
        opts.beforeInfoSave = () => {
            if (interposed > 0) return;
            interposed += 1;
            // Another writer lands a version between this merge's read and its
            // write: the pinned write is refused, and the merge re-reads.
            const record = JSON.parse(new TextDecoder().decode(objects.get(info))) as Record<string, unknown>;
            objects.set(info, asciiBytes(JSON.stringify({ ...record, metadata: { from: "the-other-writer" } })));
            generations.set(info, generations.get(info)! + 1);
            opts.beforeInfoSave = undefined;
        };
        await store.appendChunk(uploadToken, 0, bytes(1), { length: 1, now: NOW + 1 });
        expect(interposed).toBe(1);
        const record = JSON.parse(new TextDecoder().decode(objects.get(info))) as Record<string, unknown>;
        expect(record).toMatchObject({ length: 1, lastAppendAt: NOW + 1, metadata: { from: "the-other-writer" } });
    });

    test("a record that turned corrupt under the merge fails it and is never overwritten from the snapshot", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store, objects, generations } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "corrupt-merge.bin", now: NOW });
        const info = [...objects.keys()].find((n) => n.endsWith(".info"))!;
        opts.beforeInfoSave = () => {
            opts.beforeInfoSave = undefined;
            objects.set(info, asciiBytes("not json at all"));
            generations.set(info, generations.get(info)! + 1);
        };
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW + 1 })).rejects.toBeInstanceOf(
            UploadNotFoundError,
        );
        expect(new TextDecoder().decode(objects.get(info))).toBe("not json at all");
    });

    test("an append in flight when the resource was reaped does not write it back, and leaves no chunk behind", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "gone.bin", now: NOW });
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
        expect([...objects.keys()]).toEqual([]);
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("a reaped append whose chunk cannot be removed surfaces that failure: nothing else reclaims it", async () => {
        const failDeleteFor = new Set<string>();
        const { store, objects } = makeStore({ failDeleteFor });
        const { uploadToken } = await store.createUpload({ key: "gone.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        const first = [...objects.keys()].find((name) => /\/000000$/.test(name))!;
        const inFlightChunk = first.replace(/000000$/, "000001");
        const { body, pulled, release } = parkedBody(bytes(3));
        const inFlight = store.appendChunk(uploadToken, 2, body, { now: NOW + 1 }).then(
            () => undefined,
            (err: unknown) => err,
        );
        await pulled;
        await store.abortUpload(uploadToken);
        failDeleteFor.add(inFlightChunk);
        release();

        const err = await inFlight;
        expect(err).not.toBeInstanceOf(UploadNotFoundError);
        expect((err as Error).message).toBe("mock: delete denied");
        expect([...objects.keys()]).toEqual([inFlightChunk]);
    });
});

// ─── Abort + Sweep ───────────────────────────────────────────────────────────

describe("gcsUploadStore: abort and sweep", () => {
    test("abort deletes chunks, intermediates, and info, and is idempotent", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "l.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        await store.abortUpload(uploadToken);
        expect([...objects.keys()]).toEqual([]); // every staging artifact gone
        await store.abortUpload(uploadToken); // second abort: silent no-op
        await store.abortUpload("garbage-token"); // never-created: silent no-op
    });

    test("an append landing during the reclaim's listing is reclaimed too, not left behind", async () => {
        // The record is the only thing that names this upload's chunks. Removing
        // it while an append is still landing them would leave those bytes in the
        // bucket with nothing able to reach them: a deletion that reports success
        // and retains data. The record delete is pinned to the generation read
        // before the listing, and every append moves it.
        const opts: MockGcsUploadOpts = {};
        const { store, objects } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "reap.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1), { now: NOW });

        // Set BEFORE the inner call, which lists too and would otherwise re-enter
        // this hook forever.
        let raced = false;
        opts.afterListing = async () => {
            if (raced) return;
            raced = true;
            await store.appendChunk(uploadToken, 1, bytes(2), { now: NOW + 1 });
        };

        await store.abortUpload(uploadToken);

        expect(raced).toBe(true);
        expect([...objects.keys()]).toEqual([]); // the late chunk went with the rest
    });

    test("aborting a completed upload drops only the bookkeeping, never the published object", async () => {
        const { store, objects } = makeStore();
        const uploadToken = await publishedUpload(store, "m.bin", bytes(1, 2), NOW);
        await store.abortUpload(uploadToken);
        expect(objects.get("m.bin")).toEqual(bytes(1, 2));
        expect([...objects.keys()].filter((name) => name.endsWith(".info"))).toEqual([]);
    });

    test("sweepExpired reaps idle uploads by recorded activity and keeps active ones", async () => {
        const { store, objects } = makeStore();
        const stale = await store.createUpload({ key: "stale.bin", now: NOW - 100_000 });
        await store.appendChunk(stale.uploadToken, 0, bytes(1), { now: NOW - 90_000 });
        const active = await store.createUpload({ key: "active.bin", now: NOW - 100_000 });
        await store.appendChunk(active.uploadToken, 0, bytes(1), { now: NOW - 1_000 });

        const { removed } = await store.sweepExpired!({ idleSinceMs: NOW - 10_000 });
        expect(removed).toBe(1);
        await expect(store.getUploadState(stale.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        expect((await store.getUploadState(active.uploadToken)).offset).toBe(1);
        // The stale upload's chunk objects were reaped with it.
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).length).toBe(1);
    });

    test("sweeping a completed upload removes only the bookkeeping, never the published object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "done.bin", now: NOW - 100_000 });
        await store.appendChunk(uploadToken, 0, bytes(3, 4), { now: NOW - 100_000 });
        await completeDurable(store, uploadToken, { now: NOW - 100_000 });

        const { removed } = await store.sweepExpired!({ idleSinceMs: NOW });
        expect(removed).toBe(1);
        expect(objects.get("done.bin")).toEqual(bytes(3, 4));
    });

    test("a resource that cannot be reclaimed is counted, never allowed to end the scan", async () => {
        // A denied delete on one resource must not cost the resources behind
        // it in the listing: a scheduled sweep would then reclaim nothing for
        // as long as that one resource stayed unreclaimable, and would report
        // success by not throwing, which is a retention control that has
        // stopped working while still looking scheduled.
        const failDeleteFor = new Set<string>();
        const { store, objects } = makeStore({ failDeleteFor });
        const first = await store.createUpload({ key: "first.bin", now: NOW - 100_000 });
        await store.appendChunk(first.uploadToken, 0, bytes(1), { now: NOW - 100_000 });
        const second = await store.createUpload({ key: "second.bin", now: NOW - 100_000 });
        const infoNames = [...objects.keys()].filter((name) => name.endsWith(".info"));
        expect(infoNames).toHaveLength(2);
        failDeleteFor.add(infoNames[0]!);

        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 1 });
        await expect(store.getUploadState(second.uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
        // What could not be reclaimed is still listed, so the next pass
        // retries it rather than losing track of its bytes.
        expect([...objects.keys()]).toContain(infoNames[0]!);
        failDeleteFor.clear();
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 1, failed: 0 });
    });

    test("a record reclaimed from under the sweep is neither removed nor failed", async () => {
        // Another sweeper, or an abort, got there between the listing and the
        // read: nothing is left to retry, so nothing is left to alert on.
        const opts: MockGcsUploadOpts = {};
        const { store, objects } = makeStore(opts);
        await store.createUpload({ key: "raced.bin", now: NOW - 100_000 });
        const [info] = [...objects.keys()].filter((name) => name.endsWith(".info"));
        opts.afterListing = () => {
            objects.delete(info!);
        };
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
    });

    test("an object under the prefix that names no upload is not the sweep's to reap", async () => {
        const { store, objects } = makeStore();
        await store.createUpload({ key: "own.bin", now: NOW });
        const [info] = [...objects.keys()].filter((name) => name.endsWith(".info"));
        const foreign = `${info!.slice(0, info!.lastIndexOf("/") + 1)}notes.info`;
        objects.set(foreign, asciiBytes("not a record"));
        // Unreadable as a record and so "corrupt", which any age would reap,
        // were it the store's.
        expect(await store.sweepExpired!({ idleSinceMs: NOW - 10_000 })).toEqual({ removed: 0, failed: 0 });
        expect(objects.has(foreign)).toBe(true);
    });
});

// ─── Token Integrity Hardening ───────────────────────────────────────────────

describe("gcsUploadStore: token integrity hardening", () => {
    test("the token discloses nothing about the destination key", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "tenants/acme/payroll.csv", now: NOW });
        // The key routinely embeds a filename or a tenant id, and the token is
        // held by the client. Carrying the key would publish both to whoever
        // holds it, and would let a request name a key the server never
        // recorded; the token is the resource id and nothing else.
        expect(uploadToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(uploadToken).not.toContain("acme");
        expect(uploadToken).not.toContain("payroll");
    });

    test("abort with an id that names no resource discards nothing", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });

        await store.abortUpload("00000000-0000-4000-8000-000000000000");
        await store.abortUpload("not-a-token");

        // The victim's upload (info + chunks) is fully intact.
        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).length).toBe(1);
    });

    test("tokens are URL-safe whatever the key contains", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: ">>>???", now: NOW });
        expect(uploadToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0); // and still round-trips
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

describe("gcsUploadStore: a refusal before the body is read releases it", () => {
    test("an offset conflict cancels the body", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "conflict.bin", now: NOW });
        const { body, cancelled } = watchedBody();
        await expect(store.appendChunk(uploadToken, 5, body, { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
        expect(cancelled()).toBe(true);
    });

    test("with a releaseBody handle, every refusal releases through it, never a second mechanism", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "conflict.bin", now: NOW });
        for (const [token, offset, signal] of [
            [uploadToken, 5, undefined],
            ["00000000-0000-4000-8000-000000000000", 0, undefined],
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
        const { store } = makeStore();
        const { body, cancelled } = watchedBody();
        await expect(
            store.appendChunk("00000000-0000-4000-8000-000000000000", 0, body, { now: NOW }),
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(cancelled()).toBe(true);
    });

    test("a completed upload cancels the body", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "done.bin", now: NOW });
        await completeDurable(store, uploadToken, { now: NOW });
        const { body, cancelled } = watchedBody();
        await expect(store.appendChunk(uploadToken, 0, body, { now: NOW })).rejects.toThrow();
        expect(cancelled()).toBe(true);
    });
});

// ─── Capability Flags ────────────────────────────────────────────────────────

describe("gcsUploadStore: capability flags", () => {
    test("advertises exact offsets, atomic completion, no digest, byte-exact appends", () => {
        const { store } = makeStore();
        expect(store.exactOffsetRecovery).toBe(true);
        expect(store.atomicCompletion).toBe(true);
        expect(store.digestOnComplete).toBe(false);
        expect(store.appendGranularity).toBeUndefined();
        expect(store.uniformPartSize).toBeUndefined();
    });
});

// ─── Listed sizes and not-found causes ──────────────────────────────────────

describe("gcsUploadStore: listed sizes are counted, never guessed", () => {
    for (const [label, size] of [
        ["missing", undefined],
        ["non-numeric", "twelve"],
        ["negative", "-5"],
        ["fractional", "1.5"],
    ] as const) {
        test(`a chunk listed with a ${label} size fails the state read instead of counting as 0`, async () => {
            let lie = false;
            const { store } = makeStore({
                listedSize: (name, actual) => (lie && !name.endsWith(".info") ? size : String(actual)),
            });
            const { uploadToken } = await store.createUpload({ key: "k.bin", length: 10, now: NOW });
            await store.appendChunk(uploadToken, 0, asciiBytes("01234"), { now: NOW + 1 });
            lie = true;
            await expect(store.getUploadState(uploadToken)).rejects.toThrow(/usable size/);
        });
    }
});

describe("gcsUploadStore: a missing record keeps the backend's not-found as the cause", () => {
    test("getUploadState after abort throws UploadNotFoundError carrying the 404", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "k.bin", length: 10, now: NOW });
        await store.abortUpload(uploadToken);
        const err = await store.getUploadState(uploadToken).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadNotFoundError);
        expect((err as { cause?: { code?: number } }).cause?.code).toBe(404);
    });
});

// ─── Sealed completion ──────────────────────────────────────────────────────

const recordOf = (objects: Map<string, Uint8Array>): Record<string, unknown> => {
    const name = [...objects.keys()].find((n) => n.endsWith(".info"))!;
    return JSON.parse(new TextDecoder().decode(objects.get(name))) as Record<string, unknown>;
};
const text = (content: Uint8Array | undefined): string => new TextDecoder().decode(content);
const settle = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
        () => undefined,
        (err: unknown) => err,
    );

/** Admits "XYZ" at offset 3 and parks its body mid-read; 
elease lets the bytes arrive. */
const parkLateAppend = async (store: ReturnType<typeof makeStore>["store"], uploadToken: string) => {
    const { body, pulled, release } = parkedBody(asciiBytes("XYZ"));
    const late = settle(store.appendChunk(uploadToken, 3, body, { now: NOW + 1 }));
    await pulled;
    return { release, late };
};

describe("gcsUploadStore: completion is a sealed plan", () => {
    test("an append that lands after the seal is refused, removed, and absent from the published object", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store, objects } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "fence.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        // Admitted at offset 3 before the seal; its bytes arrive after it.
        const { release, late } = await parkLateAppend(store, uploadToken);

        let raced = false;
        opts.afterListing = async () => {
            if (raced) return;
            raced = true;
            // The completion holds its post-seal snapshot; the late append lands now.
            release();
            await late;
        };
        await store.completeUpload(uploadToken, { expectedLength: 3, now: NOW + 2 });

        const err = await late;
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
        expect(text(objects.get("fence.bin"))).toBe("abc");
        expect([...objects.keys()].filter((n) => /\/\d{6}$/.test(n))).toEqual([]);
        expect((await store.getUploadState(uploadToken)).status).toBe("complete");
    });

    test("a stale chunk that lands after the completion is refused, not acknowledged, and leaves no orphan", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "late.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        const { release, late } = await parkLateAppend(store, uploadToken);
        await store.completeUpload(uploadToken, { expectedLength: 3, now: NOW + 2 });
        release();

        expect(await late).toBeInstanceOf(Error);
        expect(String(await late)).toMatch(/already complete/);
        expect(text(objects.get("late.bin"))).toBe("abc");
        expect([...objects.keys()].filter((n) => n !== "late.bin" && !n.endsWith(".info"))).toEqual([]);
    });

    test("a destination written between the seal and the publish is a conflict, and the foreign object stays", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store, objects, storage } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "dest.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("ours"), { now: NOW });
        opts.afterListing = async () => {
            opts.afterListing = undefined;
            await storage.bucket("test-bucket").file("dest.bin").save(asciiBytes("theirs"));
        };

        await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        expect(text(objects.get("dest.bin"))).toBe("theirs");
        expect((await store.getUploadState(uploadToken)).status).toBe("incomplete");
        // The plan stays sealed: nothing may be appended to it.
        await expect(store.appendChunk(uploadToken, 4, bytes(1), { now: NOW })).rejects.toBeInstanceOf(
            UploadOffsetConflictError,
        );
    });

    test("an object already at the key when the seal is taken is the one the publish may replace", async () => {
        const { store, objects, storage } = makeStore();
        await storage.bucket("test-bucket").file("old.bin").save(asciiBytes("previous"));
        const { uploadToken } = await store.createUpload({ key: "old.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("next"), { now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 4, now: NOW });
        expect(text(objects.get("old.bin"))).toBe("next");
    });

    test("the published object carries the sealed publication id", async () => {
        const { store, customMetadata, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "id.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("x"), { now: NOW });
        await store.completeUpload(uploadToken, { expectedLength: 1, now: NOW });
        const seal = recordOf(objects).seal as { publicationId: string };
        expect(customMetadata.get("id.bin")).toEqual({ "partial-content-publication": seal.publicationId });
    });

    const lostRecord = (opts: MockGcsUploadOpts, copyCalls: unknown[]): void => {
        let lost = false;
        opts.beforeInfoSave = () => {
            if (lost || copyCalls.length === 0) return;
            lost = true;
            throw new Error("mock: record write lost");
        };
    };

    const completeLosingRecord = async (
        store: ReturnType<typeof makeStore>["store"],
        uploadToken: string,
        opts: MockGcsUploadOpts,
        copyCalls: unknown[],
    ): Promise<void> => {
        lostRecord(opts, copyCalls);
        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow(
            /record write lost/,
        );
    };

    test("a completion that published but failed to record is recovered by its publication id", async () => {
        const copyCalls: Array<{ source: string; destination: string }> = [];
        const opts: MockGcsUploadOpts = { copyCalls };
        const { store, objects } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "rec.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        await completeLosingRecord(store, uploadToken, opts, copyCalls);

        const retry = await store.completeUpload(uploadToken, { expectedLength: 3, now: NOW + 1 });
        expect(retry.etag).toBeDefined();
        expect(copyCalls).toHaveLength(1); // adopted, not published again
        expect(text(objects.get("rec.bin"))).toBe("abc");
        expect((await store.getUploadState(uploadToken)).status).toBe("complete");
    });

    test("a same-shape foreign object at the key is not adopted by a completion retry", async () => {
        const copyCalls: Array<{ source: string; destination: string }> = [];
        const opts: MockGcsUploadOpts = { copyCalls };
        const { store, objects, storage } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "shape.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        await completeLosingRecord(store, uploadToken, opts, copyCalls);
        // A third party replaces the key with the very same bytes.
        await storage.bucket("test-bucket").file("shape.bin").save(asciiBytes("abc"));
        const foreignGeneration = (await storage.bucket("test-bucket").file("shape.bin").getMetadata())[0].generation;

        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW + 1 })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        const [after] = await storage.bucket("test-bucket").file("shape.bin").getMetadata();
        expect(after.generation).toBe(foreignGeneration);
        expect(text(objects.get("shape.bin"))).toBe("abc");
        expect((await store.getUploadState(uploadToken)).status).toBe("incomplete");
    });

    test("a snapshot shorter than the sealed length is refused, publishes nothing, and lifts the seal", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "short.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });

        const err = await store.completeUpload(uploadToken, { expectedLength: 5, now: NOW }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(3);
        expect(objects.has("short.bin")).toBe(false);
        expect(recordOf(objects).seal).toBeUndefined();

        // Resumable: the client re-anchors at 3 and finishes.
        await store.appendChunk(uploadToken, 3, asciiBytes("de"), { now: NOW + 1 });
        await store.completeUpload(uploadToken, { expectedLength: 5, now: NOW + 2 });
        expect(text(objects.get("short.bin"))).toBe("abcde");
    });

    test("a retried completion at another length re-points the seal and keeps the destination it recorded", async () => {
        const opts: MockGcsUploadOpts = {};
        const { store, objects, storage } = makeStore(opts);
        const { uploadToken } = await store.createUpload({ key: "repoint.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("abc"), { now: NOW });
        // A first completion seals at 3 over an absent key, then dies before its listing.
        opts.afterListing = () => {
            opts.afterListing = undefined;
            throw new Error("mock: listing lost");
        };
        await expect(store.completeUpload(uploadToken, { expectedLength: 3, now: NOW })).rejects.toThrow(
            /listing lost/,
        );
        const first = recordOf(objects).seal as { destination: number; publicationId: string };
        expect(first.destination).toBe(0);
        // The key is written by someone else meanwhile, and a fenced append's
        // chunk that could not be removed sits after the sealed bytes.
        await storage.bucket("test-bucket").file("repoint.bin").save(asciiBytes("theirs"));
        const firstChunk = [...objects.keys()].find((n) => n.endsWith("/000000"))!;
        objects.set(firstChunk.replace(/000000$/, "000001"), asciiBytes("d"));

        // Re-pointed at 4, the plan still publishes only over the absent key the first seal found.
        await expect(store.completeUpload(uploadToken, { expectedLength: 4, now: NOW })).rejects.toBeInstanceOf(
            UploadDestinationConflictError,
        );
        const repointed = recordOf(objects).seal as { length: number; destination: number; publicationId: string };
        expect(repointed).toMatchObject({ length: 4, destination: 0 });
        expect(repointed.publicationId).not.toBe(first.publicationId);
        expect(text(objects.get("repoint.bin"))).toBe("theirs");
    });
});

describe("gcsUploadStore: listings stay bounded", () => {
    test("a state read lists the running composite and at most 31 chunks, however many appends landed", async () => {
        const listings: NonNullable<MockGcsUploadOpts["listings"]> = [];
        const { store, objects } = makeStore({ listings });
        const { uploadToken } = await store.createUpload({ key: "long.bin", now: NOW });
        for (let i = 0; i < 100; i++) await store.appendChunk(uploadToken, i, bytes(i), { now: NOW });

        listings.length = 0;
        expect((await store.getUploadState(uploadToken)).offset).toBe(100);
        expect(listings.reduce((sum, page) => sum + page.returned, 0)).toBeLessThanOrEqual(32);

        await store.completeUpload(uploadToken, { expectedLength: 100, now: NOW });
        expect([...objects.get("long.bin")!]).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    test("a stale append aimed at an index a composite already covers is refused and removed", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "covered.bin", now: NOW });
        for (let i = 0; i < 30; i++) await store.appendChunk(uploadToken, i, bytes(i), { now: NOW });
        // Admitted at index 30; the winner then writes 30 and 31, and 31 folds 0-31.
        const { body, pulled, release } = parkedBody(bytes(99));
        const stale = settle(store.appendChunk(uploadToken, 30, body, { now: NOW + 1 }));
        await pulled;
        await store.appendChunk(uploadToken, 30, bytes(30), { now: NOW + 2 });
        await store.appendChunk(uploadToken, 31, bytes(31), { now: NOW + 2 });
        expect([...objects.keys()].some((n) => n.endsWith("/f000031"))).toBe(true);
        release();

        const err = await stale;
        expect(err).toBeInstanceOf(UploadOffsetConflictError);
        expect((err as UploadOffsetConflictError).durableOffset).toBe(32);
        expect([...objects.keys()].some((n) => n.endsWith("/000030"))).toBe(false);
        expect((await store.getUploadState(uploadToken)).offset).toBe(32);
    });

    test("the sweep reads one delimited page of records at a time and never expands chunk directories", async () => {
        const listings: NonNullable<MockGcsUploadOpts["listings"]> = [];
        const { store, objects } = makeStore({ listings, pageSize: 1 });
        for (const key of ["a.bin", "b.bin", "c.bin"]) {
            const { uploadToken } = await store.createUpload({ key, now: NOW - 100_000 });
            await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW - 100_000 });
            await store.appendChunk(uploadToken, 2, bytes(3), { now: NOW - 100_000 });
        }
        listings.length = 0;

        expect(await store.sweepExpired({ idleSinceMs: NOW })).toEqual({ removed: 3, failed: 0 });
        const sweepPages = listings.filter((page) => page.prefix === ".partial-content-uploads/");
        expect(sweepPages.length).toBeGreaterThanOrEqual(3);
        for (const page of sweepPages) {
            expect(page.delimiter).toBe("/");
            expect(page.returned).toBeLessThanOrEqual(1);
        }
        expect([...objects.keys()]).toEqual([]);
    });
});
