/**
 * CI mutation-testing runner for partial-content.
 *
 * Runs Stryker once per core module (the command runner scores one module per
 * invocation and `thresholds.break` is a single number), each against its own
 * floor set a couple of points under the established baseline. A module scoring
 * below its floor fails the build; the surviving margin absorbs a newly added
 * equivalent mutant without turning green-to-red on the first honest change.
 *
 * Each floor's baseline and the equivalence rationale for its survivors sit
 * beside it in FLOORS below. Raise a floor here whenever the corresponding
 * baseline is raised, never lower one to make CI pass.
 *
 * Usage: `bun run test:mutation:ci` (or `node scripts/mutation-ci.mjs`).
 * Scope to one module with `MUTATION_MODULES=http.ts node scripts/...`.
 * `--list` prints the module names as a JSON array; the nightly workflow
 * runs one job per module from it, because the whole set in sequence takes
 * longer than a runner job may live.
 */
import { guardSandboxes, clearSandboxes, runStryker } from "./mutation-sandbox.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PKG_DIR } from "./script-entry.mjs";

// Bun runs the suite and the selection (it uses Bun's transpiler and resolver);
// the driver itself may be Node, where a bare `bun` is found on PATH.
const BUN = process.versions.bun ? process.execPath : "bun";
const SUITE = ["test", "--isolate", "--timeout", "30000"];

/**
 * The test command for one module and the budget its mutants run under.
 *
 * A module with a narrower selection reruns those files only. A mutant that
 * slows a test down is a survivor under the budget the full suite gave and a
 * timeout (counted as detected) under a smaller one, so the budget stays what
 * the full suite would have had: Stryker adds `timeoutFactor` times the dry-run
 * time to `timeoutMS`, and the dry run is now shorter, so `timeoutMS` carries
 * the full suite's share instead. A failed or unresolvable selection runs the
 * whole suite and says why.
 * @param {string} mod
 * @param {() => number} fullSuiteMs
 */
function commandFor(mod, fullSuiteMs) {
    const run = spawnSync(BUN, [path.join(PKG_DIR, "scripts/mutation-tests.mjs"), `src/${mod}`], {
        cwd: PKG_DIR,
        encoding: "utf8",
    });
    let selection;
    try {
        selection = JSON.parse(run.stdout);
    } catch {
        selection = { fallback: `the selection did not run (${(run.stderr || "no output").trim().split("\n")[0]})` };
    }
    if (selection.fallback !== undefined) {
        console.log(`selection: full suite, because ${selection.fallback}`);
        return { args: SUITE, note: "full suite" };
    }
    if (selection.files.length === 0) {
        console.error(`No test file reaches src/${mod}: its floor would score a module nothing exercises.`);
        process.exit(2);
    }
    return {
        args: [...SUITE, ...selection.files],
        note: `${selection.files.length} test file(s)`,
        timeoutMs: 15000 + 2 * fullSuiteMs(),
    };
}

/** Wall time of one full-suite run on this machine, measured once. */
let measuredFullSuiteMs;
function fullSuiteMs() {
    if (measuredFullSuiteMs === undefined) {
        const start = Date.now();
        const run = spawnSync(BUN, SUITE, { cwd: PKG_DIR, stdio: "ignore" });
        if (run.status !== 0) {
            console.error("The full suite fails before any mutation, so no mutant can be scored.");
            process.exit(2);
        }
        measuredFullSuiteMs = Date.now() - start;
    }
    return measuredFullSuiteMs;
}

// module file (in src/) -> break floor (mutation score %). Floors sit ~2 points
// under the recorded baseline to tolerate one new equivalent mutant.
//
// A baseline means nothing unless the tree stood still while it was measured.
// A run that samples a tree under edit fails its own initial test run and
// records the module as below floor without ever scoring it, which reads
// identically to a real regression. Freeze the tree, then measure.
//
// Two tiers, different absolute levels for a reason:
//   - Core (kernel, mime, content-disposition, object-store, http): pure logic
//     with algebraic contracts. High floors; most survivors are real gaps.
//   - SDK adapters (s3/r2/gcs/azure/node/memory/fs/hono): thin wrappers over a
//     backend SDK. Many mutants are EQUIVALENT (mutating an SDK option or a
//     Content-Range digit the mock can't distinguish), which caps the
//     achievable score well under 100. The floor still earns its keep: it
//     catches a regression that guts an adapter's tests wholesale, even if the
//     absolute number looks low. Raise a floor when its baseline rises.
const FLOORS = {
    // ── Core (pure-logic) ──
    "kernel.ts": 92, // baseline 93.11 (943 mutants; survivors: guards a
    // stricter check before them already enforces, comparisons
    // against an Invalid Date that are false either way, reads
    // one past a string's end that yield undefined either way,
    // field-overflow checks the safe-integer parse precedes, and
    // whitespace that Number() trims itself)
    "mime.ts": 84, // baseline 88.89 (18 mutants; both survivors are
    // equivalent: slice(0) of the extension, and an empty
    // extension the table lookup misses either way)
    "content-disposition.ts": 96,
    "encoding.ts": 97, // baseline 98.01 (151 mutants; survivors: trimming a
    // parameter whose name and value are trimmed again, the
    // empty-entry early return the loop reaches with the same
    // result, and the index tie-break of a stable sort over
    // entries pushed in index order)
    "cache-control.ts": 96, // baseline 100.00 (80 mutants; tolerates ~3 survivors)
    "object-store.ts": 92, // baseline 94.27 (frozen-tree, 2026-08-26)
    "http.ts": 92, // baseline 95.75 (306 mutants; survivors: trimmed header values, digest-scan bounds, the drain catch-all, and the unanchored size regexes)
    "web.ts": 83, // baseline 85.07 (988 mutants; survivors are telemetry payload
    // contents, Server-Timing arithmetic, and stream-teardown
    // internals with no observable contract)
    // ── SDK adapters (thin wrappers; equivalent-mutant heavy) ──
    "s3.ts": 93, // baseline 95.62 (137 mutants; survivors: a web-stream body
    // taking the async-iterable path, which applies the same
    // length guard; the bucket checks' optional chaining behind
    // the client check that throws first; the explicit
    // "attachment" type that is also the default; a throttle
    // with no Retry-After answering an empty hint, which the
    // classifier reads the same as a bare `true`)
    "r2.ts": 98, // baseline 100.00 (72 mutants; tolerates one survivor)
    "gcs.ts": 90, // baseline 92.80 (236 mutants; survivors: the end clamp
    // the satisfiable-range check already bounds, the explicit
    // "attachment" type that is also the default, typeof checks
    // ahead of Number.isSafeInteger or a property read that
    // rejects the same values, a throttle hint object with no
    // seconds that the classifier reads as a bare `true`, and
    // notFound's false vs undefined)
    "azure.ts": 96, // baseline 97.10 (138 mutants; survivors: the explicit
    // "attachment" type that is also the default, the header
    // getters' try/catch around reads that never throw on the
    // mock, and a throttle hint object with no seconds read as
    // a bare `true`)
    "node.ts": 88, // baseline 90.82 (98 mutants; survivors: clearing an
    // unref'd stall timer whose late fire is a no-op, the
    // `?.` on unref, the already-destroyed guards before an
    // idempotent destroy, and a header getter's null vs
    // undefined for an absent header)
    "memory.ts": 93, // baseline 93.14 (reference store)
    "fs.ts": 72, // baseline 85.66 on win32 ; lower on CI (the win32-only device/ADS guard block is unreachable on Linux, its mutants survive there)
    "hono.ts": 80, // baseline 100.00 (5 mutants; tolerates one survivor)
};

// `--list` prints the module names as JSON and exits, so the CI matrix is
// derived from FLOORS rather than restated in the workflow file: a module
// added here is sharded on the next nightly without anyone editing YAML.
if (process.argv.includes("--list")) {
    console.log(JSON.stringify(Object.keys(FLOORS)));
    process.exit(0);
}

guardSandboxes();

const only = process.env.MUTATION_MODULES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const modules = only?.length ? only : Object.keys(FLOORS);

const results = [];
for (const mod of modules) {
    const floor = FLOORS[mod];
    if (floor === undefined) {
        console.error(`No floor configured for module "${mod}" (known: ${Object.keys(FLOORS).join(", ")})`);
        process.exit(2);
    }
    const command = commandFor(mod, fullSuiteMs);
    console.log(`\n=== mutation: ${mod} (floor ${floor}%, ${command.note}) ===`);
    const run = runStryker(["stryker.config.mjs", "--mutate", `src/${mod}`], {
        ...process.env,
        STRYKER_BREAK: String(floor),
        STRYKER_TEST_COMMAND: `bun ${command.args.join(" ")}`,
        ...(command.timeoutMs === undefined ? {} : { STRYKER_TIMEOUT_MS: String(command.timeoutMs) }),
    });
    // Stryker exits 0 when the score meets `break`, non-zero (1) when it falls
    // below. Any other failure (crash, signal) is also a hard failure here.
    const passed = run.status === 0;
    results.push({ mod, floor, passed, status: run.status });
}

clearSandboxes();

console.log("\n=== mutation summary ===");
for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.mod}  (floor ${r.floor}%)`);
}

const failed = results.filter((r) => !r.passed);
if (failed.length > 0) {
    console.error(`\n${failed.length} module(s) below the mutation floor: ${failed.map((r) => r.mod).join(", ")}`);
    process.exit(1);
}
console.log("\nAll modules met their mutation floors.");
