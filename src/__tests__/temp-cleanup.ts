import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const ATTEMPTS = 11;
const DELAY_MS = 100;

/**
 * Remove several roots at once. Two recursive removals over one tree race each other (EPERM on every platform), so a
 * root nested under another registered root is a bug in the test that registered it and fails here.
 */
export async function removeTrees(roots: readonly string[]): Promise<void> {
    const resolved = roots.map((root) => resolve(root));
    for (const inner of resolved) {
        for (const outer of resolved) {
            if (inner !== outer && inner.startsWith(outer + sep)) {
                throw new Error(
                    `cleanup root ${inner} is nested under cleanup root ${outer}; register only the outer one`,
                );
            }
        }
    }
    await Promise.all(resolved.map((root) => removeTree(root)));
}

/**
 * Remove a directory a test built. A handle the previous test released a moment ago can still hold the tree on
 * Windows (EBUSY, EPERM, ENOTEMPTY), so the removal retries a bounded number of times; `force` makes a tree that
 * is already gone a success and any other error surfaces at once.
 *
 * The loop is explicit because Bun's `fs.promises.rm` ignores `maxRetries` and `retryDelay` on every platform (as
 * of Bun 1.4.4). It defends against handles outside the test (an antivirus scanner, the indexer). The upstream fix
 * is open at https://github.com/oven-sh/bun/pull/41480 (it replaces #39003). Delete the loop once that lands and
 * `packageManager` reaches the release containing it.
 */
export async function removeTree(path: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await rm(path, { recursive: true, force: true });
            return;
        } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "";
            if (attempt >= ATTEMPTS || !RETRYABLE.has(code)) throw error;
            await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        }
    }
}
