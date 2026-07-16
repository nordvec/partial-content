import { describe, test, expect } from "bun:test";
import { gcsUploadStore, UploadNotFoundError, UploadOffsetConflictError } from "../gcs";

// ─── Mock GCS Storage (upload surface) ───────────────────────────────────────

const NOW = 1_800_000_000_000;

function gcsNotFound(): Error {
    const err = new Error("No such object");
    (err as unknown as { code: number }).code = 404;
    return err;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
}

interface MockGcsUploadOpts {
    /** Record every combine call's source count. */
    combineCalls?: Array<{ sources: string[]; destination: string }>;
    /** Emit an error on the chunk write stream after this many writes. */
    failStreamAfterWrites?: number;
    /** Return getFiles entries in reverse name order (proves numeric sorting). */
    reverseListings?: boolean;
    /** Throw on the next combine call (crash mid-completion). */
    failNextCombine?: boolean;
}

/** Tiny once/off event target matching the adapter's writable surface. */
function makeWritable(
    onFinish: (content: Uint8Array) => void,
    opts: MockGcsUploadOpts,
) {
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
            onFinish(concat(chunks));
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
            listeners.set(event, queue.filter((l) => l !== listener));
        },
    };
}

function mockUploadStorage(opts: MockGcsUploadOpts = {}) {
    const objects = new Map<string, Uint8Array>();
    let etagCounter = 0;
    const etags = new Map<string, string>();

    const bucket = {
        file(name: string) {
            return {
                async save(data: Uint8Array | string) {
                    etagCounter += 1;
                    objects.set(name, typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
                    etags.set(name, `"gcs-etag-${etagCounter}"`);
                },
                async download(): Promise<[Uint8Array]> {
                    const content = objects.get(name);
                    if (!content) throw gcsNotFound();
                    return [content.slice()];
                },
                async delete(deleteOpts?: { ignoreNotFound?: boolean }) {
                    if (!objects.has(name) && !deleteOpts?.ignoreNotFound) throw gcsNotFound();
                    objects.delete(name);
                    return {};
                },
                createWriteStream() {
                    return makeWritable((content) => {
                        etagCounter += 1;
                        objects.set(name, content);
                        etags.set(name, `"gcs-etag-${etagCounter}"`);
                    }, opts);
                },
                async getMetadata(): Promise<[{ size?: string; etag?: string }]> {
                    const content = objects.get(name);
                    if (!content) throw gcsNotFound();
                    return [{ size: String(content.length), etag: etags.get(name) }];
                },
            };
        },
        async getFiles(query: { prefix: string }): Promise<[Array<{ name: string; metadata?: { size?: string } }>]> {
            const entries = [...objects.entries()]
                .filter(([name]) => name.startsWith(query.prefix))
                .map(([name, content]) => ({ name, metadata: { size: String(content.length) } }))
                .toSorted((a, b) => a.name.localeCompare(b.name));
            return [opts.reverseListings ? entries.toReversed() : entries];
        },
        async combine(sources: string[], destination: string) {
            if (sources.length === 0) throw new Error("mock: compose requires at least one source");
            if (sources.length > 32) throw new Error("mock: compose accepts at most 32 sources");
            if (opts.failNextCombine) {
                opts.failNextCombine = false;
                throw new Error("mock: compose backend failure");
            }
            opts.combineCalls?.push({ sources: [...sources], destination });
            const pieces = sources.map((name) => {
                const content = objects.get(name);
                if (!content) throw gcsNotFound();
                return content;
            });
            etagCounter += 1;
            objects.set(destination, concat(pieces));
            etags.set(destination, `"gcs-etag-${etagCounter}"`);
            return {};
        },
    };

    const storage = { bucket: (_name: string) => bucket };
    return { storage, objects };
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
        expect(fresh.isComplete).toBe(false);
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
        expect(new TextDecoder().decode(objects.get("docs/report.pdf")!)).toBe("0123456789");

        // Every staging object is gone: only the published key and the info remain.
        const chunkKeys = [...objects.keys()].filter((name) => name.includes("/report") === false && name.endsWith(".info") === false && name !== "docs/report.pdf");
        expect(chunkKeys).toEqual([]);

        const final = await store.getUploadState(uploadToken);
        expect(final.isComplete).toBe(true);
        expect(final.offset).toBe(10);
    });

    test("completion is idempotent and replays the recorded etag", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "a.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2, 3), { now: NOW });
        const first = await store.completeUpload(uploadToken, { now: NOW });
        const replay = await store.completeUpload(uploadToken, { now: NOW + 1 });
        expect(replay.etag).toBe(first.etag!);
    });

    test("zero-byte completion publishes an empty object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "empty.bin", length: 0, now: NOW });
        const completed = await store.completeUpload(uploadToken, { now: NOW });
        expect(completed.etag).toBeDefined();
        expect(objects.get("empty.bin")!.length).toBe(0);
        const state = await store.getUploadState(uploadToken);
        expect(state.isComplete).toBe(true);
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
    test("70 chunks compose through <=32-source intermediates that are deleted after use", async () => {
        const combineCalls: Array<{ sources: string[]; destination: string }> = [];
        // reverseListings proves the compose order comes from numeric sorting,
        // not the listing order.
        const { store, objects } = makeStore({ combineCalls, reverseListings: true });
        const { uploadToken } = await store.createUpload({ key: "big.bin", now: NOW });

        let offset = 0;
        for (let i = 0; i < 70; i++) {
            const chunk = asciiBytes(`[${String(i).padStart(2, "0")}]`);
            await store.appendChunk(uploadToken, offset, chunk, { now: NOW });
            offset += chunk.length;
        }

        await store.completeUpload(uploadToken, { now: NOW });

        // Level 0: 70 -> 3 intermediates (32 + 32 + 6); final: 3 -> key.
        expect(combineCalls.map((call) => call.sources.length)).toEqual([32, 32, 6, 3]);
        expect(combineCalls[3]!.destination).toBe("big.bin");
        for (const call of combineCalls) {
            expect(call.sources.length).toBeLessThanOrEqual(32);
        }

        // Content is every chunk in append order.
        const expected = Array.from({ length: 70 }, (_, i) => `[${String(i).padStart(2, "0")}]`).join("");
        expect(new TextDecoder().decode(objects.get("big.bin")!)).toBe(expected);

        // Intermediates and chunks are all gone: published object + info only.
        const remaining = [...objects.keys()].toSorted();
        expect(remaining.filter((name) => name.includes(".compose/"))).toEqual([]);
        expect(remaining.filter((name) => /\/\d{6}$/.test(name))).toEqual([]);
        expect(remaining).toContain("big.bin");
    });

    test("a crashed completion retries from intact chunks (chunks deleted only after the final compose)", async () => {
        const mockOpts: MockGcsUploadOpts = {};
        const { store, objects } = makeStore(mockOpts);
        const { uploadToken } = await store.createUpload({ key: "retry.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, asciiBytes("hello "), { now: NOW });
        await store.appendChunk(uploadToken, 6, asciiBytes("world"), { now: NOW });

        // The compose backend dies mid-completion.
        mockOpts.failNextCombine = true;
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/compose backend failure/);

        // The chunks survived the crash (deleted only after the final compose
        // succeeds), the resource is still incomplete, and a retry finishes.
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).length).toBe(2);
        expect((await store.getUploadState(uploadToken)).isComplete).toBe(false);
        const completed = await store.completeUpload(uploadToken, { now: NOW + 1 });
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
            store.appendChunk(uploadToken, 0, streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), { now: NOW, maxBytes: 4 }),
        ).rejects.toThrow(/byte bound/);

        // The destroyed single-shot write left nothing durable.
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name))).toEqual([]);
        const state = await store.getUploadState(uploadToken);
        expect(state.isInvalidated).toBe(true);
        await expect(store.appendChunk(uploadToken, 0, bytes(1), { now: NOW })).rejects.toThrow(/invalidated/);
        await expect(store.completeUpload(uploadToken, { now: NOW })).rejects.toThrow(/invalidated/);
    });

    test("expectedDigest throws a clear error instead of being silently ignored", async () => {
        const { store, objects } = makeStore();
        const store2 = store;
        expect(store2.digestOnComplete).toBe(false);
        const { uploadToken } = await store2.createUpload({ key: "g.bin", now: NOW });
        await store2.appendChunk(uploadToken, 0, bytes(1), { now: NOW });
        await expect(
            store2.completeUpload(uploadToken, { now: NOW, expectedDigest: "x".repeat(43) + "=" }),
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

// ─── Not-Found + Token Integrity ─────────────────────────────────────────────

describe("gcsUploadStore: not-found and token integrity", () => {
    test("garbage tokens answer UploadNotFoundError, never a parse crash", async () => {
        const { store } = makeStore();
        await expect(store.getUploadState("!!!not-base64!!!")).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.appendChunk("AAAA", 0, bytes(1), { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(store.completeUpload("e30", { now: NOW })).rejects.toBeInstanceOf(UploadNotFoundError);
    });

    test("aborted uploads answer UploadNotFoundError afterwards", async () => {
        const { store } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "j.bin", now: NOW });
        await store.abortUpload(uploadToken);
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

    test("corrupt info content answers UploadNotFoundError", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "k.bin", now: NOW });
        const infoName = [...objects.keys()].find((name) => name.endsWith(".info"))!;
        objects.set(infoName, asciiBytes("not json at all"));
        await expect(store.getUploadState(uploadToken)).rejects.toBeInstanceOf(UploadNotFoundError);
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

    test("aborting a completed upload drops only the bookkeeping, never the published object", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "m.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        await store.completeUpload(uploadToken, { now: NOW });
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

        const { removed } = await store.sweepExpired!(NOW - 10_000);
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
        await store.completeUpload(uploadToken, { now: NOW - 100_000 });

        const { removed } = await store.sweepExpired!(NOW);
        expect(removed).toBe(1);
        expect(objects.get("done.bin")).toEqual(bytes(3, 4));
    });
});

// ─── Token Integrity Hardening ───────────────────────────────────────────────

describe("gcsUploadStore: token integrity hardening", () => {
    test("abort with a forged (valid-id, wrong-key) token discards nothing", async () => {
        const { store, objects } = makeStore();
        const { uploadToken } = await store.createUpload({ key: "victim.bin", now: NOW });
        await store.appendChunk(uploadToken, 0, bytes(1, 2), { now: NOW });
        const decoded = JSON.parse(new TextDecoder().decode(
            Uint8Array.from(atob(uploadToken.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
        )) as { key: string; id: string };
        const forged = btoa(JSON.stringify({ key: "attacker.bin", id: decoded.id }))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        await store.abortUpload(forged);
        // The victim's upload (info + chunks) is fully intact.
        expect((await store.getUploadState(uploadToken)).offset).toBe(2);
        expect([...objects.keys()].filter((name) => /\/\d{6}$/.test(name)).length).toBe(1);
    });

    test("tokens are URL-safe even when the key's base64 needs + and /", async () => {
        const { store } = makeStore();
        // ">>>" base64-encodes with "+" and "???" with "/": both must be
        // translated to the URL-safe alphabet and pad-stripped.
        const { uploadToken } = await store.createUpload({ key: ">>>???", now: NOW });
        expect(uploadToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect((await store.getUploadState(uploadToken)).offset).toBe(0); // and still round-trips
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
