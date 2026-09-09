import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Effect, Schema } from 'effect';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './swarm-fixture.js';
import { Store } from '../src/store.js';
import { SwarmRuntime } from '../src/swarm-runtime.js';
import { swarmRequestSchema, type Intent, type Watch } from '../src/swarm-types.js';
import { swarmTools } from '../src/swarm-tools.js';
import { checkSchema, type Assignment, type Task } from '../src/types.js';
import type { LeadWait } from '../src/continuation.js';

const revision = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.service.orchestration.outcome(f.outcome.id).revision;
const entry = (key: string, extra: Partial<Assignment> = {}) => ({
  assignment: {
    projectId: 'project',
    key,
    title: key,
    kind: 'codex',
    prompt: key,
    ownership: [key],
    checks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    ...extra,
  },
});

test('batch dispatch is atomic, topological and idempotent without launching in the transaction', async () => {
  const f = await fixture();
  try {
    const input = {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      key: 'batch',
      entries: [{ ...entry('consumer'), dependsOn: ['producer'] }, entry('producer')],
    };
    const result = await f.invoke('swarm.dispatch', input);
    assert.equal(result.tasks.length, 2);
    assert.deepEqual(result.tasks[1].dependencies, [result.tasks[0].id]);
    assert.deepEqual(await f.invoke('swarm.dispatch', input), JSON.parse(JSON.stringify(result)));
    assert.equal(f.agents.calls.length, 0);
    const before = revision(f);
    await assert.rejects(
      f.invoke('swarm.dispatch', {
        ...input,
        key: 'cycle',
        expectedRevision: before,
        entries: [entry('rolled-back'), { ...entry('cycle'), dependsOn: ['missing'] }],
      }),
      /cycle or unknown/,
    );
    assert.equal(f.service.tasks(f.p.id).length, 2);
    assert.equal(revision(f), before);
    await assert.rejects(
      f.invoke('swarm.dispatch', { ...input, entries: [entry('different')] }),
      /key|Idempotency/,
    );
  } finally {
    await f.close();
  }
});

test('intent steering is scoped, preserved across reopening, and acknowledged only by its recipient', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a'),
      b = await f.submit('b');
    const other = await f.invoke('outcome.create', {
      outcome: {
        projectId: f.p.id,
        key: 'other',
        objective: 'Another objective',
        scope: ['.'],
        criteria: [{ id: 'ok', description: 'Done', requiredEvidence: 'Tests' }],
      },
    });
    const c = await f.submit('c', { outcomeId: other.id, expectedTreeRevision: other.revision });
    await f.tick();
    const correction = {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      key: 'navigation',
      text: 'Keep existing navigation',
      source: 'user request',
      objective: 'Corrected objective',
      taskIds: [a.id],
    };
    const result = await f.invoke('swarm.intent.amend', correction);
    assert.equal(result.intent.original, f.outcome.objective);
    assert.equal(f.service.task(b.id).revision, b.revision);
    assert.equal(f.service.task(c.id).revision, c.revision);
    assert.deepEqual(await f.invoke('swarm.intent.amend', correction), result);
    const reopened = new Store(f.store.path);
    assert.equal(
      reopened.get<Intent>('swarm-intent', f.outcome.id)?.amendments[0].source,
      'user request',
    );
    reopened.close();
    const messageId = result.messages[0].id;
    await assert.rejects(
      f.service.orchestration.workerAction(b.id, f.token(b), {
        action: 'message.ack',
        revision: b.revision,
        messageId,
      }),
      /recipient/,
    );
    assert.throws(
      () =>
        f.service.report(a.id, f.token(a), {
          type: 'complete',
          revision: f.service.task(a.id).revision,
          summary: 'Done',
          evidence: ['test'],
        }),
      /acknowledged/,
    );
    const acknowledged = await f.service.orchestration.workerAction(a.id, f.token(a), {
      action: 'message.ack',
      revision: f.service.task(a.id).revision,
      messageId,
    });
    assert.equal(acknowledged.acknowledgedRunId, f.run(a).id);
    assert.equal(f.service.swarm.unmetTask(f.service.task(a.id)).length, 0);
    const stale = revision(f);
    await assert.rejects(
      f.invoke('swarm.intent.amend', {
        ...correction,
        key: 'foreign',
        expectedRevision: stale,
        taskIds: [c.id],
      }),
      /objective/,
    );
    assert.equal(revision(f), stale);
    assert.equal(f.service.swarm.intent(f.outcome.id).version, 2);
  } finally {
    await f.close();
  }
});

test('keyed decisions remain open through progress and require explicit versioned resolution', async () => {
  const f = await fixture();
  try {
    const t = await f.submit('a');
    await f.tick();
    const d = await f.invoke('swarm.decision.open', {
      outcomeId: f.outcome.id,
      key: 'choice',
      text: 'Which source is authoritative?',
      source: 'lead',
      options: ['Primary', 'Secondary'],
      taskId: t.id,
    });
    f.service.report(t.id, f.token(t), {
      revision: t.revision,
      type: 'progress',
      summary: 'Still investigating',
    });
    assert.match(f.service.swarm.unmet(f.outcome.id).join(), /Which source/);
    await assert.rejects(
      f.invoke('swarm.decision.resolve', {
        decisionId: d.id,
        expectedRevision: 2,
        resolution: 'answered',
        answer: 'Primary',
        source: 'user',
      }),
      /revision/,
    );
    await f.invoke('swarm.decision.resolve', {
      decisionId: d.id,
      expectedRevision: 1,
      resolution: 'answered',
      answer: 'Primary',
      source: 'user',
    });
    assert.deepEqual(f.service.swarm.unmet(f.outcome.id), []);
  } finally {
    await f.close();
  }
});

test('partial ownership lets a coordinator and child execute together while preserving disjoint writes', async () => {
  const f = await fixture();
  try {
    const parent = await f.submit('parent', { ownership: ['.'], canDelegate: true });
    const child = await f.submit('child', { parentId: parent.id });
    const current = f.service.task(parent.id);
    await assert.rejects(
      f.invoke('swarm.ownership.transfer', {
        taskId: parent.id,
        expectedRevision: current.revision,
        childIds: [child.id],
        retainedOwnership: ['.'],
        reason: 'Continue parent work',
      }),
      /overlap/,
    );
    await f.invoke('swarm.ownership.transfer', {
      taskId: parent.id,
      expectedRevision: current.revision,
      childIds: [child.id],
      retainedOwnership: ['parent'],
      reason: 'Continue disjoint work',
    });
    await f.tick();
    await f.tick();
    assert.equal(f.service.task(parent.id).status, 'running');
    assert.equal(f.service.task(child.id).status, 'running');
    assert.deepEqual(f.service.swarm.context(f.service.task(parent.id)).writablePaths, ['parent']);
    writeFileSync(join(f.root, 'child'), 'child evidence');
    assert.throws(
      () =>
        f.service.report(parent.id, f.token(parent), {
          type: 'progress',
          revision: f.service.task(parent.id).revision,
          summary: 'Claiming child file',
          artifacts: ['child'],
        }),
      /belong to this assignment/,
    );
  } finally {
    await f.close();
  }
});

test('adaptive capacity responds to pressure, provider feedback and explicit limits; fixed remains default', async () => {
  const f = await fixture();
  let host = { cpus: 4, freeMb: 8192, load: 0 };
  const runtime = new SwarmRuntime(f.service, () => host);
  try {
    assert.equal(runtime.capacitySnapshot(f.p.id).mode, 'fixed');
    runtime.configure(
      {
        action: 'capacity.configure',
        policy: { mode: 'adaptive', maxConcurrency: 3, memoryPerWorkerMb: 512 },
        reason: 'Opt in',
      },
      f.lease,
    );
    assert.equal(runtime.capacitySnapshot(f.p.id).target, 3);
    runtime.configure(
      {
        action: 'capacity.feedback',
        provider: 'codex',
        retryAfterMs: 1000,
        evidence: '429 retry-after observed',
      },
      f.lease,
    );
    assert.match(runtime.capacityBlock(f.p.id, 'codex', undefined, [])!, /cooling/);
    assert.equal(runtime.capacityBlock(f.p.id, 'claude', undefined, []), undefined);
    host = { ...host, load: 20 };
    assert.equal(runtime.capacitySnapshot(f.p.id, true).target, 1);
    assert.match(
      runtime.capacityBlock(f.p.id, 'claude', undefined, [{ projectId: f.p.id }])!,
      /capacity/,
    );
  } finally {
    await Effect.runPromise(runtime.close());
    await f.close();
  }
});

test('external conditions persist pending, ready and failed results, including late wait registration', async () => {
  const f = await fixture();
  try {
    const create = (key: string, condition: Schema.Codec.Encoded<typeof checkSchema>) =>
      f.invoke('swarm.watch.create', {
        outcomeId: f.outcome.id,
        key,
        description: key,
        condition,
        intervalMs: 1000,
      });
    const file = await create('file', { type: 'file', path: 'ready.txt', contains: 'ready' });
    await Effect.runPromise(f.service.swarm.runtime.checkWatch(file));
    assert.equal(f.store.get<Watch>('swarm-watch', file.id)?.state, 'waiting');
    writeFileSync(join(f.root, 'ready.txt'), 'ready');
    await Effect.runPromise(
      f.service.swarm.runtime.checkWatch(f.store.get<Watch>('swarm-watch', file.id)!),
    );
    const result = f.store.get<Watch>('swarm-watch', file.id)!;
    assert.equal(result.state, 'ready');
    const wait = await f.invoke('lead.wait', {
      outcomeId: f.outcome.id,
      key: 'late',
      condition: { watchIds: [file.id] },
      adapter: { type: 'next-message' },
    });
    await f.service.continuation.process(wait);
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)?.state, 'ready');
    await assert.rejects(
      f.invoke('swarm.watch.ack', { watchId: file.id, resultId: 'wrong' }),
      /exact/,
    );
    await f.invoke('swarm.watch.ack', { watchId: file.id, resultId: result.result!.id });
    for (const [code, expected] of [
      [0, 'ready'],
      [1, 'waiting'],
      [2, 'failed'],
    ] as const) {
      const w = await create(`exit-${code}`, {
        type: 'command',
        command: process.execPath,
        args: ['-e', `process.exit(${code})`],
      });
      await Effect.runPromise(f.service.swarm.runtime.checkWatch(w));
      assert.equal(f.store.get<Watch>('swarm-watch', w.id)?.state, expected);
    }
    const interrupted = await create('recovery', { type: 'file', path: 'later' });
    f.store.put('swarm-watch', interrupted.id, { ...interrupted, state: 'checking' });
    f.service.swarm.runtime.recover();
    assert.equal(f.store.get<Watch>('swarm-watch', interrupted.id)?.state, 'waiting');
  } finally {
    await f.close();
  }
});

test('experiment candidates pin one Git commit and common checks; selection requires evidence and preserves alternatives', async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: f.root, stdio: 'pipe' }).toString().trim();
    git('init');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    );
    const base = git('rev-parse', 'HEAD');
    const checks = [
      { type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ];
    const input = {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      key: 'hypotheses',
      criteria: 'Same reproduction and counterfactual',
      checks,
      entries: [entry('a'), entry('b')],
    };
    const result = await f.invoke('swarm.experiment.create', input);
    for (const t of result.tasks) {
      assert.equal(t.execution.baseRef, base);
      assert.equal(t.checks[0].command, process.execPath);
      assert.deepEqual(t.checks[0].args, ['-e', 'process.exit(0)']);
    }
    const [a, b] = result.tasks;
    writeFileSync(
      join(f.root, 'comparison.md'),
      'A passes common check and preserves required behavior',
    );
    const select = () =>
      f.invoke('swarm.experiment.select', {
        experimentId: result.experiment.id,
        expectedRevision: revision(f),
        taskId: a.id,
        rationale: 'Evidence favors A',
        references: ['comparison.md'],
      });
    await assert.rejects(select(), /verified/);
    for (
      let n = 0;
      n < 80 && result.tasks.some((t: Task) => f.service.task(t.id).status !== 'running');
      n++
    )
      await f.tick();
    assert.notEqual(f.service.task(a.id).cwd, f.service.task(b.id).cwd);
    for (const t of [a, b]) {
      assert.equal(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.service.task(t.id).cwd })
          .toString()
          .trim(),
        base,
      );
      assert.equal((await f.complete(t)).status, 'completed');
    }
    const chosen = await select();
    assert.equal(chosen.selectionCurrent, true);
    assert.equal(f.service.task(b.id).required, false);
    assert.equal(f.service.task(a.id).required, true);
    assert.equal(f.service.tasks(f.p.id).length, 2);
    writeFileSync(join(f.root, 'comparison.md'), 'Changed comparison');
    assert.equal(f.service.swarm.compare(result.experiment.id).selectionCurrent, false);
  } finally {
    await f.close();
  }
});

test('trajectories redact worker credentials and evaluations require current integrated evidence', async () => {
  const f = await fixture();
  try {
    const t = await f.submit('a');
    await f.tick();
    writeFileSync(join(f.root, 'evidence.md'), 'Independent evaluation');
    const input = () => ({
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      key: 'trial',
      scenario: 'simple',
      strategy: 'single',
      success: true,
      regressions: 0,
      interventions: 0,
      references: ['evidence.md'],
      notes: 'Local fixture assessment',
    });
    await assert.rejects(f.invoke('swarm.evaluation.record', input()), /integrated/);
    const trajectory = f.service.swarm.trajectory(f.outcome.id);
    assert.equal(JSON.stringify(trajectory).includes(f.run(t).tokenHash), false);
    assert.equal(trajectory.tasks[0].prompt, 'a');
    f.done(f.service.task(t.id));
    await f.invoke('outcome.assess', {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      criterionId: 'correct',
      rationale: 'Checked',
      references: ['evidence.md'],
    });
    await f.invoke('outcome.integrate', {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      summary: 'Integrated',
      references: ['evidence.md'],
    });
    await f.invoke('outcome.complete', { outcomeId: f.outcome.id, expectedRevision: revision(f) });
    const evaluation = await f.invoke('swarm.evaluation.record', input());
    assert.equal(evaluation.evaluator, 'lead');
    assert.ok(evaluation.elapsedMs >= 0);
    writeFileSync(join(f.root, 'evidence.md'), 'Evidence changed');
    await assert.rejects(
      f.invoke('swarm.evaluation.record', { ...input(), key: 'stale' }),
      /integrated/,
    );
  } finally {
    await f.close();
  }
});

test('transport inputs decode through the authoritative schema and recipes load from packaged sources', async () => {
  const f = await fixture();
  try {
    const input = {
      outcomeId: f.outcome.id,
      key: 'batch',
      expectedRevision: revision(f),
      entries: [entry('a')],
    };
    const transport = swarmTools.find((t) => t.action === 'dispatch')!.schema.parse(input);
    assert.equal(
      Schema.decodeUnknownSync(swarmRequestSchema)({ ...transport, action: 'dispatch' }).action,
      'dispatch',
    );
    const recipe = await f.invoke('swarm.recipe.get', { name: 'diagnose' });
    assert.ok(recipe.trigger.length > 0);
    assert.match(recipe.instructions, /counterfactual/i);
  } finally {
    await f.close();
  }
});

test('an unrelated outcome cannot wake an intervention wait and resolved decisions survive late registration', async () => {
  const f = await fixture();
  try {
    const other = await f.invoke('outcome.create', {
      outcome: {
        projectId: f.p.id,
        key: 'unrelated',
        objective: 'Unrelated objective',
        scope: ['.'],
        criteria: [{ id: 'ok', description: 'Done', requiredEvidence: 'Evidence' }],
      },
    });
    const wait = await f.invoke('lead.wait', {
      outcomeId: f.outcome.id,
      key: 'scoped',
      condition: { intervention: true },
      adapter: { type: 'next-message' },
    });
    await f.invoke('swarm.decision.open', {
      outcomeId: other.id,
      key: 'foreign-decision',
      text: 'Other objective choice',
      source: 'lead',
      options: [],
    });
    await f.service.continuation.process(wait);
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)?.state, 'waiting');
    const d = await f.invoke('swarm.decision.open', {
      outcomeId: f.outcome.id,
      key: 'local-decision',
      text: 'Our choice',
      source: 'lead',
      options: [],
    });
    await f.service.continuation.process(f.store.get<LeadWait>('lead-wait', wait.id)!);
    assert.equal(f.store.get<LeadWait>('lead-wait', wait.id)?.state, 'ready');
    await f.invoke('lead.wait-ack', { waitId: wait.id });
    await f.invoke('swarm.decision.resolve', {
      decisionId: d.id,
      expectedRevision: 1,
      resolution: 'withdrawn',
      answer: 'No longer needed',
      source: 'user',
    });
    const late = await f.invoke('lead.wait', {
      outcomeId: f.outcome.id,
      key: 'decision-late',
      condition: { decisionIds: [d.id], intervention: false },
      adapter: { type: 'next-message' },
    });
    await f.service.continuation.process(late);
    assert.equal(f.store.get<LeadWait>('lead-wait', late.id)?.state, 'ready');
  } finally {
    await f.close();
  }
});

test('watch timeouts fail durably and cancellation prevents a completed probe from overwriting it', async () => {
  const f = await fixture();
  try {
    const w = await f.invoke('swarm.watch.create', {
      outcomeId: f.outcome.id,
      key: 'timeout',
      description: 'Bounded slow query',
      intervalMs: 1000,
      condition: {
        type: 'command',
        command: process.execPath,
        args: ['-e', 'setTimeout(()=>{},60000)'],
        timeoutMs: 100,
      },
    });
    await Effect.runPromise(f.service.swarm.runtime.checkWatch(w));
    assert.equal(f.store.get<Watch>('swarm-watch', w.id)?.state, 'failed');
    assert.match(f.store.get<Watch>('swarm-watch', w.id)?.result?.detail ?? '', /timeout/);
    const cancelled = await f.invoke('swarm.watch.create', {
      outcomeId: f.outcome.id,
      key: 'cancelled',
      description: 'Retired query',
      intervalMs: 1000,
      condition: {
        type: 'command',
        command: process.execPath,
        args: ['-e', 'setTimeout(()=>process.exit(0),100)'],
        timeoutMs: 2000,
      },
    });
    const inFlight = Effect.runPromise(f.service.swarm.runtime.checkWatch(cancelled));
    assert.equal(f.store.get<Watch>('swarm-watch', cancelled.id)?.state, 'checking');
    await f.invoke('swarm.watch.cancel', {
      watchId: cancelled.id,
      reason: 'User withdrew the dependency',
    });
    await inFlight;
    assert.equal(f.store.get<Watch>('swarm-watch', cancelled.id)?.state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('notification delivery counts shared turns, preserves the inbox and is bounded after missing acknowledgements', async () => {
  const f = await fixture();
  try {
    const t = await f.submit('a');
    await f.tick();
    await f.invoke('swarm.message.send', {
      outcomeId: f.outcome.id,
      key: 'steer',
      taskIds: [t.id],
      text: 'Inspect a current correction',
    });
    f.settle(t);
    const before = f.service.orchestration.outcome(f.outcome.id).turnsUsed;
    await f.tick();
    assert.equal(f.service.orchestration.outcome(f.outcome.id).turnsUsed, before + 1);
    const calls = f.agents.calls.filter((c) => c.method === 'agent.prompt').length;
    const doorbell = f.store.get<any>('swarm-doorbell', t.id)!;
    f.store.put('swarm-doorbell', t.id, { ...doorbell, attempts: 3, lastAt: 0 });
    f.settle(t);
    await f.tick();
    assert.equal(f.agents.calls.filter((c) => c.method === 'agent.prompt').length, calls);
    assert.equal(f.service.swarm.unmetTask(f.service.task(t.id)).length, 1);
    assert.ok(f.store.events(f.p.id).some((e) => e.type === 'swarm.attention'));
  } finally {
    await f.close();
  }
});

test('intent stays original after plan revisions, and new coordination reads survive handover', async () => {
  const f = await fixture();
  try {
    await f.invoke('outcome.revise', {
      outcomeId: f.outcome.id,
      expectedRevision: revision(f),
      maxTurns: 120,
      reason: 'Refine the plan',
    });
    assert.equal(f.service.swarm.intent(f.outcome.id).original, f.outcome.objective);
    assert.equal(f.service.orchestration.outcome(f.outcome.id).maxTurns, 120);
    const attributed = await f.invoke('outcome.create', {
      outcome: {
        projectId: f.p.id,
        key: 'attributed',
        objective: 'Lead summary',
        originalRequest: 'User exact wording',
        requestSource: 'user-message-42',
        scope: ['.'],
        criteria: [{ id: 'done', description: 'Complete', requiredEvidence: 'Proof' }],
      },
    });
    assert.equal(f.service.swarm.intent(attributed.id).original, 'User exact wording');
    assert.equal(f.service.swarm.intent(attributed.id).originalSource, 'user-message-42');
    const d = await f.invoke('swarm.decision.open', {
      outcomeId: f.outcome.id,
      key: 'handover',
      text: 'Still pending',
      source: 'lead',
      options: [],
    });
    const next = await f.invoke('lead.handover', {
      toOwner: 'next',
      reason: 'Preserve pending decisions',
    });
    assert.equal(next.briefing.swarm.openDecisions[0].id, d.id);
    await assert.rejects(
      f.invoke('swarm.decision.resolve', {
        decisionId: d.id,
        expectedRevision: 1,
        resolution: 'answered',
        answer: 'Unauthorized old owner',
        source: 'old',
      }),
      /another lead/,
    );
  } finally {
    await f.close();
  }
});
