import { z } from 'zod';
import { operationSchema, type Operation } from './operations.js';
import { VERSION } from './version.js';

export type CommandName = Operation['operation'];
type Metadata = {
  summary: string;
  effect: 'read' | 'local-write' | 'native' | 'destructive';
  controller?: boolean;
  watcher?: boolean;
};
export const commandMetadata = {
  'harness.list': {
    summary: 'List allow-listed installations and probed endpoints.',
    effect: 'read',
  },
  'harness.discover': {
    summary: 'Register the built-in Herdr provider without enabling execution.',
    effect: 'local-write',
    controller: true,
  },
  'harness.probe': {
    summary: 'Probe an explicit Herdr endpoint read-only.',
    effect: 'local-write',
    controller: true,
  },
  'harness.enable': {
    summary: 'Change installation authority at its expected revision.',
    effect: 'local-write',
    controller: true,
  },
  'profile.define': {
    summary: 'Define a versioned concrete endpoint profile.',
    effect: 'local-write',
    controller: true,
  },
  'profile.bind': {
    summary: 'Bind an ordered routing policy to concrete profiles.',
    effect: 'local-write',
    controller: true,
  },
  'profile.route-preview': {
    summary: 'Persist an explained routing snapshot; admission rechecks eligibility.',
    effect: 'local-write',
    controller: true,
  },
  'service.install': {
    summary: 'Install the user service definition without starting it.',
    effect: 'native',
  },
  'service.start': { summary: 'Start the OS-supervised project service.', effect: 'native' },
  'service.stop': {
    summary: 'Stop OS supervision and drain the current service.',
    effect: 'native',
  },
  'service.uninstall': {
    summary: 'Stop and remove the exact installed service definition.',
    effect: 'destructive',
  },
  'service.status': {
    summary: 'Read service generation and installation definition.',
    effect: 'read',
  },
  'event.list': { summary: 'Read the durable project event sequence.', effect: 'read' },
  'controller.configure': {
    summary: 'Configure the logical Chief of Staff at its expected revision.',
    effect: 'local-write',
  },
  'controller.ensure': {
    summary: 'Launch a controller using an explicitly selected harness route.',
    effect: 'native',
  },
  'controller.status': {
    summary: 'Read durable controller identity and lifecycle.',
    effect: 'read',
  },
  'controller.reconcile': {
    summary: 'Observe the exact controller native identity.',
    effect: 'native',
  },
  'inbox.read': { summary: 'Read canonical controller events and claims.', effect: 'read' },
  'inbox.ack': {
    summary: 'Commit a structured decision and its inbox acknowledgement atomically.',
    effect: 'local-write',
  },
  'workflow.bind': {
    summary: 'Bind a workflow step to a selected harness route.',
    effect: 'local-write',
  },
  'decision.list': { summary: 'List durable human decisions.', effect: 'read' },
  'decision.request': {
    summary: 'Request a bounded human choice at current workflow revisions.',
    effect: 'local-write',
  },
  'decision.resolve': {
    summary: 'Apply one current human choice exactly once.',
    effect: 'local-write',
  },
  'approval.list': { summary: 'List exact native approval requests.', effect: 'read' },
  'approval.request': {
    summary: 'Record an exact native operation requiring approval.',
    effect: 'local-write',
  },
  'approval.resolve': {
    summary: 'Record approval action; unsupported forwarding remains manual-required.',
    effect: 'local-write',
  },
  'approval.reconcile': {
    summary: 'Reconcile exact approval identity and evidence.',
    effect: 'local-write',
  },
  'service.reconcile': {
    summary: 'Observe the exact OS service action before allowing further lifecycle changes.',
    effect: 'local-write',
  },
  context: {
    summary: 'Show the effective project and session without credentials.',
    effect: 'read',
  },
  'handoff.get': { summary: 'Read a handoff and its current claim.', effect: 'read' },
  'handoff.create': {
    summary: 'Create a delivery plan for a durable result.',
    effect: 'local-write',
    controller: true,
  },
  'handoff.claim': {
    summary: 'Assign the target writer reservation to an integrator.',
    effect: 'local-write',
    controller: true,
  },
  'handoff.check': {
    summary: 'Run a check command in the claimed target workspace.',
    effect: 'native',
  },
  'handoff.complete': {
    summary: 'Record integration after checking target state and applied content.',
    effect: 'local-write',
  },
  'handoff.resolve': {
    summary: 'Retain or abandon delivery with a recorded reason.',
    effect: 'local-write',
    controller: true,
  },
  'handoff.replan': {
    summary: 'Replace a settled claim with a revised target plan.',
    effect: 'local-write',
    controller: true,
  },
  'workspace.register': {
    summary: 'Register a workspace and its permitted writes.',
    effect: 'local-write',
    controller: true,
  },
  'workspace.get': { summary: 'Read a registered workspace.', effect: 'read' },
  'workspace.retire': {
    summary: 'Remove an eligible isolated worktree after protected checks.',
    effect: 'destructive',
    controller: true,
  },
  'input.snapshot': {
    summary: 'Save a local file as a durable content-addressed artifact.',
    effect: 'local-write',
  },
  'job.create': {
    summary: 'Record a direct job with an immutable request and brief.',
    effect: 'local-write',
    controller: true,
  },
  'job.list': { summary: 'List jobs in this project.', effect: 'read' },
  'job.get': { summary: 'Read a job.', effect: 'read' },
  'job.brief': { summary: 'Read the current or selected brief revision.', effect: 'read' },
  'workflow.create': {
    summary: 'Record a pinned workflow; scheduling requires explicit activation.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.activate': {
    summary: 'Activate scheduling at exact current revisions.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.transition': {
    summary: 'Commit an evidence-gated workflow transition.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.revise': {
    summary: 'Revise a brief and invalidate affected downstream work.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.pause': {
    summary: 'Request pause and retain unsettled effects.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.cancel': {
    summary: 'Cancel future admission and track settlement.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.resume': {
    summary: 'Resume a confirmed paused workflow at current revisions.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.extend-limits': {
    summary: 'Record a revisioned workflow limit change.',
    effect: 'local-write',
    controller: true,
  },
  'workflow.status': { summary: 'Read workflow scheduling and control state.', effect: 'read' },
  'workflow.list': { summary: 'List workflow records.', effect: 'read' },
  'workflow.get': { summary: 'Read a workflow record.', effect: 'read' },
  route: { summary: 'Choose the applicable pinned workflow or direct route.', effect: 'read' },
  'attempt.get': { summary: 'Read an attempt and its execution state.', effect: 'read' },
  'brief.acknowledge': {
    summary: 'Acknowledge the assigned brief revision.',
    effect: 'local-write',
  },
  'result.get': { summary: 'Read a durable result.', effect: 'read' },
  'result.record': {
    summary: 'Record an active attempt result and verified evidence.',
    effect: 'local-write',
  },
  'result.decide': {
    summary: 'Accept or reject a result against its current brief.',
    effect: 'local-write',
    controller: true,
  },
  'board.create': { summary: 'Create an idempotent discussion thread.', effect: 'local-write' },
  'board.post': {
    summary: 'Post an immutable message and notification intents.',
    effect: 'local-write',
    watcher: true,
  },
  'board.list': { summary: 'Read a bounded page of discussion threads.', effect: 'read' },
  'board.read': { summary: 'Read a bounded page of thread messages.', effect: 'read' },
  'board.search': { summary: 'Search a bounded page of board messages.', effect: 'read' },
  'board.subscribe': {
    summary: 'Subscribe this session to board notifications.',
    effect: 'local-write',
    watcher: true,
  },
  'board.unsubscribe': {
    summary: 'Remove this session’s board subscription.',
    effect: 'local-write',
  },
  'board.mark-read': {
    summary: 'Record the last message read by this session.',
    effect: 'local-write',
  },
  'sql.read': {
    summary: 'Run bounded SQL against project-scoped read-only views.',
    effect: 'read',
  },
  'profile.list': { summary: 'List configured execution profiles.', effect: 'read' },
  'profile.configure': {
    summary: 'Set an explicit execution profile with a revision fence.',
    effect: 'local-write',
    controller: true,
  },
  'native.register': {
    summary: 'Inspect and register a Herdr connection.',
    effect: 'native',
    controller: true,
  },
  'attempt.admit': {
    summary: 'Reserve resources for a job attempt.',
    effect: 'local-write',
    controller: true,
    watcher: true,
  },
  'attempt.start': {
    summary: 'Start a previously admitted native attempt without replaying effects.',
    effect: 'native',
    controller: true,
    watcher: true,
  },
  'attempt.inspect': {
    summary: 'Observe the registered native identity and save its observation.',
    effect: 'native',
    controller: true,
  },
  'attempt.reconcile': {
    summary: 'Reconcile native state while retaining uncertain reservations.',
    effect: 'native',
    controller: true,
  },
  'sql.contribute': {
    summary: 'Validate one SQL board contribution in an isolated table.',
    effect: 'local-write',
    watcher: true,
  },
} satisfies Record<CommandName, Metadata>;

export type FieldFlag = { field: string; name: string; type: 'string' | 'number' | 'boolean' };
function flagType(schema: z.ZodTypeAny): FieldFlag['type'] | undefined {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodBranded
  )
    return flagType(schema.unwrap());
  if (schema instanceof z.ZodDefault) return flagType(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return flagType(schema.innerType());
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return undefined;
}
export const commands = operationSchema.options.map((schema) => {
  const name = schema.shape.operation.value;
  const flags: FieldFlag[] = [];
  for (const [field, definition] of Object.entries(schema.shape)) {
    const type = flagType(definition);
    if (field !== 'operation' && type)
      flags.push({
        field,
        name: field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        type,
      });
  }
  const metadata: Metadata = commandMetadata[name];
  return { name, schema, flags, ...metadata, stability: 'alpha' as const };
});
export const contractVersion = 1;
export const cliVersion = VERSION;
export const globalOptions = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  project: { type: 'string' },
  input: { type: 'string' },
  json: { type: 'string' },
  output: { type: 'string' },
  'no-input': { type: 'boolean' },
  'no-watch': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
} as const;
export const environmentContract = [
  {
    name: 'MARIONETTE_CONTEXT',
    purpose:
      'Managed project/session credential file; inherited context cannot be overridden by --project.',
    secret: false,
  },
  {
    name: 'MARIONETTE_STATE_HOME',
    purpose: 'State root; init --state-home overrides it.',
    secret: false,
  },
  {
    name: 'XDG_STATE_HOME',
    purpose: 'Fallback state root before the per-user default.',
    secret: false,
  },
];
export const exitCodes = { success: 0, operationFailed: 1, invalidInput: 2 };
export function findCommand(name: string) {
  return commands.find((command) => command.name === name);
}
