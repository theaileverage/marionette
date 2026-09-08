# Changelog

## 0.3.0 — 2026-09-08

- **Runtime change:** the CLI and supervisor now require Bun 1.3.14+. `npx` remains supported when Bun is on PATH. Development, tests, and CI use Bun with a frozen lockfile.
- Compose application workflows and resource lifetimes with Effect v4, including typed errors, scoped polling, graceful shutdown, and cancellable subprocesses and sockets.
- Use Bun's SQLite driver while preserving the version-2 database format, synchronous transactions, lease fencing, and recovery behavior.
- Enforce Effect diagnostics and anti-slop lint rules, install the project Effect skill, and expand verification to 127 tests plus isolated package checks.

Upgrade by stopping the existing supervisor, starting this version against the same state directory, and rerunning setup. Existing worker runtime paths and SQLite state are preserved.

## 0.2.2 — 2026-09-08

- Ship a Marionette agent skill with setup, task coordination, recovery, and SDK guidance.
- Place new workers in appropriately sized sibling panes, with overflow tabs, durable creation recovery, and cleanup that preserves sibling workers.
- Export a dependency-free Herdr SDK covering all 102 Herdr 0.9.0/protocol-22 schema methods plus persistent graphics streams, with generated TypeScript types, cancellable event subscriptions, bounded buffering, and file-frame acknowledgements.
- Verify graphics payloads, placement, replacement, and layer cleanup through the real Herdr server/client renderer with a simulated Kitty-capable terminal. Expand the regression suite to 117 tests.

## 0.2.1 — 2026-09-08

- Separate verification, terminal release, delivery, evidence archival and Git collection lifecycles. Task completion continues to preserve branches and worktrees.
- Automatic release of settled, identity-verified single-pane workers after integrated outcome completion; retained failures, native-input states and ambiguous close reconciliation.
- Explicit merged/published/abandoned delivery, durable SHA-256 evidence archives and standalone Git bundles. Archived evidence preserves completion after checkout removal and detects tampering.
- Opt-in retention policies, live consumer and dirty-file guards, safe worktree removal, later PR-branch collection and compare-and-delete for explicitly abandoned archived branches.
- CLI/MCP cleanup tools, dashboard eligibility and retention controls, and regression coverage for recovery, identity changes, lease fencing, shared checkouts and evidence preservation.

## 0.2.0 — 8 September 2026

- Persistent outcomes, observable completion criteria, independent assessments and integrated reviews. Required descendants, current revisions and artifact digests guard completion.
- Audited task splitting/revision/supersession, findings, scoped managed delegation, waiting-parent capacity release, and continuation in the original run and native session.
- Shared global/project/provider/model limits and outcome execution-turn budgets.
- Durable event-driven lead waits, grouped deliveries, ownership fencing, checkpoints, cache capability boundaries and deduplicated provider usage import.
- 27 exact model profiles across Codex, Claude and AGY, native catalog discovery, account validation, category defaults, assignment/lead overrides and retained run configuration.
- Bounded councils, debates, competing proposals, sequential work, independent review and repair strategies.
- Outcome board, task-tree/dependency views, criterion and integrated-review forms, revision details, findings, limits and model controls.
- Startup readiness recovery, interruption settling, uncertain-delivery detection and ancestor/evidence invalidation fixes discovered by real-agent acceptance.
- Schema-2 migration preserves 0.1 task/run/lease identities. Upgrade the supervisor with the same state directory and rerun setup; workers retain their old executable paths.

See [ORCHESTRATION.md](ORCHESTRATION.md) for the public contract and [VERIFICATION.md](VERIFICATION.md) for measured evidence and operating limits.
