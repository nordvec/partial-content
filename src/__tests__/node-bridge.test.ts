import { describe, test, expect } from "bun:test";
import {
    Agent,
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { getEventListeners } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { toWebRequest, sendResponse, nodeHandler } from "../node";
import { createTusHandler } from "../tus";
import { memoryUploadStore } from "../memory";

// Every test here drives a real http.createServer over a real socket. The
// bridge exists to convert Node's transport objects, so a mock of those objects
// would be a test of the mock: the framing behavior under test (chunked bodies,
// backpressure, a half-sent request, a socket that goes away) only exists on a
// socket.

interface Harness {
    url: string;
    port: number;
    close: () => Promise<void>;
}

async function serve(
    listener: (req: IncomingMessage, res: ServerResponse) => void,
    event: "request" | "checkContinue" = "request",
): Promise<Harness> {
    const server: Server = createServer();
    server.on(event, listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** Deferred value, so a test can await something the server observed. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One PATCH whose body stops short of its declared length and whose socket is
 * then destroyed, which is the client-went-away case several tests need.
 * `handler` runs per request and resolves what the server observed. `headers`
 * choose the framing: a declared length the eleven bytes sent fall short of
 * (the default) or reach, or no length at all, which sends the body chunked.
 */
async function abandonedPatch<T>(
    handler: (req: IncomingMessage, observed: { resolve: (v: T) => void }) => void,
    headers: Record<string, string> = { "Content-Length": "100" },
): Promise<T> {
    const observed = deferred<T>();
    // The socket is destroyed under a request the handler already holds: a
    // destroy that outran the request would leave the server nothing to observe.
    const received = deferred<void>();
    const harness = await serve((req, res) => {
        handler(req, observed);
        res.on("error", () => {
            // The socket is gone; nothing to write.
        });
        received.resolve();
    });
    try {
        const client = httpRequest({
            port: harness.port,
            host: "127.0.0.1",
            method: "PATCH",
            path: "/uploads/abc",
            headers,
        });
        client.on("error", () => {
            // Expected: the test destroys this socket on purpose.
        });
        client.write("half-an-upl");
        await received.promise;
        client.destroy();
        return await observed.promise;
    } finally {
        await harness.close();
    }
}

// ─── toWebRequest: message shape ────────────────────────────────────────────

describe("toWebRequest over a real socket", () => {
    test("a PATCH with Content-Length arrives whole, with the length preserved", async () => {
        const seen = deferred<{
            method: string;
            url: string;
            contentLength: string | null;
            body: string;
            transferEncoding: string | null;
            connection: string | null;
        }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            void request.text().then((body) => {
                seen.resolve({
                    method: request.method,
                    url: request.url,
                    contentLength: request.headers.get("content-length"),
                    transferEncoding: request.headers.get("transfer-encoding"),
                    connection: request.headers.get("connection"),
                    body,
                });
                res.writeHead(204).end();
            });
        });

        try {
            const response = await fetch(`${harness.url}/uploads/abc?v=2`, {
                method: "PATCH",
                headers: { "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
                body: "hello world",
            });
            expect(response.status).toBe(204);

            const observed = await seen.promise;
            expect(observed.method).toBe("PATCH");
            expect(observed.url).toBe(`${harness.url}/uploads/abc?v=2`);
            expect(observed.body).toBe("hello world");
            expect(observed.contentLength).toBe("11");
            // Connection-management fields describe a connection the Request does
            // not have (RFC 9110 Section 7.6.1).
            expect(observed.transferEncoding).toBeNull();
            expect(observed.connection).toBeNull();
        } finally {
            await harness.close();
        }
    });

    test("a GET carries no body and no invented framing", async () => {
        const seen = deferred<{ body: unknown; contentLength: string | null }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            seen.resolve({ body: request.body, contentLength: request.headers.get("content-length") });
            res.writeHead(204).end();
        });

        try {
            await fetch(`${harness.url}/f`);
            const observed = await seen.promise;
            expect(observed.body).toBeNull();
            expect(observed.contentLength).toBeNull();
        } finally {
            await harness.close();
        }
    });

    test("the origin option replaces the scheme and authority the socket implies", async () => {
        const seen = deferred<string>();
        const harness = await serve((req, res) => {
            seen.resolve(toWebRequest(req, { origin: "https://files.example.com" }).url);
            res.writeHead(204).end();
        });

        try {
            await fetch(`${harness.url}/uploads/abc`);
            expect(await seen.promise).toBe("https://files.example.com/uploads/abc");
        } finally {
            await harness.close();
        }
    });

    test("connection-scoped fields are dropped, including the ones Connection nominates", async () => {
        const seen = deferred<Record<string, string | null>>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            seen.resolve({
                connection: request.headers.get("connection"),
                te: request.headers.get("te"),
                trailer: request.headers.get("trailer"),
                hop: request.headers.get("x-hop"),
                kept: request.headers.get("x-kept"),
            });
            res.writeHead(204).end();
        });

        try {
            // Written on a raw socket because Node's own client polices the fields
            // under test: it refuses to send `Trailer` on a request it did not frame
            // as chunked. The wire form is what an intermediary would produce.
            //
            // RFC 9110 Section 7.6.1: `X-Hop` is nominated as connection-scoped and
            // belongs to this hop alone, so a handler forwarding the Request upstream
            // must not carry it. `close` is a connection option rather than a field
            // name and nominates nothing.
            const wire = [
                "GET /f HTTP/1.1",
                `Host: 127.0.0.1:${harness.port}`,
                "Connection: close, X-Hop",
                "X-Hop: inserted by the previous hop",
                "X-Kept: yes",
                "TE: trailers",
                "Trailer: X-Sum",
                "",
                "",
            ].join("\r\n");
            const socket = connect(harness.port, "127.0.0.1");
            await new Promise<void>((resolve, reject) => {
                socket.once("error", reject);
                socket.once("close", () => resolve());
                socket.once("connect", () => socket.end(wire));
                socket.resume();
            });

            const observed = await seen.promise;
            expect(observed.connection).toBeNull();
            expect(observed.te).toBeNull();
            expect(observed.trailer).toBeNull();
            expect(observed.hop).toBeNull();
            expect(observed.kept).toBe("yes");
        } finally {
            await harness.close();
        }
    });
});

// ─── Chunked bodies ─────────────────────────────────────────────────────────

describe("chunked request bodies", () => {
    test("no Content-Length is reported when the client sent none", async () => {
        const seen = deferred<{ contentLength: string | null; body: string }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            const contentLength = request.headers.get("content-length");
            void request.text().then((body) => {
                seen.resolve({ contentLength, body });
                res.writeHead(204).end();
            });
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                // Omitting Content-Length makes Node frame the body as chunked, which
                // is the ordinary shape of a streaming tus PATCH.
                headers: { "Upload-Offset": "0" },
            });
            client.write("first-");
            client.end("second");
            await new Promise<void>((resolve) => client.once("response", (res) => res.resume().once("end", resolve)));

            const observed = await seen.promise;
            expect(observed.contentLength).toBeNull();
            expect(observed.body).toBe("first-second");
        } finally {
            await harness.close();
        }
    });

    test("the body streams: a chunk reaches the handler before the client sends the next", async () => {
        const firstChunk = deferred<string>();
        const done = deferred<string>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            void (async () => {
                const reader = request.body!.getReader();
                const decoder = new TextDecoder();
                let all = "";
                let first = true;
                for (;;) {
                    const { done: finished, value } = await reader.read();
                    if (finished) break;
                    const text = decoder.decode(value, { stream: true });
                    all += text;
                    if (first) {
                        first = false;
                        firstChunk.resolve(text);
                    }
                }
                done.resolve(all);
                res.writeHead(204).end();
            })();
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0" },
            });
            let secondSent = false;
            client.write("alpha");

            // The assertion is ordering, not timing: the handler must observe the
            // first chunk while the request is still open. A buffering bridge could
            // only resolve this after `client.end()`.
            const observed = await firstChunk.promise;
            expect(observed).toBe("alpha");
            expect(secondSent).toBe(false);

            secondSent = true;
            client.end("omega");
            await new Promise<void>((resolve) => client.once("response", (res) => res.resume().once("end", resolve)));
            expect(await done.promise).toBe("alphaomega");
        } finally {
            await harness.close();
        }
    });
});

// ─── Stalled uploads ────────────────────────────────────────────────────────

describe("readStallTimeoutMs", () => {
    test("a body that stops mid-transfer is torn down and aborts the request signal", async () => {
        const failure = deferred<{ message: string; aborted: boolean }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { readStallTimeoutMs: 150 });
            void request.text().then(
                () => failure.reject(new Error("expected the stalled body to fail")),
                (err: unknown) => {
                    failure.resolve({
                        message: err instanceof Error ? err.message : String(err),
                        aborted: request.signal.aborted,
                    });
                    if (!res.destroyed) res.destroy();
                },
            );
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0" },
            });
            // Headers plus one chunk, then the client holds the connection open and
            // sends nothing more. Without a bound in the bridge this request would
            // sit on a socket (and on the upload's storage handle) indefinitely.
            client.write("partial");
            client.on("error", () => {
                // The bridge destroys the request, so the client sees the socket close.
            });

            const observed = await failure.promise;
            expect(observed.message).toContain("stalled");
            expect(observed.aborted).toBe(true);
            client.destroy();
        } finally {
            await harness.close();
        }
    });

    /**
     * The numbers here are a squeeze, and both sides of it are load-bearing.
     *
     * Proving the bound is per-GAP rather than per-transfer needs the whole
     * transfer to outlast the bound while no single gap reaches it:
     *
     *     CHUNK_GAP_MS < READ_STALL_MS < CHUNKS * CHUNK_GAP_MS
     *
     * The lower side must hold on a machine under load, and the upper side must
     * hold on an idle one. `sleep` is a FLOOR (a timer never fires early), so the
     * transfer takes at least CHUNKS * CHUNK_GAP_MS however fast the machine is,
     * and the upper side cannot degrade into a vacuous pass. The lower side is
     * the one contention attacks, so the gap sits far below the bound rather than
     * just under it: a run has to lose 15 gap-lengths of CPU in one gap to fail,
     * not two.
     *
     * What this catches, established by mutation rather than assumed: the bound
     * resets on progress. Note that BOTH resets are load-bearing and neither is
     * visible alone. Removing the `clearStall()` from `onData` leaves the next
     * pull's `armStall()` to clear the timer, and removing the one inside
     * `armStall()` leaves `onData` to clear it, so each masks the other's
     * absence and a mutation of either passes. Only removing both makes the
     * bound span the transfer, and then this test fails with the stall error.
     */
    const CHUNKS = 20;
    const CHUNK_GAP_MS = 40;
    const READ_STALL_MS = 600;

    test("a slow but progressing body is never cut off: the bound covers the gap between chunks", async () => {
        // Named so the squeeze above is checked rather than trusted: an edit that
        // breaks the ordering fails here instead of turning the test vacuous.
        expect(CHUNK_GAP_MS).toBeLessThan(READ_STALL_MS);
        expect(READ_STALL_MS).toBeLessThan(CHUNKS * CHUNK_GAP_MS);

        const done = deferred<string>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { readStallTimeoutMs: READ_STALL_MS });
            void request.text().then((body) => {
                done.resolve(body);
                res.writeHead(204).end();
            }, done.reject);
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0" },
            });
            const parts = Array.from({ length: CHUNKS }, (_, i) => String.fromCharCode(97 + (i % 26)));
            for (const part of parts) {
                client.write(part);
                await sleep(CHUNK_GAP_MS);
            }
            client.end();
            expect(await done.promise).toBe(parts.join(""));
        } finally {
            await harness.close();
        }
    });

    test("an unread body attaches nothing, so a rejected request is never killed for the body it declined", async () => {
        const counts = deferred<{ atConversion: number; afterResponse: number }>();
        const harness = await serve((req, res) => {
            // A reader installed at conversion time would feed every byte the client
            // sends into a queue nobody drains, and would arm the stall bound against
            // a request this handler is rejecting unread.
            toWebRequest(req, { readStallTimeoutMs: 50 });
            const atConversion = req.listenerCount("data");
            res.writeHead(401, { "Content-Length": "0" }).end();
            // Sampled an order of magnitude past the bound, not just past it: the
            // sample and the bound are timers in the same process, so what matters is
            // that no plausible scheduling delay reorders them.
            setTimeout(() => counts.resolve({ atConversion, afterResponse: req.listenerCount("data") }), 500);
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0" },
            });
            client.on("error", () => {
                // The server answers without reading; the socket may be torn down.
            });
            client.write("partial");
            const status = await new Promise<number>((resolve, reject) => {
                let answered = false;
                client.once("response", (res) => {
                    answered = true;
                    res.resume();
                    resolve(res.statusCode ?? 0);
                });
                // A reset AFTER the response is the documented end of this exchange:
                // the server answered without reading, so the unread body makes the
                // socket unusable and Node surfaces the teardown as an error on the
                // client. Rejecting on it turns the expected ending into a failure,
                // which is what made this test lose a race under load rather than
                // report anything. Only a reset that arrives with no response at all
                // means the request never got an answer.
                client.once("error", (err) => {
                    if (!answered) reject(err);
                });
            });
            expect(status).toBe(401);

            // Well past the 50ms bound: nothing armed it, because nothing read.
            const observed = await counts.promise;
            expect(observed.atConversion).toBe(0);
            expect(observed.afterResponse).toBe(0);
            client.destroy();
        } finally {
            await harness.close();
        }
    });

    test("the first read is what attaches the reader to the request", async () => {
        const counts = deferred<{ atConversion: number; whileReading: number }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            const atConversion = req.listenerCount("data");
            void request.text().then(() => res.writeHead(204).end());
            setTimeout(() => counts.resolve({ atConversion, whileReading: req.listenerCount("data") }), 50);
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0" },
            });
            client.write("partial");
            const observed = await counts.promise;
            expect(observed.atConversion).toBe(0);
            expect(observed.whileReading).toBe(1);
            client.end();
            await new Promise<void>((resolve) => client.once("response", (res) => res.resume().once("end", resolve)));
        } finally {
            await harness.close();
        }
    });
});

// ─── Client disconnects ─────────────────────────────────────────────────────

describe("client disconnects", () => {
    test("a disconnect mid-body errors the body stream and aborts the signal", async () => {
        // No declared length, so the body is chunked and the disconnect lands on
        // a read already in flight.
        const observed = await abandonedPatch<{ failed: boolean; aborted: boolean }>(
            (req, failure) => {
                const request = toWebRequest(req);
                void request.text().then(
                    () => failure.resolve({ failed: false, aborted: request.signal.aborted }),
                    () => failure.resolve({ failed: true, aborted: request.signal.aborted }),
                );
            },
            { "Upload-Offset": "0" },
        );

        expect(observed.failed).toBe(true);
        expect(observed.aborted).toBe(true);
    });

    test("a message already gone before conversion yields an aborted request", async () => {
        // The client sends its headers and drops while the server's queue is
        // ahead of it: the message's `close` fires before any listener exists.
        // Conversion reads that terminal state, so every signal check
        // downstream refuses at zero cost instead of opening a handle and
        // waiting out the read stall bound for bytes that are never coming.
        const observed = await abandonedPatch<{ aborted: boolean; destroyed: boolean }>((req, seen) => {
            req.once("close", () => {
                const request = toWebRequest(req, { readStallTimeoutMs: 0 });
                seen.resolve({ aborted: request.signal.aborted, destroyed: req.destroyed });
            });
        });

        expect(observed.destroyed).toBe(true);
        expect(observed.aborted).toBe(true);
    });

    test("a first read that starts after the socket closed fails at once, whatever the stall bound", async () => {
        // The listeners the body attaches on its first pull would have caught the
        // `close` that already fired. With the stall bound disabled nothing else
        // ends the wait, so a read attached late has to read the terminal state
        // it is attaching to.
        const observed = await abandonedPatch<{ failed: boolean; ms: number }>((req, outcome) => {
            const request = toWebRequest(req, { readStallTimeoutMs: 0 });
            req.once("close", () => {
                const started = Date.now();
                void request.text().then(
                    () => outcome.resolve({ failed: false, ms: Date.now() - started }),
                    () => outcome.resolve({ failed: true, ms: Date.now() - started }),
                );
            });
        });

        expect(observed.failed).toBe(true);
        expect(observed.ms).toBeLessThan(1000);
    });

    test("a first read after the socket closed fails even when the whole body was parsed", async () => {
        // `complete` says the parser finished, not that this side received the bytes. A
        // small body arrives with its headers and is buffered, the client resets before
        // the response, and the message is destroyed with `complete` true: the bytes went
        // with it. Waiting for them holds the upload lock and the store handle open for
        // the stall bound, or forever at 0.
        const observed = await abandonedPatch<{
            failed: boolean;
            ms: number;
            destroyed: boolean;
            complete: boolean;
            ended: boolean;
        }>(
            (req, outcome) => {
                const request = toWebRequest(req, { readStallTimeoutMs: 0 });
                req.once("close", () => {
                    const started = Date.now();
                    const seen = { destroyed: req.destroyed, complete: req.complete, ended: req.readableEnded };
                    void request.text().then(
                        () => outcome.resolve({ failed: false, ms: Date.now() - started, ...seen }),
                        () => outcome.resolve({ failed: true, ms: Date.now() - started, ...seen }),
                    );
                });
            },
            { "Content-Length": "11" },
        );

        expect(observed.destroyed).toBe(true);
        // The parser did finish: this is the case the narrower predicate let through.
        expect(observed.complete).toBe(true);
        expect(observed.ended).toBe(false);
        expect(observed.failed).toBe(true);
        expect(observed.ms).toBeLessThan(1000);
    });

    test("converting an already-closed message leaves no listener on the caller's signal", async () => {
        // The link comes off in the message's `close` handler, so a message whose close
        // already fired would keep its listener for the life of the process: one per
        // request, each pinning the message it closed over.
        const shutdown = new AbortController();

        const counted = await abandonedPatch<number>((req, seen) => {
            req.once("close", () => {
                toWebRequest(req, { signal: shutdown.signal, readStallTimeoutMs: 0 });
                seen.resolve(getEventListeners(shutdown.signal, "abort").length);
            });
        });

        expect(counted).toBe(0);
    });

    test("a disconnect mid-response stops the pump and cancels the source stream", async () => {
        const cancelled = deferred<boolean>();
        const harness = await serve((req, res) => {
            let pushed = 0;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    // A payload large enough that the client's receive window closes
                    // before the server runs out of chunks to push.
                    if (pushed++ > 4096) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(new Uint8Array(64 * 1024));
                    await sleep(1);
                },
                cancel() {
                    cancelled.resolve(true);
                },
            });
            void sendResponse(res, new Response(body, { headers: { "Content-Type": "application/octet-stream" } }));
        });

        try {
            const controller = new AbortController();
            const response = await fetch(`${harness.url}/big`, { signal: controller.signal });
            const reader = response.body!.getReader();
            await reader.read();
            controller.abort();
            await reader.cancel().catch(() => {
                // The abort already errored the stream.
            });

            expect(await cancelled.promise).toBe(true);
        } finally {
            await harness.close();
        }
    });
});

// ─── sendResponse ───────────────────────────────────────────────────────────

describe("sendResponse", () => {
    test("streams a body and preserves status, reason phrase and headers", async () => {
        const harness = await serve((req, res) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("chunk-one:"));
                    controller.enqueue(new TextEncoder().encode("chunk-two"));
                    controller.close();
                },
            });
            void sendResponse(
                res,
                new Response(body, {
                    status: 206,
                    headers: { "Content-Range": "bytes 0-18/40", "X-Trace": "t1" },
                }),
            );
        });

        try {
            const response = await fetch(`${harness.url}/f`);
            expect(response.status).toBe(206);
            expect(response.headers.get("content-range")).toBe("bytes 0-18/40");
            expect(response.headers.get("x-trace")).toBe("t1");
            expect(await response.text()).toBe("chunk-one:chunk-two");
        } finally {
            await harness.close();
        }
    });

    test("a bodyless status writes no body", async () => {
        const harness = await serve((req, res) => {
            void sendResponse(res, new Response(null, { status: 304, headers: { ETag: '"v1"' } }));
        });

        try {
            const response = await fetch(`${harness.url}/f`);
            expect(response.status).toBe(304);
            expect(response.headers.get("etag")).toBe('"v1"');
            expect(await response.text()).toBe("");
        } finally {
            await harness.close();
        }
    });

    test("Set-Cookie stays a repeated field instead of one comma-joined value", async () => {
        const harness = await serve((req, res) => {
            const headers = new Headers();
            headers.append("Set-Cookie", "a=1; Path=/");
            headers.append("Set-Cookie", "b=2; Path=/");
            void sendResponse(res, new Response(null, { status: 204, headers }));
        });

        try {
            const response = await fetch(`${harness.url}/f`);
            expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
        } finally {
            await harness.close();
        }
    });

    test("a value that is not a Response tears the socket down instead of rejecting", async () => {
        const outcome = deferred<string>();
        const harness = await serve((req, res) => {
            // This primitive is exported and the package is consumable from plain
            // JavaScript, where the parameter type never runs: the argument is
            // whatever the caller had. `undefined` is a Fetch handler that fell
            // through a branch without returning.
            const notAResponse = undefined as unknown as Response;
            void sendResponse(res, notAResponse).then(
                () => outcome.resolve("resolved"),
                () => outcome.resolve("rejected"),
            );
        });

        try {
            await fetch(`${harness.url}/f`, { signal: AbortSignal.timeout(5000) }).then(
                () => {
                    throw new Error("expected the connection to be torn down");
                },
                () => undefined,
            );
            expect(await outcome.promise).toBe("resolved");
        } finally {
            await harness.close();
        }
    });
});

// ─── nodeHandler ────────────────────────────────────────────────────────────

describe("nodeHandler", () => {
    test("round-trips a fetch handler and never rejects when it throws", async () => {
        const errors: unknown[] = [];
        const handler = nodeHandler(
            (request) => {
                if (new URL(request.url).pathname === "/boom") throw new Error("handler blew up");
                return new Response("ok", { status: 200 });
            },
            { onError: (err) => errors.push(err) },
        );
        const harness = await serve((req, res) => {
            void handler(req, res);
        });

        try {
            const ok = await fetch(`${harness.url}/fine`);
            expect(ok.status).toBe(200);
            expect(await ok.text()).toBe("ok");

            const boom = await fetch(`${harness.url}/boom`);
            expect(boom.status).toBe(500);
            expect(boom.headers.get("x-content-type-options")).toBe("nosniff");
            expect(await boom.text()).toBe("Internal Server Error");
            expect(errors).toHaveLength(1);
        } finally {
            await harness.close();
        }
    });

    test("answers Expect: 100-continue only when the handler starts reading", async () => {
        const readStarted = deferred<boolean>();
        const handler = nodeHandler(
            async (request) => {
                // The continue is sent by the bridge at the first pull, which is here.
                await sleep(60);
                readStarted.resolve(true);
                const body = await request.text();
                return new Response(body.toUpperCase(), { status: 200 });
            },
            { answerExpectContinue: true },
        );
        // On the `request` event Node has already sent the continue; `checkContinue`
        // is the flow where it deliberately has not.
        const harness = await serve((req, res) => {
            void handler(req, res);
        }, "checkContinue");

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { Expect: "100-continue", "Content-Length": "5", "Upload-Offset": "0" },
            });

            const continued = await new Promise<boolean>((resolve, reject) => {
                client.once("continue", () => resolve(true));
                client.once("error", reject);
            });
            expect(continued).toBe(true);
            expect(await readStarted.promise).toBe(true);

            client.end("hello");
            const body = await new Promise<string>((resolve, reject) => {
                client.once("response", (res) => {
                    let text = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        text += chunk;
                    });
                    res.once("end", () => resolve(text));
                });
                client.once("error", reject);
            });
            expect(body).toBe("HELLO");
        } finally {
            await harness.close();
        }
    });

    test("a handler that returns nothing is answered 500, and nothing escapes the process", async () => {
        // The parameter type does not run for a plain JavaScript consumer, so a
        // handler missing a `return` on one branch reaches the bridge returning
        // `undefined`. In Express 4 a rejection here kills the process.
        const missingReturn = (() => undefined) as unknown as (request: Request) => Response;
        const errors: unknown[] = [];
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on("unhandledRejection", onRejection);

        const handler = nodeHandler(missingReturn, { onError: (err) => errors.push(err) });
        const harness = await serve((req, res) => {
            void handler(req, res);
        });

        try {
            const response = await fetch(`${harness.url}/f`, { signal: AbortSignal.timeout(5000) });
            expect(response.status).toBe(500);
            expect(await response.text()).toBe("Internal Server Error");
            expect(response.headers.get("x-content-type-options")).toBe("nosniff");
            expect(errors).toHaveLength(1);
            // One turn for a rejection to reach the process if one were pending.
            await sleep(20);
            expect(rejections).toEqual([]);
        } finally {
            process.off("unhandledRejection", onRejection);
            await harness.close();
        }
    });
});

// ─── The dialect this bridge exists for ─────────────────────────────────────

describe("tus over http.createServer", () => {
    test("create then chunked PATCH completes an upload end to end", async () => {
        const store = memoryUploadStore({ objects: {} });
        const tus = createTusHandler(store, {
            policy: { maxSize: Infinity },
            key: () => "object-1",
            location: (token) => `/uploads/${token}`,
            resolveToken: (request) => new URL(request.url).pathname.split("/")[2] || undefined,
        });
        const harness = await serve((req, res) => {
            void nodeHandler((request) => tus(request))(req, res);
        });

        try {
            const created = await fetch(`${harness.url}/uploads`, {
                method: "POST",
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "11" },
            });
            expect(created.status).toBe(201);
            const token = created.headers.get("location")!.split("/").pop()!;

            // No Content-Length: Node frames this chunked, and the dialect must see
            // a request that reports no content length rather than a fabricated one.
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: `/uploads/${token}`,
                headers: {
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": "0",
                    "Content-Type": "application/offset+octet-stream",
                },
            });
            client.write("hello ");
            client.end("world");

            const patched = await new Promise<IncomingMessage>((resolve, reject) => {
                client.once("response", (res) => {
                    res.resume();
                    resolve(res);
                });
                client.once("error", reject);
            });
            expect(patched.statusCode).toBe(204);
            expect(patched.headers["upload-offset"]).toBe("11");

            const head = await fetch(`${harness.url}/uploads/${token}`, {
                method: "HEAD",
                headers: { "Tus-Resumable": "1.0.0" },
            });
            expect(head.headers.get("upload-offset")).toBe("11");
        } finally {
            await harness.close();
        }
    });
});

// ─── A cancelled body must not cost the response ────────────────────────────

describe("body cancellation", () => {
    test("a handler that cancels the body still delivers its response", async () => {
        // Pins the failure this covers: cancelling destroyed the request, which
        // destroys the socket under an incompletely read body, so the response the
        // handler wrote next never reached the client at all.
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            void (async () => {
                await request.body!.cancel();
                await sendResponse(res, new Response("refused", { status: 413 }));
            })();
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0", "Content-Length": "4096" },
            });
            client.end(Buffer.alloc(4096, 0x61));

            const observed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                client.once("response", (res) => {
                    let text = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        text += chunk;
                    });
                    res.once("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
                });
                client.once("error", reject);
            });
            expect(observed.status).toBe(413);
            expect(observed.body).toBe("refused");
        } finally {
            await harness.close();
        }
    });

    test("tus answers 413 for a chunk over maxAppendSize instead of resetting", async () => {
        // The composition this bridge documents: the engine refuses the chunk on
        // its declared length and cancels the body it will never read. A client
        // that receives a reset instead cannot tell refusal from a network fault,
        // and retries the chunk that will be refused again.
        const store = memoryUploadStore({ objects: {} });
        const tus = createTusHandler(store, {
            key: () => "object-1",
            location: (token) => `/uploads/${token}`,
            resolveToken: (request) => new URL(request.url).pathname.split("/")[2] || undefined,
            policy: { maxSize: 1_000_000, maxAppendSize: 1024 },
        });
        const harness = await serve((req, res) => {
            void nodeHandler((request) => tus(request))(req, res);
        });

        try {
            const created = await fetch(`${harness.url}/uploads`, {
                method: "POST",
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "4096" },
            });
            expect(created.status).toBe(201);
            const token = created.headers.get("location")!.split("/").pop()!;

            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: `/uploads/${token}`,
                headers: {
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": "0",
                    "Content-Type": "application/offset+octet-stream",
                    "Content-Length": "4096",
                },
            });
            client.end(Buffer.alloc(4096, 0x62));

            const status = await new Promise<number>((resolve, reject) => {
                client.once("response", (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                });
                client.once("error", reject);
            });
            expect(status).toBe(413);
        } finally {
            await harness.close();
        }
    });
});

// ─── The stall bound's lifetime ─────────────────────────────────────────────

describe("the read stall bound belongs to its own request", () => {
    test("a completed but unread body leaves nothing armed against the next request", async () => {
        // Pins the failure this covers: a body fully parsed but only partly read
        // emits neither `end` nor an incomplete `close`, so a bound armed on
        // arrival stayed armed and destroyed the keep-alive socket once it was
        // carrying an unrelated request.
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { readStallTimeoutMs: 400 });
            void (async () => {
                if (new URL(request.url).pathname === "/partial") {
                    // One chunk answers the question; the rest of the body is parsed,
                    // buffered, and never read.
                    await request.body!.getReader().read();
                    res.writeHead(200, { "Content-Length": "5" }).end("first");
                    return;
                }
                // Outlives the bound the first request would have armed.
                await sleep(1500);
                res.writeHead(200, { "Content-Length": "6" }).end("second");
            })();
        });

        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        try {
            const first = await new Promise<{ body: string; port: number }>((resolve, reject) => {
                const client = httpRequest({
                    port: harness.port,
                    host: "127.0.0.1",
                    method: "POST",
                    path: "/partial",
                    agent,
                    headers: { "Content-Length": "2048" },
                });
                client.once("response", (res) => {
                    // Read while the response still has its socket: it is detached by
                    // the time `end` fires.
                    const port = res.socket.localPort ?? 0;
                    let text = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        text += chunk;
                    });
                    res.once("end", () => resolve({ body: text, port }));
                });
                client.once("error", reject);
                client.end(Buffer.alloc(2048, 0x63));
            });
            expect(first.body).toBe("first");

            const second = await new Promise<{ body: string; port: number }>((resolve, reject) => {
                const client = httpRequest({
                    port: harness.port,
                    host: "127.0.0.1",
                    method: "GET",
                    path: "/second",
                    agent,
                });
                client.once("response", (res) => {
                    const port = res.socket.localPort ?? 0;
                    let text = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        text += chunk;
                    });
                    res.once("end", () => resolve({ body: text, port }));
                });
                client.once("error", reject);
                client.end();
            });
            // The same socket, so the first request's bound had the second one's
            // connection in reach for the whole 1500ms it was being served.
            expect(second.port).toBe(first.port);
            expect(second.body).toBe("second");
        } finally {
            agent.destroy();
            await harness.close();
        }
    });

    test("a slow consumer is not a stalled sender: the bound times the sender only", async () => {
        // Pins the failure this covers: the bound was re-armed on arrival and the
        // socket paused immediately after, so it counted the time the consumer
        // spent between appends and tore down an upload whose sender was never
        // late.
        const totals = deferred<number>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { readStallTimeoutMs: 150 });
            void (async () => {
                const reader = request.body!.getReader();
                let total = 0;
                try {
                    for (;;) {
                        // A store that takes longer per append than the bound allows
                        // between chunks.
                        await sleep(300);
                        const { done, value } = await reader.read();
                        if (done) break;
                        total += value.byteLength;
                    }
                } catch (err) {
                    totals.reject(err);
                    if (!res.destroyed) res.destroy();
                    return;
                }
                totals.resolve(total);
                res.writeHead(204).end();
            })();
        });

        try {
            // Large enough to arrive as several chunks with the sender always ahead
            // of the reader: every read after the first finds bytes already waiting,
            // so any teardown is the consumer's pace being measured, not the
            // sender's.
            const size = 1024 * 1024;
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Upload-Offset": "0", "Content-Length": String(size) },
            });
            client.on("error", () => {
                // A torn-down upload surfaces as the rejected `totals` promise.
            });
            client.end(Buffer.alloc(size, 0x64));

            expect(await totals.promise).toBe(size);
        } finally {
            await harness.close();
        }
    });
});

// ─── The request target and the configured origin ───────────────────────────

describe("absolute-form request targets", () => {
    test("an absolute-form target cannot replace the configured origin", async () => {
        // Pins the failure this covers: resolving the target against the origin
        // let a client-chosen absolute target discard the base entirely, so a
        // handler deriving a Location, an origin check or host-based routing from
        // `request.url` saw the client's scheme and authority.
        const seen = deferred<{ target: string; url: string }>();
        const harness = await serve((req, res) => {
            seen.resolve({
                target: req.url ?? "",
                url: toWebRequest(req, { origin: "https://files.example.com" }).url,
            });
            res.writeHead(204).end();
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "GET",
                path: "http://attacker.test/uploads/abc?v=2",
                headers: { Host: "files.example.com" },
            });
            client.end();
            await new Promise<void>((resolve, reject) => {
                client.once("response", (res) => res.resume().once("end", resolve));
                client.once("error", reject);
            });

            const observed = await seen.promise;
            expect(observed.target).toBe("http://attacker.test/uploads/abc?v=2");
            expect(observed.url).toBe("https://files.example.com/uploads/abc?v=2");
        } finally {
            await harness.close();
        }
    });

    test("with no origin configured the absolute-form target wins over Host", async () => {
        // RFC 9112 Section 3.2.2: the target is authoritative and Host is ignored.
        const seen = deferred<string>();
        const harness = await serve((req, res) => {
            seen.resolve(toWebRequest(req).url);
            res.writeHead(204).end();
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "GET",
                path: "http://elsewhere.example/uploads/abc",
                headers: { Host: "files.example.com" },
            });
            client.end();
            await new Promise<void>((resolve, reject) => {
                client.once("response", (res) => res.resume().once("end", resolve));
                client.once("error", reject);
            });

            expect(await seen.promise).toBe("http://elsewhere.example/uploads/abc");
        } finally {
            await harness.close();
        }
    });
});

describe("request-target paths the bridge refuses", () => {
    /** Send one raw request line and answer the status plus what the handler saw. */
    async function sendTarget(
        target: string,
        origin: string | undefined,
    ): Promise<{ status: number; seen: string | undefined }> {
        let seen: string | undefined;
        const handler = nodeHandler(
            (request) => {
                seen = request.url;
                return new Response(null, { status: 204 });
            },
            origin === undefined ? {} : { origin },
        );
        const harness = await serve((req, res) => void handler(req, res));
        try {
            const socket = connect(harness.port, "127.0.0.1");
            socket.end(`GET ${target} HTTP/1.1\r\nHost: files.example.com\r\nConnection: close\r\n\r\n`);
            const chunks: Buffer[] = [];
            for await (const chunk of socket) chunks.push(chunk as Buffer);
            const head = Buffer.concat(chunks).toString("latin1");
            return { status: Number(head.split(" ")[1]), seen };
        } finally {
            await harness.close();
        }
    }

    for (const origin of [undefined, "https://files.example.com"]) {
        const label = origin === undefined ? "with no origin" : "with an origin";

        test(`an empty first segment cannot name another authority (${label})`, async () => {
            // RFC 3986 Section 3.3: a path that begins with "//" is not a path-absolute,
            // and resolving it as a relative reference reads `evil.example` as the host.
            const answer = await sendTarget("//evil.example/x", origin);
            expect(answer.status).toBe(400);
            expect(answer.seen).toBeUndefined();
        });

        for (const target of ["/a/../b", "/a/./b", "/a/%2E%2e/b", "/a/.%2e", "/a\\..\\b", "http://h.example/a/../b"]) {
            test(`dot segments are refused, never normalized: ${target} (${label})`, async () => {
                const answer = await sendTarget(target, origin);
                expect(answer.status).toBe(400);
                expect(answer.seen).toBeUndefined();
            });
        }

        test(`an ordinary origin-form target reaches the handler unchanged (${label})`, async () => {
            const answer = await sendTarget("/files/a..b/.well/x%20y?q=..&r=//s", origin);
            expect(answer.status).toBe(204);
            const base = origin ?? "http://files.example.com";
            expect(answer.seen).toBe(`${base}/files/a..b/.well/x%20y?q=..&r=//s`);
        });
    }
});

// ─── Framing on methods that carry no body ──────────────────────────────────

describe("bodyless methods", () => {
    test("Content-Length is dropped where the Request carries no body", async () => {
        const seen = deferred<{ body: unknown; contentLength: string | null; other: string | null }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req);
            seen.resolve({
                body: request.body,
                contentLength: request.headers.get("content-length"),
                other: request.headers.get("x-marker"),
            });
            res.writeHead(204).end();
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "GET",
                path: "/f",
                headers: { "Content-Length": "0", "X-Marker": "kept" },
            });
            client.end();
            await new Promise<void>((resolve, reject) => {
                client.once("response", (res) => res.resume().once("end", resolve));
                client.once("error", reject);
            });

            const observed = await seen.promise;
            expect(observed.body).toBeNull();
            expect(observed.contentLength).toBeNull();
            expect(observed.other).toBe("kept");
        } finally {
            await harness.close();
        }
    });
});

// ─── The shutdown signal ────────────────────────────────────────────────────

describe("the shutdown signal folded into Request.signal", () => {
    test("a long-lived signal accumulates no listeners across many requests", async () => {
        // The option exists for a process-lifetime signal, so the count on it has
        // to be bounded by the requests in flight, never by the requests served.
        const shutdown = new AbortController();
        const count = () => getEventListeners(shutdown.signal, "abort").length;
        let peak = 0;
        // Settles on the latest request's `close`, which can trail its response.
        // The bridge subscribed to that event first, so the request's link is
        // already down when this resolves.
        let lastClosed = Promise.resolve();
        const harness = await serve((req, res) => {
            toWebRequest(req, { signal: shutdown.signal });
            peak = Math.max(peak, count());
            lastClosed = new Promise<void>((resolve) => req.once("close", () => resolve()));
            res.writeHead(204).end();
        });

        // One socket for every request: the harshest case for a per-request
        // listener, since nothing is torn down between them.
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        const send = (method: string, body?: string) =>
            new Promise<void>((resolve, reject) => {
                const client = httpRequest({ port: harness.port, host: "127.0.0.1", method, path: "/f", agent });
                client.once("response", (res) => res.resume().once("end", resolve));
                client.once("error", reject);
                if (body !== undefined) client.write(body);
                client.end();
            });

        try {
            expect(count()).toBe(0);
            for (let i = 0; i < 120; i++) {
                // Bodies the handler never reads are the case where nothing but the
                // request's own end can trigger the unlink.
                await send(i % 2 === 0 ? "GET" : "POST", i % 2 === 0 ? undefined : "x".repeat(64));
            }
            await lastClosed;
            expect(count()).toBe(0);
            expect(peak).toBeLessThanOrEqual(2);
        } finally {
            agent.destroy();
            await harness.close();
        }
    });

    test("the signal reaches a request whose body is still arriving", async () => {
        // The unlink must not cost the linkage itself: while the client is still
        // sending, a shutdown is what a store reading `request.signal` unwinds on.
        const shutdown = new AbortController();
        const aborted = deferred<unknown>();
        // The shutdown fires on a request that is already converted and listening.
        // Fired ahead of the handler it would reach conversion as an already
        // aborted signal, which is another case and dispatches no event here.
        const listening = deferred<void>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { signal: shutdown.signal });
            request.signal.addEventListener("abort", () => aborted.resolve(request.signal.reason));
            listening.resolve();
            // The body is read to keep the request alive; the read itself is not
            // what the signal tears down.
            void request.text().catch(() => {
                // The socket goes away at the end of the test.
            });
            res.on("error", () => {
                // The teardown may beat the response out; nothing to write.
            });
        });

        const client = httpRequest({
            port: harness.port,
            host: "127.0.0.1",
            method: "PATCH",
            path: "/uploads/abc",
            headers: { "Transfer-Encoding": "chunked" },
        });
        client.on("error", () => {
            // Expected once the test destroys this socket.
        });
        try {
            client.write("first-chunk");
            await listening.promise;
            const reason = new Error("partial-content-test: shutting down");
            shutdown.abort(reason);

            // The external reason travels, rather than a substitute of the bridge's.
            expect(await aborted.promise).toBe(reason);
        } finally {
            client.destroy();
            await harness.close();
        }
    });

    test("an answered request whose body never completed still unlinks when its socket dies", async () => {
        // A handler that refuses a request unread leaves the message incomplete
        // on a socket the server then tears down. Whether the message emits its
        // own `close` for that ending varies; the socket's `close` does not, and
        // the link to the process-lifetime signal has to come down on it.
        const shutdown = new AbortController();
        const count = () => getEventListeners(shutdown.signal, "abort").length;
        const socketClosed = deferred<void>();
        const harness = await serve((req, res) => {
            toWebRequest(req, { signal: shutdown.signal });
            req.socket.once("close", () => socketClosed.resolve());
            res.writeHead(401, { "Content-Length": "0" }).end();
            // The unread body makes the socket unusable; the server ends it.
            res.once("finish", () => req.socket.destroy());
        });

        try {
            const client = httpRequest({
                port: harness.port,
                host: "127.0.0.1",
                method: "PATCH",
                path: "/uploads/abc",
                headers: { "Content-Length": "100" },
            });
            client.on("error", () => {
                // Expected: the server tears the socket down under the unread body.
            });
            client.write("partial");
            await socketClosed.promise;
            expect(count()).toBe(0);
            client.destroy();
        } finally {
            await harness.close();
        }
    });

    test("a signal already aborted at conversion time yields an aborted request", async () => {
        const shutdown = new AbortController();
        shutdown.abort(new Error("partial-content-test: already down"));
        const seen = deferred<{ aborted: boolean; reason: unknown }>();
        const harness = await serve((req, res) => {
            const request = toWebRequest(req, { signal: shutdown.signal });
            seen.resolve({ aborted: request.signal.aborted, reason: request.signal.reason });
            res.writeHead(204).end();
        });

        try {
            await fetch(`${harness.url}/f`);
            const observed = await seen.promise;
            expect(observed.aborted).toBe(true);
            expect(observed.reason).toBe(shutdown.signal.reason);
            // Nothing was registered, so nothing needs unlinking.
            expect(getEventListeners(shutdown.signal, "abort").length).toBe(0);
        } finally {
            await harness.close();
        }
    });
});
