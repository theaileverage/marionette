import { Schema } from 'effect';
import { composeAdapter, defineCapability } from '../adapters.js';
import {
  CodexAppServerDeliveryPort,
  type CodexThreadBinding,
  type JsonRpcTransport,
} from '../codex-app-server.js';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
export const codexThreadBindingSchema = Schema.Struct({
  projectId: nonEmpty,
  executionHostId: nonEmpty,
  endpointHostId: nonEmpty,
  endpoint: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('websocket'), url: Schema.String.check(Schema.isPattern(/^wss?:\/\//)), authorization: Schema.optional(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal('unix'), socketPath: nonEmpty, requestPath: Schema.optional(Schema.String), authorization: Schema.optional(Schema.String) }),
  ]),
  threadId: nonEmpty,
  activeTurnId: Schema.optional(nonEmpty),
});
export const codexDeliveryInputSchema = Schema.Struct({
  deliveryId: nonEmpty,
  project: nonEmpty,
  recipient: Schema.Struct({ kind: Schema.Literal('codex-desktop'), id: nonEmpty, generation: nonEmpty }),
  message: Schema.String,
});
export const codexDeliveryOutputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('submitted'), turnId: nonEmpty }),
  Schema.Struct({ kind: Schema.Literal('unconfirmed'), reason: nonEmpty }),
  Schema.Struct({ kind: Schema.Literal('unsupported'), reason: nonEmpty }),
]);

export function createCodexAppServerCapabilities(input: {
  binding: CodexThreadBinding;
  transport: JsonRpcTransport;
}) {
  const binding = Schema.decodeSync(codexThreadBindingSchema, { onExcessProperty: 'error' })(input.binding);
  const port = new CodexAppServerDeliveryPort(binding, input.transport);
  return {
    deliver: defineCapability({
      input: codexDeliveryInputSchema,
      output: codexDeliveryOutputSchema,
      effect: 'mutation',
      summary: 'Deliver a durably claimed notification to one registered Codex thread.',
      execute: (request) => port.deliver(request),
    }),
  };
}
export function createCodexAppServerAdapter(input: {
  binding: CodexThreadBinding;
  transport: JsonRpcTransport;
}) {
  return composeAdapter(
    { id: 'codex-app-server', version: 1 },
    createCodexAppServerCapabilities(input),
  );
}
export type CodexAppServerAdapter = ReturnType<typeof createCodexAppServerAdapter>;

export { AppServerWebSocketTransport } from '../codex-app-server.js';
export type {
  CodexThreadBinding,
  JsonRpcTransport,
  AppServerEndpoint,
  AppServerRequest,
  AppServerReply,
} from '../codex-app-server.js';
