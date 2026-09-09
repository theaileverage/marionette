---
name: marionette
description: Coordinate persistent coding, research, and review workers through Marionette using its MCP tools or CLI. Use when asked to use Marionette, act as its lead, or complete an assignment in a Marionette worker pane.
---

# Marionette

Marionette is a persistent supervisor for agent CLIs in Herdr. Leads use a fenced lease; workers use an attempt-scoped environment credential. Read the role you are performing below. Use Marionette for managed task dispatch and lifecycle; direct Herdr operations do not create Marionette assignments or satisfy acceptance checks.

## Connect and establish context

Prefer connected Marionette MCP tools. MCP names use underscores (`project_briefing`); CLI action names use dots (`project.briefing`). Read the tool's input schema before constructing a call. Check `isError` before consuming every response; an error response is still a truthy object. `structuredContent.ok` also states success. Never use `Boolean(response)` to infer success.

For CLI access, use the installed `marionette`, or `bun /absolute/package/dist/cli.js` for a source build. Commands discover the project binding from the working directory; pass `--home /absolute/state/directory` for a selected instance. Start with:

```sh
marionette projects
marionette briefing PROJECT_ID
marionette inbox PROJECT_ID --consumer stable-lead-name
```

Read the selected project's briefing, decisions, outstanding questions, and inbox before dispatch. Keep IDs from responses; do not infer workspace, task, revision, or lead identity from names or UI focus. Use `task_get` / `task.get` for targeted detail.

If setup is needed, `marionette setup --schema` and `setup --help` describe the installed options. `setup --json --project /absolute/project --lead codex-desktop --lead-name NAME` creates/reuses the named session, supervisor and project binding and configures the selected lead. Setup's `--dry-run` previews its effects. Preserve an existing installation and saved lead. `doctor` diagnoses connections; deleting state is not a recovery step.

`marionette update --check` reports available updates; `update` and `upgrade` update the shared instance and its project bindings/MCP registrations, with rollback on startup failure. Setup offers migration for an older saved runtime; scripted setup requires `--upgrade`. Workspace trust is the general `trustWorkspaces` option for Codex, Claude Code, and AGY; `--no-trust-workspaces` retains native workspace prompts without changing tool approvals.

Harness launch access is separately configured through setup's `agentAccess` map or `project_configure`. Each of `codex`, `claude`, and `agy` accepts `inherit` (native settings, the default) or `full-access` (disable harness sandbox and approval prompts for future terminal sessions). Change this policy only when the user has authorized it. Existing sessions and Codex desktop app permissions are unchanged; host-managed restrictions still apply. See the README's Harness access section for configuration examples.

For user-requested removal, inspect `remove --dry-run` or `uninstall --dry-run --global` first. `remove` targets the current project (`--project DIR` or `--project-id ID` selects another); `uninstall` removes the selected instance, with `--global` also removing detected Bun/npm CLI installs. Source files and Git branches are preserved. Resolve active tasks, pending operations, and managed worktrees first. Closing verified agent panes requires explicit `--stop-agents`; `--keep-herdr` retains terminal resources. Noninteractive deletion requires `--yes`. Never use removal as a repair shortcut.

## Lead workflow

Read a supplied bootstrap prompt and private lease file locally. Keep the token out of prose, artifacts, and logs. A CLI mutation accepts `--lease /private/path/lead.json`; an MCP mutation accepts the equivalent `lease` object. Acquire control only for initial establishment or an authorized takeover. `lead_handover` / `lead.handover` transfers the lease and invalidates the old one. Do not take over merely because another lead is quiet.

If the user already supplied the objective, start it; do not create an intake outcome merely to receive a message. For a simple task, `task_submit` without `outcomeId` atomically creates an outcome from its prompt, ownership and checks. Use a separate outcome or strategy only when the work needs one.

Submit an assignment with a stable idempotency `key`, an objective, `kind` (`codex`, `claude`, or `agy`), bounded `ownership`, and meaningful `checks`. See [assignment and outcome examples](references/coordination.md) when constructing inputs.

- `outcome.scope` is also a filesystem boundary, never prose. Repair a mistaken scope with `outcome_revise`, `scope`, and a reason; omitted criteria remain intact. Do not create duplicate outcomes to fix scope.
- With `outcomeId` or `parentId`, supply `expectedTreeRevision` from the current outcome. Submissions return the new `treeRevision`; the first revision is 1. Check timeouts are 100–120000 ms. Read-only reviewers use `readOnly: true`, `ownership: []`, and `canDelegate: false`.
- Ownership paths are literal files or directory prefixes relative to the task's working directory, not globs. Workers share files unless explicitly placed in a worktree. Preserve concurrent edits.
- Assess file conflicts before choosing execution. Use shared mode for disjoint work or deliberate access to uncommitted changes. Recommend worktree mode for overlapping work and obtain a choice when the workflow has not already been authorized. Worktrees start from committed HEAD or `baseRef`; source edits and dependency branches are not automatically copied or merged.
- Submission returns before startup. A queued assignment may be waiting for dependencies, ownership, provider/model limits, or project capacity. Read its wait reason before retrying.
- After a lost submission response, reuse the same key and identical input. A changed objective needs a redirect/revision with its own key, not a duplicated assignment.
- Use `task_control` / `task.control` for reply, pause, cancel, redirect, or explicit keys. Cancellation retains the worker terminal. A worker's native permission UI requires inspecting the actual screen and resolving the specific request.

For durable multi-step outcomes, create criteria with `outcome_create`, attach assignments to the outcome and current tree revision, and use `plan_revise` with current revisions and reasons for changes. Review evidence independently. Finish with criterion assessments, integrated review, and `outcome_complete`; worker prose and terminal idle status are insufficient. Required failed, cancelled, stale, or unverified work prevents completion.

When no independent work remains, register `lead_wait` with an observable condition and yield. A Herdr adapter must pin the actual lead pane, terminal, kind, and native session obtained through `project_inspect`. The launch name may be omitted when the native session is pinned. After `lead_wait`, verify a returned wait ID and state; a failed wait registers no continuation. Desktop leads use the `next-message` adapter: MCP alone does not wake an idle conversation. Read and acknowledge inbox events on later turns; do not hold a model turn open polling. Save checkpoints before handover or consequential context changes.

Completion retains Git worktrees and branches. Follow existing authorization for review, merging, publishing, and cleanup; task completion itself does not authorize publication. Use `cleanup_preview` before explicit release/delivery/archive/collection. Pane-aware workers can share a tab, so never close a worker's entire tab manually to release one worker.

## Optional swarm operations

Load `swarm_recipe_get` only at a relevant trigger: diagnose for bugs, investigate for knowledge work, compare-approaches for experiments, review-repair for evaluation gaps, deliver for handoff, recover for interrupted work, and catch-up for status. These are versioned optional methods. See [recipes](references/recipes/) and the repository's [runtime contracts](../../documentation/swarm-runtime.md).

Use `swarm_intent_amend` for a user correction, with an explicit outcome, current revision, source and affected tasks. Use `swarm_message_send` for selected context. Required instructions remain pending until the recipient acknowledges; progress does not close `swarm_decision_open` records. Resolve each decision explicitly. `swarm_dispatch` submits a batch graph against one revision. A settled parent can retain disjoint paths through `swarm_ownership_transfer` and then resume alongside selected children. Fixed capacity remains the migration default; adaptive admission is an explicit policy change.

Use `swarm_observe` to distinguish current observations from unknown state. Register safely repeatable external queries with `swarm_watch_create`; keep actions out of probes. Add watch or decision IDs to `lead_wait` so previously captured results are not missed. `swarm_experiment_create` pins isolated candidates to a common Git base and checks; compare, select with evidence, settle alternatives, then integrate separately. Record delivery expectations independently. Preserve trajectories and assess strategy improvements using measured trials rather than fabricated usage.

## Worker workflow

Your launch prompt is the task contract: preserve its ID, current revision, working directory, owned paths, and checks. Prefer the `marionette_worker` MCP tools (`worker_inspect`, `worker_report`, `worker_call`) when present. Codex workers receive this scoped STDIO server at launch; it forwards only the attempt credential and leaves sandbox settings unchanged. The server validates its inspection connection at startup. The CLI remains available for other agents and older sessions; use the exact durable worker CLI path. Credentials are already in `MARIONETTE_WORKER_TOKEN`, `MARIONETTE_TASK_ID`, and `MARIONETTE_URL`; do not print them or acquire a lead lease.

If a CLI transport fails, use scoped MCP or request normal network permission for the exact command (`sandbox_permissions="require_escalated"` in Codex). Do not repeat the same sandboxed call or assume the supervisor is down. Inspect the current task/receipt after an uncertain report before resending it.

Write request/report JSON under `.marionette-reports/TASK_ID/` in the task working directory. Run the supplied `worker-report --file /absolute/report.json` command with, for example:

```json
{
  "revision": 1,
  "type": "complete",
  "summary": "Implemented the assigned behavior and verified it",
  "artifacts": ["src/owned-file.ts"],
  "evidence": ["Actual command and result"]
}
```

Use the actual revision and artifacts. Other report types are `progress`, `blocked`, and `failure`. For a question, report `blocked` with the precise question in `summary`, then yield. Request normal sandbox permission if the report command cannot reach the local supervisor. Continue useful work after a progress report. Finish the native turn after completion, failure, a blocker, or yield so Marionette can observe settlement and verify checks. Read pending instructions with worker_inspect and acknowledge them individually using message.ack with the current revision and messageId.

Only workers explicitly granted `canDelegate` may create children, through `worker-call` action `delegate`. Children stay within the parent's ownership and inherited budget. Read current state through `worker-call` action `inspect`; mutations include the current parent revision. After delegation, report `yield` at the returned `parentRevision`, end the turn, and stop editing delegated paths until resumed. Integrate child evidence and pass your own checks before completing.

## Recover uncertainty

An `uncertain` run means delivery or creation lost confirmation. Inspect the recorded pane and output, then use `task_reconcile` with evidence and `delivered` or `not-delivered`. Do not replay automatically. A creation interruption cannot be marked delivered because no task prompt was attempted. Ambiguous split membership or an occupied orphan pane requires manual inspection; recovery preserves it. Explicit retries consume the task's bounded attempts and preserve its worktree.

## Programmatic Herdr control

For explicitly requested terminal control or integration code, read [the thin SDK guide](references/herdr-sdk.md). The SDK controls terminals; it does not enforce Marionette leases, task ownership, or verification. Use task controls for Marionette-managed workers.
