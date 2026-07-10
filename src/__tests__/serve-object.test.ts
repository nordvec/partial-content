import { describe, test, expect, mock } from "bun:test";
import { serveObject, type ServeContext } from "../web";
import type { ObjectStore, ObjectMetadata, ObjectStream, ParsedRange } from "../web";
import { StoreUnavailableError } from "../object-store";

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Create a mock ObjectStore with controllable responses. */
function createMockStore(overrides?: Partial<ObjectStore>): ObjectStore {
    return {
        supportsRange: true,
        headObject: mock(async (_key: string, _opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> => ({
            contentLength: 10000,
            etag: '"abc123"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        })),
        getObject: mock(async (_key: string, _opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> => ({
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([72, 101, 108, 108, 111])); // "Hello"
                    controller.close();
                },
            }),
            contentLength: 10000,
            totalSize: 10000,
            etag: '"abc123"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        })),
        ...overrides,
    };
}

/** Create a Request with given headers. */
function mockRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/stream", {
        headers: new Headers(headers),
    });
}

function defaultCtx(overrides?: Partial<ServeContext>): ServeContext {
    return {
        key: "reports/q4.pdf",
        mime: "application/pdf",
        filename: "Q4 Report.pdf",
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("serveObject", () => {
    test("returns 200 with full content on first request (no conditionals)", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const response = await handler(mockRequest(), defaultCtx());

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe("10000");
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        expect(response.headers.get("ETag")).toBeTruthy();
        expect(response.headers.get("Content-Type")).toBe("application/pdf");
        // OWASP: nosniff must be present on all file-serving responses
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("returns 304 on If-None-Match match", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const response = await handler(
            mockRequest({ "If-None-Match": '"abc123"' }),
            defaultCtx(),
        );

        expect(response.status).toBe(304);
        expect(response.body).toBeNull();
    });

    test("returns 412 on If-Match mismatch", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const response = await handler(
            mockRequest({ "If-Match": '"wrong-etag"' }),
            defaultCtx(),
        );

        expect(response.status).toBe(412);
        expect(response.body).toBeNull();
    });

    test("returns 206 on valid Range with conditional headers", async () => {
        const rangeStore = createMockStore({
            getObject: mock(async (_key: string, _opts?: { range?: ParsedRange }): Promise<ObjectStream> => ({
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                    },
                }),
                contentLength: 500,
                totalSize: 10000,
                range: { start: 0, end: 499 },
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
            })),
        });
        const handler = serveObject(rangeStore);

        // Range with If-None-Match miss forces Path A (HEAD required)
        const response = await handler(
            mockRequest({
                "Range": "bytes=0-499",
                "If-Match": '"abc123"',
            }),
            defaultCtx(),
        );

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-499/10000");
        expect(response.headers.get("Content-Length")).toBe("500");
    });

    test("returns 206 on Range-only request WITHOUT conditional headers (regression)", async () => {
        // This is the most common case: first video scrub or PDF.js request
        // before the browser has an ETag. The adapter must HEAD to get totalSize,
        // parse the range, then GET with the resolved range.
        const rangeStore = createMockStore({
            getObject: mock(async (_key: string, _opts?: { range?: ParsedRange }): Promise<ObjectStream> => ({
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                    },
                }),
                contentLength: 500,
                totalSize: 10000,
                range: { start: 0, end: 499 },
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
            })),
        });
        const handler = serveObject(rangeStore);

        // Range header with NO conditional headers (no If-Match, no If-None-Match)
        const response = await handler(
            mockRequest({ "Range": "bytes=0-499" }),
            defaultCtx(),
        );

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-499/10000");
        expect(response.headers.get("Content-Length")).toBe("500");
        // Verify HEAD was called (needed to get totalSize for range parsing)
        expect(rangeStore.headObject).toHaveBeenCalled();
    });

    test("HEAD returns headers without body", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        // HEAD is derived from the request method (single source of truth).
        const response = await handler(
            new Request("http://localhost/stream", { method: "HEAD" }),
            defaultCtx(),
        );

        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(response.headers.get("Content-Length")).toBe("10000");
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        expect(response.headers.get("ETag")).toBeTruthy();
    });

    test("applies Content-Disposition: attachment by default", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const response = await handler(mockRequest(), defaultCtx());

        const disposition = response.headers.get("Content-Disposition");
        expect(disposition).toContain("attachment");
        expect(disposition).toContain("Q4 Report.pdf");
    });

    test("applies Content-Disposition: inline when configured", async () => {
        const store = createMockStore();
        const handler = serveObject(store, { disposition: "inline" });

        const response = await handler(mockRequest(), defaultCtx());

        const disposition = response.headers.get("Content-Disposition");
        expect(disposition).toContain("inline");
    });

    test("applies Content-Disposition function per MIME", async () => {
        const store = createMockStore();
        const handler = serveObject(store, {
            disposition: (mime) => mime === "application/pdf" ? "inline" : "attachment",
        });

        const pdfResponse = await handler(mockRequest(), defaultCtx({ mime: "application/pdf" }));
        expect(pdfResponse.headers.get("Content-Disposition")).toContain("inline");

        const zipResponse = await handler(mockRequest(), defaultCtx({ mime: "application/zip" }));
        expect(zipResponse.headers.get("Content-Disposition")).toContain("attachment");
    });

    test("applies security headers from callback", async () => {
        const store = createMockStore();
        const handler = serveObject(store, {
            securityHeaders: (mime) => ({
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": mime === "application/pdf" ? "sandbox" : "default-src 'none'",
            }),
        });

        const response = await handler(mockRequest(), defaultCtx());

        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
    });

    test("applies custom Cache-Control", async () => {
        const store = createMockStore();
        const handler = serveObject(store, { cacheControl: "public, max-age=3600" });

        const response = await handler(mockRequest(), defaultCtx());

        expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    });

    test("defaults to application/octet-stream when no MIME provided", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const response = await handler(mockRequest(), defaultCtx({ mime: undefined }));

        expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    });

    test("TOCTOU guard: degrades to 200 when store ignores range (no ContentRange)", async () => {
        // Simulate: a range was requested via conditionals, but S3 returned full content
        const noRangeStore = createMockStore({
            getObject: mock(async (_key: string, _opts?: { range?: ParsedRange }): Promise<ObjectStream> => ({
                body: new ReadableStream<Uint8Array>({
                    start(c) { c.close(); },
                }),
                contentLength: 10000,
                totalSize: 10000,
                // No served range -- S3 returned full content despite range request
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
            })),
        });
        const handler = serveObject(noRangeStore);

        const response = await handler(
            mockRequest({
                "Range": "bytes=0-499",
                "If-Match": '"abc123"',
            }),
            defaultCtx(),
        );

        // Must be 200, not 206 (never emit a lying 206)
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Range")).toBeNull();
    });

    test("redirects to signed URL when store does not support ranges", async () => {
        const noRangeStore = createMockStore({
            supportsRange: false,
            createSignedUrl: mock(async (_key: string, _opts: { expiresInSeconds: number }) => ({
                ok: true as const,
                url: "https://cdn.example.com/signed?token=abc",
            })),
        });
        const handler = serveObject(noRangeStore);

        const response = await handler(mockRequest(), defaultCtx());

        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe("https://cdn.example.com/signed?token=abc");
    });

    test("range-incapable store without signed URL serves the full content rangeless", async () => {
        const noRangeStore = createMockStore({
            supportsRange: false,
            createSignedUrl: undefined,
        });
        const handler = serveObject(noRangeStore);

        // A Range request against a store that cannot seek: RFC 9110 14.2
        // lets the server ignore Range, so the client gets the full 200 and
        // an honest Accept-Ranges: none instead of a hard 502.
        const response = await handler(
            mockRequest({ Range: "bytes=0-4" }),
            defaultCtx(),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("Accept-Ranges")).toBe("none");
        expect(response.headers.get("Content-Range")).toBeNull();
    });

    test("range-incapable store without signed URL still answers conditionals", async () => {
        const noRangeStore = createMockStore({
            supportsRange: false,
            createSignedUrl: undefined,
        });
        const handler = serveObject(noRangeStore);

        const response = await handler(
            mockRequest({ "If-None-Match": '"abc123"' }),
            defaultCtx(),
        );
        expect(response.status).toBe(304);
    });

    test("redirect response includes Accept-Ranges: none", async () => {
        const noRangeStore = createMockStore({
            supportsRange: false,
            createSignedUrl: mock(async (_key: string, _opts: { expiresInSeconds: number }) => ({
                ok: true as const,
                url: "https://cdn.example.com/signed?token=abc",
            })),
        });
        const handler = serveObject(noRangeStore);

        const response = await handler(mockRequest(), defaultCtx());

        expect(response.status).toBe(302);
        expect(response.headers.get("Accept-Ranges")).toBe("none");
    });

    test("returns 416 on unsatisfiable range (start >= totalSize)", async () => {
        const store = createMockStore();
        const handler = serveObject(store, {
            securityHeaders: () => ({ "X-Custom": "should-not-appear" }),
        });

        const response = await handler(
            mockRequest({
                "Range": "bytes=99999-100000",
                "If-Match": '"abc123"',
            }),
            defaultCtx(),
        );

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */10000");
        // Security headers are for body responses, 416 has no body
        expect(response.headers.get("X-Custom")).toBeNull();
    });

    test("returns 502 when headObject throws", async () => {
        const failingStore = createMockStore({
            headObject: mock(async () => { throw new Error("Connection refused"); }),
        });
        const handler = serveObject(failingStore);

        // Request with If-None-Match forces Path A (HEAD required)
        const response = await handler(
            mockRequest({ "if-none-match": '"xyz"' }),
            defaultCtx(),
        );

        expect(response.status).toBe(502);
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("returns 502 when getObject throws", async () => {
        const failingStore = createMockStore({
            getObject: mock(async () => { throw new Error("S3 timeout"); }),
        });
        const handler = serveObject(failingStore);

        // Path C (no conditionals) goes straight to getObject
        const response = await handler(mockRequest(), defaultCtx());

        expect(response.status).toBe(502);
    });

    test("returns 499 when client aborts during headObject", async () => {
        const ac = new AbortController();
        ac.abort();
        const abortStore = createMockStore({
            headObject: mock(async (_key: string, hOpts?: { signal?: AbortSignal }) => {
                hOpts?.signal?.throwIfAborted();
                return { contentLength: 10000, etag: '"abc123"' };
            }),
        });
        const handler = serveObject(abortStore);

        const req = new Request("http://localhost/stream", {
            headers: new Headers({ "if-none-match": '"xyz"' }),
            signal: ac.signal,
        });

        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(499);
    });

    test("passes signal to store.headObject and store.getObject", async () => {
        const headSpy = mock(async (_key: string, _opts?: { signal?: AbortSignal }): Promise<ObjectMetadata> => ({
            contentLength: 10000,
            etag: '"abc123"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        }));
        const getSpy = mock(async (_key: string, _opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> => ({
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([72, 101, 108, 108, 111]));
                    controller.close();
                },
            }),
            contentLength: 10000,
            totalSize: 10000,
            etag: '"abc123"',
            lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
        }));
        const spyStore = createMockStore({ headObject: headSpy, getObject: getSpy });
        const handler = serveObject(spyStore);

        // Path A: has conditional headers -> headObject is called with signal
        const req = mockRequest({ "if-none-match": '"xyz"' });
        await handler(req, defaultCtx());

        // headObject should receive the signal in its options
        expect(headSpy).toHaveBeenCalledTimes(1);
        const headArgs = headSpy.mock.calls[0];
        expect(headArgs[1]?.signal).toBeInstanceOf(AbortSignal);

        // getObject should receive the signal in its options
        expect(getSpy).toHaveBeenCalledTimes(1);
        const getArgs = getSpy.mock.calls[0];
        expect(getArgs[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    // ── Enterprise hardening ────────────────────────────────────────────

    test("returns 405 for POST method", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const req = new Request("http://localhost/stream", { method: "POST" });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(405);
        expect(response.statusText).toBe("Method Not Allowed");
        expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
        expect(response.headers.get("Content-Length")).toBe("0");
    });

    test("answers OPTIONS with 204 and the Allow surface", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const req = new Request("http://localhost/stream", { method: "OPTIONS" });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(204);
        expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
        expect(response.body).toBeNull();
    });

    test("returns 405 for DELETE method", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const req = new Request("http://localhost/stream", { method: "DELETE" });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(405);
    });

    test("returns 405 for PUT method", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const req = new Request("http://localhost/stream", { method: "PUT" });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(405);
    });

    test("returns 404 when store throws NotFound-like error", async () => {
        const notFoundError = Object.assign(new Error("Object not found"), {
            name: "ObjectNotFoundError",
            status: 404,
        });
        const store = createMockStore({
            headObject: mock(async () => { throw notFoundError; }),
        });
        const handler = serveObject(store);

        const req = mockRequest({ "if-none-match": '"xyz"' });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(404);
        expect(response.statusText).toBe("Not Found");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("returns 502 for generic store errors (not 404)", async () => {
        const genericError = new Error("Connection refused");
        const store = createMockStore({
            headObject: mock(async () => { throw genericError; }),
        });
        const handler = serveObject(store);

        const req = mockRequest({ "if-none-match": '"xyz"' });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(502);
        expect(response.statusText).toBe("Bad Gateway");
    });

    test("returns 503 + Retry-After for a StoreUnavailableError with a retry hint", async () => {
        const store = createMockStore({
            headObject: mock(async () => { throw new StoreUnavailableError("reports/q4.pdf", { retryAfterSeconds: 5 }); }),
        });
        const req = mockRequest({ "if-none-match": '"xyz"' });
        const response = await serveObject(store)(req, defaultCtx());

        expect(response.status).toBe(503);
        expect(response.statusText).toBe("Service Unavailable");
        expect(response.headers.get("Retry-After")).toBe("5");
        // Error hygiene must survive on the 503 like every other error path.
        expect(response.headers.get("Accept-Ranges")).toBe("none");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    });

    test("returns 503 WITHOUT Retry-After when the backend gives no hint", async () => {
        const store = createMockStore({
            getObject: mock(async () => { throw new StoreUnavailableError("reports/q4.pdf"); }),
        });
        const response = await serveObject(store)(mockRequest(), defaultCtx());

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBeNull();
    });

    test("503 is recognized from a foreign error by its status property (no kernel import)", async () => {
        const store = createMockStore({
            getObject: mock(async () => { throw Object.assign(new Error("SlowDown"), { status: 503 }); }),
        });
        const response = await serveObject(store)(mockRequest(), defaultCtx());
        expect(response.status).toBe(503);
    });

    test("Retry-After: fractional hint is floored, negative/NaN hint is dropped", async () => {
        const frac = createMockStore({
            getObject: mock(async () => { throw new StoreUnavailableError("k", { retryAfterSeconds: 2.9 }); }),
        });
        expect((await serveObject(frac)(mockRequest(), defaultCtx())).headers.get("Retry-After")).toBe("2");

        const neg = createMockStore({
            getObject: mock(async () => { throw new StoreUnavailableError("k", { retryAfterSeconds: -5 }); }),
        });
        const rNeg = await serveObject(neg)(mockRequest(), defaultCtx());
        expect(rNeg.status).toBe(503);
        expect(rNeg.headers.get("Retry-After")).toBeNull();
    });

    test("calls onError callback when store throws", async () => {
        const storeError = new Error("S3 timeout");
        const store = createMockStore({
            headObject: mock(async () => { throw storeError; }),
        });
        const errorSpy = mock((_err: unknown, _ctx: { key: string; operation: string }) => {});
        const handler = serveObject(store, { onError: errorSpy });

        const req = mockRequest({ "if-none-match": '"xyz"' });
        await handler(req, defaultCtx());

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toBe(storeError);
        expect(errorSpy.mock.calls[0][1]).toEqual({ key: "reports/q4.pdf", operation: "head" });
    });

    test("calls onError callback on getObject error (Path C)", async () => {
        const storeError = new Error("S3 read timeout");
        const store = createMockStore({
            getObject: mock(async () => { throw storeError; }),
        });
        const errorSpy = mock((_err: unknown, _ctx: { key: string; operation: string }) => {});
        const handler = serveObject(store, { onError: errorSpy });

        // Path C: no conditional headers, goes directly to getObject
        const response = await handler(mockRequest(), defaultCtx());

        expect(response.status).toBe(502);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][1]).toEqual({ key: "reports/q4.pdf", operation: "get" });
    });

    test("does not call onError on AbortError", async () => {
        const abortError = new DOMException("Aborted", "AbortError");
        const store = createMockStore({
            headObject: mock(async () => { throw abortError; }),
        });
        const errorSpy = mock((_err: unknown, _ctx: { key: string; operation: string }) => {});
        const handler = serveObject(store, { onError: errorSpy });

        const req = mockRequest({ "if-none-match": '"xyz"' });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(499);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test("all success responses include statusText", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        // 200 response
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.status).toBe(200);
        expect(r200.statusText).toBe("OK");

        // 304 response
        const r304 = await handler(
            mockRequest({ "if-none-match": '"abc123"' }),
            defaultCtx(),
        );
        expect(r304.status).toBe(304);
        expect(r304.statusText).toBe("Not Modified");
    });

    test("HEAD auto-detection from request method", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        const req = new Request("http://localhost/stream", { method: "HEAD" });
        const response = await handler(req, defaultCtx());

        expect(response.status).toBe(200);
        expect(response.statusText).toBe("OK");
        expect(await response.text()).toBe(""); // No body on HEAD
        expect(response.headers.get("Content-Length")).toBe("10000");
    });

    test("X-Content-Type-Options: nosniff on all response types", async () => {
        const store = createMockStore();
        const handler = serveObject(store);

        // 200 success
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("X-Content-Type-Options")).toBe("nosniff");

        // 206 partial
        const r206 = await handler(
            mockRequest({ Range: "bytes=0-99" }),
            defaultCtx(),
        );
        expect(r206.headers.get("X-Content-Type-Options")).toBe("nosniff");

        // HEAD
        const r200head = await handler(new Request("http://localhost/stream", { method: "HEAD" }), defaultCtx());
        expect(r200head.headers.get("X-Content-Type-Options")).toBe("nosniff");

        // 502 error
        const errorStore = createMockStore({
            headObject: mock(async () => { throw new Error("connection timeout"); }),
        });
        const errorHandler = serveObject(errorStore);
        const r502 = await errorHandler(mockRequest(), defaultCtx());
        expect(r502.headers.get("X-Content-Type-Options")).toBe("nosniff");

        // 404 not found
        const notFoundStore = createMockStore({
            headObject: mock(async () => { throw Object.assign(new Error("Not Found"), { name: "NotFound" }); }),
        });
        const notFoundHandler = serveObject(notFoundStore);
        const r404 = await notFoundHandler(mockRequest(), defaultCtx());
        expect(r404.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("Content-Security-Policy on error responses only", async () => {
        const store = createMockStore();
        const handler = serveObject(store);
        const CSP = "default-src 'none'";

        // Success responses must NOT have CSP (would break legitimate PDF/HTML content)
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Content-Security-Policy")).toBeNull();

        // 405 Method Not Allowed
        const r405 = await handler(
            new Request("http://localhost/stream", { method: "POST" }),
            defaultCtx(),
        );
        expect(r405.headers.get("Content-Security-Policy")).toBe(CSP);

        // 502 error (Path C: getObject)
        const errorStore = createMockStore({
            getObject: mock(async () => { throw new Error("connection timeout"); }),
        });
        const r502 = await serveObject(errorStore)(mockRequest(), defaultCtx());
        expect(r502.headers.get("Content-Security-Policy")).toBe(CSP);

        // 404 not found (Path C: getObject)
        const notFoundStore = createMockStore({
            getObject: mock(async () => { throw Object.assign(new Error("Not Found"), { name: "NotFound" }); }),
        });
        const r404 = await serveObject(notFoundStore)(mockRequest(), defaultCtx());
        expect(r404.headers.get("Content-Security-Policy")).toBe(CSP);

        // 502 declined signed URL (range-incapable store whose provider says no)
        const noStreamStore = createMockStore({
            supportsRange: false,
            createSignedUrl: mock(async () => ({ ok: false as const, error: "denied" })),
        });
        const r502ns = await serveObject(noStreamStore)(mockRequest(), defaultCtx());
        expect(r502ns.status).toBe(502);
        expect(r502ns.headers.get("Content-Security-Policy")).toBe(CSP);
    });

    test("Content-Length present on all error responses", async () => {
        const handler = serveObject(createMockStore());

        // 405 Method Not Allowed
        const r405 = await handler(
            new Request("http://localhost/stream", { method: "POST" }),
            defaultCtx(),
        );
        expect(r405.headers.get("Content-Length")).toBe("0");

        // 502 error (Path C calls getObject directly, not headObject)
        const errorStore = createMockStore({
            getObject: mock(async () => { throw new Error("connection timeout"); }),
        });
        const r502 = await serveObject(errorStore)(mockRequest(), defaultCtx());
        expect(r502.headers.get("Content-Length")).toBe("21"); // "Storage backend error"

        // 404 not found (Path C calls getObject directly)
        const notFoundStore = createMockStore({
            getObject: mock(async () => { throw Object.assign(new Error("Not Found"), { name: "NotFound" }); }),
        });
        const r404 = await serveObject(notFoundStore)(mockRequest(), defaultCtx());
        expect(r404.headers.get("Content-Length")).toBe("9"); // "Not Found"
    });

    // ─── Gold Standard Features (2026) ──────────────────────────────────────

    test("RFC 9530 Repr-Digest: emitted when store provides digest", async () => {
        const storeWithDigest = createMockStore({
            headObject: mock(async () => ({
                contentLength: 10000,
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
                digest: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            })),
        });
        const handler = serveObject(storeWithDigest);

        // 200 with conditional (forces Path A through HEAD)
        const r200 = await handler(
            mockRequest({ "if-none-match": '"xyz"' }),
            defaultCtx(),
        );
        expect(r200.status).toBe(200);
        expect(r200.headers.get("Repr-Digest")).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
    });

    test("RFC 9530 Repr-Digest: not emitted when store has no digest", async () => {
        const handler = serveObject(createMockStore());
        const response = await handler(
            mockRequest({ "if-none-match": '"xyz"' }),
            defaultCtx(),
        );
        expect(response.headers.get("Repr-Digest")).toBeNull();
    });

    test("Cross-Origin-Resource-Policy on success responses", async () => {
        const handler = serveObject(createMockStore(), {
            crossOriginResourcePolicy: "same-origin",
        });

        // 200 success (Path C)
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");

        // HEAD response
        const rHead = await handler(new Request("http://localhost/stream", { method: "HEAD" }), defaultCtx());
        expect(rHead.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    });

    test("CORP not emitted when not configured", async () => {
        const handler = serveObject(createMockStore());
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
    });

    test("Timing-Allow-Origin on success responses", async () => {
        const handler = serveObject(createMockStore(), {
            timingAllowOrigin: "*",
        });
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Timing-Allow-Origin")).toBe("*");
    });

    test("Server-Timing emitted when timing is enabled", async () => {
        const handler = serveObject(createMockStore(), { timing: true });
        const response = await handler(
            mockRequest({ "if-none-match": '"xyz"' }),
            defaultCtx(),
        );
        const timing = response.headers.get("Server-Timing");
        expect(timing).toBeTruthy();
        expect(timing).toContain("store;dur=");
        expect(timing).toContain("eval;dur=");
    });

    test("Server-Timing not emitted by default", async () => {
        const handler = serveObject(createMockStore());
        const response = await handler(mockRequest(), defaultCtx());
        expect(response.headers.get("Server-Timing")).toBeNull();
    });

    test("onTiming callback fires with timing data", async () => {
        const timingSpy = mock((_metrics: { storeMs: number; evaluateMs: number; totalMs: number }) => {});
        const handler = serveObject(createMockStore(), {
            timing: true,
            onTiming: timingSpy,
        });
        await handler(
            mockRequest({ "if-none-match": '"xyz"' }),
            defaultCtx(),
        );
        expect(timingSpy).toHaveBeenCalledTimes(1);
        const metrics = timingSpy.mock.calls[0][0];
        expect(metrics.storeMs).toBeGreaterThanOrEqual(0);
        expect(metrics.evaluateMs).toBeGreaterThanOrEqual(0);
        expect(metrics.totalMs).toBeGreaterThanOrEqual(0);
    });

    test("Cache-Control: immutable appended when configured", async () => {
        const handler = serveObject(createMockStore(), {
            cacheControl: "public, max-age=31536000",
            immutable: true,
        });
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    });

    test("Cache-Control: immutable not duplicated", async () => {
        const handler = serveObject(createMockStore(), {
            cacheControl: "public, max-age=31536000, immutable",
            immutable: true,
        });
        const r200 = await handler(mockRequest(), defaultCtx());
        // Should not have double "immutable"
        expect(r200.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    });

    test("Accept-Ranges: none on error responses", async () => {
        // 404 not found
        const notFoundStore = createMockStore({
            getObject: mock(async () => { throw Object.assign(new Error("Not Found"), { name: "NotFound" }); }),
        });
        const r404 = await serveObject(notFoundStore)(mockRequest(), defaultCtx());
        expect(r404.headers.get("Accept-Ranges")).toBe("none");

        // 502 error
        const errorStore = createMockStore({
            getObject: mock(async () => { throw new Error("timeout"); }),
        });
        const r502 = await serveObject(errorStore)(mockRequest(), defaultCtx());
        expect(r502.headers.get("Accept-Ranges")).toBe("none");

        // 502 no-streaming
        const noStreamStore = createMockStore({
            supportsRange: false,
            createSignedUrl: undefined,
        });
        const r502ns = await serveObject(noStreamStore)(mockRequest(), defaultCtx());
        expect(r502ns.headers.get("Accept-Ranges")).toBe("none");
    });

    test("Accept-Ranges: bytes on success responses", async () => {
        const handler = serveObject(createMockStore());
        const r200 = await handler(mockRequest(), defaultCtx());
        expect(r200.headers.get("Accept-Ranges")).toBe("bytes");
    });

    // ── onServe Audit Hook ──────────────────────────────────────────

    test("onServe fires on 200 with structured audit event", async () => {
        const events: Array<Record<string, unknown>> = [];
        const handler = serveObject(createMockStore(), {
            onServe: (event) => events.push(event as unknown as Record<string, unknown>),
        });
        await handler(mockRequest(), defaultCtx());
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe(200);
        expect(events[0]!.method).toBe("GET");
        expect(events[0]!.key).toBe("reports/q4.pdf");
        expect(events[0]!.mime).toBe("application/pdf");
        expect(events[0]!.bytesServed).toBe(10000);
        expect(events[0]!.etag).toBeDefined();
        expect(events[0]!.rangeStart).toBeUndefined();
    });

    test("onServe fires on 304 with zero bytesServed", async () => {
        const events: Array<Record<string, unknown>> = [];
        const handler = serveObject(createMockStore(), {
            onServe: (event) => events.push(event as unknown as Record<string, unknown>),
        });
        await handler(
            mockRequest({ "if-none-match": '"abc123"' }),
            defaultCtx(),
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe(304);
        expect(events[0]!.bytesServed).toBe(0);
    });

    test("onServe fires on HEAD with zero bytesServed", async () => {
        const events: Array<Record<string, unknown>> = [];
        const handler = serveObject(createMockStore(), {
            onServe: (event) => events.push(event as unknown as Record<string, unknown>),
        });
        await handler(
            new Request("http://localhost/stream", { method: "HEAD" }),
            defaultCtx(),
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe(200);
        expect(events[0]!.method).toBe("HEAD");
        expect(events[0]!.bytesServed).toBe(0);
    });

    test("onServe fires on 206 with range metadata", async () => {
        const events: Array<Record<string, unknown>> = [];
        const rangeStore = createMockStore({
            getObject: mock(async (_key: string, _opts?: { range?: ParsedRange }): Promise<ObjectStream> => ({
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array([72, 101, 108, 108, 111]));
                        controller.close();
                    },
                }),
                contentLength: 100,
                totalSize: 10000,
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
                range: { start: 0, end: 99 },
            })),
        });
        const handler = serveObject(rangeStore, {
            onServe: (event) => events.push(event as unknown as Record<string, unknown>),
        });
        await handler(mockRequest({ range: "bytes=0-99" }), defaultCtx());
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe(206);
        expect(events[0]!.rangeStart).toBe(0);
        expect(events[0]!.rangeEnd).toBe(99);
    });

    test("onServe does NOT fire on error responses", async () => {
        const events: Array<Record<string, unknown>> = [];
        const errorStore = createMockStore({
            headObject: mock(async () => { throw new Error("boom"); }),
            getObject: mock(async () => { throw new Error("boom"); }),
        });
        const handler = serveObject(errorStore, {
            onServe: (event) => events.push(event as unknown as Record<string, unknown>),
            onError: () => {}, // suppress
        });
        await handler(mockRequest(), defaultCtx());
        expect(events).toHaveLength(0);
    });

    // ── Charset Enforcement ─────────────────────────────────────────

    test("enforces charset=utf-8 on text/* MIME types by default", async () => {
        const handler = serveObject(createMockStore());
        const res = await handler(mockRequest(), defaultCtx({ mime: "text/html" }));
        expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    });

    test("enforces charset=utf-8 on application/json", async () => {
        const handler = serveObject(createMockStore());
        const res = await handler(mockRequest(), defaultCtx({ mime: "application/json" }));
        expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    });

    test("does not enforce charset on binary types", async () => {
        const handler = serveObject(createMockStore());
        const res = await handler(mockRequest(), defaultCtx({ mime: "application/pdf" }));
        expect(res.headers.get("Content-Type")).toBe("application/pdf");
    });

    test("does not double-add charset if already present", async () => {
        const handler = serveObject(createMockStore());
        const res = await handler(mockRequest(), defaultCtx({ mime: "text/html; charset=utf-8" }));
        expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    });

    test("enforceCharset: false disables charset enforcement", async () => {
        const handler = serveObject(createMockStore(), { enforceCharset: false });
        const res = await handler(mockRequest(), defaultCtx({ mime: "text/html" }));
        expect(res.headers.get("Content-Type")).toBe("text/html");
    });

    // ── Path C Digest ─────────────────────────────────────────────────

    test("emits Repr-Digest on Path C when GET response carries digest", async () => {
        const store = createMockStore({
            getObject: mock(async (_key: string, _opts?: { range?: ParsedRange; signal?: AbortSignal; ifMatch?: string }): Promise<ObjectStream> => ({
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                    },
                }),
                contentLength: 3,
                totalSize: 3,
                etag: '"abc123"',
                lastModified: "Sat, 28 Jun 2025 12:00:00 GMT",
                digest: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
            })),
        });
        const handler = serveObject(store);
        // Path C: no conditional headers, no range, no HEAD needed
        const res = await handler(mockRequest(), defaultCtx());
        expect(res.status).toBe(200);
        expect(res.headers.get("Repr-Digest")).toBe("sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:");
    });

    // ── CSP on Error Responses ────────────────────────────────────────

    test("412 response includes Content-Security-Policy", async () => {
        const store = createMockStore();
        const handler = serveObject(store);
        const res = await handler(
            mockRequest({ "If-Match": '"wrong-etag"' }),
            defaultCtx(),
        );
        expect(res.status).toBe(412);
        expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("416 response includes Content-Security-Policy", async () => {
        const store = createMockStore();
        const handler = serveObject(store);
        const res = await handler(
            mockRequest({
                "If-None-Match": '"no-match"',
                "Range": "bytes=99999-100000",
            }),
            defaultCtx(),
        );
        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    });
});
