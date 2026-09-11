# Marionette execution contracts

Revision 4, September 11 2026. These five decisions define the new system's design basis. They supersede the earlier linear workflow sketch and incomplete control and handoff behavior. The user authorized implementation of these contracts as the v1.0 rewrite on September 11 2026. CLI syntax and record names are finalized by the implementation and its tests.

Every engineering task enters pstack routing. Pstack wins overlaps with Matt skills. Direct work remains available, Git remains native, and agents retain the full Herdr SDK. CLI and SDK share domain operations without MCP or required HTTP. Hono remains selected for optional HTTP adapters. The accepted limited SQL write scope remains unchanged.

## 1 Workflow gates with agent owned loops

The runner owns durable execution and the few boundaries that must hold across crashes. A controlling agent owns design choices, investigation, review interpretation, and repair loops. Routine work can route directly without starting a workflow or making an extra model call.

A pinned workflow package defines named steps, permitted transitions, required evidence, applicable skills, and finite execution limits. It does not encode every sentence of a skill as a scheduled operation. Each step execution has its own ID and input revision. Repeating a step creates another step execution rather than overwriting the earlier one.

The controlling agent can return one of six transition requests. `advance` moves to an allowed next step. `repeat` creates another execution of an allowed step. `route` selects a permitted method or child workflow. `await-decision` presents a concrete artifact and stops progression. `block` records a resumable obstacle and the concrete condition or action needed to clear it. `finish` records success or failure, with final evidence or a failure reason and retained effects. Failure is terminal; retry is a new explicit execution decision. Each request records its reason, source step execution, evidence references, expected workflow revision, and an idempotency key. A stale transition fails without starting work.

The runner validates the transition against the pinned package, current brief and control revisions, required evidence, resource availability, and remaining limits. It then persists the next intent before external launch. The controlling agent cannot waive user constraints, required review separation, or stop-after boundaries by choosing another route. Child workflows inherit those boundaries and debit the parent's remaining execution allowance. Managed child admission atomically checks the expected workflow, brief and control revisions and registers both the child relationship and launch intent. If admission commits first, a later stop or revision covers that child. If control or revision commits first, admission fails stale. Workflow session context supplies the parent automatically; managed children cannot omit it to escape inherited boundaries. A top-level run outside workflow context is independent and is not silently added to an existing workflow.

Every package supplies finite attempt and repeat limits. Every run has a deadline and parallelism limit. An inner agent loop also has a deadline; exhausting it requests interruption and records uncertainty until native settlement is observed. An authorized extension creates a recorded limit revision. The runner does not automatically extend a loop or silently substitute unavailable models. Raw unmanaged Herdr activity remains outside these scheduling guarantees and must be shown as such.

A failed review can therefore return to implementation and then request another review, without a human making bookkeeping calls. A selected design-only run cannot schedule implementation through a repeat or nested route.

## 2 Instructions have revisions and results identify them

Keep the user's original request immutable. Each execution brief is an immutable revision containing the resolved objective, scope, ownership, constraints, relevant standing orders, and declared input snapshots. A result records its brief revision, input digests, and evidence. An acknowledgement records which revision the worker adopted; it does not prove the worker complied. Result acceptance still evaluates the evidence against that revision.

Board posts and ordinary `send` messages are advisory context by default. They cannot expand scope, authorize publication, alter ownership, or release a stop. The author identity and source remain visible when a post is summarized or delivered. A worker may request a change; only the user or a controller acting within already granted authority can issue it.

An explicit `revise` operation creates a new brief revision. It names the prior revision and affected work, records the change, and fences acceptance of affected older results in the same transaction. Each step execution, result and launch intent records the exact upstream results and brief revisions it consumed. The same revision transaction marks the affected dependency closure stale, closes pending launches, and records control intent for active dependent attempts. Independent branches continue only when their recorded dependencies are unaffected. Already accepted historical results remain intact; they do not satisfy the revised requirement automatically. Unaffected work continues. The system preserves invalidated evidence for inspection instead of deleting it.

A clarification that preserves scope, ownership and permission can be adopted at an acknowledged safe boundary in the same attempt. The adapter may deliver it during an active turn, but delivery alone does not make it effective. Results from the older revision remain ineligible for the changed requirement until reviewed under an explicit new acceptance decision. If the worker cannot acknowledge the boundary reliably, pause and start a fresh attempt with the consolidated brief.

A scope, ownership, permission, or material objective change supersedes the affected attempt. Stop conflicting work, classify retained effects, and start a fresh attempt only after prior execution is settled sufficiently to prevent overlapping effects. A narrower permission takes effect immediately for managed admission and approvals; running native work remains stopping or unconfirmed until the adapter proves settlement. A broader permission requires existing user authorization or a new user decision. Native harness permissions still enforce the session's actual access.

`send` never guesses whether prose changes scope. The controller uses `revise` for a binding change and a control operation for a stop. A finished job receives neither a new brief nor a new attempt implicitly; a new request creates new work.

## 3 Stop modes describe intent separately from observed execution

All controls are durable, revisioned, and idempotent. They close managed scheduling admission for the selected workflow and its descendants before returning acceptance. A launch already admitted may still be in flight. The adapter must reconcile it and apply the control to that attempt. A receipt means the request is stored, not that the worker stopped.

| Operation | New work | Active work | Completion condition |
| --- | --- | --- | --- |
| `pause --mode drain` | No new steps or children | Finish current attempts, including their existing writes | All affected attempts settle; results are retained; workflow is paused |
| `pause --mode safe` | No new steps or children | Request a checkpoint at a safe boundary; record any authorized final checkpoint writes | Checkpoint and native settlement are confirmed; workflow is paused |
| `pause --mode now` | No new steps or children | Request immediate interruption; no requested checkpoint, commit, or cleanup writes | Native settlement is confirmed; workflow is paused |
| `cancel` | No new steps or children | Request immediate interruption | Native settlement is confirmed; workflow is cancelled |

An unqualified user request to stop maps to `pause --mode now`. It preserves a possible later resume. Cancellation is terminal and requires new work to continue. `stop-after design` is a scheduling boundary chosen for the run; reaching it pauses at that boundary and requires an authorized boundary change before implementation can start. It does not mean interrupt work in the middle of design.

Control intent and execution observation are separate records. Public status reports running, pausing, paused, cancelling, cancelled, or finished with a success or failure outcome, plus blocked or unconfirmed reasons where applicable. A disconnected backend leaves a requested stop unconfirmed. Neither a delivered prompt, a PID, nor an expired lease proves that writes stopped. The system does not promise instantaneous zero writes from an unrestricted native agent. Managed commands and approvals reject admission of new effects after the control revision commits. Previously admitted operations can remain in flight and must be reconciled.

A late result is retained but cannot advance a paused, cancelling, or cancelled workflow. `resume` requires the expected control revision and confirmed settlement of the prior pause. It rechecks the current brief, permissions, workspace and limits before scheduling. It never blindly repeats an uncertain launch or Git mutation. An old resume request cannot override a newer stop. Once cancellation is committed, resume fails.

Native approval prompts remain native. Marionette records a reference to the exact attempt, session generation, operation and current approval state, and notifies the user. Approval resolution requires an authorized user action through a supported native mechanism. Immediately before forwarding approval, the adapter checks its expected brief revision, control revision and session generation. A mismatch makes the approval obsolete. This is an admission check; an approval already admitted at a racing stop remains in flight until reconciled. If an approval was already forwarded, its possible effect must be reconciled. An unsupported approval adapter reports that manual action is required; it never sends Enter speculatively.

Controls cover registered managed descendants. Raw sessions are adopted only after their identity and control ownership are verified. Unadopted sessions are listed as outside managed control and are never represented as stopped by a workflow receipt. Cleanup remains a separate explicit operation.

## 4 Results have an explicit handoff

Result production, evidence acceptance, integration, and publication are separate facts. A report can be accepted without Git integration. A patch or commit result records its source repository and workspace, base commit, resulting tree or commit, changed paths, brief revision, artifact digests, and checks. Artifact bytes must remain available after workspace retirement.

Each patch or commit delivery has a handoff record naming the consumer, target workspace and expected target state. Its states are `pending`, `integrating`, `integrated`, `conflict`, `unconfirmed`, `retained`, or `abandoned`. `retained` means the requested delivery is intentionally an exported patch or commit, not a landed change. An abandoned handoff preserves its evidence and recorded reason.

The lead or a selected integration job uses native Git. Immediately before mutation it checks the expected target HEAD, index and working-tree state under the cooperating writer reservation. Drift rejects the old plan. A revised plan can reconcile the new base and rerun relevant checks. No automatic overwrite, reset, or conflict resolution is implied.

A handoff has one claimed integrator attempt and a claim revision. Claiming the handoff and its cooperating target reservation is atomic. Completion compares that claim revision; a late former owner cannot overwrite the new record. Takeover requires confirmed settlement or absence of the former integrator. Uncertainty preserves the reservation. Persist handoff intent before mutation. Completion records the actual resulting target tree or commit and the checks run against it. If the process crashes after Git may have changed the target, mark the handoff unconfirmed and inspect Git before retrying. A worker's source checks do not automatically prove the integrated target works. Concurrent unrestricted writers remain outside the reservation guarantee; detected drift prevents a success claim.

A workflow whose requested outcome is a landed change cannot finish on production or report acceptance alone. It requires an integrated handoff with the target evidence. A workflow requesting a patch can finish with a retained, digest-verified artifact. Push, PR publication and merge remain separate authorized actions. No mandatory wrapper is added around routine direct Git work.

Retirement requires a settled execution, no other workspace consumer, verified durable copies of required artifacts, and a resolved handoff. Pending, integrating, conflicted or unconfirmed work is preserved. An explicit retain or abandon decision can resolve a handoff without pretending integration succeeded.

## 5 One execution host owns a project

The first version assigns each project one execution host. Its SQLite database, artifacts, runners, watcher, worktrees, and managed Herdr sessions live on that host. The CLI and SDK execute there. A user can invoke them through an existing remote shell, but this version does not share a live SQLite file across hosts or synchronize project state between machines.

Project identity, host identity, workspace identity, and native session identity are distinct. Each attempt and delivery stores the host ID and native locator, including server generation and the applicable workspace, pane, session or desktop task ID. A filesystem path is interpreted only on its recorded host. Socket paths, display names and reused pane IDs are insufficient identity.

A singleton project watcher record identifies its owner generation. Delivery claims belong to that generation. Takeover requires positive old-sender settlement or absence; lease expiry alone is insufficient. Ambiguous native acknowledgement remains uncertain rather than triggering replay.

Herdr restarts invalidate the previous endpoint generation. Recovery may reattach only after verifying the recorded native session identity. If the backend cannot prove identity, the attempt stays unconfirmed. Adoption of raw sessions requires a matching host and project and explicit ownership of the adopted session. Adoption never claims that Marionette tracked earlier work.

The desktop adapter must connect to the owning app-server on the project's execution host. A desktop client may view work remotely only where its supported transport preserves that server ownership and identity. Arbitrary delivery from one host to an unrelated desktop server is outside this first version. Unsupported topology is rejected before dispatch, with the actual host mismatch stated.

Host migration is a separate future operation. It requires settled executions and notification senders, transfer and verification of durable artifacts, and a new host binding. Rewriting paths or copying a live database is not migration. Multi-host workers and automatic artifact transport are deferred.

## Acceptance scenarios

After implementation is authorized, these scenarios establish the contracts:

1. A pstack review rejects a build, the owner repairs it, and review passes without manual stage advancement. A repeat or child route cannot escape design-only or execution limits.
2. A revision arrives immediately before a result. The stale result remains available but cannot satisfy the new requirement. Advisory board text cannot change permissions.
3. Pause and cancel race with launch, native approval and completion. No new managed descendants are admitted after the control commit. Uncertain native effects remain visible. Old resume requests cannot override a newer stop.
4. A worker returns a commit while the target branch changes. Integration detects drift, records the revised plan, and verifies the final target. A crash after Git mutation does not cause blind replay. Cleanup preserves unresolved handoffs.
5. A Herdr server restarts or a socket name is reused. The adapter refuses the old identity. A mismatched execution host fails before launch.
6. One live assignment passes through pstack routing, interactive AGY work, board collaboration, a brief revision, result handoff, and notification to the registered lead. Repeat with cancellation and watcher restart. Compare elapsed time and model calls with plain tools, and report native delivery uncertainty honestly.

The detailed contracts define the intended behavior. Live adapter compatibility, SQL binding controls, and performance remain implementation verification requirements.
