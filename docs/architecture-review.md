# Independent architecture judgment

## Decision

Use Architecture A as the base: an additive `effect-port/` with a synchronous, privately owned SQLite authority kernel and Effect-native application/runtime workflows. Graft B's explicit no-replay interruption matrix. Keep the existing filenames and broad v1 ownership boundaries initially to reduce parity churn; copied internal kernel code is a real port once Effect Schema, typed errors, resource lifecycle, and workflow ownership move into `effect-port/` and no baseline `src/v1` implementation modules are imported.

Do not adopt B's append-only command/fact database, transactional projections, offline state importer, or new release/state format. Do not add a new MCP surface. Those are product and persistence changes beyond the requested same-functionality migration.

## Rubric scores (0-3)

| Criterion | A | B | Judgment |
| --- | ---: | ---: | --- |
| Authority and transactions | 3 | 3 | Both keep authentication/fences/idempotency/writes transactional and external work outside commits. A maps most directly to the proven `BEGIN IMMEDIATE`/savepoint kernel. |
| Native uncertainty | 2 | 3 | A preserves claim-before-call and no replay, but B explicitly covers pre-claim, post-claim, in-submission, post-submission, interruption, takeover, and malformed-response cases. |
| Interface depth | 3 | 3 | A's use-case facade and B's `execute` interpreter both hide journal choreography. A better preserves named domain use cases. |
| Migration feasibility | 3 | 1 | A defines independently falsifiable parity slices and a no-baseline-import rule. B requires a wholesale persistence rewrite and import/cutover machinery outside scope. |
| Extension safety | 2 | 3 | B fully states schema/version/digest/authority rules. A omits this from the report, although the existing port catalog already validates versioned descriptors, resource digests, parent pins, cycles, and exact resolution. |
| Operational compatibility | 3 | 2 | A explicitly preserves CLI, SQLite, package, and dependency-free Herdr behavior. B states parity, but its new state model/importer creates avoidable compatibility risk. |
| **Total** | **16/18** | **15/18** | Neither is disqualified; A is the lower-risk base for the authorized migration. |

## Required corrections to A

1. Do not claim `run: (tx) => A` automatically prohibits `A = Promise<_>`, `Effect<_>`, or hidden I/O. TypeScript generics do not enforce that. Keep the transaction capability private, expose only closed domain commands constructed inside the authority module, retain a runtime thenable guard, and add import/lint/API tests that prevent filesystem, provider, Herdr, subprocess, and public raw-database access from authority commands.
2. Replace the current report's underspecified `context-pending` recovery. Today SQLite stores only the token hash while the `0600` context file contains the plaintext token. Reconstructing it from "authoritative stored fields" would require persisting the credential. A safer protocol is: generate and write a private temporary context file first; atomically commit the session hash, attempt, reservation, final path, and pending temporary path; rename the exact file after commit; recovery renames that retained file and never stores plaintext credentials in SQLite.
3. Preserve current filenames under `effect-port/src/v1/` for the first parity slices (`database.ts`, `store.ts`, `runtime.ts`, `watcher.ts`, and related modules). Decompose only when a later slice proves that the ownership move reduces reader load without changing behavior.
4. Define every native mutation against B's matrix: before claim may remain retryable; after durable claim, during submission, after submission, cancellation, timeout, EOF, malformed response, or executor death must retain claim/identity/reservation and must never replay. Only a boundary-proven pre-invocation failure may return to retryable state.

## Accepted grafts and rejections

- Graft B's queued-versus-claimed distinction only as a lifecycle law where current behavior already has a pre-invocation queue; do not make it a new event-sourced database.
- Graft B's takeover rule: claims from a positively absent owner become inspectable `unconfirmed`, never queued again.
- Reuse the existing `effect-port/src/extensions.ts` descriptor/catalog work, then add an explicit test that descriptors cannot receive credentials, database handles, native clients, or mint authority.
- Reject service-per-method wrappers, exported raw `DatabaseSync`, generic public transactions, and port methods that merely call baseline `Store`, `Runtime`, `Watcher`, or `Marionette` classes.
- Reject state import, root cutover, publication, and release work for this migration. Preserve current unsupported/not-implemented outcomes rather than inventing capabilities.

## Evidence and implementation gate

Verified local prerequisites are Node `v26.8.1`, Bun `1.3.14`, and isolated `effect-port/node_modules/effect` exactly `4.0.0-rc.112`. The authoritative baseline is 108 passing tests when Unix sockets are allowed. Existing source confirms synchronous `BEGIN IMMEDIATE` transactions, nested savepoints, runtime thenable rejection, durable native claims before Herdr calls, and watcher claims settling to acknowledged or unconfirmed. The dependency-free Herdr modules contain no Effect import.

Start with the smallest authority parity slice inside `effect-port/`: copied internal database/store files, Effect Schema row/domain decoding, tagged failures, scoped database acquisition, one complete authenticated/idempotent command, and real-file restart/concurrency tests. It is complete only when its import graph contains no baseline implementation imports and normalized output plus durable rows match the v1 oracle.

This review is independent of the two proposals but is same-family rather than cross-family. The requested synthesis/final-review model remains GPT-6 Astra, and Sol workers should receive exclusive implementation file ownership.
