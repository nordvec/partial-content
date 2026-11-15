/**
 * Which test files can observe a mutant in one source module.
 *
 * The command runner has no per-test coverage, so every mutant reruns whatever
 * command it is given. The whole suite is ~3,000 tests and takes seconds, which
 * across a thousand mutants outgrows a CI job. A test can only observe a module
 * it reaches through the imports it loads at runtime (barrels, self-imports of
 * the package's own name and side-effect imports included), so the command for
 * a module runs the test files whose import closure contains it.
 *
 * The selection fails closed: when any specifier cannot be resolved the way
 * Bun resolves it, the answer is the full suite and the reason, never a guess.
 *
 * Run under Bun (`bun scripts/mutation-tests.mjs src/x.ts` prints the answer as
 * JSON), because it uses Bun's own transpiler and resolver; the Stryker driver
 * itself may run under Node.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PKG_DIR, invokedDirectly } from "./script-entry.mjs";

/** The file names `bun test` runs: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
/** Directories `bun test` never descends into, plus every dot directory. */
const SKIPPED_DIRS = new Set(["node_modules", "dist"]);
/** Source files whose imports are followed; anything else is a leaf. */
const FOLLOWED = /\.[cm]?[jt]sx?$/;
/** Specifiers the runtime provides, which need no resolution to a file. */
const BUILTIN = /^(?:node|bun):|^bun$/;
/**
 * Every static import or re-export that is not a whole-statement type one, with
 * its specifier. Bun's scanner drops a declaration whose names are all inline
 * `type` ones, but this package compiles with `verbatimModuleSyntax`, which
 * keeps it as a side-effect import, so those are read here and kept. Anchored
 * at a line start so the examples in a doc comment (` * import ... from`) are
 * not imports.
 */
const STATIC_SPECIFIER = /^[ \t]*(?:import|export)\b(?!\s+type\b)(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm;

/** @param {string} dir */
function* walk(dir) {
    // oxlint-disable-next-line nordvec/no-tree-walk -- this walk reproduces `bun test`'s own discovery (including untracked files); the package is mirrored standalone, so it cannot import the monorepo's walker.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (TEST_FILE.test(entry.name)) yield full;
    }
}

/**
 * The runtime import specifiers of one file.
 * @param {Bun.Transpiler} transpiler
 * @param {string} file
 * @returns {Set<string>}
 */
function specifiersOf(transpiler, file) {
    const text = readFileSync(file, "utf8");
    const found = new Set();
    // Dynamic imports, requires and static imports the scanner keeps.
    for (const { path: specifier } of transpiler.scanImports(text)) found.add(specifier);
    for (const match of text.matchAll(STATIC_SPECIFIER)) found.add(match[1]);
    return found;
}

/**
 * The test files that load `moduleFile`, or the reason a full-suite run is the
 * only answer.
 * @param {{ cwd?: string, moduleFile: string }} where `moduleFile` relative to `cwd`
 * @returns {{ files: string[] } | { fallback: string }}
 */
export function selectTests({ cwd = PKG_DIR, moduleFile }) {
    const target = path.resolve(cwd, moduleFile);
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    /** @type {Map<string, Set<string> | string>} file -> files it loads, or why that is unknown */
    const graph = new Map();

    /** @returns {Set<string> | string} */
    const loads = (file) => {
        const known = graph.get(file);
        if (known !== undefined) return known;
        const resolved = new Set();
        let failure = null;
        for (const specifier of specifiersOf(transpiler, file)) {
            if (BUILTIN.test(specifier)) continue;
            try {
                resolved.add(Bun.resolveSync(specifier, path.dirname(file)));
            } catch {
                failure = `${path.relative(cwd, file).split(path.sep).join("/")} imports "${specifier}", which does not resolve`;
                break;
            }
        }
        const answer = failure ?? resolved;
        graph.set(file, answer);
        return answer;
    };

    const files = [];
    for (const test of [...walk(cwd)].toSorted()) {
        const seen = new Set([test]);
        const queue = [test];
        for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
            const next = loads(file);
            if (typeof next === "string") return { fallback: next };
            for (const dep of next) {
                // A dependency is a leaf: its own imports are not followed.
                if (seen.has(dep) || dep.includes(`${path.sep}node_modules${path.sep}`) || !FOLLOWED.test(dep))
                    continue;
                seen.add(dep);
                queue.push(dep);
            }
        }
        if (seen.has(target)) files.push(`./${path.relative(cwd, test).split(path.sep).join("/")}`);
    }
    return { files };
}

if (invokedDirectly(import.meta.url)) {
    const moduleFile = process.argv[2];
    if (!moduleFile) {
        console.error("usage: bun scripts/mutation-tests.mjs <src/module.ts>");
        process.exit(2);
    }
    console.log(JSON.stringify(selectTests({ moduleFile })));
}
