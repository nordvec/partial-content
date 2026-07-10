import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveObject } from "../node";
import { fsStore } from "../fs";

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
    await rm(root, { recursive: true, force: true });
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
            key: () => { throw new Error("router blew up"); },
        });
        await withServer((req, res) => { void handler(req, res); }, async (base) => {
            const res = await fetch(`${base}/anything`);
            expect(res.status).toBe(500);
            expect(await res.text()).toBe("Internal Server Error");
        });
    });

    test("synchronous writeHead failure is contained: stream released, server survives", async () => {
        // writeHead can throw synchronously (socket destroyed in the await
        // window, a header the runtime rejects). That throw must not escape
        // the handler (unhandled rejection kills Express 4 processes) and
        // must release the storage stream.
        let cancelled = false;
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() { return { contentLength: 5 }; },
            async getObject() {
                return {
                    body: new ReadableStream<Uint8Array>({
                        pull(controller) {
                            controller.enqueue(new TextEncoder().encode("01234"));
                        },
                        cancel() { cancelled = true; },
                    }),
                    contentLength: 5,
                    totalSize: 5,
                };
            },
        };
        const handler = serveObject(store, { key: () => "x" });
        await withServer((req, res) => {
            res.writeHead = ((): never => {
                throw new Error("socket torn down mid-write");
            }) as unknown as typeof res.writeHead;
            void handler(req, res);
        }, async (base) => {
            // The client sees a dropped connection; the assertion is that the
            // process survives and the storage stream is cancelled.
            await fetch(`${base}/x`).catch(() => { /* torn socket is expected */ });
            for (let i = 0; i < 50 && !cancelled; i++) {
                await new Promise((r) => setTimeout(r, 10));
            }
            expect(cancelled).toBe(true);
        });
    });

    test("array-valued request headers are joined per RFC 9110 field-line rules", async () => {
        // set-cookie is the one header Node always keeps as an array, even on
        // requests; it exercises the array branch of the header conversion.
        const handler = serveObject(fsStore({ root }), {
            key: (req) => new URL(req.url!, "http://localhost").pathname.slice(1),
        });
        await withServer((req, res) => {
            req.headers["set-cookie"] = ["a=1", "b=2"];
            void handler(req, res);
        }, async (base) => {
            const res = await fetch(`${base}/hello.txt`);
            expect(res.status).toBe(200);
            expect(await res.text()).toBe("0123456789abcdefghij");
        });
    });

    test("a stalled reader (backpressure with no drain) is torn down by writeStallTimeoutMs", async () => {
        // A client that stops reading but holds the socket open fills the send
        // buffer, so res.write() returns false and 'drain' never fires. Without
        // a bound the pump would wait forever, pinning the storage reader. The
        // stall timeout must reject into the error path: cancel the reader and
        // destroy the response.
        let readerCancelled = false;
        const store: ObjectStore = {
            supportsRange: true,
            async headObject() { return { contentLength: 5 }; },
            async getObject() {
                return {
                    body: new ReadableStream<Uint8Array>({
                        pull(controller) { controller.enqueue(new TextEncoder().encode("01234")); },
                        cancel() { readerCancelled = true; },
                    }),
                    contentLength: 5,
                    totalSize: 5,
                };
            },
        };
        const handler = serveObject(store, { key: () => "x", writeStallTimeoutMs: 30 });

        const req = Object.assign(new EventEmitter(), {
            method: "GET",
            url: "/x",
            headers: {} as Record<string, string | string[] | undefined>,
        }) as unknown as IncomingMessage;

        const res = Object.assign(new EventEmitter(), {
            headersSent: false,
            destroyed: false,
            writeHead(this: { headersSent: boolean }) { this.headersSent = true; return this; },
            // Permanent backpressure: never returns true, never emits 'drain'.
            write() { return false; },
            end() { /* no-op */ },
            destroy(this: { destroyed: boolean }) { this.destroyed = true; },
        }) as unknown as ServerResponse;

        await handler(req, res);

        expect(res.destroyed).toBe(true);
        expect(readerCancelled).toBe(true);
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
                        body: new ReadableStream<Uint8Array>({
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
                    body: new ReadableStream<Uint8Array>({
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
        await withServer((req, res) => { void handler(req, res); }, async (base) => {
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
        });
    });
});
