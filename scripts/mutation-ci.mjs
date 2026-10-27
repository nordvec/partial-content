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
    "kernel.ts": 82,
    "mime.ts": 84,
    "content-disposition.ts": 96,
    "encoding.ts": 86, // baseline 88.89 (survivors: token-regex class mutants, largely equivalent)
    "cache-control.ts": 96, // baseline 100.00 (80 mutants; tolerates ~3 survivors)
    "object-store.ts": 92, // baseline 94.27 (frozen-tree, 2026-08-26)
    "http.ts": 92,
    "open-retry.ts": 88, // baseline 91.30 (23 mutants; the 2 survivors are
    // backoff-delay arithmetic (baseDelayMs * attempt),
    // equivalent within one retry round)
    "upload-engine.ts": 91, // baseline 92.04 (507 mutants; survivors are
    // undefined-comparison no-ops in optional-bound
    // guards, provably outcome-equivalent: an absent
    // bound makes every comparison against it false,
    // so widening the guard changes no outcome)
    "upload-orchestrator.ts": 93, // baseline 95.54 (587 mutants, frozen tree,
    // 2026-10-08; the events copy on a creation's
    // offset conflict was pinned after it). The 21
    // residuals are equivalent: grace-timer
    // cleanup closures and once:true hygiene, the
    // undefined-comparison no-ops in the policy
    // guards and belowMinSize, the always-defined
    // oldest entry of the delivered-completion
    // memory, the token guard on a digest
    // mismatch's discard, a cancel the engine
    // always accepts, finally-block cleanups, and
    // a defensive unreachable default throw
    "upload-internals.ts": 98, // baseline 98.02 (303 mutants, 2026-10-12). It
    // mints the upload id, gates its shape, scrubs
    // the capability out of reported errors, and
    // drives every store's append body. The 6
    // survivors are unobservable: `=+$` vs `=+` on
    // padding that only ends a base64 string, a
    // write past a typed array's end, `crypto?.` on
    // runtimes that all define crypto, randomUUID
    // vs the fallback (both mint a valid id), a
    // typeof check Number.isSafeInteger repeats,
    // and `maxBytes !== undefined` before a
    // comparison that is false for undefined.
    "upload-locker.ts": 93, // baseline 95.35 (43 mutants; the 2 survivors are
    // provably equivalent: the `if (!holder)` guard in
    // release() (only one unreleased lock exists per
    // token at a time, and the Map entry outlives every
    // live holder, so holder is never missing on a live
    // release) and the `if (idx !== -1)` guard on the
    // timeout timer (a shifted entry always has its timer
    // cleared, so a firing timer always finds its entry
    // queued). Both are defensive belts on paths the
    // signal-based redesign structurally prevents.
    "redis-locker.ts": 88, // baseline 89.17 (146 mutants; the range is
    // real, not sloppiness: this module's mutants
    // are timing-sensitive and one or two flip
    // between runs, so the floor is set under the
    // LOW end. Raised from 84
    // when bounding every round trip added ~45
    // mutants and the survivor sweep pinned the
    // failing-SET, failing-unsubscribe,
    // preempt-after-release and no-sink-configured
    // paths. The 13 survivors are equivalence
    // classes for a timing module: poll-jitter and
    // sleep(0)-vs-skip arithmetic, the
    // watchdog-interval floor, the two deadline
    // guards that are redundant with each other by
    // design (either one alone produces the same
    // rejection; both exist to skip a doomed round
    // trip), timer-clear hygiene with no observable
    // contract, an optional-chained sink on a
    // detached promise, and the withinTimeout
    // spent-budget pre-check, which both call sites
    // make unreachable but which keeps a subscribe
    // from being opened that nothing would close)
    "tus.ts": 88, // baseline 88.77 (checksum extension landed
    // well-covered; residuals are completeness
    // derivations masked by the heal safety net and
    // isHead flags on outcomes a HEAD never produces)
    "upload.ts": 94, // baseline 94.75 (385 mutants; the survivors are
    // provably equivalent: .trim() on values Headers
    // already OWS-strips, a defensive unreachable
    // default:, digest-parser edge conditionals whose
    // branches converge)
    "web.ts": 83, // baseline 85.07 (988 mutants; survivors are telemetry payload
    // contents, Server-Timing arithmetic, and stream-teardown
    // internals with no observable contract)
    // ── SDK adapters (thin wrappers; equivalent-mutant heavy) ──
    "s3.ts": 75, // baseline 77.57 (raised from 73 once the throttle names,
    // the monotonic sidecar merge and the target validation
    // gained tests; the named throttles had been unreachable,
    // every case building its error with a status the check
    // reads first)
    "r2.ts": 80, // baseline 83.13 (write store lifted it from 77.05)
    "gcs.ts": 66, // baseline 68.52 (write store; equivalent-heavy SDK spreads)
    "azure.ts": 68, // baseline 71.71 (write store lifted it from 66.87)
    "node.ts": 63, // baseline 65.79
    "memory.ts": 93, // baseline 93.14 (write store lifted it from 84.09)
    "fs.ts": 72, // baseline 85.66 on win32 incl. the write store; lower on CI (the win32-only device/ADS guard block is unreachable on Linux, its mutants survive there)
    "hono.ts": 80, // baseline 100.00 (5 mutants; tolerates one survivor)
    "cas-merge.ts": 87, // baseline 100.00 (16 mutants; tolerates two survivors)
    "sweep-each.ts": 84, // baseline 100.00 (13 mutants; tolerates two survivors)
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
    console.log(`\n=== mutation: ${mod} (floor ${floor}%) ===`);
    const run = runStryker(["stryker.config.mjs", "--mutate", `src/${mod}`], {
        ...process.env,
        STRYKER_BREAK: String(floor),
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
