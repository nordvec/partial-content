/**
 * Bun variant of the profiling/bench server: the web adapter runs NATIVELY
 * on Bun.serve (Request/Response are Bun's own primitives -- no node bridge,
 * no conversion layer). Compare against the Node numbers in bench/run.mjs.
 *
 * Run:  bun bench/bun-server.ts        then drive with autocannon.
 */
import { serveObject } from "../src/web.ts";
import { fsStore } from "../src/fs.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "pc-bun-"));
writeFileSync(join(root, "small.bin"), randomBytes(4 * 1024));

const handler = serveObject(fsStore({ root }), { disposition: "inline" });
Bun.serve({
  port: 18778,
  fetch: (req) => handler(req, { key: "small.bin", mime: "application/octet-stream" }),
});
const cachedHandler = serveObject(fsStore({ root, cache: { ttlMs: 1000 } }), { disposition: "inline" });
Bun.serve({
  port: 18779,
  fetch: (req) => cachedHandler(req, { key: "small.bin", mime: "application/octet-stream" }),
});
console.log("bun ready on :18778 (plain) and :18779 (cache)");
setTimeout(() => process.exit(0), 30_000);
