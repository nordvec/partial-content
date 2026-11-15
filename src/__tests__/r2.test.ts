import { describe, test, expect } from "bun:test";
import { r2Store, ObjectNotFoundError, ObjectChangedError, type R2StoreOptions } from "../r2";

// ─── Mock R2 Bucket ─────────────────────────────────────────────────────────

const CONTENT = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes
const UPLOADED = new Date("2025-06-28T12:00:00Z");

function sha256Buf(): ArrayBuffer {
    // Fixed 32-byte buffer standing in for a SHA-256 checksum.
    return new Uint8Array(32).fill(7).buffer;
}

/**
 * The bucket surface the adapter consumes, read off the adapter's own option
 * type. Deriving it binds the double to the contract, and keeps the union the
 * binding really returns: a failed `onlyIf` precondition resolves to a
 * body-less object, which a body-only mock shape could not express.
 */
type R2Bucket = R2StoreOptions["bucket"];

interface MockR2Opts {
    /** Override the range the mock reports as actually returned. */
    reportedRange?: { offset: number; length: number };
    /** Object is missing. */
    missing?: boolean;
    /** Include a sha256 checksum. */
    withChecksum?: boolean;
}

function mockBucket(opts: MockR2Opts = {}): R2Bucket {
    const base = {
        key: "test.bin",
        size: CONTENT.length,
        etag: "abc123etag",
        uploaded: UPLOADED,
        checksums: { sha256: opts.withChecksum ? sha256Buf() : undefined },
    };
    return {
        async head(_key: string) {
            return opts.missing ? null : base;
        },
        async get(_key: string, options?: { range?: { offset: number; length: number } }) {
            if (opts.missing) return null;
            const requested = options?.range;
            const actual = opts.reportedRange ?? requested;
            const slice = actual ? CONTENT.slice(actual.offset, actual.offset + actual.length) : CONTENT;
            return {
                ...base,
                body: new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(slice);
                        c.close();
                    },
                }),
                range: actual ?? { offset: 0, length: CONTENT.length },
            };
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("r2Store: headObject", () => {
    test("maps R2 metadata to ObjectMetadata", async () => {
        const store = r2Store({ bucket: mockBucket({ withChecksum: true }) });
        const meta = await store.headObject("test.bin");

        expect(meta.contentLength).toBe(20);
        expect(meta.etag).toBe("abc123etag");
        expect(meta.lastModified).toBe(UPLOADED.toUTCString());
        // 32 bytes of 0x07 -> base64
        expect(meta.digest).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString("base64"));
    });

    test("omits digest when R2 has no sha256 checksum", async () => {
        const store = r2Store({ bucket: mockBucket() });
        const meta = await store.headObject("test.bin");
        expect(meta.digest).toBeUndefined();
    });

    test("throws ObjectNotFoundError for missing objects", async () => {
        const store = r2Store({ bucket: mockBucket({ missing: true }) });
        await expect(store.headObject("gone.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("pre-aborted signal rejects", async () => {
        const store = r2Store({ bucket: mockBucket() });
        const ac = new AbortController();
        ac.abort();
        await expect(store.headObject("test.bin", { signal: ac.signal })).rejects.toThrow("The operation was aborted");
    });
});

describe("r2Store: getObject", () => {
    test("full get has no served range", async () => {
        const store = r2Store({ bucket: mockBucket() });
        const result = await store.getObject("test.bin");

        expect(result.range).toBeUndefined();
        expect(result.contentLength).toBe(20);
        expect(result.totalSize).toBe(20);
    });

    test("ranged get reports the range R2 actually returned", async () => {
        const store = r2Store({ bucket: mockBucket() });
        const result = await store.getObject("test.bin", { range: { start: 5, end: 9 } });

        expect(result.range).toEqual({ start: 5, end: 9 });
        expect(result.contentLength).toBe(5);
    });

    test("R2's actual range wins when it differs from the request", async () => {
        // R2 clamped the requested 5-99 to offset 5, length 3 (object changed).
        const store = r2Store({
            bucket: mockBucket({ reportedRange: { offset: 5, length: 3 } }),
        });
        const result = await store.getObject("test.bin", { range: { start: 5, end: 99 } });

        expect(result.range).toEqual({ start: 5, end: 7 });
        expect(result.contentLength).toBe(3);
    });

    test("throws ObjectNotFoundError for missing objects", async () => {
        const store = r2Store({ bucket: mockBucket({ missing: true }) });
        await expect(store.getObject("gone.bin")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("ifMatch is forwarded as onlyIf.etagMatches", async () => {
        const seen: Array<string | undefined> = [];
        const bucket = mockBucket();
        const origGet = bucket.get.bind(bucket);
        bucket.get = (
            key: string,
            options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } },
        ) => {
            seen.push(options?.onlyIf?.etagMatches);
            return origGet(key, options);
        };
        const store = r2Store({ bucket });
        await store.getObject("test.bin", { ifMatch: "abc123etag" });

        expect(seen).toEqual(["abc123etag"]);
    });

    test("body-less onlyIf response maps to ObjectChangedError", async () => {
        const bucket = mockBucket();
        // R2's onlyIf failure mode: resolves with metadata but NO body.
        bucket.get = async () => ({
            key: "test.bin",
            size: CONTENT.length,
            etag: "new-etag",
            uploaded: UPLOADED,
            checksums: {},
        });
        const store = r2Store({ bucket });

        await expect(store.getObject("test.bin", { ifMatch: "abc123etag" })).rejects.toBeInstanceOf(ObjectChangedError);
    });
});

describe("r2Store: open range wire translation", () => {
    test("an open-ended range becomes an offset-only R2 read (no length field)", async () => {
        const seen: Array<{ offset: number; length?: number } | undefined> = [];
        const bucket = mockBucket();
        const origGet = bucket.get.bind(bucket);
        bucket.get = ((key: string, options?: { range?: { offset: number; length?: number } }) => {
            seen.push(options?.range);
            // R2 itself reads to end for an offset-only range.
            return origGet(key, { ...options, range: { offset: 5, length: 15 } });
        }) as typeof bucket.get;

        const store = r2Store({ bucket });
        const result = await store.getObject("test.bin", { range: { start: 5, end: undefined } });

        // An open range MUST NOT surface as a length.
        expect(seen[0]).toEqual({ offset: 5 });
        expect(result.range).toEqual({ start: 5, end: 19 });
        expect(result.contentLength).toBe(15);
    });
});

// ─── Recording doubles ──────────────────────────────────────────────────────

interface Recorded {
    heads: number;
    gets: Array<{ key: string; options: unknown }>;
}

/** A bucket over an object of `CONTENT` that counts every binding call. */
function recordingBucket(report?: () => { offset: number; length: number }): {
    bucket: R2Bucket;
    calls: Recorded;
} {
    const calls: Recorded = { heads: 0, gets: [] };
    const base = {
        key: "k",
        size: CONTENT.length,
        etag: "e",
        uploaded: UPLOADED,
        checksums: {},
    };
    const bucket: R2Bucket = {
        async head() {
            calls.heads++;
            return base;
        },
        async get(key, options) {
            calls.gets.push({ key, options });
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(CONTENT);
                    c.close();
                },
            });
            return { ...base, body, ...(report ? { range: report() } : {}) };
        },
    };
    return { bucket, calls };
}

describe("r2Store: capability flags", () => {
    test("the store serves ranges and reports an authoritative range", () => {
        const store = r2Store({ bucket: mockBucket() });
        expect(store.supportsRange).toBe(true);
        expect(store.authoritativeRange).toBe(true);
    });
});

describe("r2Store: reserved key namespace", () => {
    const RESERVED = [".partial-content-uploads/x", ".partial-content-uploads/a/b", ".partial-content-uploads"];

    test.each(RESERVED)("a read of %s is refused before the binding is called", async (key) => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket });
        await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject(key, { range: { start: 0, end: 1 } })).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(calls.heads).toBe(0);
        expect(calls.gets).toHaveLength(0);
    });

    test("a sibling that only shares the prefix text is readable", async () => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket });
        await store.headObject(".partial-content-uploads-other/x");
        expect(calls.heads).toBe(1);
    });

    test("an empty reservedPrefix reserves nothing", async () => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket, reservedPrefix: "" });
        await store.headObject(".partial-content-uploads/x");
        await store.getObject(".partial-content-uploads/x");
        expect(calls.heads).toBe(1);
        expect(calls.gets.map((g) => g.key)).toEqual([".partial-content-uploads/x"]);
    });

    test("a custom prefix list replaces the default", async () => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket, reservedPrefix: ["a/", "b"] });
        await expect(store.headObject("a/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("b/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await store.headObject(".partial-content-uploads/x");
        expect(calls.heads).toBe(1);
        expect(calls.gets).toHaveLength(0);
    });

    test("the error carries the key but its message does not name it", async () => {
        const store = r2Store({ bucket: recordingBucket().bucket });
        const err = await store.headObject(".partial-content-uploads/secret-name").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ObjectNotFoundError);
        expect((err as ObjectNotFoundError).key).toBe(".partial-content-uploads/secret-name");
        expect((err as Error).message).not.toMatch(/secret-name/);
    });
});

describe("r2Store: key policy", () => {
    test("keys are verbatim by default: an empty segment reaches the binding as spelled", async () => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket });
        await store.headObject("a//b");
        await store.getObject("a//b");
        expect(calls.heads).toBe(1);
        expect(calls.gets.map((g) => g.key)).toEqual(["a//b"]);
    });

    test("keys: 'plain' refuses an empty or dot segment before the binding is called", async () => {
        const { bucket, calls } = recordingBucket();
        const store = r2Store({ bucket, keys: "plain" });
        await expect(store.headObject("a//b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("a/../b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(calls.heads).toBe(0);
        expect(calls.gets).toHaveLength(0);
    });

    test("keys: 'plain' still reads a plain key", async () => {
        const { bucket, calls } = recordingBucket();
        await r2Store({ bucket, keys: "plain" }).headObject("a/b");
        expect(calls.heads).toBe(1);
    });
});

describe("r2Store: get options and served span", () => {
    test("a plain whole-object read passes no get options", async () => {
        const { bucket, calls } = recordingBucket();
        await r2Store({ bucket }).getObject("k");
        expect(calls.gets[0]!.options).toBeUndefined();
    });

    test("a ranged read without ifMatch carries no onlyIf", async () => {
        const { bucket, calls } = recordingBucket();
        await r2Store({ bucket }).getObject("k", { range: { start: 2, end: 4 } });
        expect(calls.gets[0]!.options).toEqual({ range: { offset: 2, length: 3 } });
    });

    test("an ifMatch read without a range carries onlyIf alone", async () => {
        const { bucket, calls } = recordingBucket();
        await r2Store({ bucket }).getObject("k", { ifMatch: "e" });
        expect(calls.gets[0]!.options).toEqual({ onlyIf: { etagMatches: "e" } });
    });

    test("the request is the answer when the binding reports no range", async () => {
        const { bucket } = recordingBucket();
        const store = r2Store({ bucket });
        const closed = await store.getObject("k", { range: { start: 3, end: 7 } });
        expect(closed.range).toEqual({ start: 3, end: 7 });
        expect(closed.contentLength).toBe(5);
        const open = await store.getObject("k", { range: { start: 5, end: undefined } });
        expect(open.range).toEqual({ start: 5, end: 19 });
        expect(open.contentLength).toBe(15);
    });

    test("a reported offset wins over the requested start", async () => {
        const { bucket } = recordingBucket(() => ({ offset: 8, length: 2 }));
        const result = await r2Store({ bucket }).getObject("k", { range: { start: 3, end: 4 } });
        expect(result.range).toEqual({ start: 8, end: 9 });
        expect(result.contentLength).toBe(2);
    });

    test("a reported offset of zero is kept, not replaced by the requested start", async () => {
        const { bucket } = recordingBucket(() => ({ offset: 0, length: 4 }));
        const result = await r2Store({ bucket }).getObject("k", { range: { start: 6, end: 9 } });
        expect(result.range).toEqual({ start: 0, end: 3 });
    });
});

describe("r2Store: options argument", () => {
    test("headObject and getObject accept an options object without a signal", async () => {
        const store = r2Store({ bucket: mockBucket() });
        expect((await store.headObject("test.bin", {})).contentLength).toBe(20);
        expect((await store.getObject("test.bin", {})).contentLength).toBe(20);
    });

    test("a pre-aborted signal rejects getObject before the binding is called", async () => {
        const { bucket, calls } = recordingBucket();
        const ac = new AbortController();
        ac.abort();
        await expect(r2Store({ bucket }).getObject("k", { signal: ac.signal })).rejects.toThrow(
            "The operation was aborted",
        );
        expect(calls.gets).toHaveLength(0);
    });
});

describe("r2Store: precondition failure shapes", () => {
    test("an object whose body is null maps to ObjectChangedError", async () => {
        const bucket = mockBucket();
        bucket.get = (async () => ({
            key: "k",
            size: CONTENT.length,
            etag: "e",
            uploaded: UPLOADED,
            checksums: {},
            body: null,
        })) as unknown as R2Bucket["get"];
        await expect(r2Store({ bucket }).getObject("k", { ifMatch: "x" })).rejects.toBeInstanceOf(ObjectChangedError);
    });
});
