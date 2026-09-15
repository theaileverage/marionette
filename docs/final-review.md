# Final Effect port review

Scope: current `effect-port` source compared with the preserved v1 baseline, using Effect `4.0.0-rc.112`. This review excludes active judge/runtime test fixes and makes no source changes.

## Findings

### P0 — the new root cannot replace the published package

`effect-port/package.json:2-26` is still a private development package. It has no `build` or `prepack` script, no `bin`, `types`, `files`, or `exports` map, and version `0.0.0`. The baseline package exposes the root SDK, dependency-free `./herdr-sdk`, and three adapter subpaths and installs the `marionette` CLI. Although `effect-port/src/index.ts:1` and `effect-port/src/v1/index.ts:1-56` contain source exports, a consumer cannot install or import those contracts from the new root as a package. Existing `dist/` bytes do not make this reproducible because the manifest has no build path or declared public files.

**Action:** add a deterministic build from this root, declaration emission, CLI bundle, the baseline export subpaths, package smoke tests, and the workflow/skill/license file list. Keep `herdr-sdk` on its dependency-free graph; the current `effect-port/src/herdr-sdk.ts:1-20` and `herdr-transport.ts:1-3` correctly avoid importing Effect.

**Falsifiable slice:** pack the new root, install the tarball into an empty Node 26 project, import every baseline export subpath, typecheck a `MarionetteService` program, run `marionette --help`, and verify importing `./herdr-sdk` does not load or require `effect`.

### P1 — native optional keys tighten the public operation input contract

`effect-port/src/v1/operations.ts:31` maps every Zod `.optional()` operation field to `Schema.optionalKey`. That accepts an absent property but rejects a present property whose value is `undefined`. The baseline Zod object accepts `{ cursor: undefined }`; the port's strict Effect struct rejects it with `Expected string at ["cursor"]`. This affects page fields at `operations.ts:49-52` and every other use of the shared `optional` helper. The decoding-default fields at `operations.ts:36-46` need the same audit because baseline Zod defaults also apply to explicit `undefined`.

This is observable through the SDK because callers can construct JavaScript objects with explicit `undefined`, even though JSON cannot encode that value.

**Action:** decide whether the preserved SDK contract includes explicit `undefined`. If parity is required, model Zod optional semantics with the Effect schema that accepts `undefined` while omitting it from the decoded result, and add differential tests for missing, explicit `undefined`, valid values, and invalid values. Do not silently document this as a JSON-only limitation because `execute` is a JavaScript API.

**Evidence:** a direct comparison on the installed versions produced `zod true` and `effect false Expected string at ["cursor"]` for `{ cursor: undefined }`.

### P1 — native ports still require Promises and make Effect optional

The watcher boundary requires Promise methods while its Effect methods are optional (`effect-port/src/v1/watcher.ts:9-17`), then dynamically chooses the optional Effect or lifts the Promise with `Effect.tryPromise` (`watcher.ts:72-79`). The Herdr driver repeats the pattern for all eight operations (`effect-port/src/v1/adapters/herdr.ts:66-82`) and centralizes the Promise lift at `adapters/herdr.ts:85-86`. A new native implementation therefore cannot implement only the typed Effect contract; it must provide a Promise API, and Effect failures are widened to `unknown` on the Herdr side.

This is useful compatibility scaffolding, but it is not a complete native Effect service port. It also makes it easy for production paths to fall back to opaque Promise failure and lose interruption/service requirements.

**Action:** make the Effect operations the required internal port contracts with concrete typed errors. Put Promise compatibility methods in outward facades that call `Effect.runPromise`. If test fixtures need Promise convenience, adapt them at fixture construction rather than keeping Promise as the production authority contract.

**Falsifiable slice:** a driver and delivery/liveness implementation containing only Effect methods typechecks and passes launch, prompt, interruption, watcher takeover, and delivery-claim tests; the public Promise facade still passes the preserved SDK tests.

### P1 — several native `*Effect` methods are whole-method Promise lifts

The concrete Herdr adapter's `observeEffect`, `recoverEffect`, `adoptEffect`, `registerEffect`, and `cleanupEffect` wrap the corresponding pre-existing Promise methods as one `Effect.tryPromise` boundary (`effect-port/src/v1/native.ts:936-948` and `972-973`; boundary definition at `410-412`). By contrast, `launchEffect`, `promptEffect`, and `interruptEffect` expose the durable claim and retry workflow as Effect steps (`native.ts:900-933` and `950-970`). The former group gains a typed outer error but does not gain Effect-visible steps, interruption boundaries, or composable services. This is wrapping/scaffolding rather than the actual port requested.

**Action:** move each native workflow into Effect primitives, with socket/process calls individually represented by `Effect.tryPromise`, retries represented by schedules or explicit Effect loops, and failures kept in the typed channel. Retain the Promise methods only as compatibility facades over those workflows.

**Falsifiable slice:** interrupt each operation after its durable claim and before its transport response, then prove the same unconfirmed/settlement state as the baseline without replaying the external action.

### P2 — typed Effect failures are not part of the root public surface

The root exports `executeEffect`, `acquireMarionette`, and `marionetteLayer` (`effect-port/src/v1/index.ts:54-55`) but does not export `OperationError` from `operations.ts:330-352` or `ClientOperationError` used by `acquireMarionette` in `service.ts:2,11-20`. Consumers can run these Effects, but they cannot import the error classes from the supported root entry to perform stable `instanceof` handling or name them directly in public type annotations. A future declaration build may also expose names reachable only through unpublished internal paths.

**Action:** export the intended tagged error types from the root, or replace class-based public handling with an explicitly exported error union and schemas. Add a package-level TypeScript fixture that imports only supported subpaths and exhaustively handles every advertised error tag.

## Verified non-findings and evidence

- Source coverage is complete by filename: the port contains every one of the baseline's 41 `src/v1/*.ts` files plus the new `service.ts`.
- No production port source imports Zod. The standalone Herdr SDK remains dependency-free.
- The five baseline `Store` truthful stubs remain the same stubs, rather than being presented as newly completed workflow behavior (`effect-port/src/v1/store.ts:1784-1801`; baseline has the same methods).
- The synchronous Store rejects Effect and Promise transaction callback results before commit (`effect-port/src/v1/store.ts:549`), preserving the SQLite authority boundary.
- Focused native Effect infrastructure tests pass 20/20 for database scope closing, interruption, typed service errors, extension resolution, and Marionette resource scope. Evidence: `.test-output/logs/2026-09-13T23-29-42.604Z-parity.log`.

## Closure recheck — 2026-09-14

The findings above are retained as the historical review record. Rechecking the frozen integration source and package closes all five for the intentionally private, additive Effect port. Publication and replacement of the original package or binary are outside this scope.

### P0 package surface — resolved for scope

The manifest now has a deterministic build and package-smoke entry (`package.json:19-20`), CLI bins (`package.json:34-36`), declaration entry and export map (`package.json:38-71`), and the packaged runtime/workflow/skill/license/documentation file set (`package.json:73-82`). The export map covers the root, dependency-free Herdr SDK/protocol/streams/transport modules, and all adapter subpaths. Final integration reports strict typecheck and build passing, followed by a package smoke that imports every declared subpath. `private: true` and version `0.0.0` (`package.json:2-4`) are intentional markers for this additive port, not a remaining delivery gap.

### P1 explicit `undefined` semantics — resolved

Public option fields now use `Schema.optional` rather than `Schema.optionalKey` (`src/v1/operations.ts:31,49-52`), and decoded defaults are applied directly with `Schema.withDecodingDefault` (`src/v1/operations.ts:36-46`). The model's `requiresDistinctRole` default is likewise a native Boolean schema with decoding and constructor defaults (`src/v1/model.ts:104-115`). The final parity log contains passing regressions for both `owned public schemas accept explicit undefined for legacy optional fields` and `explicit undefined retirement options retain omission semantics`; their sources are `tests/runtime-effect.test.ts:113` and `tests/retirement-handoff-parity.test.ts:697`.

### P1 internal native ports — resolved

Watcher construction accepts compatibility inputs but immediately stores required Effect-only ports (`src/v1/watcher.ts:47-66`); all runtime liveness, readiness, and delivery calls use those Effect methods (`src/v1/watcher.ts:84-86`). The Herdr boundary defines a complete `HerdrEffectDriver` with a concrete `HerdrDriverError` channel (`src/v1/adapters/herdr.ts:76-91`) and exposes native Effect execution on every capability while retaining Promise execution as the public compatibility facade (`src/v1/adapters/herdr.ts:97-125`). The final parity log proves an implementation containing only Effect methods composes successfully (`tests/runtime-effect.test.ts:122`). Promise-driver acceptance remains deliberate compatibility at construction, not the internal authority contract.

### P1 concrete native workflows — resolved

The previously wrapped operations are now implemented as Effect workflows: observation (`src/v1/native.ts:509-530`), recovery (`src/v1/native.ts:532-553`), fixture adoption (`src/v1/native.ts:555-569`), registration (`src/v1/native.ts:571-588`), and cleanup (`src/v1/native.ts:616-633`). Their transport and process calls cross individually named `NativeBoundaryError` boundaries, while workflow composition, polling, and recovery remain visible to Effect. The Promise methods now point in the correct direction as thin `Effect.runPromise` facades (`src/v1/native.ts:635-643`).

### P2 public typed failures — resolved

The root entry exports the Effect operation and service APIs (`src/v1/index.ts:54-55`) together with their public typed failures: operation/client/runtime/native/watcher/background/SQL/handoff/retirement/store/database/app-server errors and `HerdrDriverError` (`src/v1/index.ts:57-74`). This permits supported-root imports for stable failure handling and declaration consumers.

### Final evidence and remaining issues

`.test-output/logs/2026-09-13T23-46-04.769Z-parity.log` records 162 tests, 162 passes, and zero failures, skips, cancellations, or todos. Final integration additionally reports the strict typecheck, build, and all-export-subpath package smoke passing. No material issue remains among the reviewed findings. Live native acceptance is a separate runtime verification and was not disturbed by this read-only recheck.
