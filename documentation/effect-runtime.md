# Effect runtime

Marionette runs on Bun and uses Effect v4 for application workflows and resource lifetimes. The
installed version is pinned because the v4 API is still a release candidate.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for compiler diagnostics, lint rules,
and the installed Effect skill.

## Application lifetime

`src/application.ts` composes configuration, the supervisor lock, SQLite storage,
and the application service through `Context.Service` and `Layer`. Resources use
`Effect.acquireRelease`, so failure during later acquisition unwinds earlier
resources. A failed database constructor closes its database handle before
throwing. Lock cleanup checks its acquisition ID before removing the file.

`src/server.ts` owns this graph through `ManagedRuntime`. HTTP listening and
signal handlers belong to the same lifetime. The Promise returned by `shutdown`
is shared between callers, so every caller waits for disposal to finish.

The supervisor stops its scheduled poll before draining finite background jobs.
Continuation and cleanup work also drain before SQLite is closed. Shutdown
preserves external Herdr workers. Explicit fiber interruption is a separate
operation; it must not silently substitute for graceful shutdown.

## Workflow and transport boundaries

Application operations use named `Effect.fn` functions and compose through
`yield*`. `AppError` and `BoundaryError` are tagged schema errors: application
errors retain their HTTP status and code, while infrastructure errors retain
their operation and original cause. Effect Schema decodes application inputs;
Zod remains at the MCP SDK boundary to satisfy that SDK's registration contract.

Promise runners belong at ingress points such as HTTP, MCP, CLI, or compatibility
methods used by existing callers. New internal code should call the Effect
operation directly. A nested `Effect.runPromise` starts another fiber and needs
explicit cancellation wiring; wrapping it in `tryPromise` alone does not provide
that wiring.

The published Herdr SDK keeps its Promise and async-iterator interfaces and has
no Effect dependency. The application's Herdr adapter passes Effect's abort
signal into the SDK socket request. `src/process.ts` scopes subprocess groups,
bounds captured output, and waits for stdio closure after termination. Loopback
HTTP uses Effect's HTTP client. Retry schedules are for safe readiness
observations, not potentially delivered mutations.

## Durable authority

SQLite records remain authoritative for leases, revisions, ownership,
idempotency, and uncertain delivery. A fiber is an execution mechanism, not a
replacement for persisted state. Persist intent before an external mutation and
recheck current authority after external I/O. A lost acknowledgement must not
cause automatic send or close replay.

Persistence currently uses `bun:sqlite` directly. Effect owns its lifetime and wraps application operations; queries do not use `@effect/sql-sqlite-bun`.

Store transactions remain synchronous. Keep all writes in a transaction inside
one synchronous boundary; never return a Promise or lazy Effect from a
transaction callback. This preserves atomic records, events, and idempotency
updates without committing before deferred work executes.

## Verification

`bun run check` includes patched TypeScript diagnostics and anti-slop lint.
`bun run tooling:check` proves the rules reject deliberate failures after
installation. `bun run runtime:check` exercises failed resource acquisition,
duplicate startup, concurrent shutdown, and signal cleanup. `bun run test` covers
durable orchestration and protocol behavior. `bun pm pack` runs checks and builds;
`bun scripts/release.mjs smoke PATH_TO_TARBALL` checks the isolated CLI and SDK,
including declaration use without a workspace Effect dependency.

The [compatibility acceptance guide](effect-compatibility.md) records the
pre-migration invariants and additional review cases. It is a review checklist,
not a test result or a claim of integrated acceptance.
