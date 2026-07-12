import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveObject } from "../web";
import { fsStore, ObjectNotFoundError } from "../fs";

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "partial-content-fs-"));
    await writeFile(join(root, "hello.txt"), "0123456789abcdefghij"); // 20 bytes
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "deep.txt"), "nested-content");
    // 256 KiB: above SMALL_READ_LIMIT, exercises the ReadStream path.
    await writeFile(join(root, "big.bin"), Buffer.alloc(256 * 1024, 0x61));
    // Exactly AT the limit: the positional-read boundary is inclusive.
    await writeFile(join(root, "limit.bin"), Buffer.alloc(128 * 1024, 0x62));
    // Device-name LOOKALIKES (no digit after com/lpt): ordinary filenames
    // that must serve; only real reserved names are rejected on Windows.
    await writeFile(join(root, "comx.txt"), "test");
    await writeFile(join(root, "lptx.txt"), "test");
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

describe("fsStore: headObject", () => {
    test("returns size and HTTP-date Last-Modified", async () => {
        const store = fsStore({ root });
        const meta = await store.headObject("hello.txt");

        expect(meta.contentLength).toBe(20);
        // IMF-fixdate: "Sat, 28 Jun 2025 12:00:00 GMT"
        expect(meta.lastModified).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    });

    test("exposes a weak validator derived once from size + mtime", async () => {
        const store = fsStore({ root });
        const meta = await store.headObject("hello.txt");

        // W/"<size-hex>-<mtime-seconds-hex>": stable across calls, matches
        // what getObject reports for the same representation, so the
        // orchestrator never re-derives validators per request.
        expect(meta.etag).toMatch(/^W\/"14-[0-9a-f]+"$/); // 0x14 = 20 bytes
        const result = await store.getObject("hello.txt");
        expect(result.etag).toBe(meta.etag!);
        await drain(result.body);
    });

    test("resolves nested keys", async () => {
        const store = fsStore({ root });
        const meta = await store.headObject("nested/deep.txt");
        expect(meta.contentLength).toBe(14);
    });

    test("throws ObjectNotFoundError for a missing file", async () => {
        const store = fsStore({ root });
        await expect(store.headObject("missing.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("throws ObjectNotFoundError for a directory", async () => {
        const store = fsStore({ root });
        await expect(store.headObject("nested")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("rejects path traversal outside the root", async () => {
        const store = fsStore({ root: join(root, "nested") });
        await expect(store.headObject("../hello.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject("..\\hello.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("rejects Windows cross-drive, device, and ADS keys", async () => {
        const store = fsStore({ root });
        // A cross-drive key must never escape the root. On Windows the guard
        // rejects it before open(); on POSIX it is an unusual filename that
        // does not exist. Either way: not-found, never another volume's bytes.
        await expect(store.headObject("D:\\secrets\\private.key")).rejects.toBeInstanceOf(ObjectNotFoundError);

        if (process.platform === "win32") {
            // Reserved device names resolve to hardware from any directory, and
            // alternate-data-stream keys reach a hidden stream: reject both.
            for (const key of ["NUL", "CON", "COM1", "aux.txt", "hello.txt::$DATA", "C:relative.txt"]) {
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
        }
    });

    test("rejects null bytes in keys as not-found, not a runtime error", async () => {
        const store = fsStore({ root });
        await expect(store.headObject("hello\0.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("hello\0.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("device-name lookalikes without a digit serve normally", async () => {
        // com/lpt are only reserved WITH a trailing digit; comx/lptx are
        // ordinary filenames and the Windows guard must not over-match.
        const store = fsStore({ root });
        expect((await store.headObject("comx.txt")).contentLength).toBe(4);
        expect((await store.headObject("lptx.txt")).contentLength).toBe(4);
    });

    test("a path THROUGH a file is not-found (ENOTDIR), not a crash", async () => {
        const store = fsStore({ root });
        await expect(store.headObject("hello.txt/child")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("hello.txt/child")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("accepts an empty options object (no signal)", async () => {
        const store = fsStore({ root });
        expect((await store.headObject("hello.txt", {})).contentLength).toBe(20);
    });
});

describe("fsStore: getObject", () => {
    test("streams the full file", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("hello.txt");

        expect(await drain(result.body)).toBe("0123456789abcdefghij");
        expect(result.contentLength).toBe(20);
        expect(result.totalSize).toBe(20);
        expect(result.range).toBeUndefined();
    });

    test("streams a byte range with a matching Content-Range", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("hello.txt", { range: { start: 5, end: 9 } });

        expect(await drain(result.body)).toBe("56789");
        expect(result.contentLength).toBe(5);
        expect(result.totalSize).toBe(20);
        expect(result.range).toEqual({ start: 5, end: 9 });
    });

    test("streams a single-byte range", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("hello.txt", { range: { start: 19, end: 19 } });
        expect(await drain(result.body)).toBe("j");
    });

    test("throws ObjectNotFoundError for a missing file", async () => {
        const store = fsStore({ root });
        await expect(store.getObject("missing.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("throws ObjectNotFoundError for a directory (handle is closed, not leaked)", async () => {
        const store = fsStore({ root });
        await expect(store.getObject("nested")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("aborted signal rejects before any I/O", async () => {
        const store = fsStore({ root });
        const ac = new AbortController();
        ac.abort();
        await expect(store.getObject("hello.txt", { signal: ac.signal })).rejects.toThrow();
    });

    test("small transfers return bytes with the handle already closed", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("hello.txt");
        // Below the single-read limit the body is a plain Uint8Array: no
        // stream to cancel, no handle held (afterAll rm() proves release).
        expect(result.body).toBeInstanceOf(Uint8Array);
    });

    test("range end beyond EOF is clamped; reported range matches served bytes", async () => {
        // fsStore is public API: a direct caller with an unclamped range must
        // get coherent bounds, never a short body under inflated bounds.
        const store = fsStore({ root });
        const result = await store.getObject("hello.txt", { range: { start: 10, end: 999 } });

        expect(await drain(result.body)).toBe("abcdefghij");
        expect(result.contentLength).toBe(10);
        expect(result.range).toEqual({ start: 10, end: 19 });
    });

    test("range start beyond EOF throws loudly instead of serving lying bounds", async () => {
        const store = fsStore({ root });
        await expect(
            store.getObject("hello.txt", { range: { start: 20, end: 25 } }),
        ).rejects.toBeInstanceOf(RangeError);
    });

    test("weak validator distinguishes same-size writes within one second (ns mtime)", async () => {
        // The classic weak-ETag hazard: two same-length writes in the same
        // wall-clock second. Second-floored validators collide (false-fresh
        // 304 for changed bytes); nanosecond mtime resolution must not.
        const p = join(root, "nsclash.bin");
        await writeFile(p, "AAAA");
        const base = Math.floor(Date.now() / 1000);
        await utimes(p, base, base + 0.111);
        const store = fsStore({ root });
        const first = (await store.headObject("nsclash.bin")).etag;

        await writeFile(p, "BBBB"); // same size, different bytes
        await utimes(p, base, base + 0.888); // same integer second
        const second = (await store.headObject("nsclash.bin")).etag;

        expect(first).toMatch(/^W\/"4-[0-9a-f]+"$/);
        expect(second).not.toBe(first);
    });
});

describe("fsStore: large transfers (ReadStream path, above the single-read limit)", () => {
    test("streams a 256 KiB file in full", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("big.bin");

        const body = await drain(result.body);
        expect(body.length).toBe(256 * 1024);
        expect(result.contentLength).toBe(256 * 1024);
        expect(result.totalSize).toBe(256 * 1024);
    });

    test("streams a >128 KiB range with correct bounds", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("big.bin", {
            range: { start: 1024, end: 1024 + 200 * 1024 - 1 },
        });

        const body = await drain(result.body);
        expect(body.length).toBe(200 * 1024);
        expect(result.range).toEqual({ start: 1024, end: 1024 + 200 * 1024 - 1 });
    });

    test("cancelling a large stream releases the handle (temp dir removable)", async () => {
        const store = fsStore({ root });
        const result = await store.getObject("big.bin");
        // Cancel without reading: autoClose must release the handle so the
        // afterAll rm() does not fail with EBUSY on Windows.
        await result.body.cancel();
    });

    test("a file exactly at the single-read limit takes the byte-body fast path", async () => {
        // The boundary is inclusive: exactly 128 KiB is one positional read
        // (Uint8Array body), not a ReadStream.
        const store = fsStore({ root });
        const result = await store.getObject("limit.bin");
        expect(result.body).toBeInstanceOf(Uint8Array);
        expect(result.contentLength).toBe(128 * 1024);
    });
});

describe("fsStore: opt-in hot-object cache", () => {
    test("second full read of a small file is served from memory (no fs churn)", async () => {
        const store = fsStore({ root, cache: { ttlMs: 60_000 } });
        const first = await store.getObject("hello.txt");
        expect(await drain(first.body)).toBe("0123456789abcdefghij");

        // Cached: byte body, zero-copy, coherent metadata.
        const second = await store.getObject("hello.txt");
        expect(second.body).toBeInstanceOf(Uint8Array);
        expect(await drain(second.body)).toBe("0123456789abcdefghij");
        expect(second.totalSize).toBe(20);
        expect(second.lastModified).toBe(first.lastModified);
    });

    test("ranges are served as zero-copy views of the cached body", async () => {
        const store = fsStore({ root, cache: { ttlMs: 60_000 } });
        await store.getObject("hello.txt"); // populate

        const ranged = await store.getObject("hello.txt", { range: { start: 5, end: 9 } });
        expect(await drain(ranged.body)).toBe("56789");
        expect(ranged.range).toEqual({ start: 5, end: 9 });
        expect(ranged.totalSize).toBe(20);
    });

    test("headObject hits populate metadata and expire on TTL", async () => {
        const store = fsStore({ root, cache: { ttlMs: 30 } });
        const before = await store.headObject("hello.txt");
        expect(before.contentLength).toBe(20);

        // Within TTL: served from cache (observable indirectly: identical values).
        const hit = await store.headObject("hello.txt");
        expect(hit.lastModified).toBe(before.lastModified);

        // After TTL: revalidates against disk without error.
        await new Promise((r) => setTimeout(r, 50));
        const revalidated = await store.headObject("hello.txt");
        expect(revalidated.contentLength).toBe(20);
    });

    test("stale reads are bounded by ttlMs (nginx open_file_cache semantics)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-cache-"));
        try {
            await writeFile(join(dir, "mut.txt"), "version-one!");
            const store = fsStore({ root: dir, cache: { ttlMs: 40 } });

            expect(await drain((await store.getObject("mut.txt")).body)).toBe("version-one!");
            await writeFile(join(dir, "mut.txt"), "version-TWO!");

            // Within TTL the old (coherent) representation may still serve.
            const stale = await store.getObject("mut.txt");
            expect(["version-one!", "version-TWO!"]).toContain(await drain(stale.body));

            // Past TTL the new content MUST serve.
            await new Promise((r) => setTimeout(r, 60));
            expect(await drain((await store.getObject("mut.txt")).body)).toBe("version-TWO!");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("LRU eviction respects maxEntries", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-lru-"));
        try {
            for (let i = 0; i < 3; i++) await writeFile(join(dir, `f${i}.txt`), `body-${i}`);
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxEntries: 2 } });

            await store.getObject("f0.txt");
            await store.getObject("f1.txt");
            await store.getObject("f0.txt"); // touch f0 (most recent)
            await store.getObject("f2.txt"); // evicts f1

            // All still serve correctly regardless of cache state.
            for (let i = 0; i < 3; i++) {
                expect(await drain((await store.getObject(`f${i}.txt`)).body)).toBe(`body-${i}`);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("maxEntries eviction actually evicts (proven by disk misses)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-evict-"));
        try {
            for (let i = 0; i < 3; i++) await writeFile(join(dir, `f${i}.txt`), `body-${i}`);
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxEntries: 2 } });

            await drain((await store.getObject("f0.txt")).body);
            await drain((await store.getObject("f1.txt")).body);
            await drain((await store.getObject("f2.txt")).body); // at capacity: evicts f0

            // f1/f2 serve from memory (files removed first)...
            await rm(join(dir, "f1.txt"));
            await rm(join(dir, "f2.txt"));
            expect(await drain((await store.getObject("f1.txt")).body)).toBe("body-1");
            expect(await drain((await store.getObject("f2.txt")).body)).toBe("body-2");

            // ...and f0 was genuinely evicted: its next read hits disk and misses.
            await rm(join(dir, "f0.txt"));
            await expect(store.getObject("f0.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a range read never caches its slice as the full body", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-slice-"));
        try {
            await writeFile(join(dir, "r.txt"), "0123456789");
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });

            // Range first (no prior full read): bytes must NOT enter the cache;
            // caching the slice would serve 4 bytes as the whole object later.
            expect(await drain((await store.getObject("r.txt", { range: { start: 0, end: 3 } })).body)).toBe("0123");

            await rm(join(dir, "r.txt"));
            await expect(store.getObject("r.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a full-span range read also stays out of the byte cache", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-span-"));
        try {
            await writeFile(join(dir, "r.txt"), "0123456789");
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });

            // Even when the range happens to cover the whole object, only
            // FULL (rangeless) reads may populate bodies: the rule is on the
            // read shape, not the byte count.
            expect(await drain((await store.getObject("r.txt", { range: { start: 0, end: 9 } })).body)).toBe("0123456789");

            await rm(join(dir, "r.txt"));
            await expect(store.getObject("r.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a body exactly at maxBytes is cached (budget boundary is inclusive)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-exact-"));
        try {
            await writeFile(join(dir, "six.txt"), "sixby!"); // 6 bytes == budget
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 6 } });

            await drain((await store.getObject("six.txt")).body);
            await rm(join(dir, "six.txt"));
            expect(await drain((await store.getObject("six.txt")).body)).toBe("sixby!");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("bodies that exactly fill the budget are both retained (no over-eviction)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-fit-"));
        try {
            await writeFile(join(dir, "a.txt"), "aaaaaa"); // 6 bytes
            await writeFile(join(dir, "b.txt"), "bbbbbb"); // 6 bytes -> exactly 12
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 12 } });

            await drain((await store.getObject("a.txt")).body);
            await drain((await store.getObject("b.txt")).body);
            await rm(join(dir, "a.txt"));
            await rm(join(dir, "b.txt"));
            expect(await drain((await store.getObject("a.txt")).body)).toBe("aaaaaa");
            expect(await drain((await store.getObject("b.txt")).body)).toBe("bbbbbb");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("the default budget retains multiple near-limit bodies", async () => {
        // Two ~100 KiB bodies fit comfortably in the 64 MiB default; a
        // mis-scaled default (KiB instead of MiB) would cache neither.
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-default-"));
        try {
            await writeFile(join(dir, "x.bin"), Buffer.alloc(100 * 1024, 0x78));
            await writeFile(join(dir, "y.bin"), Buffer.alloc(100 * 1024, 0x79));
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });

            await drain((await store.getObject("x.bin")).body);
            await drain((await store.getObject("y.bin")).body);
            await rm(join(dir, "x.bin"));
            await rm(join(dir, "y.bin"));
            expect((await store.getObject("x.bin")).contentLength).toBe(100 * 1024);
            expect((await store.getObject("y.bin")).contentLength).toBe(100 * 1024);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("byte budget evicts least-recent bodies (maxBytes)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-bytes-"));
        try {
            for (let i = 0; i < 3; i++) await writeFile(join(dir, `f${i}.txt`), `body-${i}`); // 6 bytes each
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 14 } });

            await drain((await store.getObject("f0.txt")).body); // 6 bytes cached
            await drain((await store.getObject("f1.txt")).body); // 12 bytes cached
            await drain((await store.getObject("f2.txt")).body); // 18 > 14 -> evicts f0

            // f1 and f2 still serve from memory (files removed first).
            await rm(join(dir, "f1.txt"));
            await rm(join(dir, "f2.txt"));
            expect(await drain((await store.getObject("f1.txt")).body)).toBe("body-1");
            expect(await drain((await store.getObject("f2.txt")).body)).toBe("body-2");

            // f0 was evicted: its next read must go to disk (and miss).
            await rm(join(dir, "f0.txt"));
            await expect(store.getObject("f0.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a body larger than maxBytes is served but cached metadata-only", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-oversize-"));
        try {
            await writeFile(join(dir, "small.txt"), "abc"); // 3 bytes
            await writeFile(join(dir, "big.txt"), "0123456789"); // 10 bytes > budget
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 5 } });

            await drain((await store.getObject("small.txt")).body); // cached (3 <= 5)
            const oversized = await store.getObject("big.txt");
            expect(await drain(oversized.body)).toBe("0123456789"); // served normally

            // The oversized insert must not have flushed the small body.
            await rm(join(dir, "small.txt"));
            expect(await drain((await store.getObject("small.txt")).body)).toBe("abc");

            // And the oversized body itself was never cached.
            await rm(join(dir, "big.txt"));
            await expect(store.getObject("big.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("maxBytes: 0 keeps the cache metadata-only (stat elision, no body memory)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-metaonly-"));
        try {
            await writeFile(join(dir, "doc.txt"), "content");
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 0 } });

            await drain((await store.getObject("doc.txt")).body);
            // Metadata still serves from cache (no stat after file removal)...
            await rm(join(dir, "doc.txt"));
            expect((await store.headObject("doc.txt")).contentLength).toBe(7);
            // ...but no bytes were retained: a GET must hit disk and miss.
            await expect(store.getObject("doc.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("large files never enter the byte cache (always stream fresh)", async () => {
        const store = fsStore({ root, cache: { ttlMs: 60_000 } });
        await store.getObject("big.bin"); // streams; must not cache bytes
        const again = await store.getObject("big.bin");
        expect(again.body).toBeInstanceOf(ReadableStream);
        // The streaming path still writes back real metadata: a follow-up
        // HEAD serves coherent values from the cache, not an empty entry.
        const meta = await store.headObject("big.bin");
        expect(meta.contentLength).toBe(256 * 1024);
        expect(meta.etag).toMatch(/^W\//);
    });

    test("cached ranges are clamped identically to disk ranges", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-clamp-"));
        try {
            await writeFile(join(dir, "c.bin"), "0123456789"); // 10 bytes
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });
            await store.getObject("c.bin"); // prime the byte cache

            const clamped = await store.getObject("c.bin", { range: { start: 4, end: 99 } });
            expect(await drain(clamped.body)).toBe("456789");
            expect(clamped.contentLength).toBe(6);
            expect(clamped.range).toEqual({ start: 4, end: 9 });

            await expect(
                store.getObject("c.bin", { range: { start: 10, end: 12 } }),
            ).rejects.toBeInstanceOf(RangeError);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("refreshing an existing entry at capacity does not evict others", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-refresh-"));
        try {
            await writeFile(join(dir, "a.bin"), "aaaa");
            await writeFile(join(dir, "b.bin"), "bbbb");
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxEntries: 2 } });

            await store.headObject("a.bin"); // metadata-only entry
            await drain((await store.getObject("b.bin")).body); // byte entry -> at capacity

            // Range GET on a.bin hits disk (no bytes cached) and refreshes
            // a.bin's entry IN PLACE; b.bin must not be evicted by it.
            await drain((await store.getObject("a.bin", { range: { start: 0, end: 1 } })).body);

            // Prove b.bin still serves from memory: remove the file first.
            await rm(join(dir, "b.bin"));
            const fromMemory = await store.getObject("b.bin");
            expect(fromMemory.body).toBeInstanceOf(Uint8Array);
            expect(await drain(fromMemory.body)).toBe("bbbb");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a range GET does not evict the cached full body (write-back preserves bytes)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-preserve-"));
        try {
            await writeFile(join(dir, "s.txt"), "0123456789"); // 10 bytes, small
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });
            await drain((await store.getObject("s.txt")).body); // cache the full body

            // A range GET refreshes metadata but carries no bytes; it must NOT
            // clobber the cached body with a metadata-only entry.
            await drain((await store.getObject("s.txt", { range: { start: 2, end: 5 } })).body);

            // Prove the full body still serves from memory: delete the file first.
            await rm(join(dir, "s.txt"));
            const served = await store.getObject("s.txt");
            expect(served.body).toBeInstanceOf(Uint8Array);
            expect(await drain(served.body)).toBe("0123456789");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("disk reads write back metadata: HEAD converges on what GET served", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-wb-"));
        try {
            await writeFile(join(dir, "doc.txt"), "first version");
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000 } });
            const before = await store.headObject("doc.txt"); // metadata-only entry

            await writeFile(join(dir, "doc.txt"), "second version.");
            // Range read misses the byte cache, hits disk, and must refresh
            // the metadata entry -- a follow-up HEAD reflects the new state
            // instead of serving the stale snapshot for the full TTL.
            await drain((await store.getObject("doc.txt", { range: { start: 0, end: 5 } })).body);

            const after = await store.headObject("doc.txt");
            expect(after.contentLength).toBe(15);
            expect(after.etag).not.toBe(before.etag);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ─── Authoritative Single-Round-Trip Ranges (via the web adapter) ───────────

describe("fsStore: authoritative-range fast path", () => {
    test("a plain range serves in one round-trip: zero HEADs, bounds from the handle", async () => {
        const base = fsStore({ root });
        let heads = 0;
        const counting = {
            ...base,
            headObject: (async (key: string, o?: { signal?: AbortSignal }) => {
                heads++;
                return base.headObject(key, o);
            }) as typeof base.headObject,
        };
        const handler = serveObject(counting);
        const res = await handler(
            new Request("http://localhost/f", { headers: { Range: "bytes=5-9" } }),
            { key: "hello.txt" },
        );

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(res.headers.get("Content-Range")).toBe("bytes 5-9/20");
        // The weak nanosecond validator rides the 206 straight from the GET.
        expect(res.headers.get("ETag")).toStartWith('W/"');
        expect(heads).toBe(0);
    });

    test("a start beyond EOF falls back to validation and answers a true 416", async () => {
        const handler = serveObject(fsStore({ root }));
        const res = await handler(
            new Request("http://localhost/f", { headers: { Range: "bytes=100-200" } }),
            { key: "hello.txt" },
        );

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe("bytes */20");
    });

    test("an open-ended range is clamped by the store itself", async () => {
        const handler = serveObject(fsStore({ root }));
        const res = await handler(
            new Request("http://localhost/f", { headers: { Range: "bytes=15-" } }),
            { key: "hello.txt" },
        );

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(res.headers.get("Content-Range")).toBe("bytes 15-19/20");
    });
});
