# Outcome orchestration in 0.2

A lead defines observable criteria, dispatches bounded work, waits for meaningful events, and evaluates the integrated result. Marionette persists and enforces that contract across the full delegation tree. The same authenticated service implements CLI, MCP, and dashboard actions.

## Establish the outcome

Save an input file containing:

```json
{
  "outcome": {
    "projectId": "PROJECT_ID",
    "key": "invoice-outcome-v1",
    "objective": "Deliver an invoice summarizer with correct fractional cents",
    "scope": ["src", "tests", "review"],
    "category": "software",
    "criteria": [
      {
        "id": "correctness",
        "description": "Fractional prices total correctly and invalid prices are rejected",
        "requiredEvidence": "Independent acceptance tests and a review artifact"
      }
    ],
    "maxTurns": 60,
    "maxDepth": 3
  }
}
```

```sh
marionette call outcome.create --file outcome.json --lease /private/path/lead.json
```

Categories are `software`, `research`, `analysis`, and `decision`; evidence can be source notes, experiments, comparisons, decision records, or executable checks. Give assignments the returned `outcomeId` and its current `expectedTreeRevision`. Add `parentId` for accountable child work. Add a reason when extending the plan. Stale tree/task revisions and cycles are rejected.

To finish, use `outcome.assess` for each `criterionId`, supplying the current `expectedRevision`, `rationale`, and `references` array. Then use `outcome.integrate` with an independent `summary` and `references`, followed by `outcome.complete`. Each call needs the lead lease and outcome ID. References must resolve to regular files; their digests are stored. For a managed checkout, use `task:TASK_ID:relative/owned/file`.

Completion rejects any required failed, cancelled, blocked, unverified or stale task, missing criterion evidence, stale strategy result, or missing integrated review. Every required descendant must pass, and a parent must pass its own checks. An outcome with no worker tasks can still be assessed directly against real evidence.

## Evolve the plan and delegate

`plan.revise` requires `taskId`, `expectedRevision`, `expectedTreeRevision`, `reason`, optional evidence references, and a `patch`. Supported changes include criteria/checks, prompt, title, dependencies, required status, and explicit supersession. Create split tasks with `task.submit` or scoped delegation, then supersede the old requirement with its concrete replacement. A reason and revision history expose changes to the completion contract.

New required work reopens affected parents and outcomes. Changed artifact digests invalidate affected verification and downstream work while preserving unaffected results. Routine board history contains summaries; `plan.get` reads the full before/after record on demand.

A task needs `canDelegate: true` to request children. Workers receive an attempt-scoped credential and use:

```sh
marionette worker-call --file request.json
marionette worker-report --file report.json
```

Scoped actions are `inspect`, `finding`, `delegate`, `revise`, and `control`. Mutation requests carry the current parent `revision`; delegation contains an `assignment`. Children cannot expand the parent's ownership or outcome scope, change root criteria, or control unrelated tasks. They inherit the parent's effective checkout and applicable limits. A child in a managed worktree shares its parent's branch; it does not create another checkout.

After delegating, the parent reports `type: "yield"` using the returned `parentRevision`, ends its native turn, and stops editing transferred paths. Once the native turn settles, its execution slot and ownership reservation are released. Verified child results produce a compact continuation in the same parent run and native session. The parent evaluates and integrates the result before reporting completion. Pause/cancel controls cascade through descendants. Findings remain visible to the root lead.

Ownership is a scheduling/reporting contract, not an operating-system sandbox. Native agent permissions remain in force.

## Shared execution limits

`limits.configure` accepts a reason and `limits` with `global` (1–32, default 8), `project` (1–8, default 3), optional `providers` keyed by `codex`, `claude`, `agy` (1–16), and optional exact `models` (1–16). Existing project concurrency also applies. Global/provider/model settings are shared across the instance and count activity across registered projects; configuring them updates that shared policy. Profile concurrency is 1–8, default 2.

Outcome `maxTurns` is 1–1000 (default 60), shared by all worker dispatches, parent resumptions, controls that send new prompts, and automatic lead continuations. It counts Marionette-triggered execution turns, not internal tool/model calls. It is not a token or dollar spending cap. `maxDepth` is 0–6 (default 3). Queued tasks expose the limiting reason. Waiting coordinators release capacity after settling; active lead continuations reserve capacity until their native turn settles. Existing turns are not forcibly stopped when limits are reduced.

## Wait without model polling

`lead.wait` persists a unique `key`, `outcomeId`, a condition, and an adapter. Conditions support task `all`/`any`/`quorum`, strategy quorum, answered questions, and intervention events. Failed/cancelled results can trigger a continuation; they never count as successful outcome completion. Routine events are grouped, while blocking questions and findings can trigger prompt intervention.

A Herdr adapter pins `paneId`, `terminalId`, `name`, `kind`, and the observed `nativeSession`. Only use identifiers obtained from the explicitly selected session. The supervisor verifies the original identity and current lead ownership, waits for readiness and capacity, then appends one compact delivery with a durable ID. Busy or blocked leads retain their queued delivery. Restart during ambiguous delivery produces `uncertain`, requiring inspection and `lead.reconcile`; it does not replay automatically. Handover fences the old lead and requires a fresh wait for the receiving session.

For Codex desktop or another client without a supported injection API, use `{ "type": "next-message" }`. `lead.pending` retrieves the durable message on the user's next turn; `lead.ack` acknowledges it. MCP alone cannot wake an idle desktop conversation. `adapter.capabilities` states the supported boundary.

On the tested Herdr 0.8.2 installation, native screen/status detection became stale when the session had no attached client. Keep a client attached to the named session for reliable native readiness observation. Marionette preserves uncertain state rather than assuming delivery succeeded. No permission prompts are automatically approved.

## Checkpoints, cache and cost

Wait registration saves a checkpoint with the objective, decisions, remaining criteria, and evidence references. `checkpoint.save` also accepts an explicit summary and `kind: "compaction"`; this records a deliberate compaction decision, but does not itself compact the provider conversation. Request native compaction only after saving the checkpoint and inspecting the exact settled session.

Native CLIs expose no verified user-selectable cache TTL here. Retention policy therefore uses the native provider default where observable, preserves the existing session and checkpoint, and never wakes a lead merely to keep a cache alive. API cache controls are not assumed to exist in a CLI. Claude's observed 1-hour cache counters are evidence from this account, not a guaranteed lifetime.

`usage.import` reads a local provider JSON/NDJSON file within the project. Supported records are Claude print results, Claude native assistant usage rows, and Codex `turn.completed` usage. Optional `runId` or `waitId` associates counters with the outcome's execution. Repeated assistant blocks and growing native transcripts are deduplicated by provider message identity. Import one representation per execution; do not combine aggregate print totals with the same run's individual transcript requests. AGY metrics and per-request native Claude dollar costs may be unavailable and remain `null`. Compaction-internal requests missing from the transcript are not silently estimated.

Routine coordination excludes full output and truncates prompt/receipt text. `task.get`, artifact references, and `plan.get` provide targeted detail. The browser requests full task details for its output drawer.

## Exact model profiles

0.2 includes 27 selectable profiles seeded from the native catalogs inspected on 8 September 2026: seven Codex, five Claude catalog configurations plus the evaluated Fable 5 profile, and fourteen AGY configurations. These are unverified seeds until checked on the current account. Category labels describe selectable uses, not comparative benchmark rankings.

`profile.discover` reads current native metadata: Codex app-server `model/list`, Claude SDK initialization model metadata, or `agy models`. It adds missing exact configurations and retains custom profiles, validation evidence, and defaults. Hidden Codex entries and ambiguous aliases are excluded. Discovery uses no model inference prompt.

`profile.configure` stores exact model ID, runtime, supported effort, capabilities, strengths, delegation permission and profile concurrency. Its optional `defaults` map selects a profile by task category. `profile.validate` explicitly probes Codex/Claude with tools disabled and verifies AGY's exact model catalog membership. The validation may incur a small provider charge. Metadata discovery and AGY catalog membership are not proof that a substantive task will succeed.

Assignments, council participants, and `lead --profile PROFILE_ID` can override category defaults. Setup also accepts `leadProfile` / `--lead-profile`. Explicit profile requests must validate; an unavailable model is not silently replaced. Runs retain the resolved model, effort and launch arguments separately from the display name. Unprofiled legacy runs retain their runtime defaults and label the exact model unreported.

AGY effort variants are encoded in their exact model IDs; Marionette does not add an unsupported `--effort` flag. Claude context variants such as `[1m]` remain part of the exact configured value. Catalogs are account/version dependent and can change.

## Collaboration strategies

`strategy.create`, `strategy.contribute`, `strategy.advance`, `strategy.finish`, and `strategy.reopen` provide bounded orchestration records. Supported kinds include parallel specialists, sequential work, councils, debates, competing proposals, and review/repair. They operate on ordinary accountable tasks; they do not create untracked agents.

Stage independent council/debate/proposal tasks with `deferStart: true`, then create the strategy so all participants receive the same initial protocol before dispatch. Contributions require verified participant results. Councils require quorum and a synthesis with an explicit disagreements array. Debates require fresh verified task revisions for later rounds, preserve earlier rounds, and enforce their round limit. Record claims, evidence, rebuttals, decision criteria and stop conditions. A strategy's completion never bypasses the outcome's own completion criteria.

Combine a sequential implementation/review dependency with new repair and re-verification tasks when findings warrant it. Record the original finding and reason, then assess the final integrated outcome. Fable 5 successfully coordinated continuation, delegated child work, synthesized a council and re-reviewed repaired software in acceptance; it also made unsupported source inferences that needed independent correction. It is a usable candidate, not an automatic authority or a demonstrated universal best model.

## Upgrade from 0.1

Stop the existing supervisor, retain its state, then start 0.2 with the same `--home` and rerun setup. Database schema 2 migrates legacy tasks into persistent implicit outcomes while preserving IDs, run identity, receipts, verification, leases and setup bindings. Newer database schemas fail closed. Old runtime directories remain available to existing workers.

Legacy submissions without an outcome remain compatible through implicit criteria derived from their assignment checks. New lead prompts establish an explicit outcome first. The 0.2 setup contract refuses an older running supervisor and prints the stop/start remedy instead of mixing protocol versions.

## Delivery, archival and cleanup in 0.2.1

Cleanup has five stages: verify the result, release execution resources, record delivery, archive evidence, and collect eligible Git resources. Task completion alone never deletes branches or worktrees. Project sessions and workspaces remain until the operator retires the project through Herdr.

`cleanup.preview` takes `taskId` and returns run identities, cleanup states, blocking consumers, delivery, archive and project policy without deleting anything. The dashboard exposes these operations under **Delivery and cleanup** in task details. Every mutation requires the current lead `lease` and a meaningful `reason`.

- `cleanup.release` takes `taskId` and optional `runId`. After the lead has inspected the result and decided that no native continuation is needed, it preserves bounded output and closes the settled worker's single-pane tab. Herdr has no separate worker-stop endpoint in protocol 20; closing that tab releases its terminal and worker together. The exact workspace, tab, pane, terminal, agent name/kind and native session must still match. Split tabs, busy agents, pending controls, lead waits, active dependent tasks and waiting parents prevent closure. Failed/cancelled results need this explicit inspection; their files remain intact.
- Automatic release defaults on and waits for a completed integrated outcome, a settled completed task, and no active consumers. It runs at most once per ten-second scan. Failed, blocked, paused, yielding and uncertain work stays available. A failed preflight is retained for inspection instead of being retried continuously.
- A close intent is durable before `tab.close`. Lost acknowledgements or restart during closure become `uncertain` and never replay automatically. `cleanup.reconcile` takes `taskId`, optional `runId`, and `resolution: "closed" | "not-closed"`. Closed requires both the original tab and terminal to be absent; not-closed requires the original settled identity. A later explicit release can retry a reconciled retained tab. Closing a tab manually is also recognized only after confirming the original terminal is absent.
- `cleanup.deliver` records `disposition: "merged" | "published" | "abandoned"` and, except for abandonment, `targetRef`. It performs no commit, merge, fetch or push. Supply a full branch ref such as `refs/heads/main`; published work requires a refreshed remote-tracking ref such as `refs/remotes/origin/review`. The clean worktree's HEAD must be an ancestor of that target. Local remote-tracking metadata must be refreshed using the normal Git workflow first. Squash/rebase integration without ancestry proof needs manual review; it is not inferred from similar content. Modified, untracked and ignored files block delivery and collection. Preserve or remove those files explicitly; collection never forces their removal.
- `cleanup.archive` seals all finished tasks sharing a managed checkout after every recorded worker terminal has been released and all live consumers have finished. Completed tasks require integrated outcome completion. It stores receipt artifacts, file-check evidence and referenced outcome evidence with SHA-256 digests, a manifest containing reports/checks/output and public run identity, and a standalone Git bundle retaining committed history, including abandoned unique commits. Files and directories are flushed before the durable archive record is committed. Archives live in `<state>/archives/<archive-id>` and remain private. Sealed tasks cannot resume or retry; create a new assignment for further work.
- `cleanup.collect` requires the preview's exact `archiveId`, `taskId`, and optional `deleteBranch` (default false). It rechecks archive integrity, original worker absence, all tasks/projects sharing the checkout, Git identity, clean files, delivery ancestry and unchanged evidence. It removes the worktree through non-forced `git worktree remove`. Merged branch deletion rechecks ancestry and compares the branch tip against the archived commit with `git update-ref -d REF EXPECTED_COMMIT`; a moved tip is retained and exposes a recoverable partial result. Explicit abandonment plus `deleteBranch: true` permits compare-and-delete of the exact archived branch tip after checking that no checkout uses it. Published PR branches remain until a subsequent merged or abandoned delivery decision. That decision and branch collection can happen after the worktree has already been removed.

Live files remain authoritative while the checkout exists: archival does not mask edits or stale verification. Once an authorized collection removes it, existing `task:TASK_ID:path` evidence references resolve to their verified archived bytes. Missing or tampered archived evidence still invalidates acceptance. An interrupted removal retains its phase and error; inspect and repeat `cleanup.collect` with the same archive ID. It checks whether Git actually removed the original worktree before proceeding. A branch that moved is preserved. No session, workspace, source checkout, remote branch, archive, or unrelated file is collected.

`cleanup.configure` stores a project-wide authorized retention policy:

```json
{
  "lease": { "projectId": "PROJECT_ID", "owner": "LEAD", "epoch": 1, "token": "PRIVATE" },
  "reason": "User authorized retaining delivered work for seven days",
  "policy": {
    "autoRelease": true,
    "collectAfterHours": 168,
    "deleteMergedBranches": false
  }
}
```

The default `collectAfterHours: null` retains worktrees until explicit collection; the default `deleteMergedBranches: false` retains branches. A configured delay begins at recorded delivery and never bypasses checks, archives or consumers. Only completed, delivered work is automatically archived and collected; failures and abandonment require explicit actions. Revoking/changing policy before a pending side effect stops that automatic operation. Cleanup errors remain in the inbox and archive/run records for inspection. Closing the supervisor drains cleanup operations along with other work; it does not initiate cleanup during shutdown.

Upgrade with `stop`, `start`, and setup using the existing state directory. The additive records retain schema 2 and existing run identities. A new supervisor is required for the cleanup tools; existing workers keep their versioned report executable paths.
