# Marionette

Marionette is a local CLI and TypeScript SDK for delegating work to coding agents, sharing a durable message board, and tracking results in SQLite. Native workers run through Herdr. The CLI and SDK call the same implementation. No Marionette MCP server or HTTP service is required.

This branch prepares **1.0.0-alpha.1**. It is a breaking rewrite. Existing Marionette databases and sessions are not imported into the new state directory.

## Requirements

- Node.js 26.8.1 or newer.
- Herdr for native worker execution.
- The agent executable selected in your execution profile.

## Project setup

```sh
marionette init --project /absolute/path/to/repository
marionette context
marionette schema
marionette schema board.post
```

Initialization writes `.marionette-v1/project.json` inside the repository. SQLite and durable artifacts live under the configured state home. Set `MARIONETTE_STATE_HOME` or pass `--state-home` during initialization to choose it.

Commands discover the binding from the current directory. Use `--project /absolute/path/to/.marionette-v1/project.json` when calling from elsewhere. Managed agents inherit `MARIONETTE_CONTEXT`, which binds their project and session even when their working directory changes. A managed session cannot switch projects or become a local user by supplying another binding.

## Harness adapters

The alpha SDK exports `defineCapability`, `composeAdapter`, and `AdapterRegistry` from `@theaileverage/marionette/adapters`. Capabilities declare typed input/output schemas and effects; composed adapters expose validated invocation, offline descriptions, exact-version lookup, and cooperative cancellation. Herdr execution and Codex app-server messaging use this contract. See [the Adapter API guide](documentation/v1/adapters.md) for composition examples and integration scope.

## CLI input

Common operations accept flags, for example `marionette board create --title Notes --idempotency-key notes`. Nested requests accept `--input FILE`, `--input -` for stdin, or `--json JSON_OR_FILE`. Request flags and raw JSON cannot be combined. Both paths use the same validation; input files and inline JSON are limited to 1 MiB.

The CLI never prompts. When both stdin and stdout are terminals, results use readable, escaped output capped at 4000 characters with an explicit abbreviation notice. Pipes retain complete JSON results. Override with `--output human|json|ndjson`; NDJSON emits one line per top-level array item. Diagnostics go to stderr. Exit codes are 0 for success, 1 for operational failures, and 2 for invalid input.

`marionette schema [OPERATION]` (also `describe`) works offline and describes this installed version's inputs, constraints, defaults, flags, output schemas, effects, environment, and exit codes. `marionette COMMAND --help` describes a command. JSON success values remain unwrapped for compatibility; errors have a stable `error` object containing `code`, `message`, `fields`, `retry`, and `mutation`.

`marionette workspace retire --workspace-id ID --idempotency-key KEY --dry-run` checks local authorization, persisted state, and Git state, and reports planned effects. It opens existing credentials and the database read-only; missing setup or pending migrations fail without creating or upgrading state. It does not record retirement intent, contact native agents, close tabs, or remove worktrees. Its `skippedChecks` list identifies checks that execution must still perform. A ready preview is a snapshot, not a guarantee that a later retirement will succeed.

Board reads already support bounded pages. Other list operations retain their complete JSON response for compatibility; pagination and projections for those operations remain follow-ups. `marionette context` reports the credential source and effective project, role, and workspace scope without printing the token. Authentication continues to use the existing private local session files; this alpha has no remote login flow.

```sh
printf '%s\n' '{"title":"Implementation notes","idempotencyKey":"notes-thread"}' |
  marionette board create --input -
```

Use the returned thread ID in subsequent commands.

```json
{
  "threadId": "RETURNED_THREAD_ID",
  "body": "The parser change is ready for review.",
  "kind": "result",
  "idempotencyKey": "parser-ready"
}
```

Save this as `post.json`, then run:

```sh
marionette board post --input post.json
```

`marionette exec` accepts the same payload with an `operation` field, such as `"operation":"board.post"`. Mutations that accept an idempotency key return the recorded result on an identical retry and reject reuse with a different payload.

## TypeScript SDK

```ts
import { Marionette } from '@theaileverage/marionette';

const client = Marionette.connect();
try {
  const thread = client.createThread({
    title: 'Implementation notes',
    idempotencyKey: 'notes-thread',
  });
  client.post({
    threadId: thread.id,
    kind: 'progress',
    body: 'The parser tests pass.',
    idempotencyKey: 'parser-tests',
  });
  const page = client.readThread({ threadId: thread.id });
  console.log(page.entries);
} finally {
  client.close();
}
```

The package also exports operation validation, workflow package loading, routing, and the Herdr SDK through `@theaileverage/marionette/herdr-sdk`.

## Collaboration and SQL

Board posts are immutable and have stable sequence numbers. Replies and replacements refer to earlier posts. Subscriptions create durable notification intents. Progress stays on the board by default; questions, blockers, and results notify subscribers.

`sql.read` runs bounded queries against public project-scoped views in a separate Node worker. It rejects writes, attachment, pragmas, and extension loading. Query limits cover execution time, row count, and output size. `sql.contribute` accepts one validated board contribution through an isolated in-memory table. It cannot mutate runtime tables.

## Native execution

Register a Herdr connection and configure an execution profile before admitting an attempt. A profile names the executable, model, and permitted method. Admission records the current brief, workspace, session identity, and reservations before any launch effect.

The runtime journals launch and prompt claims. A crash after a claim leaves the effect unconfirmed. It does not blindly launch another worker. A native idle observation releases a reservation only after the attempt has a durable result. Result acceptance remains a separate decision.

The project watcher owns native launch and prompt execution. `attempt start` ensures that watcher is running and returns the current observation; inspect the attempt until its launch is confirmed. CLI callers do not race the watcher by launching directly. The CLI starts a local background watcher after relevant runtime and board operations. SDK callers can call `ensureWatcher()` explicitly. `marionette watch --stop-after 5000` runs a bounded foreground watcher. Uncertain delivery is retained for reconciliation rather than automatically repeated.

`attempt retained-work --id ATTEMPT` (SDK: `inspectRetainedWork`) refreshes and returns typed native conversation references, an explicit bounded-history status, and job-scoped retained attempts/results/artifacts. Pi and OMP confirmed JSONL paths support local bounded history; identifier-only harnesses report history as unsupported. Reference identity is separate from the pane/process locator, and legacy string bytes remain explicitly untyped. See [native session references](documentation/v1/native-session-references.md).

Desktop notification support requires a reachable endpoint for the actual desktop-owned Codex app-server. The current local desktop uses private stdio, so delivery to it is unavailable. The board remains readable. A separately started app-server would not establish access to that desktop task.

## Handoff and retirement

A controller creates a handoff for an accepted patch or commit result, then assigns its claim to a running integrator on the exact target write workspace. The integrator uses native Git. Handoff checks capture the resulting target state and reject drift during checks or before completion.

Integration completion requires a durable `text/x-diff` artifact whose changes are present in the target. If conflict resolution changes those edits, record and accept the revised result before completion. A passing command alone does not prove that a source patch was applied.

`workspace.retire` checks consumers, unresolved handoffs, Git state, and durable evidence before removal. Uncertain native cleanup claims are retained without resending. Sessions already recorded as settled are released consumers; this alpha can leave their idle native tabs open.

## Workflow packages

Bundled packages include `direct`, `feature`, `bug-fix`, `refactoring`, and `architect`. They pin workflow definitions, role configuration, and imported pstack skill resources by digest. Routing keeps routine requests direct. Package creation stores the chosen resources with the workflow.

Workflow controls support drain pause, immediate pause, and cancellation through `workflow.control` (SDK: `controlWorkflow`). The receipt confirms durable admission fencing; the watcher or `attempt.reconcile` confirms native settlement separately. Safe pause, resume, automatic workflow progression, brief revision controls, and limit changes remain unavailable. Creating a workflow record does not prove that its stages will execute automatically.

## Storage and verification

SQLite opens with numbered, transactional migrations. Applied migration checksums are recorded. The runtime rejects a newer schema or an edited applied migration. Requests, briefs, results, and artifact digests retain the evidence needed to inspect decisions after a restart.

The repository tests use real temporary SQLite databases and disposable Git repositories. Native adapter tests use local Unix-socket fixtures. Live native compatibility requires a separate real Herdr check.

```sh
bun install --frozen-lockfile
npm run check
npm test
npm run build
npm run release:check
```

Build output lives in `dist`. The package smoke script installs an actual tarball into a temporary project, exercises CLI and SDK board reads, runs the SQL worker from another directory, loads bundled workflows, and checks exported TypeScript declarations.

```sh
npm pack
node scripts/package-smoke-v1.mjs /absolute/path/to/package.tgz
```

See [the implementation plan](documentation/v1/implementation-plan.md) and [execution contracts](documentation/v1/execution-contracts.md) for the rewrite scope and remaining acceptance work.

## License

MIT. Bundled Herdr and pstack notices are retained in `THIRD_PARTY_NOTICES.md`.
