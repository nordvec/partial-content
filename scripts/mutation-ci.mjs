/**
 * CI mutation-testing runner for @nordvec/partial-content.
 *
 * Runs Stryker once per core module (the command runner scores one module per
 * invocation and `thresholds.break` is a single number), each against its own
 * floor set a couple of points under the established baseline. A module scoring
 * below its floor fails the build; the surviving margin absorbs a newly added
 * equivalent mutant without turning green-to-red on the first honest change.
 *
 * Baselines + equivalence rationale live in
 * docs/plans/test-architecture-master.md. Raise a floor here whenever the
 * corresponding baseline is raised, never lower one to make CI pass.
 *
 * Usage: `bun run test:mutation:ci` (or `node scripts/mutation-ci.mjs`).
 * Scope to one module with `MUTATION_MODULES=http.ts node scripts/...`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// module file (in src/) -> break floor (mutation score %). Floors sit ~2 points
// under the recorded baseline to tolerate one new equivalent mutant.
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
    "kernel.ts": 82,
    "mime.ts": 84,
    "content-disposition.ts": 96,
    "encoding.ts": 86,          // baseline 88.89 (survivors: token-regex class mutants, largely equivalent)
    "cache-control.ts": 96,     // baseline 100.00 (80 mutants; tolerates ~3 survivors)
    "object-store.ts": 92,
    "http.ts": 92,
    "upload-engine.ts": 90,     // baseline 91.73 (344 mutants; survivors are
                                // undefined-comparison no-ops in optional-bound
                                // guards, provably outcome-equivalent)
    "upload-orchestrator.ts": 92, // baseline 93.85 (completion inference +
                                  // derived clean-append outcome joined the
                                  // R534 growth; residuals are post-settle
                                  // cleanup closures, once:true hygiene,
                                  // undefined-comparison no-ops in the policy
                                  // guards, and a defensive unreachable throw)
    "upload-locker.ts": 96,     // baseline 100.00 (55 mutants; headroom for
                                // timer-jitter timeout mutants)
    "redis-locker.ts": 84,      // baseline 86.00 (100 mutants; survivors are
                                // optional-chained onError sinks, poll-jitter
                                // and 1ms-deadline arithmetic, and the
                                // watchdog-interval floor, all equivalent
                                // within one poll round)
    "tus.ts": 88,               // baseline 90.62 (checksum extension landed
                                // well-covered; residuals are completeness
                                // derivations masked by the heal safety net and
                                // isHead flags on outcomes a HEAD never produces)
    "upload.ts": 94,            // baseline 96.44 (309 mutants; the 11 survivors are
                                // provably equivalent: .trim() on values Headers
                                // already OWS-strips, a defensive unreachable
                                // default:, digest-parser edge conditionals whose
                                // branches converge)
    "web.ts": 83,      // baseline 85.07 (988 mutants; survivors are telemetry payload
                       // contents, Server-Timing arithmetic, and stream-teardown
                       // internals with no observable contract)
    // ── SDK adapters (thin wrappers; equivalent-mutant heavy) ──
    "s3.ts": 73,       // baseline 75.68 (write store lifted it from 52.11)
    "r2.ts": 80,       // baseline 83.13 (write store lifted it from 77.05)
    "gcs.ts": 66,      // baseline 68.52 (write store; equivalent-heavy SDK spreads)
    "azure.ts": 68,    // baseline 71.71 (write store lifted it from 66.87)
    "node.ts": 63,     // baseline 65.79
    "memory.ts": 93,   // baseline 95.08 (write store lifted it from 84.09)
    "fs.ts": 72,       // baseline 84.57 on win32 incl. the write store; lower on CI (the win32-only device/ADS guard block is unreachable on Linux, its mutants survive there)
    "hono.ts": 80,     // baseline 100.00 (5 mutants; tolerates one survivor)
};

const require = createRequire(import.meta.url);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resolve the Stryker CLI from its own package.json bin field (robust across
// hoisting and platforms; avoids a PATH-dependent `stryker` shim).
const strykerPkgJson = require.resolve("@stryker-mutator/core/package.json");
const strykerPkg = require("@stryker-mutator/core/package.json");
const binRel = typeof strykerPkg.bin === "string" ? strykerPkg.bin : strykerPkg.bin.stryker;
const strykerBin = path.resolve(path.dirname(strykerPkgJson), binRel);

const only = process.env.MUTATION_MODULES?.split(",").map((s) => s.trim()).filter(Boolean);
const modules = only?.length ? only : Object.keys(FLOORS);

const results = [];
for (const mod of modules) {
    const floor = FLOORS[mod];
    if (floor === undefined) {
        console.error(`No floor configured for module "${mod}" (known: ${Object.keys(FLOORS).join(", ")})`);
        process.exit(2);
    }
    console.log(`\n=== mutation: ${mod} (floor ${floor}%) ===`);
    const run = spawnSync(
        process.execPath,
        [strykerBin, "run", "stryker.config.mjs", "--mutate", `src/${mod}`],
        {
            cwd: pkgDir,
            stdio: "inherit",
            env: {
                ...process.env,
                STRYKER_BREAK: String(floor),
                // Fresh, deterministic evaluation in CI (no stale incremental file).
                STRYKER_INCREMENTAL: "false",
            },
        },
    );
    // Stryker exits 0 when the score meets `break`, non-zero (1) when it falls
    // below. Any other failure (crash, signal) is also a hard failure here.
    const passed = run.status === 0;
    results.push({ mod, floor, passed, status: run.status });
}

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
