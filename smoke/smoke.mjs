/**
 * Cross-runtime smoke test for the BUILT package (dist/).
 *
 * The suite runs on Bun (`bun test`), but the package advertises Node, Deno,
 * and Workers support. This script exercises the shipped ESM artifact through
 * the public subpath exports with only web-standard + `node:assert` APIs, so the
 * SAME file runs unmodified under `node` and `deno` in CI. It deliberately
 * avoids the Node-`Readable` path (the one place Buffer is touched) by driving
 * the in-memory store, whose bodies are `Uint8Array`, through the Fetch adapter.
 *
 * Run: `node smoke/smoke.mjs` or `deno run --allow-read smoke/smoke.mjs`
 * (build dist/ first: `bun run build` / `tsc`).
 */
import assert from "node:assert/strict";

import {
  buildContentDisposition,
  parseRangeHeader,
  evaluateConditionalRequest,
  guardStreamLength,
  resolveServedRange,
} from "../dist/index.js";
import { memoryStore } from "../dist/memory.js";
import { serveObject } from "../dist/web.js";

const runtime =
  typeof globalThis.Deno !== "undefined" ? `Deno ${globalThis.Deno.version.deno}`
  : typeof globalThis.Bun !== "undefined" ? `Bun ${globalThis.Bun.version}`
  : `Node ${globalThis.process?.versions?.node ?? "?"}`;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log(`partial-content cross-runtime smoke (${runtime})`);

// ── Pure kernel functions ───────────────────────────────────────────────────
await check("buildContentDisposition escapes and encodes a non-ASCII filename", () => {
  const cd = buildContentDisposition("réport.pdf", { type: "attachment" });
  assert.match(cd, /^attachment/);
  assert.match(cd, /filename\*=UTF-8''/);
});

await check("parseRangeHeader parses a single byte range", () => {
  const parsed = parseRangeHeader("bytes=0-499", 10000);
  assert.ok(parsed && parsed !== "unsatisfiable", "expected a parsed range object");
  assert.equal(parsed.start, 0);
  assert.equal(parsed.end, 499);
});

await check("resolveServedRange maps the unknown-total sentinel to undefined", () => {
  assert.equal(resolveServedRange("bytes 0-9/100")?.totalSize, 100);
  assert.equal(resolveServedRange("bytes 0-9/*")?.totalSize, undefined);
  assert.equal(resolveServedRange("bytes garbage"), null);
});

await check("evaluateConditionalRequest short-circuits a matching If-None-Match to 304", () => {
  const result = evaluateConditionalRequest(
    new Headers({ "If-None-Match": '"v1"' }),
    { etag: '"v1"', totalSize: 10 },
  );
  assert.equal(result.status, 304);
});

// ── In-memory store through the Fetch (web) adapter ─────────────────────────
const store = memoryStore({ objects: { "hello.txt": { body: "hello world", etag: '"v1"' } } });
const handler = serveObject(store);
const ctx = { key: "hello.txt", mime: "text/plain", filename: "hello.txt" };

await check("full GET returns 200 with the whole body", async () => {
  const res = await handler(new Request("https://x/hello.txt"), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await res.text(), "hello world");
});

await check("ranged GET returns 206 with the exact slice and RFC bounds", async () => {
  const res = await handler(
    new Request("https://x/hello.txt", { headers: { Range: "bytes=0-4" } }),
    ctx,
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 0-4/11");
  assert.equal(await res.text(), "hello");
});

await check("unsatisfiable range returns 416", async () => {
  const res = await handler(
    new Request("https://x/hello.txt", { headers: { Range: "bytes=999-1999" } }),
    ctx,
  );
  assert.equal(res.status, 416);
});

await check("missing object returns 404", async () => {
  const res = await handler(new Request("https://x/nope.txt"), { ...ctx, key: "nope.txt" });
  assert.equal(res.status, 404);
});

// ── guardStreamLength on a web ReadableStream ───────────────────────────────
await check("guardStreamLength errors a stream that ends short of the committed length", async () => {
  const short = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const guarded = guardStreamLength(short, 10);
  await assert.rejects(async () => {
    const reader = guarded.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  }, /expected 10/);
});

await check("guardStreamLength propagates a consumer cancel to the source (backend teardown)", async () => {
  // The highest-risk cross-runtime divergence: cancelling the guard's readable
  // must propagate through the pipeThrough to cancel the source, or every client
  // disconnect during an S3/R2/Azure web-stream body leaks the backend socket.
  // Bun and Deno have both had TransformStream propagation bugs historically.
  let sourceCancelled = false;
  const source = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      controller.enqueue(new Uint8Array(64));
    },
    cancel() { sourceCancelled = true; },
  });
  const reader = guardStreamLength(source, 1_000_000).getReader();
  await reader.read();
  await reader.cancel("client gone");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sourceCancelled, true, "cancel did not reach the source: backend sockets would leak on disconnect");
});

await check("a streaming body survives the runtime's Response plumbing", async () => {
  // Byte bodies (memoryStore above) never cross the Response's stream path; a
  // real streamed body must round-trip through new Response(stream) intact.
  const src = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello world"));
      controller.close();
    },
  });
  const res = new Response(guardStreamLength(src, 11));
  assert.equal(await res.text(), "hello world");
});

console.log(`\n${passed} checks passed on ${runtime}`);
