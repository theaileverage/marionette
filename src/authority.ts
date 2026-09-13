import { Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { inside, safePath } from './files.js';
import type { Service } from './service.js';
import { AppError, credentialsSchema, now, type Task } from './types.js';

export const authorityInputSchema = Schema.Struct({
  projectId: Schema.String,
  outcomeId: Schema.String,
  activities: Schema.Array(Schema.Literals(['documentation', 'implementation', 'execute'])),
  scope: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  source: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export interface Authority extends Schema.Schema.Type<typeof authorityInputSchema> {
  id: string;
  createdAt: string;
  origin: 'user-cli' | 'lead-conversation';
  recordedBy?: string;
  outcomeRevision?: number;
  leadEpoch?: number;
}

export function grantAuthority<Input>(s: Service, raw: Input) {
  return persistAuthority(s, Schema.decodeUnknownSync(authorityInputSchema)(raw), 'user-cli');
}

const conversationAuthoritySchema = Schema.Struct({
  ...authorityInputSchema.fields,
  lease: credentialsSchema,
  expectedRevision: Schema.Int,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export function recordUserRequest<Input>(s: Service, raw: Input) {
  const input = Schema.decodeUnknownSync(conversationAuthoritySchema)(raw);
  const lease = s.guard(input.lease);
  if (lease.projectId !== input.projectId)
    throw new AppError({
      code: 'project_mismatch',
      message: 'Authority belongs to another project',
      status: 403,
    });
  if (s.project(lease.projectId).authorityMode !== 'conversation')
    throw new AppError({
      code: 'authority_external',
      message:
        'This project requires external authority through marionette authorize. The user can change authority mode in setup.',
      status: 403,
    });
  const outcome = s.orchestration.outcome(input.outcomeId);
  s.orchestration.checkRevision(outcome, input.expectedRevision);
  if (
    !input.source.trim() ||
    input.source.length > 20000 ||
    input.scope.length === 0 ||
    input.scope.length > 100
  )
    throw new AppError({
      code: 'authority_scope',
      message: 'Record a bounded user instruction and nonempty scope',
      status: 400,
    });
  for (const path of input.scope) {
    const root = s.project(input.projectId).root;
    if (!outcome.scope.some((scope) => inside(safePath(root, scope), safePath(root, path))))
      throw new AppError({
        code: 'authority_scope',
        message: 'Authority paths exceed the current outcome scope',
        status: 403,
      });
  }
  const { lease: _lease, expectedRevision: _revision, ...grant } = input;
  return persistAuthority(
    s,
    grant,
    'lead-conversation',
    lease.owner,
    outcome.revision,
    lease.epoch,
  );
}

function persistAuthority<Input>(
  s: Service,
  raw: Input,
  origin: Authority['origin'],
  recordedBy?: string,
  outcomeRevision?: number,
  leadEpoch?: number,
) {
  const input = Schema.decodeUnknownSync(authorityInputSchema)(raw);
  const project = s.project(input.projectId);
  const outcome = s.orchestration.outcome(input.outcomeId);
  if (outcome.projectId !== project.id)
    throw new AppError({
      code: 'project_mismatch',
      message: 'Authority and outcome must belong to the same project',
      status: 409,
    });
  if (
    s
      .tasks(project.id)
      .some(
        (t) =>
          t.outcomeId === outcome.id &&
          [
            'running',
            'preparing',
            'verifying',
            'redirecting',
            'cancelling',
            'yielding',
            'uncertain',
          ].includes(t.status),
      )
  )
    throw new AppError({
      code: 'authority_busy',
      message: 'Pause and settle active outcome workers before replacing their authority',
      status: 409,
    });
  for (const path of input.scope) s.orchestration.scopePath(project.id, path);
  const grant: Authority = {
    ...input,
    id: randomUUID(),
    createdAt: now(),
    origin,
    recordedBy,
    outcomeRevision,
    leadEpoch,
  };
  s.store.transaction(() => {
    s.store.put('authority-history', grant.id, grant);
    s.store.put('authority', outcome.id, grant);
    s.store.event(
      project.id,
      'authority.granted',
      `User granted ${input.activities.join(', ') || 'inspection only'} for outcome ${outcome.id}`,
      undefined,
      { authorityId: grant.id, origin, recordedBy, outcomeRevision, leadEpoch },
    );
  });
  return grant;
}

export function taskAuthority(s: Service, task: Task) {
  const project = s.project(task.projectId);
  if (!project.coordinatorOnly) return;
  const grant = task.outcomeId ? s.store.get<Authority>('authority', task.outcomeId) : undefined;
  const activity = task.resolvedRole?.activity ?? (task.readOnly ? 'inspect' : 'implementation');
  const deny = (message: string): never => {
    throw new AppError({
      code: 'authority_required',
      message: `${message}. Record the actual user instruction with authority_record_user_request, or use marionette authorize. Intent amendments and skills cannot grant authority.`,
      status: 403,
    });
  };
  if (!task.readOnly) {
    if (activity !== 'documentation' && activity !== 'implementation')
      return deny('This role cannot write');
    if (!grant || !grant.activities.includes(activity))
      return deny(`Outcome does not authorize ${activity}`);
    for (const owned of task.ownership)
      if (
        !grant.scope.some((scope) =>
          inside(
            safePath(project.root, scope),
            safePath(task.worktree?.sourceCwd ?? task.cwd, owned),
          ),
        )
      )
        deny(`Ownership ${owned} exceeds user-authorized paths`);
  }
  if (
    task.checks.some((check) => check.type === 'command') &&
    !grant?.activities.includes('execute')
  )
    deny('Outcome does not authorize supervisor command execution');
}
