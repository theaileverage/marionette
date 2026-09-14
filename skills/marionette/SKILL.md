---
name: marionette
description: Coordinate coding-agent work with the Marionette v1 CLI. Use when a user asks an agent to delegate, supervise, recover, integrate, review, or close work through Marionette.
---

# Marionette

Act as the human-facing lead. Translate the user's request into Marionette operations and run those operations yourself. Do not ask the user to calculate digests, write operation JSON, copy IDs between commands, or monitor worker attempts.

This repository uses `1.0.0-alpha.1`. Marionette MCP and its HTTP supervisor are retired.

## Start from installed truth

Run `marionette --help` once for the command inventory, then `marionette schema OPERATION` immediately before each mutation family. The installed schema owns command names, fields, effects, and output shapes. Do not infer CLI grammar from operation names, from an earlier version, or from another repository's usage.

Commands are grouped words; JSON operations are dotted. `marionette brief acknowledge --attempt-id ID` on the command line carries `"operation": "brief.acknowledge"` inside `--input` or `--json`. Utility commands (`schema`, `describe`, `init`, `watch`, `--version`) take only their own flags and reject operation flags such as `--project`.

Run `marionette context` from the repository. If it reports the project is not initialized, initialize only when the user asked to use Marionette for that repository. Preserve an inherited `MARIONETTE_CONTEXT`: it binds a managed session to one project, role, workspace, and attempt, and `--project` cannot replace it.

## Keep a typed ID ledger

The schema types most identifiers as plain `string`, so it cannot catch a result ID passed where a job ID belongs. Record every returned ID next to its semantic type and pass it only where that type is expected. `job.create.dependencies` takes job IDs; `attempt.admit.inputResultIds` takes accepted result IDs. Read the related object before referencing it — the schema describes field types, not relational invariants.

## Coordinate the request

Read [references/coordination-loop.md](references/coordination-loop.md) whenever you create, supervise, recover, integrate, or close delegated work. It carries the loop through result acceptance or a concrete blocker, and holds the unknown-mutation, handoff-sequencing, and verification-environment procedures.

Read [references/cli-reference.md](references/cli-reference.md) when choosing an operation, composing a request, or handling a non-happy path. Do not load it only to repeat command names already returned by `marionette --help`.

Use direct jobs for the alpha's reliable path. A workflow record pins a package, but the alpha does not progress its stages automatically.

## Keep the durable record honest

- Treat an admitted attempt as reserved, not launched. `attempt admit` can also start a watcher.
- Treat native `idle` as an observation, not a completed or accepted result.
- Treat an error carrying `mutation: "unknown"` as uncertain. Read state and reconcile. Never replay a launch, prompt, interrupt, claim, or cleanup merely because the earlier call was interrupted or timed out.
- Accept work only after reading the durable result and checking its evidence against the current brief revision. Accept an honestly failed verification only after independently running the missing checks and recording that basis.
- Keep workspace access and `writes` within the user's authority. Preview retirement with `--dry-run` before removing an isolated workspace.
- Plan delivery around one target writer reservation at a time. Aggregate several accepted results through one reservation, or sequence one handoff at a time.
- Report unsupported automation plainly. Pause, cancel, resume, brief revision, limit changes, and automatic workflow progression are not implemented in this alpha.
