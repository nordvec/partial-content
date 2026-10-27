import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { appendFile, mkdtemp, rm, symlink, writeFile, mkdir, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveObject } from "../web";
import { fsStore, ObjectNotFoundError } from "../fs";
import { asStream, drain } from "./helpers";

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
        await expect(store.getObject("hello.txt", { range: { start: 20, end: 25 } })).rejects.toBeInstanceOf(
            RangeError,
        );
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
        await asStream(result.body).cancel();
    });

    test("a file exactly at the single-read limit takes the byte-body fast path", async () => {
        // The boundary is inclusive: exactly 128 KiB is one positional read
        // (Uint8Array body), not a ReadStream.
        const store = fsStore({ root });
        const result = await store.getObject("limit.bin");
        expect(result.body).toBeInstanceOf(Uint8Array);
        expect(result.contentLength).toBe(128 * 1024);
    });

    test("a file that grows mid-stream serves exactly the committed length", async () => {
        // The stream is bounded by the size the pinned fstat reported, which
        // is the number already committed as Content-Length. An unbounded read
        // runs to whatever EOF has become by then, and the extra bytes leave
        // the response longer than its own header: Node answers that with
        // ERR_HTTP_CONTENT_LENGTH_MISMATCH and a destroyed socket, so the
        // client gets nothing instead of the correct first N bytes.
        const key = "growing.bin";
        const target = join(root, key);
        await writeFile(target, Buffer.alloc(200 * 1024, 0x63));
        const store = fsStore({ root });
        const result = await store.getObject(key);
        expect(result.contentLength).toBe(200 * 1024);

        await appendFile(target, Buffer.alloc(50 * 1024, 0x64));
        const body = await drain(result.body);

        expect(body.length).toBe(200 * 1024);
        // Only the pinned file's filler byte: none of the appended bytes.
        expect(body.includes("d")).toBe(false);
        await rm(target, { force: true });
    });
});

/**
 * Lowest unused descriptor number. Node and Bun both hand out the lowest free
 * slot, on Windows as well as POSIX, so this number rises exactly when
 * descriptors accumulate and returns to its floor when they are released.
 * Sampled as a minimum because other test files share this process and open
 * descriptors of their own; a leak moves the floor, transient neighbours do
 * not.
 */
function lowestFreeDescriptor(probePath: string): number {
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
        const fd = openSync(probePath, "r");
        closeSync(fd);
        if (fd < lowest) lowest = fd;
    }
    return lowest;
}

/** Give the pending best-effort closes a turn to retire before probing. */
async function settleCloses(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Descriptors a neighbouring test file may legitimately hold while this one probes. */
const LEAK_TOLERANCE = 20;
const SETTLE_ATTEMPTS = 500;

/**
 * Growth of the lowest free descriptor since `before`, sampled until the
 * pending closes have retired. Closes complete on the thread pool, so how long
 * they take depends on machine load; this polls until the growth is within
 * tolerance and bounds the wait by attempts, not wall-clock. A leaked
 * descriptor never retires, so a real leak exhausts the attempts and the
 * returned growth stays above the tolerance.
 */
async function descriptorGrowth(probePath: string, before: number): Promise<number> {
    let growth = lowestFreeDescriptor(probePath) - before;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS && growth >= LEAK_TOLERANCE; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        growth = lowestFreeDescriptor(probePath) - before;
    }
    return growth;
}

describe("fsStore: the read path pins one descriptor", () => {
    const HAMMER = 100;
    const TOCTOU_REQUESTS = 3000;
    const TOCTOU_READERS = 32;

    test("sustained range-beyond-EOF traffic leaks no descriptors", async () => {
        // The read path holds a RAW descriptor, which has no finalizer to
        // clean up after a missed close, so one descriptor per rejected
        // request accumulates until the process hits EMFILE. 416 traffic is
        // the cheapest way for a client to drive that.
        const store = fsStore({ root });
        const beyondEof = { range: { start: 20, end: 25 } };
        for (let i = 0; i < 20; i++) {
            await expect(store.getObject("hello.txt", beyondEof)).rejects.toBeInstanceOf(RangeError);
        }
        await settleCloses();
        const before = lowestFreeDescriptor(join(root, "hello.txt"));

        for (let i = 0; i < HAMMER; i++) {
            await expect(store.getObject("hello.txt", beyondEof)).rejects.toBeInstanceOf(RangeError);
        }

        // A leak is one descriptor per request, so it moves the floor by
        // HAMMER, which exceeds the tolerance.
        expect(await descriptorGrowth(join(root, "hello.txt"), before)).toBeLessThan(LEAK_TOLERANCE);
    });

    test("sustained not-a-file traffic leaks no descriptors", async () => {
        // A directory opens successfully and is refused only after the stat,
        // so this is the failure exit that runs with a descriptor already in
        // hand.
        const store = fsStore({ root });
        for (let i = 0; i < 20; i++) {
            await expect(store.getObject("nested")).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        await settleCloses();
        const before = lowestFreeDescriptor(join(root, "hello.txt"));

        for (let i = 0; i < HAMMER; i++) {
            await expect(store.getObject("nested")).rejects.toBeInstanceOf(ObjectNotFoundError);
        }

        expect(await descriptorGrowth(join(root, "hello.txt"), before)).toBeLessThan(LEAK_TOLERANCE);
    });

    test("sustained successful small reads leak no descriptors", async () => {
        // The success exit closes in its own callback rather than a `finally`,
        // so it is a separate path from the failure exits above and leaks the
        // same way if it is missed.
        const store = fsStore({ root });
        for (let i = 0; i < 20; i++) {
            expect((await store.getObject("hello.txt")).contentLength).toBe(20);
        }
        await settleCloses();
        const before = lowestFreeDescriptor(join(root, "hello.txt"));

        for (let i = 0; i < HAMMER; i++) {
            expect((await store.getObject("hello.txt")).contentLength).toBe(20);
        }

        expect(await descriptorGrowth(join(root, "hello.txt"), before)).toBeLessThan(LEAK_TOLERANCE);
    });

    test("metadata comes from the descriptor, so a replaced file cannot tear a response", async () => {
        // The size, validators and bytes of one response must all describe the
        // file the descriptor was opened on. Statting the PATH instead measures
        // whatever the name points at by then, and every shape that produces is
        // asserted below: a Content-Length longer than the pinned file (the read
        // runs out and reports a shrink), one shorter (a prefix of the wrong
        // file served as a whole object), and a stat of a name that has since
        // been unlinked (a bare ENOENT escaping instead of the mapped
        // not-found the open path produces).
        //
        // Unlinking is what makes the two disagree: the descriptor keeps the
        // inode alive with its own size and bytes while the name is recreated
        // at a different size. Windows allows this too, so the check is not
        // POSIX-only.
        const key = "toctou.bin";
        const target = join(root, key);
        const SMALL = { size: 4096, byte: 0x41 };
        const LARGE = { size: 8192, byte: 0x42 };
        await writeFile(target, Buffer.alloc(SMALL.size, SMALL.byte));

        let flipping = true;
        const staged = [join(root, "toctou.staged.0"), join(root, "toctou.staged.1")];
        // Synchronous flips: the readers below saturate the filesystem thread
        // pool, and an async flipper queued behind them would flip a handful of
        // times across the whole run. On the main thread a flip costs nothing
        // and lands cleanly between two turns of the event loop, which is
        // exactly where a reader's window sits.
        const flipper = (async () => {
            for (let i = 0; flipping; i++) {
                const shape = i % 2 === 0 ? LARGE : SMALL;
                const source = staged[i % 2]!;
                writeFileSync(source, Buffer.alloc(shape.size, shape.byte));
                // Unlink first (the name must be free before the rename can
                // take it), then publish the finished file under one syscall,
                // so a reader sees a whole file or no file, never a half-
                // written one.
                rmSync(target, { force: true });
                renameSync(source, target);
                await new Promise((resolve) => setImmediate(resolve));
            }
        })();

        const store = fsStore({ root });
        let issued = 0;
        let served = 0;
        // Readers run concurrently on purpose. The window a path stat opens is
        // one turn of the event loop wide, so a single sequential reader almost
        // always completes between two flips and never straddles one; keeping
        // many requests in flight means every flip lands inside some reader's
        // window.
        const readOnce = async (): Promise<void> => {
            let result;
            try {
                result = await store.getObject(key);
            } catch (err) {
                // Losing the race to OPEN is legitimate: the name is briefly
                // absent while it is recreated, which surfaces as the mapped
                // not-found or, on Windows, as the delete-pending error the
                // platform returns there instead. A torn response carries no
                // errno at all (the short-read guard raises a plain Error), so
                // this admits the race without admitting the defect.
                if (!(err instanceof ObjectNotFoundError)) {
                    expect((err as NodeJS.ErrnoException).code).toMatch(/^(ENOENT|EPERM|EBUSY)$/);
                }
                return;
            }
            served++;
            const bytes = result.body;
            if (!(bytes instanceof Uint8Array)) throw new Error("expected a byte body");
            // Bounds agree with the bytes actually delivered.
            expect(bytes.length).toBe(result.contentLength);
            expect(result.totalSize).toBe(bytes.length);
            // And the bytes are one whole file, not a prefix of the other:
            // each shape has its own filler byte and its own length.
            const shape = bytes.length === SMALL.size ? SMALL : LARGE;
            expect(bytes.length).toBe(shape.size);
            expect(bytes.every((b) => b === shape.byte)).toBe(true);
            // The weak validator encodes the size the descriptor reported.
            expect(/^W\/"([0-9a-f]+)-/.exec(result.etag!)?.[1]).toBe(shape.size.toString(16));
        };

        try {
            await Promise.all(
                Array.from({ length: TOCTOU_READERS }, async () => {
                    while (issued < TOCTOU_REQUESTS) {
                        issued++;
                        await readOnce();
                    }
                }),
            );
        } finally {
            flipping = false;
            await flipper;
            await rm(target, { force: true });
            for (const source of staged) await rm(source, { force: true });
        }
        // Guard against the vacuous pass where every request lost the open race
        // and nothing was ever checked against real bytes.
        expect(served).toBeGreaterThan(0);
    });

    test("a throw while the stream is being wrapped leaks no descriptors", async () => {
        // The descriptor is handed to a ReadStream and then to the web-stream
        // wrapper, and it belongs to exactly one owner at each point: the raw
        // number until the ReadStream constructs, the stream afterwards. Only
        // one of the two steps releasing it means a throw in the other leaves
        // a descriptor no finalizer will ever collect, and the terminal state
        // of that is EMFILE for the whole process.
        //
        // The wrapper reads the signal by interface (it only subscribes to
        // "abort"), so a signal whose subscription throws is what drives a
        // failure into the second step. A real AbortSignal cannot: subscribing
        // to one is infallible whatever its state.
        const hostileSignal = {
            aborted: false,
            throwIfAborted() {
                // Not aborted: the read must reach the stream handoff.
            },
            addEventListener() {
                throw new Error("subscription refused");
            },
            removeEventListener() {
                // Never reached; present so the wrapper's detach path is real.
            },
        } as unknown as AbortSignal;

        const store = fsStore({ root });
        // "big.bin" is above the single-read limit, so it takes the streaming
        // path that owns a descriptor across the handoff.
        const stream = { signal: hostileSignal };
        for (let i = 0; i < 20; i++) {
            await expect(store.getObject("big.bin", stream)).rejects.toThrow("subscription refused");
        }
        await settleCloses();
        const before = lowestFreeDescriptor(join(root, "hello.txt"));

        for (let i = 0; i < HAMMER; i++) {
            await expect(store.getObject("big.bin", stream)).rejects.toThrow("subscription refused");
        }

        expect(await descriptorGrowth(join(root, "hello.txt"), before)).toBeLessThan(LEAK_TOLERANCE);
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

    test("stale reads are bounded by ttlMs (TTL-revalidated hot-object cache)", async () => {
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
            expect(await drain((await store.getObject("r.txt", { range: { start: 0, end: 9 } })).body)).toBe(
                "0123456789",
            );

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

    test("byte-budget eviction skips metadata-only entries (stat elision survives)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-metaonly-"));
        try {
            await writeFile(join(dir, "meta.txt"), "metadata"); // 8 bytes
            await writeFile(join(dir, "b0.txt"), "body-0"); // 6 bytes
            await writeFile(join(dir, "b1.txt"), "body-1"); // 6 bytes
            const store = fsStore({ root: dir, cache: { ttlMs: 60_000, maxBytes: 10 } });

            // Oldest LRU entry carries no bytes (HEAD caches metadata only).
            await store.headObject("meta.txt");
            // 6 + 6 > 10 forces a byte-budget eviction. Evicting the
            // metadata entry would free zero bytes; the budget must reach
            // past it and evict b0's BODY entry instead.
            await drain((await store.getObject("b0.txt")).body);
            await drain((await store.getObject("b1.txt")).body);

            // The metadata-only entry survived: HEAD still answers from
            // cache after the file is gone (within the TTL).
            await rm(join(dir, "meta.txt"));
            expect((await store.headObject("meta.txt")).contentLength).toBe(8);

            // And the budget was genuinely relieved by evicting b0.
            await rm(join(dir, "b0.txt"));
            await expect(store.getObject("b0.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
            await rm(join(dir, "b1.txt"));
            expect(await drain((await store.getObject("b1.txt")).body)).toBe("body-1");
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
        // Streams; must not cache bytes. Each stream is CANCELLED, never
        // abandoned: an unconsumed stream holds its FileHandle open, and a
        // handle collected while open is a runtime error that lands
        // asynchronously in whichever unrelated test is running when GC fires.
        await ((await store.getObject("big.bin")).body as ReadableStream).cancel();
        const again = await store.getObject("big.bin");
        expect(again.body).toBeInstanceOf(ReadableStream);
        await (again.body as ReadableStream).cancel();
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

            await expect(store.getObject("c.bin", { range: { start: 10, end: 12 } })).rejects.toBeInstanceOf(
                RangeError,
            );
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
        const res = await handler(new Request("http://localhost/f", { headers: { Range: "bytes=5-9" } }), {
            key: "hello.txt",
        });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(res.headers.get("Content-Range")).toBe("bytes 5-9/20");
        // The weak nanosecond validator rides the 206 straight from the GET.
        expect(res.headers.get("ETag")).toStartWith('W/"');
        expect(heads).toBe(0);
    });

    test("a start beyond EOF falls back to validation and answers a true 416", async () => {
        const handler = serveObject(fsStore({ root }));
        const res = await handler(new Request("http://localhost/f", { headers: { Range: "bytes=100-200" } }), {
            key: "hello.txt",
        });

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe("bytes */20");
    });

    test("an open-ended range is clamped by the store itself", async () => {
        const handler = serveObject(fsStore({ root }));
        const res = await handler(new Request("http://localhost/f", { headers: { Range: "bytes=15-" } }), {
            key: "hello.txt",
        });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(res.headers.get("Content-Range")).toBe("bytes 15-19/20");
    });
});

// ─── Links that leave the root ──────────────────────────────────────────────

/**
 * A directory link: a junction on Windows (no privilege needed), a symlink on
 * POSIX, where the type argument is ignored.
 */
async function linkDir(target: string, path: string): Promise<void> {
    await symlink(target, path, "junction");
}

/** A file symlink, or false where the platform refuses one without privilege. */
async function linkFile(target: string, path: string): Promise<boolean> {
    try {
        await symlink(target, path, "file");
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
        throw err;
    }
}

describe("fsStore: symlinks", () => {
    let base: string;
    let inside: string;
    let outside: string;

    beforeAll(async () => {
        base = await mkdtemp(join(tmpdir(), "pc-fs-links-"));
        inside = join(base, "root");
        outside = join(base, "outside");
        await mkdir(join(inside, "real"), { recursive: true });
        await mkdir(outside);
        await writeFile(join(outside, "secret.txt"), "outside the root");
        await writeFile(join(inside, "real", "doc.txt"), "inside the root");
        await linkDir(outside, join(inside, "escape"));
        await linkDir(join(inside, "real"), join(inside, "alias"));
    });

    afterAll(async () => {
        await rm(base, { recursive: true, force: true });
    });

    test("a directory link out of the root is refused by default", async () => {
        const store = fsStore({ root: inside });
        await expect(store.getObject("escape/secret.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject("escape/secret.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        const ranged = store.getObject("escape/secret.txt", { range: { start: 0, end: 3 } });
        await expect(ranged).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("the refusal holds behind the serving handler and its fast path", async () => {
        const handler = serveObject(fsStore({ root: inside }));
        for (const headers of [{}, { Range: "bytes=0-3" }] as Record<string, string>[]) {
            const res = await handler(new Request("http://localhost/f", { headers }), { key: "escape/secret.txt" });
            expect(res.status).toBe(404);
        }
    });

    test("symlinks: follow serves through the same link", async () => {
        const store = fsStore({ root: inside, symlinks: "follow" });
        expect(await drain((await store.getObject("escape/secret.txt")).body)).toBe("outside the root");
        expect((await store.headObject("escape/secret.txt")).contentLength).toBe(16);
    });

    test("a link that stays inside the root still serves", async () => {
        const store = fsStore({ root: inside });
        expect(await drain((await store.getObject("alias/doc.txt")).body)).toBe("inside the root");
        expect((await store.headObject("alias/doc.txt")).contentLength).toBe(15);
    });

    test("a root that is itself reached through a link serves its own files", async () => {
        const linkedRoot = join(base, "root-link");
        await linkDir(inside, linkedRoot);
        const store = fsStore({ root: linkedRoot });
        expect(await drain((await store.getObject("real/doc.txt")).body)).toBe("inside the root");
        await expect(store.getObject("escape/secret.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a link inside the root cannot reach the reserved upload workspace", async () => {
        await mkdir(join(inside, ".uploads"), { recursive: true });
        await writeFile(join(inside, ".uploads", "abc"), "in-flight bytes");
        await linkDir(join(inside, ".uploads"), join(inside, "workspace"));
        const store = fsStore({ root: inside });
        await expect(store.getObject("workspace/abc")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject("workspace/abc")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("a file symlink out of the root is refused by default and served under follow", async () => {
        if (!(await linkFile(join(outside, "secret.txt"), join(inside, "link.txt")))) return;
        await expect(fsStore({ root: inside }).getObject("link.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(fsStore({ root: inside }).headObject("link.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
        const follow = fsStore({ root: inside, symlinks: "follow" });
        expect(await drain((await follow.getObject("link.txt")).body)).toBe("outside the root");
    });

    test("an unrecognized symlinks value fails closed", async () => {
        const store = fsStore({ root: inside, symlinks: "allow" as "follow" });
        await expect(store.getObject("escape/secret.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("fsStore: non-regular files", () => {
    test.skipIf(process.platform === "win32")("a FIFO under the root is refused without blocking", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pc-fs-fifo-"));
        try {
            execFileSync("mkfifo", [join(dir, "pipe")]);
            for (const symlinks of ["contain", "follow"] as const) {
                const store = fsStore({ root: dir, symlinks });
                // Opening a FIFO for reading blocks until a writer appears, so an
                // open that is not refused never settles and this test times out.
                await expect(store.getObject("pipe")).rejects.toBeInstanceOf(ObjectNotFoundError);
                await expect(store.headObject("pipe")).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("fsStore: cache option validation", () => {
    for (const option of ["ttlMs", "maxEntries", "maxBytes"] as const) {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
            test(`cache.${option} = ${value} is refused with a TypeError naming it`, () => {
                const cache = { ttlMs: 1000, [option]: value };
                expect(() => fsStore({ root, cache })).toThrow(TypeError);
                expect(() => fsStore({ root, cache })).toThrow(`cache.${option}`);
            });
        }
    }

    test("zero stays a valid value for every cache option", () => {
        expect(() => fsStore({ root, cache: { ttlMs: 0, maxEntries: 0, maxBytes: 0 } })).not.toThrow();
    });
});
