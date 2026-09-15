# Architecture B. Effect command interpreter with a transactional journal

## Problem

Marionette needs an Effect v4 port that can coexist with the current implementation while preserving its full behavior, including explicit unsupported and not implemented results. The difficult part is the lifecycle contract, not converting promises into `Effect`. Admission binds a worker, reservation, current brief, workflow revision, and control revision in one transaction. Native mutations are claimed before I/O. Exact native identity is immutable. Uncertain effects are inspected rather than replayed. Native idle releases execution only after a durable result exists, while a result becomes reusable only after a separate controller acceptance against the current brief. The current runtime spreads those rules across `Runtime`, `Store`, `Watcher`, and the Herdr adapter [src/v1/runtime.ts:108-200] [src/v1/runtime.ts:203-244] [src/v1/store.ts:1417-1607] [src/v1/store.ts:2076-2155].

This candidate makes the command interpreter and immutable decision journal the architectural center. Effect owns orchestration, scopes, errors, scheduling, and boundary decoding. Pure functions own decisions. SQLite owns atomicity and durable claims. Native SDK calls remain Promise based at the final adapter boundary.

## Usage (caller's view)

The application caller supplies authority and fences with each command. It does not coordinate storage stages or native calls.

```ts
import { Effect, Stream } from "effect"
import { Marionette } from "@theaileverage/marionette-effect"

const program = Effect.gen(function* () {
  const marionette = yield* Marionette.Service

  const admitted = yield* marionette.execute({
    _tag: "AttemptAdmit",
    commandId: CommandId.make("cmd-admit-01"),
    idempotencyKey: IdempotencyKey.make("lead/run-42"),
    authority: controllerSession,
    jobId,
    profile: ProfileRef.make({ id: "codex", version: 1 }),
    nativeWorkspaceId,
    inputResultIds: [],
    expectedBriefRevision: Revision.make(7),
    expectedWorkflowRevision: Revision.make(12),
    expectedControlRevision: Revision.make(3),
  })

  return admitted.reply
})
```

The CLI and MCP adapters decode their wire inputs, call the same `execute` method, and encode the reply. An idempotent replay returns the original reply. Reusing the key with a different command digest fails with `IdempotencyConflict`.

```ts
const inspected = yield* marionette.execute({
  _tag: "AttemptInspect",
  commandId: CommandId.make("cmd-inspect-01"),
  authority: controllerSession,
  attemptId,
})
```

Inspection may schedule read-only reconciliation. It never resubmits a native mutation. The caller sees `Working`, `Blocked`, `ManualRequired`, `Settled`, `Unconfirmed`, or `Unsupported` as explicit variants.

Long-lived consumers subscribe without owning worker lifecycle controls.

```ts
const updates = yield* marionette.updates({ projectId, after: cursor })

yield* updates.pipe(
  Stream.runForEach(renderUpdate),
)
```

Production assembly makes authority, persistence, and native execution visible.

```ts
const MainLayer = Marionette.layer.pipe(
  Layer.provide(CommandJournal.sqliteLayer),
  Layer.provide(NativeExecution.layer),
  Layer.provide(HerdrDriver.layer),
  Layer.provide(RuntimeConfig.layer),
)
```

There is no public `startWatcher` or `startExecutor`. Long-lived fibers belong to their layer scopes.

## Shape

### Core data model

All boundary-crossing records use `Schema.Struct`, branded scalar schemas, and `Schema.TaggedUnion`. Internal control flow uses `Data.TaggedEnum`. Unknown CLI, MCP, database, extension, and native responses are decoded exactly once at their boundary.

```ts
type Command =
  | ProjectCommand
  | JobCommand
  | WorkflowCommand
  | AttemptCommand
  | ResultCommand
  | BoardCommand
  | DeliveryCommand
  | HandoffCommand
  | RetirementCommand

type Decision = Data.TaggedEnum<{
  Rejected: { error: DomainError }
  Unchanged: { reply: CommandReply }
  Committed: {
    facts: NonEmptyReadonlyArray<Fact>
    intents: ReadonlyArray<EffectIntent>
    reply: CommandReply
  }
}>

type EffectIntent = Schema.TaggedUnion<{
  NativeMutationRequested: {
    intentId: IntentId
    semanticKey: SemanticEffectKey
    adapter: AdapterRef
    capability: CapabilityRef
    requestDigest: Digest
    request: JsonValue
    fences: EffectFences
    permit: ExecutionPermit
  }
  DeliveryRequested: {
    intentId: IntentId
    semanticKey: SemanticEffectKey
    recipient: BoardRecipient
    payloadDigest: Digest
    payload: JsonValue
    fences: EffectFences
    permit: ExecutionPermit
  }
}>

type IntentState = Data.TaggedEnum<{
  Queued: {}
  Claimed: { ownerGeneration: OwnerGeneration; claimedAt: DateTimeUtc }
  Confirmed: { receipt: EffectReceipt }
  Unconfirmed: { reason: NonEmptyString; retainedLocator?: NativeLocator }
  Unsupported: { reason: NonEmptyString }
}>
```

`Command`, `Decision`, `Fact`, and `EffectIntent` are immutable values. The decision function has no services and no I/O.

```ts
declare const decide: (
  state: DecisionState,
  command: Command,
) => Decision
```

The state slice contains only the aggregates needed for the command. It includes authority state, idempotency state, current brief, workflow and control revisions, reservation ownership, result validity and acceptance, and native intent history. The journal loads that slice and commits the decision. Callers never load and resubmit mutable domain objects.

This follows `model-the-domain`, `type-system-discipline`, and `boundary-discipline`. Contradictory lifecycle bags become tagged states. Semantic IDs are branded. Storage rows and native replies remain private codecs.

### Transactional command journal

```ts
interface CommandJournal {
  readonly execute: (
    command: Command,
  ) => Effect.Effect<ExecutedDecision, JournalError | DomainError>

  readonly claimIntent: (
    intentId: IntentId,
    owner: ExecutorOwner,
  ) => Effect.Effect<ClaimedIntent, IntentUnavailable | JournalError>

  readonly readIntent: (
    intentId: IntentId,
  ) => Effect.Effect<IntentView, JournalError>

  readonly pendingIntents: Stream.Stream<IntentId, JournalError>
  readonly updates: (cursor: JournalCursor) => Stream.Stream<CommittedFact, JournalError>
}
```

`execute` performs one `BEGIN IMMEDIATE` transaction. It validates the command's canonical payload digest against the idempotency record, reads a consistent state slice, calls `decide`, appends the command and decision, appends facts and queued intents, updates query projections, and stores the exact reply. A repeated matching key reads the original reply. A mismatched digest is rejected. This preserves the current transactional idempotency behavior [src/v1/store.ts:629-668].

Every mutation that can reach another process is represented by an intent. The command transaction only creates `Queued`. An executor transaction changes it to `Claimed` before invocation. The unique `semanticKey`, such as `attempt/<id>/create-tab`, prevents a second intent for the same logical effect. Current code provides the same fundamental fence through a unique attempt and effect-kind pair [src/v1/migrations/004_native_runtime.ts:43-50].

The journal owns transaction policy and projection updates. It does not know Herdr request types. This creates a deep module. One method hides idempotency, authority checks, revision fences, decision persistence, outbox creation, and reply replay.

### No-replay interruption semantics

A claimed mutation is considered possibly applied until positively reconciled. This is true even if the executor fiber was interrupted before its Promise resolved. Effect interruption is an observation about the local fiber, not proof that the native process did nothing.

The executor protocol is:

1. Claim a queued intent in a transaction and persist the executor generation.
2. Recheck the persisted permit and fences immediately before the boundary call.
3. Invoke the Promise driver exactly once under `Effect.tryPromise`.
4. Append `EffectConfirmed`, `EffectUnsupported`, or `EffectUnconfirmed` through a new command.
5. If cancellation, scope closure, process death, malformed output, transport loss, or an unknown exception can occur after invocation began, retain `Claimed` or append `EffectUnconfirmed`. Never return it to `Queued`.
6. On executor takeover, convert every claim owned by the absent generation to `Unconfirmed`. Reconciliation may observe it. Dispatch may not claim it again.

Only failures proven by the boundary contract to occur before invocation may return an intent to `Queued`. Examples include input decoding failure or an already-aborted signal checked before the driver call. The current adapter distinguishes before-invocation and after-invocation failures and warns against retrying the latter [src/v1/adapters.ts:41-65] [src/v1/adapters.ts:227-247]. Invalid output is after invocation and therefore ambiguous [src/v1/adapters.ts:90-109].

An `Effect.ensuring` finalizer may append an unconfirmed fact during ordinary interruption. Correctness does not depend on that finalizer running. Takeover reconciliation handles hard process death. There is no retry schedule around native mutation drivers.

### Scoped executors

```ts
interface NativeDriver {
  readonly describe: Effect.Effect<NativeDriverDescription>
  readonly observe: (query: NativeObservationQuery) => Effect.Effect<NativeObservation, NativeReadError>
  readonly executeOnce: (
    claimed: ClaimedNativeIntent,
  ) => Effect.Effect<NativeEffectReceipt, NativeInvocationError>
}

interface NativeExecution {
  readonly reconcile: (
    intentId: IntentId,
  ) => Effect.Effect<Reconciliation, NativeReadError | JournalError>
}
```

`NativeExecution.layer` consumes `pendingIntents`, forks its consumer with `Effect.forkScoped`, and uses `FiberMap` keyed by endpoint plus pane or workspace. Different native targets may run concurrently. Operations for one target remain ordered. The private queue and fibers are not exposed. Delivery execution uses the same claim protocol in a separate scoped executor because delivery readiness and replay policy differ from native agent lifecycle.

The current interval loop serially starts and reconciles attempts, then polls one delivery digest [src/v1/client.ts:408-470]. The new runtime replaces that temporal module with intent-owned executors. Scheduling uses `Schedule` only for read-only observation, queued-work polling, and explicit busy-before-invocation delivery retries. It never retries a mutation with an uncertain outcome.

Watcher ownership stays durable. Takeover requires positive proof that the prior process instance is absent. Claimed deliveries from that generation become unconfirmed and are never replayed, preserving current behavior [src/v1/watcher.ts:122-179] [tests/v1/watcher.test.ts:92-143]. PID plus start token remains the process-instance identity, since PID liveness alone is insufficient [src/v1/background.ts:10-30].

### Exact native reconciliation

Registration persists endpoint evidence. It includes host, socket path, workspace, device, inode, birth time, server process start token, and protocol. Every call rechecks socket identity, process start identity, and protocol before using the client [src/v1/native.ts:8-37] [src/v1/native.ts:576-628].

Agent identity is the tuple of endpoint evidence, workspace, tab, owned tab, pane, terminal, agent kind, agent name, identity revision, and either native session ID or foreground process PID plus start token. A locator without either process-instance proof is invalid [src/v1/native.ts:82-118].

Reconciliation is read only. It performs exact equality checks and returns one of `Working`, `Blocked`, `ManualRequired`, `Settled`, or `Unconfirmed`. It never creates a tab, starts an agent, sends a prompt, sends keys, changes a binding, or adopts a nearby pane. Current recovery tests enforce that read-only behavior [tests/v1/native.test.ts:450-497]. Fixture adoption remains a separately named read operation that requires an exact explicit fixture authorization and cannot itself grant general launch or control authority [src/v1/native.ts:533-573].

An ambiguous create, start, prompt, interrupt, delivery, or cleanup stays `Unconfirmed` until exact evidence proves its result or an authorized controller records a resolution. Resolution records a fact. It does not delete history or reset the semantic key. A controller may choose a new logical attempt with a new semantic key only after reservations and uncertain work are explicitly resolved.

Trust dialogs remain `ManualRequired`. Prompt and interrupt commands cannot execute against that observation. Cleanup requires explicit authority, exact settled identity, a tab containing exactly the registered pane, and a confirmed `tab.close` acknowledgement. The current adapter already enforces these safety properties [src/v1/native.ts:738-785] [src/v1/native.ts:788-845] [src/v1/native.ts:855-902].

### Attempt and result decisions

The interpreter preserves these fences:

- `AttemptAdmit` requires an active user or controller, an open job, the exact current brief revision, current workflow and control revisions for managed work, an admissible workspace, an active unbound worker session, accepted current input results, capacity, distinct-role rules, and an unreserved resource. The current transaction enforces these together [src/v1/store.ts:1417-1529].
- `NativeEffectRequest` rechecks the attempt brief and workflow control revision in the same transaction that appends the intent. A changed brief or control revision rejects the mutation [src/v1/runtime.ts:203-244].
- `NativeIdentityConfirmed` permits one immutable native identity for the attempt and worker session. A different later identity is an error [src/v1/store.ts:2223-2303].
- `ResultRecord` requires the assigned active worker or an authorized controller, a running or stopping attempt, the requested result kind, accepted upstream results, unique artifact digests, retained and byte-verified artifacts, and current-brief validity [src/v1/store.ts:1786-1925].
- `ResultDecide` is a distinct controller command. Acceptance requires current brief equality, required evidence claims, retained artifacts, and fresh byte verification [src/v1/store.ts:2050-2155].
- Exact native `Settled` plus a durable recorded result may settle the attempt and release its execution reservation. Native idle alone does not. This is existing runtime parity [src/v1/runtime.ts:433-460] [tests/v1/runtime.test.ts:320-344].
- Downstream workflow input, handoff, integration, or completion requires a current eligible accepted result. Recording or native settlement does not imply acceptance.

Unconfirmed settlement keeps reservations and related claims unconfirmed. Confirmed settlement releases them together in one decision transaction. The current store updates attempt, reservation, handoff, writer, session, and control state as one unit [src/v1/store.ts:2306-2414].

### Extension model and authority

```ts
interface ExtensionManifest {
  readonly apiVersion: 1
  readonly extension: ExtensionRef
  readonly capabilities: ReadonlyArray<{
    readonly ref: CapabilityRef
    readonly effect: "read" | "mutation"
    readonly inputSchema: JsonSchemaDocument
    readonly outputSchema: JsonSchemaDocument
    readonly inputSchemaDigest: Digest
    readonly outputSchemaDigest: Digest
    readonly summary: NonEmptyString
  }>
}

interface ExtensionRegistry {
  readonly register: (extension: ExtensionModule) => Effect.Effect<void, ExtensionError>
  readonly resolveExact: (ref: ExtensionRef) => Effect.Effect<ExtensionModule, ExtensionError>
  readonly describe: Effect.Effect<ReadonlyArray<ExtensionManifest>>
}
```

`ExtensionRef` and `CapabilityRef` contain an ID and positive contract version. Resolution is exact. Duplicate IDs and versions, duplicate capabilities, malformed schemas, schema digest mismatches, and unsupported versions fail at startup. Inputs are decoded before invocation. Outputs are decoded after invocation. Descriptions are generated without executing validators or drivers. These preserve the current adapter contract [src/v1/adapters.ts:4-39] [src/v1/adapters.ts:112-173] [tests/v1/adapters.test.ts:48-102].

The manifest describes shape and effect class. It grants no authority. Extensions never receive actor credentials, controller sessions, database handles, or an unrestricted native client. A mutation driver receives only a `ClaimedNativeIntent` carrying an opaque `ExecutionPermit` minted by the core journal after authority and fence checks. An extension cannot construct or widen that permit. Core policy maps each known capability to its required authority. An unknown mutation capability is unavailable until a core policy module explicitly admits it. Declaring a capability as `read` cannot weaken a core mutation classification.

Contract changes require a new positive version and new schema digests. Persisted intents pin extension ID, extension version, capability version, and both schema digests. The executor never silently upgrades a pending or claimed intent. Pure import upcasters may translate historical journal records into a new database copy, but they cannot create permits or rewrite effect outcomes.

### Herdr dependency boundary

The existing `src/herdr-sdk.ts`, generated protocol types, streams, and transport remain dependency free from Effect. Their public contract stays Promise and async stream based. The new `effect-port/` package owns one `HerdrDriver` adapter that wraps each Promise exactly once with `Effect.tryPromise`, decodes the response into the Effect domain schema, and maps errors into typed boundary errors.

No Effect type crosses into the Herdr SDK. No Herdr wire type crosses out of `effect-port/src/native/herdr-driver.ts`. This keeps the public Herdr package usable by non-Effect consumers and preserves the existing deliberate dependency boundary. The root package currently depends on Zod and exposes the Herdr SDK separately [package.json:16-20] [package.json:47-64].

### Root layout and coexistence

```text
effect-port/
  package.json
  tsconfig.json
  src/
    domain/            branded schemas, commands, facts, decisions, pure decide functions
    journal/           service, SQLite implementation, migrations, projections, import
    application/       Marionette facade, queries, command routing
    execution/         scoped native and delivery executors, ownership, reconciliation
    native/            domain protocol and Herdr Promise adapter
    extensions/        manifests, exact registry, schema validation
    surfaces/          CLI, MCP, output encoders, SQL worker
    parity/            explicit implemented, unsupported, and not implemented capability table
    index.ts
  tests/
```

The root implementation remains unchanged during the port. `effect-port/` has its own pinned Effect v4 dependency, currently coordinated as `4.0.0-rc.112`, its own build graph, migrations, tests, binary name, and state-format marker. The two implementations may read the same repository files, but they must not write the same database, state directory, watcher owner row, native workspace, or active Herdr pane. Coexistence means isolated runtimes, not concurrent writers over shared state.

An explicit offline import copies a closed legacy database into a new Effect database. It records source schema version, source database digest, import version, and imported journal facts. It never mutates the source. It refuses import when the old watcher or unresolved native claims cannot be proven inactive. This follows `separate-before-serializing-shared-state` and avoids a dual-write compatibility layer.

### Whole-functionality parity

Parity covers every current public operation and output contract across projects, hosts, workspaces, jobs, briefs, sessions, settings and profiles, artifacts, results and decisions, workflows and packages, attempts and reservations, board and subscriptions, delivery, SQL, handoff, native execution, retirement, onboarding, CLI, MCP, and package exports.

The parity registry is data, not prose.

```ts
type ParityStatus =
  | { _tag: "Implemented"; verification: VerificationRef }
  | { _tag: "Unsupported"; reason: NonEmptyString }
  | { _tag: "NotImplemented"; reason: NonEmptyString }
```

Brief revision, workflow transition, workflow control, workflow resume, and limit extension must remain truthful `NotImplemented` commands until implemented. The current store throws explicit not implemented errors for all five [src/v1/store.ts:1767-1783]. Native approval remains `Unsupported` until a supported user-action adapter exists [src/v1/native.ts:848-853]. Parity does not convert either category into success, a mock, or a silent no-op.

### Module depth and red-flag screen

The public surface is `execute`, query methods, and update streams. It hides transactions, projections, idempotency records, effect claims, executor ownership, schema codecs, and adapter dispatch. This is deeper than exposing separate admit, claim, launch, submit, update, settle, and retry methods to callers.

The design passes the red-flag screen as follows:

- It avoids shallow modules. Callers submit one domain command rather than coordinating stages.
- It avoids information leakage. SQLite rows, Herdr replies, Effect fibers, and extension wire schemas stay behind their owning boundary.
- It avoids temporal decomposition. Domain modules own decisions that may occur at different times. Executors own only external effect execution.
- It avoids pass-through services. Surface adapters add decoding, authority context, and output encoding. The application facade adds journal execution and typed queries.

## Synthesis decision

This is candidate B for synthesis. Its base is a pure command interpreter plus append-only decision journal and transactional projections. Its structurally distinct alternative is a set of Effect services layered over the current synchronous `Store` kernel. Candidate B should be selected when the port is intended to make Effect the real orchestration and failure model rather than a wrapper around synchronous methods.

The strongest idea to graft into any final design is the two-step `Queued` then `Claimed` intent protocol. It allows safe executor takeover before a claim while treating every interruption after claim as ambiguous. The immutable semantic effect key prevents replay permanently.

## Tradeoffs accepted

- We accept a new journal and projection model in exchange for one atomic place that enforces idempotency, authority, revisions, state transitions, and effect creation.
- We accept isolated state directories during coexistence in exchange for eliminating unsafe dual writers and ambiguous ownership.
- We accept explicit import tooling in exchange for a deterministic, inspectable migration boundary.
- We accept more persisted records in exchange for retaining every decision, claim, outcome, and manual resolution without destructive rewrites.
- We accept exact extension version pinning in exchange for deterministic replay and reconciliation of persisted intents.
- We accept conservative unconfirmed states after interruption in exchange for never duplicating a native mutation.
- We accept Promise wrapping at one boundary in exchange for keeping the Herdr SDK dependency free and usable outside Effect.

## Alternatives considered

### Effect services over the synchronous kernel

Each current `Store`, `Runtime`, and `Watcher` method could be wrapped in `Effect.try`. This minimizes initial change, but leaves decisions spread across mutable classes and keeps promise lifecycle, polling, and post-call ambiguity outside the Effect domain. Its interface is broad because callers and services still coordinate temporal stages.

### Full event sourcing without transactional projections

Every query could fold the complete fact log. This has a small write model but exposes replay and snapshot concerns to most readers and makes parity migration unnecessarily expensive. Transactional projections keep the immutable audit trail while hiding query cost and schema evolution.

### Actor per attempt with in-memory mailboxes

An actor can serialize one attempt cleanly, but crash recovery still needs a durable journal and exact native claims. Making actors primary would leak supervision and mailbox rules into callers while duplicating the durable state machine.

## Migration feasibility

The design is feasible, but the scope is a full port rather than a local runtime refactor. The current source already supplies a complete behavioral oracle and 108 passing tests. The Effect package has a pinned v4 release candidate. The highest-risk work is persistence parity and native interruption behavior, not wrapping the Herdr SDK.

A verifiable migration sequence is:

1. Create the isolated `effect-port/` package with schemas, typed errors, journal tables, pure decision functions, and no external effects. Port idempotency and revision fence tests first.
2. Port project, workspace, job, session, artifact, result, acceptance, workflow, board, and handoff decisions. Compare normalized public outputs against the current implementation using the same fixtures.
3. Add intent creation, claim takeover, and interruption tests with deterministic `Deferred`, `Queue`, and `TestClock`. Prove that queued work may be claimed after restart and claimed mutation work never returns to queued.
4. Add the Promise-based Herdr driver wrapper and fake socket tests. Port exact endpoint, session, foreground process, trust-screen, cleanup, recovery, and no-replay cases.
5. Add scoped delivery and native executor layers. Port watcher ownership and unconfirmed delivery tests.
6. Port retirement, CLI, MCP, SQL worker, onboarding, packaging, and explicit stubs. Generate the parity table from the operation registry and fail CI on missing operations.
7. Add the offline state importer and compare all durable public views. Do not enable it for active or ambiguous native state.
8. Run current and Effect suites independently. Then run live native acceptance in a disposable Herdr workspace. Fixture and static checks are necessary but do not satisfy native acceptance.

No phase dual-writes production state. Each phase ends with its own contract and failure-law tests. This follows `foundational-thinking`, `outcome-oriented-execution`, `sequence-verifiable-units`, and `prove-it-works`.

## Explicit native acceptance requirements

The port is not accepted as native-compatible until a disposable live Herdr run proves all of the following against the installed protocol and process behavior:

1. Register confirms the exact socket file instance, server process start token, protocol, host, and workspace.
2. Admission plus two concurrent starts produces exactly one tab, one agent start, and one prompt.
3. Killing the executor after durable claim at each mutation boundary never causes a second create, start, prompt, interrupt, delivery, or cleanup after restart.
4. A queued but unclaimed intent is safely executed once after restart.
5. Restart recovery succeeds only for an exact native session or exact foreground PID plus start token. A changed socket, server start token, workspace, tab, pane, terminal, agent name, agent kind, identity revision, native session, PID, or process start token fails closed.
6. Ambiguous launch retains the strongest known locator and performs read-only reconciliation. It does not create, start, prompt, or send keys.
7. A trust screen produces `ManualRequired` and receives no prompt or interrupt.
8. Native idle without a durable result retains the attempt and reservation. Exact idle plus a durable result settles the attempt. The result remains unusable downstream until current-brief controller acceptance.
9. Delivery takeover requires confirmed former process absence. A claimed delivery from the former generation becomes unconfirmed and is not replayed.
10. Cleanup requires explicit authority, exact persisted identity, a settled native slot, and exactly one registered pane in the owned tab. Any mismatch leaves the tab open.
11. Scope interruption, malformed native output, timeout, socket EOF, and executor process death after claim all preserve an inspectable unconfirmed record with the semantic key permanently consumed.
12. The dependency-free Herdr SDK still passes its own package and protocol tests without Effect installed in its dependency graph.

The existing fixture suite proves many of these laws, including one effect under concurrent starts, no replay after claimed launch or prompt, durable-result settlement, exact read-only recovery, and cleanup refusal after pane drift [tests/v1/runtime.test.ts:204-340] [tests/v1/native.test.ts:250-365] [tests/v1/runtime-retirement.test.ts:262-346]. It does not substitute for the live disposable native run.

## Open questions and risks

- Should the new package name and directory remain `effect-port/`, or should the final public package use another name after parity is complete?
- Which live Herdr errors are contractually guaranteed to mean no mutation began? Until verified, the executor must classify them as after-invocation and unconfirmed.
- Should attempt settlement continue to require only a recorded result for strict parity, or should a future version intentionally require controller acceptance before releasing execution? The port should preserve current recorded-result behavior unless a versioned product change is approved.
- Which read models must be byte-for-byte compatible with current JSON output, and which may be semantically normalized behind a new package version?
- How should an operator resolve an unconfirmed semantic key when live evidence proves the effect did not occur? The safe default is to close the attempt and admit a new one, not reuse the key.
- Is state import required before initial release, or can isolated greenfield projects establish runtime parity first?

## Next implementation step

Build the isolated journal schema and pure `AttemptAdmit` plus `NativeEffectRequest` decision functions, then prove idempotency, brief and control fences, queued-versus-claimed takeover, and no-replay interruption laws before adding a native driver.
