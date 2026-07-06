/**
 * Benchmark: partial-content vs send vs sirv, serving identical files over
 * real HTTP (Node http.createServer, loopback).
 *
 * Run:  node bench/run.mjs        (build dist first: bun run build)
 *
 * Methodology
 * - Same fixtures for every server: 4 KB and 1 MB random binary files.
 * - partial-content serves through its shipped dist (node adapter + fsStore),
 *   i.e. exactly what npm consumers run, including conditional evaluation,
 *   ETag generation, and disposition handling on every request.
 * - send and sirv run with defaults plus ETags enabled.
 * - Every scenario is correctness-verified (status + byte count) before timing.
 * - autocannon: 40 connections, 5 s per scenario, one warmup second discarded
 *   by taking autocannon's steady-state aggregates. The client runs in a
 *   separate process so its own parse cost never throttles the server column.
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import send from "send";
import sirv from "sirv";
import { serveObject } from "../dist/node.js";
import { fsStore } from "../dist/fs.js";

const DURATION = 5;
const CONNECTIONS = 40;

const root = await mkdtemp(join(tmpdir(), "pc-bench-"));
await writeFile(join(root, "small.bin"), randomBytes(4 * 1024));
await writeFile(join(root, "large.bin"), randomBytes(1024 * 1024));

// Manual path parse: `new URL()` costs over a microsecond per call, which at
// 10k req/s benches the harness callback instead of the library. send and
// sirv parse paths with equivalent hand-rolled parsers internally (parseurl,
// @polka/url), so this keeps the key-extraction cost comparable across
// columns. Fixture names contain no percent-encoding.
function keyOf(req) {
  const url = req.url;
  const q = url.indexOf("?");
  return q === -1 ? url.slice(1) : url.slice(1, q);
}

const servers = {
  "partial-content": createServer((req, res) => {
    void pcHandler(req, res);
  }),
  // Opt-in hot-object cache (nginx open_file_cache semantics, 1 s TTL):
  // the apples-to-apples row for sirv, which also serves cached metadata.
  "partial-content (cache)": createServer((req, res) => {
    void pcCachedHandler(req, res);
  }),
  "send": createServer((req, res) => {
    send(req, keyOf(req), { root }).pipe(res);
  }),
  "sirv": createServer(sirv(root, { etag: true, maxAge: 0, dev: false })),
};
const pcHandler = serveObject(fsStore({ root }), {
  key: keyOf,
  mime: () => "application/octet-stream",
  disposition: "inline",
});
const pcCachedHandler = serveObject(fsStore({ root, cache: { ttlMs: 1000 } }), {
  key: keyOf,
  mime: () => "application/octet-stream",
  disposition: "inline",
});

const ports = {};
for (const [name, srv] of Object.entries(servers)) {
  await new Promise((resolve) => srv.listen(0, resolve));
  ports[name] = srv.address().port;
}

// Raw client: fetch() auto-appends `Cache-Control: no-cache` to requests
// carrying conditional headers, and libraries that honor it (send does)
// would then never answer 304. autocannon sends clean headers, so
// verification must too.
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => resolve({ status: res.statusCode, bytes, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function etagFor(name, path) {
  const res = await rawGet(ports[name], path);
  return res.headers.etag;
}

// scenario -> { path, headers?, expectStatus, expectBytes }
const scenarios = {
  "GET 4 KB (200)": { path: "/small.bin", expectStatus: 200, expectBytes: 4096 },
  "GET 1 MB (200)": { path: "/large.bin", expectStatus: 200, expectBytes: 1024 * 1024 },
  "Range 64 KB of 1 MB (206)": {
    path: "/large.bin",
    headers: { Range: "bytes=0-65535" },
    expectStatus: 206,
    expectBytes: 65536,
  },
  "Revalidation (304)": {
    path: "/small.bin",
    headers: async (name) => ({ "If-None-Match": await etagFor(name, "/small.bin") }),
    expectStatus: 304,
    expectBytes: 0,
  },
};

async function verify(name, scenario) {
  const headers = typeof scenario.headers === "function"
    ? await scenario.headers(name)
    : scenario.headers ?? {};
  const res = await rawGet(ports[name], scenario.path, headers);
  if (res.status !== scenario.expectStatus || res.bytes !== scenario.expectBytes) {
    return `status=${res.status} bytes=${res.bytes} (expected ${scenario.expectStatus}/${scenario.expectBytes})`;
  }
  return null;
}

// The load generator runs in a SEPARATE process. In-process, autocannon's
// own HTTP parser dominates the profile (Buffer.toString on every response
// body -- 72% of process CPU on the 1 MB cell), throttling every server
// column equally and drowning real differences in client cost.
const autocannonBin = createRequire(import.meta.url).resolve("autocannon/autocannon.js");

function bench(name, scenario, headers) {
  const args = [
    autocannonBin,
    `http://127.0.0.1:${ports[name]}${scenario.path}`,
    "-c", String(CONNECTIONS),
    "-d", String(DURATION),
    "--json",
  ];
  for (const [k, v] of Object.entries(headers ?? {})) {
    args.push("-H", `${k}=${v}`);
  }
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(JSON.parse(stdout));
    });
  });
}

const rows = [];
for (const [scenarioName, scenario] of Object.entries(scenarios)) {
  const row = { scenario: scenarioName };
  for (const name of Object.keys(servers)) {
    const mismatch = await verify(name, scenario);
    if (mismatch) {
      row[name] = `unsupported (${mismatch})`;
      continue;
    }
    const headers = typeof scenario.headers === "function"
      ? await scenario.headers(name)
      : scenario.headers ?? {};
    const r = await bench(name, scenario, headers);
    row[name] = `${Math.round(r.requests.average).toLocaleString("en-US")} req/s (p99 ${r.latency.p99} ms)`;
  }
  rows.push(row);
  console.error(`done: ${scenarioName}`);
}

console.log(`\nNode ${process.version}, ${CONNECTIONS} connections, ${DURATION}s per cell, loopback\n`);
const names = Object.keys(servers);
console.log(`| Scenario | ${names.join(" | ")} |`);
console.log(`|---|${names.map(() => "---").join("|")}|`);
for (const row of rows) {
  console.log(`| ${row.scenario} | ${names.map((n) => row[n]).join(" | ")} |`);
}

// Footnote datum: sirv's 304 throughput comes from pre-rendering complete
// header sets for the directory at boot (files created afterwards 404).
// Measure sirv in the configuration that CAN serve runtime-created files
// (dev: true, per-request lookup) for the like-for-like comparison.
{
  const devSrv = createServer(sirv(root, { etag: true, maxAge: 0, dev: true }));
  await new Promise((resolve) => devSrv.listen(0, resolve));
  ports["sirv (dev)"] = devSrv.address().port;
  const scenario = scenarios["Revalidation (304)"];
  const mismatch = await verify("sirv (dev)", scenario);
  if (mismatch) {
    console.log(`\nsirv dev-mode (runtime-file-capable) 304: unsupported (${mismatch})`);
  } else {
    const headers = await scenario.headers("sirv (dev)");
    const r = await bench("sirv (dev)", scenario, headers);
    console.log(`\nsirv dev-mode (runtime-file-capable) 304: ${Math.round(r.requests.average).toLocaleString("en-US")} req/s (p99 ${r.latency.p99} ms)`);
  }
  await new Promise((r) => devSrv.close(r));
}

for (const srv of Object.values(servers)) await new Promise((r) => srv.close(r));
await rm(root, { recursive: true, force: true });
