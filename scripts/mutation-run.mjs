/**
 * Single-module mutation run: `bun run test:mutation -- --mutate src/kernel.ts`.
 *
 * A passthrough to `stryker run` that also owns sandbox hygiene, so an
 * interrupted run cannot leave a copy of the package behind for `bun test` to
 * find (see mutation-sandbox.mjs). Every argument after the script name is
 * forwarded to Stryker unchanged, except a worker count: lower it with
 * `STRYKER_CONCURRENCY=<n>`, since a command-line count would beat the bound
 * the machine's suite slot sets.
 */
import { clearSandboxes, concurrencyFlag, guardSandboxes, runStryker } from "./mutation-sandbox.mjs";

const args = process.argv.slice(2);
const flag = concurrencyFlag(args);
if (flag !== null) {
    console.error(`${flag}: lower the worker count with STRYKER_CONCURRENCY=<n> instead.`);
    process.exit(2);
}
guardSandboxes();
const run = runStryker(args);
clearSandboxes();
process.exit(run.status ?? 1);
