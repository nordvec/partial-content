# Contributing

Thanks for your interest in partial-content. Issues and PRs are welcome; this
page tells you what to expect and what we expect back.

## Ground rules

- **Zero runtime dependencies is a hard invariant.** PRs that add a runtime
  dependency will be declined regardless of merit; devDependencies are fine.
- **Correctness over convenience.** Behavior follows the RFCs (9110, 9530,
  6266/8187). When a change touches protocol behavior, cite the
  section that justifies it in the PR description; where the ecosystem and the
  spec disagree, the deviations are documented in `docs/DESIGN.md`.
- **Small surface, deep implementation.** New features must serve the core
  job (range + conditional serving for storage backends). If in doubt, open
  an issue first so we can talk scope before you write code.
- **Docs describe the latest state only.** No changelog-style "now supports"
  language in README or docs; history lives in `CHANGELOG.md`.

## Reporting bugs

Use the issue tracker. The single most useful thing you can include is a
minimal reproduction: request headers in, response status/headers out, and
what you expected instead (with the RFC section if you know it).

Security reports: **do not open a public issue**; see [SECURITY.md](SECURITY.md).

## Development

```bash
bun install              # dependencies (Bun is the dev runtime)
bun test                 # full unit + property suite
bun run build            # tsc -> dist/
bun run typecheck        # tsc --noEmit over the shipped source
bun run typecheck:tests  # tsc --noEmit over the suite
bun run check:doc-types  # compile the TypeScript in README.md and docs/*.md
bun run lint             # bans Bun-only builtins and monorepo imports in src/
npm run bench            # e2e benchmark suite (optional, takes minutes)
```

The library is TypeScript, ESM-only, built with plain `tsc`. Tests use
`bun:test`; kernel invariants also have property-based coverage
(`fast-check`) in `src/__tests__/kernel.property.test.ts`. Prefer a property
(round-trip, bounds, idempotence) over more example cases when a function
has an algebraic contract.

Two gates cover ground the build tsconfig does not:

- **`typecheck:tests`** covers `src/__tests__` under `tsconfig.tests.json`.
  The build config excludes those files so they can never reach `dist/`,
  which left the suite typechecked by nothing: a test double could omit a
  field its interface requires, and the only symptom was a puzzling assertion
  failure, or none at all. It emits nothing, so the tarball is unaffected.
- **`check:doc-types`** extracts every fenced ` ```typescript ` block in
  `README.md` and `docs/*.md` into its own module and compiles it against the
  real source. A reference snippet that does not compile is the same defect as
  a function that does not, and it is worse for the consumer, who copies it
  before finding out. A block is skipped when it is not meant to stand alone:
  it opens with `// doc-check: fragment` (a deliberate excerpt), or it imports
  a package other than this one. Both gates run on pre-commit.

## Pull requests

- Every behavior change needs a test that fails without the change.
- Run `bun test`, `bun run build`, `bun run typecheck:tests` and
  `bun run check:doc-types` before pushing; CI also verifies the
  packed exports map (`attw`), consumer type-resolution, per-export size
  budgets (`.size-limit.json`), and smoke-tests the built package on Node,
  Bun, and Deno.
- Keep diffs reviewable: one concern per PR.

## Mutation testing

CI enforces per-module mutation-score floors nightly (Stryker; see
`scripts/mutation-ci.mjs`). For a module you changed:

```bash
bun run test:mutation -- --mutate src/<file>.ts
```

Surviving mutants are a review signal, not automatically a defect: confirm a
survivor represents a real coverage gap before adding a test for it, and
never weaken a guard just to kill a mutant. If your change raises a module's
baseline, raise its floor in the same PR; floors are never lowered to go
green.

A run builds sandboxes under `.stryker-tmp/`, each a whole copy of the
package with its tests. A copy left in the tree is the trap: `bun test`
discovers the sandbox's tests and runs them against MUTATED source, so the
next plain test run reports failures that read exactly like a regression in
your change. Both `test:mutation` and `test:mutation:ci` route through
`scripts/mutation-sandbox.mjs`, which clears the directory on entry, on
`SIGINT`/`SIGTERM`, and on the way out, so interrupting a run is safe. A run
that finds the directory locked refuses and says so: another mutation run
owns it, and two runs sharing one temp directory corrupt each other's
results. The lint config also ignores the directory: a sandbox present
mid-run is a whole second copy of the package, a build artifact of the
mutation run rather than source anyone should lint.

## Releases (maintainers)

Publishing is CI-only via npm Trusted Publishing: bump the version and
`CHANGELOG.md`, then push a `v<version>` tag matching `package.json`. The
release workflow builds, tests and smoke-tests the packed `dist/` on Node 24,
Bun and Deno with read-only permissions, publishes that exact tarball with
provenance from a job holding only the OIDC permission, and then creates the
GitHub Release. There is no manual `npm publish` path.
