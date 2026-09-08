# Contributing

Use Bun 1.3.14 or newer and install dependencies with `bun install --frozen-lockfile`. Run `bun run check`, `bun run test`, `bun run build` and `bun run format:check` before opening a pull request. Describe the concrete behavior change and its validation. Keep tests deterministic; the standard suite must not start paid agent sessions or depend on a developer's Herdr configuration.

Edit the lead prompt in [`src/templates/lead.mustache`](src/templates/lead.mustache).
It is a plain-text Mustache template shared by setup, lead launch, and MCP
instructions. The optional `session` section receives `leadName`, `projectName`,
`projectId`, and `leasePath`; triple braces preserve their literal text without
HTML escaping. Keep session-specific details inside that section. Run
`bun test tests/prompts.test.ts tests/lead-terminal.test.ts` to check rendering
and terminal compatibility. Source commands load template edits on their next
start; run `bun run build` to embed them in the distributed CLI and MCP bundles.

Worker wording lives beside it: `worker.mustache` contains the assignment,
scope, inspection, worktree, and reporting instructions; `worker-delegation.mustache`
and `worker-strategy.mustache` are conditional partials; `worker-followup.mustache`
handles child results, lead answers, and replacement objectives. Task data and
shell-quoted CLI commands are prepared in `src/prompts.ts` and `src/supervisor.ts`.
Use triple braces for literal text and the prepared `*Json` fields inside JSON
examples. Templates and partials are embedded during the same build. Run
`bun test tests/prompts.test.ts tests/orchestration.test.ts` after worker edits.

The project pins Bun, Effect v4, and TypeScript 7. Commit `bun.lock`; do not generate an npm lockfile. `bun install --frozen-lockfile` runs the `prepare` script to
patch the local TypeScript and Oxlint binaries with `@effect/tsgo`. If dependencies
were installed with lifecycle scripts disabled, run `bun run prepare` before
checking code. `bun run check` includes Effect compiler diagnostics and Oxlint;
`bun run effect:diagnostics` prints the Effect diagnostics separately. Run
`bun run tooling:check` to verify that valid Effect code passes and deliberate
floating Effects and unsafe casts fail. CI performs this check after installation.
`bun run runtime:check` exercises failed startup and concurrent shutdown through
the real server boundary; it requires permission to bind loopback sockets.

Read the [Effect skill](.agents/skills/effect/SKILL.md) and its relevant references
before changing application workflows. The skill is from
[kitlangton/skills](https://github.com/kitlangton/skills/tree/main/skills/effect).
Use the installed `effect` package source to verify APIs for the pinned release.
The [runtime guide](documentation/effect-runtime.md) explains resource ownership,
transport boundaries, and the durable-state invariants the migration preserves.
For VS Code or Cursor, install the TypeScript 7 extension and select the workspace
TypeScript version; `.vscode/settings.json` configures the native language server.

The [vendored anti-slop rules](tools/oxlint/anti-slop/UPSTREAM.md) enforce evidence
for casts, parsed boundaries, and Effect service imports. All generic rules and
the Effect rule group are errors. Fix the underlying contract instead of disabling
rules. Generated Herdr protocol types, vendor code, built output, agent assets and
local runtime state are excluded from lint. Keep `oxlint` and `@oxlint/plugins`
at the same exact version and within `@effect/tsgo`'s supported versions.

Keep generated bundles, local agent configuration, `.env` files, `.marionette` state, `.runtime` fixtures and credentials out of commits. The reviewed `.agents/skills/effect` guidance is tracked; other local agent configuration remains ignored. Live validation scripts are opt-in and use explicitly named isolated sessions. Never point them at someone else's active session.

Changes enter `main` through pull requests. Release preparation and publication follow [RELEASING.md](RELEASING.md). Marionette is licensed under [MIT](LICENSE); bundled third-party licenses are preserved in `THIRD_PARTY_NOTICES.md`.
