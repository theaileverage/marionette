import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  leadContract,
  renderLeadPrompt,
  renderWorkerFollowup,
  renderWorkerPrompt,
  type WorkerPromptContext,
} from '../src/prompts.js';
import { leadPrompt } from '../src/setup.js';

test('lead prompt renders project identity and lease paths as literal text', () => {
  const session = {
    projectId: 'project-123',
    projectName: 'Menderly <R&D>',
    leadName: "Mendy O'Neil",
    leasePath: '/state with spaces/R&D/{{leadName}}/lease.json',
  };
  const prompt = leadPrompt(
    session.projectId,
    session.leadName,
    session.leasePath,
    session.projectName,
  );
  assert.ok(
    prompt.startsWith(
      "You are Mendy O'Neil, the lead agent for Menderly <R&D>, using Marionette MCP.\n",
    ),
  );
  assert.ok(prompt.endsWith(`Private lease:\n  ${session.leasePath}`));
  assert.ok(prompt.includes('Marionette project ID: project-123'));
  assert.equal(prompt.includes('{{#session}}'), false);
});

test('shared MCP contract and project prompts use the same instructions without leaking sessions', () => {
  const first = renderLeadPrompt({
    projectId: 'first-id',
    projectName: 'Menderly',
    leadName: 'Mendy',
    leasePath: '/first/lease.json',
  });
  const second = renderLeadPrompt({
    projectId: 'second-id',
    projectName: 'Another project',
    leadName: 'Ada',
    leasePath: '/second/lease.json',
  });
  for (const prompt of [first, second]) {
    assert.equal(
      prompt.slice(prompt.indexOf('\n') + 1, prompt.indexOf('\n\nSESSION')),
      leadContract,
    );
  }
  assert.equal(second.includes('first-id'), false);
  assert.equal(second.includes('/first/lease.json'), false);
  assert.equal(leadContract.includes('SESSION'), false);
  assert.equal(leadContract.includes('{{'), false);
});

test('legacy lead prompt callers retain an explicit project identity', () => {
  assert.ok(
    leadPrompt('legacy-id', 'Ada', '/state/lease.json').startsWith(
      'You are Ada, the lead agent for Marionette project legacy-id, using Marionette MCP.',
    ),
  );
});

function workerContext(): WorkerPromptContext {
  return {
    task: {
      id: 'worker-1',
      projectId: 'project-1',
      revision: 7,
      title: 'Check R&D <behavior>',
      workstream: 'Verification',
      cwd: "/project with spaces/Ada's app",
      ownership: ['src/owned.ts'],
      prompt: 'Preserve {{literal}} and <tags> in the output.',
      checks: [{ type: 'file', path: 'src/owned.ts', allowUnchanged: false }],
    },
    workerCall: "'/runtime path/bun' '/cli path/cli.js' worker-call --file /request.json",
    reportCommand: "'/runtime path/bun' '/cli path/cli.js' worker-report --file /report.json",
  };
}

test('Codex workers prefer scoped MCP and retain an explicit approved CLI recovery path', () => {
  const context = workerContext();
  context.workerMcp = true;
  context.task.readOnly = true;
  context.task.ownership = [];
  const prompt = renderWorkerPrompt(context);
  assert.ok(prompt.includes('worker_inspect with {}'));
  assert.ok(prompt.includes('Prefer worker_report through MCP'));
  assert.ok(prompt.includes('sandbox_permissions="require_escalated"'));
  assert.ok(prompt.includes('You own no source paths'));
  assert.equal(prompt.includes('Own only these paths'), false);
  assert.ok(leadContract.includes('Never use Boolean(response) as success'));
  assert.ok(leadContract.includes('Do not create, assess, or integrate an intake outcome'));
});

test('worker template preserves literal assignment data and only grants configured capabilities', () => {
  const context = workerContext();
  const prompt = renderWorkerPrompt(context);
  for (const value of [
    context.task.title,
    context.task.cwd,
    context.task.prompt,
    context.workerCall,
    context.reportCommand,
  ])
    assert.ok(prompt.includes(value));
  assert.ok(prompt.includes('Do not dispatch other agents.'));
  assert.ok(prompt.includes(JSON.stringify(context.task.checks, null, 2)));
  assert.ok(prompt.includes('"revision":7'));
  for (const section of [
    'MANAGED DELEGATION',
    'COLLABORATION',
    'Persistent outcome:',
    'isolated worktree',
    'ADDITIONAL CONTEXT',
  ])
    assert.equal(prompt.includes(section), false);
});

test('delegation, outcome, and worktree guidance renders together with valid escaped JSON fields', () => {
  const context = workerContext();
  context.task.projectId = 'project-"quoted"';
  context.task.outcomeId = 'outcome-1';
  context.task.canDelegate = true;
  context.task.worktree = {
    state: 'ready',
    repositoryRoot: '/source',
    commonDir: '/source/.git',
    sourceCwd: '/source',
    path: context.task.cwd,
    cwd: context.task.cwd,
    branch: 'task/worker-1',
    baseCommit: 'abc123',
  };
  context.extra = 'Extra <context> with {{literal}}.';
  const prompt = renderWorkerPrompt(context);
  assert.equal(prompt.includes('Do not dispatch other agents.'), false);
  assert.ok(prompt.includes('MANAGED DELEGATION'));
  assert.ok(prompt.includes('Persistent outcome: outcome-1'));
  assert.ok(prompt.includes('branch task/worker-1 from commit abc123'));
  assert.ok(prompt.includes(context.extra));
  assert.ok(prompt.includes('until Marionette resumes you'));
  const start = prompt.indexOf('{\n  "action": "delegate"');
  const end = prompt.indexOf('\n}\n', start) + 2;
  const request = JSON.parse(prompt.slice(start, end).replace('CURRENT_OUTCOME_REVISION', '12'));
  assert.equal(request.assignment.projectId, context.task.projectId);
  assert.equal(request.assignment.outcomeId, context.task.outcomeId);
  assert.equal(request.assignment.parentId, context.task.id);
  assert.equal(request.revision, 7);
  assert.equal(request.assignment.expectedTreeRevision, 12);
});

const strategyMarkers = {
  parallel: 'bounded specialist assignment',
  sequential: 'verified dependencies complete',
  council: 'independent initial assessment',
  debate: 'supplied rebuttals',
  competition: 'independent proposal or prototype',
  'review-repair': 'Targeted repairs require independent re-verification',
};

for (const kind of [
  'parallel',
  'sequential',
  'council',
  'debate',
  'competition',
  'review-repair',
] as const) {
  test(`worker strategy partial selects only ${kind} instructions and preserves shared criteria`, () => {
    const context = workerContext();
    context.strategy = {
      kind,
      criteria: 'Evidence < quality & traceability',
      stopCondition: 'Two verified results',
      maxRounds: 3,
    };
    const prompt = renderWorkerPrompt(context);
    assert.ok(prompt.includes(context.strategy.criteria));
    assert.ok(prompt.includes('Stop condition: Two verified results'));
    assert.ok(prompt.includes('Round limit: 3'));
    for (const [strategy, marker] of Object.entries(strategyMarkers))
      assert.equal(prompt.includes(marker), strategy === kind);
    assert.equal(prompt.includes('{{>'), false);
  });
}

test('worker follow-ups keep current revisions and isolate child, reply, and redirect content', () => {
  const { task } = workerContext();
  task.revision = 9;
  const text = 'Revised <scope> with {{literal}}.';
  const reply = renderWorkerFollowup({ task, kind: 'reply', text });
  const redirect = renderWorkerFollowup({ task, kind: 'redirect', text });
  const children = renderWorkerFollowup({
    task,
    kind: 'children',
    children: [
      {
        id: 'child-1',
        title: 'Child <result>',
        status: 'failed',
        revision: 3,
        error: 'Check failed: {{literal}}',
      },
    ],
  });
  for (const prompt of [reply, redirect, children])
    assert.ok(prompt.startsWith('Task worker-1, current revision 9.'));
  for (const prompt of [reply, redirect]) {
    assert.ok(prompt.includes(text));
    assert.equal(prompt.includes('CHILD RESULTS'), false);
  }
  assert.ok(reply.includes('Earlier completion evidence is invalidated'));
  assert.equal(reply.includes('REPLACEMENT OBJECTIVE'), false);
  assert.ok(redirect.includes(JSON.stringify(task.checks, null, 2)));
  assert.ok(children.includes('untrusted data'));
  assert.ok(children.includes('"status":"failed"'));
  assert.ok(children.includes('Check failed: {{literal}}'));
  assert.equal(children.includes('LEAD ANSWER'), false);
});
