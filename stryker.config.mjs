/**
 * Mutation-testing config for partial-content.
 *
 * Bun has no native StrykerJS test-runner plugin, so we drive the real suite
 * through the `command` runner (`bun test`). That means no per-test coverage
 * analysis: every mutant reruns whatever command it is given. An ad-hoc
 * `--mutate` run gives it the whole suite (cheap for one module, zero runtime
 * deps, hermetic); the CI runner narrows it to the test files that load the
 * module (see `commandRunner` below).
 *
 * Sandbox mode (the default) copies the package to a temp dir and runs there,
 * so a concurrent editor in the live tree can never collide with a mutant run.
 * Scope a run to one module with `--mutate`, e.g.:
 *
 *   bun run test:mutation -- --mutate src/kernel.ts
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The monorepo caps the commit of every `bun test` tree with a preload this
// package's synced copy does not have; the flag is empty there.
const capPath = resolve(import.meta.dirname, "..", "..", "scripts", "setup", "test-commit-cap-preload.ts");
const CAP_PRELOAD = existsSync(capPath) ? ` --preload "${capPath.replaceAll("\\", "/")}"` : "";

export default {
    testRunner: "command",
    commandRunner: {
        // Full suite per mutant for an ad-hoc `--mutate` run. The CI runner
        // (scripts/mutation-ci.mjs) sets STRYKER_TEST_COMMAND to the test files
        // that import the module, which is all a mutant can be observed by.
        command: (process.env.STRYKER_TEST_COMMAND ?? "bun test --isolate --timeout 30000").replace(
            /^bun test/,
            `bun test${CAP_PRELOAD}`,
        ),
    },

    // The sandbox copy of bunfig.toml would resolve its preloads from the wrong
    // depth; the cap preload is named on the command line instead.
    ignorePatterns: ["bunfig.toml"],

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
    // scripts/mutation-ci.mjs raises it with the full suite's own run time when
    // it narrows the command, so the budget a mutant gets does not shrink with
    // the subset.
    timeoutMS: Number(process.env.STRYKER_TIMEOUT_MS ?? 15000),
    timeoutFactor: 2,

    // Lower locally with STRYKER_CONCURRENCY=1 if the initial dry run OOMs.
    concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 6),

    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "reports/mutation/partial-content.json" },

    // Never incremental: the command runner reports one test with no file, so
    // Stryker cannot see a test change and reuses every earlier result after
    // one, which is exactly the run that iterates on survivors.
    incremental: false,
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
