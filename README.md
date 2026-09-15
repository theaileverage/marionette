# Marionette

Marionette is a local, evidence-backed workflow runtime for coding agents. The CLI and TypeScript SDK use the same durable project state. Native work, recorded results, acceptance, and integration have separate states so an idle agent is never mistaken for an accepted result.

The default v1 implementation uses Effect v4 for services, schemas, and workflows. SQLite remains the authority for project identity, session generations, immutable inputs, result evidence, and external-effect claims. Marionette v1 is CLI-only; it does not expose an MCP or HTTP server.

Requires Node.js 26.8.1 or newer, a Herdr server for native execution, and an authenticated agent executable. Development uses Bun 1.3.14 and the pinned lockfile.

```sh
bun install --frozen-lockfile
npm run check
npm test
npm run boundaries:check
npm run package:smoke
```

Install the alpha CLI with `npm install --global @theaileverage/marionette@alpha`, then run `marionette init` in your repository. New projects bind through `.marionette/project.json`. The private state directory holds the SQLite database and session credentials outside the repository. A repository with an existing `.marionette-v1/project.json` reuses that project identity when initialized with the current CLI; the old binding remains available for managed sessions that still name it.

Run `marionette --help` for the available v1 operations and `marionette schema OPERATION` for a mutation's installed request contract. Workers inherit `MARIONETTE_CONTEXT`; that managed context fixes their project and session. A local native observation is execution evidence, not result acceptance.

## Effect API

Public codecs are Effect Schema values. Decode untrusted input with `Schema.decodeUnknownSync(codec)(input)` or `Schema.decodeUnknownEffect(codec)(input)`. Effect callers may use `executeEffect` or the scoped `MarionetteService`; imperative callers may use `Marionette.connect` and must call `close()`.

Native launch and notification claims are durable before external mutation. Ambiguous acknowledgments remain uncertain until reconciled, and the runtime does not blindly replay them. A result can be recorded while acceptance and integration remain pending.

## Verification

The test harness compares selected behavior with a pinned pre-port source snapshot from Git history. CI fetches full history for that oracle. The boundary check compares every current `src/` file with [the reviewed Effect source manifest](evidence/effect-source-manifest.json), verifies the product import graph stays inside `src/`, and rejects product Zod imports. When changing source intentionally, review and update the manifest in the same change. These checks and package smoke establish local behavior and artifact completeness; live Herdr compatibility requires separate native acceptance.

See [release instructions](RELEASING.md), [Effect diagnostics](docs/diagnostics.md), and [extension contracts](docs/extensions.md).
