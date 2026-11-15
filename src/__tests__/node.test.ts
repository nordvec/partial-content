import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { removeTree } from "./temp-cleanup.ts";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveObject } from "../node";
import { fsStore } from "../fs";

/**
 * An object of `chunks` chunks and a response whose `write` always reports a
 * full send buffer, so the pump parks after every chunk until a test emits
 * 'drain'. The stream is exactly the committed length, so nothing but
 * backpressure can stop it, and long enough that a cancel finds it still open.
 */
function backpressured({ chunks = 2, onCancel }: { chunks?: number; onCancel?: () => void } = {}) {
    const chunk = new TextEncoder().encode("01234");
    const contentLength = chunk.length * chunks;
    let sent = 0;
    const store: ObjectStore = {
        supportsRange: true,
        async headObject() {
            return { contentLength };
        },
        async getObject() {
            return {
                body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                    pull(controller) {
                        controller.enqueue(chunk);
                        if (++sent === chunks) controller.close();
                    },
                    cancel: onCancel,
                }),
                contentLength,
                totalSize: contentLength,
            };
        },
    };
    const req = Object.assign(new EventEmitter(), {
        method: "GET",
        url: "/x",
        headers: {} as Record<string, string | string[] | undefined>,
    }) as unknown as IncomingMessage;
    const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        destroyed: false,
        ended: false,
        written: 0,
        writeHead() {
            res.headersSent = true;
            return res;
        },
        write(): boolean {
            res.written++;
            return false;
        },
        end() {
            res.ended = true;
        },
        destroy() {
            res.destroyed = true;
        },
        /** Settles once the pump waits on a drain. */
        async parked() {
            while (res.listenerCount("drain") === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        },
    });
    return { store, req, res };
}

// Full-stack integration: real http.createServer + real fs store + real fetch.

let root: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "partial-content-node-"));
    await writeFile(join(root, "hello.txt"), "0123456789abcdefghij"); // 20 bytes

    const handler = serveObject(fsStore({ root }), {
        key: (req) => new URL(req.url!, "http://localhost").pathname.slice(1),
        mime: () => "text/plain",
        disposition: "inline",
    });

    server = createServer((req, res) => {
        void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTree(root);
});

describe("node adapter over real HTTP", () => {
    test("GET 200 serves the full file", async () => {
        const res = await fetch(`${baseUrl}/hello.txt`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("0123456789abcdefghij");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(res.headers.get("etag")).toStartWith('W/"');
    });

    test("Range request round-trips as 206", async () => {
        const res = await fetch(`${baseUrl}/hello.txt`, {
            headers: { Range: "bytes=5-9" },
        });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("56789");
        expect(res.headers.get("content-range")).toBe("bytes 5-9/20");
    });

    test("revalidation cycle: 200 ETag -> 304 on If-None-Match", async () => {
        const first = await fetch(`${baseUrl}/hello.txt`);
        const etag = first.headers.get("etag")!;
        await first.text();

        const second = await fetch(`${baseUrl}/hello.txt`, {
            headers: { "If-None-Match": etag },
        });
        expect(second.status).toBe(304);
        expect(await second.text()).toBe("");
    });

    test("conditional HEAD returns 304", async () => {
        const first = await fetch(`${baseUrl}/hello.txt`, { method: "HEAD" });
        const etag = first.headers.get("etag")!;

        const second = await fetch(`${baseUrl}/hello.txt`, {
            method: "HEAD",
            headers: { "If-None-Match": etag },
        });
        expect(second.status).toBe(304);
    });

    test("HEAD returns headers without a body", async () => {
        const res = await fetch(`${baseUrl}/hello.txt`, { method: "HEAD" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe("20");
        expect(await res.text()).toBe("");
    });

    test("missing file returns 404", async () => {
        const res = await fetch(`${baseUrl}/missing.txt`);
        expect(res.status).toBe(404);
    });

    test("path traversal is rejected as 404", async () => {
        // Encoded traversal so the URL parser doesn't normalize it away client-side.
        const res = await fetch(`${baseUrl}/..%2f..%2fetc%2fpasswd`);
        expect(res.status).toBe(404);
    });

    test("POST returns 405 with Allow", async () => {
        const res = await fetch(`${baseUrl}/hello.txt`, { method: "POST" });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    });
});

// ─── Failure-path integration (dedicated servers per test) ──────────────────

import type { ObjectStore } from "../web";

async function withServer(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
    run: (base: string) => Promise<void>,
): Promise<void> {
    const srv = createServer(handler);
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const addr = srv.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    try {
        await run(`http://127.0.0.1:${addr.port}`);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
}

describe("node adapter failure paths", () => {
    test("throwing key extractor becomes a 500, not a rejected handler", async () => {
        const handler = serveObject(fsStore({ root }), {
            key: () => {
                throw new Error("router blew up");
            },
        });
        await withServer(
            (req, res) => {
                void handler(req, res);
            },
            async (base) => {
                const res = await fetch(`${base}/anything`);
                expect(res.status).toBe(500);
                expect(await res.text()).toBe("Internal Server Error");
            },
        );
    });

    test("under an auditKey, a throwing extractor reports the projection, never the raw error", async () => {
        const errors: unknown[] = [];
        const handler = serveObject(fsStore({ root }), {
            key: () => {
                throw new TypeError("no object at private/report.pdf");
            },
            auditKey: () => "audit-1",
            onError: (err) => errors.push(err),
        });
        await withServer(
            (req, res) => {
                void handler(req, res);
            },
            async (base) => {
                expect((await fetch(`${base}/anything`)).status).toBe(500);
            },
        );
        expect(errors).toEqual([{ name: "TypeError", operation: "context" }]);
        expect(JSON.stringify(errors)).not.toContain("report.pdf");
    });

    test("synchronous writeHead failure is contained: stream released, server survives", async () => {
        // writeHead can throw synchronously (socket destroyed in the await
        // window, a header the runtime rejects). That throw must not escape
        // the handler (unhandled rejection kills Express 4 processes) and
        // must release the storage stream.
        let cancelled = false;
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() {
                return { contentLength: 5 };
            },
            async getObject() {
                return {
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        pull(controller) {
                            controller.enqueue(new TextEncoder().encode("01234"));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                    contentLength: 5,
                    totalSize: 5,
                };
            },
        };
        const handler = serveObject(store, { key: () => "x" });
        await withServer(
            (req, res) => {
                res.writeHead = ((): never => {
                    throw new Error("socket torn down mid-write");
                }) as unknown as typeof res.writeHead;
                void handler(req, res);
            },
            async (base) => {
                // The client sees a dropped connection; the assertion is that the
                // process survives and the storage stream is cancelled.
                await fetch(`${base}/x`).catch(() => {
                    /* torn socket is expected */
                });
                for (let i = 0; i < 50 && !cancelled; i++) {
                    await new Promise((r) => setTimeout(r, 10));
                }
                expect(cancelled).toBe(true);
            },
        );
    });

    test("array-valued request headers are joined per RFC 9110 field-line rules", async () => {
        // set-cookie is the one header Node always keeps as an array, even on
        // requests; it exercises the array branch of the header conversion.
        const handler = serveObject(fsStore({ root }), {
            key: (req) => new URL(req.url!, "http://localhost").pathname.slice(1),
        });
        await withServer(
            (req, res) => {
                req.headers["set-cookie"] = ["a=1", "b=2"];
                void handler(req, res);
            },
            async (base) => {
                const res = await fetch(`${base}/hello.txt`);
                expect(res.status).toBe(200);
                expect(await res.text()).toBe("0123456789abcdefghij");
            },
        );
    });

    test("a stalled reader (backpressure with no drain) is torn down by writeStallTimeoutMs", async () => {
        // A client that stops reading but holds the socket open fills the send
        // buffer, so res.write() returns false and 'drain' never fires. Without
        // a bound the pump would wait forever, pinning the storage reader. The
        // stall timeout must reject into the error path: cancel the reader and
        // destroy the response.
        let readerCancelled = false;
        const { store, req, res } = backpressured({
            chunks: 6,
            onCancel: () => {
                readerCancelled = true;
            },
        });
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 30 });

        await handler(req, res as unknown as ServerResponse);

        expect(res.destroyed).toBe(true);
        expect(readerCancelled).toBe(true);
        expect(res.ended).toBe(false);
        expect(res.written).toBe(1);
        expect(res.listenerCount("drain")).toBe(0);
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a drain resumes the transfer and leaves no listener behind", async () => {
        const { store, req, res } = backpressured();
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 60_000 });

        const serving = handler(req, res as unknown as ServerResponse);
        await res.parked();
        expect(res.written).toBe(1);
        res.emit("drain");
        await res.parked();
        res.emit("drain");
        await serving;

        expect(res.ended).toBe(true);
        expect(res.written).toBe(2);
        expect(res.destroyed).toBe(false);
        expect(res.listenerCount("drain")).toBe(0);
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a close during backpressure stops the transfer with the stall bound disabled", async () => {
        let readerCancelled = false;
        const { store, req, res } = backpressured({
            chunks: 6,
            onCancel: () => {
                readerCancelled = true;
            },
        });
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 0 });

        const serving = handler(req, res as unknown as ServerResponse);
        await res.parked();
        res.destroyed = true;
        res.emit("close");
        await serving;

        expect(res.written).toBe(1);
        expect(readerCancelled).toBe(true);
    });

    test("a stall bound of 0 waits for the drain however long it takes", async () => {
        const { store, req, res } = backpressured();
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 0 });

        const serving = handler(req, res as unknown as ServerResponse);
        await res.parked();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(res.destroyed).toBe(false);
        res.emit("drain");
        await res.parked();
        res.emit("drain");
        await serving;
        expect(res.ended).toBe(true);
    });

    test("a stall bound past the largest timer delay is capped, not fired at once", async () => {
        // A timer delay above 2^31 - 1 ms fires after about a millisecond.
        const { store, req, res } = backpressured();
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 2 ** 32 });

        const serving = handler(req, res as unknown as ServerResponse);
        await res.parked();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(res.destroyed).toBe(false);
        res.emit("drain");
        await res.parked();
        res.emit("drain");
        await serving;
        expect(res.ended).toBe(true);
    });

    test("a client that leaves mid-transfer aborts the store read, and the listener is detached after", async () => {
        let seen: AbortSignal | undefined;
        const { store, req, res } = backpressured({ chunks: 6 });
        const getObject = store.getObject.bind(store);
        store.getObject = (key, opts) => {
            seen = opts?.signal;
            return getObject(key, opts);
        };
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 0 });

        const serving = handler(req, res as unknown as ServerResponse);
        await res.parked();
        expect(seen?.aborted).toBe(false);
        res.emit("close");
        expect(seen?.aborted).toBe(true);
        res.destroyed = true;
        res.emit("close");
        await serving;
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a completed transfer carries the reason phrase and detaches the disconnect listener", async () => {
        const { store, req, res } = backpressured();
        res.write = () => {
            res.written++;
            return true;
        };
        let writeHeadArgs: unknown[] = [];
        const writeHead = res.writeHead;
        res.writeHead = (...args: unknown[]) => {
            writeHeadArgs = args;
            return writeHead();
        };
        await serveObject(store, { key: () => "x" })(req, res as unknown as ServerResponse);

        expect(res.ended).toBe(true);
        expect(writeHeadArgs.slice(0, 2)).toEqual([200, "OK"]);
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a writeHead that throws over a byte body tears the socket down and the handler resolves", async () => {
        const { req, res } = backpressured();
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() {
                return { contentLength: 5 };
            },
            async getObject() {
                return { body: new TextEncoder().encode("01234"), contentLength: 5, totalSize: 5 };
            },
        };
        res.writeHead = () => {
            throw new Error("socket torn down mid-write");
        };
        await serveObject(store, { key: () => "x" })(req, res as unknown as ServerResponse);
        expect(res.destroyed).toBe(true);
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a throwing extractor answers a hardened 500 and reports the raw error with its context", async () => {
        const failure = new Error("router blew up");
        const reports: [unknown, unknown][] = [];
        const { store, req, res } = backpressured();
        let head: unknown[] = [];
        let sent: unknown;
        res.writeHead = (...args: unknown[]) => {
            head = args;
            res.headersSent = true;
            return res;
        };
        res.end = (chunk?: unknown) => {
            sent = chunk;
            res.ended = true;
        };
        await serveObject(store, {
            key: () => {
                throw failure;
            },
            onError: (err, ctx) => reports.push([err, ctx]),
        })(req, res as unknown as ServerResponse);

        expect(reports).toEqual([[failure, { key: "", operation: "context" }]]);
        expect(head[0]).toBe(500);
        expect(head[1]).toEqual({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": "21",
            "Accept-Ranges": "none",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'",
        });
        expect(new TextDecoder().decode(sent as Uint8Array)).toBe("Internal Server Error");
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a throwing extractor on a response already on the wire tears the socket down", async () => {
        // Middleware ahead of the handler may already have sent the headers.
        const { store, req, res } = backpressured();
        res.headersSent = true;
        let wroteHead = false;
        res.writeHead = () => {
            wroteHead = true;
            return res;
        };
        await serveObject(store, {
            key: () => {
                throw new Error("router blew up");
            },
        })(req, res as unknown as ServerResponse);
        expect(wroteHead).toBe(false);
        expect(res.ended).toBe(false);
        expect(res.destroyed).toBe(true);
    });

    test("storage stream erroring mid-transfer truncates the response and the server survives", async () => {
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() {
                return { contentLength: 10 };
            },
            async getObject(key) {
                if (key === "ok") {
                    return {
                        body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode("0123456789"));
                                controller.close();
                            },
                        }),
                        contentLength: 10,
                        totalSize: 10,
                    };
                }
                return {
                    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
                        pull(controller) {
                            controller.enqueue(new TextEncoder().encode("01234"));
                            // Second pull: the backend dies mid-transfer.
                            controller.error(new Error("backend connection reset"));
                        },
                    }),
                    contentLength: 10,
                    totalSize: 10,
                };
            },
        };
        const handler = serveObject(store, {
            key: (req) => new URL(req.url!, "http://localhost").pathname.slice(1),
        });
        await withServer(
            (req, res) => {
                void handler(req, res);
            },
            async (base) => {
                // Headers were already sent (200 + Content-Length: 10), so the
                // only correct signal is a torn connection: the body read fails.
                let failed = false;
                try {
                    const res = await fetch(`${base}/doc`);
                    await res.arrayBuffer();
                } catch {
                    failed = true;
                }
                expect(failed).toBe(true);

                // The server must remain healthy for subsequent requests.
                const again = await fetch(`${base}/ok`);
                expect(again.status).toBe(200);
                expect(await again.text()).toBe("0123456789");
            },
        );
    });
});

describe("node adapter client-disconnect signal", () => {
    test("a request that has been read to its end is not a client that left", async () => {
        let seen: AbortSignal | undefined;
        const { store, req, res } = backpressured({ chunks: 6 });
        const getObject = store.getObject.bind(store);
        store.getObject = (key, opts) => {
            seen = opts?.signal;
            return getObject(key, opts);
        };
        const serving = serveObject(store, { key: () => "x", writeStallTimeoutMs: 0 })(
            req,
            res as unknown as ServerResponse,
        );
        await res.parked();
        // IncomingMessage emits "close" once it is drained, whatever the socket does.
        req.emit("close");
        expect(seen?.aborted).toBe(false);
        res.destroyed = true;
        res.emit("close");
        await serving;
    });

    test("a response already closed when the handler starts reaches the store with an aborted signal", async () => {
        let seen: AbortSignal | undefined;
        const { store, req, res } = backpressured();
        const getObject = store.getObject.bind(store);
        store.getObject = (key, opts) => {
            seen = opts?.signal;
            return getObject(key, opts);
        };
        res.destroyed = true;
        await serveObject(store, { key: () => "x" })(req, res as unknown as ServerResponse);
        expect(seen?.aborted).toBe(true);
        expect(res.written).toBe(0);
        expect(res.listenerCount("close")).toBe(0);
    });

    test("a response that closed after it finished is not a client abort", async () => {
        let seen: AbortSignal | undefined;
        const { store, req, res } = backpressured();
        res.write = () => {
            res.written++;
            return true;
        };
        const getObject = store.getObject.bind(store);
        store.getObject = (key, opts) => {
            seen = opts?.signal;
            return getObject(key, opts);
        };
        const handler = serveObject(store, { key: () => "x" });
        const serving = handler(req, res as unknown as ServerResponse);
        Object.assign(res, { writableFinished: true });
        res.emit("close");
        await serving;
        expect(seen?.aborted).toBe(false);
    });

    test("a client that leaves after the request was drained still aborts the store read", async () => {
        let storeSignal: AbortSignal | undefined;
        const aborted = Promise.withResolvers<void>();
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() {
                return { contentLength: 10 };
            },
            async getObject(_key, opts) {
                storeSignal = opts?.signal;
                opts?.signal?.addEventListener("abort", () => aborted.resolve());
                // The read never completes on its own: only the abort ends it.
                await aborted.promise;
                throw new DOMException("aborted", "AbortError");
            },
        };
        const handler = serveObject(store, { key: () => "x" });
        const started = Promise.withResolvers<void>();
        await withServer(
            (req, res) => {
                // Something upstream drains the request before the handler runs.
                req.resume();
                req.once("end", () => {
                    started.resolve();
                    void handler(req, res);
                });
            },
            async (base) => {
                const controller = new AbortController();
                const pending = fetch(`${base}/x`, { signal: controller.signal }).catch(() => undefined);
                await started.promise;
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(storeSignal?.aborted).toBe(false);
                controller.abort();
                await pending;
                await aborted.promise;
                expect(storeSignal?.aborted).toBe(true);
            },
        );
    });

    test("an auditKey extractor that yields nothing keys the request as unkeyed", async () => {
        const failing: ObjectStore = {
            supportsRange: true,
            async headObject() {
                throw new Error("backend rejected private/report.pdf");
            },
            async getObject() {
                throw new Error("unreachable");
            },
        };
        const { req, res } = backpressured();
        req.headers["if-none-match"] = '"x"';
        const seen: { err: unknown; key: string }[] = [];
        await serveObject(failing, {
            key: () => "private/report.pdf",
            auditKey: () => undefined,
            onError: (err, ctx) => void seen.push({ err, key: ctx.key }),
        })(req, res as unknown as ServerResponse);

        expect(seen).toEqual([{ err: { name: "Error", operation: "head" }, key: "unkeyed" }]);
    });
});
