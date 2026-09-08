# Marionette design

## Process boundaries

```text
Codex desktop ── STDIO MCP ──┐
Terminal lead ── MCP / CLI ──┼── authenticated loopback HTTP
Browser dashboard ──────────┘              │
                                  persistent supervisor
                                    │             │
                               SQLite WAL     Herdr NDJSON socket
                                                  │
                                      explicitly selected workspace
                                          ├─ Codex tab
                                          ├─ Claude tab
                                          └─ AGY tab
```

MCP calls persist bounded intentions and return promptly. Independent supervisor loops monitor assigned panes; closing the calling conversation cannot cancel work. One process/PID lock protects each state directory. Herdr owns worker terminals and their lifecycle.

## Durable records

`Store` uses Node's SQLite API with WAL and synchronous FULL. Version 2 stores typed JSON documents by kind/id plus an append-only sequenced event table. Transactions group local changes before external side effects. Documents include projects, tasks, attempts/runs, lead leases (token hashes only), operations, decisions, pending/answered questions, idempotency receipts and per-consumer inbox cursors.

Tasks carry dependencies, declared ownership, agent kind, objective revision, attempt budget, latest bounded output, receipt and verification. Runs retain the precise terminal/pane/tab, agent name and native session, dispatch phase, baseline digests, connection state and scoped worker-token hash. Control operations retain their phase and revision so a restart cannot silently duplicate delivery.

## Execution environments

The lead recommends isolation based on likely concurrent file conflicts and requests the user's choice unless already authorized. The supervisor does not make a heuristic isolation decision. An optional task `execution` selects `shared` (also the backwards-compatible default) or `worktree` with optional `baseRef`. Submission remains a nonblocking database operation; Git preparation runs asynchronously after scheduling. Ownership compares effective filesystem paths, including reserved worktree locations before creation. Dependencies and project concurrency remain in force.

Managed worktrees live beneath the instance state directory, with a unique project/task path and `marionette/<task-id>` branch. Before any Git write, a durable plan records the repository and common Git directory, source and destination working directories, branch, and resolved base commit. Only committed history is checked out. A monorepo subdirectory maps to the same relative path in the new tree. The effective `task.cwd` and file checks are validated before Herdr receives that directory.

The worktree lifecycle is separate from the worker run lifecycle: `planned → creating → ready`. A restart may execute a persisted plan or adopt a registered creation only after checking repository identity, branch, checkout status, and pinned commit. Ambiguous or incomplete creations fail closed and preserve all files. A ready worktree must retain its identity but may contain worker commits and dirty files, which retries preserve. Git calls use argument arrays, bounded subprocess execution, disabled hooks, and a cleared inherited Git environment; preparation issues no forced checkout, reset, merge, prune, or removal. Later cleanup uses the separately authorized lifecycle below. Pause/cancel/redirect during preparation is applied before worker launch.

Completion leaves the branch and worktree available. The lead recommends review, merge, or push/PR based on the user's workflow and obtains a choice unless already authorized. These delivery actions use normal Git/hosting tools and are not automatic supervisor side effects. No task dependency implicitly integrates another branch. The structured worktree metadata is available in briefings, task reads, inbox-associated task state, and the dashboard.

## State and delivery

Tasks normally follow `queued → preparing → running → verifying → completed/failed`. Dependencies, concurrency and ownership can retain `queued`. Questions or native screens produce `blocked`; pause produces `paused`. Cancel/redirect await an interrupted worker before acting. The revised objective fences obsolete reports immediately.

Before `tab.create` or `pane.split`, the run is persisted as `creating`, with the split target and pre-creation pane membership when applicable. Layout allocation is serialized per project; new workers share tabs only when all live members match saved pane-scoped run identities. Geometry and a four-pane cap determine whether to split or create another tab. Returned identifiers are saved before `agent.start`; the agent must become interactively ready before any task prompt is sent. `prompting` is persisted before `agent.prompt`. Native startup and input screens never trigger automatic approvals. The transport validates response IDs and handles fragmented NDJSON; loss before acknowledgement is treated as ambiguous.

A crash in `creating` or `prompting`, or while a control is `sending`, requires explicit reconciliation. A run in `starting` is inspected and continued in its existing pane. Running attempts reattach; verification safely reruns. Identity mismatch suspends control. This is conservative at-most-once automatic dispatch with visible uncertainty, not a claim of exactly-once external execution.

Each task is reserved synchronously before asynchronous I/O; a busy set prevents concurrent loops touching its run. Store updates merge onto the latest row so output sampling cannot erase a concurrent report or lead revision. Lead authorization is rechecked after external reads for retry/reconciliation. Explicit takeover rotates the token and increments the epoch in one transaction.

## Verification and trust

An agent report alone never completes a task. The supervisor also requires a settled recognized identity and passes every check. Files are bounded to the task root, artifacts to declared ownership, and default checks require freshness. Commands are trusted lead input, launched with `shell: false`, a timeout, capped output and isolated process group. Arbitrary acceptance commands may have side effects and must be chosen accordingly.

Herdr output and reported evidence are untrusted data. They render as escaped React text, not HTML or executable instructions. Worker credentials authorize reports and bounded inspect/finding/delegation/revision/control operations within their assigned attempt and task subtree. The instance bearer token is administrative; anyone who can read its private file has local instance access. Lead leases prevent conflicting workflow writes among cooperative authorized clients; they are not a multi-user security boundary.

Host and Origin checks plus loopback binding defend the HTTP interface against cross-site control and DNS rebinding. No public listener, remote credentials, global permission relaxation or Ghostty UI bypass is required.

## Notification boundary

Events persist independently of clients. Each inbox reader has its own monotonic acknowledgement cursor. Dashboard event alerts use a separate forward cursor, so an old unread backlog cannot hide a fresh completion. OS notification delivery depends on browser permission and the dashboard remaining open. MCP exposes inbox tools and server instructions; it does not claim an idle desktop-task wakeup capability.

## Outcome contracts and continuation

See [ORCHESTRATION.md](ORCHESTRATION.md) for the public 0.2 contract. Outcomes, digest-linked criterion assessments, integrated reviews, plan revisions, model catalogs/profiles, findings, strategies, checkpoints, native usage and lead waits are typed records alongside existing tasks. Schema migration preserves legacy identities and adds implicit outcomes. Nested mutations use SQLite savepoints.

Task and outcome revisions fence asynchronous verification and plan changes. Required descendants form an acyclic completion graph together with dependencies. Changed artifacts invalidate affected work and integrated evidence. Parent yield transfers declared ownership to children after the native turn settles; resumption reuses its original run, pane and native conversation. Shared worker and lead reservations are acquired before external dispatch.

Lead wait delivery persists waiting, ready, sending, delivered or uncertain state. Current lease ownership and exact native identity are checked before side effects and after asynchronous reads. Ambiguous acknowledgements never trigger automatic replay. Routine event summaries and targeted artifact/history reads reduce repeated context. Cache metrics retain missing values as unavailable and native message IDs prevent duplicate import.

## Resource retirement

The cleanup service separates run release from worktree delivery/archive/collection. Completed integrated outcomes enable conservative automatic worker-pane release (legacy runs retain exclusive-tab release); failed/cancelled runs require inspection. Closure persists `closing → closed` or `uncertain`, pins the full native identity and original terminal, and never replays an ambiguous close. It does not close project sessions or workspaces.

Managed-checkout collection is disabled until explicitly requested or covered by an authorized retention policy. All tasks sharing the checkout are locked during inspection; task mutations, child submission, project registration and evidence assessment are fenced while cleanup awaits external reads. Archives seal terminal tasks and preserve file evidence, run diagnostics and a Git bundle. File writes and directory entries are flushed before committing the archive record. Collection verifies live files and archive digests before non-forced worktree removal. Original task references resolve to archived bytes only after recorded collection and actual checkout disappearance; tampering still invalidates acceptance. Delivery records retain pinned HEAD/target commits. Published branches can be collected later after a new merged delivery decision. Explicit abandonment retains a bundle before compare-and-delete of the exact branch tip. Partial Git operations preserve their phase and are explicitly inspectable/retryable.

Closing a native terminal and invoking Git have unavoidable external-process boundaries. Herdr protocol 20 has no atomic conditional-close operation; identity is checked immediately before the close, but operators must not repurpose a terminal concurrently with its cleanup. Git checks and branch-tip comparisons likewise do not replace coordination with external tools editing a checkout. Marionette fences its own concurrent mutations and refuses unsafe observed states.
