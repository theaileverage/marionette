import { z } from 'zod';
import { composeAdapter, defineCapability } from '../adapters.js';
import {
  CodexAppServerDeliveryPort,
  type CodexThreadBinding,
  type JsonRpcTransport,
} from '../codex-app-server.js';
import { NativeSessionPointerSchema } from '../native-session.js';

export const codexThreadBindingSchema = z
  .object({
    projectId: z.string().min(1),
    executionHostId: z.string().min(1),
    endpointHostId: z.string().min(1),
    endpoint: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('websocket'),
          url: z.string().url(),
          authorization: z.string().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('unix'),
          socketPath: z.string().min(1),
          requestPath: z.string().optional(),
          authorization: z.string().optional(),
        })
        .strict(),
    ]),
    threadId: z.string().min(1),
    activeTurnId: z.string().min(1).optional(),
  })
  .strict();
export const codexDeliveryInputSchema = z
  .object({
    deliveryId: z.string().min(1),
    project: z.string().min(1),
    recipient: z
      .object({
        kind: z.literal('codex-desktop'),
        id: z.string().min(1),
        generation: z.string().min(1),
      })
      .strict(),
    message: z.string(),
  })
  .strict();
export const codexDeliveryOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('submitted'), turnId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unconfirmed'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
]);
export const codexInspectionInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024)
      .optional(),
  })
  .strict();
export const codexInspectionOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfirmed'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('session-missing'), reason: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('available'),
      threadId: z.string().min(1),
      reference: NativeSessionPointerSchema,
      status: z.enum(['active', 'idle']),
      turns: z.array(z.unknown()),
      truncated: z.boolean(),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
]);

export function createCodexAppServerCapabilities(input: {
  binding: CodexThreadBinding;
  transport: JsonRpcTransport;
}) {
  const binding = codexThreadBindingSchema.parse(input.binding);
  const port = new CodexAppServerDeliveryPort(binding, input.transport);
  return {
    inspect: defineCapability({
      input: codexInspectionInputSchema,
      output: codexInspectionOutputSchema,
      effect: 'read',
      summary: 'Read bounded history from the registered Codex thread.',
      execute: (request) => port.inspect(request),
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
