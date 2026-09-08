import { Effect, Fiber, Latch } from 'effect';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { parseUsage, type LeadWait } from '../src/continuation.js';
import type { Outcome } from '../src/orchestration-types.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { AppError, now, type HerdrPort, type Project, type Run, type Task } from '../src/types.js';

class Agents implements HerdrPort {
  agents = new Map<string, any>();
  envs = new Map<string, any>();
  panes = new Map<string, any>();
  calls: { method: string; params: any }[] = [];
  failPrompt = false;
  next = 0;
  async call(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'ping' || method === 'workspace.get') return {};
    if (method === 'pane.list') return { panes: [...this.panes.values()] };
    if (method === 'pane.layout') {
      const tab = this.panes.get(params.pane_id).tab_id;
      return {
        layout: {
          workspace_id: 'w1',
          tab_id: tab,
          panes: [...this.panes.values()]
            .filter((p) => p.tab_id === tab)
            .map((p) => ({ pane_id: p.pane_id, rect: { x: 0, y: 0, width: 180, height: 48 } })),
        },
      };
    }
    if (method === 'tab.create' || method === 'pane.split') {
      const n = ++this.next,
        pane = {
          pane_id: `w1:p${n}`,
          tab_id:
            method === 'pane.split' ? this.panes.get(params.target_pane_id).tab_id : `w1:t${n}`,
          workspace_id: 'w1',
          terminal_id: `terminal-${n}`,
        };
      this.envs.set(pane.pane_id, params.env);
      this.panes.set(pane.pane_id, { ...pane, cwd: params.cwd });
      return method === 'pane.split' ? { pane } : { root_pane: pane };
    }
    if (method === 'agent.start') {
      const n = params.pane_id.split('p')[1];
      const a = {
        pane_id: params.pane_id,
        terminal_id: `terminal-${n}`,
        workspace_id: 'w1',
        name: params.name,
        agent: params.kind,
        agent_status: 'idle',
        state_change_seq: 0,
        agent_session: { value: `native-${n}` },
      };
      this.agents.set(a.pane_id, a);
      return { agent: a };
    }
    if (method === 'agent.get') {
      const a = this.agents.get(params.target);
      if (!a)
        throw new AppError({ code: 'agent_not_found', message: 'Missing test agent', status: 400 });
      return { agent: { ...a } };
    }
    if (method === 'agent.prompt') {
      if (this.failPrompt)
        throw new AppError({
          code: 'herdr_timeout',
          message: 'Lost delivery acknowledgement',
          status: 400,
        });
      const a = this.agents.get(params.target);
      a.agent_status = 'working';
      a.state_change_seq++;
      return {};
    }
    if (method === 'agent.send_keys') {
      this.agents.get(params.target).agent_status = 'idle';
      return {};
    }
    if (method === 'pane.read') return { read: { text: 'Protocol fixture; no real agent work.' } };
    throw new Error('Unexpected protocol method ' + method);
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-outcomes-'))),
    store = new Store(join(root, 'state.sqlite'));
  const agents = new Agents(),
    service = new Service(store, () => agents),
    supervisor = new Supervisor(service, 'http://localhost:1', '/test/cli.js', 1);
  const p: Project = {
    id: 'project',
    name: 'Test',
    root,
    session: 'test',
    socketPath: join(root, 'herdr.sock'),
    workspaceId: 'w1',
    maxConcurrency: 3,
    agentArgs: {},
    createdAt: now(),
  };
  store.put('project', p.id, p);
  const lease = (
    await service.invoke('lead.acquire', {
      projectId: p.id,
      owner: 'lead',
      expectedEpoch: 0,
      reason: 'Test outcome orchestration',
    })
  ).lease;
  const invoke = (action: string, raw: any = {}) => service.invoke(action, { ...raw, lease });
  const outcome = await invoke('outcome.create', {
    outcome: {
      projectId: p.id,
      key: 'outcome',
      objective: 'Deliver the integrated result',
      scope: ['.'],
      criteria: [
        {
          id: 'correct',
          description: 'The result meets the contract',
          requiredEvidence: 'Independent tests and integrated review',
        },
      ],
    },
  });
  const submit = (title: string, extra: any = {}) =>
    invoke('task.submit', {
      assignment: {
        projectId: p.id,
        key: title,
        title,
        kind: 'codex',
        prompt: title,
        ownership: [title],
        checks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        outcomeId: outcome.id,
        expectedTreeRevision: service.orchestration.outcome(outcome.id).revision,
        ...extra,
      },
    });
  const run = (t: Task) => store.get<Run>('run', service.task(t.id).runId!)!;
  const token = (t: Task) => agents.envs.get(run(t).paneId!).MARIONETTE_WORKER_TOKEN;
  const settle = (t: Task) => {
    const a = agents.agents.get(run(t).paneId!);
    a.agent_status = 'idle';
    a.state_change_seq++;
    run(t).settledAt = Date.now() - 50;
  };
  const tick = async () => {
    supervisor.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const complete = async (t: Task) => {
    const current = service.task(t.id);
    service.report(t.id, token(t), {
      revision: current.revision,
      type: 'complete',
      summary: 'Produced tested result',
      evidence: ['Independent check pending'],
    });
    settle(t);
    for (let n = 0; n < 80 && !['completed', 'failed'].includes(service.task(t.id).status); n++)
      await tick();
    return service.task(t.id);
  };
  const done = (t: Task) =>
    service.updateTask(t, {
      status: 'completed',
      verification: [
        { check: t.checks[0], passed: true, detail: 'Fixture evidence', checkedAt: now() },
      ],
    });
  const leadAgent = () => {
    const a = {
      pane_id: 'w1:plead',
      terminal_id: 'lead-terminal',
      workspace_id: 'w1',
      name: 'root-lead',
      agent: 'claude',
      agent_status: 'idle',
      state_change_seq: 0,
      agent_session: { value: 'lead-native-session' },
    };
    agents.agents.set(a.pane_id, a);
    return {
      type: 'herdr' as const,
      paneId: a.pane_id,
      terminalId: a.terminal_id,
      name: a.name,
      kind: 'claude' as const,
      nativeSession: a.agent_session.value,
    };
  };
  const close = async () => {
    await supervisor.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    store,
    agents,
    service,
    supervisor,
    p,
    lease,
    invoke,
    outcome,
    submit,
    run,
    token,
    settle,
    tick,
    complete,
    done,
    leadAgent,
    close,
  };
}

test('outcome criteria, history and independent assessments survive restart and handover', async () => {
  const f = await fixture();
  try {
    const task = await f.submit('research');
    f.done(task);
    writeFileSync(
      join(f.root, 'evidence.md'),
      'Observed research evidence and integrated evaluation',
    );
    const revision = f.service.orchestration.outcome(f.outcome.id).revision;
    await f.invoke('outcome.assess', {
      outcomeId: f.outcome.id,
      expectedRevision: revision,
      criterionId: 'correct',
      rationale: 'Reviewed source quality and corroborating evidence',
      references: ['evidence.md'],
    });
    await assert.rejects(
      f.invoke('outcome.complete', { outcomeId: f.outcome.id, expectedRevision: revision }),
      /Integrated outcome/,
    );
    await f.invoke('outcome.integrate', {
      outcomeId: f.outcome.id,
      expectedRevision: revision,
      summary: 'The assembled result meets the objective',
      references: ['evidence.md'],
    });
    const result = await f.invoke('outcome.complete', {
      outcomeId: f.outcome.id,
      expectedRevision: revision,
    });
    assert.equal(result.outcome.status, 'completed');
    const next = await f.invoke('lead.handover', {
      toOwner: 'replacement',
      reason: 'Continue after long wait',
    });
    assert.equal(next.briefing.outcomes[0].status, 'completed');
    const reopened = new Store(f.store.path);
    assert.equal(reopened.get<Outcome>('outcome', f.outcome.id)?.criteria[0].id, 'correct');
    reopened.close();
    writeFileSync(join(f.root, 'evidence.md'), 'Changed after review');
    assert.match(
      f.service.orchestration.unmet(f.service.orchestration.outcome(f.outcome.id)).join(' '),
      /stale/,
    );
    await assert.rejects(
      f.invoke('outcome.revise', {
        outcomeId: f.outcome.id,
        expectedRevision: revision,
        criteria: [],
        reason: 'Old owner',
      }),
      /Control belongs/,
    );
  } finally {
    await f.close();
  }
});

test('recursive completion rejects failed, blocked, cancelled and unresolved descendants', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', { ownership: ['.'], canDelegate: true });
    const middle = await f.submit('middle', {
      parentId: parent.id,
      ownership: ['middle'],
      canDelegate: true,
    });
    const leaf = await f.submit('middle/leaf', { parentId: middle.id });
    f.done(parent);
    f.done(middle);
    for (const status of ['failed', 'blocked', 'cancelled', 'uncertain', 'queued'] as const) {
      f.service.updateTask(leaf, { status });
      assert.equal(f.service.orchestration.unmetTask(parent).length, 1);
      await assert.rejects(
        f.invoke('outcome.complete', {
          outcomeId: f.outcome.id,
          expectedRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        }),
        new RegExp(status),
      );
    }
    f.done(leaf);
    assert.deepEqual(f.service.orchestration.unmetTask(parent), []);
  } finally {
    await f.close();
  }
});

test('late required work reopens completed ancestors without losing sibling verification', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', { ownership: ['.'], canDelegate: true });
    const left = await f.submit('left', { parentId: parent.id });
    const right = await f.submit('right', { parentId: parent.id });
    f.done(left);
    f.done(right);
    f.done(parent);
    const before = f.service.task(right.id);
    await f.submit('repair', {
      parentId: parent.id,
      planReason: 'Review found missing error handling',
    });
    assert.equal(f.service.task(parent.id).status, 'paused');
    assert.equal(f.service.task(parent.id).verification, undefined);
    assert.deepEqual(f.service.task(right.id), before);
    assert.match(
      f.service.orchestration.board(f.p.id).revisions.at(-1)!.reason,
      /missing error handling/,
    );
  } finally {
    await f.close();
  }
});

test('revision fencing rejects stale additions, dependency cycles, and silent criterion removal', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      revision = f.service.orchestration.outcome(f.outcome.id).revision;
    const b = await f.submit('b', { dependencies: [a.id] });
    await assert.rejects(
      f.submit('stale', { expectedTreeRevision: revision }),
      /task tree changed/,
    );
    await assert.rejects(
      f.invoke('plan.revise', {
        taskId: a.id,
        expectedRevision: a.revision,
        expectedTreeRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        patch: { dependencies: [b.id] },
        reason: 'Would create a cycle',
      }),
      /acyclic/,
    );
    await assert.rejects(
      f.invoke('outcome.revise', {
        outcomeId: f.outcome.id,
        expectedRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        criteria: f.outcome.criteria,
      }),
      /[Ss]tring|Required/,
    );
    const revised = await f.invoke('outcome.revise', {
      outcomeId: f.outcome.id,
      expectedRevision: f.service.orchestration.outcome(f.outcome.id).revision,
      criteria: [
        {
          id: 'changed',
          description: 'Revised objective with observable evidence',
          requiredEvidence: 'Decision record',
        },
      ],
      reason: 'User explicitly changed scope',
    });
    assert.equal(revised.assessments.length, 0);
    assert.match(f.service.orchestration.board(f.p.id).revisions.at(-1)!.reason, /explicitly/);
  } finally {
    await f.close();
  }
});

test('superseding failed requirements requires a concrete required replacement and an audited decision', async () => {
  const f = await fixture();
  try {
    const old = await f.submit('old'),
      replacement = await f.submit('replacement');
    f.service.updateTask(old, { status: 'failed' });
    await f.invoke('plan.revise', {
      taskId: old.id,
      expectedRevision: old.revision,
      expectedTreeRevision: f.service.orchestration.outcome(f.outcome.id).revision,
      patch: { supersededBy: replacement.id, required: false },
      reason: 'Replacement covers the original acceptance contract',
      evidence: ['review finding'],
    });
    assert.equal(f.service.orchestration.required(f.service.task(old.id)), false);
    assert.match(
      f.service.orchestration.unmet(f.service.orchestration.outcome(f.outcome.id)).join(' '),
      /replacement/,
    );
  } finally {
    await f.close();
  }
});

test('managed children inherit bounded ownership and execute when a waiting parent releases the only slot', async () => {
  const f = await fixture();
  try {
    await f.invoke('limits.configure', {
      limits: { global: 1, project: 1 },
      reason: 'Test one shared execution slot',
    });
    const parent = await f.submit('parent', { ownership: ['.'], canDelegate: true });
    await f.tick();
    const originalRun = f.run(parent).id;
    const raw = {
      revision: f.service.task(parent.id).revision,
      assignment: {
        projectId: f.p.id,
        outcomeId: f.outcome.id,
        expectedTreeRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        parentId: parent.id,
        key: 'child',
        title: 'child',
        kind: 'claude',
        prompt: 'Create result',
        ownership: ['child'],
        checks: parent.checks,
      },
    };
    await assert.rejects(f.service.orchestration.delegate(parent.id, 'wrong', raw), /token/);
    const result = await f.service.orchestration.delegate(parent.id, f.token(parent), raw),
      child = result.task;
    await f.tick();
    assert.equal(f.service.task(child.id).status, 'queued');
    f.service.report(parent.id, f.token(parent), {
      revision: result.parentRevision,
      type: 'yield',
      summary: 'Delegate and yield to child',
    });
    f.settle(parent);
    await f.tick();
    await f.tick();
    await f.tick();
    assert.equal(f.service.task(parent.id).status, 'waiting');
    assert.equal(f.service.task(child.id).status, 'running');
    assert.equal((await f.complete(child)).status, 'completed');
    await f.tick();
    await f.tick();
    assert.equal(f.service.task(parent.id).status, 'running');
    assert.equal(f.run(parent).id, originalRun);
    assert.equal(f.agents.next, 2, 'Parent resumes without creating another pane');
    assert.equal(f.service.orchestration.outcome(f.outcome.id).turnsUsed, 3);
    assert.equal((await f.complete(parent)).status, 'completed');
  } finally {
    await f.close();
  }
});

test('nested delegation cannot exceed depth, scope, or shared execution budget', async () => {
  const f = await fixture();
  try {
    f.store.put('outcome', f.outcome.id, { ...f.outcome, maxDepth: 1, maxTurns: 1 });
    const parent = await f.submit('parent', { ownership: ['parent'], canDelegate: true });
    await assert.rejects(f.submit('outside', { parentId: parent.id }), /scope/);
    const child = await f.submit('parent/child', { parentId: parent.id, canDelegate: true });
    await assert.rejects(f.submit('parent/child/deep', { parentId: child.id }), /depth/);
    await f.tick();
    assert.equal(f.service.orchestration.outcome(f.outcome.id).turnsUsed, 1);
    f.service.report(parent.id, f.token(parent), {
      revision: f.service.task(parent.id).revision,
      type: 'yield',
      summary: 'Wait for child',
    });
    f.settle(parent);
    await f.tick();
    await f.tick();
    await f.tick();
    assert.equal(f.service.task(child.id).status, 'queued');
    assert.match(f.service.task(child.id).waitReason!, /budget/);
  } finally {
    await f.close();
  }
});

test('cancellation is atomic and cascades to all descendants', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', { ownership: ['.'], canDelegate: true });
    const child = await f.submit('child', { parentId: parent.id, canDelegate: true });
    const leaf = await f.submit('child/leaf', { parentId: child.id });
    await f.invoke('task.control', { taskId: parent.id, key: 'cancel-tree', type: 'cancel' });
    for (const t of [parent, child, leaf]) assert.equal(f.service.task(t.id).status, 'cancelled');
    assert.equal(f.service.orchestration.unmetTask(parent).length, 2);
  } finally {
    await f.close();
  }
});

test('completed parents require their own integration checks after all children pass', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', {
      ownership: ['.'],
      canDelegate: true,
      checks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(9)'] }],
    });
    const child = await f.submit('child', { parentId: parent.id });
    f.done(child);
    await f.tick();
    assert.equal((await f.complete(parent)).status, 'failed');
  } finally {
    await f.close();
  }
});

test('lead waits group routine results and preserve native session identity without polling model turns', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      b = await f.submit('b'),
      adapter = f.leadAgent();
    const wait = await f.invoke('lead.wait', {
      key: 'results',
      outcomeId: f.outcome.id,
      condition: { tasks: [a.id, b.id] },
      adapter,
    });
    await f.service.continuation.process(wait);
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, 0);
    f.done(a);
    f.done(b);
    f.store.event(f.p.id, 'task.completed', 'A ready', a.id);
    f.store.event(f.p.id, 'task.completed', 'B ready', b.id);
    await f.service.continuation.process(wait);
    const prepared = f.store.get<LeadWait>('lead-wait', wait.id)!;
    prepared.readyAt = 0;
    f.store.put('lead-wait', wait.id, prepared);
    await f.service.continuation.process(prepared);
    const delivered = f.store.get<LeadWait>('lead-wait', wait.id)!;
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.eventIds?.length, 3); // wait registration plus two results
    assert.match(delivered.message!, /A ready/);
    assert.match(delivered.message!, /B ready/);
    await f.service.continuation.process(delivered);
    const prompts = f.agents.calls.filter((c) => c.method === 'agent.prompt');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].params.target, adapter.paneId);
  } finally {
    await f.close();
  }
});

test('busy leads defer delivery, blocked interventions wake promptly, and desktop adapters expose next-message continuation', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      adapter = f.leadAgent();
    const wait = await f.invoke('lead.wait', {
      key: 'intervention',
      outcomeId: f.outcome.id,
      condition: { tasks: [a.id] },
      adapter,
    });
    f.store.event(f.p.id, 'question.opened', 'A consequential question', a.id);
    f.agents.agents.get(adapter.paneId).agent_status = 'working';
    await f.service.continuation.process(wait);
    assert.match(f.store.get<LeadWait>('lead-wait', wait.id)!.error!, /working/);
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, 0);
    f.agents.agents.get(adapter.paneId).agent_status = 'idle';
    await f.service.continuation.process(f.store.get<LeadWait>('lead-wait', wait.id)!);
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)!.state, 'delivered');
    await f.invoke('lead.wait-ack', { waitId: wait.id });
    const desktop = await f.invoke('lead.wait', {
      key: 'desktop',
      outcomeId: f.outcome.id,
      condition: { tasks: [a.id] },
      adapter: { type: 'next-message' },
    });
    f.done(a);
    await f.service.continuation.process(desktop);
    assert.equal(f.store.get<LeadWait>('lead-wait', desktop.id)!.state, 'ready');
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, 1);
  } finally {
    await f.close();
  }
});

test('ambiguous lead delivery survives restart without replay and stale ownership cannot resume', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      adapter = f.leadAgent();
    const wait = await f.invoke('lead.wait', {
      key: 'ambiguous',
      outcomeId: f.outcome.id,
      condition: { tasks: [a.id] },
      adapter,
    });
    f.done(a);
    f.store.put('lead-wait', wait.id, { ...wait, state: 'ready', readyAt: 0 });
    f.agents.failPrompt = true;
    await assert.rejects(
      f.service.continuation.process(f.store.get<LeadWait>('lead-wait', wait.id)!),
      /acknowledgement/,
    );
    f.service.continuation.recover();
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)!.state, 'uncertain');
    f.service.continuation.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, 1);
    await f.invoke('lead.handover', { toOwner: 'new-lead', reason: 'Recover with another lead' });
    f.service.continuation.tick();
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)!.state, 'invalidated');
  } finally {
    await f.close();
  }
});

test('checkpoints retain objectives and unresolved criteria; provider metrics keep unavailable values null', async () => {
  const f = await fixture();
  try {
    const checkpoint = await f.invoke('checkpoint.save', {
      outcomeId: f.outcome.id,
      summary: 'Resume after a long gap',
      decisions: ['Keep original scope'],
      kind: 'compaction',
    });
    assert.equal(checkpoint.objective, f.outcome.objective);
    assert.ok(checkpoint.remainingCriteria.length);
    assert.equal(
      (await f.invoke('checkpoint.get', { checkpointId: checkpoint.id })).summary,
      checkpoint.summary,
    );
    assert.deepEqual(
      parseUsage({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 10 },
      }),
      {
        cacheReadTokens: 70,
        cacheWriteTokens: null,
        uncachedInputTokens: 30,
        outputTokens: 10,
        costUsd: null,
      },
    );
    writeFileSync(
      join(f.root, 'usage.json'),
      JSON.stringify({
        type: 'result',
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
          output_tokens: 10,
        },
        total_cost_usd: 0.01,
      }),
    );
    const usage = await f.invoke('usage.import', { outcomeId: f.outcome.id, path: 'usage.json' });
    assert.equal(usage[0].uncachedInputTokens, 40);
    assert.equal(usage[0].cacheWriteTokens, 20);
    await f.invoke('usage.import', { outcomeId: f.outcome.id, path: 'usage.json' });
    assert.equal(f.store.all('usage').length, 1);
  } finally {
    await f.close();
  }
});

test('bounded councils require independent verified participants, quorum, and explicit disagreements', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      b = await f.submit('b');
    let council = await f.invoke('strategy.create', {
      expectedRevision: f.service.orchestration.outcome(f.outcome.id).revision,
      reason: 'Two independent research assessments',
      strategy: {
        outcomeId: f.outcome.id,
        kind: 'council',
        participants: [a.id, b.id],
        criteria: 'Source quality and correctness',
        stopCondition: 'Synthesize after both assessments',
        maxRounds: 1,
      },
    });
    await assert.rejects(
      f.invoke('strategy.contribute', {
        strategyId: council.id,
        expectedRevision: council.revision,
        taskId: a.id,
        claim: 'A',
        evidence: ['source A'],
      }),
      /verified/,
    );
    f.done(a);
    f.done(b);
    council = await f.invoke('strategy.contribute', {
      strategyId: council.id,
      expectedRevision: council.revision,
      taskId: a.id,
      claim: 'A',
      evidence: ['source A'],
    });
    await assert.rejects(
      f.invoke('strategy.finish', {
        strategyId: council.id,
        expectedRevision: council.revision,
        synthesis: 'A wins',
        disagreements: [],
      }),
      /quorum/,
    );
    council = await f.invoke('strategy.contribute', {
      strategyId: council.id,
      expectedRevision: council.revision,
      taskId: b.id,
      claim: 'B',
      evidence: ['source B'],
    });
    await assert.rejects(
      f.invoke('strategy.advance', { strategyId: council.id, expectedRevision: council.revision }),
      /Stop condition/,
    );
    council = await f.invoke('strategy.finish', {
      strategyId: council.id,
      expectedRevision: council.revision,
      synthesis: 'A is better supported; B remains plausible',
      disagreements: ['Participants disagree about the forecast'],
    });
    assert.equal(council.status, 'completed');
    assert.equal(council.disagreements.length, 1);
  } finally {
    await f.close();
  }
});

test('a new required child fences an in-flight parent verification result', async () => {
  const f = await fixture();
  try {
    const gate =
      "const fs=require('fs');fs.writeFileSync('verification-started','yes');const timer=setInterval(()=>{if(fs.existsSync('verification-release')){clearInterval(timer);process.exit(0)}},10);setTimeout(()=>process.exit(1),3000).unref()";
    const parent = await f.submit('parent', {
      ownership: ['.'],
      canDelegate: true,
      checks: [{ type: 'command', command: process.execPath, args: ['-e', gate] }],
    });
    await f.tick();
    f.service.report(parent.id, f.token(parent), {
      revision: f.service.task(parent.id).revision,
      type: 'complete',
      summary: 'Initial integration ready',
      evidence: ['Run independent check'],
    });
    f.settle(parent);
    const deadline = Date.now() + 2000;
    while (!existsSync(join(f.root, 'verification-started')) && Date.now() < deadline)
      await f.tick();
    assert.ok(existsSync(join(f.root, 'verification-started')));
    assert.equal(f.service.task(parent.id).status, 'verifying');
    const child = await f.submit('late-child', {
      parentId: parent.id,
      deferStart: true,
      planReason: 'Late independent finding creates a required repair',
    });
    writeFileSync(join(f.root, 'verification-release'), 'yes');
    await f.tick();
    await f.tick();
    assert.notEqual(f.service.task(parent.id).status, 'completed');
    assert.equal(f.service.task(child.id).status, 'paused');
    assert.ok(
      f.service.orchestration
        .unmet(f.service.orchestration.outcome(f.outcome.id))
        .some((x) => x.includes('late-child')),
    );
  } finally {
    await f.close();
  }
});
test('two-round debate keeps historical revisions without blocking current verified synthesis', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      b = await f.submit('b');
    let strategy = await f.invoke('strategy.create', {
      expectedRevision: f.service.orchestration.outcome(f.outcome.id).revision,
      reason: 'Bounded debate',
      strategy: {
        outcomeId: f.outcome.id,
        kind: 'debate',
        participants: [a.id, b.id],
        criteria: 'Check claims',
        stopCondition: 'Two verified rounds',
        maxRounds: 2,
      },
    });
    for (const task of [a, b]) {
      f.done(task);
      strategy = await f.invoke('strategy.contribute', {
        strategyId: strategy.id,
        expectedRevision: strategy.revision,
        taskId: task.id,
        claim: 'Independent claim',
        evidence: ['Initial analysis'],
      });
    }
    strategy = await f.invoke('strategy.advance', {
      strategyId: strategy.id,
      expectedRevision: strategy.revision,
    });
    await assert.rejects(
      f.invoke('strategy.contribute', {
        strategyId: strategy.id,
        expectedRevision: strategy.revision,
        taskId: a.id,
        claim: 'Recycled claim',
        evidence: ['Old analysis'],
      }),
      /fresh/,
    );
    for (const task of [a, b]) {
      const updated = await f.invoke('plan.revise', {
        taskId: task.id,
        expectedRevision: f.service.task(task.id).revision,
        expectedTreeRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        reason: 'Evaluate opposing evidence',
        patch: { prompt: 'Fresh rebuttal' },
      });
      f.done(updated);
      strategy = await f.invoke('strategy.contribute', {
        strategyId: strategy.id,
        expectedRevision: strategy.revision,
        taskId: task.id,
        claim: 'Revised position',
        rebuttal: 'Concession and objection',
        evidence: ['Fresh analysis'],
      });
    }
    strategy = await f.invoke('strategy.finish', {
      strategyId: strategy.id,
      expectedRevision: strategy.revision,
      synthesis: 'Bounded experiment',
      disagreements: ['Confidence threshold'],
    });
    assert.equal(strategy.entries.length, 4);
    assert.equal(strategy.status, 'completed');
    assert.ok(
      !f.service.orchestration
        .unmet(f.service.orchestration.outcome(f.outcome.id))
        .some((x) => /strategy|participant/i.test(x)),
    );
  } finally {
    await f.close();
  }
});
test('startup shell readiness is retried but post-launch registration never duplicates an agent', async () => {
  const f = await fixture();
  try {
    const original = f.agents.call.bind(f.agents);
    let starts = 0,
      reads = 0;
    f.agents.call = async (method, params = {}) => {
      if (method === 'agent.start') {
        starts++;
        if (starts === 1)
          throw new AppError({
            code: 'invalid_state',
            message: 'agent target pane w1:p1 is not an available shell',
            status: 400,
          });
        await original(method, params);
        throw new AppError({
          code: 'agent_not_ready',
          message: 'Agent launched but registration pending',
          status: 400,
        });
      }
      if (method === 'agent.get' && reads++ === 0)
        throw new AppError({
          code: 'agent_not_found',
          message: 'Registration pending',
          status: 400,
        });
      return original(method, params);
    };
    const t = await f.submit('readiness');
    for (let n = 0; n < 100 && f.service.task(t.id).status !== 'running'; n++) await f.tick();
    assert.equal(f.service.task(t.id).status, 'running');
    assert.equal(starts, 2);
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, 1);
  } finally {
    await f.close();
  }
});

test('invalid Codex argument combinations fail before creating a worker', async () => {
  const f = await fixture();
  try {
    f.store.put('project', f.p.id, {
      ...f.p,
      agentArgs: { codex: ['--approve-for-me', '--sandbox', 'workspace-write'] },
    });
    const task = await f.submit('arguments');
    await f.tick();
    assert.equal(f.service.task(task.id).status, 'failed');
    assert.match(f.service.task(task.id).error!, /already selects its sandbox/);
    assert.equal(f.agents.calls.filter((c) => c.method === 'tab.create').length, 0);
  } finally {
    await f.close();
  }
});

test('native blocked scrollback falls back to visible output and permits explicit control', async () => {
  const f = await fixture();
  try {
    const task = await f.submit('approval');
    await f.tick();
    const original = f.agents.call.bind(f.agents);
    f.agents.call = async (method, params = {}) => {
      if (method === 'pane.read' && params.source === 'recent_unwrapped')
        throw new AppError({
          code: 'agent_not_idle',
          message: 'Scrollback unavailable while blocked',
          status: 400,
        });
      return original(method, params);
    };
    f.agents.agents.get(f.run(task).paneId!).agent_status = 'blocked';
    await f.tick();
    assert.equal(f.service.task(task.id).blockKind, 'native');
    await f.invoke('task.control', {
      taskId: task.id,
      expectedRevision: 1,
      key: 'approval-key',
      type: 'keys',
      keys: ['enter'],
    });
    await f.tick();
    assert.ok(f.agents.calls.some((c) => c.method === 'agent.send_keys'));
  } finally {
    await f.close();
  }
});

test('changed verified artifacts reopen the task, ancestors and outcome without invalidating unrelated work', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', { canDelegate: true, ownership: ['.'] });
    const child = await f.submit('child', {
      parentId: parent.id,
      ownership: ['child.txt'],
      checks: [{ type: 'file', path: 'child.txt', allowUnchanged: true }],
    });
    const other = await f.submit('other');
    writeFileSync(join(f.root, 'child.txt'), 'accepted');
    const { digest } = await import('../src/files.js');
    f.service.updateTask(child, {
      status: 'completed',
      verification: [
        {
          check: child.checks[0],
          passed: true,
          detail: 'Verified',
          digest: digest(join(f.root, 'child.txt'))!,
          checkedAt: now(),
        },
      ],
    });
    f.done(f.service.task(parent.id));
    f.done(other);
    const previous = f.service.orchestration.outcome(f.outcome.id).revision;
    writeFileSync(join(f.root, 'child.txt'), 'changed after verification');
    assert.match(
      f.service.orchestration.unmet(f.service.orchestration.outcome(f.outcome.id)).join('\n'),
      /stale completion evidence/,
    );
    f.service.orchestration.refreshEvidence();
    assert.equal(f.service.task(child.id).status, 'paused');
    assert.equal(f.service.task(parent.id).status, 'paused');
    assert.equal(f.service.task(other.id).status, 'completed');
    assert.equal(f.service.orchestration.outcome(f.outcome.id).revision, previous + 1);
  } finally {
    await f.close();
  }
});

test('native Claude usage imports deduplicate repeated message blocks and growing transcript snapshots', async () => {
  const f = await fixture();
  try {
    const item = (id: string) => ({
      type: 'assistant',
      sessionId: 'native',
      message: {
        id,
        model: 'claude-fable-5',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 100,
          output_tokens: 20,
        },
      },
    });
    const file = join(f.root, 'usage.jsonl');
    writeFileSync(file, [item('one'), item('one')].map((v) => JSON.stringify(v)).join('\n'));
    await f.invoke('usage.import', { outcomeId: f.outcome.id, path: 'usage.jsonl' });
    assert.equal(f.store.all('usage').length, 1);
    writeFileSync(
      file,
      [item('one'), item('one'), item('two')].map((v) => JSON.stringify(v)).join('\n'),
    );
    await f.invoke('usage.import', { outcomeId: f.outcome.id, path: 'usage.jsonl' });
    assert.equal(f.store.all('usage').length, 2);
    assert.equal(
      f.store.all<any>('usage').reduce((sum, u) => sum + u.cacheReadTokens, 0),
      200,
    );
    assert.ok(f.store.all<any>('usage').every((u) => u.costUsd === null));
  } finally {
    await f.close();
  }
});

test('a settled parent monitor cannot overwrite a concurrently queued child-result continuation', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent-race', { canDelegate: true, ownership: ['.'] });
    await f.tick();
    const child = await f.submit('child-race', { parentId: parent.id });
    f.done(child);
    f.service.updateTask(parent, { status: 'waiting', waitForChildren: [child.id] });
    const run = f.run(parent);
    run.seenWork = true;
    run.settledAt = Date.now() - 20000;
    f.store.put('run', run.id, run);
    f.agents.agents.get(run.paneId!).agent_status = 'idle';
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.agents.call.bind(f.agents);
    let held = false;
    f.agents.call = async (method, params = {}) => {
      if (method === 'pane.read' && params.pane_id === run.paneId && !held) {
        held = true;
        await barrier;
      }
      return original(method, params);
    };
    f.supervisor.tick();
    assert.equal(f.service.task(parent.id).status, 'queued');
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.service.task(parent.id).status, 'queued');
    await f.tick();
    assert.equal(f.service.task(parent.id).status, 'running');
    assert.equal(f.run(parent).id, run.id);
    assert.equal(
      f.agents.calls.filter((c) => c.method === 'agent.prompt' && c.params.target === run.paneId)
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

test('global, provider and model limits include other projects and lead reservations', async () => {
  const f = await fixture();
  try {
    const first = await f.submit('capacity');
    f.service.updateTask(first, { status: 'running', model: 'exact-a' });
    f.store.put('project', 'other', { ...f.p, id: 'other' });
    const candidate = {
      ...first,
      id: 'candidate',
      projectId: 'other',
      kind: 'codex' as const,
      model: 'exact-a',
      outcomeId: undefined,
    };
    await f.invoke('limits.configure', {
      limits: { global: 4, project: 3, providers: { codex: 1 } },
      reason: 'Shared provider cap',
    });
    assert.match(
      f.service.orchestration.capacity(candidate, () => true)!,
      /provider/,
    );
    await f.invoke('limits.configure', {
      limits: { global: 4, project: 3, providers: { codex: 4 }, models: { 'exact-a': 1 } },
      reason: 'Shared exact-model cap',
    });
    assert.match(
      f.service.orchestration.capacity(candidate, () => true)!,
      /model/,
    );
    assert.equal(
      f.service.orchestration.capacity({ ...candidate, model: 'exact-b' }, () => true),
      undefined,
    );
    const wait = await f.invoke('lead.wait', {
      key: 'capacity-lead',
      outcomeId: f.outcome.id,
      condition: { tasks: [first.id] },
      adapter: f.leadAgent(),
    });
    f.store.put('lead-wait', wait.id, {
      ...wait,
      reservation: true,
      state: 'delivered',
      model: 'exact-b',
    });
    await f.invoke('limits.configure', {
      limits: { global: 2, project: 3 },
      reason: 'Include running lead turns',
    });
    assert.match(
      f.service.orchestration.capacity({ ...candidate, model: 'exact-b' }, () => true)!,
      /Global/,
    );
  } finally {
    await f.close();
  }
});

test('profile discovery preserves exact choices and defaults; availability cannot be forged', async () => {
  const f = await fixture();
  try {
    const raw = {
      id: 'chosen',
      name: 'Explicit choice',
      kind: 'codex',
      model: 'exact-a',
      reasoning: 'high',
      supportedReasoning: ['high'],
      categories: ['implementation'],
      strengths: 'User choice',
      availability: 'available',
      canDelegate: true,
    };
    await f.invoke('profile.configure', {
      profiles: [raw],
      defaults: { implementation: 'chosen' },
    });
    assert.equal(f.service.orchestration.profiles(f.p.id)[0].availability, 'unverified');
    f.service.orchestration.probeProfile = () =>
      Effect.succeed({
        output: 'Native probe fixture',
        evidence: 'Controlled availability response',
      });
    await f.invoke('profile.validate', { profileId: 'chosen' });
    f.service.orchestration.discoverModels = () =>
      Effect.succeed({
        kind: 'codex',
        source: 'fixture catalog',
        fetchedAt: now(),
        models: [
          {
            model: 'exact-a',
            name: 'Catalog A',
            description: 'A',
            reasoning: ['low'],
            capabilities: [],
          },
          {
            model: 'exact-b',
            name: 'Catalog B',
            description: 'B',
            reasoning: ['low'],
            defaultReasoning: 'low',
            capabilities: ['tools'],
          },
        ],
      });
    const discovered = await f.invoke('profile.discover', { kind: 'codex' });
    assert.equal(discovered.added.length, 1);
    const chosen = f.service.orchestration.profiles(f.p.id).find((p) => p.id === 'chosen')!;
    assert.equal(chosen.model, 'exact-a');
    assert.equal(chosen.reasoning, 'high');
    assert.equal(chosen.availability, 'available');
    assert.equal(f.service.orchestration.board(f.p.id).profileDefaults.implementation, 'chosen');
    await assert.rejects(
      f.submit('wrong-model', { profileId: 'chosen', model: 'exact-b' }),
      /Explicit model differs/,
    );
    const task = await f.submit('configured', { profileId: 'chosen' });
    await f.tick();
    assert.equal(f.run(task).resolvedModel, 'exact-a');
    assert.ok(f.run(task).resolvedArgs!.includes('exact-a'));
    await f.invoke('profile.configure', {
      profiles: [{ ...raw, model: 'exact-b' }],
      defaults: { implementation: 'chosen' },
    });
    assert.equal(f.run(task).resolvedModel, 'exact-a');
    assert.equal(f.service.task(task.id).resolvedProfile!.model, 'exact-a');
  } finally {
    await f.close();
  }
});

test('legacy adoption preserves existing lease, native run, receipt and verification across restart', async () => {
  const f = await fixture();
  try {
    const t = await f.submit('legacy');
    await f.tick();
    await f.complete(t);
    const saved = f.service.task(t.id),
      run = f.run(t),
      lead = f.store.get('lead', f.p.id);
    f.store.put('task', t.id, { ...saved, outcomeId: undefined });
    const restarted = new Service(f.store, () => f.agents);
    const adopted = restarted.task(t.id);
    assert.deepEqual(adopted.receipt, saved.receipt);
    assert.deepEqual(adopted.verification, saved.verification);
    assert.equal(adopted.runId, run.id);
    assert.equal(adopted.status, saved.status);
    assert.deepEqual(f.store.get('lead', f.p.id), lead);
    assert.deepEqual(f.store.get('run', run.id), run);
    assert.equal(restarted.guard(f.lease).owner, f.lease.owner);
    assert.ok(adopted.outcomeId?.startsWith('legacy-'));
    new Service(f.store, () => f.agents);
    assert.equal(f.store.all<any>('outcome').filter((o) => o.id === adopted.outcomeId).length, 1);
  } finally {
    await f.close();
  }
});

test('acknowledged prompts with no observed native activity become uncertain without replay', async () => {
  const f = await fixture();
  try {
    const original = f.agents.call.bind(f.agents);
    let prompts = 0;
    f.agents.call = async (method, params = {}) => {
      if (method === 'agent.prompt') {
        prompts++;
        return {};
      }
      return original(method, params);
    };
    const task = await f.submit('silent-native');
    await f.tick();
    const r = f.run(task);
    r.settledAt = Date.now() - 40000;
    f.store.put('run', r.id, r);
    await f.tick();
    assert.equal(f.service.task(task.id).status, 'uncertain');
    for (let n = 0; n < 3; n++) await f.tick();
    assert.equal(prompts, 1);
  } finally {
    await f.close();
  }
});

test('interrupting a held lead prompt persists uncertainty immediately and never replays', async () => {
  const f = await fixture();
  const entered = Latch.makeUnsafe();
  const release = Latch.makeUnsafe();
  let prompts = 0;
  const original = f.agents.call.bind(f.agents);
  f.agents.call = async (method, params = {}) => {
    if (method === 'agent.prompt') {
      prompts++;
      entered.openUnsafe();
      await Effect.runPromise(release.await);
      return {};
    }
    return original(method, params);
  };
  try {
    const task = await f.submit('interrupted-lead');
    const wait = await f.invoke('lead.wait', {
      key: 'interrupted',
      outcomeId: f.outcome.id,
      condition: { tasks: [task.id] },
      adapter: f.leadAgent(),
    });
    f.done(task);
    f.store.put('lead-wait', wait.id, { ...wait, state: 'ready', readyAt: 0 });
    const delivery = Effect.runFork(
      f.service.continuation.processEffect(f.store.get<LeadWait>('lead-wait', wait.id)!),
    );
    await Effect.runPromise(entered.await);
    await Effect.runPromise(Fiber.interrupt(delivery));
    const current = f.store.get<LeadWait>('lead-wait', wait.id)!;
    assert.equal(current.state, 'uncertain');
    assert.match(current.error!, /No automatic replay/);
    await f.service.continuation.process(current);
    assert.equal(prompts, 1);
  } finally {
    release.openUnsafe();
    await f.close();
  }
});
