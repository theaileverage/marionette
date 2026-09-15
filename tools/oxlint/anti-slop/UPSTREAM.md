# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop

Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (merge of PR #36,
"contrib/effect-tag-match-rules", authored 2026-09-10T09:53:24-04:00).
Inspected directly from a fresh clone of the upstream repository on
2026-09-14, not copied from a possibly-stale bundled skill; verified
`src/` and `skills/install-anti-slop/assets/anti-slop/` were byte-identical
(excluding `*.test.ts`) at this commit before vendoring.

Copied with upstream's `skills/install-anti-slop/scripts/install.mjs` into
`effect-port/tools/oxlint/anti-slop/`. Both the generic `anti-slop` plugin
and the opt-in `anti-slop-effect` plugin are registered in
`effect-port/oxlint.config.ts`, because `effect-port/package.json` declares
`effect` as a direct dependency. The original MIT license is included at
`LICENSE`; the nested `vendor/eslint-stylistic/` directory carries its own
`LICENSE` and `UPSTREAM.md` for the vendored `padding-line-between-statements`
adaptation used by `require-readable-spacing`.

## Installed plugin paths

- `effect-port/tools/oxlint/anti-slop/index.ts` — generic plugin (18 rules).
- `effect-port/tools/oxlint/anti-slop/effect/index.ts` — Effect plugin (5 rules).

## Deviations from upstream

None. This is a pristine copy of the upstream `src/` tree at the pinned
revision; no local rule, helper, or configuration changes were made.

## Dependencies

`oxlint` and `@oxlint/plugins` are pinned to `1.82.0` in
`effect-port/package.json` (devDependencies). `effect-port` had no prior
`oxlint` dependency, so both packages were installed at the current npm
`latest` version at install time (`npm view oxlint version` /
`npm view @oxlint/plugins version`, both `1.82.0`), per the bundled skill's
fresh-install procedure. This also matches the root repository's pinned
`oxlint`/`@oxlint/plugins` version.

## Maintenance

These files are maintained as vendored source, scoped to `effect-port` only.
Review upstream changes and run `bun run lint` and
`bun run lint:anti-slop-smoke` in `effect-port/` when updating them. Keep
`oxlint` and `@oxlint/plugins` pinned to the same version, compatible with
`@effect/tsgo` and TypeScript 7.
