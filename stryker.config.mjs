/**
 * Mutation-testing config for @nordvec/partial-content.
 *
 * Bun has no native StrykerJS test-runner plugin, so we drive the real suite
 * through the `command` runner (`bun test`). That means no per-test coverage
 * analysis: every surviving-or-killed decision reruns the whole suite, which is
 * cheap here (~700ms, zero runtime deps) and keeps the run hermetic.
 *
 * Sandbox mode (the default) copies the package to a temp dir and runs there,
 * so a concurrent editor in the live tree can never collide with a mutant run.
 * Scope a run to one module with `--mutate`, e.g.:
 *
 *   bun run test:mutation -- --mutate src/kernel.ts
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
    testRunner: "command",
    commandRunner: {
        // Full suite per mutant: fast enough here and avoids false survivors
        // from a module being exercised by a sibling suite (no perTest data).
        command: "bun test --isolate --timeout 30000",
    },

    // Default empty: the test:mutation script always passes --mutate <file> so a
    // bare run fails fast rather than mutating the entire package by accident.
    mutate: [],

    // No TypeScript checker: Bun runs TS directly and the checker plugin can't
    // resolve the workspace's symlinked node_modules inside the sandbox.
    checkers: [],

    // Skip module-level (static) mutants: each forces a full re-instrument and
    // the command runner has no coverage data to place them per-test.
    ignoreStatic: true,

    // A mutant still running well past the ~700ms suite is a spinning
    // loop-condition mutant; fail it fast rather than wait out the factor.
    timeoutMS: 15000,
    timeoutFactor: 2,

    // Lower locally with STRYKER_CONCURRENCY=1 if the initial dry run OOMs.
    concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 6),

    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "reports/mutation/partial-content.json" },

    // Incremental locally (fast re-runs while iterating); disabled in CI where
    // the checkout is fresh and a full, deterministic evaluation is wanted.
    incremental: process.env.STRYKER_INCREMENTAL !== "false",
    incrementalFile: "reports/mutation/stryker-incremental.json",
    tempDirName: ".stryker-tmp",
    cleanTempDir: true,

    // String-literal flips are noise (header names, MIME strings); the logic
    // mutants (conditionals, arithmetic, boundaries) are what matter here.
    mutator: { excludedMutations: ["StringLiteral"] },

    // `break` is null for local exploration; the CI runner sets STRYKER_BREAK to
    // a per-module floor so a regression below the established score fails the
    // build (scripts/mutation-ci.mjs owns the per-module floors).
    thresholds: {
        high: 90,
        low: 75,
        break: process.env.STRYKER_BREAK ? Number(process.env.STRYKER_BREAK) : null,
    },
};
