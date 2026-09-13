# Marionette Effect port

This is the additive Effect v4 implementation of Marionette v1. It owns its source, schemas, database code, runtime, watcher, adapters, SDK facade, and CLI. The original Node/Zod implementation remains the comparison baseline outside this folder.

Requires Node 26.8.1 or newer. Bun manages the separate lockfile; Node runs SQLite and the application.

```sh
cd effect-port
bun install --frozen-lockfile
npm run prepare
npm run check
npm test
node scripts/build.mjs
node dist/v1/cli.js --help
```

The build emits JavaScript and declarations into `dist/` and checks the captured workflow and coordination-skill resources stored in this package. It does not publish or migrate an existing installation. The package stays private during the additive migration.

## Effect API

All public codecs are native Effect Schema values. Use `Schema.decodeUnknownSync(codec)(input)` or `Schema.decodeUnknownEffect(codec)(input)`; use `typeof codec.Type` for decoded types. Schema `.parse`, `.safeParse`, and Zod introspection are replaced by Effect's decoding and AST APIs. CLI JSON shapes and authority checks retain the v1 contracts.

The scoped service owns the connection and closes SQLite on successful exit, failure, or interruption:

```ts
import { Effect } from 'effect';
import { MarionetteService, marionetteLayer } from './dist/v1/index.js';

const program = Effect.gen(function* () {
  const marionette = yield* MarionetteService;
  return yield* marionette.execute({ operation: 'context' });
});

await Effect.runPromise(
  program.pipe(Effect.provide(marionetteLayer({ cwd: '/absolute/project/path' }))),
);
```

`Marionette.connect` and the Promise SDK remain available for imperative callers, which must call `close()`. Effect callers use `executeEffect`, the scoped service, or the named `*Effect` methods. Exported tagged errors support typed handling. SQLite transaction callbacks are deliberately synchronous and reject Promise and Effect results.

The separate Herdr SDK entry remains dependency-free. Native launch and notification claims are durable before external mutation; ambiguous acknowledgements retain uncertainty and are never blindly retried. A result and its acceptance are separate from a native idle observation.

## Diagnostics and evidence

Open `effect-port.code-workspace` for the local TypeScript-Go and Effect language service settings. See [diagnostics](docs/diagnostics.md) for commands and the deliberate-failure plugin smoke test.

The harness verifies the captured baseline hashes, redirects adapted v1 tests to port-owned source, and permits original source only as an explicitly isolated test oracle. It uses separate scratch directories for concurrent runs. See [test adaptations](docs/test-adaptations.md), [architecture](docs/architecture.md), [extension contracts](docs/extensions.md), and [coverage](docs/coverage.json). Passing a selected slice does not establish whole-project or live native parity; retained evidence records those distinctions.
