// Profiling target: our stack serving a 4 KB file. Run under --cpu-prof,
// driven externally by autocannon, stopped with SIGTERM so the profile flushes.
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { serveObject } from "../dist/node.js";
import { fsStore } from "../dist/fs.js";

const root = await mkdtemp(join(tmpdir(), "pc-prof-"));
await writeFile(join(root, "small.bin"), randomBytes(4 * 1024));

const handler = serveObject(fsStore({ root }), {
  key: () => "small.bin",
  mime: () => "application/octet-stream",
  disposition: "inline",
});
const server = createServer((req, res) => { void handler(req, res); });
await new Promise((r) => server.listen(18777, r));
console.log("ready");

// Self-terminate gracefully so --cpu-prof flushes (Windows has no SIGTERM).
setTimeout(() => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}, 12_000);
