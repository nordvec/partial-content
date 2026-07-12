/**
 * Node.js HTTP adapter for partial-content.
 *
 * Bridges the gap between Node.js `IncomingMessage`/`ServerResponse` and the
 * Fetch-based `partial-content/web` handler. Works with Express, Fastify
 * (in compatibility mode), Koa, raw `http.createServer`, and any Node.js
 * HTTP framework that exposes the standard request/response objects.
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
 *   key: (req) => new URL(req.url!, `http://${req.headers.host}`).pathname.slice(1),
 * });
 *
 * createServer((req, res) => handler(req, res)).listen(3000);
 * ```
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { serveObjectRaw, type RawResponseParts, type ServeObjectOptions, type ServeContext } from "./web.ts";
import type { ObjectStore } from "./index.ts";

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

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Node.js request handler that serves files from an {@link ObjectStore}.
 *
 * Converts Node.js `IncomingMessage` to a Fetch `Request`, delegates to the
 * web adapter's `serveObject`, then writes the Fetch `Response` back to the
 * Node.js `ServerResponse`.
 */
export function serveObject<Req extends IncomingMessage = IncomingMessage>(
  store: ObjectStore,
  opts: NodeServeOptions<Req>,
) {
  const { key: keyFn, mime: mimeFn, filename: filenameFn, writeStallTimeoutMs, ...serveOpts } = opts;
  const handler = serveObjectRaw(store, serveOpts);
  const stallMs = writeStallTimeoutMs ?? DEFAULT_WRITE_STALL_MS;

  return async function handleNodeServe(
    req: Req,
    res: ServerResponse,
  ): Promise<void> {
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
      };
      parts = await handler(fetchRequest, ctx);
    } catch (err) {
      // A throwing extractor is consumer code failing: surface it to the
      // consumer's telemetry (the response body stays generic), with the
      // same error-hygiene headers every other error response carries.
      serveOpts.onError?.(err, { key: "", operation: "context" });
      if (!res.headersSent) {
        const body = "Internal Server Error";
        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(body.length),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
        });
        res.end(body);
      } else if (!res.destroyed) {
        res.destroy();
      }
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

      if (!parts.body) {
        res.end();
        return;
      }

      // Byte bodies (in-memory stores, fs small-transfer fast path, error
      // pages): a single write, no reader machinery.
      if (parts.body instanceof Uint8Array) {
        res.end(parts.body);
        return;
      }

      // Stream the response body with backpressure. Client disconnects abort
      // the storage stream (via the signal above), which rejects reader.read();
      // that rejection must be contained here, not escape the handler.
      const reader = parts.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) {
            // Client is gone; stop pulling and release the storage stream.
            await reader.cancel();
            break;
          }
          const canContinue = res.write(value);
          if (!canContinue) {
            // Backpressure: wait for drain, or for the response to close
            // (client disconnect) so a stalled socket cannot hang this loop.
            // A stall timeout bounds a reader that stops consuming but holds
            // the socket open: it rejects into the catch below, which cancels
            // the storage reader and destroys the response.
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
        // Transfer failed mid-stream (disconnect or storage error). Headers are
        // already sent, so no error response is possible; tear the socket down
        // so the client sees a truncated transfer instead of a hang.
        await reader.cancel().catch(() => {
          // Stream may already be errored; cancel is best-effort
        });
        if (!res.destroyed) res.destroy();
      } finally {
        reader.releaseLock();
      }
    } catch {
      // writeHead/end threw synchronously. The pump above never rethrows, so
      // this only catches pre-stream failures: release an unconsumed stream
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
