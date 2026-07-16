import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { httpStore, ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "../http";
import { memoryStore } from "../memory";
import { serveObject } from "../web";
import { serveObject as serveObjectNode } from "../node";

// ─── Stub-fetch unit tests ──────────────────────────────────────────────────

function stubFetch(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) =>
        handler(String(input), init ?? {})) as typeof globalThis.fetch;
}

function headersOf(init: RequestInit): Record<string, string> {
    // Headers normalizes names to lowercase and, crucially for the reserved-
    // header tests, mirrors how fetch itself would combine duplicate keys.
    return Object.fromEntries(new Headers(init.headers ?? {}).entries());
}

describe("httpStore: unit (stub fetch)", () => {
    test("headObject maps HEAD response headers to metadata", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, {
                headers: {
                    "Content-Length": "1234",
                    ETag: '"origin-etag"',
                    "Last-Modified": "Sat, 28 Jun 2025 12:00:00 GMT",
                    "Repr-Digest": "sha-256=:MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=:",
                },
            })),
        });
        const meta = await store.headObject("doc.pdf");

        expect(meta.contentLength).toBe(1234);
        expect(meta.etag).toBe('"origin-etag"');
        expect(meta.lastModified).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
        expect(meta.digest).toBe("MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=");
    });

    test("requests are sent with Accept-Encoding: identity (byte-accounting safety)", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            headers: { Authorization: "Bearer tok" },
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response(null, { headers: { "Content-Length": "1" } });
            }),
        });
        await store.headObject("doc.pdf");

        expect(seen[0]["accept-encoding"]).toBe("identity");
        expect(seen[0]["authorization"]).toBe("Bearer tok");
    });

    test("reserved headers override case-variant consumer values instead of merging", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            // Lowercase spellings: a plain object spread would keep these
            // alongside the adapter's capitalized fields and fetch would join
            // the duplicates ("gzip, identity"), defeating the identity guard.
            headers: {
                "accept-encoding": "gzip",
                "range": "bytes=0-0",
                "if-match": '"stale"',
                Authorization: "Bearer tok",
            },
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response("hello ther", {
                    status: 206,
                    headers: { "Content-Length": "10", "Content-Range": "bytes 5-14/100" },
                });
            }),
        });
        await store.getObject("doc.pdf", {
            range: { start: 5, end: 14 },
            ifMatch: '"pinned"',
        });

        expect(seen[0]["accept-encoding"]).toBe("identity");
        expect(seen[0]["range"]).toBe("bytes=5-14");
        expect(seen[0]["if-match"]).toBe('"pinned"');
        expect(seen[0]["authorization"]).toBe("Bearer tok");
    });

    test("a bodyless 200 that declares bytes throws instead of serving a clean-looking empty stream", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            // No conformant fetch runtime returns a null body on 200 with a
            // Content-Length; only a stubbed/broken implementation does.
            fetch: stubFetch(() => new Response(null, { headers: { "Content-Length": "10" } })),
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no body but declares 10 bytes/);
    });

    test("a bodyless 200 for a zero-byte object still serves the empty stream", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, { headers: { "Content-Length": "0" } })),
        });
        const result = await store.getObject("empty.bin");
        expect(result.contentLength).toBe(0);
        const reader = result.body.getReader();
        expect((await reader.read()).done).toBe(true);
    });

    test("consumer Range/If-Match are cleared on requests that carry neither", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            headers: { Range: "bytes=0-0", "If-Match": '"stale"' },
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response(null, { headers: { "Content-Length": "1" } });
            }),
        });
        await store.headObject("doc.pdf");

        expect(seen[0]["range"]).toBeUndefined();
        expect(seen[0]["if-match"]).toBeUndefined();
    });

    test("fails loudly when an origin transfer-compresses despite identity", async () => {
        // An origin that ignores Accept-Encoding: identity returns a compressed
        // body; the fetch runtime decodes it but Content-Length still reports the
        // compressed size, so every byte count would be wrong. Refuse both HEAD
        // and GET rather than stream a body that disagrees with its headers.
        const headStore = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, {
                headers: { "Content-Length": "46", "Content-Encoding": "gzip" },
            })),
        });
        await expect(headStore.headObject("doc.pdf")).rejects.toThrow(/Content-Encoding/);

        const getStore = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("body-longer-than-the-declared-46-bytes-would-be", {
                status: 200,
                headers: { "Content-Length": "46", "Content-Encoding": "gzip" },
            })),
        });
        await expect(getStore.getObject("doc.pdf")).rejects.toThrow(/Content-Encoding/);
    });

    test("a malformed-206 refusal drains a bounded prefix, not the whole body", async () => {
        // drain() must not buffer the entire (potentially whole-object, possibly
        // decompression-bombed) body just to throw: it reads a bounded prefix
        // then cancels. Track pulled bytes + cancellation on a 1 MiB body.
        let pulled = 0;
        let cancelled = false;
        const CHUNK = 16 * 1024;
        const TOTAL = CHUNK * 64; // 1 MiB if fully read
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulled >= TOTAL) { controller.close(); return; }
                pulled += CHUNK;
                controller.enqueue(new Uint8Array(CHUNK));
            },
            cancel() { cancelled = true; },
        });
        const store = httpStore({
            url: (k) => `https://origin.example/${k}`,
            fetch: stubFetch(() => new Response(body, {
                status: 206,
                headers: { "Content-Range": "bytes garbage", "Content-Length": String(TOTAL) },
            })),
        });
        await expect(store.getObject("big.bin", { range: { start: 0, end: 5 } }))
            .rejects.toThrow(/unparseable Content-Range/);
        expect(cancelled).toBe(true);
        // Bounded to ~64 KiB + one chunk, never the full 1 MiB.
        expect(pulled).toBeLessThan(200 * 1024);
    });

    test("allows an explicit identity Content-Encoding", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, {
                headers: { "Content-Length": "10", "Content-Encoding": "identity" },
            })),
        });
        const meta = await store.headObject("doc.pdf");
        expect(meta.contentLength).toBe(10);
    });

    test("getObject forwards Range and If-Match; 412 maps to ObjectChangedError", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response(null, { status: 412 });
            }),
        });

        await expect(
            store.getObject("doc.pdf", { range: { start: 0, end: 9 }, ifMatch: '"v1"' }),
        ).rejects.toBeInstanceOf(ObjectChangedError);
        await Bun.sleep(0);
        expect(seen[0]["range"]).toBe("bytes=0-9");
        expect(seen[0]["if-match"]).toBe('"v1"');
    });

    test("404 maps to ObjectNotFoundError", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("nope", { status: 404 })),
        });
        await expect(store.getObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("503/429 map to StoreUnavailableError and forward Retry-After (delay-seconds)", async () => {
        const getStore = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("slow down", { status: 503, headers: { "Retry-After": "7" } })),
        });
        const err = await getStore.getObject("busy.pdf").catch((e) => e);
        expect(err).toBeInstanceOf(StoreUnavailableError);
        expect((err as StoreUnavailableError).retryAfterSeconds).toBe(7);

        const headStore = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, { status: 429 })),
        });
        const headErr = await headStore.headObject("busy.pdf").catch((e) => e);
        expect(headErr).toBeInstanceOf(StoreUnavailableError);
        // No hint on the response -> no fabricated Retry-After.
        expect((headErr as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });

    test("Retry-After as an HTTP-date is converted to whole seconds from now", async () => {
        const when = new Date(Date.now() + 30_000).toUTCString();
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("slow", { status: 503, headers: { "Retry-After": when } })),
        });
        const err = await store.getObject("busy.pdf").catch((e) => e);
        expect(err).toBeInstanceOf(StoreUnavailableError);
        // Clock skew of a test tick: allow a small window around 30s.
        const secs = (err as StoreUnavailableError).retryAfterSeconds!;
        expect(secs).toBeGreaterThanOrEqual(28);
        expect(secs).toBeLessThanOrEqual(30);
    });

    test("chunked 206 without Content-Length derives byte count from Content-Range", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => {
                // Response without explicit Content-Length (chunked origin);
                // undici would normally compute one from the string body, so
                // build headers explicitly with only Content-Range.
                const res = new Response("0123456789", {
                    status: 206,
                    headers: { "Content-Range": "bytes 5-14/100" },
                });
                res.headers.delete("content-length");
                return res;
            }),
        });
        const result = await store.getObject("doc.pdf", { range: { start: 5, end: 14 } });

        expect(result.contentLength).toBe(10);
        expect(result.totalSize).toBe(100);
        expect(result.range).toEqual({ start: 5, end: 14 });
    });

    test("chunked 206 that ends short of its Content-Range span errors the stream instead of closing clean", async () => {
        // An origin that terminates its chunked body cleanly (0-chunk) short of
        // the span it committed to would otherwise deliver a truncated body
        // that looks complete under the derived Content-Length.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => {
                const res = new Response("0123", {
                    status: 206,
                    headers: { "Content-Range": "bytes 0-9/100" },
                });
                res.headers.delete("content-length");
                return res;
            }),
        });
        const result = await store.getObject("doc.pdf", { range: { start: 0, end: 9 } });

        expect(result.contentLength).toBe(10);
        await expect(new Response(result.body).arrayBuffer()).rejects.toThrow(/10 bytes|expected/i);
    });

    test("206 with unknown total (bytes a-b/*) yields totalSize undefined", async () => {
        // A proxied streaming origin that does not know its full length answers
        // `bytes a-b/*`. The adapter must NOT fabricate a total; it propagates
        // `undefined` so the served response repeats `*` honestly.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("0123456789", {
                status: 206,
                headers: { "Content-Range": "bytes 0-9/*" },
            })),
        });
        const result = await store.getObject("stream.bin", { range: { start: 0, end: 9 } });

        expect(result.totalSize).toBeUndefined();
        expect(result.contentLength).toBe(10);
        expect(result.range).toEqual({ start: 0, end: 9 });
    });

    test("HEAD without Content-Length fails loudly", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => {
                const res = new Response(null, { status: 200 });
                res.headers.delete("content-length");
                return res;
            }),
        });
        await expect(store.headObject("doc.pdf")).rejects.toThrow(/Content-Length/);
    });
});

// ─── Origin edge cases (precision the happy path doesn't pin) ────────────────

describe("httpStore: origin edge cases", () => {
    test("advertises authoritativeRange so the orchestrator can skip the HEAD", () => {
        // A 206's bounds come from the origin's actual Content-Range, so the
        // store is authoritative for ranges; flipping this to false would make
        // the orchestrator issue a redundant validating HEAD on every range.
        const store = httpStore({ url: (key) => `https://origin.example/${key}` });
        expect(store.authoritativeRange).toBe(true);
        expect(store.supportsRange).toBe(true);
    });

    test("a headers FUNCTION is invoked per key (per-object credentials)", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            headers: (key) => ({ "X-Object-Key": key }),
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response(null, { headers: { "Content-Length": "1" } });
            }),
        });
        await store.headObject("secret.pdf");
        expect(seen[0]["x-object-key"]).toBe("secret.pdf");
    });

    test("HEAD 404 maps to ObjectNotFoundError (not a generic failure)", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, { status: 404 })),
        });
        await expect(store.headObject("gone.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    test("HEAD 503 forwards Retry-After onto StoreUnavailableError", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, { status: 503, headers: { "Retry-After": "5" } })),
        });
        const err = await store.headObject("busy.pdf").catch((e) => e);
        expect(err).toBeInstanceOf(StoreUnavailableError);
        expect((err as StoreUnavailableError).retryAfterSeconds).toBe(5);
    });

    test("HEAD with an unexpected non-ok status throws (even with a Content-Length)", async () => {
        // A 403 is neither 404 nor 503/429: it must surface loudly, not be
        // swallowed into a successful metadata read just because headers parse.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, { status: 403, headers: { "Content-Length": "10" } })),
        });
        await expect(store.headObject("forbidden.pdf")).rejects.toThrow(/failed: 403/);
    });

    test("a weak If-Match validator (W/) is NOT sent (RFC 9110 strong-compare)", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch((_url, init) => {
                seen.push(headersOf(init));
                return new Response("body", { status: 200, headers: { "Content-Length": "4" } });
            }),
        });
        await store.getObject("doc.pdf", { ifMatch: 'W/"weak-1"' });
        expect(seen[0]["if-match"]).toBeUndefined();
    });

    test("GET with an unexpected status throws (even with a Content-Length)", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("teapot", { status: 500, headers: { "Content-Length": "6" } })),
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/failed: 500/);
    });

    test("GET 200 without Content-Length fails loudly (range serving needs a size)", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => {
                const res = new Response("body", { status: 200 });
                res.headers.delete("content-length");
                return res;
            }),
        });
        await expect(store.getObject("doc.pdf")).rejects.toThrow(/no Content-Length/);
    });

    test("getObject surfaces the origin's Last-Modified onto the stream", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("data", {
                status: 200,
                headers: { "Content-Length": "4", "Last-Modified": "Sat, 28 Jun 2025 12:00:00 GMT" },
            })),
        });
        const result = await store.getObject("doc.pdf");
        expect(result.lastModified).toBe("Sat, 28 Jun 2025 12:00:00 GMT");
    });

    test("a multi-digit delay-seconds Retry-After is parsed in full", async () => {
        // Guards the `\d+` quantifier: a single-digit regex would fall through
        // to the HTTP-date branch and mis-parse "12" as a calendar date.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("slow", { status: 503, headers: { "Retry-After": "12" } })),
        });
        const err = await store.getObject("busy.pdf").catch((e) => e);
        expect((err as StoreUnavailableError).retryAfterSeconds).toBe(12);
    });

    test("an unparseable Retry-After yields undefined, never NaN", async () => {
        // Date.parse fails -> the isNaN guard must return undefined, not let a
        // NaN leak through the seconds arithmetic onto the error.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("slow", { status: 503, headers: { "Retry-After": "not-a-date" } })),
        });
        const err = await store.getObject("busy.pdf").catch((e) => e);
        expect((err as StoreUnavailableError).retryAfterSeconds).toBeUndefined();
    });

    test("Repr-Digest extraction accepts an unpadded base64 blob", async () => {
        // The capture uses `=*` (zero-or-more padding), not exactly one `=`, so
        // a base64url-style unpadded digest is still extracted verbatim.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, {
                headers: { "Content-Length": "1", "Repr-Digest": "sha-256=:abcABC0189+/xyz:" },
            })),
        });
        const meta = await store.headObject("doc.pdf");
        expect(meta.digest).toBe("abcABC0189+/xyz");
    });

    test("error responses are drained so the connection can be reused", async () => {
        // On every throwing GET path the body must be consumed; a leaked,
        // unread body pins the socket until GC.
        let held: Response | undefined;
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => {
                held = new Response("error body", { status: 404 });
                return held;
            }),
        });
        await store.getObject("gone.pdf").catch(() => {});
        expect(held?.bodyUsed).toBe(true);
    });
});

// ─── Proxy-chain integration ────────────────────────────────────────────────
// Origin: serveObject(memoryStore) over real node:http.
// Edge:   serveObject(httpStore -> origin).
// The kernel runs on BOTH ends; the edge must faithfully relay ranges,
// validators, and conditionals through plain HTTP.

let origin: Server;
let originUrl: string;

beforeAll(async () => {
    const originHandler = serveObjectNode(
        memoryStore({
            objects: {
                "hello.txt": {
                    body: "0123456789abcdefghij",
                    etag: '"origin-v1"',
                    lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
                },
            },
        }),
        { key: (req) => new URL(req.url!, "http://x").pathname.slice(1) },
    );
    origin = createServer((req, res) => { void originHandler(req, res); });
    await new Promise<void>((r) => origin.listen(0, r));
    const address = origin.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    originUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((r) => origin.close(() => r()));
});

function edgeHandler() {
    return serveObject(httpStore({ url: (key) => `${originUrl}/${key}` }));
}

describe("httpStore: proxy chain over real HTTP", () => {
    test("full GET relays body, size, and validators", async () => {
        const res = await edgeHandler()(
            new Request("http://edge/files/hello.txt"),
            { key: "hello.txt", mime: "text/plain" },
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
        expect(res.headers.get("Content-Length")).toBe("20");
        expect(res.headers.get("ETag")).toBe('"origin-v1"');
    });

    test("range request produces a truthful 206 end-to-end", async () => {
        const res = await edgeHandler()(
            new Request("http://edge/files/hello.txt", { headers: { Range: "bytes=5-9" } }),
            { key: "hello.txt" },
        );

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(res.headers.get("Content-Range")).toBe("bytes 5-9/20");
    });

    test("revalidation flows through the chain: 304 at the edge", async () => {
        const res = await edgeHandler()(
            new Request("http://edge/files/hello.txt", {
                headers: { "If-None-Match": '"origin-v1"' },
            }),
            { key: "hello.txt" },
        );
        expect(res.status).toBe(304);
    });

    test("origin 404 becomes edge 404", async () => {
        const res = await edgeHandler()(
            new Request("http://edge/files/missing.txt"),
            { key: "missing.txt" },
        );
        expect(res.status).toBe(404);
    });
});

describe("httpStore: weak-validator origins (fs-style) must still serve", () => {
    // Regression: an origin with only weak ETags (e.g. fs-backed) must not be
    // pinned with If-Match -- a compliant origin would 412 every attempt,
    // turning healthy objects into 502s.
    let weakOrigin: Server;
    let weakUrl: string;

    beforeAll(async () => {
        const handler = serveObjectNode(
            memoryStore({
                objects: { "w.txt": { body: "weak-origin-body", etag: 'W/"weak-9"' } },
            }),
            { key: (req) => new URL(req.url!, "http://x").pathname.slice(1) },
        );
        weakOrigin = createServer((req, res) => { void handler(req, res); });
        await new Promise<void>((r) => weakOrigin.listen(0, r));
        const address = weakOrigin.address();
        if (typeof address === "string" || address === null) throw new Error("no port");
        weakUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => weakOrigin.close(() => r()));
    });

    test("range request through the chain returns 206, not 502", async () => {
        const edge = serveObject(httpStore({ url: (key) => `${weakUrl}/${key}` }));
        const res = await edge(
            new Request("http://edge/w", { headers: { Range: "bytes=0-3" } }),
            { key: "w.txt" },
        );

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("weak");
    });
});

describe("httpStore: degenerate origin responses", () => {
    test("206 without Content-Range is refused (would silently truncate)", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("partial", {
                status: 206,
                headers: { "Content-Length": "7" },
            })),
        });
        await expect(
            store.getObject("doc.pdf", { range: { start: 0, end: 6 } }),
        ).rejects.toThrow(/206 with no Content-Range/);
    });

    test("206 with unparseable Content-Range is refused", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response("partial", {
                status: 206,
                headers: { "Content-Length": "7", "Content-Range": "bytes nonsense" },
            })),
        });
        await expect(
            store.getObject("doc.pdf", { range: { start: 0, end: 6 } }),
        ).rejects.toThrow(/unparseable Content-Range/);
    });

    test("zero-byte 200 with a null body streams an empty object", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(() => new Response(null, {
                status: 200,
                headers: { "Content-Length": "0" },
            })),
        });
        const result = await store.getObject("empty.bin");
        const chunks: Uint8Array[] = [];
        for await (const chunk of result.body) chunks.push(chunk);

        expect(chunks).toHaveLength(0);
        expect(result.contentLength).toBe(0);
        expect(result.totalSize).toBe(0);
    });

    test("redirect policy reaches fetch on both HEAD and GET", async () => {
        const seen: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            redirect: "error",
            fetch: stubFetch((_url, init) => {
                seen.push(String(init.redirect));
                return new Response("x", { headers: { "Content-Length": "1" } });
            }),
        });
        await store.headObject("doc.pdf");
        await store.getObject("doc.pdf");

        expect(seen).toEqual(["error", "error"]);
    });

    test("redirect defaults to 'error' (no SSRF-by-default via a hostile 3xx)", async () => {
        const seen: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch((_url, init) => {
                seen.push(String(init.redirect));
                return new Response("x", { headers: { "Content-Length": "1" } });
            }),
        });
        await store.headObject("doc.pdf");
        await store.getObject("doc.pdf");

        expect(seen).toEqual(["error", "error"]);
    });
});
