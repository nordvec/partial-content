/**
 * Node-runtime smoke test for the BUILT `partial-content/node` fetch bridge.
 *
 * `smoke.mjs` deliberately avoids the Node-`Readable` path so the same file
 * runs under Deno; this file is its opposite number. The bridge converts
 * `IncomingMessage` to `Request` and `Response` back to `ServerResponse`, so
 * its correctness depends on the runtime's own Fetch implementation: whether a
 * `Content-Length` header survives onto a constructed `Request`, whether a
 * stream body is carried rather than buffered, what a second read of a used
 * body throws. The suite runs under Bun, so those answers are Bun's. This file
 * asks them of Node, against `dist/`.
 *
 * Run: `node smoke/node-bridge.mjs` (build dist/ first: `npm run build`).
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

import { toWebRequest, sendResponse, nodeHandler } from "../dist/node.js";
import { createTusHandler } from "../dist/tus.js";
import { memoryUploadStore } from "../dist/memory.js";
import { listenForFetch } from "./listen.mjs";

console.log(`partial-content node bridge smoke (Node ${process.versions.node})`);

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function serve(listener, event = "request") {
    const server = createServer();
    server.on(event, listener);
    const port = await listenForFetch(server);
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

// ── The harness never binds a port fetch refuses ────────────────────────────
await check("listenForFetch redraws a port fetch blocks", async () => {
    const drawn = [6000, 6665, 41234];
    const closes = [];
    const server = {
        listen: (_port, _host, resolve) => resolve(),
        address: () => ({ port: drawn[0] }),
        close: (resolve) => {
            closes.push(drawn.shift());
            resolve();
        },
    };
    assert.equal(await listenForFetch(server), 41234);
    assert.deepEqual(closes, [6000, 6665]);
});

// ── A chunked body streams and reports no content length ────────────────────
await check("chunked PATCH streams and reports no Content-Length", async () => {
    const firstChunk = deferred();
    const finished = deferred();
    const harness = await serve((req, res) => {
        const request = toWebRequest(req);
        assert.equal(request.headers.get("content-length"), null, "chunked request must not report a length");
        assert.equal(request.headers.get("transfer-encoding"), null, "connection framing must be dropped");
        void (async () => {
            const reader = request.body.getReader();
            const decoder = new TextDecoder();
            let all = "";
            let first = true;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                all += decoder.decode(value, { stream: true });
                if (first) {
                    first = false;
                    firstChunk.resolve(all);
                }
            }
            finished.resolve(all);
            res.writeHead(204).end();
        })();
    });

    try {
        const client = httpRequest({
            host: "127.0.0.1",
            port: harness.port,
            method: "PATCH",
            path: "/uploads/abc",
            headers: { "Upload-Offset": "0" },
        });
        client.write("alpha");
        assert.equal(await firstChunk.promise, "alpha");
        client.end("omega");
        await new Promise((resolve) => client.once("response", (res) => res.resume().once("end", resolve)));
        assert.equal(await finished.promise, "alphaomega");
    } finally {
        await harness.close();
    }
});

// ── A stalled body is bounded by the bridge ─────────────────────────────────
await check("a stalled request body hits readStallTimeoutMs and aborts the signal", async () => {
    const failure = deferred();
    const harness = await serve((req, res) => {
        const request = toWebRequest(req, { readStallTimeoutMs: 150 });
        void request.text().then(
            () => failure.reject(new Error("expected the stalled body to fail")),
            (err) => {
                failure.resolve({ message: String(err?.message ?? err), aborted: request.signal.aborted });
                if (!res.destroyed) res.destroy();
            },
        );
    });

    try {
        const client = httpRequest({
            host: "127.0.0.1",
            port: harness.port,
            method: "PATCH",
            path: "/uploads/abc",
            headers: { "Upload-Offset": "0" },
        });
        client.on("error", () => {});
        client.write("partial");
        const observed = await failure.promise;
        assert.match(observed.message, /stalled/);
        assert.equal(observed.aborted, true);
        client.destroy();
    } finally {
        await harness.close();
    }
});

// ── The response direction streams and keeps Set-Cookie repeated ────────────
await check("sendResponse streams a body and keeps Set-Cookie a repeated field", async () => {
    const harness = await serve((req, res) => {
        const headers = new Headers({ "Content-Range": "bytes 0-8/40" });
        headers.append("Set-Cookie", "a=1; Path=/");
        headers.append("Set-Cookie", "b=2; Path=/");
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("part-one:"));
                controller.enqueue(new TextEncoder().encode("part-two"));
                controller.close();
            },
        });
        void sendResponse(res, new Response(body, { status: 206, headers }));
    });

    try {
        const response = await fetch(`${harness.url}/f`);
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-range"), "bytes 0-8/40");
        assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
        assert.equal(await response.text(), "part-one:part-two");
    } finally {
        await harness.close();
    }
});

// ── The dialect this bridge exists for ──────────────────────────────────────
await check("tus create + chunked PATCH completes over http.createServer", async () => {
    const tus = createTusHandler(memoryUploadStore({ objects: {} }), {
        key: () => "object-1",
        policy: { maxSize: 1024 * 1024 },
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
        assert.equal(created.status, 201);
        const token = created.headers.get("location").split("/").pop();

        const client = httpRequest({
            host: "127.0.0.1",
            port: harness.port,
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
        const patched = await new Promise((resolve, reject) => {
            client.once("response", (res) => {
                res.resume();
                resolve(res);
            });
            client.once("error", reject);
        });
        assert.equal(patched.statusCode, 204);
        assert.equal(patched.headers["upload-offset"], "11");

        const head = await fetch(`${harness.url}/uploads/${token}`, {
            method: "HEAD",
            headers: { "Tus-Resumable": "1.0.0" },
        });
        assert.equal(head.headers.get("upload-offset"), "11");
    } finally {
        await harness.close();
    }
});

// ── Expect: 100-continue is answered when the handler starts reading ────────
await check("answerExpectContinue sends the continue at first read", async () => {
    const handler = nodeHandler(
        async (request) => {
            await sleep(40);
            return new Response((await request.text()).toUpperCase(), { status: 200 });
        },
        { answerExpectContinue: true },
    );
    const harness = await serve((req, res) => {
        void handler(req, res);
    }, "checkContinue");

    try {
        const client = httpRequest({
            host: "127.0.0.1",
            port: harness.port,
            method: "PATCH",
            path: "/uploads/abc",
            headers: { Expect: "100-continue", "Content-Length": "5", "Upload-Offset": "0" },
        });
        await new Promise((resolve, reject) => {
            client.once("continue", resolve);
            client.once("error", reject);
        });
        client.end("hello");
        const body = await new Promise((resolve, reject) => {
            client.once("response", (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    text += chunk;
                });
                res.once("end", () => resolve(text));
            });
            client.once("error", reject);
        });
        assert.equal(body, "HELLO");
    } finally {
        await harness.close();
    }
});

// ── A handler that throws never escapes as an unhandled rejection ───────────
await check("nodeHandler answers 500 and reports a throwing handler", async () => {
    const errors = [];
    const harness = await serve((req, res) => {
        void nodeHandler(
            () => {
                throw new Error("blew up");
            },
            { onError: (err) => errors.push(err) },
        )(req, res);
    });

    try {
        const response = await fetch(`${harness.url}/boom`);
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await response.text(), "Internal Server Error");
        assert.equal(errors.length, 1);
    } finally {
        await harness.close();
    }
});

console.log(`\n${passed} checks passed`);
