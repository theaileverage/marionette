# Effect port architecture

## Caller contract

The new package exposes Effect workflows through explicit services and layers. The current published Node package remains unchanged during coexistence. A compatibility facade in the port can retain the old synchronous and Promise call shapes, but Effect runtime execution happens only at that facade or CLI boundary.

```ts
const program = Effect.gen(function* () {
	const marionette = yield* MarionetteService;
	return yield* marionette.execute(input);
});
```

This is a design sketch until the application slice supplies these symbols. No placeholder executable is presented as a port.

## Decision

Use architecture A as the base. Preserve the Node 26 synchronous SQLite authority kernel and its existing migration history. Port domain and persisted-value codecs to Effect Schema. Move native execution, delivery, watch loops, subprocess ownership, and application orchestration into Effect workflows with typed errors and scoped resources.

Retain the `src/v1` module layout inside `effect-port/src/v1` initially. Moving every file while changing its implementation would make comparison harder. Module names do not determine lifecycle ownership. The new public service graph must own complete use cases rather than export raw SQLite or one unused wrapper per old method.

The imperative kernel owns synchronous transaction logic in the new folder. It does not import the old `Store`. Retaining tested SQL and pure business rules is intentional. A ported service is incomplete if its application work still runs through the old product import graph.

Graft architecture B's failure analysis. Once a native effect or delivery has been durably claimed, interruption, timeout, process death, or malformed output cannot authorize a repeated invocation. Ordinary finalizers may record uncertainty. Crash correctness relies on persisted claims and exact reconciliation even when no finalizer ran. Do not add a general retry policy around native mutations.

Reject the proposed new event-sourced database, offline importer, MCP endpoint, and generic executor framework for this migration. The existing command journal already protects the critical native effects. These additions would expand the product and introduce new state semantics before parity.

## Authority and lifecycle

SQLite owns cross-process serialization. Outer transactions use `BEGIN IMMEDIATE`; nested transactions use savepoints. Preserve rollback, checksums, WAL, FULL synchronization, foreign keys, project scoping, and the current idempotency semantics.

TypeScript generic callbacks alone cannot prove that a transaction callback is synchronous or free of I/O. Keep transaction functions internal, reject asynchronous results, audit call sites, and test rollback. Never suspend an Effect, fork, or invoke a provider inside a transaction callback. Do not claim the type system prevents arbitrary synchronous filesystem calls.

Database ownership uses a scoped layer. Native and delivery workflows follow durable claim, one boundary invocation, and durable acknowledgement or uncertainty. Promise interoperation remains at the dependency-free Herdr SDK and other external adapters. Schedule owns polling. Scope shutdown drains or interrupts work according to its durable claim state before closing the database.

Exact endpoint, server generation, native session or process instance, workspace, tab, pane, terminal, and agent identity remain required for reconciliation. Native idle is an observation. Result recording, native settlement, and evidence-checked acceptance remain distinct operations.

## Context-file risk

Architecture A identified synchronous session-context file creation inside a database callback. Preserve its current behavior until a dedicated, tested change establishes a recoverable file protocol. Do not add a `context-pending` state or persist plaintext credentials as an incidental refactor. No launch may begin without a verified session context bound to the admitted attempt. A later repair must prove ordering, permissions, and crash recovery without weakening credential handling.

## Dependencies and coexistence

Node 26.8.1 remains the runtime. Bun 1.3.14 manages packages; those roles do not conflict. The port pins Effect 4.0.0-rc.112 in its own lockfile. No additional platform or SQL runtime package is necessary merely to use Effect with Node's built-in SQLite.

The root Herdr SDK keeps its Promise and stream API and has no Effect dependency. The new build may copy those exact source files with a hash check. Port tests and native acceptance use isolated databases and owned native workspaces. This migration does not open production state with new code.

## Extensions

Use the [data-only extension contract](extensions.md). It resolves exact content-addressed descriptors and parent references. It performs no code loading and cannot mint execution authority. The current workflow and adapter admission rules remain authoritative.

## Verification and review

The [parity predicate](plan.md) distinguishes source coverage, differential behavior, Effect lifecycle tests, packaged execution, and live native acceptance. Raw Effect Schema exports change the in-progress SDK schema API; comparison fixtures must disclose any API adaptation. Wire acceptance and output semantics remain the parity target.

Candidate proposals are retained as `architecture-a.md` and `architecture-b.md`. Their sketches contain provisional APIs and some stale observations. This decision document and dated evidence supersede those observations. Independent Sol review is in progress. The Astra lead owns synthesis and final review; cross-family review is unavailable in this tool roster.
