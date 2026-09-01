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
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TEMP_DIR = ".stryker-tmp";
const tempPath = () => path.join(pkgDir, TEMP_DIR);

/**
 * Remove every staged sandbox. Returns the error when the directory survives,
 * `null` otherwise; a missing directory is success. Retries briefly because a
 * just-exited runner can still hold a handle on Windows for a few ms.
 */
export function clearSandboxes() {
  try {
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
  const err = clearSandboxes();
  if (err) {
    console.error(
      `Cannot clear ${TEMP_DIR}/: ${err.message}\n`
      + "Another mutation run is probably still using it. Wait for it to finish, "
      + "or stop it and delete the directory, then start again.",
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
