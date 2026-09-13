# Harness Adapter API

The alpha package exports a shared Adapter API from `@theaileverage/marionette/adapters`. A harness supplies capabilities with Zod input and output schemas. Agents compose those capabilities into a versioned adapter, call it through a typed interface, and inspect the same contract offline.

The shipped implementations are Herdr and Codex app-server messaging. The native runtime, board delivery, and retirement now call the composed Herdr adapter. A harness implemented with an SDK or another process protocol can define its own inputs and session identities without introducing Herdr pane fields.

## Define and compose capabilities

```ts
import { z } from 'zod';
import { composeAdapter, defineCapability } from '@theaileverage/marionette/adapters';

type HarnessSession = {
  read: (sessionId: string) => Promise<string>;
  send: (input: {
    sessionId: string;
    text: string;
    signal?: AbortSignal;
  }) => Promise<{ submissionId: string }>;
};

export function makeHarnessAdapter(session: HarnessSession) {
  const observation = {
    read: defineCapability({
      input: z.object({ sessionId: z.string().min(1) }).strict(),
      output: z.string(),
      effect: 'read',
      summary: 'Read the identified harness session.',
      execute: ({ sessionId }) => session.read(sessionId),
    }),
  };

  const messaging = {
    prompt: defineCapability({
      input: z
        .object({
          sessionId: z.string().min(1),
          text: z.string().max(100_000),
        })
        .strict(),
      output: z.object({ submissionId: z.string().min(1) }).strict(),
      effect: 'mutation',
      summary: 'Submit one message to the identified harness session.',
      execute: (input, { signal }) => session.send({ ...input, signal }),
    }),
  };

  return composeAdapter({ id: 'my-harness', version: 1 }, observation, messaging);
}
```

This example accepts an application-owned session implementation. Its submission ID acknowledges transport submission; the application still needs a durable result before declaring work complete.

`adapter.invoke('prompt', input, { signal })` retains the capability's exact input and output types. Unknown capability names and missing required fields fail type checking. At runtime, the adapter validates both directions. Inputs and outputs must be JSON compatible; optional object properties with `undefined` values are omitted. Cycles, non-finite numbers, and non-JSON values fail validation.

Compose as many capability modules as needed. Duplicate names fail during composition instead of overwriting a handler. `createHerdrCapabilities(driver)` exposes reusable registration, execution, messaging, and control modules. `createCodexAppServerCapabilities({ binding, transport })` exposes the messaging module for a registered Codex thread.

## Select an exact contract

```ts
import { AdapterRegistry } from '@theaileverage/marionette/adapters';

const registry = new AdapterRegistry([adapter]);
const selected = registry.get({ id: 'my-harness', version: 1 });
const description = selected.describe();
const result = await selected.dispatch('prompt', {
  sessionId: 'session-123',
  text: 'Read the current brief.',
});
```

Use `invoke` when the concrete adapter is known at compile time. Use `dispatch` when the host selects an adapter and capability dynamically. Both execute the same validated capability. Registry lookup requires an exact ID and contract version; it never substitutes another version. Registering the same pair twice fails.

`describe()` returns API version 1, the adapter reference, and each capability's name, summary, effect classification, input schema, and output schema. Description is local and does not call the harness. It does not evaluate schema default factories or refinements, or include bound credentials. Unsupported capabilities fail before invocation. Bump the adapter contract version when changing capability semantics or input/output compatibility. The contract version is separate from a harness binary version or a native session generation.

## Effects, cancellation, and recovery

`AdapterError` has a stable `code`, `phase`, and field paths. Validation failures do not echo rejected values. Errors thrown by a harness are wrapped with a safe message; their original cause is available to application code for private diagnostics.

The `before-invocation` phase covers rejected input, an unavailable capability, or a signal already cancelled before the handler starts. After the handler starts, malformed output or an exception has phase `after-invocation`. Inspect durable state before retrying a mutation in that phase. The API never retries or falls back to another capability or adapter.

Cancellation is cooperative. A pre-cancelled call never reaches the handler; a running handler receives the caller's `AbortSignal`. The host must keep accounting for any effect that may already have occurred. The existing Herdr driver retains its transport deadlines and per-effect checks; it does not gain mid-request cancellation merely by being composed.

Effect classification describes behavior. Admission, authorization, idempotency, durable claims, reservations, and accepted results remain with Marionette or the application embedding the adapter. Herdr's factory requires the existing caller-owned `NativeJournal`, and the migrated runtime still records and checks each native effect before dispatch. Codex delivery requires the caller's durable delivery ID and an explicitly bound thread/expected turn. Supplying a registry entry does not authorize launching a worker.

## Built-in factories

| Import                                                | Factory                                               | Capabilities                                                          |
| ----------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `@theaileverage/marionette/adapters/herdr`            | `createHerdrAdapter(journal, options)`                | register, launch, recover, adopt, observe, prompt, interrupt, cleanup |
| `@theaileverage/marionette/adapters/codex-app-server` | `createCodexAppServerAdapter({ binding, transport })` | deliver                                                               |

Herdr options accept injected endpoint/process inspectors and an SDK client factory. `composeHerdrAdapter(driver)` also accepts a structural driver, so implementations do not need to subclass the built-in driver. Herdr identities retain their endpoint instance and native session/process evidence.

Codex's transport belongs to the caller, which closes it when finished. The adapter can steer a registered active turn or start a turn on an idle registered thread. It does not create a substitute desktop app-server. Availability still depends on a usable registered endpoint; the previously tested desktop-only private-stdio setup remains unsupported.

## Integration scope

This is an importable composition and invocation API. The alpha CLI's scheduled native attempts still use the existing Herdr binding and identity storage. Loading third-party adapter modules into the CLI, persisting provider selection for a background watcher, and scheduling a new provider are separate integrations. The in-process registry does not imply those integrations exist.

Verification covers typed composition, exact-version selection, duplicate rejection, pre-execution validation, cancellation, invalid-output handling without replay, a real disposable child process, the Herdr lifecycle through a local protocol fixture, and Codex expected-turn messaging through a protocol fixture. Installed-package checks exercise the exports and TypeScript declarations. These checks do not establish live compatibility for a future harness.
