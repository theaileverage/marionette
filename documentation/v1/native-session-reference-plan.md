# Native session references and retained-work inspection

Status: implementation plan authorized by the user on September 13, 2026. The user wants Marionette to copy and adapt Herdr's session-reference implementation so controllers can identify, inspect, and understand native sessions and retained work. This is not approval of every policy default in unit-4-lifecycle-proposals.md.

## Outcome

Every managed attempt exposes its native conversation/session reference when the harness makes one available, including references learned after the first prompt. References preserve their type, harness, source, host, and binding evidence. Controllers can discover the reference, inspect supported native history read-only, and associate it with retained work and checkpoint artifacts. Unsupported inspection is explicit; a PID or pane ID is never presented as a conversation ID.

## Starting state and ownership

Continue the current v1 implementation, including the uncommitted Unit 4 control changes. The dispatch prompt supplies a frozen baseline snapshot and source HEAD. Work in the new task's isolated worktree. Preserve all existing changes; do not overwrite the source worktree or main. Do not push, publish, merge, or deploy. Do not stop, resume, prompt, adopt, or change real user sessions for testing.

Likely owned paths: src/v1/native.ts, runtime.ts, model.ts, store.ts, adapters/herdr.ts, adapters/codex-app-server.ts, codex-app-server.ts, operations.ts, client.ts, command-registry.ts, output-contracts.ts, additive migrations, focused tests/v1 tests, and documentation/v1. Coordinate schema additions with the actual baseline; do not edit previously applied migration SQL. You are not alone in the repository: preserve other edits and report drift.

## 1. Inspect and adapt upstream implementation

Read the repository's applicable instructions and execution contracts. Inspect Herdr source at v0.9.0 first (the vendored schema's version); compare newer source only when necessary and pin the actual commit used. Inspect integration hook/extension/plugin code and session-reference persistence, reporting, validation, and restoration code. Do not infer extraction fields from documentation or invent harness CLI commands.

Build a source-backed matrix for each supported harness: native ID versus session-file path, authoritative event/API and payload field, event timing, reporter installation mechanism, identity validation, and supported read-only history access. Pay particular attention to AGY's reference becoming available after its first invocation, Pi/OMP file references, Codex CLI versus app-server thread identity, and reference changes within a terminal session. Mark unsupported paths explicitly.

Copy/adapt the relevant small modules and hook/reporting logic rather than reimplementing from memory or importing Herdr's entire terminal runtime. Preserve upstream license notices and attribution, record source paths/commit and local modifications, and update THIRD_PARTY_NOTICES.md where required. Existing Herdr integrations remain usable: do not silently duplicate hooks or alter user configuration. If Marionette-owned reporters are needed, implement explicit idempotent installation/uninstallation with isolated config fixtures and no automatic installation into the user's global harness configuration.

## 2. Typed durable references

Replace the lossy nativeSession string model with a typed reference preserving at least harness, kind (id/path, with explicit app-server thread representation as appropriate), value, source/provenance, observed time, host, and associated attempt/session/native generation. Separate the conversation reference from the transport locator (workspace/tab/pane/terminal, endpoint generation, process identity).

Use additive migrations and append-only observation/history records. Old string-only records retain their bytes with legacy/unknown provenance; do not infer an ID/path kind or fabricate evidence. Preserve checkpoint/result links and historical references when a new attempt starts. Avoid exposing credentials, full environment data, or unrelated user session history in outputs.

## 3. Late discovery and identity-safe refresh

Persist the best verified launch identity before work dispatch. Refresh session references through read-only observation after prompt submission, during watcher reconciliation, on explicit inspection, and before checkpoint/retirement decisions. A verified process-only launch may gain a native reference when an authoritative report arrives for the same bound execution.

Treat native transport identity and conversation identity independently. Do not accept a new reference solely because a pane ID or socket path matches. Validate project/host, terminal and native server/process generation, reporter/harness identity and event ordering where supplied. Preserve previous observations; distinguish legitimate session-change events from identity mismatch. If the upstream interface cannot prove the association, keep the candidate unconfirmed rather than attaching another conversation to the attempt.

Do not replay work to obtain an ID. An observation failure cannot turn into a prompt, resume, launch, or adoption. Uncertain effects remain uncertain under the existing control contract. New reference persistence must not invalidate retirement identity matching or let a live process identity be replaced without evidence.

## 4. Controller-facing inspection

Expose typed references through shared SDK/CLI operations and output schemas. Provide an explicit read-only refresh/inspect operation and a history/transcript capability only where the harness supports it. Validate local paths on the recorded host and within the verified session/artifact boundary; never follow an arbitrary reported path into unrelated files. Bound transcript output and offer pagination or artifact export for larger history.

Keep three facts distinct: a known conversation reference, an available native history reader, and durable retained artifacts. Return useful typed statuses when a reference is missing, history is unavailable, the session has disappeared, or identity is unconfirmed. History reads must not resume or mutate a session. Codex app-server uses a supplied owning-server binding and thread/read; it must not connect to an unrelated server or treat an active turn ID as a thread ID.

Update the safe-pause proposal to explicitly link checkpoint artifacts to the originating attempt and its typed native reference/history observations. This adds provenance to the proposal; it does not implement safe pause or adopt unrelated resume/child policy decisions. References and retained artifacts survive a fresh attempt and explicit retirement according to the existing retention contract.

## 5. Acceptance and verification

Use real SQLite, process/reopen persistence tests, real socket fixtures for native adapters, and isolated fixtures for upstream hook payloads/configuration. Test:

- Immediate launch-time session ID and path references preserve all metadata.
- AGY-like launch with no ID gains a verified conversation reference after the first prompt without a second prompt.
- Restart/reopen retains reference history and checkpoint/result linkage.
- Reused pane/socket, host mismatch, stale report/generation, and unrelated session changes cannot rebind an attempt.
- Safe reference enrichment does not break control, settlement, reservations, or retirement checks.
- Legacy references remain readable without invented provenance.
- Reference refresh and history inspection cause zero native launch/prompt/resume/cleanup effects, including paused/cancelled attempts.
- Unavailable history and malformed/unsafe paths fail explicitly and do not expose unrelated content.
- A fresh attempt retains discoverable links to the original attempt and retained artifacts.
- SDK/CLI outputs agree, including bounded history and missing/unsupported states.

Run focused tests, then the full suite, type/lint/build/format checks, and built CLI smoke tests in isolated state. Request sandbox escalation for local socket fixtures if needed. Do not promote fixtures into live compatibility evidence. Produce a final harness matrix showing implemented, fixture-verified, live-verified, and unsupported behavior separately.

## Completion

Deliver implementation, source/license attribution, updated documentation, test evidence, and exact remaining harness limitations. Do not stop after only designing types or storing an ID: late discovery and a controller-facing read-only inspection path are central to the request. Where native transcript inspection is unsupported, ship reference discovery plus explicit unsupported status and durable artifact inspection. Ask for user decisions only when a concrete unresolved product choice prevents safe progress; continue independent work meanwhile.
