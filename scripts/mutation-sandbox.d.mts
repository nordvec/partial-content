import type { SpawnSyncReturns } from "node:child_process";

export const pkgDir: string;

/** `stryker run <args>` in the package, under the suite slot when the monorepo provides one. */
export function runStryker(args: readonly string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<Buffer>;

/** Remove every staged sandbox; the error when the directory survives, else null. */
export function clearSandboxes(): unknown;

/** Clear sandboxes on the way in and on the signals that skip Stryker's teardown. */
export function guardSandboxes(): void;

/** The argument that sets Stryker's worker count on the command line, or null. */
export function concurrencyFlag(args: readonly string[]): string | null;
