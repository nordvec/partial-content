import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { httpStore, encodeKeyPath, ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "../http";
import { memoryStore } from "../memory";
import { serveObject } from "../web";
import { serveObject as serveObjectNode } from "../node";
import { asStream } from "./helpers";

// ─── Stub-fetch unit tests ──────────────────────────────────────────────────

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof globalThis.fetch {
    // The target's text the way the runtime reads it, so a Request never
    // records as "[object Request]".
    return (async (input: string | URL | Request, init?: RequestInit) =>
        handler(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            init ?? {},
        )) as typeof globalThis.fetch;
}

function headersOf(init: RequestInit): Record<string, string> {
    // Headers normalizes names to lowercase and, crucially for the reserved-
    // header tests, mirrors how fetch itself would combine duplicate keys.
    return Object.fromEntries(new Headers(init.headers ?? {}).entries());
}

describe("httpStore: reserved upload bookkeeping", () => {
    // An origin fronting a bucket an upload store also writes to exposes that
    // store's in-flight bytes and sidecars through the read path. The http
    // adapter cannot know which upload store it is, so it refuses every
    // default prefix before a request is ever built.
    function counting() {
        const urls: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch((url) => {
                urls.push(url);
                return new Response("x", { headers: { "Content-Length": "1" } });
            }),
        });
        return { store, urls };
    }

    /** Every key is refused on both read entry points, with no request built. */
    async function refusedWithoutRequest(keys: readonly string[]): Promise<void> {
        const { store, urls } = counting();
        for (const key of keys) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(urls).toEqual([]);
    }

    test("both upload-store defaults are refused on headObject and getObject without a request", async () => {
        await refusedWithoutRequest([
            ".uploads/tok",
            ".uploads/tok.json",
            ".uploads",
            ".partial-content-uploads/tok.info",
        ]);
    });

    test("a spelling the origin resolves into the reserved namespace is refused without a request", async () => {
        // `url()` belongs to the consumer, and one that interpolates the key
        // unencoded hands the origin a path it decodes and resolves before the
        // key names anything: `%2E` becomes `.` and `..` walks a segment up, so
        // a literal prefix check alone reads both of these as ordinary keys.
        await refusedWithoutRequest([
            "%2Euploads/tok",
            "%2euploads/tok.info",
            "docs/../.uploads/tok",
            ".uploads%2Ftok",
            "%2E%2E/.uploads/tok",
            "docs/%2E%2E/.partial-content-uploads/tok",
        ]);
    });

    test("an ordinary key that merely carries an encoding is still fetched", async () => {
        const { store, urls } = counting();
        await store.headObject("docs/a%20b.pdf");
        expect(urls).toEqual(["https://origin.example/docs/a%20b.pdf"]);
    });

    test("a key with a dot segment is refused before any request, wherever it resolves", async () => {
        // The origin, not this store, decides what a dot segment resolves to, so no key that has one is sent.
        const { store, urls } = counting();
        await expect(store.headObject("docs/2026/../a.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.headObject("docs/../.uploads/v6/rec/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(urls).toEqual([]);
    });

    test("a published key is fetched", async () => {
        const { store, urls } = counting();
        await store.headObject("docs/a.pdf");
        expect(urls).toEqual(["https://origin.example/docs/a.pdf"]);
    });

    test("reservedPrefix takes the consumer's own value, a list, or the empty opt-out", async () => {
        const own = httpStore({
            url: (key) => `https://origin.example/${key}`,
            reservedPrefix: "private/",
            fetch: stubFetch(() => new Response(null, { headers: { "Content-Length": "1" } })),
        });
        await expect(own.headObject("private/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(own.headObject(".uploads/x")).resolves.toBeDefined();

        const none = httpStore({
            url: (key) => `https://origin.example/${key}`,
            reservedPrefix: "",
            fetch: stubFetch(() => new Response(null, { headers: { "Content-Length": "1" } })),
        });
        await expect(none.headObject(".uploads/x")).resolves.toBeDefined();
    });
});

describe("encodeKeyPath", () => {
    test("encodes each segment and keeps the separators literal", () => {
        expect(encodeKeyPath("docs/a b.pdf")).toBe("docs/a%20b.pdf");
        expect(encodeKeyPath("r\u00e9ports/2026/q1.pdf")).toBe("r%C3%A9ports/2026/q1.pdf");
    });

    test("a key cannot carry a query, a fragment, an authority or an encoded separator into the request line", () => {
        expect(encodeKeyPath("a?x=1")).toBe("a%3Fx%3D1");
        expect(encodeKeyPath("a#frag")).toBe("a%23frag");
        expect(() => encodeKeyPath("//evil.example/x")).toThrow(ObjectNotFoundError);
        expect(encodeKeyPath("evil.example:8080/x")).toBe("evil.example%3A8080/x");
        expect(encodeKeyPath("a%2Fb")).toBe("a%252Fb");
    });

    test("an empty segment and the dot segments are refused, since a URL parser resolves them", () => {
        for (const key of ["", "a//b", "/a", "a/", ".", "..", "a/../b", "a/./b", "../a"]) {
            expect(() => encodeKeyPath(key)).toThrow(ObjectNotFoundError);
        }
    });
});

describe("httpStore: unit (stub fetch)", () => {
    test("headObject maps HEAD response headers to metadata", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        headers: {
                            "Content-Length": "1234",
                            ETag: '"origin-etag"',
                            "Last-Modified": "Sat, 28 Jun 2025 12:00:00 GMT",
                            "Repr-Digest": "sha-256=:MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=:",
                        },
                    }),
            ),
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
                range: "bytes=0-0",
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

    test("case-variant identity Content-Encoding is accepted, not refused", async () => {
        // The identity check normalizes case; an origin answering
        // "Content-Encoding: IDENTITY" is identity-coded, not compressed.
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        headers: { "Content-Length": "5", "Content-Encoding": "IDENTITY" },
                    }),
            ),
        });
        const meta = await store.headObject("doc.bin");
        expect(meta.contentLength).toBe(5);
    });

    test("a custom fetch returning unstripped header values still parses Content-Length", async () => {
        // opts.fetch is an injection point: a wrapper that surfaces raw header
        // strings (no Headers OWS-stripping) must not break size parsing.
        const raw = {
            status: 200,
            ok: true,
            body: null,
            headers: { get: (n: string) => (n === "content-length" ? " 5" : null) },
        } as unknown as Response;
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: (async () => raw) as unknown as typeof globalThis.fetch,
        });
        const meta = await store.headObject("doc.bin");
        expect(meta.contentLength).toBe(5);
    });

    test("Repr-Digest values that merely resemble digests are never extracted", async () => {
        const digestOf = async (reprDigest: string) => {
            const store = httpStore({
                url: (key) => `https://origin.example/${key}`,
                fetch: stubFetch(
                    () =>
                        new Response(null, {
                            headers: { "Content-Length": "1", "Repr-Digest": reprDigest },
                        }),
                ),
            });
            return (await store.headObject("doc.bin")).digest;
        };

        // No sha-256 marker at all: scanning must not start mid-string and
        // return a fragment of some other algorithm's value.
        expect(await digestOf("md5=:AAAA:")).toBeUndefined();
        // Empty value between the colons.
        expect(await digestOf("sha-256=::")).toBeUndefined();
        // Unterminated value (no closing colon).
        expect(await digestOf("sha-256=:abcd")).toBeUndefined();
        // Characters just OUTSIDE each base64 alphabet range must terminate
        // the run and fail the closing-colon check, never be swallowed.
        expect(await digestOf("sha-256=:ab@cd:")).toBeUndefined(); // 0x40, below A-Z
        expect(await digestOf("sha-256=:ab[cd:")).toBeUndefined(); // 0x5b, above A-Z
        expect(await digestOf("sha-256=:ab`cd:")).toBeUndefined(); // 0x60, below a-z
        expect(await digestOf("sha-256=:ab{cd:")).toBeUndefined(); // 0x7b, above a-z
        expect(await digestOf("sha-256=:ab*cd:")).toBeUndefined(); // 0x2a, next to +
        // Control: a well-formed value still extracts.
        expect(await digestOf("sha-256=:abcABC0189+/xyz=:")).toBe("abcABC0189+/xyz=");
    });

    test("error-path drain reads a bounded prefix then cancels, never the whole body", async () => {
        // The refusal paths drain a bounded prefix (connection reuse) and then
        // cancel: an unbounded drain would buffer a decompression bomb.
        let pulls = 0;
        let cancelled = false;
        const chunk = new Uint8Array(40 * 1024);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls++;
                if (pulls >= 10) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response(body, {
                        status: 503,
                        headers: { "Retry-After": "1" },
                    }),
            ),
        });
        await expect(store.getObject("big.bin")).rejects.toBeInstanceOf(StoreUnavailableError);

        // 40 KiB chunks cross the 64 KiB cap on the second read: the drain
        // consumes exactly two chunks (plus one readahead pull) and cancels.
        // A cap that fires too early reads one chunk; no cap reads all ten.
        expect(cancelled).toBe(true);
        expect(pulls).toBeGreaterThanOrEqual(2);
        expect(pulls).toBeLessThanOrEqual(4);
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
        const reader = asStream(result.body).getReader();
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
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        headers: { "Content-Length": "46", "Content-Encoding": "gzip" },
                    }),
            ),
        });
        await expect(headStore.headObject("doc.pdf")).rejects.toThrow(/Content-Encoding/);

        const getStore = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response("body-longer-than-the-declared-46-bytes-would-be", {
                        status: 200,
                        headers: { "Content-Length": "46", "Content-Encoding": "gzip" },
                    }),
            ),
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
                if (pulled >= TOTAL) {
                    controller.close();
                    return;
                }
                pulled += CHUNK;
                controller.enqueue(new Uint8Array(CHUNK));
            },
            cancel() {
                cancelled = true;
            },
        });
        const store = httpStore({
            url: (k) => `https://origin.example/${k}`,
            fetch: stubFetch(
                () =>
                    new Response(body, {
                        status: 206,
                        headers: { "Content-Range": "bytes garbage", "Content-Length": String(TOTAL) },
                    }),
            ),
        });
        await expect(store.getObject("big.bin", { range: { start: 0, end: 5 } })).rejects.toThrow(
            /unparseable Content-Range/,
        );
        expect(cancelled).toBe(true);
        // Bounded to ~64 KiB + one chunk, never the full 1 MiB.
        expect(pulled).toBeLessThan(200 * 1024);
    });

    test("allows an explicit identity Content-Encoding", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        headers: { "Content-Length": "10", "Content-Encoding": "identity" },
                    }),
            ),
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
            fetch: stubFetch(
                () =>
                    new Response("0123456789", {
                        status: 206,
                        headers: { "Content-Range": "bytes 0-9/*" },
                    }),
            ),
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
            fetch: stubFetch(
                () =>
                    new Response("data", {
                        status: 200,
                        headers: { "Content-Length": "4", "Last-Modified": "Sat, 28 Jun 2025 12:00:00 GMT" },
                    }),
            ),
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
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        headers: { "Content-Length": "1", "Repr-Digest": "sha-256=:abcABC0189+/xyz:" },
                    }),
            ),
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
    origin = createServer((req, res) => {
        void originHandler(req, res);
    });
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
        const res = await edgeHandler()(new Request("http://edge/files/hello.txt"), {
            key: "hello.txt",
            mime: "text/plain",
        });

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
        const res = await edgeHandler()(new Request("http://edge/files/missing.txt"), { key: "missing.txt" });
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
        weakOrigin = createServer((req, res) => {
            void handler(req, res);
        });
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
        const res = await edge(new Request("http://edge/w", { headers: { Range: "bytes=0-3" } }), { key: "w.txt" });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("weak");
    });
});

describe("httpStore: degenerate origin responses", () => {
    test("206 without Content-Range is refused (would silently truncate)", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response("partial", {
                        status: 206,
                        headers: { "Content-Length": "7" },
                    }),
            ),
        });
        await expect(store.getObject("doc.pdf", { range: { start: 0, end: 6 } })).rejects.toThrow(
            /206 with no Content-Range/,
        );
    });

    test("206 with unparseable Content-Range is refused", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response("partial", {
                        status: 206,
                        headers: { "Content-Length": "7", "Content-Range": "bytes nonsense" },
                    }),
            ),
        });
        await expect(store.getObject("doc.pdf", { range: { start: 0, end: 6 } })).rejects.toThrow(
            /unparseable Content-Range/,
        );
    });

    test("zero-byte 200 with a null body streams an empty object", async () => {
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch(
                () =>
                    new Response(null, {
                        status: 200,
                        headers: { "Content-Length": "0" },
                    }),
            ),
        });
        const result = await store.getObject("empty.bin");
        const chunks: Uint8Array[] = [];
        for await (const chunk of asStream(result.body)) chunks.push(chunk);

        expect(chunks).toHaveLength(0);
        expect(result.contentLength).toBe(0);
        expect(result.totalSize).toBe(0);
    });
});

describe("httpStore: redirects are handled by the store, never by the runtime", () => {
    const ok = (): Response => new Response("x", { headers: { "Content-Length": "1" } });
    const to = (location: string | null, status = 302): Response =>
        new Response(null, { status, headers: location === null ? {} : { Location: location } });

    for (const redirect of [undefined, "error", "follow"] as const) {
        test(`every request goes out with redirect "manual" (policy ${redirect})`, async () => {
            // One runtime refuses "error" outright, so the store never sends it.
            const seen: string[] = [];
            const store = httpStore({
                url: (key) => `https://origin.example/${key}`,
                redirect,
                fetch: stubFetch((_url, init) => {
                    seen.push(String(init.redirect));
                    return ok();
                }),
            });
            await store.headObject("doc.pdf");
            await store.getObject("doc.pdf");
            expect(seen).toEqual(["manual", "manual"]);
        });
    }

    test("by default a 3xx fails the read and its target is never requested", async () => {
        const fetched: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            fetch: stubFetch((url) => {
                fetched.push(url);
                return to("http://169.254.169.254/latest/meta-data/");
            }),
        });
        await expect(store.headObject("doc.pdf")).rejects.toThrow("httpStore HEAD failed: 302");
        await expect(store.getObject("doc.pdf")).rejects.toThrow("httpStore GET failed: 302");
        expect(fetched).toEqual(["https://origin.example/doc.pdf", "https://origin.example/doc.pdf"]);
    });

    test("follow: each hop goes through the injected fetch, resolved against the URL that answered", async () => {
        const fetched: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/a/${key}`,
            redirect: "follow",
            fetch: stubFetch((url) => {
                fetched.push(url);
                if (url.endsWith("/a/doc.pdf")) return to("../b/doc.pdf", 307);
                if (url.endsWith("/b/doc.pdf")) return to("https://cdn.example/doc.pdf", 301);
                return ok();
            }),
        });
        expect((await store.getObject("doc.pdf")).contentLength).toBe(1);
        expect(fetched).toEqual([
            "https://origin.example/a/doc.pdf",
            "https://origin.example/b/doc.pdf",
            "https://cdn.example/doc.pdf",
        ]);
    });

    test("follow: a hop to another origin carries no caller header, a same-origin hop keeps them", async () => {
        const seen: Record<string, string>[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            headers: { Authorization: "Bearer t", "X-Api-Key": "k", Cookie: "s=1" },
            redirect: "follow",
            fetch: stubFetch((url, init) => {
                seen.push(headersOf(init));
                if (url === "https://origin.example/doc.pdf") return to("/moved.pdf");
                if (url === "https://origin.example/moved.pdf") return to("https://cdn.example/doc.pdf");
                if (url === "https://cdn.example/doc.pdf") return to("https://origin.example/back.pdf");
                return new Response("x", { status: 206, headers: { "Content-Range": "bytes 0-0/1" } });
            }),
        });
        await store.getObject("doc.pdf", { range: { start: 0, end: 0 }, ifMatch: '"v1"' });

        expect(seen[1]).toMatchObject({ authorization: "Bearer t", "x-api-key": "k", cookie: "s=1" });
        const own = { "accept-encoding": "identity", range: "bytes=0-0", "if-match": '"v1"' };
        // Dropped at the first foreign origin, and not restored on the way back.
        expect(seen[2]).toEqual(own);
        expect(seen[3]).toEqual(own);
    });

    const refusedHops: Record<string, string | null> = {
        "a scheme that is not http or https": "file:///etc/passwd",
        "another unknown scheme": "gopher://internal.example/x",
        "a downgrade from https to http": "http://origin.example/doc.pdf",
        "no Location": null,
        "a Location that is not a URL": "http://[bad",
    };
    for (const [what, location] of Object.entries(refusedHops)) {
        test(`follow: a redirect to ${what} is refused without another request`, async () => {
            let requests = 0;
            const store = httpStore({
                url: (key) => `https://origin.example/${key}`,
                redirect: "follow",
                fetch: stubFetch(() => {
                    requests++;
                    return to(location);
                }),
            });
            await expect(store.getObject("doc.pdf")).rejects.toThrow(
                "httpStore GET: the origin's redirect was refused",
            );
            expect(requests).toBe(1);
        });
    }

    test("follow: a redirect loop stops after 10 hops", async () => {
        let requests = 0;
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            redirect: "follow",
            fetch: stubFetch(() => {
                requests++;
                return to("/again");
            }),
        });
        await expect(store.headObject("doc.pdf")).rejects.toThrow("httpStore HEAD: the origin's redirect was refused");
        expect(requests).toBe(11);
    });

    test("follow: a redirect body is released before the next hop", async () => {
        let cancelled = 0;
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            redirect: "follow",
            fetch: stubFetch((url) => {
                if (url.endsWith("/next")) return ok();
                const body = new ReadableStream<Uint8Array>({
                    cancel() {
                        cancelled++;
                    },
                });
                return new Response(body, { status: 302, headers: { Location: "/next" } });
            }),
        });
        await store.getObject("doc.pdf");
        expect(cancelled).toBe(1);
    });
});

describe("httpStore: key spellings the guard reads", () => {
    const ok = stubFetch(() => new Response(null, { status: 200, headers: { "content-length": "3", etag: '"e"' } }));

    test("a key that is not valid percent-encoding is read as written", async () => {
        const meta = await httpStore({ url: (k) => `https://o.example/${k}`, fetch: ok }).headObject("docs/a%zz.pdf");
        expect(meta.contentLength).toBe(3);
    });

    test("a verbatim store reads a key no URL parser resolves", async () => {
        const store = httpStore({ url: () => "https://o.example/x", fetch: ok, keys: "verbatim" });
        expect((await store.headObject("a/[x")).contentLength).toBe(3);
    });

    test("a url() that builds a non-http(s) URL is refused before any fetch", async () => {
        let fetched = 0;
        const counted = (async () => {
            fetched++;
            return new Response("abc");
        }) as unknown as typeof fetch;
        for (const built of ["localhost:8080/x", "s3://bucket/x", "file:///etc/passwd", "relative/x"]) {
            const store = httpStore({ url: () => built, fetch: counted });
            await expect(store.headObject("docs/q1.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.getObject("docs/q1.pdf")).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(fetched).toBe(0);
    });

    test("a key that starts with a special scheme is refused under either policy", async () => {
        // `new URL(key, base)` would take its host from the key.
        for (const keys of ["plain", "verbatim"] as const) {
            const store = httpStore({ url: () => "https://o.example/x", fetch: ok, keys });
            await expect(store.headObject("http://[x")).rejects.toBeInstanceOf(ObjectNotFoundError);
            await expect(store.headObject("http:/evil.example/x")).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
    });

    test("a verbatim store reads a key with an empty segment, which a plain one refuses", async () => {
        const url = (): string => "https://o.example/x";
        expect((await httpStore({ url, fetch: ok, keys: "verbatim" }).headObject("a//b")).contentLength).toBe(3);
        await expect(httpStore({ url, fetch: ok }).headObject("a//b")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
});

describe("httpStore: dot segments and the verbatim key policy", () => {
    function counting(keys?: "plain" | "verbatim") {
        const urls: string[] = [];
        const store = httpStore({
            url: (key) => `https://origin.example/${key}`,
            keys,
            fetch: stubFetch((url) => {
                urls.push(url);
                return new Response(null, { headers: { "Content-Length": "1" } });
            }),
        });
        return { store, urls };
    }

    const DOT_SEGMENT_KEYS = [
        "../private/secret.pdf",
        "a/../.uploads/x",
        "a/./b",
        "%2e%2e/x",
        "a/%2E%2e/b",
        "a\\..\\b",
        "．．/x",
        "a/.%2e/b",
        "a/.. /b",
        // The URL parser deletes ASCII tab and newline before it splits the path.
        ".\t./private/secret.pdf",
        ".\r./x",
        ".\n./x",
        "%2e\t%2e/x",
    ];

    for (const keys of ["plain", "verbatim"] as const) {
        test(`${keys}: a key with a dot segment in any spelling is refused before any request`, async () => {
            const { store, urls } = counting(keys);
            for (const key of DOT_SEGMENT_KEYS) {
                await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
                await expect(store.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
            }
            expect(urls).toEqual([]);
        });
    }

    test("plain: a segment of only tab, newline or carriage return is an empty segment", async () => {
        const { store, urls } = counting("plain");
        await expect(store.headObject("a/\t/b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        await expect(store.getObject("a/\r\n/b")).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(urls).toEqual([]);
    });

    test("verbatim: the empty segment is the only thing the policy lets through", async () => {
        const { store, urls } = counting("verbatim");
        await store.headObject("reports//q1.pdf");
        expect(urls).toEqual(["https://origin.example/reports//q1.pdf"]);
    });

    test("verbatim: a reserved prefix is also tested against the slash-collapsed key", async () => {
        const { store, urls } = counting("verbatim");
        for (const key of [".uploads//x", "/.uploads/x", "//.partial-content-uploads//x"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(urls).toEqual([]);
    });

    test("a key shaped like a scheme is a path, and reaches the origin", async () => {
        const { store, urls } = counting();
        await store.headObject("ab:c");
        await store.headObject("tenant:42/a.pdf");
        expect(urls).toEqual(["https://origin.example/ab:c", "https://origin.example/tenant:42/a.pdf"]);
    });

    test("trailing dots and spaces of a segment do not hide the reserved prefix", async () => {
        const { store, urls } = counting();
        for (const key of [".uploads./x", ".uploads /x", ".uploads. ./x", ".partial-content-uploads../x.info"]) {
            await expect(store.headObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
        }
        expect(urls).toEqual([]);
        // A key that merely ends in a dot elsewhere is an ordinary key.
        await store.headObject("docs/v1.");
        expect(urls).toEqual(["https://origin.example/docs/v1."]);
    });
});

describe("httpStore: bodies it does not serve", () => {
    /**
     * A 404 whose body is one chunk and then, only when read again, its end:
     * with no high-water mark nothing ends the body unless the drain asks.
     */
    function notFoundWith(chunk: Uint8Array): { fetch: typeof globalThis.fetch; cancelled: () => boolean } {
        let cancelled = false;
        const fetch = stubFetch(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>(
                        {
                            start(controller) {
                                controller.enqueue(chunk);
                            },
                            pull(controller) {
                                controller.close();
                            },
                            cancel() {
                                cancelled = true;
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                    { status: 404 },
                ),
        );
        return { fetch, cancelled: () => cancelled };
    }

    test("an error body up to the drain bound is read to its end, so the connection is reused", async () => {
        const origin = notFoundWith(new Uint8Array(64 * 1024));
        await expect(
            httpStore({ url: () => "https://o.example/x", fetch: origin.fetch }).getObject("k"),
        ).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(origin.cancelled()).toBe(false);
    });

    test("an error body past the drain bound is cancelled", async () => {
        const origin = notFoundWith(new Uint8Array(64 * 1024 + 1));
        await expect(
            httpStore({ url: () => "https://o.example/x", fetch: origin.fetch }).getObject("k"),
        ).rejects.toBeInstanceOf(ObjectNotFoundError);
        expect(origin.cancelled()).toBe(true);
    });
});

describe("httpStore: served body backpressure", () => {
    test("an unread body reads at most one chunk ahead of the consumer", async () => {
        let pulls = 0;
        // A response shape over the raw stream: a runtime Response may read its
        // body source ahead, which would hide the store's own read-ahead.
        const fetch = stubFetch(
            () =>
                ({
                    status: 200,
                    ok: true,
                    headers: new Headers({ "content-length": "30", etag: '"e"' }),
                    body: new ReadableStream<Uint8Array>(
                        {
                            pull(controller) {
                                pulls++;
                                controller.enqueue(new Uint8Array(3));
                                if (pulls === 10) controller.close();
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                }) as unknown as Response,
        );
        const obj = await httpStore({ url: () => "https://o.example/x", fetch }).getObject("k");
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(pulls).toBeLessThanOrEqual(1);
        expect((await new Response(asStream(obj.body)).arrayBuffer()).byteLength).toBe(30);
    });
});
