/**
 * Single-module mutation run: `bun run test:mutation -- --mutate src/kernel.ts`.
 *
 * A passthrough to `stryker run` that also owns sandbox hygiene, so an
 * interrupted run cannot leave a copy of the package behind for `bun test` to
 * find (see mutation-sandbox.mjs). Every argument after the script name is
 * forwarded to Stryker unchanged.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pkgDir, clearSandboxes, guardSandboxes } from "./mutation-sandbox.mjs";

const require = createRequire(import.meta.url);
const strykerPkgJson = require.resolve("@stryker-mutator/core/package.json");
const strykerPkg = require("@stryker-mutator/core/package.json");
const binRel = typeof strykerPkg.bin === "string" ? strykerPkg.bin : strykerPkg.bin.stryker;
const strykerBin = path.resolve(path.dirname(strykerPkgJson), binRel);

guardSandboxes();
const run = spawnSync(process.execPath, [strykerBin, "run", ...process.argv.slice(2)], {
  cwd: pkgDir,
  stdio: "inherit",
});
clearSandboxes();
process.exit(run.status ?? 1);
