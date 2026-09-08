---
name: marionette
description: Coordinate persistent coding, research, and review workers through Marionette using its MCP tools or CLI. Use when asked to use Marionette, act as its lead, or complete an assignment in a Marionette worker pane.
---

# Marionette

Marionette is a persistent supervisor for agent CLIs in Herdr. Leads use a fenced lease; workers use an attempt-scoped environment credential. Read the role you are performing below. Use Marionette for managed task dispatch and lifecycle; direct Herdr operations do not create Marionette assignments or satisfy acceptance checks.

## Connect and establish context

Prefer connected Marionette MCP tools. MCP names use underscores (`project_briefing`); CLI action names use dots (`project.briefing`). Read the tool's input schema before constructing a call.

For CLI access, use the installed `marionette`, or `node /absolute/package/dist/cli.js` for a source build. Commands discover the project binding from the working directory; pass `--home /absolute/state/directory` for a selected instance. Start with:

```sh
marionette projects
marionette briefing PROJECT_ID
marionette inbox PROJECT_ID --consumer stable-lead-name
```

Read the selected project's briefing, decisions, outstanding questions, and inbox before dispatch. Keep IDs from responses; do not infer workspace, task, revision, or lead identity from names or UI focus. Use `task_get` / `task.get` for targeted detail.

If setup is needed, `marionette setup --schema` and `setup --help` describe the installed options. `setup --json --project /absolute/project --lead codex-desktop --lead-name NAME` creates/reuses the named session, supervisor and project binding and configures the selected lead. Setup's `--dry-run` previews its effects. Preserve an existing installation and saved lead. `doctor` diagnoses connections; deleting state is not a recovery step.

## Lead workflow

Read a supplied bootstrap prompt and private lease file locally. Keep the token out of prose, artifacts, and logs. A CLI mutation accepts `--lease /private/path/lead.json`; an MCP mutation accepts the equivalent `lease` object. Acquire control only for initial establishment or an authorized takeover. `lead_handover` / `lead.handover` transfers the lease and invalidates the old one. Do not take over merely because another lead is quiet.

Submit an assignment with a stable idempotency `key`, an objective, `kind` (`codex`, `claude`, or `agy`), bounded `ownership`, and meaningful `checks`. See [assignment and outcome examples](references/coordination.md) when constructing inputs.

- Ownership paths are literal files or directory prefixes relative to the task's working directory, not globs. Workers share files unless explicitly placed in a worktree. Preserve concurrent edits.
- Assess file conflicts before choosing execution. Use shared mode for disjoint work or deliberate access to uncommitted changes. Recommend worktree mode for overlapping work and obtain a choice when the workflow has not already been authorized. Worktrees start from committed HEAD or `baseRef`; source edits and dependency branches are not automatically copied or merged.
- Submission returns before startup. A queued assignment may be waiting for dependencies, ownership, provider/model limits, or project capacity. Read its wait reason before retrying.
- After a lost submission response, reuse the same key and identical input. A changed objective needs a redirect/revision with its own key, not a duplicated assignment.
- Use `task_control` / `task.control` for reply, pause, cancel, redirect, or explicit keys. Cancellation retains the worker terminal. A worker's native permission UI requires inspecting the actual screen and resolving the specific request.

For durable multi-step outcomes, create criteria with `outcome_create`, attach assignments to the outcome and current tree revision, and use `plan_revise` with current revisions and reasons for changes. Review evidence independently. Finish with criterion assessments, integrated review, and `outcome_complete`; worker prose and terminal idle status are insufficient. Required failed, cancelled, stale, or unverified work prevents completion.

When no independent work remains, register `lead_wait` with an observable condition and yield. A Herdr adapter must pin the actual lead pane, terminal, agent name/kind, and native session obtained through `project_inspect`. Desktop leads use the `next-message` adapter: MCP alone does not wake an idle conversation. Read and acknowledge inbox events on later turns; do not hold a model turn open polling. Save checkpoints before handover or consequential context changes.

Completion retains Git worktrees and branches. Follow existing authorization for review, merging, publishing, and cleanup; task completion itself does not authorize publication. Use `cleanup_preview` before explicit release/delivery/archive/collection. Pane-aware workers can share a tab, so never close a worker's entire tab manually to release one worker.

## Worker workflow

Your launch prompt is the task contract: preserve its ID, current revision, working directory, owned paths, and checks. Use its exact durable worker CLI path. Credentials are already in `MARIONETTE_WORKER_TOKEN`, `MARIONETTE_TASK_ID`, and `MARIONETTE_URL`; do not print them or acquire a lead lease.

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

Use the actual revision and artifacts. Other report types are `progress`, `blocked`, and `failure`. For a question, report `blocked` with the precise question in `summary`, then yield. Request normal sandbox permission if the report command cannot reach the local supervisor. Finish your native turn after the report so Marionette can observe settlement and verify checks.

Only workers explicitly granted `canDelegate` may create children, through `worker-call` action `delegate`. Children stay within the parent's ownership and inherited budget. Read current state through `worker-call` action `inspect`; mutations include the current parent revision. After delegation, report `yield` at the returned `parentRevision`, end the turn, and stop editing delegated paths until resumed. Integrate child evidence and pass your own checks before completing.

## Recover uncertainty

An `uncertain` run means delivery or creation lost confirmation. Inspect the recorded pane and output, then use `task_reconcile` with evidence and `delivered` or `not-delivered`. Do not replay automatically. A creation interruption cannot be marked delivered because no task prompt was attempted. Ambiguous split membership or an occupied orphan pane requires manual inspection; recovery preserves it. Explicit retries consume the task's bounded attempts and preserve its worktree.

## Programmatic Herdr control

For explicitly requested terminal control or integration code, read [the thin SDK guide](references/herdr-sdk.md). The SDK controls terminals; it does not enforce Marionette leases, task ownership, or verification. Use task controls for Marionette-managed workers.
