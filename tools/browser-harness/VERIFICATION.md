# Browser harness verification — 9 September 2026

Tested locally on macOS with Bun 1.3.14, Herdr 0.9.0, wterm DOM/Ghostty 0.5.0, and agent-browser 0.36.0 (Chrome for Testing 152).

## Observed

- wterm loaded the Ghostty WASM asset from the local server and rendered Herdr's workspace sidebar, tabs, shell prompts, and Unicode text.
- Browser keyboard input launched a unique `wterm-*` session. Commands inside it confirmed `HERDR_ENV=1`, pane `w1:p1`, workspace `w1`.
- Marionette setup succeeded for a fresh Git repository and an existing Git repository with committed, dirty, and untracked files. MCP registration and workspace trust were disabled.
- Repeat setup succeeded. The smoke script checks stable fresh-project identity, distinct existing-project identity, and exact preservation of fixture file contents.
- Reloading the page reconnected to the same Herdr pane. A new command printed `RECONNECT_OK pane=w1:p1`.
- Desktop and mobile screenshots were visually inspected. Viewports at 375 and 768 pixels had no document horizontal overflow. Herdr adapted to a compact layout at 375 pixels. Desktop rendering was checked at 1280 pixels and resized to 1440 pixels.
- Request-validation tests cover origin/host/capability-path rejection and malformed or oversized terminal messages and invalid dimensions.

## Issue found during acceptance

The pre-existing repository bundle reported version 0.5.0 while its package metadata said 0.4.0. Initial setup succeeded, but subsequent setup required a runtime upgrade; replacing it with a consistent 0.4.0 build correctly refused a downgrade. Those results were retained in the first disposable fixture.

Acceptance continued with a separately bundled current-source runtime and a clean disposable fixture. The harness now prepares that isolated runtime by default, avoiding replacement of concurrent repository build outputs. No Marionette lifecycle source was changed by this harness work.

## Limits

This proves the browser → wterm → native PTY → Herdr → Marionette setup path. It does not yet verify historical-version database migrations, real AI lead/worker completion, approval dialogs, supervisor crash recovery, multi-browser control, or exhaustive terminal protocol compatibility. The browser screenshots and raw setup artifacts remain local; private capability URLs are not checked into the repository.

## Guarded launch regression — 10 September 2026

Tested the `codex/coordinator-roles-omp` worktree using its rebuilt package through `MARIONETTE_CLI`, with separate before/after browser harness sessions. Both runs passed baseline fresh/existing setup, repeat setup, stable project identity, and preservation of dirty and untracked files.

- Before the fix, the browser reproduced the reported launch: the long inline hook/MCP command was cut off while entering the new shell, leaving an incomplete line. The native Codex screen never appeared.
- After the fix, both fixtures reached Codex's native workspace trust screen. Independent Herdr process snapshots contained actual `codex` and `node` processes, both hooks, the scoped MCP configuration, read-only sandbox, disabled shell/native delegation, and the complete final bootstrap argument. The reconstructed shell command was 699 bytes.
- Repeating launch after native startup preserved each lead's exact pane, terminal, and launch receipt. Exiting the fresh fixture's trust prompt and relaunching reused its original terminal. Browser reload and a 1440×900 resize preserved the native screen; the next shell check confirmed the same `w2:p2` identity.
- An early scenario attempted reuse before native startup completed and encountered pending agent metadata. The reusable scenario now waits for the visible native trust screen before asserting reuse. No launch is replayed merely because startup is pending.
- Trust prompts were left unanswered or declined. This is native launcher verification, not model-backed lead/worker completion or full guard-hook enforcement inside a model turn. Unit and integration checks cover generated configuration, exact wrapper argv/environment, scoped guard requests, compaction responses, and rejection of oversized encoded input before Herdr calls.
- Automated validation: 246 tests passed; two harness security tests passed; type/lint, formatting, build, and runtime lifecycle checks passed. Effect diagnostics reported zero errors, zero warnings, and six existing suggestions.

Private artifacts were retained in the disposable `marionette-browser-MyLoUL` (before) and `marionette-browser-YCcPMj` (after) fixture directories, including `launch-assertions.json`, process snapshots, terminal receipts, and native-screen captures. No capability URLs or raw setup credentials are included here.

## Multiple intents and full prompt delivery — 10 September 2026

Used current-source temporary runtimes from the same isolated worktree, Codex CLI
0.153.4, and a `gpt-5.6-sol`/low profile validated by the real CLI on this account.
All Herdr commands ran through the dedicated browser terminal after verifying its
real `HERDR_ENV=1`. Each connected runtime passed fresh/existing setup, repeat setup,
stable identity, and preservation of dirty/untracked files.

- A live initial run revealed native MCP approval rejection before outcome creation.
  The generated configuration now approves only the session's scoped Marionette
  server; role, authority, and project capability checks remain in Marionette.
- In `marionette-browser-HqmabQ`, the lead received a read-only compatibility
  investigation. After the first task entered `preparing`, a second message added a
  startup investigation without reminding the lead to preserve earlier work. The
  lead explicitly treated it as additive, created two outcomes, ran two workers,
  assessed their file evidence, integrated and completed both outcomes. Both task
  revisions remained 1. Independent SQLite and filesystem assertions confirmed
  both completions and exact preservation of both evidence files and the existing
  repository's dirty/untracked files. Evidence: `multiple-intents-assertions.json`.
- That real run exposed two wait defects: scoped transport added an excess
  `projectId`, and the backend allowed only one active wait per lead. These are
  corrected: one active wait is allowed per outcome, while an atomic capacity
  reservation serializes delivery to the lead. A regression test makes two outcomes
  ready together, verifies one initial prompt, then verifies delivery of the second
  after the first settles. Existing uncertain-delivery/no-replay tests still pass.
- Against the final rebuilt runtime in `marionette-browser-3jh1Qb`, the real STDIO
  scoped MCP created two outcomes and registered two waits in each fresh/existing
  project. Both intents appeared in each briefing, administrative authority tools
  remained absent, and `evidence/scoped-waits.json` records the assertions. This
  transport scenario uses `next-message` waits and does not claim two automatic
  native wake-ups were observed with real models.
- Native session inspection confirmed the full generated lead instructions were
  injected exactly, separately from the visible bootstrap. `/compact` restored the
  same full contract on the next turn. An intermediate prompt lacked the exact
  MCP server pointer: after compaction the model selected unrelated global
  connections, which the guard blocked. The final contract explicitly identifies
  `marionette_lead` and forbids substituting another connection.
- In the final `marionette-browser-3jh1Qb` session, a normal status question after
  `/compact` caused the lead to rediscover the exact scoped server and successfully
  read `project_briefing`, `inbox_read`, and `swarm_observe`. It reported both open
  fixture investigations and their separate waits without a corrective message or
  new worker dispatch. The full 13,921-character generated contract matched exactly
  before and after compaction. Native terminal text and independent session/state
  assertions agree; `evidence/compaction-assertions.json` records the result.
- Automated validation of the final source: 250 tests passed across 27 files;
  two harness security tests passed; type/lint, formatting, build, and runtime
  lifecycle checks passed. Effect diagnostics reported zero errors, zero warnings,
  and six existing suggestions. The first sandboxed suite attempt could not bind
  transport sockets; the complete suite passed with the required local access.

Real model completion here covers two bounded read-only file investigations.
Historical migration compatibility, all harness adapters, and the separate
conversational write-authority UX are not established by this scenario. Fixture
resources and private evidence are retained; no raw credentials or terminal
capability URLs are included in this record.
The three native trust entries added for disposable model-test repositories were
restored after testing; all other parsed Codex configuration was preserved.

## PR 17 CI portability repair — 10 September 2026

The guarded-launch unit fixture now supplies its own Codex help executable, and
its symlink escape fixture targets the platform temporary directory. Production
source is unchanged. Local type/lint, formatting, all 250 tests, and runtime
lifecycle checks passed. A new browser-controlled Herdr session verified
`HERDR_ENV=1`, fresh/existing/repeat setup, distinct stable project identities,
and preservation of dirty/untracked fixture files. All nine coordinator tests
also passed through browser input; terminal success markers were checked against
independent evidence logs. This repair did not rerun real model completion.
