import { describe, test, expect } from "bun:test";
import { r2Store, ObjectNotFoundError, ObjectChangedError } from "../r2";

// ─── Mock R2 Bucket ─────────────────────────────────────────────────────────

const CONTENT = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes
const UPLOADED = new Date("2025-06-28T12:00:00Z");

function sha256Buf(): ArrayBuffer {
    // Fixed 32-byte buffer standing in for a SHA-256 checksum.
    return new Uint8Array(32).fill(7).buffer;
}

interface MockR2Opts {
    /** Override the range the mock reports as actually returned. */
    reportedRange?: { offset: number; length: number };
    /** Object is missing. */
    missing?: boolean;
    /** Include a sha256 checksum. */
    withChecksum?: boolean;
}

function mockBucket(opts: MockR2Opts = {}) {
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
            const slice = actual
                ? CONTENT.slice(actual.offset, actual.offset + actual.length)
                : CONTENT;
            return {
                ...base,
                body: new ReadableStream<Uint8Array>({
                    start(c) { c.enqueue(slice); c.close(); },
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
        await expect(store.headObject("test.bin", { signal: ac.signal })).rejects.toThrow();
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
        bucket.get = (key: string, options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } }) => {
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

        await expect(
            store.getObject("test.bin", { ifMatch: "abc123etag" }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
    });
});
