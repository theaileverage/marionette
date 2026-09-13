# Alpha integration review

September 11, 2026. Target version `1.0.0-alpha.1`.

Independent reviews covered runtime effects, context and actor checks, handoff, result evidence, storage, retirement, SQL, and packaging. The integration owner assessed each finding and applied the accepted changes.

## Fixed findings

- Handoff claims require an assigned running integrator on the exact target write workspace. Only a user or controller can assign the public claim; the chosen worker can run checks and complete it.
- An integrated handoff requires the accepted source patch to be present in the checked target. A passing command alone cannot prove delivery. Source acceptance is checked again at completion.
- Recovery includes launch and prompt claims. Ambiguity is recorded atomically without releasing reservations or resending effects. A later exact idle observation can settle an attempt with a previously recorded result.
- Result content and evidence require catalogued, digest-verified durable bytes. Evidence-only attachments are retained and checked again before initial acceptance. Idempotent replay preserves the earlier decision.
- Settled or uncertain actors cannot submit new results. Identical retries return the result recorded while the attempt was active.
- SDK initialization and custom environment options cannot bypass an inherited managed context.
- Concurrent SQLite initialization retries a busy WAL-mode change within the configured timeout. The existing startup race test passed 12 repeated runs after the reproduced failure was fixed.

The comment review found no actionable comment or suppression changes. The retained explanatory comments cover recursive JSON and Node declaration gaps.

## CLI contract

The command registry derives scalar flags from the operation schemas and supplies help and offline introspection metadata. The installed CLI exposes input constraints and output contracts, supports flags or bounded raw JSON without merging them, and keeps machine stdout separate from diagnostics. Human output escapes controls and reports abbreviation. Process validation precedes project connection. Workspace retirement has a local preview that shares retirement checks while skipping native effects and persistent mutation. Its connection opens existing credentials and SQLite read-only; pending migrations or missing setup fail without initialization.

Review corrected explicit machine output being ignored on parser errors, human watcher warnings using JSON, and malformed credential JSON leaking parser excerpts. Context reports credential source and effective scope without exposing the bearer. Non-board list pagination remains a follow-up to preserve the existing complete JSON results.

## Adapter composition

The shared Adapter API supplies schema-validated capability modules, typed invocation, offline descriptions, cooperative cancellation, stable failure phases, and exact-version registry lookup. Herdr execution, native board delivery, and retirement use the composed contract. Codex app-server messaging supplies a separate capability module. Third-party CLI loading and provider scheduling remain separate integrations.

Tests cover invalid input before execution, malformed output after execution, cancellation, duplicate/version rejection, JSON representation, a disposable process implementation, and the existing Herdr lifecycle through the public adapter. Adapter failures retain uncertain outcomes without adding automatic retries.

## Verification

The integrated Node suite passes 107 tests against temporary SQLite databases, Git worktrees, local Unix sockets, native protocol fixtures, and real CLI subprocesses/PTYs. The process suite proves flag/JSON parity, pre-connection errors, credential redaction, terminal rendering, and non-mutating retirement previews. Type checking, lint, formatting, release metadata, and production build pass. The installed tarball smoke checks CLI/SDK collaboration, an isolated SQL worker from an unrelated directory, workflow resource loading, and public TypeScript declarations.

A separate live Herdr/AGY fixture returned the requested marker after one adapter prompt. It was left idle. That probe does not prove the complete assignment/revision/control/handoff lifecycle.

## Remaining work

Automatic workflow progression depends on brief revisions, transitions, pause/cancel/resume, and limit changes. Those operations remain unavailable pending the source-only authorization request after automatic approval review rejected their implementation.

The actual desktop-owned Codex app-server exposes private stdio in the tested environment. Desktop notifications remain unavailable. Native worker subscriptions use their registered session identities; local user subscriptions do not provide a desktop transport.

Retirement treats already-settled sessions as released consumers and can leave their idle native tabs open. Uncertain cleanup claims are retained and never blindly repeated.

The full live assignment lifecycle and stable-release acceptance scenarios remain incomplete. This work has not been tagged or published.
