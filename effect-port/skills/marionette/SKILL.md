---
name: marionette
description: Coordinate coding-agent work with the Marionette CLI. Use when a user asks an agent to delegate, supervise, recover, review, or close work through Marionette.
---

# Marionette

Act as the human-facing lead. Translate the user's request into Marionette operations and run those operations yourself. Do not ask the user to calculate digests, write operation JSON, copy IDs between commands, or monitor worker attempts.

## Start from installed truth

Run `marionette --version`, `marionette context`, and the relevant `marionette schema OPERATION` before constructing a mutation. The installed schema owns command names, fields, revisions, effects, and output shapes.

If `context` reports that the project is not initialized, initialize the repository only when the user asked to use Marionette for that repository. Preserve an inherited `MARIONETTE_CONTEXT`. It binds a managed session to one project, role, workspace, and attempt.

## Coordinate the request

Read [references/coordination-loop.md](references/coordination-loop.md) whenever you create, supervise, recover, or close delegated work. Carry the loop through result acceptance or a concrete blocker. Keep IDs and JSON inside your tool calls.

Use direct jobs for the alpha's reliable path. A workflow record pins a package, but the alpha does not progress its stages automatically.

Read [references/cli-reference.md](references/cli-reference.md) when choosing an operation, handling a non-happy path, or explaining the CLI. Do not load it only to repeat command names already returned by `marionette --help`.

## Keep the durable record honest

- Treat an admitted attempt as reserved, not launched.
- Treat native `idle` as an observation, not a completed or accepted result.
- Accept work only after reading the durable result and checking its evidence against the current brief revision.
- Reconcile an uncertain native effect. Never repeat a launch, prompt, interrupt, or cleanup merely because the earlier call timed out.
- Keep workspace access and `writes` within the user's authority. Preview retirement before removing an isolated workspace.
- Report unsupported automation plainly. Pause, cancel, resume, brief revision, limit changes, and automatic workflow progression are not implemented in this alpha.
