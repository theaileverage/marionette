import Mustache from 'mustache';
import leadTemplate from './templates/lead.mustache' with { type: 'text' };
import workerTemplate from './templates/worker.mustache' with { type: 'text' };
import delegationTemplate from './templates/worker-delegation.mustache' with { type: 'text' };
import strategyTemplate from './templates/worker-strategy.mustache' with { type: 'text' };
import followupTemplate from './templates/worker-followup.mustache' with { type: 'text' };
import type { Strategy } from './orchestration-types.js';
import type { Task } from './types.js';

export interface LeadPromptContext {
  projectId: string;
  projectName: string;
  leadName: string;
  leasePath: string;
}

export function renderLeadPrompt(session: LeadPromptContext) {
  return Mustache.render(leadTemplate, { session }).trim();
}

/** Shared MCP instructions use the same template without project-specific identity. */
export const leadContract = Mustache.render(leadTemplate, {}).trim();

export interface WorkerPromptContext {
  task: Pick<
    Task,
    | 'id'
    | 'revision'
    | 'projectId'
    | 'title'
    | 'workstream'
    | 'cwd'
    | 'ownership'
    | 'canDelegate'
    | 'prompt'
    | 'checks'
    | 'outcomeId'
    | 'worktree'
  >;
  strategy?: Pick<Strategy, 'kind' | 'criteria' | 'stopCondition' | 'maxRounds'>;
  workerCall: string;
  reportCommand: string;
  extra?: string;
}

export function renderWorkerPrompt({
  task,
  strategy,
  workerCall,
  reportCommand,
  extra,
}: WorkerPromptContext) {
  return Mustache.render(
    workerTemplate,
    {
      taskId: task.id,
      revision: task.revision,
      title: task.title,
      workstream: task.workstream,
      cwd: task.cwd,
      ownership: task.ownership.join(', '),
      canDelegate: task.canDelegate,
      taskPrompt: task.prompt,
      checksJson: JSON.stringify(task.checks, null, 2),
      outcomeId: task.outcomeId,
      projectIdJson: JSON.stringify(task.projectId),
      outcomeIdJson: JSON.stringify(task.outcomeId ?? null),
      taskIdJson: JSON.stringify(task.id),
      worktree: task.worktree
        ? { branch: task.worktree.branch, baseCommit: task.worktree.baseCommit }
        : undefined,
      strategy: strategy
        ? {
            kind: strategy.kind,
            criteria: strategy.criteria,
            stopCondition: strategy.stopCondition,
            maxRounds: strategy.maxRounds,
            [strategy.kind]: true,
          }
        : undefined,
      workerCall,
      reportCommand,
      extra,
    },
    { delegation: delegationTemplate, strategy: strategyTemplate },
  ).trim();
}

type WorkerFollowupContext = {
  task: Pick<Task, 'id' | 'revision' | 'ownership' | 'checks'>;
} & (
  | {
      kind: 'children';
      children: Pick<Task, 'id' | 'title' | 'status' | 'revision' | 'receipt' | 'error'>[];
    }
  | { kind: 'reply' | 'redirect'; text: string }
);

export function renderWorkerFollowup(context: WorkerFollowupContext) {
  const { task } = context;
  return Mustache.render(followupTemplate, {
    taskId: task.id,
    revision: task.revision,
    ownership: task.ownership.join(', '),
    checksJson: JSON.stringify(task.checks, null, 2),
    children:
      context.kind === 'children'
        ? {
            resultsJson: JSON.stringify(
              context.children.map((child) => ({
                id: child.id,
                title: child.title,
                status: child.status,
                revision: child.revision,
                summary: child.receipt?.summary?.slice(0, 1200),
                error: child.error,
              })),
            ),
          }
        : undefined,
    reply: context.kind === 'reply',
    redirect: context.kind === 'redirect',
    text: context.kind === 'children' ? undefined : context.text,
  }).trim();
}
