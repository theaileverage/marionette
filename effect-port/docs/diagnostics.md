# Effect and TypeScript diagnostics

This package pins Effect 4.0.0-rc.112, TypeScript 7.0.2 (the native Go compiler), and @effect/tsgo 0.43.0. The latter adds Effect diagnostics and language service support to TypeScript-Go. These versions match the installed tool's supported-version table.

From `effect-port/`:

```sh
bun install --frozen-lockfile
npm run prepare
npm run check
npm run effect:diagnostics
npm run toolchain:check
```

`prepare` patches this package's native TypeScript executable. Run it explicitly after installations that disable lifecycle scripts. `check` runs TypeScript and Effect diagnostics; the dedicated diagnostics command also supports structured JSON through `effect:diagnostics:json`.

Open `effect-port.code-workspace` (or this folder) in an editor with TypeScript-Go support. The checked-in workspace and `.vscode/settings.json` select the local native SDK; `tsconfig.json` enables the Effect language service plugin. An already open editor may require a TypeScript server restart. Editor activation is not established by the command-line check.

`toolchain:check` creates an isolated ignored probe, deliberately leaves an Effect unused, and asserts that the diagnostic named `floatingEffect` is an error and the process exits unsuccessfully. It saves the versions and diagnostic in `evidence/diagnostics-smoke.json`. This proves the plugin runs; it does not assert that the application itself typechecks or that an editor is running the language service.
