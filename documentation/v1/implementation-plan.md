# Marionette v1 implementation

- [x] Read the Principles section of poteto-mode in full.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [x] Unit 1: Transactional SQLite migrations, identities, immutable inputs and real database verification.
- [x] Unit 2: Shared CLI/SDK operations, project binding, board and controlled SQL.
- [ ] Unit 3: Herdr worker launch, observation, control and recovery; verify real adapter behavior.
- [ ] Unit 4: Pinned pstack workflow transitions, instruction revisions and descendant controls.
- [ ] Unit 5: Watcher, native delivery, result handoff and protected cleanup.
- [ ] Unit 6: Remove legacy runtime, build and package 1.0.0-alpha.1, complete actual CLI and native acceptance checks.
- [ ] Phase D: Keep the audit trail throughout every unit.
- [ ] Phase E: Verify and hand back.

## Done predicate

The new package exposes the agreed CLI and importable SDK without requiring MCP or HTTP. SQLite initialization and upgrades use atomic versioned migrations. The five contracts hold under real-database tests, process crashes and native-adapter races. The built CLI completes project setup, delegation, collaboration, correction, control, handoff and notification in isolated fixtures. Full static/build/package checks pass. Native integrations must be proven live or explicitly reported as unverified; fixtures never establish native compatibility. Legacy runtime and data remain recoverable. Publication is conditional on verification.

## Throughput checkpoint

- Blocking first steps: preserve dirty main, isolate implementation, establish exact shared types/storage interface, probe SQL authorizer and native control access.
- Independent workstreams: source/adapter and schema/build grounding first; code delegates own isolated worktrees after interfaces settle.
- Shared mutable state: single integrator owns core schema and integration branch; workers publish commits from separate worktrees. No shared runtime fixture state.
- Smallest safe decomposition: six units, with parallel code only across domain seams. Review and checks close each unit before dependent work.

## Architecture phases

Ground: refresh existing SDK/build and relevant runtime contracts.
Sketch: revision-4 artifacts already contain the selected two-candidate synthesis; no second arena unless implementation evidence invalidates it.
Agree: user's v1 rewrite request authorizes implementation, migrations and breaking changes.
Implement: replace old APIs rather than maintain compatibility layers.
Scrap: reconsider any seam that repeatedly needs exceptions.

## Initial swarm

Frame: identify reusable native SDK and constraints on migrations/packaging.
Fan out: two read-only source explorers on the available configured model.
Aggregate: record interfaces and risk probes in the implementation contract.
Report: source-based findings before code delegation.

## Alpha integration status

The isolated rewrite branch targets `1.0.0-alpha.1`. It contains the CLI and SDK, five SQLite migrations, board and SQL operations, pinned workflow packages, native execution journal, background watcher, handoff checks, and protected retirement. Legacy runtime source and its MCP/HTTP/dashboard dependencies have been removed from this branch. Existing main and live state are preserved.

The integrated suite passes 85 tests after review corrections. The actual installed alpha tarball passed SDK/CLI board reads, the SQL worker from an unrelated directory, bundled workflow loading, and declaration checks. The final candidate is verified again through the installed tarball smoke test.

A live AGY fixture accepted one journaled prompt through the Herdr adapter and returned `V1_NATIVE_SMOKE_OK`. Its trust prompt and adoption were explicitly authorized for that fixture. This proves the native prompt path, not the full assignment/revision/control/handoff lifecycle. The fixture was left idle.

The current desktop-owned Codex app-server has private stdio and no reachable registered endpoint. Desktop notifications are unavailable in this environment. No substitute app-server was used as evidence.

Unit 4 remains blocked on the pending source-implementation authorization following automatic approval review rejection. Its stubs reject brief revisions, workflow transitions, pause/cancel/resume, and limit changes. Automatic workflow scheduling depends on those operations. Alpha naming does not count as completing that scope.

Remaining acceptance work includes the complete native assignment lifecycle, automatic workflow progression and controls, and final integration review. No version tag, npm publication, or stable-release claim has been made.
