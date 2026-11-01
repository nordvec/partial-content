/**
 * The package's directory and the run-as-a-program test, shared by every
 * script that both exports functions for its tests and runs when invoked.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root (the directory holding `package.json`). */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether the module at `moduleUrl` is the program node or bun was asked to run,
 * rather than one imported by a test.
 * @param {string} moduleUrl the caller's `import.meta.url`
 */
export const invokedDirectly = (moduleUrl) =>
    Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
