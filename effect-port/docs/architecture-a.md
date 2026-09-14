# Architecture A: native Effect services over a synchronous SQLite authority kernel

## Problem

Marionette v1 currently presents a synchronous class API, validates CLI operations with Zod, and delegates almost every durable state transition to one `Store` over Node's synchronous `node:sqlite` API. The same process also coordinates asynchronous Herdr calls, watcher polling, filesystem work, subprocesses, and artifact verification. A whole Effect port therefore cannot be a set of `Effect.try` wrappers around the current classes. It must move workflow ownership, typed failure, resource lifetime, scheduling, and interruption into native Effect services while keeping SQLite as the atomic authority kernel. The port must remain on Node 26.8.1 or newer, keep the public Herdr SDK dependency-free, preserve every dirty file in the existing tree, and live in a new repository-root folder so the current `src/v1` implementation remains an untouched comparison oracle during migration.

The proposed root is `effect-port/`. This name is provisional but the isolation is load-bearing. No migration slice moves, deletes, or edits `src/v1`, `tests/v1`, the root Herdr SDK files, or current dirty files. The new root owns its own source, tests, TypeScript configuration, and package metadata until parity is proven.

## Grounded current flow

The ingress path is shallow but imperative today.

1. `operationSchema` parses a discriminated operation and `execute` switches directly to `Marionette` methods (`src/v1/operations.ts:32-231`, `src/v1/operations.ts:240-330`).
2. `Marionette` resolves local identity, opens one `Store`, authenticates, and constructs board, SQL, settings, runtime, and artifact helpers in its constructor (`src/v1/client.ts:50-109`). Most public methods authenticate and forward to one collaborator (`src/v1/client.ts:202-241`, `src/v1/client.ts:289-365`). This is useful behavior, but the forwarding surface is a shallow module and should not become a service-per-method Effect design.
3. `Store.open` creates the synchronous database handle and binds it to exactly one project (`src/v1/store.ts:581-613`). `read` and `transaction` both enter the same transaction engine; outer writes use `BEGIN IMMEDIATE`, nested calls use savepoints, Promise-returning callbacks are rejected, and every exception rolls back (`src/v1/store.ts:621-696`).
4. Idempotency is part of the authority transaction. It digests a canonical payload, rejects key reuse with changed input, executes the transition, and stores the encoded result before commit (`src/v1/store.ts:629-669`).
5. Attempt admission checks actor, job, brief, workflow revisions, role separation, capacity, accepted inputs, and workspace availability before atomically inserting the attempt and its exclusive reservation (`src/v1/store.ts:1417-1599`). SQLite also enforces one held or uncertain reservation per resource (`src/v1/migrations/001_core.ts:145-160`).
6. Runtime admission composes session creation, store admission, context-file creation, and the native-attempt record under an idempotency scope (`src/v1/runtime.ts:108-200`). This reveals one current atomicity gap: `writeSessionContext` is filesystem I/O inside the database transaction callback (`src/v1/runtime.ts:169-187`). The Effect port must make the durable ordering explicit rather than imply SQLite can roll back a file.
7. Before each native mutation, `Runtime.journal` rechecks brief, workflow control, and attempt phase and inserts one `native_effects` claim. A prior claim rejects replay (`src/v1/runtime.ts:203-244`). The claim is committed before `launch` or `prompt` awaits Herdr (`src/v1/runtime.ts:268-322`, `src/v1/runtime.ts:356-382`).
8. Observation is non-authoritative until persisted. Ambiguous launch or prompt results settle the attempt as unconfirmed, and reconciliation requires both a settled native observation and a durable result (`src/v1/runtime.ts:385-460`). Tests directly assert concurrent start claims only one launch and prompt, crash-after-claim does not replay, working recovery does not resend, and later settlement remains possible (`tests/v1/runtime.test.ts:204-314`).
9. SQLite startup itself is authority-sensitive. It uses `node:sqlite`, WAL, `synchronous = FULL`, foreign keys, a bounded busy timeout, `BEGIN IMMEDIATE` migrations, checksum history, and rollback (`src/v1/database.ts:162-220`, `src/v1/database.ts:222-264`). Migration tests cover failed-migration rollback and concurrent first open (`tests/v1/store-migrations.test.ts:186-238`).
10. The watcher durably claims deliveries, invokes a Promise-based port only after claim, then records acknowledged or unconfirmed. Takeover requires confirmed prior-owner absence and never replays an uncertain claim (`src/v1/watcher.ts:271-330`, `tests/v1/watcher.test.ts:58-180`).
11. The Herdr SDK is intentionally a normal Promise and async-stream API. Its public surface imports only the generated protocol, stream, and transport modules (`src/herdr-sdk.ts:1-50`). The underlying transport uses Node `net`, `AbortSignal`, bounded queues, and explicit failure semantics (`src/herdr-transport.ts:1-93`). Effect must remain on Marionette's side of this boundary.

## Usage, written before the shape

Application code should read as domain work, not database choreography.

```ts
import { Effect, Layer } from "effect"
import { Marionette, Runtime, Watcher } from "../effect-port/src/index.js"

const program = Effect.gen(function* () {
  const marionette = yield* Marionette.Service
  const admitted = yield* marionette.admitAttempt({
    jobId,
    profile: "codex",
    nativeWorkspaceId: "main",
    inputResultIds: [],
    expectedBriefRevision: 1,
    idempotencyKey: "lead/attempt-1"
  })
  return yield* marionette.startAttempt(admitted.id)
}).pipe(Effect.provide(Marionette.live(resolvedContext)))
```

The watcher owns its long-lived fiber and stops when its layer scope closes.

```ts
const watcherProgram = Effect.gen(function* () {
  const watcher = yield* Watcher.Service
  yield* watcher.run
})

await NodeRuntime.runMain(
  watcherProgram.pipe(Effect.provide(Watcher.live(projectContext)))
)
```

An adapter converts the dependency-free Herdr API once at the boundary.

```ts
const launch = Effect.fn("HerdrExecution.launch")(function* (request: LaunchRequest) {
  const herdr = yield* HerdrExecution.Service
  return yield* herdr.launch(request)
})
```

Tests substitute services without touching globals or sleeping.

```ts
it.effect("does not replay a claimed native effect", () =>
  Runtime.start(attemptId).pipe(
    Effect.provide(Runtime.testLayer({ crashAfterClaim: "launch" })),
    Effect.andThen(Runtime.start(attemptId)),
    Effect.andThen(RuntimeTest.launchCount),
    Effect.tap((count) => Effect.sync(() => assert.equal(count, 0)))
  )
)
```

The CLI boundary decodes once, invokes one application service, and encodes the result.

```ts
const execute = Effect.fn("Operation.execute")(function* (unknownInput: unknown) {
  const operation = yield* Schema.decodeUnknown(Operation)(unknownInput)
  const marionette = yield* Marionette.Service
  return yield* marionette.execute(operation)
})
```

## Shape

### Core data structure

The central structure is an authority command that can run only inside the synchronous kernel.

```ts
declare const AuthorityCommandTypeId: unique symbol

export interface AuthorityCommand<A> {
  readonly [AuthorityCommandTypeId]: (_: never) => A
  readonly operation: AuthorityOperation
  readonly payloadDigest: Digest
  readonly run: (tx: AuthorityTransaction) => A
}

export interface AuthorityKernel {
  readonly read: <A>(query: AuthorityQuery<A>) => Effect.Effect<A, AuthorityError>
  readonly commit: <A>(command: AuthorityCommand<A>) => Effect.Effect<A, AuthorityError>
}

interface AuthorityTransaction {
  readonly database: DatabaseSync
  readonly project: ProjectBinding
  readonly now: Timestamp
  readonly newId: <A>(kind: string, schema: Schema.Schema<A>) => A
}
```

`AuthorityCommand.run` is deliberately synchronous. It cannot return an Effect, Promise, stream, file operation, adapter call, or subprocess result. The live `AuthorityKernel.commit` implementation uses the existing `BEGIN IMMEDIATE` plus nested-savepoint semantics. The Effect service suspends one complete synchronous commit with `Effect.try`, maps failures to `Schema.TaggedError`, and returns only after SQLite commits. Effect interruption cannot occur halfway through JavaScript's synchronous transaction callback. This encodes the current rule rather than depending on every caller to remember it.

The kernel should expose domain commands and queries, not raw `DatabaseSync`, to application services. A temporary internal `unsafeTransaction` may exist during migration, but it is not exported and must have a deletion test or an explicit final slice. Exporting raw SQL through the Effect service would preserve the current Store's 2,454-line knowledge leak and would be wrapping rather than a port.

### Service signatures

```ts
export class Authority extends Context.Service<Authority, AuthorityKernel>()(
  "@marionette/Authority"
) {}

export interface AttemptsApi {
  readonly admit: (input: AdmitAttempt) => Effect.Effect<AdmittedAttempt, AttemptError>
  readonly claimLaunch: (input: ClaimLaunch) => Effect.Effect<Attempt, AttemptError>
  readonly observeRunning: (input: ObserveRunning) => Effect.Effect<Attempt, AttemptError>
  readonly settle: (input: SettleAttempt) => Effect.Effect<Attempt, AttemptError>
  readonly get: (id: AttemptId) => Effect.Effect<Attempt, AttemptNotFound | AuthorityError>
}

export class Attempts extends Context.Service<Attempts, AttemptsApi>()(
  "@marionette/Attempts"
) {}

export interface NativeEffectsApi {
  readonly prepare: (
    attemptId: AttemptId,
    effect: NativeEffect
  ) => Effect.Effect<PreparedNativeEffect, NativeEffectRejected | AuthorityError>
  readonly recordObservation: (
    attemptId: AttemptId,
    observation: NativeObservation
  ) => Effect.Effect<void, RuntimeError>
}

export class NativeEffects extends Context.Service<NativeEffects, NativeEffectsApi>()(
  "@marionette/NativeEffects"
) {}

export interface HerdrExecutionApi {
  readonly launch: (input: LaunchInput) => Effect.Effect<LaunchResult, HerdrError>
  readonly prompt: (input: PromptInput) => Effect.Effect<NativeSubmission, HerdrError>
  readonly observe: (identity: NativeIdentity) => Effect.Effect<NativeObservation, HerdrError>
  readonly cleanup: (input: CleanupInput) => Effect.Effect<CleanupResult, HerdrError>
}

export class HerdrExecution extends Context.Service<HerdrExecution, HerdrExecutionApi>()(
  "@marionette/HerdrExecution"
) {}

export interface RuntimeApi {
  readonly admit: (input: RuntimeAdmission) => Effect.Effect<AttemptId, RuntimeError>
  readonly start: (id: AttemptId) => Effect.Effect<RuntimeInspection, RuntimeError>
  readonly inspect: (id: AttemptId) => Effect.Effect<RuntimeInspection, RuntimeError>
  readonly reconcile: (id: AttemptId) => Effect.Effect<RuntimeInspection, RuntimeError>
}

export class Runtime extends Context.Service<Runtime, RuntimeApi>()(
  "@marionette/Runtime"
) {}
```

Every public and non-trivial internal operation uses `Effect.fn("Domain.operation")`. Persisted and wire inputs use Effect Schema with branded IDs and tagged unions. Expected failures use `Schema.TaggedError`. Zod remains only at compatibility boundaries while old fixtures or generated Herdr contracts require it. Boundary decoders parse unknown CLI, persisted JSON, and adapter payloads; internal services trust decoded domain values.

The top-level `Marionette.Service` is a deep application facade. It groups complete use cases such as `createWorkflow`, `admitAttempt`, `startAttempt`, `recordResult`, and `decideResult`. It does not expose `read`, `transaction`, `prepare`, or step-by-step persistence choreography. Domain services remain separately available to internal workflows and focused tests. The public facade hides authentication, authority commits, journal claims, adapters, artifacts, and error translation behind one effect per use case.

### Runtime ordering

The launch workflow is a three-step protocol with an explicit uncertainty boundary.

```text
Authority.commit(claim launch + native_effect row)
  -> HerdrExecution.launch
    -> Authority.commit(confirmed identity | unconfirmed outcome)
```

No provider, filesystem, Herdr, Git, or subprocess effect runs inside `Authority.commit`. If interruption or process loss occurs after the first commit, the durable claim remains and the next run inspects. It never launches again. If Herdr returns a confirmed identity, the second commit binds the attempt and session to that identity. If the response is lost, the second commit records uncertainty only when it has truthful evidence; otherwise the pre-existing claim itself is sufficient to prohibit replay.

Runtime admission needs a specific repair. Generate session identity and token outside the commit, commit the session, attempt, reservation, and a `context-pending` record atomically, then write the context file with an atomic temp-file rename, then mark it ready in a second commit. A crash leaves a repairable pending projection. The watcher may repair the file from authoritative stored fields because writing identical context bytes is idempotent. This removes filesystem work from the transaction without weakening launch admission.

### Lifecycles and concurrency

`Database.live` acquires one `DatabaseSync` with `Effect.acquireRelease`; release closes it exactly once. `Watcher.live` acquires durable watcher ownership, forks `runPass().pipe(Effect.repeat(Schedule.spaced(...)))` with `Effect.forkScoped`, and settles ownership in a finalizer. Runtime work uses scoped fibers or a `FiberMap<AttemptId, ...>` so one process has at most one active workflow fiber per attempt. SQLite constraints and compare-and-set updates remain the cross-process authority. An in-memory semaphore may reduce local contention, but correctness cannot depend on it.

Herdr calls use `Effect.tryPromise` with the Effect fiber's `AbortSignal` passed to the existing SDK. The SDK modules remain outside `effect-port/` and receive no `effect` import. The port owns adapters that translate Promise rejection, AbortSignal cancellation, and SDK error codes to typed Effect failures.

### Module ownership map

```text
effect-port/
  package.json                 pins Effect v4 and port-only build/test commands
  tsconfig.json                NodeNext, Node 26, strict declarations
  src/
    index.ts                   intentional public exports only
    application/
      marionette.ts            deep use-case facade and identity policy
      operation.ts             Schema decode and exhaustive operation dispatch
    domain/
      model.ts                 branded IDs, records, tagged unions
      errors.ts                Schema.TaggedError families
      attempts.ts              pure attempt transition rules and service surface
      workflows.ts             pure workflow transition rules and service surface
      results.ts               evidence, acceptance, and validity rules
      board.ts                 thread/post/subscription rules
    authority/
      authority.ts             Context service and command/query algebra
      sqlite-kernel.ts         DatabaseSync, BEGIN IMMEDIATE, savepoints, row codecs
      migrations/              copied then independently evolved v1 schema history
      idempotency.ts            canonical payload digest and transactional replay
    runtime/
      runtime.ts               claim, invoke, observe, reconcile workflow
      native-effects.ts        durable effect journal policy
      watcher.ts               scheduled scoped delivery loop
      context-projection.ts    idempotent session-context file projection
    adapters/
      herdr-execution.ts       Promise SDK to Effect boundary
      filesystem.ts            scoped/typed file effects
      process.ts               process identity and spawn boundary
      sql-query.ts             isolated SQL worker boundary
    layers/
      live.ts                  flat named production layer graph
      test.ts                  first-class test services and controls
  test/
    ...                        port-only Effect tests and parity fixtures
```

Ownership follows domain knowledge. There is no `load`, `validate`, `transform`, `save` module chain. Row schemas stay private to `sqlite-kernel.ts`. Herdr wire types stay private to the adapter. `application/marionette.ts` owns authentication and use-case sequencing. `runtime/runtime.ts` owns only the native claim/invoke/reconcile protocol. This avoids temporal decomposition and keeps ordinary flow traceable through at most the application facade, domain service, and authority kernel.

## Invariants

1. One SQLite database is bound to one project and host. Every query and mutation is project-scoped.
2. `AuthorityKernel.commit` is synchronous and uses `BEGIN IMMEDIATE`; nested authority calls use savepoints. No Effect, Promise, provider, file, subprocess, or network work can occur inside it.
3. WAL, `synchronous = FULL`, foreign keys, extension denial, busy timeout, migration checksum history, and rollback behavior remain byte-for-byte acceptance constraints unless a recorded design explicitly changes them.
4. Idempotency key, payload digest, domain transition, and result record commit atomically. Same key plus same payload returns the stored result. Same key plus changed payload fails.
5. Actor identity, role, generation, host, workspace, brief revision, workflow revision, and control revision are checked in the same authority commit that admits or changes work.
6. Exclusive reservations are held for active and unconfirmed effects. Uncertainty never frees capacity.
7. Every external mutation has a durable unique claim before invocation. A claimed launch, prompt, interrupt, cleanup, delivery, Git mutation, or other non-idempotent effect is inspected or reconciled and is never automatically replayed.
8. Native identity is a tuple of the owning host, server generation, and exact locator. Conversation identity never substitutes for transport identity.
9. A native idle observation is insufficient for completion. Settlement requires the exact native observation and the required durable result/evidence facts.
10. Results, requests, brief revisions, control intents, transition requests, and migration history retain their current immutability constraints.
11. Long-lived work is scoped. Closing the layer interrupts its fibers and finalizes durable ownership. Process takeover still requires proof that the prior owner is absent.
12. The public Herdr SDK stays dependency-free and keeps its current Promise, AbortSignal, and async-stream API.
13. CLI and SDK call the same Effect application use cases. A compatibility shell may call `Effect.runPromise`, but domain modules never do.
14. Existing dirty and untracked files remain untouched. All port work is additive under `effect-port/` until a separately accepted cutover.

## Falsifiable vertical slices

### Slice 0. Scaffolding only

Create `effect-port/` with pinned Effect v4, NodeNext TypeScript, `Context.Service`, production/test layer skeletons, tagged error schemas, and a `NodeRuntime.runMain` smoke. It passes only if the port builds and a layer acquire/release test proves database close. This is scaffolding. It proves no domain behavior and must not be reported as a Store, runtime, watcher, or CLI port.

### Slice 1. Authority transaction parity

Port database open, migration verification, canonical JSON, idempotency, and one representative job creation command. Run the same real-file assertions for nested savepoint rollback, rejected async transaction bodies at the type/API boundary, failed migration rollback, checksum drift, concurrent first open, close finalization, and restart persistence. It passes only if the observed database rows and errors match v1 fixtures. A service that delegates to `new Store(...).createJob(...)` fails this slice because it is wrapping, not ownership transfer.

### Slice 2. Admission and reservation

Port `admitAttempt` as a domain command executed by the authority kernel. Race two admissions for the same resource from separate database handles. Exactly one may hold the reservation. The loser must receive typed `ResourceBusy`, and a stale brief/control revision must leave no attempt, session binding, reservation, or idempotency record. Restart and repeat the read. This slice transfers actual admission authority.

### Slice 3. Native effect journal

Port launch and prompt through `NativeEffects` plus a fake `HerdrExecution` controlled with `Deferred` and `Queue`. Crash or interrupt after the claim commit and before acknowledgement. A second `Runtime.start` must invoke neither launch nor prompt, must preserve the reservation, and must expose an inspectable claimed or unconfirmed state. Then supply an exact working observation and prove the runtime advances without resending. This is the first actual runtime port.

### Slice 4. Durable result and settlement

Port brief acknowledgement, result recording, artifact verification, acceptance, and native settlement. Prove damaged or missing evidence never records/accepts, a stale brief cannot accept, a settled native session without a result does not release, and an exact settled observation plus durable result releases once. Restart between result record and reconciliation. This transfers completion authority rather than wrapping Store getters.

### Slice 5. Scoped watcher

Port watcher ownership and delivery claims to a scoped scheduled fiber. Use deterministic test synchronization, not sleeps. Prove layer-scope close settles ownership, busy delivery releases a claim safely, a thrown or interrupted delivery becomes unconfirmed, takeover requires proven prior absence, and an uncertain claim is never replayed after restart. Run the same test with two watcher processes against one real database.

### Slice 6. CLI and SDK parity

Port the operation schema, exhaustive dispatcher, client facade, SQL-worker boundary, and package entrypoint. Feed representative raw CLI JSON and SDK calls through the same application service and compare normalized output plus persisted rows with v1. Prove parser failure occurs before project discovery and secrets remain redacted. The compatibility shell may be the only `Effect.runPromise` boundary.

### Slice 7. Herdr boundary and package proof

Build and pack the port. Install the tarball in a temporary Node 26 project. Prove the CLI, root SDK, adapter exports, SQL worker from another cwd, and generated declarations work. Scan `dist/herdr-sdk.js`, `dist/herdr-protocol.js`, `dist/herdr-streams.js`, and `dist/herdr-transport.js` for Effect imports and verify a consumer can import `@theaileverage/marionette/herdr-sdk` without Effect installed. Then run the real native fixture separately. The package smoke is static/package evidence; it does not prove live Herdr compatibility.

### Slice 8. Cutover readiness, still no cutover

Run the full old and port suites against isolated fixtures, compare schema and public operation matrices, run build/type/lint/format/package smoke, and document all mismatches. A green matrix makes the port reviewable. It does not authorize deleting `src/v1`, changing root exports, publishing, or migrating user databases.

## What counts as scaffolding, wrapping, and a port

Scaffolding consists of package setup, service tags, layers, schemas, tagged errors, placeholder methods, and a runnable Effect main. It establishes shape only.

Wrapping consists of Effect methods whose bodies call the current `Marionette`, `Runtime`, `Watcher`, or `Store` classes. Wrapping can be a disposable characterization bridge, but it transfers no authority, keeps hidden synchronous exceptions, and cannot be counted as ported behavior.

An actual port owns the domain rule and its durable state transition under `effect-port/`, maps failures into the Effect error channel, acquires resources in layers, uses scoped concurrency, and passes a vertical slice after the corresponding old class is absent from that slice's import graph. A simple CI rule can enforce that `effect-port/src/**` never imports `src/v1/client.ts`, `runtime.ts`, `watcher.ts`, or `store.ts`. Reusing dependency-free Herdr SDK modules is intentional interoperation, not wrapping.

## Synthesis decision

Architecture A uses native Effect application and runtime services over a deliberately synchronous SQLite authority kernel. It takes the deep application facade and command/query kernel as its base because they preserve atomic authority while giving callers a small Effect-native surface. It adapts the current per-effect journal protocol and watcher ownership model unchanged in meaning. It rejects a service for every current class method because that would reproduce the shallow forwarding surface. It also rejects making raw SQL transactions generally effectful because the current atomicity and no-I/O rule are central safety properties, not incidental implementation details.

The requested multi-runner arena was not available inside this bounded delegated task. The second structurally distinct design below is therefore assessed directly rather than claimed as an independent runner result.

## Alternative B: fully effectful transaction services

Alternative B would make transactions themselves Effect programs, likely through an Effect SQL service.

```ts
interface AuthorityDatabase {
  readonly transaction: <A, E, R>(
    body: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError, R | SqlTransaction>
}
```

This shape has real advantages. Row decoding, tracing, interruption, dependency injection, and SQL failures stay inside Effect. Tests can provide a database service naturally. If the whole authority used an Effect-native SQLite driver with known transaction semantics, callers could compose repository work without an imperative callback.

It loses here for four reasons.

1. The interface permits suspension and arbitrary dependencies inside an authoritative transaction. The type says provider calls, files, sleeps, forks, and interruption are possible unless a second restricted transaction environment is invented. That weakens the existing synchronous rule.
2. Interruption and fiber scheduling introduce a new rollback surface inside transitions whose current behavior is one uninterrupted JavaScript call. Proving parity would require driver-specific interruption, nested transaction, savepoint, busy, and finalizer tests before any domain port could rely on it.
3. The current runtime depends on Node 26 `node:sqlite`, including authorizer and defensive capabilities for isolated SQL reads (`src/v1/sql-worker.ts:120-145`, `src/v1/sql-worker.ts:175-200`). No Effect SQLite dependency is installed, and compatibility with these exact APIs is currently unverified.
4. A generic effectful transaction service exposes more mechanism to every repository caller. Architecture A hides transaction mode, savepoints, idempotency, project binding, clocks, IDs, and row codecs behind commands. Its interface is deeper.

We accept a small synchronous imperative island in exchange for a stronger no-suspension invariant and direct reuse of Node 26 SQLite semantics. We accept adapter code that maps thrown SQLite failures to tagged errors in exchange for keeping the domain and runtime fully Effect-native. We accept a two-commit protocol around external effects in exchange for truthful crash recovery and no replay. We accept duplicated isolated port files during migration in exchange for preserving dirty work and retaining a runnable comparison oracle.

Alternative B becomes viable only if a focused spike proves all of the following with the chosen pinned versions: Node 26 support, `node:sqlite` or equivalent authorizer support, WAL and `synchronous = FULL`, outer `BEGIN IMMEDIATE`, nested savepoints, deterministic rollback on interruption, no transaction leakage across fibers, bounded busy behavior, and package compatibility. Even then, it should expose domain commands rather than a generic transaction method to most callers.

## Current baseline and missing dependencies

- The observed runtime is Node `v26.8.1`, matching the declared floor (`package.json:5-7`).
- The root package has one runtime dependency, Zod (`package.json:20-22`). `npm ls effect @effect/platform-node @effect/sql @effect/sql-sqlite-node --depth=0` returned empty at the root. The isolated `effect-port/` prerequisite work has since pinned Effect `4.0.0-rc.112`; any Node runtime or SQL integration package still needs exact source/API verification before use.
- The repository declares `packageManager: bun@1.3.14` while the scripts and runtime are Node-based (`package.json:8-18`, `package.json:89`). That metadata conflict needs a deliberate decision. It must not silently pull the port back to Bun.
- TypeScript targets ES2024 with NodeNext and emits declarations from `src/v1` plus the root Herdr SDK modules (`tsconfig.v1.json:2-20`). The new root needs a separate config until cutover.
- Root package exports and published files point at `dist/v1` and the dependency-free Herdr modules (`package.json:33-53`, `package.json:67-87`). The port cannot be package-smoked without an additive build/output plan.
- The working tree was dirty before this report. Modified files include `README.md`, `documentation/v1/implementation-plan.md`, `package.json`, `scripts/package-smoke-v1.mjs`, `skills/marionette/SKILL.md`, `src/v1/cli.ts`, and `tests/v1/cli-ux.test.ts`; there are deleted Effect skill metadata files and several untracked onboarding/skill files. The port must not normalize or overwrite any of them.
- The constrained `npm test` run executed 108 tests with 94 passing and 14 blocked by the sandbox. Thirteen failures were sandbox-denied Unix socket listeners (`EPERM`) across Herdr SDK/stream/transport/native fixtures. One watcher test could not obtain a process start token. The lead independently confirmed all 108 tests pass outside this socket-restricted sandbox and the root check passes with a warning only. The unrestricted suite is the baseline; neither run proves live Herdr compatibility.
- There is no project `AGENTS.md` in or above this checkout. The requested local Effect skill is guidance, while the installed dependency source required by its source rule does not yet exist.

## Design red-flag screen

- **Shallow module.** The public service exposes complete use cases, not every Store method or transaction stage. Domain services exist for internal composition and tests.
- **Information leakage.** `DatabaseSync`, row layouts, Zod compatibility types, Herdr wire types, and transaction modes are private to adapters and the authority kernel.
- **Temporal decomposition.** Modules own attempt, result, workflow, authority, and native-journal knowledge. They are not split into load/validate/save stages.
- **Pass-through methods.** A method earns its boundary only when it authenticates, decodes, sequences a complete use case, translates errors, or protects authority. Pure forwarding wrappers are migration debt and fail the slice import rule.

## Open questions and risks

1. Which exact Effect v4 release and Node runtime package are accepted for the port? The local skill requires current v4 APIs, but no package is installed to verify signatures.
2. Is `effect-port/` the desired permanent root name, or should it be a temporary isolated program renamed at cutover?
3. Must the first cutover preserve Zod operation objects byte-for-byte, or may the public SDK accept Effect Schema domain values while the CLI retains compatibility decoding?
4. Should the new root own a copied migration history with the same checksums, or open separate fixture databases until cutover? Opening user databases from two evolving implementations would be high risk.
5. Can session context files be reconstructed entirely from authoritative stored data? The proposed pending-projection recovery depends on deterministic bytes and permissions.
6. Which current dirty changes define the baseline that the port must match? Before implementation, capture their exact diff without modifying them and avoid rebasing or formatting the root tree.
7. The sandbox baseline could not run socket fixtures. A later acceptance run needs an environment that permits Unix-domain listeners and process identity inspection.

## Next implementation step

Create only Slice 0 under `effect-port/`, pin and inspect the chosen Effect v4 packages, then implement Slice 1 without importing the current `Store`; do not touch existing dirty files or root package exports.

## Principles that changed this design

- Foundational Thinking made the authority command and synchronous transaction shape the first design artifact instead of starting with service tags.
- Redesign from First Principles moved orchestration ownership into Effect services rather than preserving current class boundaries.
- Model the Domain produced services around attempts, workflows, results, and native effect claims rather than a generic repository per table.
- Boundary Discipline kept raw SQLite, Zod compatibility, Herdr promises, files, and subprocesses in explicit adapters.
- Type System Discipline made synchronous authority commands incapable of returning Effect or Promise values and keeps IDs and failures branded/tagged.
- Make Operations Idempotent preserved the claim-before-effect and no-replay protocol and introduced a recoverable context projection.
- Minimize Reader Load limited ordinary call flow to the facade, domain service, and authority kernel.
- Outcome-Oriented Execution defined a port by transferred ownership and parity slices, so scaffolding and wrappers cannot be reported as migration progress.
- Sequence Work into Verifiable Units produced the falsifiable vertical slices and delayed cutover until a full parity matrix exists.
- Prove It Works separates static build, database parity, package smoke, socket fixtures, and live Herdr compatibility as different evidence classes.
