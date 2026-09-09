import { agentAccessSchema } from './agent-access.js';
import { Schema } from 'effect';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { leadAgentSchema } from './types.js';

const identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
export const bindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  home: Schema.String,
  instanceId: Schema.String,
  projectId: identifier,
  root: Schema.String,
  session: identifier,
  socket: Schema.String,
  workspace: Schema.String.check(Schema.isPattern(/^w\d+$/)),
  lead: leadAgentSchema,
  leadName: Schema.String,
  leadProfile: Schema.optional(Schema.String),
  leasePath: Schema.String,
  runtime: Schema.String,
  runtimeExecutable: Schema.optional(Schema.String),
  trustWorkspaces: Schema.optional(Schema.Boolean),
  agentAccess: Schema.optionalKey(agentAccessSchema),
  trustAgy: Schema.optional(Schema.Boolean),
  mcp: Schema.Literals(['install', 'print', 'skip']),
  ownsWorkspace: Schema.optional(Schema.Boolean),
  ownsSession: Schema.optional(Schema.Boolean),
});
export type ProjectBinding = Schema.Schema.Type<typeof bindingSchema>;
export function readBinding(root: string) {
  root = realpathSync(root);
  const path = resolve(root, '.marionette/project.json');
  const binding = Schema.decodeUnknownSync(bindingSchema)(JSON.parse(readFileSync(path, 'utf8')));
  if (
    !isAbsolute(binding.home) ||
    !isAbsolute(binding.runtime) ||
    !isAbsolute(binding.leasePath) ||
    realpathSync(binding.root) !== root
  )
    throw new Error(`Invalid Marionette project binding: ${path}`);
  return { path, binding, text: readFileSync(path, 'utf8') };
}
export function findBinding(root = process.cwd()) {
  root = realpathSync(root);
  while (!existsSync(resolve(root, '.marionette/project.json'))) {
    if (dirname(root) === root)
      throw new Error(
        'No configured Marionette project found. Run setup first or pass --project DIR.',
      );
    root = dirname(root);
  }
  return readBinding(root);
}
