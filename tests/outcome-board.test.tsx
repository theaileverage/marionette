import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutcomeBoard, type OutcomeBoardData } from '../web/outcome-board';

const task = (id: string, status: string, required = true) => ({
  id,
  title: id,
  status,
  required,
  kind: 'codex',
  revision: 1,
  outcomeId: 'outcome',
  dependencies: [],
  ownership: [],
  receipt: {
    summary: `RESULT ${'long evidence '.repeat(2000)} END OF REPORT`,
    evidence: [],
    artifacts: [],
  },
});
const fixture = (): OutcomeBoardData => ({
  tasks: [
    task('blocked-required', 'cancelled'),
    task('cancelled-optional', 'cancelled', false),
    task('verified-task', 'completed'),
    task('active-task', 'running'),
  ],
  outcomes: [
    {
      id: 'outcome',
      projectId: 'project',
      objective: 'Deliver the repair',
      scope: ['app'],
      category: 'software',
      criteria: [
        {
          id: 'criterion',
          description: 'Hidden criterion detail',
          requiredEvidence: 'Runtime proof',
        },
      ],
      maxTurns: 60,
      maxDepth: 3,
      leadOwner: 'lead',
      revision: 1,
      status: 'open',
      turnsUsed: 2,
      createdAt: '',
      updatedAt: '',
      assessments: [],
      unmet: ['Required cancellation must be resolved'],
    },
  ],
  revisions: [],
  findings: [],
  profiles: [],
  limits: { global: 8, project: 3, providers: {}, models: {} },
  strategies: [],
  waits: [],
  checkpoints: [],
  coordination: { turns: 0, usage: [], metricBoundary: 'Hidden capacity detail' },
});
const render = (data: OutcomeBoardData) =>
  renderToStaticMarkup(
    <OutcomeBoard
      data={data}
      projectId="project"
      canEdit={false}
      pending={false}
      onTask={() => {}}
      onAddTask={() => {}}
      onAction={async () => undefined}
    />,
  );

test('board keeps blockers visible while reports and history remain unmounted', () => {
  const html = render(fixture());
  expect(html).toContain('blocked-required');
  expect(html).toContain('1 completion blockers');
  expect(html).toContain('Outcome details and blockers');
  expect(html).not.toContain('Required cancellation must be resolved');
  expect(html).toContain('active-task');
  expect(html).not.toContain('cancelled-optional');
  expect(html).not.toContain('verified-task');
  expect(html).not.toContain('END OF REPORT');
  expect(html).not.toContain('Hidden criterion detail');
  expect(html).not.toContain('Hidden capacity detail');
  expect(html.length).toBeLessThan(7000);
});

test('cancelled tasks in a completed outcome are history', () => {
  const data = fixture();
  data.outcomes[0]!.status = 'completed';
  data.outcomes[0]!.unmet = [];
  const html = render(data);
  expect(html).not.toContain('blocked-required');
  expect(html).toContain('Cancelled history · 2');
});

test('current work precedes long outcome details', () => {
  const data = fixture();
  data.outcomes[0]!.objective = `Repair ${'long request '.repeat(1000)} END OF OBJECTIVE`;
  const html = render(data);
  expect(html).not.toContain('END OF OBJECTIVE');
  expect(html.indexOf('blocked-required')).toBeLessThan(
    html.indexOf('Outcome details and blockers'),
  );
  expect(html).toContain('Open task details and evidence');
  expect(html).toContain('Findings and plan revisions');
  expect(html.length).toBeLessThan(7000);
});
