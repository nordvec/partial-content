import { describe, test, expect } from "bun:test";
import { serveObject, serveObjectRaw, type ServeAuditEvent, type TransferEvent } from "../web";
import { OPEN_ENDED, ObjectNotFoundError, StoreUnavailableError } from "../index";
import type { ObjectStore, ObjectMetadata, ObjectStream, ParsedRange } from "../index";

// ─── In-Memory Store ────────────────────────────────────────────────────────

interface MemoryStoreOpts {
    /** Object content. */
    content?: string;
    /** Backend ETag (raw, as a store would return it). */
    etag?: string;
    /** Last-Modified date string. */
    lastModified?: string;
    /** RFC 9530 raw base64 SHA-256 digest. */
    digest?: string;
    /** Override the served range the GET result reports (TOCTOU tests). */
    rangeOverride?: { start: number; end: number } | null;
    /** Throw this error from headObject/getObject. */
    error?: unknown;
    /** Record calls for assertions. */
    calls?: string[];
}

function bytesOf(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

/** A well-behaved in-memory ObjectStore for exercising the web adapter. */
function memoryStore(opts: MemoryStoreOpts = {}): ObjectStore {
    const content = opts.content ?? "0123456789abcdefghij"; // 20 bytes
    const data = bytesOf(content);

    return {
        supportsRange: true,

        async headObject(key: string): Promise<ObjectMetadata> {
            opts.calls?.push(`head:${key}`);
            if (opts.error) throw opts.error;
            return {
                contentLength: data.length,
                etag: opts.etag,
                lastModified: opts.lastModified,
                digest: opts.digest,
            };
        },

        async getObject(key: string, getOpts?: { range?: ParsedRange; ifMatch?: string }): Promise<ObjectStream> {
            const range = getOpts?.range;
            opts.calls?.push(`get:${key}:${range ? `${range.start}-${range.end}` : "full"}`);
            if (opts.error) throw opts.error;

            const slice = range ? data.slice(range.start, range.end + 1) : data;
            const served = opts.rangeOverride !== undefined
                ? (opts.rangeOverride ?? undefined)
                : range
                    ? { start: range.start, end: range.end }
                    : undefined;

            return {
                body: streamOf(slice),
                contentLength: slice.length,
                totalSize: data.length,
                range: served,
                etag: opts.etag,
                lastModified: opts.lastModified,
                digest: opts.digest,
            };
        },
    };
}

function req(headers: Record<string, string> = {}, method = "GET"): Request {
    return new Request("http://localhost/files/test.bin", { method, headers });
}

const KEY = "test.bin";
const ETAG = '"abc123"';
const LAST_MODIFIED = "Sat, 28 Jun 2025 12:00:00 GMT";

// ─── Full Content (200) ─────────────────────────────────────────────────────

describe("serveObject: 200 full content", () => {
    test("plain GET streams the full body with protocol headers", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG, lastModified: LAST_MODIFIED }));
        const res = await handler(req(), { key: KEY, mime: "application/pdf" });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
        expect(res.headers.get("Content-Length")).toBe("20");
        expect(res.headers.get("Content-Type")).toBe("application/pdf");
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        expect(res.headers.get("ETag")).toBe(ETAG);
        expect(res.headers.get("Last-Modified")).toBe(LAST_MODIFIED);
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(res.headers.get("Content-Disposition")).toBe("attachment");
        expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    });

    test("Path C (no conditionals) derives a weak ETag from size + mtime when the store has no hash", async () => {
        const handler = serveObject(memoryStore({ lastModified: LAST_MODIFIED }));
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(200);
        const etag = res.headers.get("ETag");
        expect(etag).toStartWith('W/"');
        // Must equal what the HEAD path derives, so validators are stable
        // across first-visit (Path C) and revalidation (Path A) requests.
        const headRes = await handler(req({}, "HEAD"), { key: KEY });
        expect(headRes.headers.get("ETag")).toBe(etag!);
    });

    test("textual MIME gets charset=utf-8 appended by default", async () => {
        const handler = serveObject(memoryStore());
        const res = await handler(req(), { key: KEY, mime: "application/json" });
        expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    });

    test("filename produces a full Content-Disposition", async () => {
        const handler = serveObject(memoryStore(), { disposition: "inline" });
        const res = await handler(req(), { key: KEY, filename: "report.pdf" });
        expect(res.headers.get("Content-Disposition")).toBe("inline; filename=report.pdf");
    });
});

// ─── Range Requests (206 / 416) ─────────────────────────────────────────────

describe("serveObject: range requests", () => {
    test("Range: bytes=0-9 returns 206 with correct slice and Content-Range", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("0123456789");
        expect(res.headers.get("Content-Range")).toBe("bytes 0-9/20");
        expect(res.headers.get("Content-Length")).toBe("10");
    });

    test("suffix range bytes=-5 returns the last 5 bytes", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=-5" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(res.headers.get("Content-Range")).toBe("bytes 15-19/20");
    });

    test("unsatisfiable range returns 416 with bytes */total", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=500-" }), { key: KEY });

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe("bytes */20");
        expect(res.headers.get("Content-Length")).toBe("0");
    });

    test("TOCTOU guard: store ignores the range -> 200 full, never a lying 206", async () => {
        const store = memoryStore({ etag: ETAG, rangeOverride: null });
        // Store will serve a slice but report no served range: adapter must
        // treat it as full content per the store's own accounting.
        store.getObject = async () => ({
            body: streamOf(bytesOf("0123456789abcdefghij")),
            contentLength: 20,
            totalSize: 20,
            etag: ETAG,
        });
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Range")).toBeNull();
        expect(res.headers.get("Content-Length")).toBe("20");
    });

    test("backend's ACTUAL served range wins over the requested range", async () => {
        // Object shrank between HEAD (20 bytes) and GET: backend clamped the
        // requested 0-9 to 0-4/5. Headers must reflect the actual bytes.
        const store = memoryStore({ etag: ETAG });
        store.getObject = async () => ({
            body: streamOf(bytesOf("01234")),
            contentLength: 5,
            totalSize: 5,
            range: { start: 0, end: 4 },
            etag: ETAG,
        });
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Range")).toBe("bytes 0-4/5");
        expect(res.headers.get("Content-Length")).toBe("5");
    });

    test("incoherent served range from the store fails loudly with 502 and cancels the stream", async () => {
        const errors: unknown[] = [];
        let cancelled = false;
        const stream = streamOf(bytesOf("0123456789"));
        const origCancel = stream.cancel.bind(stream);
        stream.cancel = (reason?: unknown) => {
            cancelled = true;
            return origCancel(reason);
        };
        const store = memoryStore({ etag: ETAG });
        // end >= totalSize: bounds a correct backend can never produce.
        store.getObject = async () => ({
            body: stream,
            contentLength: 10,
            totalSize: 20,
            range: { start: 15, end: 25 },
            etag: ETAG,
        });
        const handler = serveObject(store, { onError: (err) => errors.push(err) });
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
        // The stream never reached a Response; without cancellation the
        // backing resource (fs handle, pooled socket) would leak.
        expect(cancelled).toBe(true);
    });

    test("206 whose contentLength disagrees with the served span fails loudly with 502", async () => {
        // Coherent bounds, but the store reports a byte count that does NOT
        // match the span. Content-Length would be built from the span (5) while
        // the body streams contentLength (10) bytes -> a truncated/over-run 206
        // the client cannot distinguish from a complete one. The multipart path
        // guards this per part; the single-range path must too.
        let cancelled = false;
        const stream = streamOf(bytesOf("0123456789"));
        const origCancel = stream.cancel.bind(stream);
        stream.cancel = (reason?: unknown) => { cancelled = true; return origCancel(reason); };
        const store = memoryStore({ etag: ETAG });
        store.getObject = async () => ({
            body: stream,
            contentLength: 10,           // 10 bytes...
            totalSize: 20,
            range: { start: 0, end: 4 }, // ...but the span is 5
            etag: ETAG,
        });
        const errors: unknown[] = [];
        const handler = serveObject(store, { onError: (err) => errors.push(err) });
        const res = await handler(req({ Range: "bytes=0-4" }), { key: KEY });

        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
        expect(cancelled).toBe(true);
    });

    test("200 whose contentLength disagrees with totalSize fails loudly with 502", async () => {
        let cancelled = false;
        const stream = streamOf(bytesOf("0123456789"));
        const origCancel = stream.cancel.bind(stream);
        stream.cancel = (reason?: unknown) => { cancelled = true; return origCancel(reason); };
        const store = memoryStore({ etag: ETAG });
        store.getObject = async () => ({
            body: stream,
            contentLength: 10,   // body is 10 bytes...
            totalSize: 20,       // ...but the full size is advertised as 20
            etag: ETAG,
        });
        const handler = serveObject(store);
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(502);
        expect(cancelled).toBe(true);
    });

    test("If-Range with matching strong ETag honors the range", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(
            req({ Range: "bytes=0-9", "If-Range": ETAG }),
            { key: KEY },
        );
        expect(res.status).toBe(206);
    });

    test("If-Range with stale ETag ignores the range and serves 200", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(
            req({ Range: "bytes=0-9", "If-Range": '"old-version"' }),
            { key: KEY },
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
    });
});

// ─── Conditional Requests (304 / 412) ───────────────────────────────────────

describe("serveObject: conditional requests", () => {
    test("If-None-Match hit returns 304 without a body", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ "If-None-Match": ETAG }), { key: KEY });

        expect(res.status).toBe(304);
        expect(res.headers.get("ETag")).toBe(ETAG);
        expect(res.body).toBeNull();
    });

    test("If-Match mismatch returns 412", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ "If-Match": '"other"' }), { key: KEY });
        expect(res.status).toBe(412);
    });

    test("If-Modified-Since not-modified returns 304", async () => {
        const handler = serveObject(memoryStore({ lastModified: LAST_MODIFIED }));
        const res = await handler(
            req({ "If-Modified-Since": "Sun, 29 Jun 2025 12:00:00 GMT" }),
            { key: KEY },
        );
        expect(res.status).toBe(304);
    });
});

// ─── HEAD ───────────────────────────────────────────────────────────────────

describe("serveObject: HEAD", () => {
    test("HEAD returns full-size headers and no body", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG, lastModified: LAST_MODIFIED }));
        const res = await handler(req({}, "HEAD"), { key: KEY, mime: "application/pdf" });

        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
        expect(res.headers.get("Content-Length")).toBe("20");
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        expect(res.headers.get("ETag")).toBe(ETAG);
    });

    test("conditional HEAD returns 304 (RFC 9110 Section 13.1: conditionals apply to HEAD)", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ "If-None-Match": ETAG }, "HEAD"), { key: KEY });
        expect(res.status).toBe(304);
        expect(res.body).toBeNull();
    });

    test("HEAD with failing If-Match returns 412", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ "If-Match": '"other"' }, "HEAD"), { key: KEY });
        expect(res.status).toBe(412);
    });

    test("HEAD ignores Range (RFC 9110 Section 14.2: range handling is GET-only)", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=0-9" }, "HEAD"), { key: KEY });

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Length")).toBe("20");
        expect(res.headers.get("Content-Range")).toBeNull();
    });

    test("HEAD never calls getObject", async () => {
        const calls: string[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG, calls }));
        await handler(req({}, "HEAD"), { key: KEY });
        expect(calls).toEqual([`head:${KEY}`]);
    });
});

// ─── Errors ─────────────────────────────────────────────────────────────────

describe("serveObject: error handling", () => {
    test("missing object returns 404 with truthful Content-Length", async () => {
        const err = Object.assign(new Error("not here"), { status: 404 });
        const handler = serveObject(memoryStore({ error: err }));
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(404);
        const body = await res.text();
        expect(String(body.length)).toBe(res.headers.get("Content-Length")!);
    });

    test("store failure returns 502 with truthful Content-Length and fires onError", async () => {
        const errors: Array<{ key: string; operation: string }> = [];
        const handler = serveObject(
            memoryStore({ error: new Error("connection refused") }),
            { onError: (_err, ctx) => errors.push(ctx) },
        );
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(502);
        const body = await res.text();
        expect(String(body.length)).toBe(res.headers.get("Content-Length")!);
        expect(errors).toEqual([{ key: KEY, operation: "get" }]);
    });

    test("unsupported method returns 405 with Allow header", async () => {
        const handler = serveObject(memoryStore());
        const res = await handler(req({}, "POST"), { key: KEY });

        expect(res.status).toBe(405);
        expect(res.headers.get("Allow")).toBe("GET, HEAD");
    });

    test("corrupt store metadata (NaN size) returns 502, never throws", async () => {
        const errors: unknown[] = [];
        const store = memoryStore({ etag: ETAG });
        store.headObject = async () => ({ contentLength: NaN, etag: ETAG });
        const handler = serveObject(store, { onError: (err) => errors.push(err) });
        // Conditional request forces Path A, where evaluation validates size.
        const res = await handler(req({ "If-None-Match": '"other"' }), { key: KEY });

        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
    });

    test("client abort returns 499", async () => {
        const store = memoryStore();
        store.getObject = async () => {
            throw new DOMException("The operation was aborted", "AbortError");
        };
        const handler = serveObject(store);
        const res = await handler(req(), { key: KEY });
        expect(res.status).toBe(499);
    });
});

// ─── Non-Streaming Degradation ──────────────────────────────────────────────

describe("serveObject: supportsRange=false degradation", () => {
    test("redirects to a signed URL when the store provides one", async () => {
        const store: ObjectStore = {
            supportsRange: false,
            headObject: async () => ({ contentLength: 1 }),
            getObject: async () => { throw new Error("unreachable"); },
            createSignedUrl: async () => ({ ok: true, url: "https://cdn.example/signed" }),
        };
        const handler = serveObject(store);
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("https://cdn.example/signed");
        expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache");
    });

    test("a malformed signed URL is sanitized before it reaches the Location header", () => {
        const store: ObjectStore = {
            supportsRange: false,
            headObject: async () => ({ contentLength: 1 }),
            getObject: async () => { throw new Error("unreachable"); },
            createSignedUrl: async () => ({ ok: true, url: "https://cdn/x\r\nSet-Cookie: evil=1" }),
        };
        const handler = serveObject(store);
        return handler(req(), { key: KEY }).then((res) => {
            expect(res.status).toBe(302);
            const loc = res.headers.get("Location")!;
            expect(loc).not.toContain("\r");
            expect(loc).not.toContain("\n");
        });
    });

    test("returns 502 with truthful Content-Length when no signed URL is possible", async () => {
        const store: ObjectStore = {
            supportsRange: false,
            headObject: async () => ({ contentLength: 1 }),
            getObject: async () => { throw new Error("unreachable"); },
        };
        const handler = serveObject(store);
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(502);
        const body = await res.text();
        expect(String(body.length)).toBe(res.headers.get("Content-Length")!);
    });
});

// ─── Observability ──────────────────────────────────────────────────────────

describe("serveObject: audit and headers", () => {
    test("onServe fires with range bounds on 206", async () => {
        const events: ServeAuditEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), {
            onServe: (e) => events.push(e),
        });
        await handler(req({ Range: "bytes=5-9" }), { key: KEY, mime: "video/mp4" });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: KEY, status: 206, mime: "video/mp4",
            bytesServed: 5, rangeStart: 5, rangeEnd: 9,
        });
    });

    test("onServe fires with bytesServed 0 on 304", async () => {
        const events: ServeAuditEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), {
            onServe: (e) => events.push(e),
        });
        await handler(req({ "If-None-Match": ETAG }), { key: KEY });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ status: 304, bytesServed: 0 });
    });

    test("onServe fires on 412 and 416: denials are audit events too", async () => {
        const events: ServeAuditEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), {
            onServe: (e) => events.push(e),
        });

        // Failed If-Match = optimistic-concurrency conflict -> 412
        const denied = await handler(req({ "If-Match": '"stale"' }), { key: KEY });
        expect(denied.status).toBe(412);

        // Unsatisfiable range -> 416
        const unsat = await handler(req({ Range: "bytes=999-1000" }), { key: KEY });
        expect(unsat.status).toBe(416);

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ key: KEY, status: 412, bytesServed: 0 });
        expect(events[1]).toMatchObject({ key: KEY, status: 416, bytesServed: 0, method: "GET" });
    });

    test("immutable option appends to Cache-Control", async () => {
        const handler = serveObject(memoryStore(), {
            cacheControl: "public, max-age=31536000",
            immutable: true,
        });
        const res = await handler(req(), { key: KEY });
        expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    });

    test("per-request Cache-Control is sanitized (a consumer may source it from data)", async () => {
        // ServeContext.cacheControl is per-request; a consumer routing a
        // per-document DB field into it must not be able to inject a header.
        const handler = serveObject(memoryStore());
        const res = await handler(req(), {
            key: KEY,
            cacheControl: "private\r\nSet-Cookie: evil=1",
        });
        const cc = res.headers.get("Cache-Control")!;
        expect(cc).not.toContain("\r");
        expect(cc).not.toContain("\n");
    });

    test("security headers and CORP are applied to body responses", async () => {
        const handler = serveObject(memoryStore(), {
            securityHeaders: () => ({ "Content-Security-Policy": "sandbox" }),
            crossOriginResourcePolicy: "same-origin",
        });
        const res = await handler(req(), { key: KEY });
        expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
        expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    });

    test("Repr-Digest is emitted from store metadata", async () => {
        const digest = "MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=";
        const handler = serveObject(memoryStore({ etag: ETAG, digest }));
        const res = await handler(req(), { key: KEY });
        expect(res.headers.get("Repr-Digest")).toBe(`sha-256=:${digest}:`);
    });

    test("Want-Repr-Digest: sha-256=0 suppresses the digest (RFC 9530 Section 4)", async () => {
        const digest = "MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=";
        const handler = serveObject(memoryStore({ etag: ETAG, digest }));
        const res = await handler(
            req({ "Want-Repr-Digest": "sha-256=0" }),
            { key: KEY },
        );
        expect(res.headers.get("Repr-Digest")).toBeNull();
    });

    test("Want-Repr-Digest listing only unsupported algorithms suppresses the digest", async () => {
        const digest = "MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=";
        const handler = serveObject(memoryStore({ etag: ETAG, digest }));
        const res = await handler(
            req({ "Want-Repr-Digest": "sha-512=5" }),
            { key: KEY },
        );
        expect(res.headers.get("Repr-Digest")).toBeNull();
    });

    test("ctx.cacheControl overrides the handler-level Cache-Control per request", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }), {
            cacheControl: "private, no-cache",
        });

        const immutable = await handler(req(), {
            key: KEY,
            cacheControl: "public, max-age=31536000, immutable",
        });
        expect(immutable.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

        // Requests without the override keep the handler default.
        const plain = await handler(req(), { key: KEY });
        expect(plain.headers.get("Cache-Control")).toBe("private, no-cache");

        // 304s carry the per-request value too (revalidation policy follows
        // the representation, not the handler).
        const notModified = await handler(req({ "If-None-Match": ETAG }), {
            key: KEY,
            cacheControl: "public, max-age=60",
        });
        expect(notModified.status).toBe(304);
        expect(notModified.headers.get("Cache-Control")).toBe("public, max-age=60");
    });

    test("adapter pin tokens round-trip from headObject metadata into getObject", async () => {
        // Stores with a non-ETag version identifier (GCS generations) issue
        // an opaque pin; the orchestrator must pass it back verbatim so the
        // store can skip its metadata re-fetch.
        const seen: Array<string | undefined> = [];
        const store = memoryStore({ etag: ETAG });
        const origHead = store.headObject.bind(store);
        store.headObject = async (key, headOpts) => ({
            ...(await origHead(key, headOpts)),
            pin: "opaque-token",
        });
        const origGet = store.getObject.bind(store);
        store.getObject = (key, getOpts: Parameters<typeof origGet>[1] & { pin?: string } = {}) => {
            seen.push(getOpts.pin);
            return origGet(key, getOpts);
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(seen).toEqual(["opaque-token"]);
    });

    test("pinned read: getObject receives the RAW backend etag as ifMatch", async () => {
        const pins: Array<string | undefined> = [];
        const store = memoryStore({ etag: ETAG });
        const origGet = store.getObject.bind(store);
        store.getObject = (key, getOpts) => {
            pins.push(getOpts?.ifMatch);
            return origGet(key, getOpts);
        };
        const handler = serveObject(store);
        // Path A (range request forces HEAD first)
        await handler(req({ Range: "bytes=0-9" }), { key: KEY });
        // Path C (no HEAD, so no pin available)
        await handler(req(), { key: KEY });

        expect(pins).toEqual([ETAG, undefined]);
    });

    test("weak backend ETags are never pinned (If-Match requires strong comparison)", async () => {
        // A weak validator would 412 on every compliant backend -> retry ->
        // 502 for a perfectly healthy object. The pin must be skipped and the
        // request must still succeed.
        const pins: Array<string | undefined> = [];
        const store = memoryStore({ etag: 'W/"weak-1"' });
        const origGet = store.getObject.bind(store);
        store.getObject = (key, getOpts) => {
            pins.push(getOpts?.ifMatch);
            return origGet(key, getOpts);
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(pins).toEqual([undefined]);
    });

    test("ObjectChangedError triggers ONE re-validation against the new state", async () => {
        const store = memoryStore({ etag: ETAG });
        const origGet = store.getObject.bind(store);
        let getCalls = 0;
        store.getObject = (key, getOpts) => {
            getCalls++;
            if (getCalls === 1) {
                const err = new Error("changed");
                err.name = "ObjectChangedError";
                throw err;
            }
            return origGet(key, getOpts);
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        // Second attempt succeeded: coherent 206 of the (new) object.
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("0123456789");
        expect(getCalls).toBe(2);
    });

    test("object churning through both attempts fails with 502, not a loop", async () => {
        const errors: unknown[] = [];
        const store = memoryStore({ etag: ETAG });
        let getCalls = 0;
        store.getObject = () => {
            getCalls++;
            const err = new Error("changed");
            err.name = "ObjectChangedError";
            throw err;
        };
        const handler = serveObject(store, { onError: (err) => errors.push(err) });
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(502);
        expect(getCalls).toBe(2);
        expect(errors).toHaveLength(1);
    });

    test("onServe fires with status 302 on signed-URL redirect", async () => {
        const events: ServeAuditEvent[] = [];
        const store: ObjectStore = {
            supportsRange: false,
            headObject: async () => ({ contentLength: 1 }),
            getObject: async () => { throw new Error("unreachable"); },
            createSignedUrl: async () => ({ ok: true, url: "https://cdn.example/signed" }),
        };
        const handler = serveObject(store, { onServe: (e) => events.push(e) });
        await handler(req(), { key: KEY });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ key: KEY, status: 302, bytesServed: 0 });
    });
});

describe("serveObject: never-throw contract (Path C)", () => {
    test("corrupt GET metadata on a plain GET returns 502, never throws", async () => {
        // Path C (no Range, no conditionals) skips HEAD entirely, so corrupt
        // metadata surfaces in the header builder. A rejected handler here
        // is an unhandled rejection in Express 4 (process crash).
        const errors: unknown[] = [];
        const store = memoryStore({});
        store.getObject = async () => ({
            body: streamOf(bytesOf("0123456789")),
            contentLength: NaN,
            totalSize: NaN,
        });
        const handler = serveObject(store, { onError: (err) => errors.push(err) });
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
    });

    test("throwing onServe hook serves normally; the failure surfaces via onError", async () => {
        // An observability outage must never become a delivery outage: hooks
        // are logging, not access control. The response goes out intact and
        // the hook failure is reported through onError with operation
        // "audit" (same contract on every emission site: 200/206/302/304/
        // 412/416/HEAD).
        const failures: Array<{ key: string; operation: string }> = [];
        const store = memoryStore({ etag: ETAG });
        const handler = serveObject(store, {
            onServe: () => { throw new Error("audit sink is down"); },
            onError: (_err, ctx) => { failures.push(ctx); },
        });
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
        expect(failures).toEqual([{ key: KEY, operation: "audit" }]);
    });

    test("supportsRange: false without createSignedUrl returns 502", async () => {
        const store = memoryStore({ etag: ETAG });
        (store as { supportsRange: boolean }).supportsRange = false;
        const handler = serveObject(store);
        const res = await handler(req(), { key: KEY });

        expect(res.status).toBe(502);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
});

describe("plain-range fast path (authoritative-range stores)", () => {
    /** Backend-faithful store: clamps ranges, reports SERVED bounds, and
     *  rejects start-beyond-EOF natively (like S3 InvalidRange). */
    function authoritativeStore(calls: string[] = []): ObjectStore {
        const data = bytesOf("0123456789abcdefghij"); // 20 bytes
        return {
            supportsRange: true,
            authoritativeRange: true,
            async headObject(key: string): Promise<ObjectMetadata> {
                calls.push(`head:${key}`);
                return { contentLength: data.length, etag: '"auth-v1"' };
            },
            async getObject(key: string, getOpts?: { range?: ParsedRange }): Promise<ObjectStream> {
                const range = getOpts?.range;
                calls.push(`get:${key}:${range ? `${range.start}-${range.end}` : "full"}`);
                if (range && range.start >= data.length) {
                    throw new Error("InvalidRange: start beyond EOF");
                }
                const end = range ? Math.min(range.end, data.length - 1) : data.length - 1;
                const slice = range ? data.slice(range.start, end + 1) : data;
                return {
                    body: streamOf(slice),
                    contentLength: slice.length,
                    totalSize: data.length,
                    range: range ? { start: range.start, end } : undefined,
                    etag: '"auth-v1"',
                };
            },
        };
    }

    test("plain bounded range is served in a single round-trip (no HEAD)", async () => {
        const calls: string[] = [];
        const handler = serveObject(authoritativeStore(calls));
        const res = await handler(req({ Range: "bytes=5-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(res.headers.get("Content-Range")).toBe("bytes 5-9/20");
        expect(res.headers.get("ETag")).toBe('"auth-v1"');
        expect(calls).toEqual([`get:${KEY}:5-9`]);
    });

    test("open-ended range serves the tail with backend-clamped bounds", async () => {
        const calls: string[] = [];
        const handler = serveObject(authoritativeStore(calls));
        const res = await handler(req({ Range: "bytes=15-" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(res.headers.get("Content-Range")).toBe("bytes 15-19/20");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toStartWith(`get:${KEY}:15-`);
    });

    test("Path B reports a terminal 404/503 to onError exactly once (hottest-path telemetry)", async () => {
        for (const { err, status } of [
            { err: new ObjectNotFoundError(KEY), status: 404 },
            { err: new StoreUnavailableError(KEY, { retryAfterSeconds: 7 }), status: 503 },
        ]) {
            const reported: Array<{ key: string; operation: string }> = [];
            const store: ObjectStore = {
                supportsRange: true,
                authoritativeRange: true,
                async headObject(): Promise<ObjectMetadata> { return { contentLength: 20, etag: '"v"' }; },
                async getObject(): Promise<ObjectStream> { throw err; },
            };
            const handler = serveObject(store, { onError: (_e, ctx) => reported.push(ctx) });
            const res = await handler(req({ Range: "bytes=0-4" }), { key: KEY });
            // A plain range on an authoritative-range store is served straight
            // from Path B and never re-runs Path A, so without the capture the
            // 404/503 would be invisible to onError on the hottest path.
            expect(res.status).toBe(status);
            expect(reported).toHaveLength(1);
            expect(reported[0].operation).toBe("get");
        }
    });

    test("unknown-total backend (bytes a-b/*) serves 206 with '*' in one round-trip", async () => {
        // A proxied streaming origin reports served bounds but no total
        // (`bytes a-b/*`). The orchestrator must trust the authoritative
        // bounds -- there is no EOF to bound-check against -- and emit `*`
        // rather than fabricating a size, all without a validating HEAD.
        const calls: string[] = [];
        const store: ObjectStore = {
            supportsRange: true,
            authoritativeRange: true,
            async headObject(key: string): Promise<ObjectMetadata> {
                calls.push(`head:${key}`);
                return { contentLength: 10 };
            },
            async getObject(key: string, getOpts?: { range?: ParsedRange }): Promise<ObjectStream> {
                const range = getOpts?.range;
                calls.push(`get:${key}:${range ? `${range.start}-${range.end}` : "full"}`);
                return {
                    body: streamOf(bytesOf("0123456789")),
                    contentLength: 10,
                    totalSize: undefined,
                    range: { start: 0, end: 9 },
                };
            },
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Range")).toBe("bytes 0-9/*");
        expect(res.headers.get("Content-Length")).toBe("10");
        expect(await res.text()).toBe("0123456789");
        expect(calls).toEqual([`get:${KEY}:0-9`]);
    });

    test("start beyond EOF: native backend rejection falls back to a correct 416", async () => {
        const calls: string[] = [];
        const handler = serveObject(authoritativeStore(calls));
        const res = await handler(req({ Range: "bytes=100-200" }), { key: KEY });

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe("bytes */20");
        // Fast GET attempt, then the validating HEAD path resolves the 416.
        expect(calls[0]).toBe(`get:${KEY}:100-200`);
        expect(calls[1]).toBe(`head:${KEY}`);
    });

    test("conditional range requests still take the validating HEAD path", async () => {
        const calls: string[] = [];
        const handler = serveObject(authoritativeStore(calls));
        const res = await handler(
            req({ Range: "bytes=5-9", "If-None-Match": '"auth-v1"' }),
            { key: KEY },
        );

        expect(res.status).toBe(304);
        expect(calls).toEqual([`head:${KEY}`]);
    });

    test("suffix ranges fall back to the HEAD path (need totalSize to resolve)", async () => {
        const calls: string[] = [];
        const handler = serveObject(authoritativeStore(calls));
        const res = await handler(req({ Range: "bytes=-5" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(calls[0]).toBe(`head:${KEY}`);
    });

    test("store that echoes unclamped bounds despite the flag still yields a correct response", async () => {
        // Misdeclared adapter: claims authoritativeRange but echoes the
        // requested (unclamped) bounds. The response-side guard rejects the
        // incoherent 206 and the request self-heals via the HEAD path.
        const store = authoritativeStore();
        const origGet = store.getObject.bind(store);
        store.getObject = async (key, getOpts) => {
            const result = await origGet(key, getOpts);
            if (getOpts?.range) result.range = { start: getOpts.range.start, end: getOpts.range.end };
            return result;
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=15-" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("fghij");
        expect(res.headers.get("Content-Range")).toBe("bytes 15-19/20");
    });

    test("stores without the flag are untouched: range still validates via HEAD", async () => {
        const calls: string[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG, calls }));
        const res = await handler(req({ Range: "bytes=5-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(calls[0]).toBe(`head:${KEY}`);
    });

    test("a failing fast attempt reports onError exactly ONCE (via Path A), not twice", async () => {
        // The speculative fast GET must not double-count failures: only Path A,
        // the authoritative path, reports. A transient blip that Path A also
        // hits should surface one onError, never a phantom pair.
        const errors: Array<{ operation: string }> = [];
        const store: ObjectStore = {
            supportsRange: true,
            authoritativeRange: true,
            headObject: async () => { throw new Error("backend down"); },
            getObject: async () => { throw new Error("backend down"); },
        };
        const handler = serveObject(store, { onError: (_e, ctx) => errors.push(ctx) });
        const res = await handler(req({ Range: "bytes=0-9" }), { key: KEY });

        expect(res.status).toBe(502);
        expect(errors).toHaveLength(1);
        expect(errors[0].operation).toBe("head");
    });

    test("open-ended fast range sends bytes=a- on the wire, not a 16-digit end", async () => {
        // Verifies the OPEN_ENDED sentinel never leaks as a literal
        // last-byte-pos into a store that formats a Range header.
        let seenRange: { start: number; end: number } | undefined;
        const data = bytesOf("0123456789abcdefghij");
        const store: ObjectStore = {
            supportsRange: true,
            authoritativeRange: true,
            headObject: async () => ({ contentLength: data.length }),
            getObject: async (_k, o) => {
                seenRange = o?.range;
                const end = data.length - 1;
                const start = o?.range?.start ?? 0;
                return {
                    body: streamOf(data.slice(start)),
                    contentLength: data.length - start,
                    totalSize: data.length,
                    range: { start, end },
                };
            },
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=15-" }), { key: KEY });
        expect(res.status).toBe(206);
        // The adapter received the OPEN_ENDED sentinel; a real adapter maps it
        // to `bytes=15-`. Assert the sentinel is what flows (not a clamped end).
        expect(seenRange).toEqual({ start: 15, end: OPEN_ENDED });
    });
});

// ─── Transfer-completion metering (onTransfer) ──────────────────────────────

describe("transfer-completion (onTransfer)", () => {
    /** Store whose body streams several discrete chunks (to interrupt mid-way). */
    function multiChunkStore(chunks: string[]): ObjectStore {
        const parts = chunks.map(bytesOf);
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        return {
            supportsRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return { contentLength: total, etag: ETAG };
            },
            async getObject(): Promise<ObjectStream> {
                let i = 0;
                const body = new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (i < parts.length) controller.enqueue(parts[i++]!);
                        else controller.close();
                    },
                });
                return { body, contentLength: total, totalSize: total, etag: ETAG };
            },
        };
    }

    /** Store whose GET returns a byte body (Uint8Array), not a stream. */
    function byteStore(content: string): ObjectStore {
        const data = bytesOf(content);
        return {
            supportsRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return { contentLength: data.length, etag: ETAG };
            },
            async getObject(): Promise<ObjectStream> {
                return { body: data, contentLength: data.length, totalSize: data.length, etag: ETAG };
            },
        };
    }

    test("reports the full byte count and completed=true on a drained body", async () => {
        const events: TransferEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), { onTransfer: (e) => events.push(e) });
        const res = await handler(req(), { key: KEY });

        expect(await res.text()).toBe("0123456789abcdefghij"); // drains fully
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: KEY, method: "GET", status: 200,
            bytesExpected: 20, bytesTransferred: 20, completed: true,
        });
    });

    test("reports partial bytes and completed=false when the client disconnects early", async () => {
        const events: TransferEvent[] = [];
        const handler = serveObject(multiChunkStore(["aaaa", "bbbb", "cccc"]), {
            onTransfer: (e) => events.push(e),
        });
        const res = await handler(req(), { key: KEY });

        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.value && new TextDecoder().decode(first.value)).toBe("aaaa");
        await reader.cancel(); // client goes away mid-stream

        expect(events).toHaveLength(1);
        expect(events[0]!.completed).toBe(false);
        expect(events[0]!.bytesExpected).toBe(12);
        // Fewer bytes reached the client than were granted (exact count depends
        // on stream pull-ahead, but it is a strict, non-zero fraction).
        expect(events[0]!.bytesTransferred).toBeGreaterThan(0);
        expect(events[0]!.bytesTransferred).toBeLessThan(12);
    });

    test("carries 206 range bounds on the transfer event", async () => {
        const events: TransferEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), { onTransfer: (e) => events.push(e) });
        const res = await handler(req({ Range: "bytes=5-9" }), { key: KEY });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(events[0]).toMatchObject({
            status: 206, bytesExpected: 5, bytesTransferred: 5, completed: true,
            rangeStart: 5, rangeEnd: 9,
        });
    });

    test("byte-body stores are metered too (uniform measurement across body shapes)", async () => {
        const events: TransferEvent[] = [];
        const handler = serveObject(byteStore("hello"), { onTransfer: (e) => events.push(e) });
        const res = await handler(req(), { key: KEY });

        expect(await res.text()).toBe("hello");
        expect(events[0]).toMatchObject({ bytesExpected: 5, bytesTransferred: 5, completed: true });
    });

    test("without onTransfer a byte body keeps the static-body fast path (Uint8Array)", async () => {
        const raw = serveObjectRaw(byteStore("hello"));
        const parts = await raw(req(), { key: KEY });
        expect(parts.body).toBeInstanceOf(Uint8Array);
    });

    test("with onTransfer a byte body is wrapped in a counting stream", async () => {
        const raw = serveObjectRaw(byteStore("hello"), { onTransfer: () => { /* noop */ } });
        const parts = await raw(req(), { key: KEY });
        expect(parts.body).toBeInstanceOf(ReadableStream);
    });

    test("a throwing onTransfer routes to onError (operation 'audit') without corrupting the transfer", async () => {
        const failures: Array<{ key: string; operation: string }> = [];
        const handler = serveObject(byteStore("hello"), {
            onTransfer: () => { throw new Error("meter sink is down"); },
            onError: (_err, ctx) => { failures.push(ctx); },
        });
        const res = await handler(req(), { key: KEY });

        expect(await res.text()).toBe("hello"); // transfer completes cleanly
        expect(failures).toEqual([{ key: KEY, operation: "audit" }]);
    });
});

// ─── Multi-range (multipart/byteranges) ─────────────────────────────────────

describe("multi-range serving (multipart/byteranges)", () => {
    /** Decode a multipart/byteranges body into its part Content-Range lines. */
    function partRanges(body: string): string[] {
        return [...body.matchAll(/Content-Range: (bytes \d+-\d+\/\d+)/g)].map((m) => m[1]!);
    }

    test("two disjoint ranges are served as multipart/byteranges with an exact Content-Length", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=0-4,10-14" }), { key: KEY, mime: "text/plain" });

        expect(res.status).toBe(206);
        const ctype = res.headers.get("Content-Type") ?? "";
        expect(ctype).toStartWith("multipart/byteranges; boundary=");

        const buf = await res.arrayBuffer();
        // The killer assertion: the precomputed Content-Length is exact.
        expect(res.headers.get("Content-Length")).toBe(String(buf.byteLength));

        const bodyText = new TextDecoder().decode(buf);
        expect(partRanges(bodyText)).toEqual(["bytes 0-4/20", "bytes 10-14/20"]);
        // Each part's Content-Type is the representation MIME (with charset).
        expect(bodyText).toContain("Content-Type: text/plain; charset=utf-8");
        // The actual sliced bytes appear in the body.
        expect(bodyText).toContain("01234");
        expect(bodyText).toContain("abcde");
        // The body ends with the closing boundary delimiter.
        const boundary = ctype.split("boundary=")[1]!;
        expect(bodyText.endsWith(`--${boundary}--\r\n`)).toBe(true);
    });

    test("overlapping ranges coalesce to a single normal 206 (not multipart)", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=0-4,2-8" }), { key: KEY, mime: "text/plain" });

        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Type")).not.toContain("multipart");
        expect(res.headers.get("Content-Range")).toBe("bytes 0-8/20");
        expect(await res.text()).toBe("012345678");
    });

    test("all-unsatisfiable multi-range yields 416", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=100-200,300-400" }), { key: KEY });

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe("bytes */20");
    });

    test("range-amplification (too many parts) degrades to a full 200", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }), { maxRanges: 2 });
        const res = await handler(req({ Range: "bytes=0-0,2-2,4-4" }), { key: KEY });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
    });

    test("ranges covering the whole file degrade to a full 200", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(req({ Range: "bytes=0-9,10-19" }), { key: KEY });

        expect(res.status).toBe(200);
        expect((await res.text()).length).toBe(20);
    });

    test("conditionals still win: If-None-Match on a multi-range yields 304", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG }));
        const res = await handler(
            req({ Range: "bytes=0-4,10-14", "If-None-Match": ETAG }),
            { key: KEY },
        );
        expect(res.status).toBe(304);
    });

    test("stale If-Range on a multi-range serves the full 200", async () => {
        const handler = serveObject(memoryStore({ etag: ETAG, lastModified: LAST_MODIFIED }));
        const res = await handler(
            req({ Range: "bytes=0-4,10-14", "If-Range": '"stale-etag"' }),
            { key: KEY },
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
    });

    test("a store serving a mismatched span fails loudly (no spliced/short 206)", async () => {
        // A non-pinning store that races: it reports the requested bounds but
        // hands back the WRONG byte count (full object, not the range span) --
        // exactly what a concurrent overwrite looks like. The per-part guard
        // must reject it rather than emit a body that violates the committed
        // multipart Content-Length.
        const data = bytesOf("0123456789abcdefghij");
        const store: ObjectStore = {
            supportsRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return { contentLength: data.length, etag: ETAG };
            },
            async getObject(_key: string, getOpts?: { range?: ParsedRange }): Promise<ObjectStream> {
                const range = getOpts?.range;
                return {
                    body: streamOf(data),        // full body...
                    contentLength: data.length,  // ...but claims the range span
                    totalSize: data.length,
                    range: range ? { start: range.start, end: range.end } : undefined,
                };
            },
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-4,10-14" }), { key: KEY });

        // The eager first-part guard throws ObjectChangedError; after the single
        // re-validation still fails, the orchestrator returns 502 -- never a 206
        // with a body that disagrees with its Content-Length.
        expect(res.status).toBe(502);
    });

    test("cancelling the multipart body before the first pull releases the eager first part", async () => {
        // The first part is fetched up front (so a pinned race surfaces before
        // headers commit). If the client disconnects between the handler
        // returning and the runtime's first pull, gen.return() runs no finally,
        // so the outer cancel must release firstStream itself -- otherwise a
        // stream part's file handle/socket leaks.
        const data = bytesOf("0123456789abcdefghij");
        let getCalls = 0;
        let firstCancelled = false;
        const store: ObjectStore = {
            supportsRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return { contentLength: data.length, etag: ETAG };
            },
            async getObject(_key: string, getOpts?: { range?: ParsedRange }): Promise<ObjectStream> {
                getCalls++;
                const range = getOpts!.range!;
                const slice = data.subarray(range.start, range.end + 1);
                const body = new ReadableStream<Uint8Array>({
                    start(c) { c.enqueue(slice); c.close(); },
                    cancel() { firstCancelled = true; },
                });
                return { body, contentLength: slice.length, totalSize: data.length, range: { start: range.start, end: range.end }, etag: ETAG };
            },
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-4,10-14" }), { key: KEY });
        expect(res.status).toBe(206);

        // Only the eager first part was fetched; cancel before ANY pull.
        expect(getCalls).toBe(1);
        await res.body!.cancel();
        expect(firstCancelled).toBe(true);
    });

    test("a lazy part from a different representation (same size, new ETag) resets the body", async () => {
        // servedSpanMatches alone would pass a SAME-SIZE overwrite (right byte
        // count, different bytes). Comparing each part's validator against the
        // first catches it: the second part reports a new ETag, so the stream
        // must error rather than splice bytes from a changed representation.
        const data = bytesOf("0123456789abcdefghij");
        let call = 0;
        const store: ObjectStore = {
            supportsRange: true,
            async headObject(): Promise<ObjectMetadata> {
                return { contentLength: data.length, etag: ETAG };
            },
            async getObject(_key: string, getOpts?: { range?: ParsedRange }): Promise<ObjectStream> {
                const range = getOpts!.range!;
                const slice = data.subarray(range.start, range.end + 1);
                const etag = call++ === 0 ? ETAG : '"overwritten-same-size"';
                return { body: streamOf(slice), contentLength: slice.length, totalSize: data.length, range: { start: range.start, end: range.end }, etag };
            },
        };
        const handler = serveObject(store);
        const res = await handler(req({ Range: "bytes=0-4,10-14" }), { key: KEY });
        // Headers already committed (first part validated), so status is 206...
        expect(res.status).toBe(206);
        // ...but draining must fail loudly rather than deliver spliced bytes.
        let streamError = false;
        try { await res.arrayBuffer(); } catch { streamError = true; }
        expect(streamError).toBe(true);
    });

    test("onTransfer meters the whole multipart body", async () => {
        const events: TransferEvent[] = [];
        const handler = serveObject(memoryStore({ etag: ETAG }), { onTransfer: (e) => events.push(e) });
        const res = await handler(req({ Range: "bytes=0-4,10-14" }), { key: KEY, mime: "text/plain" });

        const buf = await res.arrayBuffer();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            status: 206, completed: true,
            bytesExpected: buf.byteLength, bytesTransferred: buf.byteLength,
        });
    });
});
