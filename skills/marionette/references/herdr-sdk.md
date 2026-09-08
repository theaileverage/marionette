# Thin Herdr SDK

## Coverage and compatibility

The SDK targets the installed Herdr **0.9.0, protocol 22** schema. It exposes all **102 schema-defined methods**, plus the documented `pane.graphics.stream` transport omitted by upstream's exported schema. This includes workspace, worktree, tab, pane, layout, agent, event, integration, plugin, notification, client, and server APIs. The full surface uses `api[method](params, options?)`; the short helpers below remain conveniences for common operations.

The vendored schema and generated types are reproducible with `npm run sdk:generate` in the Marionette source checkout. Coverage tests exercise every method through an isolated Unix-socket peer, plus streaming success/failure cases. A separate live 0.9.0 server/client check verified emitted RGB/RGBA/BGRA/PNG payloads, file-frame acknowledgements, placement, replacement, and layer removal using a simulated Kitty-capable terminal. See `VERIFICATION.md` in the package for evidence and limits; this does not validate every server-side operation or the native terminal display. Herdr still enforces semantic constraints, installed plugins, and client/graphics capabilities. Existing Marionette pane and agent methods also remain schema-compatible with 0.8.2/protocol 20.

The [Socket API documentation](https://herdr.dev/docs/socket-api/) describes the server contract. In 0.9.0, multiple clients can size tabs independently, so read current pane geometry before splitting.

After installing a build of Marionette containing the SDK, import its ESM subpath in Node.js 22.13+:

```js
import { HerdrClient, HerdrError } from '@theaileverage/marionette/herdr-sdk';

// Inside a real Herdr pane: reads HERDR_ENV and HERDR_SOCKET_PATH.
const herdr = HerdrClient.fromEnv();
const caller = process.env.HERDR_PANE_ID;
if (!caller) throw new Error('Missing caller pane');
const { layout } = await herdr.pane.layout(caller);
const rect = layout.panes.find((pane) => pane.pane_id === caller)?.rect;
if (!rect) throw new Error('Caller pane is missing from layout');
const { pane } = await herdr.pane.split(caller, {
  direction: rect.width >= rect.height * 3 ? 'right' : 'down',
  cwd: process.cwd(),
});
await herdr.agent.start(pane.pane_id, 'reviewer', 'codex');
const { agent } = await herdr.agent.get(pane.pane_id);
if (
  agent.name !== 'reviewer' ||
  agent.agent !== 'codex' ||
  !['idle', 'done'].includes(agent.agent_status) ||
  agent.launch_pending ||
  agent.interactive_ready === false
) {
  throw new Error('Inspect startup readiness before sending work');
}
await herdr.agent.prompt('reviewer', 'Review the assigned code and report actionable findings.', {
  timeout_ms: 120000,
});
const { read } = await herdr.pane.read(pane.pane_id, 120);
console.log(read.text);
```

This example creates and runs an independent agent only when that work is authorized. Do not use it to bypass a Marionette worker's delegation restriction.

For service integration, `new HerdrClient('/absolute/explicitly-selected/herdr.sock')` selects a named connection without fabricating caller environment or relying on UI focus. The constructor does not discover or start sessions. Keep the selected socket private to the local user.

Typed helpers preserve Herdr's result envelopes and opaque IDs:

- `workspace.list()`, `workspace.create({ cwd, label, env?, focus? })`
- `tab.list(workspaceId)`, `tab.create(workspaceId, { cwd, label?, env?, focus? })`, `tab.close(tabId)`
- `pane.list(workspaceId)`, `pane.layout(paneId)`, `pane.split(paneId, { direction, cwd, ratio?, env?, focus? })`
- `pane.read(paneId, lines?)`, `pane.sendText(paneId, text)`, `pane.sendKeys(paneId, keys)`, `pane.close(paneId)`
- `agent.start(paneId, name, kind, args?, timeoutMs?)`, `agent.get(target)`, `agent.prompt(target, text, wait?)`, `agent.wait(target, { timeout_ms, until? })`, `agent.sendKeys(target, keys)`

Creation defaults to `focus: false`. `pane.split` maps its target to the protocol's `target_pane_id`. Read uses `recent_unwrapped` text. `sendText` does not submit Enter; use `agent.prompt` for atomic agent prompt submission. Start requires an available shell pane. `agent.start` only acknowledges the protocol launch; check `agent.get` for matching identity and interactive readiness before prompting. The CLI can provide additional startup polling that the raw socket does not.

## Full typed wire API

```ts
import { HerdrClient, HERDR_METHODS } from '@theaileverage/marionette/herdr-sdk';

const herdr = HerdrClient.fromEnv();
const info = await herdr.request('ping');
if (info.type === 'pong') console.log(info.version, info.protocol);

// Same exact method and parameter names as Herdr's schema:
const layout = await herdr.api['pane.layout']({ pane_id: process.env.HERDR_PANE_ID });
if (layout.type === 'pane_layout') console.log(layout.layout.panes);
const plugins = await herdr.api['plugin.list']();
if (plugins.type === 'plugin_list') console.log(plugins.plugins);
console.log(HERDR_METHODS); // 102 schema-defined names
console.log(Object.keys(herdr.api)); // Includes pane.graphics.stream as well
```

`request(method, params?, options?)` supports all one-shot methods with generated parameter types. It returns the schema's discriminated `HerdrResult` union; narrow on `result.type` to read a particular response shape. Parameters are required when the schema requires fields. Runtime semantic and range validation belongs to Herdr. Values are ordinary JSON/JavaScript values; use safe integer values for counters that need exact arithmetic.

`api[method]` exposes those same calls and routes `events.subscribe` and `pane.graphics.stream` to persistent connections. `HerdrParams`, `HerdrMethod`, `HerdrResult`, `HerdrEvent`, and the request/response type namespaces are exported for typed agent code. The wire API passes parameters as supplied: unlike convenience creation helpers, it does not add `focus: false` or fill missing targets. Pass explicit IDs to avoid server-focused defaults.

Options accept `signal: AbortSignal`, `timeoutMs`, and `maxResponseBytes` (default 32 MiB per message). Ordinary requests default to 10 seconds. Agent startup and server waits allow their requested server timeout plus five seconds; a wait with no server deadline remains open until completion, disconnect or cancellation. `timeoutMs: null` explicitly disables the transport deadline. Aborting a mutation cannot undo input already delivered.

`call<Result>(method, params?, timeoutMs?)` remains an untyped escape hatch for future one-shot extensions, with a 10-second default. JavaScript omits `<Result>`. It refuses the two streaming methods, since closing at their first acknowledgement would discard the stream.

## Event subscriptions

```js
const controller = new AbortController();
const events = await herdr.subscribe([{ type: 'pane.created' }, { type: 'layout.updated' }], {
  signal: controller.signal,
  maxQueuedEvents: 1024,
});
try {
  // Subscribe first: 0.9.0 does not replay lifecycle history.
  const snapshot = await herdr.request('session.snapshot');
  console.log(snapshot);
  for await (const event of events) {
    console.log(event.event, event.data);
    // Apply events to the snapshot in order; break when this monitoring job finishes.
  }
} finally {
  events.close();
}
```

Subscription creation resolves only after Herdr's acknowledgement. It then buffers events while the initial snapshot is loading. All lifecycle, output-match, agent-status, and scroll subscriptions are available through generated `RequestTypes.Subscription`. A `for await` break or `events.close()` releases the socket. The supplied signal cancels the stream's entire lifetime. The open timeout applies only to acknowledgement.

Buffers default to 1,024 pending messages and 32 MiB total; `maxQueuedEvents` and `maxQueuedBytes` customize these bounds. Overflow fails with `herdr_stream_overflow` and closes the socket instead of silently losing events. Errors and unexpected disconnects reject iteration and `events.closed`. The SDK never reconnects or replays automatically; after an intentional reconnect, subscribe first and take a fresh snapshot.

## Graphics streams

```js
const stream = await herdr.graphicsStream({ pane_id: 'OBSERVED_PANE_ID', layer_id: 'preview' });
try {
  // One pixel of owned RGBA bytes; the SDK computes data_length.
  await stream.frame(
    { format: 'rgba', image_width: 1, image_height: 1 },
    new Uint8Array([255, 128, 0, 255]),
  );
  // Keep the stream open for the desired display lifetime.
} finally {
  stream.close(); // Herdr removes the layer when its owning stream closes.
}
```

Await each frame before sending another. Concurrent frames are rejected with `herdr_stream_busy` to prevent interleaved headers/bodies. Inline PNG/RGB/RGBA/BGRA frames send a JSON header followed by exactly the raw payload bytes, up to Herdr's 16 MiB inline limit. `frame()` resolves after the local socket write; Herdr does not send successful inline-frame acknowledgements. Observe `stream.closed` for later server errors.

For negotiated direct-file transport, first inspect `api['pane.graphics.info']`. Only use it when the server advertises support for the intended format, layer, size and attached terminal. Send an immutable absolute local `rgba` or `bgra` file with:

```js
const ack = await stream.fileFrame({
  format: 'rgba',
  image_width: 800,
  image_height: 600,
  file: { path: '/absolute/private/frame.rgba' },
  sequence: 1,
  revision: 1,
});
```

The returned ACK must match both sequence and revision before the source file may be reused. A failed or timed-out call grants no source-reuse acknowledgement. The SDK does not read, write or remove the source file. Frame calls have a 30-second default transport deadline. Graphics-stream request/frame types are maintained against Herdr's tagged stream implementation because the exported schema omits that method.

## Errors and scope

Errors expose `code` and `message`. Server codes are preserved; transport failures include `herdr_timeout`, `herdr_unavailable`, `herdr_disconnected`, `herdr_aborted`, `herdr_response_too_large`, and `herdr_stream_overflow`. A timeout or disconnect can occur after a mutation succeeded. Inspect the intended target before deciding to retry.

The SDK is dependency-free at runtime and accepts explicitly selected Unix socket paths or Windows named-pipe paths. It does not start sessions, manage permissions, install plugins, or dispatch workers except through the API calls the caller chooses. Closing a tab closes every pane inside it; preserve sibling workers and close only resources within the authorized scope.
