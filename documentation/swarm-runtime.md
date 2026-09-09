# General swarm coordination

Marionette retains one durable **outcome** per objective. The lead chooses strategy, decomposition, models and stopping decisions. The runtime provides scoped assignments, messages, evidence, resource admission and continuation. Herdr supplies terminal execution and observations. These operations are available through MCP and `marionette call`; this change adds no dashboard interface.

## Transport and migration

MCP tools use `swarm_` followed by the action with dots replaced by underscores. For example, `swarm_intent_amend` corresponds to CLI action `swarm.intent.amend`. Mutations require the current project lead lease. Reads do not. CLI inputs are JSON files:

```sh
marionette call swarm.intent.amend --file /absolute/amendment.json --lease /private/lead.json
```

Use the returned revisions. Keyed operations are idempotent for the exact same decoded input; a changed request requires a new key. All graph/record mutations are synchronous SQLite transactions. Native terminal calls, Git reads and external condition commands run outside those transactions. An accepted batch cannot be partially visible to the scheduler.

Existing installations retain saved fixed concurrency settings. Adaptive capacity is opt-in. Existing schema-2 databases accept the additional record kinds without changing tables. New outcomes capture `originalRequest` and `requestSource` from `outcome.create` separately from the lead's `objective` summary. If omitted, the initial objective and lead attribution are retained. Existing outcomes capture the available objective when first revised or amended; earlier user wording that was never stored cannot be recovered. Task implementation guidance remains in `prompt` and is returned in full by worker inspection.

## Intent, steering and decisions

`swarm.intent.get` takes `outcomeId` and returns the original objective, ordered amendments, intent version and current outcome revision. An amendment records its text, source, affected tasks and timestamp. It can also update the outcome's current objective:

```json
{
  "outcomeId": "OUTCOME_ID",
  "expectedRevision": 4,
  "key": "keep-navigation-1",
  "text": "Keep the existing navigation labels and behavior.",
  "source": "User correction in the onboarding discussion",
  "taskIds": ["WORKER_ID"],
  "objective": "Improve onboarding while preserving existing navigation"
}
```

Omit `taskIds` to address every nonfailed, noncancelled task in that outcome. Other outcomes are unaffected. Each affected task gets a new revision and loses obsolete completion evidence; ancestors and dependent results are invalidated through the existing graph rules. Completed or verifying tasks pause and need explicit resumption. Newly created workers receive the full current intent. Amendment source is attributed text, not proof of a separate user's identity.

`swarm.message.send` takes `outcomeId`, `key`, `taskIds`, `text`, optional file `references`, and optional `required` (default true). This explicitly shares selected findings or instructions. File references are captured with digests. It neither changes ownership nor interrupts a busy worker. Workers read their durable inbox with `worker_inspect`, then call:

```json
{ "request": { "action": "message.ack", "revision": 3, "messageId": "MESSAGE_ID" } }
```

Only the recipient's current attempt can acknowledge. The acknowledgement records run ID, revision and time. A required unacknowledged message prevents completion. Acknowledgement establishes receipt and acceptance; independent checks establish resulting behavior. Settled active sessions receive a bounded notification (at most three attempts, at least 90 seconds apart). Payloads remain in SQLite; a lost notification cannot lose the instruction. Notifications count against the outcome's turn allowance. Exhausted attempts produce an attention event. Paused workers resume explicitly.

Workers can send nonrequired messages to their parent, or, with delegation authority, their descendants using `worker_call` with `action: "message.send"`, `revision`, `key`, `taskId`, `text` and optional `references`. They cannot steer unrelated workers or acquire a lead lease. Ordered messages and acknowledgement records survive supervisor restart and lead handover. The project briefing includes current intent, pending messages and open decisions.

`swarm.decision.open` takes `outcomeId`, `key`, `text`, `source`, `options`, optional `taskId`, and `blocking` (default true). Worker `decision.open` uses its authenticated task and source. Progress, idle observations, and legacy question closure do not resolve these records. `swarm.decision.resolve` requires `decisionId`, its `expectedRevision`, `resolution` (`answered`, `superseded`, `withdrawn`), `answer` and `source`. Deliver resulting instructions separately. Blocking decisions prevent outcome completion.

## Flexible dispatch and ownership

`swarm.dispatch` submits up to 100 assignments with one outcome revision:

```json
{
  "outcomeId": "OUTCOME_ID",
  "expectedRevision": 1,
  "key": "initial-graph",
  "entries": [
    {
      "assignment": {
        "projectId": "PROJECT_ID",
        "key": "library",
        "title": "Implement library",
        "kind": "codex",
        "prompt": "Implement and test the library contract",
        "ownership": ["src/library"],
        "checks": [
          { "type": "command", "command": "bun", "args": ["test", "tests/library.test.ts"] }
        ]
      }
    },
    {
      "dependsOn": ["library"],
      "assignment": {
        "projectId": "PROJECT_ID",
        "key": "consumer",
        "title": "Integrate consumer",
        "kind": "codex",
        "prompt": "Use the verified library contract",
        "ownership": ["src/consumer"],
        "checks": [
          { "type": "command", "command": "bun", "args": ["test", "tests/consumer.test.ts"] }
        ]
      }
    }
  ]
}
```

`dependsOn` names keys in the same batch; `assignment.dependencies` can name existing task IDs. Entries may be supplied out of order. Cycles, unknown keys, foreign targets or invalid assignments roll back the entire batch. The result includes task IDs and final `treeRevision`. Ordinary assignment scope, profile and graph checks still apply. Dependencies do not merge worktrees.

For a coordinator to continue alongside children:

1. Create direct children within its original ownership envelope.
2. Pause and observe the parent settled (a never-started queued parent also qualifies).
3. Call `swarm.ownership.transfer` with `taskId`, `expectedRevision`, `childIds`, `retainedOwnership` and `reason`.
4. Resume paused work through `task.control`.

Retained paths must be inside the original envelope and disjoint from all unsettled direct children. Enumerate disjoint paths; a parent directory overlaps its descendants. The runtime retains the original envelope for delegation but uses `retainedOwnership` for scheduling, worker instructions and artifact reporting. Only explicitly transferred children bypass the ordinary parent-yield requirement. An empty retained set permits a coordinating parent with no project writes. Existing full-yield behavior remains available.

## Adaptive capacity

`swarm.capacity.configure` takes `policy` and `reason`. The policy is instance-wide, matching existing shared execution limits:

```json
{
  "policy": {
    "mode": "adaptive",
    "maxConcurrency": 12,
    "projectConcurrency": 6,
    "providers": { "codex": 8, "claude": 4 },
    "memoryPerWorkerMb": 512
  },
  "reason": "User selected adaptive admission with these ceilings"
}
```

Global, per-project, provider and exact-model ceilings are optional in adaptive mode. Admission considers active workers plus reserved lead continuations, CPU availability, host load and free memory. Capacity grows gradually and contracts under pressure. These are host estimates, not a guarantee of provider quota or available money. A configured model ceiling requires an exact model for admission.

`swarm.capacity.feedback` takes `provider`, `retryAfterMs` (1 second–1 hour), and observed `evidence`. The indicated provider cools down while others can continue. Quota discovery is not automatic. `mode: "fixed"` restores saved `limits.configure` behavior; configure fixed ceilings through that existing operation. Shared outcome turn and depth budgets remain enforced and can be revised through existing outcome controls. This feature does not claim a dollar spending cap.

## Observation and external waits

`swarm.observe` takes `projectId` and optional event cursor `after`. It returns objective revisions, worker state, pending instructions, decisions, watches, capacity estimates, and supervision health. Use `cursor`/`hasMore` to page changes. Herdr observations include source and time; stale observations become unknown. Fresh worker claims are explicitly nonauthoritative. Worker `activity` takes `state` (`busy`, `idle`, `external-wait`), `detail`, and optional `until` (Unix milliseconds). Busy claims expire after five minutes. Declared waits expire no later than four hours without refresh, even when a later expected time was supplied. A definitive missing agent or pane is recorded as dead; connection or identity ambiguity is unknown. Silence alone never proves a dead worker or authorizes a restart.

Thirty minutes without new activity evidence produces an attention event. Supervision health exposes last tick freshness, objectives without a registered lead wait, and `next-message` adapters. A missing wait is a possible continuation gap, not proof the lead is idle. Unsupported desktop hosts still require another user message; there is no invented host turn-end hook.

`swarm.watch.create` registers a **read-only, safely repeatable condition**, not an action:

```json
{
  "outcomeId": "OUTCOME_ID",
  "key": "external-build",
  "description": "Wait for the externally produced build receipt",
  "condition": { "type": "file", "path": "receipts/build.json", "contains": "passed" },
  "intervalMs": 5000
}
```

File conditions honor `contains` and `sha256`, use contained project paths, and are limited to regular files under 1 MiB. Command conditions use the existing check schema: executable, argument array and timeout (100–120000 ms, default 30000). Exit 0 captures ready; exit 1 schedules another check; any other exit, timeout or execution failure captures failed. Command output is bounded. The runtime cannot prove a user-supplied command is read-only; callers must register queries, never repeatable deployment or payment actions.

Wait results have durable IDs. `swarm.watch.ack` takes `watchId` and exact `resultId`; `swarm.watch.cancel` takes `watchId` and `reason`. A cancelled probe cannot overwrite cancellation when it finishes. Interrupted probes return to waiting after restart because only repeatable conditions are allowed. Register `lead.wait` with `condition.watchIds` or `condition.decisionIds` to react even if a result was captured before registration. A ready, failed or cancelled watch wakes the lead to inspect the result; it does not imply success. Conditions retain existing OR behavior across condition groups, and all IDs within each watch/decision group must be ready.

## Experiments and delivery

`swarm.experiment.create` takes the batch fields plus `criteria` and a nonempty common `checks` list. It resolves one shared Git base commit before dispatch, pins every candidate to that commit, and creates independent worktree assignments. Candidate-specific checks are replaced with the common checks. Candidates begin optional; they are independent root tasks, and worktree branches are prepared by the normal supervisor lifecycle.

`swarm.experiment.compare` takes `experimentId` and returns current verification, receipts, worktree references, task revisions and selection freshness. `swarm.experiment.select` takes `experimentId`, `expectedRevision` (outcome revision), `taskId`, `rationale` and file `references`. The winner must have current verified completion. Selection makes it required, preserves alternatives, and records candidate revisions plus comparison evidence digests. A revised candidate, outcome or comparison artifact makes selection stale. Settle or explicitly cancel outstanding candidates before completing the outcome. Integration and criterion assessments remain separate; selection does not merge, publish or delete anything.

`swarm.delivery.configure` takes `outcomeId`, `expectedRevision`, `target` (`local`, `pull-request`, `merge`), `verification` and `authorization`. It records delivery expectations and their source independently of evaluation. This record grants no new native permissions and performs no publication. Use existing delivery/cleanup records to capture an actual authorized delivery.

## Trajectories and optional methods

`swarm.trajectory` takes `outcomeId` and optional `after`; page events using `nextCursor`/`hasMore`. It captures the objective, amendments, assignments and full prompts, model/profile choices, run identities, messages, decisions, events, available usage and evaluations. Worker token hashes and terminal output are excluded. Prompts and artifacts may contain project-confidential data; exports remain local unless separately shared.

`swarm.evaluation.record` takes `outcomeId`, `expectedRevision`, `key`, `scenario`, `strategy`, `success`, `regressions`, `interventions`, `references` and `notes`. It records the evaluator, elapsed time and shared turns. A success record requires current completed and integrated outcome evidence. Assessments are attributed and evidence-backed; they are not a model-independent guarantee. Missing provider usage stays unavailable.

The [evaluation suite](../evaluations/README.md) provides six reproducible scenarios, common checks, mid-task steering, fresh fixtures and a common adapter protocol for single-agent, prior Marionette and revised Marionette trials. Acceptance, cost availability and procedural review remain distinct.

`swarm.recipe.get` loads one versioned optional recipe: `diagnose`, `investigate`, `compare-approaches`, `review-repair`, `deliver`, `recover`, or `catch-up`. Their triggers and examples are in [the skill library](../skills/marionette/references/recipes/). Recipe text is embedded in CLI/MCP bundles from those same files. Recipes can evolve independently of the runtime's authority and evidence checks.
