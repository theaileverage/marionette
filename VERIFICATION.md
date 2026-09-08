# Verification record

## Effect v4 on Bun — 0.3.0 local acceptance (8 September 2026)

Verified locally on macOS arm64 with Bun 1.3.14, Effect 4.0.0-rc.112, TypeScript 7.0.2, and `@effect/tsgo` 0.43.0. The implementation was coordinated through a dedicated Marionette session. The complete Bun suite passed **127 tests across 14 files**, including all 125 retained Effect-era tests and two Bun SQLite compatibility tests.

`bun run check`, `bun run effect:diagnostics`, `bun run format:check`, and `bun run runtime:check` passed. Effect diagnostics reported zero errors, warnings, or messages. A separate clean `bun install --frozen-lockfile` applied the compiler/linter patches successfully; `bun run tooling:check` proved that valid Effects pass while floating Effects and chained casts fail.

`bun pm pack` passed the full prepack checks, tests, lifecycle checks, and production build. The tarball installed into an isolated Bun consumer and passed executable CLI, standalone Herdr SDK, and TypeScript declaration smoke checks without an installed Effect dependency.

The dedicated supervisor was gracefully stopped, its SQLite files preserved, and the new bundled runtime started with the actual Bun executable. The original project identity, complete lead record, and completed task IDs/revisions matched before and after restart. The pre-existing unrelated validation instance was preserved.

Persistence uses `bun:sqlite` directly, with Effect managing its lifetime; it does not yet use Effect's SQL adapter. Tests cover version-2 records, WAL/FULL settings, nested rollback, rejection of deferred transaction results, restart, monotonic event IDs, and refusal of a newer schema. Other new regressions cover graceful draining after client disconnection, explicit fiber interruption, process descendants, socket cancellation, and uncertainty without replay.

Linux CI is configured but was not executed locally. These are local results; the release workflow separately gates publication on CI. Older release evidence below remains historical.

## Herdr SDK and pane layout 0.2.2 (8 September 2026)

The SDK exposes all 102 methods from the installed Herdr 0.9.0/protocol-22 schema plus the documented graphics-stream transport. The 117-test suite covers generated API coverage, socket framing, event cancellation and buffer limits, graphics errors and acknowledgements, pane layout selection, interrupted creation recovery, and sibling-safe terminal cleanup. The packed SDK was imported independently and its public TypeScript types compiled in a fresh consumer.

A disposable named Herdr 0.9.0 session and real attached Herdr client rendered a 120-by-80 four-color fixture through a simulated Kitty-capable PTY with 10-by-20-pixel cells. Captured terminal graphics commands contained byte-exact RGBA (38,400 bytes), RGB (28,800 bytes), converted BGRA (38,400 bytes), and PNG (289 bytes) payloads. A BGRA file frame returned the expected sequence 7 / revision 11 acknowledgement and emitted the expected RGBA pixels. All placements retained the requested 24-by-8-cell size. Frame replacement and stream closure emitted deletions for all five image IDs. The decoded renderer output was visually inspected.

This verifies the installed Herdr server/client rendering pipeline and SDK transports. The outer terminal was simulated; Computer Use denied access to Ghostty, so native Ghostty display and direct-file terminal consumption were not visually verified. No existing Herdr session was controlled and no paid agent was launched. The test server and frame sources were cleaned up.

## Resource lifecycle 0.2.1 (8 September 2026)

The release adds 26 cleanup regression tests to the existing suite (100 total). The cleanup fixtures use real temporary Git repositories/worktrees and SQLite databases, plus an explicitly labelled Herdr protocol double. They exercise integrated-outcome release, retained failures/native-input states, split and replaced tabs, busy workers, lead handover, lost acknowledgements and restart reconciliation, dirty/untracked/ignored files, shared-checkout and registered-project consumers, archived evidence and Git bundles, tampering, branch movement, published-then-merged delivery, explicit abandonment, policy opt-in/revocation, directory/symlink artifacts and continuation after terminal release. HTTP/STDIO integration checks all 47 MCP tools, including the seven cleanup tools.

The installed Herdr protocol-20 schema was inspected for `tab.get`, `pane.list`, `agent.get`, and `tab.close`. No real user worker, tab, branch or worktree was removed in this release exercise, and no paid agent was launched. Protocol-fixture results do not claim new live native-agent acceptance; the earlier 0.2.0 exercise remains documented below.

The built dashboard was checked in an isolated temporary supervisor with no real Herdr connection. Cleanup eligibility rendered the retained worker and blocking reasons. A seven-day retention policy saved and reloaded through the UI. Screenshots were visually inspected at desktop and 390-pixel mobile width; the mobile drawer and document both measured 390 pixels with no horizontal overflow. The test used private fixture state and left production project bindings untouched.

Release gates: formatting, TypeScript checks, release metadata, the full suite, production build, packaged-install smoke, and the Linux/macOS Node 22/24 CI matrix. Evidence archival flushes files/directories before recording success; collection retains an explicit phase through interruptions and rechecks identity/integrity before removal. Herdr does not provide an atomic conditional-close primitive, so external operators must not repurpose a tab while cleanup is closing it.

## Outcome orchestration 0.2.0 (8 September 2026)

Published `@theaileverage/marionette@0.2.0` publicly with the `latest` tag. The registry integrity exactly matches the tested tarball, and an independent fresh-cache registry install returned version `0.2.0`. All required validation, including the cold-resume probe, passed before publication.

The release candidate implements the complete outcome lifecycle. The current suite has **72 tests** covering recursive completion and an in-flight verification race, late requirements, artifact invalidation, cycles, scoped delegation, shared capacity/budgets, native identity fencing, ambiguous delivery, legacy migration, model discovery/validation and actual HTTP/STDIO MCP/CLI parity. Protocol doubles are explicitly separated from the real agent exercise below.

### Real supported-agent acceptance

An isolated named Herdr session ran eleven tracked tasks using Codex `gpt-6-astra` high, Claude `claude-fable-5` high and AGY `gemini-3.1-pro-high`. The persistent outcome completed at tree revision 25 after all four criteria and a separate integrated review passed. The source corpus was a controlled synthetic fixture, not a production benchmark.

- **Research council:** Fable and AGY independently evaluated the same source corpus, disagreed about adaptive versus fixed concurrency, and produced verified artifacts. A separate Fable synthesis was revised after lead review. The final lead decision preserves disagreement and explicitly rejects unsupported per-job retry guarantees and zero-all-cause-retry claims.
- **Bounded debate:** Codex and Fable produced independent round-one claims and fresh verified round-two rebuttals in their original sessions. The strategy retained all four contributions and stopped after two rounds. The final decision records disagreement over stress-test vetoes and a remaining unsupported affected-job bound in Fable's argument. No proposed production experiment was actually run.
- **Nested delegation:** a Codex coordinator requested a registered Fable child, yielded capacity and ownership, resumed its original run/native session on the child's result, and independently integrated it. The supervisor's nested acceptance command passed.
- **Review and repair:** Codex implemented a summarizer against an intentionally flawed helper. AGY independently identified `0.29 → 28`, `1.15 → 114`, and invalid-input handling. A targeted Codex repair and independent Fable re-verification passed both basic and fractional-cent acceptance commands. The reviewer documented half-cent rounding as outside the fixture's two-decimal contract.
- **Restart and interruptions:** the isolated supervisor was restarted repeatedly while preserving worker IDs and sessions. Real startup races, a waiting-parent monitor race and an AGY interruption that swallowed an acknowledged continuation were reproduced and fixed. The ambiguous AGY delivery was explicitly reconciled after inspecting the exact idle pane; its report was then submitted from the same native conversation. No worker report was fabricated by the test harness.

Native CLI versions observed: Codex 0.153.4, Claude Code 2.1.263, AGY language server 1.1.27; Herdr 0.8.2/protocol 20. On this Herdr installation, an attached client was necessary for fresh terminal/status observation. This operating requirement is documented; a fully detached headless session is not claimed as validated. Specific native permission prompts were inspected and approved individually, without disabling native safeguards.

### Model profiles

Live metadata extraction returned seven public Codex models, five exact Claude catalog configurations and fourteen AGY configurations. Together with the evaluated Fable 5 profile, the package includes **27 profiles**. Discovery preserves existing validation and custom defaults. Exact Codex Astra/Luna and Claude Fable 5/Fable 5.1 `[1m]`/Sonnet 5/Haiku 4.5 response probes passed; AGY Gemini 3.1 Pro high and Gemini 3.8 Flash high catalog checks passed. Only the three models in the task exercise above were evaluated on substantive assignments. Catalog inclusion is not an account-independent performance or availability guarantee.

Fable was effective at continuation, child work, synthesis and software re-verification. Its source-analysis errors demonstrate why independent review remains required. Category labels and descriptions are not benchmark rankings.

### Event continuation and cache evidence

The pinned Claude lead waited **2,234.497 seconds (37 minutes 14.497 seconds)** without model polling, then automatically wrote the correct delivery ID and a phrase retained from the original conversation. First resume request: **45,340 cache-read tokens, 1,141 cache-write tokens, 2 uncached input tokens**. The next request read 46,481 cache tokens and wrote 398. Provider counters classified the writes as ephemeral one-hour cache entries; no configurable native TTL or future guarantee is inferred.

Deliberate native compaction reduced reported context from **47,009 to 5,683 tokens**, dropping 41,326. A durable checkpoint preceded it. A second event wait of **75.097 seconds** resumed the same conversation with the correct delivery ID and phrase. Its first request read **30,218** cache tokens and wrote **10,826**, with 2 uncached input tokens; the next read 41,044 and wrote 334. Compaction retained some prefix reuse while requiring new cache writes. Six unique native assistant requests were imported without duplicate message blocks. Native transcript dollar cost and any hidden compaction request usage are unavailable, not zero. No cache-only wakeup was scheduled.

The fresh-conversation checkpoint recovery probe also passed. A new Claude Fable 5 session, with tools and MCP disabled, received only a synthetic checkpoint and returned both the exact recovery phrase and the correct remaining action. Its session ID differed from the original lead. Provider-reported usage was **0 cache-read tokens, 3,911 cache-write tokens, 2 uncached input tokens and 94 output tokens**, with a provider-reported list-price cost of **$0.08294**. These measurements establish an observed cold cache for this probe, not a guarantee that every new conversation starts cold. This test verifies minimal checkpoint recovery; the longer real orchestration exercise above verifies same-session continuation and integration.

### Package checks

The exact 0.2.0 candidate tarball was installed with an independent offline npm cache. Its CLI returned 0.2.0, setup schema exposed `leadProfile`, and supervisor health reported setup contract 2. The dashboard and all 40 bundled STDIO MCP tools worked after deleting that isolated cache; the copied runtime had no `node_modules`. The test supervisor was stopped afterward. Setup also reused the live acceptance project's original name, workspace and lease under 0.2 without installing a global MCP registration.

The tarball has 12 allowlisted files (about 630 kB compressed, 2.7 MB unpacked): bundled CLI/MCP, built dashboard, package metadata, license notices and documentation. No state database, credentials, logs, provider transcripts, test projects or screenshots are included. The final release target is `@theaileverage/marionette@0.2.0`; the publisher verifies the registry tarball integrity against this tested artifact.

### Board and compatibility

The browser created an outcome, rejected a missing evidence reference, recorded criterion and integrated assessments separately, completed the outcome, revised its criteria with a reason, and observed it reopen. Lazy before/after history reads, recursive task cards, dependency navigation and the mobile task drawer were exercised. An outcome-switch form-value leak was found and fixed by resetting the form for each outcome/revision.

At **375, 414, 768, 1024 and 1440 px**, document width equaled viewport width. The 375 px task drawer fit the full viewport. Axe-core 4.12.1 found **zero WCAG 2 A/AA violations** on desktop and mobile; mobile reported four partly clipped horizontal-navigation items whose contrast could not be automatically assessed. Visible controls were visually inspected. This is not a complete accessibility certification.

Schema-2 migration tests preserve v0.1 task IDs, runs, receipts, verification and lead leases. A real Git regression confirms that delegated children inherit a managed checkout outside the registered root without creating an extra worktree, while task-scoped evidence rejects traversal. Transport tests create an outcome through MCP, submit a paused assignment through the actual CLI, read it through HTTP/board, and reject unauthorized worker access and premature completion.

Private reproducibility inputs and provider artifacts remain under `.runtime/v02-live/`; they are excluded from npm. Opt-in scripts are `scripts/live-v02.mjs`, `scripts/cache-v02.mjs`, `scripts/restart-acceptance.mjs` and `scripts/board-validation.mjs`. These use an explicitly named isolated session and refuse duplicate exercise stages. The earlier v0.1 evidence below is historical and does not replace these 0.2 checks.

## Managed worktrees (8 September 2026)

The suite now includes **43 tests**, with 12 new real-Git regression cases for managed execution. Checks cover simultaneous same-file tasks in separate worktrees alongside a shared task, independent completion checks in the new directory, whole-directory ownership before checkout creation, concurrency/dependency waiting, invalid repositories and base refs, monorepo subdirectories, retained worker commits and dirty files on retry, restart adoption without duplicate creation, incomplete/colliding checkout preservation, cancellation during Git creation, absolute-path refusal and symlink revalidation, and changed-branch refusal. Herdr remains a labeled protocol double in these cases; no paid agent work or remote push/PR was performed.

Server/dashboard/test type checks and the production build pass. The HTTP/STDIO MCP and Unix-socket tests pass with local socket permission; the filesystem sandbox initially denied their listeners. The new execution selector and optional base field were exercised through the real dashboard form against a temporary server with worker dispatch stopped. The saved assignment retained `execution: {mode: "worktree", baseRef: "main"}`. Worktree details were inspected using an explicitly seeded display fixture, separate from the earlier live integration exercise below. Form checks at 375, 414, 768, 1024 and 1440 px found no page overflow; both new controls are 44 px high. Long selector labels were shortened after mobile visual inspection.

Lead instructions now require a reasoned recommendation and the user's choice for isolation and delivery unless already authorized. No automatic merge, push, PR, or cleanup policy was added. This validation updates the source and built artifacts; it does not replace or restart an existing installed supervisor or MCP client.

## Earlier validation

Validated locally on 8 September 2026 (Asia/Kolkata). The product is running at `http://127.0.0.1:4380`; obtain its private access link with `node dist/cli.js dashboard`.

## Real integration exercise

The isolated Herdr session was `marionette-validation`, workspace `w1`, project `71013dce-ccb2-4758-868b-5bd85e0f0085`. Existing sessions and panes were preserved. The supervisor used Herdr 0.8.2's supported protocol-20 socket API, not GUI control or fabricated caller variables. Models were inherited from the user's installed agent configuration.

| Path                     | Observed result                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nonblocking MCP dispatch | Three real submissions returned in 8.0, 7.2 and 9.0 ms while workers started independently. The desktop conversation continued during execution.                                                                                                                                                                                 |
| Codex backend            | Task `ecad0278-0834-43d6-b12a-d27e37afc63a`, pane `w1:p3`, attempt 1, revision 3. Reported a currency question, received INR, implemented the ledger. Independent artifact digest and Node acceptance checks passed.                                                                                                             |
| Claude design            | Task `e70877ea-c74a-448e-9cbd-27387ceff737`, pane `w1:p4`, attempt 1, revision 2. Redirected from compact to comfortable density during execution. Independent checks confirmed fresh invoice HTML and comfortable layout metadata.                                                                                              |
| AGY review               | Task `7727932b-c39f-435f-b7fa-39601c0b5efa`, pane `w1:p2`, attempt 1, revision 2. Normal native read/write/report permissions were resolved individually. Recovery review artifact passed an independent content and digest check.                                                                                               |
| Concurrent work          | Backend and design occupied distinct live worker tabs with disjoint ownership. The third review task also ran independently.                                                                                                                                                                                                     |
| Shared decisions         | Currency and density decisions persisted, appeared in the dashboard and were read by the terminal lead.                                                                                                                                                                                                                          |
| Handover                 | Desktop-validation lease handed to terminal-validation at epoch 2. The old lease failed a write with `stale_lead`. A real Codex lead in `w1:p5` confirmed `HERDR_ENV=1`, used Marionette MCP briefing/inbox/decision tools, and recorded decision `f43a5af5-85d6-4bec-ac68-e06c6bff0889`. No CLI fallback was used by that lead. |
| Crash recovery           | The identified supervisor process was deliberately killed during the exercise and restarted with its existing database. Run IDs, pane IDs and attempt counts were unchanged. Running/blocked workers continued; no duplicate task dispatch occurred.                                                                             |
| Desktop discovery        | Project-only config was visible to Codex CLI but did not appear in a fresh desktop task. With explicit user approval, the same server was added through `codex mcp add` at user level. The user confirmed Marionette appeared and connected after refresh.                                                                       |
| Dashboard controls       | Explicit takeover, task-detail output, native-key input, decision creation, dependency-blocked assignment creation, queued pause and cancel all worked against the live store. The cancelled UI-only task remained at attempt 0; no worker was created for it.                                                                   |

Private evidence is retained under `.runtime/`: `live-state.json`, `live-verification.json`, `terminal-lead-receipt.json`, `automated-tests.txt`, browser audit results, and `.runtime/workflow/` worker artifacts. Lease files contain credentials and are deliberately ignored by version control.

The review surfaced a preparation reservation that could stick across restart, interruption without a deadline, missing orphan-pane reconciliation, and missing artifact ownership validation. These were fixed and covered by regression tests. The review artifact is retained as the worker's original assessment, so some findings describe the earlier source snapshot.

## Automated checks

**25 tests passed**, with no skipped tests. `npm run check` typechecks server, dashboard and tests; `npm run build` succeeds; `npm run format:check` succeeds.

Coverage includes nonblocking/idempotent submissions, conflicting keys, lead fencing, overlapping ownership, dependencies, incorrect and obsolete reports, independent acceptance failure/success, redirect ordering, blocked replies, ambiguous dispatch without replay, database restart, replaced pane identity, retry limits, traversal/symlinks, command timeouts, concurrent stale snapshots, late reports, prompt-acknowledgement races, orphan pane recovery/refusal, interactive startup readiness, artifact ownership, bounded interruption, preparation recovery, real fragmented Unix-socket transport, HTTP bearer/Origin/Host rejection, process-lock refusal, and actual STDIO MCP initialization/list/call/error handling.

The protocol double used for failure injection is explicitly labeled; it is separate from the real three-agent evidence above. The HTTP/MCP test launches an actual isolated local server and STDIO client and does not incur worker-model usage.

## Browser checks and limits

- The final overview has **zero detected WCAG 2 A/AA violations** in axe-core 4.12.1. This automated audit is not a complete accessibility certification.
- The actual dashboard was measured at widths **375, 414, 768, 1024 and 1440 px**: document scroll width equaled viewport width at each size.
- Controls were exercised through browser forms; no simulated task completion was written to the database. Dashboard handover downloaded a valid receiving lease and disabled stale controls. Inbox acknowledgement cleared only the browser consumer.
- A real CLI-initiated handover produced the matching in-app notification on the open dashboard. The observed notification text is retained in `.runtime/notification-verification.txt`. Final desktop control belongs to `codex-desktop`; its private lease is `.runtime/desktop-lead-lease.json`.
- A test-browser session unexpectedly reset to `about:blank` during validation. Its session authentication was restored normally and the dashboard rechecked. Durable tasks, decisions, worker identities and the supervisor were unaffected.
- An idle Codex desktop task is **not automatically awakened**. The working path is durable MCP inbox plus the open dashboard. Browser/OS notification delivery depends on permission and an open page; native OS banner delivery has not been separately tested.
- The generated Claude invoice fixture passed static and supervisor acceptance checks; it was not subjected to a separate screen-reader certification.
- No required external connection remains blocked. The runtime is local and manually started after a machine reboot. Strong filesystem isolation is delegated to worktrees and the agents' normal permission systems; ownership is not an OS sandbox.

Integration references consulted: [Herdr socket API](https://herdr.dev/docs/socket-api), [Herdr agents](https://herdr.dev/docs/agents), and [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp). The installed Herdr schema and CLI were inspected before integration.

## npm release and guided setup (0.1.0)

The release adds six regression tests, bringing the suite to **31 passing tests**. New coverage verifies conservative AGY settings updates, malformed settings and concurrent-edit refusal, read-only setup planning, preserved setup preferences, private file permissions, durable runtime reuse after package deletion, all lead-client command argument shapes, and agent identity through fenced handover.

A tarball was installed with `npm exec --offline --package=/absolute/package.tgz` from an independent temporary project. Setup started its own named Herdr session, selected free port 4381 while the original instance remained running, and registered exactly one workspace. Repeating setup preserved the workspace, custom name, lead epoch, and AGY trust entry. Actual Codex, Claude Code, and AGY CLI MCP registrations and reruns passed using an instance-specific test server name. No worker models were invoked by these setup tests.

After deleting that test's npm cache, the supervisor and dashboard still worked, and the standalone bundled MCP server initialized, listed all 14 tools, and returned the correct project briefing. The copied runtime had no `node_modules` directory. `lead --print` discovered the project from a nested directory. Results are retained privately in `.runtime/package-smoke.mjs` and `/private/tmp/marionette-release-check/smoke-result.json`.

The npm tarball uses an explicit files allowlist and includes bundled dependency license notices. State databases, private leases, credentials, screenshots, test projects, and local logs are excluded. Human lead launch preserves the normal CLI trust and permission prompts; native terminal interaction for the new launch shortcut was not separately automated.

Published `@theaileverage/marionette@0.1.0` publicly to npm with the `latest` tag. The public registry integrity matches the locally verified tarball, and a fresh-cache download through `npm exec` returned version `0.1.0`. Temporary MCP registrations and the isolated release-test Herdr session were removed; the original instance was preserved.
