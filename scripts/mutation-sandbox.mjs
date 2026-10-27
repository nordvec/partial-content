/**
 * Sandbox hygiene shared by both mutation entry points.
 *
 * A Stryker sandbox is a whole copy of the package, tests included. Left in
 * the tree it is discovered by `bun test` as part of the suite, so the next
 * plain test run executes the sandbox's tests against MUTATED source and the
 * failures read exactly like a regression in whatever you were working on.
 * Stryker clears the directory on a normal exit; an interrupted run (Ctrl-C, a
 * killed CI step) does not, which is precisely the run most likely to be
 * interrupted.
 *
 * Both `test:mutation` and `test:mutation:ci` route through here, so neither
 * path depends on anyone remembering to delete it afterwards.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A mutation run loads the CPU as a test suite does. Inside the development
 * monorepo each Stryker run therefore waits for the machine's suite slot,
 * whose holder is a Bun script there; the standalone repository has no such
 * file and runs Stryker directly. The path is probed rather than imported so
 * this package never depends on the monorepo existing.
 */
const SUITE_SLOT = path.resolve(pkgDir, "../../scripts/setup/with-suite-slot.ts");
const underBun = process.versions.bun !== undefined;

const require = createRequire(import.meta.url);

/**
 * The Stryker CLI, resolved from its own package.json `bin` field (robust
 * across hoisting and platforms; avoids a PATH-dependent `stryker` shim).
 */
function strykerBin() {
    const pkgJson = require.resolve("@stryker-mutator/core/package.json");
    const pkg = require("@stryker-mutator/core/package.json");
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.stryker;
    return path.resolve(path.dirname(pkgJson), binRel);
}

/**
 * `stryker run <args>` in the package; the spawn result. Stryker always runs
 * under Node. The slot holder needs Bun, so the package scripts start the
 * driver with `bun` and `process.execPath` is then the Bun binary itself (a
 * bare `bun` is not spawnable without a shell on every Windows install).
 */
export function runStryker(args, env = process.env) {
    const stryker = [underBun ? "node" : process.execPath, strykerBin(), "run", ...args];
    const [command, ...rest] = existsSync(SUITE_SLOT)
        ? [process.execPath, SUITE_SLOT, "mutation", "--", ...stryker]
        : stryker;
    return spawnSync(command, rest, { cwd: pkgDir, stdio: "inherit", env });
}

const TEMP_DIR = ".stryker-tmp";
const tempPath = () => path.join(pkgDir, TEMP_DIR);

/**
 * Remove every staged sandbox. Returns the error when the directory survives,
 * `null` otherwise; a missing directory is success. Retries briefly because a
 * just-exited runner can still hold a handle on Windows for a few ms.
 */
export function clearSandboxes() {
    try {
        // oxlint-disable-next-line nordvec/no-restricted-syntax -- tempPath() is the package's own fixed sandbox directory, never a caller's variable.
        rmSync(tempPath(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return null;
    } catch (err) {
        return err;
    }
}

/**
 * Clear on the way in, and again on the signals that skip Stryker's own
 * teardown. Call before spawning Stryker.
 *
 * A sandbox that cannot be removed almost always means another mutation run
 * holds it, and two runs sharing one temp directory corrupt each other's
 * results. Refuse with that sentence rather than an EPERM stack from inside a
 * cleanup helper, which says nothing about what to do next.
 */
export function guardSandboxes() {
    if (existsSync(SUITE_SLOT) && !underBun) {
        console.error(
            "Inside the monorepo the suite slot is held by a Bun script: start the run with " +
                "`bun run test:mutation` or `bun run test:mutation:ci`.",
        );
        process.exit(2);
    }
    const err = clearSandboxes();
    if (err) {
        console.error(
            `Cannot clear ${TEMP_DIR}/: ${err.message}\n` +
                "Another mutation run is probably still using it. Wait for it to finish, " +
                "or stop it and delete the directory, then start again.",
        );
        process.exit(2);
    }
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
            // Best-effort on the way out: the signal already decided the outcome, so
            // a failure to clean must not replace it with a different error.
            clearSandboxes();
            process.exit(130);
        });
    }
}
