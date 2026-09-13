# Native session references and retained-work inspection

Status: implemented and fixture-verified on September 13, 2026. No live user session was used or changed for this work.

## Contract

Marionette stores conversation identity independently from transport identity. The Herdr workspace, tab, pane, terminal, endpoint generation, and foreground process identify the execution transport. A native session reference identifies a harness conversation. A pane ID, process ID, socket path, or active Codex turn ID is never promoted to a conversation ID.

Migration 007 adds immutable, append-only reference observations. Each observation records the attempt and worker session, host and native server generation, typed reference, Herdr source, observation time, and exact binding evidence. Previously persisted `nativeSession` bytes remain `legacy-untyped`; Marionette does not guess whether they were IDs or paths.

Launch persists the best confirmed identity before prompt dispatch. Read-only observation refreshes it after successful prompt submission, during reconciliation, and on explicit inspection. A process-only launch may gain a reference only while the same PID/start-token instance and exact Herdr agent locator remain verified. A changed reference without that process fence is retained as an unconfirmed candidate and does not rebind the attempt.

`attempt retained-work --id ATTEMPT` (SDK: `inspectRetainedWork`) returns four separate facts:

- the attempt;
- every append-only reference observation for it;
- a bounded native-history status/page; and
- every attempt, durable result, and result artifact for the same job, with originating attempt/result IDs.

The operation refreshes native identity by default; raw JSON input with `"refresh": false` reads only durable state. History uses byte cursors, a maximum of 200 records, and a maximum of 262144 bytes. Reference refresh and history reads have no launch, prompt, resume, interrupt, cleanup, or adoption effect.

## Herdr source and validation

The reference normalization is adapted from Herdr v0.9.0 `src/agent_resume.rs`, commit `b99002ac99b09e00b4ca692436cb15a6b0d676f1` (tag object `cca4af8dfad160bc5fb5ae133b70882b5fe28f61`, Apache-2.0). Marionette accepts only Herdr's exact official `(source, agent)` pairs, ID/path limits, and absolute-path rule. It does not install another reporter or alter global harness configuration; the existing Herdr integration remains authoritative.

| Harness | Reference | Authoritative report | Timing | Herdr installation | Native history |
| --- | --- | --- | --- | --- | --- |
| AGY (`agy`) | ID | `herdr:antigravity_cli`, reported conversation ID | May appear after first invocation | Herdr-owned `hooks.json` block and reporter script | Unsupported; durable references/artifacts remain available |
| Pi | Absolute JSONL path preferred, ID fallback | `herdr:pi`, session path/ID | Session start/change events | Herdr extension | Bounded local JSONL for a confirmed path |
| OMP | Absolute JSONL path preferred, ID fallback | `herdr:omp`, session path/ID | Session start/change events | Herdr extension | Bounded local JSONL for a confirmed path |
| Claude | ID | `herdr:claude` `SessionStart` report | Start/resume/clear/compact | Herdr hook scripts | Unsupported |
| Codex CLI | ID | `herdr:codex` `SessionStart` report | Start/resume | Herdr hook scripts with Codex hooks enabled | Unsupported |
| Copilot, Devin, Droid, Kimi, Mastracode, Qoder CLI, Qwen, Cursor, Grok | ID | Matching `herdr:<agent>` report | Harness hook/session events | Herdr-owned hook scripts/config | Unsupported |
| Hermes | ID | `herdr:hermes` report | Plugin session events | Herdr plugin | Unsupported |
| OpenCode | ID | `herdr:opencode` report | Plugin session events | Herdr plugin | Unsupported |
| Kilo | ID | `herdr:kilo` report | Extension session events | Herdr JavaScript integration | Unsupported |

For Pi/OMP history, the durable confirmed path is the only input. The controller cannot supply a replacement path. The reader requires the recorded host, a user-owned regular `.jsonl` file, exact real path, no symbolic link traversal, a line-boundary cursor, and bounded bytes. Missing, malformed, oversized-record, and unsafe paths return explicit statuses without reading another path.

## Codex app-server

Codex CLI session IDs and Codex app-server thread IDs are distinct kinds. The app-server adapter accepts an explicit owning binding containing project, execution host, endpoint host, and thread ID. Its read capability calls `thread/read` with that thread ID and `includeTurns: true`, verifies the returned thread ID, and returns only a bounded tail. `activeTurnId` is used solely as an expected-turn fence for delivery and is never treated as the thread ID.

The current app-server protocol recommends paginated turn/item endpoints for large histories. This v1 adapter intentionally implements the authorized `thread/read` slice and bounds its returned tail; it does not claim complete large-history export. It is SDK-only because the managed Herdr attempt runtime has no durable Codex app-server owning binding.

## Verification status

| Behavior | Implemented | Fixture-verified | Live-verified |
| --- | --- | --- | --- |
| Herdr typed ID/path extraction and official source pairing | Yes | Yes | No |
| Immediate reference persistence | Yes | Yes | No |
| AGY process-only launch enriched after one prompt | Yes | Yes, real Unix socket fixture | No |
| Append-only SQLite persistence and legacy preservation | Yes | Yes, real SQLite | No |
| Pi/OMP bounded JSONL history and unsafe-path rejection | Yes | Yes, real files | No |
| Codex app-server bound `thread/read` history | Yes | Yes, transport fixture | No reachable desktop endpoint was used |
| Retained attempts/results/artifacts across a fresh attempt | Yes | Yes, real SQLite/artifact bytes | Not applicable |

Fixture verification proves Marionette's contracts and failure behavior, not that every installed harness currently emits the expected event. Live compatibility remains a separate acceptance step.
