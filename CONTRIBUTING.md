# Contributing

Thanks for your interest in partial-content. Issues and PRs are welcome; this
page tells you what to expect and what we expect back.

## Ground rules

- **Zero runtime dependencies is a hard invariant.** PRs that add a runtime
  dependency will be declined regardless of merit; devDependencies are fine.
- **Correctness over convenience.** Behavior follows the RFCs (7232, 7233,
  9110, 9530, 6266/8187). When a change touches protocol behavior, cite the
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
bun install          # dependencies (Bun is the dev runtime)
bun test             # full unit + property suite
bun run build        # tsc -> dist/
npm run bench        # e2e benchmark suite (optional, takes minutes)
```

The library is TypeScript, ESM-only, built with plain `tsc`. Tests use
`bun:test`; kernel invariants also have property-based coverage
(`fast-check`) in `src/__tests__/kernel.property.test.ts`. Prefer a property
(round-trip, bounds, idempotence) over more example cases when a function
has an algebraic contract.

## Pull requests

- Every behavior change needs a test that fails without the change.
- Run `bun test` and `bun run build` before pushing; CI also verifies the
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

## Releases (maintainers)

Publishing is CI-only via npm Trusted Publishing: bump the version and
`CHANGELOG.md`, then push a `v<version>` tag matching `package.json`. The
release workflow runs the suite, publishes with provenance, and creates the
GitHub Release. There is no manual `npm publish` path.
