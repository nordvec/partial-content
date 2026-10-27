import { describe, expect, it } from "bun:test";
// @ts-expect-error - a repo-tooling .mjs with no declarations; the package ships neither.
import { resolveNpmCli } from "../../scripts/check-tarball.mjs";

const resolve = resolveNpmCli as (
    env: Record<string, string | undefined>,
    execPath: string,
    exists: (p: string) => boolean,
) => string;

const NODE = "/usr/bin/node";
const BESIDE_NODE = "/usr/lib/node_modules/npm/bin/npm-cli.js";
const nothingExists = () => false;

/**
 * `join` emits the host's separators, so a candidate built on Windows is
 * backslashed even from a posix-looking node path. The claim under test is
 * which candidate was chosen, never how the host spells it.
 */
const posix = (p: string) => p.replaceAll("\\", "/");
const onlyPosixLayout = (p: string) => posix(p).endsWith("/lib/node_modules/npm/bin/npm-cli.js");

describe("resolveNpmCli", () => {
    it("takes npm's own execpath when npm is the runner", () => {
        const npmCli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
        expect(resolve({ npm_execpath: npmCli }, NODE, nothingExists)).toBe(npmCli);
    });

    it("ignores a runner that is not npm, rather than handing node a binary", () => {
        // `bun run` sets npm_execpath to the bun executable, pnpm to pnpm.cjs.
        // Running either as a script is what this check exists to prevent.
        for (const runner of ["/home/u/.bun/bin/bun", "C:\\bun\\bun.exe", "/usr/lib/pnpm/bin/pnpm.cjs"]) {
            expect(posix(resolve({ npm_execpath: runner }, NODE, onlyPosixLayout))).toBe(BESIDE_NODE);
        }
    });

    it("finds npm as the runner's own sibling, where a bun-launched run has to look", () => {
        // npm nowhere near the executing binary is the normal shape when the
        // runner was installed as a package: both live in one node_modules.
        const bun = "/home/u/npm-local/node_modules/bun/bin/bun";
        const sibling = "/home/u/npm-local/node_modules/npm/bin/npm-cli.js";
        const only = (p: string) => posix(p) === sibling;
        expect(posix(resolve({ npm_execpath: bun }, NODE, only))).toBe(sibling);
        expect(posix(resolve({}, bun, only))).toBe(sibling);
    });

    it("finds npm beside the running node when no runner declared one", () => {
        expect(posix(resolve({}, NODE, onlyPosixLayout))).toBe(BESIDE_NODE);
    });

    it("finds npm in the layout that puts it under the node directory itself", () => {
        // The Windows shape. Spelled with posix separators so the case runs the
        // same on the Linux runner, where a backslash is an ordinary character
        // and `dirname` would answer "." to a real Windows path.
        const under = (p: string) => posix(p).endsWith("/bin/node_modules/npm/bin/npm-cli.js");
        expect(posix(resolve({}, NODE, under))).toBe("/usr/bin/node_modules/npm/bin/npm-cli.js");
    });

    it("refuses with an actionable message rather than spawning something wrong", () => {
        expect(() => resolve({}, NODE, nothingExists)).toThrow(/cannot find npm's CLI beside \/usr\/bin\/node/);
    });
});
