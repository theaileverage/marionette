# Effect v4 compatibility acceptance guide

This is baseline acceptance analysis for the integrated reviewer, not a verdict on the ongoing rewrite. Source and test references below refer to committed baseline `88c1034d0d65d77b8a1fdf5f6a2d76bf38f15fd6`, inspected using `git show HEAD:<path>` and `git grep ... HEAD`. Existing tests were read, not executed in this review. Proposed checks below are additional acceptance work, not passing evidence.

The reviewed local skill is `.agents/skills/effect/SKILL.md`, with `SERVICES_LAYERS`, `TESTING`, `SCHEDULING`, `STREAMS`, `SCHEMA`, and `CONFIG` references. The installed and working-package Effect version was `4.0.0-rc.112`. Acceptance requires genuine Effect composition plus preserved durable, transport, SDK, and package behavior.

## SQLite and authoritative state

`src/store.ts:Store.transaction` executes `BEGIN IMMEDIATE`, nested savepoints, commit/release, and rollback synchronously. `Store` uses WAL, `synchronous=FULL`, a 5000 ms busy timeout, schema version 2, and refuses newer databases. Preserve persisted records, events, ordering, and restart compatibility.

Keep each complete transaction inside one synchronous effect boundary. A callback returning a Promise or lazy Effect lets this baseline transaction commit before that work executes; do not yield, await, fork, or perform provider I/O inside it. `src/service.ts:submitAssignment`, `controlTask`, `report`, and `src/orchestration.ts:invoke` couple records, idempotency results, and events. Those writes must commit together or leave no partial state. Fibers and in-memory locks cannot replace persisted authority.

Existing evidence: `tests/core.test.ts`, “submission is nonblocking, idempotent and rejects reused keys with different intent” and “SQLite restart recovers running tasks and credentials without redispatch”; `tests/orchestration.test.ts`, “cancellation is atomic and cascades to all descendants”. These do not directly inject mid-transaction failure. **Proposed:** throw after a record write but before its event/idempotency write; reopen SQLite and verify rollback. Exercise nested rollback caught by the outer callback, uncaught nested failure, and rejection/prevention of asynchronous transaction callbacks.

## Lease, task, and revision fencing

`src/service.ts:guard` compares the persisted lead owner, epoch, and token hash. `workerGuard`/`report` bind credentials to the current task run and reject obsolete revisions; `updateTask` merges onto the current row so stale I/O snapshots cannot erase newer controls or receipts. Preserve rechecks after external awaits, including reconciliation in `Service.invoke`, profile validation in `src/orchestration.ts:invoke`, and `src/cleanup.ts:release`. `src/supervisor.ts:verify` rereads the revision and pending operations after command execution before accepting results.

Existing tests in `tests/core.test.ts`: “handover persists a briefing, fences the old lead, and rejects simultaneous takeover”, “redirect rejects stale reports and waits for the previous turn to settle”, and “late output snapshots cannot roll back a concurrent redirect or receipt”. Retain path/symlink and artifact-ownership tests: changing schemas must not broaden task authority or expose tokens.

## Ambiguous external effects must not replay

`src/supervisor.ts:recover` treats persisted `creating`, `prompting`, and control `sending` phases as ambiguous; scheduling reservations before side effects are recoverable separately. Dispatch persists run/creation intent before mutation. `src/continuation.ts:process` and `recover` preserve lead-delivery uncertainty; `src/cleanup.ts:release` persists `closing` before pane/tab closure, and `recover` converts interrupted closure to `uncertain`. A timeout, cancellation, or disconnected acknowledgement cannot prove the external action did not happen. Preserve identity-pinned explicit reconciliation and prohibit automatic mutation retry.

Existing evidence: `tests/core.test.ts`, “ambiguous prompt delivery is never retried automatically, including restart” and “lost split acknowledgement persists intent and reconciles without replaying or prompting”; `tests/orchestration.test.ts`, “ambiguous lead delivery survives restart without replay and stale ownership cannot resume”; `tests/cleanup.test.ts`, “lost pane-close acknowledgement remains uncertain and reconciles with sibling still present”. Schedule-based polling may retry safe observations; it must not wrap an entire dispatch/close/send operation in generic retries.

## Completion includes descendants and current evidence

`Service.report` records a completion receipt; `Supervisor.verify` independently checks artifacts/commands and `Orchestration.unmetTask`. `src/orchestration.ts:unmet`, `taskEvidenceCurrent`, and `refreshEvidence` require current required descendants and criterion assessments, and reopen stale completed work. Preserve scope/depth/budget limits, yielding ownership/capacity, parent revision changes, and independent parent integration checks.

Existing `tests/orchestration.test.ts` cases include “recursive completion rejects failed, blocked, cancelled and unresolved descendants”, “completed parents require their own integration checks after all children pass”, “a new required child fences an in-flight parent verification result”, and “changed verified artifacts reopen the task, ancestors and outcome without invalidating unrelated work”. A successful child fiber or receipt alone cannot complete the parent outcome.

## Resource acquisition, drain, and interruption

`src/server.ts:serve/shutdown` rejects new action calls while stopping, drains `Supervisor.stop`, closes HTTP connections, closes SQLite, then removes its owned lock. `Supervisor.stop` stops scheduling and waits for continuation, cleanup, and busy tasks. `src/continuation.ts:stop` and `src/cleanup.ts:stop` drain active work. External Herdr workers remain alive. Preserve this graceful-drain contract; scope interruption must not silently replace it with task cancellation or terminal closure.

Critical **proposed checks**, using readiness gates rather than arbitrary sleeps:

- Inject failure after lock acquisition, during Store/Service construction, during listener binding, and after background startup. Assert acquired resources finalize exactly once, SQLite closes, listeners/timers disappear, and retry succeeds. Baseline `serve` constructs Store/Service before its listen-error cleanup; this acquisition window is not covered by the integration happy path.
- Hold a Herdr send/close or verification command active, request shutdown, and assert no new scheduling, no database close before draining writes, and no duplicate external call. Separately interrupt the owning operation and assert durable uncertainty where delivery is ambiguous, with no writes after database disposal.
- Test simultaneous startup, stale PID recovery, malformed lock data, and lock replacement between acquisition and failure/shutdown. Remove only the lock this acquisition owns. Baseline normal shutdown checks `lockId`, but listen-error cleanup unlinks unconditionally. `tests/integration.test.ts` covers duplicate startup and normal lock removal; `tests/setup.test.ts` covers a concurrent AGY lock, not this full matrix. Also fault `src/agy-trust.ts:trustAgyWorkspace` cleanup without deleting another owner's replacement lock.

## Process and SDK cancellation

`src/files.ts:command` uses argument-array spawning, strips `MARIONETTE_`/`HERDR_` variables, bounds output, and kills the POSIX process group on timeout. Preserve these properties. The existing “verification timeouts stop their process group and capture failure” in `tests/core.test.ts` only launches one process and checks timeout/nonzero exit. **Proposed:** spawn a descendant, interrupt the owning fiber, verify both processes exit and pipes/timers settle; test spawn failure and platform-specific behavior.

`src/herdr-transport.ts:socketRequest`/`JsonConnection` close sockets and detach abort listeners; preserve SDK Promise/async-iterator contracts, explicit targeting, deadlines, correlated replies, overflow errors, and no reconnect/replay. `tests/herdr-streams.test.ts` already covers cancellation, reader wakeup, overflow/EOF, and lost graphics ACKs. Add cancellation through the application Effect adapter, not merely direct `AbortController` calls.

Audit every `Effect.runPromise` inside an Effect program. In installed `node_modules/effect/src/internal/effect.ts`, `runPromiseWith` reaches `runForkWith`, which creates a new fiber; interruption is connected only when explicitly supplied a signal. Wrapping a nested runner in `tryPromise` without forwarding cancellation detaches work. Prefer `yield*` composition and scoped fibers internally; allow runners at deliberate Promise-facing ingress boundaries with owned lifetime. Prove parent interruption reaches the actual SDK socket/command and waits for finalization. Source search alone cannot establish propagation.

## Integrated review steps

1. Review the final diff against the pinned baseline and trace acquisition/finalization, transaction callbacks, retries, runners, and authority rechecks. Run the proposed fault/cancellation checks alongside retained tests.
2. Run final `npm run check`, `npm test`, `npm run build`, configured lint/Effect diagnostics, and package smoke checks. Record exact revision, commands, results, and skipped platform cases.
3. Retain `tests/integration.test.ts` HTTP/MCP/CLI parity: loopback/Host/Origin/auth enforcement, worker-token separation, error envelopes/statuses, 47 baseline MCP tools, durable shared state, and CLI JSON. Schema errors must still map to `invalid_input`/400 rather than internal failures.
4. Verify `package.json`'s Node `>=22.13`, executable CLI/MCP bundles, public dashboard assets, `./herdr-sdk` export and declarations, plus isolated packed-package imports without workspace dependencies. Retain `tests/herdr-api.test.ts` protocol-22 routing and `tests/setup.test.ts` durable runtime/MCP argument tests. Passing source tests alone does not establish packed-artifact compatibility.
