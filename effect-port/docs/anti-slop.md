# Anti-slop Oxlint plugin (effect-port)

`effect-port` vendors [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)
at commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, installed via the
project's bundled `install-anti-slop` skill. See
`tools/oxlint/anti-slop/UPSTREAM.md` for full provenance.

This installation is scoped to `effect-port/` only: it does not touch the
repository root's separate vendored copy at `tools/oxlint/anti-slop/`
(pinned at an older revision, `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`).

## Layout

- `tools/oxlint/anti-slop/` — vendored plugin source (generic + Effect rules,
  plus the nested `vendor/eslint-stylistic/` adaptation used by
  `require-readable-spacing`).
- `oxlint.config.ts` — registers both plugins and enables every applicable
  rule at `"error"`.
- `scripts/anti-slop-smoke.mjs` — repeatable smoke test (see below).

## Enabled rules

Generic (`anti-slop/*`, 18 rules) plus the native companion rule:

`oxc/no-accumulating-spread`, `no-array-filter-map`,
`no-reduce-accumulator-copy`, `no-chained-type-assertions`,
`no-conditional-empty-object-spread`, `no-known-value-widening`,
`no-module-mocking`, `no-object-parameters`, `no-reflect-apply`,
`no-reflect-get`, `no-runtime-typeof`, `no-shape-in-symbol-names`,
`no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`,
`no-unsafe-dictionary-type`, `no-widen-then-assert`,
`require-readable-spacing`, `require-safety-comment-for-type-assertion`.

Effect (`anti-slop-effect/*`, 5 rules), enabled because `effect-port/package.json`
declares `effect` as a direct dependency:

`no-manual-effect-error-tag`, `no-manual-tag-comparison`,
`no-manual-tagged-construction`, `no-service-constructor-imports`,
`prefer-effect-match`.

No rule was disabled or downgraded to make existing application source pass.

## Running lint

```bash
cd effect-port
bun run lint
```

This runs `oxlint src tests scripts` using `oxlint.config.ts`. As of this
installation, lint reports real findings against the existing application
source and tests — see `evidence/anti-slop-lint.txt` (full output) and
`evidence/anti-slop-lint-rule-breakdown.txt` (counts per rule). The bulk of
findings are `require-readable-spacing` (blank-line formatting); the rest are
substantive `anti-slop`/`anti-slop-effect` findings. **Application cleanup is
lead's decision, not performed here** — this installation only enables and
verifies the rules.

## Smoke test

```bash
cd effect-port
bun run lint:anti-slop-smoke
```

`scripts/anti-slop-smoke.mjs` writes two fixtures under the git-ignored
`.test-output/anti-slop-smoke/` directory and lints each individually:

1. `violation.ts` — a deliberate `state._tag === "Ready"` comparison. Expected:
   exit code `1` and an `anti-slop-effect(no-manual-tag-comparison)` finding.
2. `corrected.ts` — the same logic rewritten with `Predicate.isTagged("Ready")`.
   Expected: exit code `0`, no anti-slop findings at all.

The script asserts both expectations and fails loudly (non-zero exit) if
either fixture's actual behavior doesn't match — it does not fabricate a
passing result. See `evidence/anti-slop-smoke.txt` for a captured run.

## Dependencies

`oxlint` and `@oxlint/plugins` are pinned to the exact same version,
`1.82.0`, in `devDependencies`. `effect-port` had no prior `oxlint`
dependency, so this version was resolved from npm `latest` at install time
per the bundled skill's fresh-install procedure (it happens to match the
repository root's own pin). All previously pinned dependencies (`effect`,
`typescript`, `@effect/tsgo`) and the existing `prepare` script are
unchanged.

## Lead verification after integration

The installation result was accepted in Marionette after independently checking all seven claimed file hashes, eleven registered artifacts, the live upstream HEAD, and the two-case rule smoke test. The saved worker typecheck log captured temporary errors during concurrent native-adapter edits; its report incorrectly attributed that failure to language-service suggestions. The final `npm run check` and `bun run check` both pass. The full lint snapshot remains a separate set of findings and has not been represented as a clean lint run.
