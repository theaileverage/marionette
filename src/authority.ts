import { Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { inside, safePath } from './files.js';
import type { Service } from './service.js';
import { AppError, now, type Task } from './types.js';

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
  origin: 'user-cli';
}

/** Called only through the instance-owner endpoint, never exposed through lead/worker MCP. */
export function grantAuthority<Input>(s: Service, raw: Input) {
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
  const grant: Authority = { ...input, id: randomUUID(), createdAt: now(), origin: 'user-cli' };
  s.store.transaction(() => {
    s.store.put('authority-history', grant.id, grant);
    s.store.put('authority', outcome.id, grant);
    s.store.event(
      project.id,
      'authority.granted',
      `User granted ${input.activities.join(', ') || 'inspection only'} for outcome ${outcome.id}`,
      undefined,
      { authorityId: grant.id },
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
      message: `${message}. User authority must be recorded through marionette authorize; intent amendments and skills cannot grant it.`,
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
