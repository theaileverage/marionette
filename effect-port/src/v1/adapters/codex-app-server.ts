import { Schema } from 'effect';
import { composeAdapter, defineCapability } from '../adapters.js';
import {
  CodexAppServerDeliveryPort,
  type CodexThreadBinding,
  type JsonRpcTransport,
} from '../codex-app-server.js';
import { NativeSessionPointerSchema } from '../native-session.js';

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
export const codexInspectionInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Finite.check(
      Schema.makeFilter((value) => Number.isInteger(value) && value >= 1 && value <= 200),
    ),
  ),
  maxBytes: Schema.optional(
    Schema.Finite.check(
      Schema.makeFilter((value) => Number.isInteger(value) && value >= 1 && value <= 256 * 1024),
    ),
  ),
});
export const codexInspectionOutputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('unconfirmed'), reason: nonEmpty }),
  Schema.Struct({ kind: Schema.Literal('session-missing'), reason: nonEmpty }),
  Schema.Struct({
    kind: Schema.Literal('available'),
    threadId: nonEmpty,
    reference: NativeSessionPointerSchema,
    status: Schema.Literals(['active', 'idle']),
    turns: Schema.Array(Schema.Unknown),
    truncated: Schema.Boolean,
    bytes: Schema.Finite,
  }),
]);

export function createCodexAppServerCapabilities(input: {
  binding: CodexThreadBinding;
  transport: JsonRpcTransport;
}) {
  const binding = Schema.decodeSync(codexThreadBindingSchema, { onExcessProperty: 'error' })(input.binding);
  const port = new CodexAppServerDeliveryPort(binding, input.transport);
  return {
    inspect: defineCapability({
      input: codexInspectionInputSchema,
      output: codexInspectionOutputSchema,
      effect: 'read',
      summary: 'Read bounded history from the registered Codex thread.',
      execute: (request) => port.inspect(request),
      executeEffect: (request) => port.inspectEffect(request),
    }),
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
  CodexThreadHistory,
} from '../codex-app-server.js';
