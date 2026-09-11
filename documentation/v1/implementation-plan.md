# Marionette v1 implementation

- [x] Read the Principles section of poteto-mode in full.
- [ ] Phase A: Frame.
- [ ] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [ ] Unit 1: Transactional SQLite migrations, identities, immutable inputs and real database verification.
- [ ] Unit 2: Shared CLI/SDK operations, project binding, board and controlled SQL.
- [ ] Unit 3: Herdr worker launch, observation, control and recovery; verify real adapter behavior.
- [ ] Unit 4: Pinned pstack workflow transitions, instruction revisions and descendant controls.
- [ ] Unit 5: Watcher, native delivery, result handoff and protected cleanup.
- [ ] Unit 6: Remove legacy runtime, build and package v1.0, complete actual CLI and native acceptance checks.
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
