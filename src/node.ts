/**
 * Node.js HTTP adapter for partial-content.
 *
 * {@link serveObject} is a ready-made handler that serves ranges and
 * conditional requests from an {@link ObjectStore} to a Node.js
 * `IncomingMessage`/`ServerResponse` pair. Works with Express, Fastify (in
 * compatibility mode), Koa, raw `http.createServer`, and any Node.js HTTP
 * framework that exposes the standard request/response objects.
 *
 * HTTP/1.1 only. `Http2ServerRequest` carries pseudo-header semantics of its
 * own, is not accepted by these types, and is not tested here.
 *
 * @example Express
 * ```typescript
 * import path from "node:path";
 * import express from "express";
 * import { serveObject } from "partial-content/node";
 * import { fsStore } from "partial-content/fs";
 *
 * const store = fsStore({ root: path.resolve("uploads") });
 * const app = express();
 *
 * // The type parameter makes framework fields (req.params) typecheck in
 * // the extractors; plain JS callers just omit it.
 * app.get("/files/:key", serveObject<express.Request>(store, {
 *   key: (req) => req.params.key,
 *   disposition: "inline",
 * }));
 * ```
 *
 * @example raw http.createServer
 * ```typescript
 * import { createServer } from "node:http";
 * import { serveObject } from "partial-content/node";
 * import { s3Store } from "partial-content/s3";
 *
 * const store = s3Store({ client, bucket: "docs" });
 * // Only the path is wanted, so the base is a constant: an authority taken
 * // from `Host` here would be a client-chosen value standing in a key. A key
 * // is the object's name, so the path is percent-decoded.
 * const keyOf = (url = "/") => decodeURIComponent(new URL(url, "http://host.invalid").pathname.slice(1));
 * const handler = serveObject(store, { key: (req) => keyOf(req.url) });
 *
 * createServer((req, res) => {
 *   // A malformed escape (`%E0%A4%A`) makes decodeURIComponent throw: answer
 *   // 400 before the handler, instead of letting it surface as a 500.
 *   try {
 *     keyOf(req.url);
 *   } catch {
 *     res.writeHead(400).end();
 *     return;
 *   }
 *   return handler(req, res);
 * }).listen(3000);
 * ```
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { plainTextErrorParts } from "./error-response.ts";
import { serveObjectRaw, type RawResponseParts, type ServeObjectOptions, type ServeContext } from "./web.ts";
import type { ObjectStore } from "./index.ts";
import { projectError } from "./object-store.ts";
import { guardSink, UNKEYED_AUDIT_KEY } from "./hooks.ts";

// ─── Options ────────────────────────────────────────────────────────────────

export interface NodeServeOptions<Req extends IncomingMessage = IncomingMessage> extends ServeObjectOptions {
    /**
     * Extract the storage key from the incoming request.
     *
     * `Req` defaults to the raw Node.js IncomingMessage; pass your
     * framework's request type (e.g. `serveObject<express.Request>`) so
     * framework fields like `req.params` typecheck in the extractors.
     */
    key: (req: Req) => string | Promise<string>;

    /**
     * Extract the MIME type from the request.
     * When omitted, defaults to "application/octet-stream".
     */
    mime?: (req: Req) => string | undefined;

    /**
     * Extract the filename from the request (for Content-Disposition).
     * When omitted, no filename is set.
     */
    filename?: (req: Req) => string | undefined;

    /**
     * Extract an audit-safe identifier reported as `key` in every
     * `onServe`/`onTransfer`/`onError` event instead of the storage key
     * (which commonly embeds a filename -- personal data that must stay out
     * of log records). The store still reads by the real key. When the
     * extractor returns `undefined` the events carry the constant `"unkeyed"`,
     * never the storage key.
     */
    auditKey?: (req: Req) => string | undefined;

    /**
     * Max milliseconds to wait for a single backpressure `drain` while streaming
     * before treating the client as stalled and tearing the transfer down.
     *
     * A client that stops reading but holds its socket open (a slow-read attack)
     * fills the send buffer, so `res.write()` returns false and `drain` never
     * fires. Without a bound the stream pump would wait forever, pinning the
     * backend storage socket (and its connection-pool slot). A stall reliably
     * tears down via the existing error path (cancel the reader, destroy the
     * response). Set to `0` to disable and rely on an upstream proxy / socket
     * timeout instead.
     *
     * @default 60000
     */
    writeStallTimeoutMs?: number;
}

/** Default backpressure stall bound: 60s of zero drain is a stalled reader. */
const DEFAULT_WRITE_STALL_MS = 60_000;

/** The largest delay a timer takes: a larger one fires after about a millisecond, ending a wait that has barely begun. */
const MAX_TIMER_MS = 2 ** 31 - 1;

// ─── Response writing ───────────────────────────────────────────────────────

/**
 * Write a response body to a `ServerResponse`, streaming with backpressure.
 *
 * Bodyless statuses and byte bodies take a single `end()`. A stream body is
 * pumped chunk by chunk so a large object never materializes in memory, and
 * the pump stops the moment the client is gone.
 *
 * Once a reader is acquired this never rethrows: headers are already on the
 * wire by then, so no error response is possible and the only honest outcome
 * is a torn-down socket, which the client reads as a truncated transfer
 * rather than a hang. `end()` on the bodyless and byte paths is deliberately
 * left to throw, so the caller's pre-stream handling still sees it.
 */
async function writeBody(
    res: ServerResponse,
    body: ReadableStream<Uint8Array<ArrayBufferLike>> | Uint8Array | null,
    stallMs: number,
): Promise<void> {
    if (!body) {
        res.end();
        return;
    }

    // Byte bodies (in-memory stores, fs small-transfer fast path, error
    // pages): a single write, no reader machinery.
    if (body instanceof Uint8Array) {
        res.end(body);
        return;
    }

    // Client disconnects abort the source stream (via the request signal), which
    // rejects reader.read(); that rejection must be contained here, not escape
    // the handler.
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.destroyed) {
                // Client is gone; stop pulling and release the source stream.
                await reader.cancel();
                break;
            }
            const canContinue = res.write(value);
            if (!canContinue) {
                // Backpressure: wait for drain, or for the response to close
                // (client disconnect) so a stalled socket cannot hang this loop.
                // A stall timeout bounds a reader that stops consuming but holds
                // the socket open: it rejects into the catch below, which cancels
                // the source reader and destroys the response.
                await new Promise<void>((resolve, reject) => {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const cleanup = () => {
                        if (timer !== undefined) clearTimeout(timer);
                        res.off("drain", onDone);
                        res.off("close", onDone);
                    };
                    const onDone = () => {
                        cleanup();
                        resolve();
                    };
                    if (stallMs > 0) {
                        timer = setTimeout(
                            () => {
                                cleanup();
                                reject(new Error("partial-content: response write stalled"));
                            },
                            Math.min(stallMs, MAX_TIMER_MS),
                        );
                        // Do not keep the event loop alive solely for this timer.
                        timer.unref?.();
                    }
                    res.once("drain", onDone);
                    res.once("close", onDone);
                });
            }
        }
        res.end();
    } catch {
        // Transfer failed mid-stream (disconnect or source error). Headers are
        // already sent, so no error response is possible; tear the socket down
        // so the client sees a truncated transfer instead of a hang.
        await reader.cancel().catch(() => {
            // Stream may already be errored; cancel is best-effort
        });
        if (!res.destroyed) res.destroy();
    }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export type { ServeObjectOptions, ServeContext } from "./web.ts";
export type { ObjectStore } from "./index.ts";
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "./index.ts";

/**
 * Create a Node.js request handler that serves files from an {@link ObjectStore}.
 *
 * Reads the method and headers straight off the `IncomingMessage`, delegates to
 * the web adapter's `serveObjectRaw`, then writes the resulting status, headers
 * and body to the `ServerResponse`. No Fetch `Request` or `Response` is built.
 */
export function serveObject<Req extends IncomingMessage = IncomingMessage>(
    store: ObjectStore,
    opts: NodeServeOptions<Req>,
) {
    const {
        key: keyFn,
        mime: mimeFn,
        filename: filenameFn,
        auditKey: auditKeyFn,
        writeStallTimeoutMs,
        ...serveOpts
    } = opts;
    const handler = serveObjectRaw(store, serveOpts);
    // The adapter reports a failing extractor itself, so its sink is guarded
    // here the same way the handler guards its own.
    const onError = guardSink(serveOpts.onError);
    const stallMs = writeStallTimeoutMs ?? DEFAULT_WRITE_STALL_MS;

    return async function handleNodeServe(req: Req, res: ServerResponse): Promise<void> {
        // Wire up client-disconnect detection: when the connection closes before
        // the response finished (client navigates away, connection drops),
        // signal the web adapter to cancel the storage stream and stop
        // transferring bytes.
        //
        // The signal comes from the RESPONSE, never the request: an
        // IncomingMessage emits "close" once it has been read to its end, which
        // says nothing about the client (a body parser that drained it earlier
        // has already fired it; one that drains it mid-handler fires it for a
        // client that is still connected).
        //
        // The listener MUST be detached once the response is fully written:
        // a response emits "close" after every NORMAL completion too, and an
        // abort() there constructs a DOMException and notifies the store's
        // abort listener on every request -- measured at ~8% of serve CPU.
        const ac = new AbortController();
        const onClientGone = () => {
            if (!res.writableFinished) ac.abort();
        };
        res.once("close", onClientGone);
        // A "close" that fired before this listener attached is never delivered
        // again: the connection is already gone, so the signal starts aborted.
        if (res.destroyed || res.closed) onClientGone();

        // Lightweight ServableRequest view: the orchestrator only reads method,
        // headers.get, and signal, so constructing real fetch primitives
        // (undici Request + Headers) per request would be pure overhead. Node
        // already lower-cases incoming header names, so reads go straight to
        // req.headers with no per-request copy; join() matches how Node folds
        // repeated headers (request headers are never Set-Cookie).
        const nodeHeaders = req.headers;
        const fetchRequest = {
            method: req.method ?? "GET",
            headers: {
                get(name: string): string | null {
                    const value = nodeHeaders[name.toLowerCase()];
                    if (value === undefined) return null;
                    return Array.isArray(value) ? value.join(", ") : value;
                },
            },
            signal: ac.signal,
        };

        // Resolve context and delegate to the web adapter. Guarded: a throwing
        // key/mime/filename extractor (caller code) must become a 500 response,
        // not a rejected handler -- in Express 4 an async handler rejection is
        // an unhandled promise rejection, which kills the process.
        let parts: RawResponseParts;
        try {
            const key = await keyFn(req);
            const ctx: ServeContext = {
                key,
                mime: mimeFn?.(req),
                filename: filenameFn?.(req),
                // A configured extractor that yields nothing still keys the
                // request: falling back to the storage key would put a filename
                // into the audit trail the extractor exists to keep it out of.
                auditKey: auditKeyFn ? (auditKeyFn(req) ?? UNKEYED_AUDIT_KEY) : undefined,
            };
            parts = await handler(fetchRequest, ctx);
        } catch (err) {
            // A throwing extractor is consumer code failing: surface it to the
            // consumer's telemetry (the response body stays generic), with the
            // same error-hygiene headers every other error response carries.
            // Under an auditKey it is the projection: the raw error may name the key.
            onError?.(auditKeyFn ? projectError(err, "context") : err, { key: "", operation: "context" });
            sendPlainError(res, 500, "Internal Server Error");
            res.off("close", onClientGone);
            return;
        }

        // Write the raw parts straight to the ServerResponse: no fetch
        // primitives were constructed anywhere on this path. Preserves custom
        // reason phrases (e.g. 499 Client Closed Request). The outer try/finally
        // is load-bearing: writeHead and end can throw SYNCHRONOUSLY (socket
        // destroyed in the await window, a header value the runtime rejects),
        // and that throw must not leak the storage stream, leave the disconnect
        // listener attached, or escape as an unhandled rejection (which kills
        // Express 4 processes).
        try {
            res.writeHead(parts.status, parts.statusText, parts.headers);
            await writeBody(res, parts.body, stallMs);
        } catch {
            // writeHead/end threw synchronously. writeBody never rethrows once it
            // owns a reader, so this only catches pre-stream failures: release an
            // unconsumed stream
            // body (fs handle / backend socket) and tear the connection down.
            if (parts.body instanceof ReadableStream) {
                await parts.body.cancel().catch(() => {
                    // Already locked or errored; best-effort release
                });
            }
            if (!res.destroyed) res.destroy();
        } finally {
            res.off("close", onClientGone);
        }
    };
}

// ─── Error responses ────────────────────────────────────────────────────────

/**
 * Hardened plain-text error response, carrying the error-hygiene headers every
 * other error response in this package carries. A response already on the wire
 * has no room for one, so the connection is torn down instead.
 */
function sendPlainError(res: ServerResponse, status: number, body: string): void {
    if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
    }
    const { bytes, headers } = plainTextErrorParts(body);
    res.writeHead(status, headers);
    res.end(bytes);
}
