import { Effect, Schema } from 'effect';
import { profileSchema } from './orchestration-types.js';
import { credentialsSchema, kindSchema, leadAgentSchema } from './types.js';

export const projectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  session: Schema.String,
  socketPath: Schema.String,
  workspaceId: Schema.String,
  maxConcurrency: Schema.Finite,
  agentArgs: Schema.Record(
    kindSchema,
    Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  ),
  trustWorkspaces: Schema.optional(Schema.Boolean),
  trustAgyWorkspaces: Schema.optional(Schema.Boolean),
  createdAt: Schema.String,
});
export const briefingSchema = Schema.Struct({
  project: projectSchema,
  lead: Schema.NullOr(
    Schema.Struct({
      owner: Schema.String,
      epoch: Schema.Finite,
      agent: Schema.optional(leadAgentSchema),
    }),
  ),
  profiles: Schema.mutable(Schema.Array(profileSchema)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  profileDefaults: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const leaseResponseSchema = Schema.Struct({ lease: credentialsSchema });
export const jsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
