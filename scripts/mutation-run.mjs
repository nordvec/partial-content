/**
 * Single-module mutation run: `bun run test:mutation -- --mutate src/kernel.ts`.
 *
 * A passthrough to `stryker run` that also owns sandbox hygiene, so an
 * interrupted run cannot leave a copy of the package behind for `bun test` to
 * find (see mutation-sandbox.mjs). Every argument after the script name is
 * forwarded to Stryker unchanged.
 */
import { clearSandboxes, guardSandboxes, runStryker } from "./mutation-sandbox.mjs";

guardSandboxes();
const run = runStryker(process.argv.slice(2));
clearSandboxes();
process.exit(run.status ?? 1);
