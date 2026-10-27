/**
 * Node.js HTTP adapter for partial-content.
 *
 * Bridges the gap between Node.js `IncomingMessage`/`ServerResponse` and the
 * Fetch primitives every other adapter in this package speaks. Works with
 * Express, Fastify (in compatibility mode), Koa, raw `http.createServer`, and
 * any Node.js HTTP framework that exposes the standard request/response
 * objects.
 *
 * Two surfaces live here. {@link serveObject} is the read side: a ready-made
 * handler that serves ranges and conditional requests from an
 * {@link ObjectStore}. {@link toWebRequest} and {@link sendResponse} are the
 * write side: the conversion each way, so the resumable-upload dialects
 * (`partial-content/tus`, `partial-content/upload`), which are Fetch handlers,
 * run on a Node server without the consumer hand-writing the bridge.
 * {@link nodeHandler} composes the pair when a single Fetch handler owns a
 * whole route.
 *
 * HTTP/1.1 only. `Http2ServerRequest` carries pseudo-header semantics of its
 * own, is not accepted by these types, and is not tested here.
 *
 * @example Express
 * ```typescript
 * import express from "express";
 * import { serveObject } from "partial-content/node";
 * import { fsStore } from "partial-content/fs";
 *
 * const store = fsStore({ root: "./uploads" });
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
 * const handler = serveObject(store, {
 *   // Only the path is wanted, so the base is a constant: an authority taken
 *   // from `Host` here would be a client-chosen value standing in a key.
 *   key: (req) => new URL(req.url ?? "/", "http://host.invalid").pathname.slice(1),
 * });
 *
 * createServer((req, res) => handler(req, res)).listen(3000);
 * ```
 *
 * @packageDocumentation
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { serveObjectRaw, type RawResponseParts, type ServeObjectOptions, type ServeContext } from "./web.ts";
import type { ObjectStore } from "./index.ts";
import { projectError } from "./object-store.ts";

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
     * of log records). The store still reads by the real key.
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

/** Default request-body stall bound: 60s of zero inbound bytes is a stalled sender. */
const DEFAULT_READ_STALL_MS = 60_000;

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
                        timer = setTimeout(() => {
                            cleanup();
                            reject(new Error("partial-content: response write stalled"));
                        }, stallMs);
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
    } finally {
        reader.releaseLock();
    }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Node.js request handler that serves files from an {@link ObjectStore}.
 *
 * Converts Node.js `IncomingMessage` to a Fetch `Request`, delegates to the
 * web adapter's `serveObject`, then writes the Fetch `Response` back to the
 * Node.js `ServerResponse`.
 */
export type { ServeObjectOptions, ServeContext } from "./web.ts";
export type { ObjectStore } from "./index.ts";
export { ObjectNotFoundError, ObjectChangedError, StoreUnavailableError } from "./index.ts";

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
    const stallMs = writeStallTimeoutMs ?? DEFAULT_WRITE_STALL_MS;

    return async function handleNodeServe(req: Req, res: ServerResponse): Promise<void> {
        // Wire up client-disconnect detection: when the Node.js request closes
        // (client navigates away, connection drops), signal the web adapter to
        // cancel the storage stream and stop transferring bytes.
        //
        // The listener MUST be detached once the response is fully written:
        // IncomingMessage emits "close" after every NORMAL completion too, and
        // an abort() there constructs a DOMException and notifies the store's
        // abort listener on every request -- measured at ~8% of serve CPU.
        const ac = new AbortController();
        const onClientGone = () => ac.abort();
        req.once("close", onClientGone);

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
                auditKey: auditKeyFn?.(req),
            };
            parts = await handler(fetchRequest, ctx);
        } catch (err) {
            // A throwing extractor is consumer code failing: surface it to the
            // consumer's telemetry (the response body stays generic), with the
            // same error-hygiene headers every other error response carries.
            // Under an auditKey it is the projection: the raw error may name the key.
            serveOpts.onError?.(auditKeyFn ? projectError(err, "context") : err, { key: "", operation: "context" });
            sendPlainError(res, 500, "Internal Server Error");
            req.off("close", onClientGone);
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
            res.writeHead(parts.status, parts.statusText || undefined, parts.headers);
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
            req.off("close", onClientGone);
        }
    };
}

// ─── Fetch bridge ───────────────────────────────────────────────────────────
//
// The upload dialects (`partial-content/tus`, `partial-content/upload`) are
// Fetch handlers: `(Request) => Promise<Response>`. Node's `http` server speaks
// `IncomingMessage`/`ServerResponse`. These two primitives convert between the
// pairs, and stay primitives rather than one handler because a dialect endpoint
// has to be composed with the consumer's own routing, auth, and token
// resolution, all of which live between the two conversions.
//
// SCOPE: HTTP/1.1 only. `Http2ServerRequest` is a separate class carrying
// pseudo-headers (`:method`, `:path`, `:authority`) and framing of its own,
// none of which this file reads. It is not accepted by these types and it is
// not tested here, so support for it is not claimed. Serve HTTP/2 by
// terminating it at a reverse proxy that forwards HTTP/1.1 to this server.

/**
 * Fields that describe the HTTP/1.1 connection rather than the message
 * (RFC 9110 Section 7.6.1). `Proxy-Connection` is not in that list and is not
 * standard, but it is connection-scoped by construction and travels with the
 * same hop.
 */
const CONNECTION_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

const EXPECT_100_CONTINUE = /(?:^|,)\s*100-continue\s*(?:,|$)/i;

export interface ToWebRequestOptions {
    /**
     * Absolute origin (`https://files.example.com`) the request URL is resolved
     * against, replacing the scheme and authority derived from the socket and
     * the `Host` header.
     *
     * Set this behind a TLS-terminating proxy: the origin server sees plaintext
     * HTTP, so the derived scheme is `http` and any absolute URL a handler builds
     * from it names a scheme the client never used. `X-Forwarded-Proto` is
     * deliberately NOT consulted, because a header a client can send is not
     * evidence of how the client connected.
     *
     * Set it also wherever a handler turns `request.url` into a URL it hands
     * back, the `Location` of a created upload being the case this package
     * exists for. With no origin configured the authority comes from `Host`,
     * which is the right answer for a server addressed by more than one name and
     * is still a value the client chose: an unconfigured deployment emits, in
     * that `Location`, whatever authority the request carried. Configuring the
     * origin is what makes the authority the deployment's own, and it is the
     * only thing that does.
     *
     * Only the path and query of the request target are taken; the scheme and
     * authority are this value's, always. A request target in absolute form
     * (`GET https://elsewhere.example/x HTTP/1.1`, RFC 9112 Section 3.2.2) is as
     * client-controlled as the `Host` header, so it cannot select the origin
     * either: a handler deriving a `Location`, an origin check, or host-based
     * routing from `request.url` sees the authority the deployment configured.
     */
    origin?: string;

    /**
     * Max milliseconds to wait for the next request-body chunk before treating
     * the sender as stalled and tearing the request down.
     *
     * A `Request` body is read through this bridge rather than through the HTTP
     * server's own parser callbacks, so `server.requestTimeout` no longer bounds
     * a client that sends its headers, opens a PATCH body, and then sends
     * nothing: the connection would be pinned for as long as the client cares to
     * hold it, along with whatever storage handle the upload engine has open for
     * it. Firing the bound destroys the request, which errors the body stream and
     * aborts {@link Request.signal}, so an in-flight append unwinds on the path
     * it already has for a client disconnect.
     *
     * It runs only while a read is outstanding: armed when the reader asks for a
     * chunk, cleared the moment one arrives. So it measures the sender's latency
     * and nothing else. The total upload duration is not bounded, a slow but
     * progressing multi-gigabyte upload is never cut off, and a store that takes
     * minutes between appends is the consumer's own pace rather than a stall,
     * which matters because surviving a slow backend is what a resumable upload
     * is for. A handler that rejects a request without reading its body (auth
     * failure, unknown token) arms nothing at all. Set to `0` to disable and rely
     * on an upstream proxy instead.
     *
     * @default 60000
     */
    readStallTimeoutMs?: number;

    /**
     * Additional abort source folded into {@link Request.signal}, on top of the
     * client-disconnect detection the bridge always installs. Wire a graceful
     * shutdown signal here so in-flight appends unwind instead of being killed
     * with the process.
     *
     * The fold lasts until the request message ends, and the signal it hangs off
     * is expected to be one per process rather than one per request. So a
     * shutdown reaches a request whose body is still arriving or still being
     * read, and does not reach whatever a handler does after the last inbound
     * byte: recording a final offset is the half of an upload a graceful
     * shutdown wants to let finish, not cancel.
     */
    signal?: AbortSignal;

    /**
     * Invoked once, lazily, the first time the request body is READ, and only
     * when the request carries `Expect: 100-continue` (RFC 9110 Section 10.1.1).
     *
     * The bridge itself never writes an interim response, for two reasons. On the
     * server's `request` event Node has already sent the `100 Continue` before
     * the listener runs, so a second one from here would be a duplicate interim
     * response on the wire. And in the flow where Node has NOT sent it, the
     * server's `checkContinue` event, withholding the continue is the whole point
     * of the event: whether the body is worth receiving is an authorization
     * decision belonging to the handler, and a bridge cannot make it.
     *
     * So the bridge reports the moment instead of deciding it. A `checkContinue`
     * consumer that has approved the request passes `() => res.writeContinue()`
     * and gets the continue sent exactly when the handler starts reading, not
     * before. Do not also call `writeContinue()` yourself, and do not pass this
     * from a plain `request` listener.
     */
    onExpectContinue?: () => void;
}

/**
 * The Fetch standard requires `duplex: "half"` on a request constructed with a
 * stream body, and the runtimes that accept one enforce it. TypeScript's DOM
 * lib does not declare the member, so a consumer compiling with that lib sees
 * an error on a field the platform demands. Declaring the gap keeps the value
 * typed rather than asserted past, and this goes away when the lib carries it.
 */
interface StreamingRequestInit extends RequestInit {
    duplex?: "half";
}

/**
 * Build a Fetch `Request` from a Node `IncomingMessage`.
 *
 * The body streams: chunks reach the handler as the socket delivers them, with
 * backpressure applied to the socket when the reader falls behind, so a
 * multi-gigabyte upload never materializes in memory. It is attached only when
 * the request actually frames one (`Content-Length` or `Transfer-Encoding`, per
 * RFC 9112 Section 6), and only for methods where Fetch permits a body, so a
 * GET arrives with `body === null`.
 *
 * `Content-Length` is forwarded when the client sent one and is absent when it
 * did not, which is the ordinary shape of a chunked tus PATCH: the resulting
 * `Request` reports no content length rather than a fabricated one. It is also
 * absent on a method that carries no body here (GET, HEAD), where it would
 * describe content the handler has no way to read. The
 * HTTP/1.1 connection-management fields (`Connection`, `Keep-Alive`,
 * `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, RFC 9110 Section 7.6.1,
 * plus `Proxy-Connection` and every field the request's own `Connection`
 * header nominates) are dropped, because they describe a connection the
 * `Request` does not have and the body they frame has already been decoded by
 * the time a handler could read them. The same rule is what keeps a field
 * scoped to one hop from reaching a second one: a handler that forwards this
 * `Request` upstream with `fetch()` forwards its headers with it, and a field
 * an intermediary inserted for the hop it terminated would arrive at the
 * origin looking like something the client sent.
 *
 * `Request.signal` aborts when the client disconnects before completing the
 * request. It does NOT abort on an ordinary completed request, so a handler
 * whose work outlives the last inbound byte (durably recording an upload
 * offset, say) is not cancelled by its own success.
 *
 * A `Request` body is single-use, as the Fetch standard requires: a second read
 * throws where a second read of the raw `IncomingMessage` would have returned
 * nothing. The bridge does not guard that, because the only guard available is
 * to buffer the body, and buffering an upload of caller-chosen size is a memory
 * amplification primitive this package refuses everywhere else. Check
 * `request.bodyUsed` before reading, and note that `request.clone()` is not a
 * way around it either: cloning tees the stream, and a tee buffers whatever the
 * slower branch has not consumed.
 *
 * @throws TypeError when no absolute URL can be derived, which means a request
 * with no `Host` header, no {@link ToWebRequestOptions.origin}, and no local
 * socket address, or a `Host` value that is not a valid authority; and when the
 * request target's path is one the URL parser would rewrite (a leading `//`, a
 * dot segment, a backslash), which {@link nodeHandler} answers with 400.
 */
export function toWebRequest(req: IncomingMessage, options: ToWebRequestOptions = {}): Request {
    // Derived first: a request with no representable URL must fail before this
    // function has attached anything to `req`.
    const url = absoluteUrl(req, options.origin);
    const method = req.method ?? "GET";
    const framed = hasFramedBody(req, method);
    const headers = new Headers();
    const raw = req.headers;
    const nominated = connectionNominated(raw.connection);
    for (const name of Object.keys(raw)) {
        if (CONNECTION_HEADERS.has(name) || nominated.has(name)) continue;
        // A method whose body Fetch refuses to carry arrives with `body === null`,
        // so its framing goes with the body: a `Content-Length` on a `Request` with
        // nothing to read describes a message the handler was never given.
        if (!framed && name === "content-length") continue;
        const value = raw[name];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
        } else {
            headers.append(name, value);
        }
    }

    const controller = new AbortController();
    const external = options.signal;
    // Assigned below, read at `close`: the link to a signal that outlives the
    // request has to be taken down by the request that made it.
    let unlinkExternal: (() => void) | undefined;
    // `close` with `complete === false` is a premature disconnect. A completed
    // request also emits `close`, and aborting there would construct a
    // DOMException and notify every abort listener on the success path of every
    // request, so the flag is the whole guard.
    //
    // A message that is already destroyed and incomplete when it arrives here
    // has emitted its `close` before the listener existed: a client that sent
    // its headers and dropped while the server's queue was ahead of it. The
    // signal is aborted at conversion for that message, so every signal check
    // downstream refuses at zero cost instead of opening a handle and then
    // waiting out the read stall bound for bytes that are never coming.
    //
    // The unlink is anchored on the socket's `close` as well as the message's.
    // An answered request whose body was never read keeps its message open on
    // the socket until the socket itself goes, and a message that was never
    // fully parsed emits no `close` of its own on some Node versions; the
    // socket's `close` is the last event either way. The socket's fires first
    // when both do, with the message's a tick behind it, and an incomplete
    // message at either is a disconnect; whichever fires takes the other down
    // so the link comes off exactly once.
    const disconnected = () => new Error("partial-content: client disconnected");
    if (req.destroyed && !req.complete) controller.abort(disconnected());
    // Typed non-null, but a test double or an internally nulled message has none.
    const socket: Pick<Socket, "once" | "off"> | null | undefined = req.socket;
    const onGone = () => {
        if (!req.complete) controller.abort(disconnected());
        req.off("close", onGone);
        socket?.off("close", onGone);
        unlinkExternal?.();
    };
    req.once("close", onGone);
    socket?.once("close", onGone);
    if (external) {
        if (external.aborted) {
            controller.abort(external.reason);
        } else if (req.destroyed) {
            // A message that already ended emitted its only `close` before the listeners
            // above were attached, so `onGone` will never run for it and a listener added
            // here would never come off: one retained per such request, each pinning the
            // message it closed over, until the process-lifetime signal fires. There is
            // nothing to link anyway, since the body stream refuses a destroyed message at
            // its first pull. The one-tick window where `close` is merely pending is
            // unaffected: `destroyed` is not yet set there and those listeners do fire.
        } else {
            // One listener per request on a signal that lives as long as the
            // process, so it is unlinked rather than left to be removed by firing:
            // a listener only `{ once: true }` can take down is retained for every
            // request the server ever answers, each one pinning that request's
            // controller. `close` is where it comes off, because `close` is the last
            // event the request message produces and every accepted request emits
            // one, body read or not, which bounds the listeners on the signal by the
            // requests in flight. That bound is also the reach of the link:
            // shutdown unwinds an append that is still reading its body, and no
            // longer reaches the step that records what was already written, which
            // is the half a graceful shutdown wants to let finish.
            const onExternalAbort = () => controller.abort(external.reason);
            external.addEventListener("abort", onExternalAbort, { once: true });
            unlinkExternal = () => external.removeEventListener("abort", onExternalAbort);
        }
    }

    const init: StreamingRequestInit = { method, headers, signal: controller.signal };
    if (framed) {
        const offersContinue = raw.expect !== undefined && EXPECT_100_CONTINUE.test(raw.expect);
        init.body = requestBodyStream(
            req,
            options.readStallTimeoutMs ?? DEFAULT_READ_STALL_MS,
            offersContinue ? options.onExpectContinue : undefined,
        );
        // Required by the Fetch standard for a stream body: the request body is
        // still being sent while the response is being received.
        init.duplex = "half";
    }
    return new Request(url, init);
}

export interface SendResponseOptions {
    /**
     * Max milliseconds to wait for a single backpressure `drain` while streaming
     * the response before treating the client as stalled and tearing the
     * transfer down. Identical in meaning and default to
     * {@link NodeServeOptions.writeStallTimeoutMs}.
     *
     * @default 60000
     */
    writeStallTimeoutMs?: number;
}

/**
 * Write a Fetch `Response` to a Node `ServerResponse`.
 *
 * Stream bodies stream, with backpressure and the same stall bound the read
 * path uses, so a download built by a Fetch handler is not buffered on its way
 * out. `Set-Cookie` is written as the repeated field it is rather than the
 * comma-joined single value `Headers` iteration produces, since a comma is
 * legal inside a cookie's `Expires` date and joining is lossy.
 *
 * Never rejects. A client that disconnects mid-response ends the transfer and
 * releases the body; a failure after the headers are on the wire destroys the
 * socket, because no error response is possible at that point and a truncated
 * transfer is the only signal left. Reading `response` falls under the same
 * guarantee: this primitive is exported and the package is consumable from
 * plain JavaScript, where the parameter type never runs, so a value that is
 * not a `Response` reaches that same torn-down socket instead of escaping as
 * a rejection.
 */
export async function sendResponse(
    res: ServerResponse,
    response: Response,
    options: SendResponseOptions = {},
): Promise<void> {
    // Declared out here so the failure path can release a body that was read
    // before a later step threw; every read of `response` happens inside the try.
    let body: ReadableStream<Uint8Array<ArrayBufferLike>> | null = null;
    try {
        body = response.body;
        res.writeHead(response.status, response.statusText || undefined, toOutgoingHeaders(response.headers));
        await writeBody(res, body, options.writeStallTimeoutMs ?? DEFAULT_WRITE_STALL_MS);
    } catch {
        // The response could not be written: writeHead or a bodyless end() threw
        // synchronously (socket already destroyed, a header value the runtime
        // rejects), or `response` is not a `Response` at all. Release the
        // unconsumed body so its source is not pinned, then tear the connection
        // down.
        if (body) {
            await body.cancel().catch(() => {
                // Already locked or errored; cancel is best-effort
            });
        }
        if (!res.destroyed) res.destroy();
    }
}

export interface NodeHandlerOptions extends ToWebRequestOptions, SendResponseOptions {
    /**
     * Send `100 Continue` when the handler starts reading a body the client
     * offered with `Expect: 100-continue`.
     *
     * Leave this off for a handler wired to the server's `request` event: Node
     * has already sent the continue by the time that listener runs, and a second
     * one is a duplicate interim response. Turn it on only for a handler wired to
     * `checkContinue`, where Node deliberately sends nothing and the decision is
     * the consumer's.
     *
     * @default false
     */
    answerExpectContinue?: boolean;

    /**
     * Reports a request the bridge answered on the handler's behalf: a request
     * with no derivable URL (400), and a handler that threw or returned
     * something other than a `Response` (500). The response
     * body stays generic, so this callback is the only place the cause is
     * visible.
     */
    onError?: (error: unknown) => void;
}

/**
 * Adapt a Fetch handler to Node's `(req, res)` signature.
 *
 * Convenience over {@link toWebRequest} and {@link sendResponse} for the case
 * where one Fetch handler owns a whole route. Compose the two primitives
 * directly when the route needs anything in between, which a dialect endpoint
 * generally does: resolving an upload token out of the path, checking a
 * session, choosing between the tus and the draft handler.
 *
 * The returned function never rejects, so `server.on("request", handler)` and
 * an Express 4 route both stay safe: a handler that throws, or that returns
 * anything other than a `Response`, becomes a 500 and is reported through
 * {@link NodeHandlerOptions.onError} rather than escaping as an unhandled
 * rejection.
 *
 * @example tus over a raw Node server
 * ```typescript
 * import { createServer } from "node:http";
 * import { nodeHandler } from "partial-content/node";
 * import { createTusHandler } from "partial-content/tus";
 * import { fsUploadStore } from "partial-content/fs";
 *
 * const tus = createTusHandler(fsUploadStore({ root: "./uploads" }), {
 *   key: () => crypto.randomUUID(),
 *   location: (token) => `/uploads/${token}`,
 *   resolveToken: (req) => new URL(req.url).pathname.split("/")[2] || undefined,
 *   policy: { maxSize: 5 * 1024 ** 3 },
 * });
 *
 * // The origin is configured, so the scheme and authority a handler reads off
 * // `request.url` are the deployment's rather than the ones the client sent.
 * createServer(
 *   nodeHandler((req) => tus(req), { origin: "https://files.example.com" }),
 * ).listen(3000);
 * ```
 */
export function nodeHandler(
    handler: (request: Request) => Response | Promise<Response>,
    options: NodeHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async function handleNodeFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // The two failures are answered separately because they are different
        // answers: a request the bridge cannot represent (no derivable URL, a
        // header value the Fetch layer rejects) is the client's, and a handler that
        // threw is ours.
        let request: Request;
        try {
            request = toWebRequest(req, {
                ...options,
                onExpectContinue: options.answerExpectContinue ? () => res.writeContinue() : options.onExpectContinue,
            });
        } catch (err) {
            options.onError?.(err);
            sendPlainError(res, 400, "Bad Request");
            return;
        }

        let response: Response;
        try {
            response = await handler(request);
        } catch (err) {
            // Consumer code threw. Answered here so nothing escapes as an unhandled
            // rejection (which kills Express 4 processes); the body stays generic and
            // the cause goes to the consumer's telemetry.
            options.onError?.(err);
            sendPlainError(res, 500, "Internal Server Error");
            return;
        }

        // A handler that returned nothing (a missing `return` on one branch) or
        // returned a plain object is the same consumer failure as one that threw,
        // and it reaches here because the parameter type does not run for a plain
        // JavaScript consumer. The check is on the shape rather than
        // `instanceof Response`, so a `Response` constructed in another realm
        // (a handler composed across a worker or vm boundary) is still answered
        // with the handler's own response instead of a spurious 500.
        if (typeof response?.status !== "number") {
            options.onError?.(new TypeError("partial-content: the Fetch handler did not return a Response"));
            sendPlainError(res, 500, "Internal Server Error");
            return;
        }
        await sendResponse(res, response, options);
    };
}

// ─── Bridge internals ───────────────────────────────────────────────────────

/**
 * The field names a `Connection` header declares connection-scoped.
 *
 * RFC 9110 Section 7.6.1 lets a sender nominate any field for the current hop
 * by listing its name there, so the connection-scoped set is per-message and
 * cannot be a constant. `close` and `keep-alive` are connection options rather
 * than field names, so they nominate nothing.
 */
function connectionNominated(value: string | string[] | undefined): Set<string> {
    const names = new Set<string>();
    if (value === undefined) return names;
    for (const entry of Array.isArray(value) ? value : [value]) {
        for (const token of entry.split(",")) {
            const name = token.trim().toLowerCase();
            if (name === "" || name === "close" || name === "keep-alive") continue;
            names.add(name);
        }
    }
    return names;
}

/**
 * Where the path begins in the request target, refusing a path the URL parser
 * would rewrite: the path a handler routes on is the one the client sent. A
 * leading "//" reads as an authority (RFC 3986 Section 3.3), a dot segment,
 * literal or percent-encoded, is removed (Section 5.2.4), and a backslash is
 * read as "/"; what survives resolves to itself. A target in none of the
 * request-target forms (RFC 9112 Section 3.2) is refused too.
 */
function pathStart(target: string): number {
    const at = target[0] === "/" || target === "*" ? 0 : (/^[a-z][\w+.-]*:\/\/[^/?#]*/i.exec(target)?.[0].length ?? -1);
    if (at < 0 || /^\/\/|\\|\/(\.|%2e){1,2}(\/|$)/i.test(target.slice(at).split(/[?#]/)[0]!)) {
        throw new TypeError("partial-content: the request target's path is not in normal form (RFC 9110 Section 7.1)");
    }
    return at;
}

/** Resolve the request target against the effective origin. */
function absoluteUrl(req: IncomingMessage, origin: string | undefined): string {
    const target = req.url ?? "/";
    const at = pathStart(target);
    if (origin !== undefined) {
        // A configured origin is the authority for scheme and host, so only the
        // path and query survive from the target. Resolving the target directly
        // would let an absolute-form target (RFC 9112 Section 3.2.2) replace both.
        return new URL(at ? target.slice(at) || "/" : target, origin).href;
    }

    // TLS terminated in this process means the socket carries `encrypted`; a
    // plaintext socket does not have the property at all.
    const socket = req.socket;
    const scheme = "encrypted" in socket && socket.encrypted === true ? "https" : "http";
    // With no configured origin the authority is the one the client addressed,
    // which is what a server answering on several names has to honour. A
    // deployment that publishes one authority names it in `origin`, and that is
    // the only thing that stops a client-chosen `Host` from reaching an absolute
    // URL a handler builds from `request.url`.
    const authority = req.headers.host ?? localAuthority(req);
    if (authority === undefined) {
        throw new TypeError(
            "partial-content: cannot derive an absolute URL for this request " +
                "(no Host header, no `origin` option, and no local socket address)",
        );
    }
    return new URL(target, `${scheme}://${authority}`).href;
}

/** The address this server is listening on, as a URL authority. */
function localAuthority(req: IncomingMessage): string | undefined {
    const address = req.socket.localAddress;
    const port = req.socket.localPort;
    if (address === undefined || port === undefined) return undefined;
    return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * Whether the request frames a body Fetch is willing to carry.
 *
 * RFC 9112 Section 6: a request has content exactly when it sends
 * `Transfer-Encoding` or `Content-Length`. Fetch forbids a body on GET and
 * HEAD regardless, and `new Request` throws rather than dropping one.
 */
function hasFramedBody(req: IncomingMessage, method: string): boolean {
    if (method === "GET" || method === "HEAD") return false;
    return req.headers["transfer-encoding"] !== undefined || req.headers["content-length"] !== undefined;
}

/**
 * Adapt the request stream to a `ReadableStream`, lazily.
 *
 * Nothing is attached to `req` until the body is first READ. That is what makes
 * an unread body free: a handler that answers without reading leaves the
 * request paused, and the HTTP server discards it when the response finishes,
 * exactly as it does for a handler that never touched `req`. Attaching a `data`
 * listener up front would instead feed every byte into a queue nobody drains,
 * which is an unbounded buffer keyed on how much the client chooses to send.
 *
 * A high-water mark of zero is what makes "first read" the trigger: a stream
 * whose queue already wants a chunk is pulled as soon as it is constructed, so
 * any non-zero mark would attach at `toWebRequest` time instead. Zero also
 * means each `pull` corresponds to a reader that is waiting, so resuming the
 * socket there applies the reader's backpressure directly to the connection.
 */
function requestBodyStream(
    req: IncomingMessage,
    stallMs: number,
    onExpectContinue: (() => void) | undefined,
): ReadableStream<Uint8Array> {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearStall = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    const armStall = () => {
        clearStall();
        if (stallMs <= 0 || settled) return;
        timer = setTimeout(() => {
            timer = undefined;
            const stalled = new Error("partial-content: request body read stalled");
            // Destroy first, so the disconnect listener runs and any in-flight append
            // unwinds through the path it already has. A stalled body never ended, so
            // that listener's `readableEnded` test refuses it whatever `destroy()` does
            // to `complete`, which is a runtime detail this side does not depend on.
            req.destroy(stalled);
            fail(stalled);
        }, stallMs);
        // Do not keep the event loop alive solely for this timer.
        timer.unref?.();
    };
    // Every exit clears the timer unconditionally, including the one where the
    // request is complete but unread: a body whose bytes were all parsed still
    // emits no `end` while the reader has stopped pulling, and a timer surviving
    // its own request holds `req.destroy()` over a keep-alive socket that by then
    // carries somebody else's request.
    const fail = (err: Error) => {
        clearStall();
        if (settled) return;
        settled = true;
        controller?.error(err);
    };

    const onData = (chunk: Buffer) => {
        clearStall();
        if (settled) return;
        // Buffer IS a Uint8Array; enqueue it as delivered rather than copying.
        controller?.enqueue(chunk);
        if ((controller?.desiredSize ?? 1) <= 0) req.pause();
    };
    const onEnd = () => {
        clearStall();
        if (settled) return;
        settled = true;
        controller?.close();
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => {
        clearStall();
        // A body that was delivered settles through `end`; reaching close first means the
        // client went away before this side read it. `complete` describes the PARSER, and a
        // message can be complete with its bytes still buffered and undelivered, so the
        // question to ask is whether the readable ended, not whether parsing finished.
        if (!req.readableEnded) fail(new Error("partial-content: client disconnected mid-body"));
    };

    return new ReadableStream<Uint8Array>(
        {
            pull(streamController) {
                controller = streamController;
                if (!started) {
                    started = true;
                    // A message whose socket closed before the first pull has
                    // already emitted the `close` the listeners below would have
                    // caught: attaching now waits out the stall bound (or forever
                    // at 0) for bytes that are never coming. The terminal state is
                    // read before attaching, and nothing runs between the read
                    // and the attach for a close to slip through.
                    // A destroyed readable delivers nothing whether or not the parser
                    // finished: buffered bytes on a message destroyed before this side
                    // read them are gone with it, so `complete` must not narrow this.
                    if (req.destroyed) {
                        fail(new Error("partial-content: client disconnected before the body was read"));
                        return;
                    }
                    onExpectContinue?.();
                    req.on("data", onData);
                    req.once("end", onEnd);
                    req.once("error", onError);
                    req.once("close", onClose);
                }
                req.resume();
                // Armed per pull, after the socket is flowing again: the bound then spans
                // exactly the interval where this side is asking and the sender is not
                // delivering. Arming on arrival instead would time a consumer that has
                // not asked for the next chunk yet, and kill a healthy upload whose store
                // is slow between appends.
                armStall();
            },
            cancel() {
                settled = true;
                clearStall();
                req.off("data", onData);
                req.off("end", onEnd);
                req.off("error", onError);
                req.off("close", onClose);
                discardRequestBody(req);
            },
        },
        { highWaterMark: 0 },
    );
}

/**
 * Release a request body the handler stopped reading, keeping the connection.
 *
 * Cancelling the stream must not destroy the request. `req.destroy()` on an
 * `IncomingMessage` whose body is not fully read destroys the SOCKET, and a
 * cancel happens while the handler is still running, so the response it is
 * about to write is lost: a client whose chunk exceeded a size policy sees a
 * reset instead of the 413 that explains it, and cannot tell a server refusal
 * from a network fault. Draining the remaining bytes and discarding them leaves
 * the response writable and the connection reusable.
 *
 * Discarding costs no memory, and how long a sender may go on delivering a body
 * nobody reads is the server's own `requestTimeout` to bound (RFC 9110 does not
 * give the message a length limit of its own). A byte ceiling enforced here
 * instead would destroy the connection on the bodies most likely to be refused,
 * taking with it the response this function exists to keep.
 */
function discardRequestBody(req: IncomingMessage): void {
    if (req.readableEnded || req.destroyed) return;
    // Flowing with no `data` listener attached is what discards: the listeners
    // this body had were removed before this call.
    req.resume();
}

/** Flatten `Headers` for `writeHead`, keeping `Set-Cookie` a repeated field. */
function toOutgoingHeaders(headers: Headers): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of headers) {
        if (name === "set-cookie") continue;
        out[name] = value;
    }
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) out["set-cookie"] = cookies;
    return out;
}

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
    res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(body.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'",
    });
    res.end(body);
}
