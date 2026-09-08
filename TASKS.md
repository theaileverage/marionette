# Marionette — tasks after v0.1.0

Release 0.2.0 is published to npm under the latest tag. All implementation and validation tasks are complete, including the cold-resume probe. Registry integrity matches the tested tarball, and a fresh npm install reports 0.2.0. Evidence is recorded in VERIFICATION.md.

Baseline: the published `@theaileverage/marionette@0.1.0` release. This backlog captures the subsequent discussion about outcome-driven orchestration. Checkboxes track verified delivery; discussion or agreement alone does not mark an item complete. Priorities and sequencing below are proposed implementation order.

Already shipped in the baseline: npx packaging, guided/JSON setup, named selectable leads, MCP registration, automatic AGY workspace trust, persistent worker supervision, basic dependencies, assignment verification, handovers, and the dashboard assignment list.

## P0 — orchestration foundations

### 1. Make outcomes and definitions of done persistent

- [x] Add an outcome record with the objective, scope, completion criteria, required evidence, and responsible lead.
- [x] Require the lead to establish observable completion criteria before dispatching work; ask for clarification only when necessary.
- [x] Support completion criteria for software, research, analysis, and collaborative decision-making.
- [x] Preserve revisions and reasons when completion criteria change. Prevent silently weakening criteria to claim success.

**Done when:** an outcome and its acceptance criteria survive restart and handover, and the lead can explain exactly what remains unmet.

### 2. Enforce completion across the entire task tree

- [x] Represent parent/child relationships alongside dependencies.
- [x] Require every required descendant to be verified complete before its parent can complete.
- [x] Verify the parent's own criteria and the integrated result; passing child checks alone is insufficient.
- [x] Keep failed, cancelled, blocked, and unresolved required work from counting as success. Record explicit decisions to remove or supersede requirements.
- [x] Make completion conditional on the current task-tree revision so concurrent additions cannot produce false completion.

**Done when:** neither a parent nor the overall outcome can finish with unmet required work anywhere beneath it.

### 3. Allow the plan to evolve during execution

- [x] Let authorized leads and subordinate coordinators create, split, revise, and supersede tasks based on findings.
- [x] Record what changed, why, and which worker evidence prompted the change.
- [x] Reopen completed parents and affected ancestors when new required work is added.
- [x] Invalidate obsolete acceptance evidence while retaining unaffected verified work.
- [x] Reject dependency cycles and stale updates; preserve explicit scope boundaries.

**Done when:** a late review finding can create repair and re-verification tasks, update the board, and keep the outcome open until the new work passes.

### 4. Support managed delegation to child workers

- [x] Allow a worker to coordinate a bounded portion of the outcome and request child workers through Marionette.
- [x] Register the full delegation tree with parent accountability, scoped authority, and inherited limits.
- [x] Define ownership transfer while children work so a waiting parent does not conflict with its own children or edit their assigned files concurrently.
- [x] Return child results to the responsible parent for evaluation and integration; surface consequential findings to the root lead.
- [x] Support interruption, cancellation, recovery, and handover across the tree without orphaning descendants.
- [x] Update worker instructions and reporting tools once managed delegation exists.

**Done when:** a specialist can delegate, yield, resume on child results, and integrate them while the root lead retains visibility and control.

### 5. Apply shared concurrency and execution budgets

- [x] Enforce shared limits across the whole delegation tree: global, project, and provider/model capacity.
- [x] Include descendants in the same execution budget; delegation must not multiply the allowance.
- [x] Release execution capacity when coordinators wait for children, while retaining their logical identity and session.
- [x] Expose why work is queued and which limit prevents dispatch.
- [x] Make limits configurable and validate safe operating ranges before increasing concurrency.

**Done when:** waiting parents cannot exhaust all slots and prevent their children from running, and nested delegation cannot exceed configured limits.

## P0 — continuation and cost control

### 6. Resume leads from meaningful events

- [x] Persist lead wait conditions: required results, council quorum, blocking questions, or findings requiring replanning.
- [x] Let the supervisor monitor workers without model polling or repeated timeout turns.
- [x] Queue and group routine events; promptly deliver events that require intervention.
- [x] Resume the correct lead session when it is ready, with duplicate-delivery protection and restart recovery.
- [x] Prevent simultaneous coordination turns and preserve the existing lead-ownership checks.
- [x] Declare adapter capabilities explicitly: automatic continuation versus continuation on the user's next message.

**Investigation:** validate continuation for Herdr-hosted leads and supported native session APIs. Establish a supported route before promising wakeup of an existing desktop conversation.

**Done when:** a worker result can trigger the appropriate next lead turn without a manual prompt or model-driven waiting loop.

### 7. Preserve useful cache reuse and control coordination cost

- [x] Reuse the same conversation and stable prompt prefixes where possible; append compact event updates instead of rewriting instructions or resending the entire board.
- [x] Keep detailed transcripts and artifacts outside routine coordination messages, available through references and targeted reads.
- [x] Detect supported cache-retention controls and usage metrics for each adapter. Distinguish API controls from capabilities actually exposed by native CLIs.
- [x] Choose supported retention policies based on expected work duration and total cost. Do not wake a lead solely because cache expiry is approaching.
- [x] Persist checkpoints containing objectives, decisions, remaining criteria, and evidence references for long gaps and recovery.
- [x] Compact deliberately when warranted; account for the resulting loss of prefix reuse.
- [x] Measure cache reads/writes, uncached input, coordination turns, and cost where available; label unavailable measurements honestly.

**Done when:** the lead can wait for long-running work without polling, resume with sufficient context, and expose evidence of coordination cost and cache behavior where the provider supports it.

## P1 — adaptive collaboration and visibility

### 8. Add model and capability profiles

- [x] Define configurable profiles for orchestration, research, implementation, review, and other task categories.
- [x] Store agent runtime, exact model, supported reasoning effort, tools/capabilities, strengths, delegation permissions, and applicable limits.
- [x] Make Claude Fable selectable for orchestration and evaluate its suitability on representative workflows.
- [x] Let users set category defaults and override a particular assignment or council participant.
- [x] Validate model availability and preserve explicit requests for powerful models; make fallback choices explicit.
- [x] Record the resolved model and configuration used for each run, independently of its display name.

**Done when:** the lead can select an appropriate configured profile for a task, and the user can inspect what actually ran.

### 9. Support composable collaboration strategies

- [x] Provide the operations needed to delegate, exchange findings, wait, gather results, evaluate, revise, and finish.
- [x] Support parallel specialists followed by integration, and sequential work with dependencies.
- [x] Support councils with independent initial assessments and synthesis that preserves material disagreements.
- [x] Support bounded debates with claims, evidence, rebuttals, and explicit decision/stop conditions.
- [x] Support competing proposals or prototypes evaluated against shared criteria.
- [x] Support independent review and targeted repair/re-verification loops.
- [x] Let the lead combine and adapt strategies during a run within its authority and budget.

**Done when:** the lead can carry out the user's requested collaboration pattern, or select an appropriate one, while retaining the original outcome and completion criteria.

### 10. Make the lead accountable for the outcome

- [x] Update the lead prompt to establish completion criteria, choose agents and strategy, adapt to evidence, and evaluate the integrated outcome.
- [x] Teach the lead to register wait conditions and yield when it has no useful work to do.
- [x] Require a final account of satisfied criteria, supporting evidence, unresolved issues, and any necessary user decision.
- [x] Apply equivalent instructions to subordinate coordinators within their delegated scope.

**Done when:** runtime behavior and prompts together support continuing toward verified completion, with a clear explanation whenever work genuinely requires user input.

### 11. Extend the assignment list into an outcome-aware task board

- [x] Add board, task-tree, and dependency views backed by the same persistent records.
- [x] Show outcomes, definitions of done, responsible agents, actual models, descendants, dependencies, and evidence.
- [x] Explain waiting/blocked states, capacity limits, and unresolved acceptance criteria.
- [x] Show findings, plan revisions, and reasons for reopening tasks.
- [x] Route board actions through the same authority and verification rules used by agents; dragging a card cannot bypass completion checks.

**Done when:** a user can understand what is happening, why it is happening, and what remains before the overall outcome is complete.

## P2 — validation and release

### 12. Verify the complete orchestration lifecycle

- [x] Test recursive completion, revision races, newly added requirements, stale evidence, and dependency-cycle rejection.
- [x] Test nested delegation, shared budgets, waiting-parent capacity release, cancellation, and restart recovery.
- [x] Test event grouping, correct-session resumption, duplicate prevention, busy/blocked leads, and unsupported desktop adapters.
- [x] Evaluate long waits, cold resumes, stable-prefix reuse, and compaction using observable provider metrics where available.
- [x] Run representative council, debate, research, implementation, review, and repair workflows with real supported agents.
- [x] Verify board actions reflect the same state and constraints as MCP/CLI actions.
- [x] Verify compatibility with existing v0.1.0 projects, tasks, leases, and setup configuration.
- [x] Update setup guidance, prompts, documentation, and release evidence. Select and authorize the next release separately.

## Implementation dependencies

- Outcome records and task relationships (1–2) underpin dynamic planning (3), delegation (4), and the board (11).
- Delegation (4) requires shared scheduling/budget rules (5) and scoped authority before child dispatch is enabled.
- Event-driven continuation (6) and cache-aware resumption (7) should be designed together.
- Profiles (8), adaptive strategies (9), and lead behavior (10) build on the orchestration foundations.
- Validation (12) should accompany each increment, followed by complete workflow acceptance before release.

Open details to resolve during implementation: per-adapter continuation/cache support, budget defaults and accounting, supported delegation depth, and measured model/profile recommendations. No unlimited concurrency or guaranteed provider-cache lifetime is assumed.
