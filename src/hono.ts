/**
 * Hono middleware adapter for partial-content.
 *
 * Wraps an {@link ObjectStore} into a Hono-compatible middleware that handles
 * the full HTTP file-serving protocol (200, 206, 304, 412, 416, HEAD).
 *
 * @example
 * ```typescript
 * import { Hono } from "hono";
 * import { serveObject } from "partial-content/hono";
 * import { s3Store } from "partial-content/s3";
 *
 * const store = s3Store({ client, bucket: "documents" });
 * const app = new Hono();
 *
 * app.get("/files/:key", serveObject(store, {
 *   key: (c) => c.req.param("key"),
 *   disposition: "inline",
 * }));
 * ```
 *
 * @packageDocumentation
 */

import { serveObject as serveObjectWeb, type ServeObjectOptions, type ServeContext } from "./web.ts";
import type { ObjectStore } from "./index.ts";

// Re-export for convenience
export type { ServeObjectOptions, ServeContext } from "./web.ts";
export type { ObjectStore } from "./index.ts";

// ─── Hono Types ─────────────────────────────────────────────────────────────

/**
 * Minimal Hono context interface.
 *
 * We declare just enough of the Hono Context shape to avoid a hard
 * dependency on the `hono` package. Users who import `partial-content/hono`
 * will have `hono` installed (it's an optional peer dep), but we don't
 * want to force TypeScript resolution on it at build time for the
 * published package.
 */
interface HonoContext {
  req: {
    raw: Request;
    param: (name: string) => string;
    header: (name: string) => string | undefined;
    method: string;
  };
}

/** Hono handler return type. */
type HonoResponse = Response | Promise<Response>;

// ─── Options ────────────────────────────────────────────────────────────────

export interface HonoServeOptions extends ServeObjectOptions {
  /**
   * Extract the storage key from the Hono context.
   *
   * @example
   * ```ts
   * key: (c) => c.req.param("key")
   * key: (c) => c.req.param("path")
   * ```
   */
  key: (c: HonoContext) => string | Promise<string>;

  /**
   * Extract the MIME type from the Hono context.
   * When omitted, defaults to "application/octet-stream".
   */
  mime?: (c: HonoContext) => string | undefined;

  /**
   * Extract the filename from the Hono context (for Content-Disposition).
   * When omitted, no filename is set.
   */
  filename?: (c: HonoContext) => string | undefined;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Hono middleware handler that serves files from an {@link ObjectStore}.
 *
 * Uses the standard Request/Response API under the hood, so it works on
 * all Hono runtimes (Cloudflare Workers, Bun, Deno, Node.js).
 *
 * @example
 * ```typescript
 * import { Hono } from "hono";
 * import { serveObject } from "partial-content/hono";
 * import { s3Store } from "partial-content/s3";
 *
 * const app = new Hono();
 * const store = s3Store({ client, bucket: "media" });
 *
 * app.get("/media/:key", serveObject(store, {
 *   key: (c) => c.req.param("key"),
 *   disposition: "inline",
 *   cacheControl: "public, max-age=31536000, immutable",
 * }));
 * ```
 */
export function serveObject(
  store: ObjectStore,
  opts: HonoServeOptions,
): (c: HonoContext) => HonoResponse {
  const { key: keyFn, mime: mimeFn, filename: filenameFn, ...serveOpts } = opts;
  const handler = serveObjectWeb(store, serveOpts);

  return async function honoHandler(c: HonoContext): Promise<Response> {
    const key = await keyFn(c);
    const ctx: ServeContext = {
      key,
      mime: mimeFn?.(c),
      filename: filenameFn?.(c),
    };

    return handler(c.req.raw, ctx);
  };
}
