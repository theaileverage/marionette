import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Supervisor } from '../src/supervisor.js';
import { Cleanup, type Archive } from '../src/cleanup.js';
import { AppError, now, type Task, type Run, type HerdrPort, type Project } from '../src/types.js';
import { hash, digest } from '../src/files.js';
import { planWorktree, createWorktree } from '../src/worktrees.js';
import type { Outcome } from '../src/orchestration-types.js';

// Deterministic Herdr protocol fixture; no user terminals or paid agents.
class Terminal implements HerdrPort {
  closed = false;
  closeCalls = 0;
  paneCount = 1;
  nativeSession = 'native';
  status = 'idle';
  loseAcknowledgement = false;
  closeBeforeLoss = false;
  beforeFinalRead?: () => void;
  reads = 0;
  async call(method: string): Promise<any> {
    if (method === 'tab.get') {
      if (this.closed) throw new AppError('tab_not_found', 'absent');
      return { tab: { tab_id: 'w1:t1', workspace_id: 'w1', pane_count: this.paneCount } };
    }
    if (method === 'pane.list')
      return {
        panes: this.closed
          ? []
          : [{ tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term', workspace_id: 'w1' }],
      };
    if (method === 'agent.get') {
      if (++this.reads === 2) this.beforeFinalRead?.();
      return {
        agent: {
          pane_id: 'w1:p1',
          terminal_id: 'term',
          workspace_id: 'w1',
          name: 'worker',
          agent: 'codex',
          agent_status: this.status,
          agent_session: { value: this.nativeSession },
        },
      };
    }
    if (method === 'pane.read') return { read: { text: 'Saved diagnostics: acceptance passed' } };
    if (method === 'tab.close') {
      this.closeCalls++;
      if (this.closeBeforeLoss || !this.loseAcknowledgement) this.closed = true;
      if (this.loseAcknowledgement) throw new AppError('herdr_timeout', 'acknowledgement lost');
      return {};
    }
    throw new Error('Unexpected protocol method ' + method);
  }
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-cleanup-'))),
    repo = join(root, 'repo'),
    state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(state);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  g(['init', '-b', 'main']);
  g(['config', 'user.name', 'Cleanup fixture']);
  g(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repo, 'result.txt'), 'verified\n');
  g(['add', '.']);
  g(['commit', '-m', 'fixture']);
  const store = new Store(join(state, 'state.sqlite')),
    h = new Terminal(),
    s = new Service(store, () => h);
  const p: Project = {
    id: 'project',
    name: 'Fixture',
    root: repo,
    session: 'fixture',
    socketPath: join(root, 'fixture.sock'),
    workspaceId: 'w1',
    maxConcurrency: 3,
    agentArgs: {},
    createdAt: now(),
  };
  store.put('project', p.id, p);
  store.put('lead', p.id, {
    projectId: p.id,
    owner: 'lead',
    epoch: 1,
    tokenHash: hash('secret'),
    changedAt: now(),
    reason: 'fixture',
  });
  const lease = { projectId: p.id, owner: 'lead', epoch: 1, token: 'secret' };
  const t: Task = {
    id: 'task',
    projectId: p.id,
    outcomeId: 'outcome',
    title: 'Fixture',
    workstream: 'Test',
    kind: 'codex',
    prompt: 'Verify',
    cwd: repo,
    ownership: ['.'],
    dependencies: [],
    checks: [{ type: 'file', path: 'result.txt', allowUnchanged: true }],
    maxAttempts: 3,
    status: 'completed',
    revision: 1,
    attempt: 1,
    createdAt: now(),
    updatedAt: now(),
    leadOwner: 'lead',
    runId: 'run',
    output: 'output',
    receipt: {
      revision: 1,
      summary: 'Done',
      artifacts: ['result.txt'],
      evidence: ['checked'],
      receivedAt: now(),
    },
    verification: [
      {
        check: { type: 'file', path: 'result.txt', allowUnchanged: true },
        passed: true,
        detail: 'pass',
        checkedAt: now(),
        digest: digest(join(repo, 'result.txt'))!,
      },
    ],
  };
  const r: Run = {
    id: 'run',
    taskId: t.id,
    attempt: 1,
    revision: 1,
    agentName: 'worker',
    kind: 'codex',
    tokenHash: hash('worker-secret'),
    phase: 'stopped',
    paneId: 'w1:p1',
    tabId: 'w1:t1',
    terminalId: 'term',
    nativeSession: 'native',
    startedAt: now(),
    seenWork: true,
    baseline: {},
  };
  store.put('task', t.id, t);
  store.put('run', r.id, r);
  const ref = { path: 'task:task:result.txt', digest: digest(join(repo, 'result.txt'))! };
  const o: Outcome = {
    id: 'outcome',
    projectId: p.id,
    objective: 'Verified outcome',
    scope: ['.'],
    category: 'software',
    criteria: [{ id: 'correct', description: 'Correct', requiredEvidence: 'file' }],
    maxTurns: 60,
    maxDepth: 3,
    leadOwner: 'lead',
    revision: 1,
    status: 'completed',
    turnsUsed: 1,
    createdAt: now(),
    updatedAt: now(),
    assessments: [
      {
        criterionId: 'correct',
        rationale: 'checked',
        references: [ref],
        revision: 1,
        owner: 'lead',
        createdAt: now(),
      },
    ],
    integrated: {
      revision: 1,
      summary: 'Reviewed',
      evidence: [ref],
      owner: 'lead',
      createdAt: now(),
    },
  };
  store.put('outcome', o.id, o);
  const invoke = (action: string, input: any = {}) =>
    s.invoke(action, {
      taskId: t.id,
      lease,
      reason: 'Reviewed and authorized in fixture',
      ...input,
    });
  const worktree = async () => {
    const plan = await planWorktree({ ...t, execution: { mode: 'worktree' } }, state);
    const cwd = await createWorktree(plan);
    s.updateTask(t, {
      cwd,
      execution: { mode: 'worktree' },
      worktree: { ...plan, state: 'ready' },
    });
    return cwd;
  };
  const archived = async () => {
    await worktree();
    await invoke('cleanup.release');
    await invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    return invoke('cleanup.archive') as Promise<Archive>;
  };
  return {
    root,
    repo,
    state,
    store,
    s,
    h,
    t,
    r,
    o,
    lease,
    g,
    invoke,
    worktree,
    archived,
    async close() {
      await s.cleanup.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('automatic release waits for integrated completion and preserves Git resources', async () => {
  const f = fixture();
  try {
    const cwd = await f.worktree();
    f.store.put('outcome', f.o.id, { ...f.o, status: 'open' });
    f.s.cleanup.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.h.closeCalls, 0);
    f.store.put('outcome', f.o.id, f.o);
    f.s.cleanup = new Cleanup(f.s);
    f.s.cleanup.tick();
    await f.s.cleanup.stop();
    assert.equal(f.h.closeCalls, 1);
    assert.ok(existsSync(cwd));
    assert.ok(f.g(['branch', '--list', 'marionette/task']).includes('marionette/task'));
    assert.match(f.store.get<Run>('run', f.r.id)!.cleanup!.output!, /Saved diagnostics/);
  } finally {
    await f.close();
  }
});

test('failed, cancelled, waiting, paused, blocked and uncertain tasks are retained automatically', async () => {
  for (const status of [
    'failed',
    'cancelled',
    'waiting',
    'paused',
    'blocked',
    'uncertain',
  ] as const) {
    const f = fixture();
    try {
      f.s.updateTask(f.t, { status });
      f.s.cleanup.tick();
      await f.s.cleanup.stop();
      assert.equal(f.h.closeCalls, 0, status);
    } finally {
      await f.close();
    }
  }
});

test('explicit release preserves failed work and refuses live consumers', async () => {
  const f = fixture();
  try {
    f.s.updateTask(f.t, { status: 'failed' });
    f.store.put('task', 'consumer', {
      ...f.t,
      id: 'consumer',
      runId: undefined,
      status: 'queued',
      dependencies: [f.t.id],
    });
    await assert.rejects(f.invoke('cleanup.release'), /consumes/);
    f.store.put('task', 'consumer', {
      ...f.t,
      id: 'consumer',
      runId: undefined,
      status: 'cancelled',
      dependencies: [f.t.id],
    });
    await f.invoke('cleanup.release');
    assert.ok(existsSync(join(f.repo, 'result.txt')));
  } finally {
    await f.close();
  }
});

test('closure refuses split tabs, replaced native sessions, busy agents and lost lead ownership', async () => {
  for (const change of ['split', 'identity', 'busy', 'lease']) {
    const f = fixture();
    try {
      if (change === 'split') f.h.paneCount = 2;
      if (change === 'identity') f.h.nativeSession = 'replacement';
      if (change === 'busy') f.h.status = 'working';
      if (change === 'lease')
        f.h.beforeFinalRead = () => f.store.put('lead', 'project', { owner: 'new', epoch: 2 });
      await assert.rejects(f.invoke('cleanup.release'));
      assert.equal(f.h.closeCalls, 0, change);
    } finally {
      await f.close();
    }
  }
});

test('lost close acknowledgement is durable and never automatically replayed', async () => {
  const f = fixture();
  try {
    f.h.loseAcknowledgement = true;
    await assert.rejects(f.invoke('cleanup.release'), /acknowledgement/);
    assert.equal(f.store.get<Run>('run', f.r.id)!.cleanup!.state, 'uncertain');
    f.s.cleanup = new Cleanup(f.s);
    f.s.cleanup.recover();
    f.s.cleanup.tick();
    assert.equal(f.h.closeCalls, 1);
    await assert.rejects(f.invoke('cleanup.release'), /Reconcile/);
    await assert.rejects(f.invoke('cleanup.reconcile', { resolution: 'closed' }), /still present/);
    await f.invoke('cleanup.reconcile', { resolution: 'not-closed' });
    f.h.loseAcknowledgement = false;
    await f.invoke('cleanup.release');
    assert.equal(f.h.closeCalls, 2);
  } finally {
    await f.close();
  }
});

test('restart during closure can reconcile an absent original tab without replay', async () => {
  const f = fixture();
  try {
    f.store.put('run', f.r.id, {
      ...f.r,
      cleanup: { state: 'closing', reason: 'test', updatedAt: now(), output: 'saved' },
    });
    f.h.closed = true;
    f.s.cleanup.recover();
    await f.invoke('cleanup.reconcile', { resolution: 'closed' });
    assert.equal(f.h.closeCalls, 0);
    assert.equal(f.store.get<Run>('run', f.r.id)!.cleanup!.state, 'closed');
  } finally {
    await f.close();
  }
});

test('archive and collection preserve current task and outcome evidence across database restart', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    assert.equal(f.s.orchestration.unmet(f.o).length, 0);
    const result = await f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true });
    assert.equal(result.phase, 'collected');
    assert.equal(result.branchDeleted, true);
    assert.equal(existsSync(a.worktree.path), false);
    assert.equal(f.g(['branch', '--list', 'marionette/task']), '');
    f.s.orchestration.refreshEvidence();
    assert.equal(f.s.task(f.t.id).status, 'completed');
    assert.equal(f.s.orchestration.outcome(f.o.id).status, 'completed');
    const reopened = new Store(join(f.state, 'state.sqlite'));
    try {
      const service = new Service(reopened, () => f.h);
      assert.equal(service.orchestration.unmet(service.orchestration.outcome(f.o.id)).length, 0);
      assert.match(
        readFileSync(service.orchestration.evidencePath('project', 'task:task:result.txt'), 'utf8'),
        /verified/,
      );
    } finally {
      reopened.close();
    }
    const manifest = readFileSync(join(f.state, 'archives', a.id, 'manifest.json'), 'utf8');
    assert.ok(!manifest.includes(hash('worker-secret')));
    assert.match(
      f.g(['bundle', 'list-heads', join(f.state, 'archives', a.id, 'commits.bundle')]),
      /marionette\/task/,
    );
    await assert.rejects(
      f.invoke('plan.revise', {
        expectedRevision: 1,
        expectedTreeRevision: 1,
        patch: { title: 'Again' },
      }),
      /archived/,
    );
  } finally {
    await f.close();
  }
});

test('dirty, untracked and ignored work refuse delivery without deleting files', async () => {
  for (const kind of ['dirty', 'untracked', 'ignored']) {
    const f = fixture();
    try {
      const cwd = await f.worktree();
      if (kind === 'dirty') writeFileSync(join(cwd, 'result.txt'), 'changed');
      else {
        if (kind === 'ignored')
          writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'private.txt\n');
        writeFileSync(join(cwd, 'private.txt'), 'keep');
      }
      await assert.rejects(
        f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' }),
        /modified, untracked, or ignored/,
      );
      assert.ok(existsSync(cwd));
    } finally {
      await f.close();
    }
  }
});

test('unmerged commits cannot claim merged delivery; published branches survive collection', async () => {
  const f = fixture();
  try {
    const cwd = await f.worktree();
    writeFileSync(join(cwd, 'extra.txt'), 'new');
    f.g(['add', '.'], cwd);
    f.g(['commit', '-m', 'unique'], cwd);
    await f.invoke('cleanup.release');
    await assert.rejects(
      f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' }),
    );
    const tip = f.g(['rev-parse', 'HEAD'], cwd);
    f.g(['update-ref', 'refs/remotes/origin/review', tip]);
    await f.invoke('cleanup.deliver', {
      disposition: 'published',
      targetRef: 'refs/remotes/origin/review',
    });
    const a = await f.invoke('cleanup.archive');
    await assert.rejects(
      f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true }),
      /retained until merged/,
    );
    await f.invoke('cleanup.collect', { archiveId: a.id });
    assert.ok(f.g(['branch', '--list', 'marionette/task']));
  } finally {
    await f.close();
  }
});

test('changed evidence after archival blocks collection instead of masking stale acceptance', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    writeFileSync(join(a.worktree.cwd, 'result.txt'), 'changed');
    await assert.rejects(
      f.invoke('cleanup.collect', { archiveId: a.id }),
      /no longer current|modified/,
    );
    assert.ok(existsSync(a.worktree.path));
    f.s.orchestration.refreshEvidence();
    assert.equal(f.s.task(f.t.id).status, 'paused');
  } finally {
    await f.close();
  }
});

test('archive tampering blocks removal and invalidates evidence after removal', async () => {
  const f = fixture();
  try {
    const a = await f.archived(),
      file = join(f.state, 'archives', a.id, 'files', a.files[0].digest),
      original = readFileSync(file);
    writeFileSync(file, 'corrupt');
    await assert.rejects(f.invoke('cleanup.collect', { archiveId: a.id }), /integrity/);
    assert.ok(existsSync(a.worktree.path));
    writeFileSync(file, original);
    await f.invoke('cleanup.collect', { archiveId: a.id });
    writeFileSync(file, 'corrupt');
    f.s.orchestration.refreshEvidence();
    assert.equal(f.s.task(f.t.id).status, 'paused');
    assert.equal(f.s.orchestration.outcome(f.o.id).status, 'open');
  } finally {
    await f.close();
  }
});

test('all child tasks sharing a checkout must finish and release before archival', async () => {
  const f = fixture();
  try {
    const cwd = await f.worktree();
    await f.invoke('cleanup.release');
    f.store.put('task', 'child', {
      ...f.s.task(f.t.id),
      id: 'child',
      parentId: f.t.id,
      status: 'waiting',
      runId: undefined,
      cwd,
    });
    await f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    await assert.rejects(f.invoke('cleanup.archive'), /child is waiting/);
    f.s.updateTask(f.s.task('child'), { status: 'completed' });
    const a = await f.invoke('cleanup.archive');
    assert.deepEqual(a.taskIds.sort(), ['child', 'task']);
    assert.equal(f.s.task('child').archiveId, a.id);
  } finally {
    await f.close();
  }
});

test('partial worktree removal resumes by inspecting Git without repeating tab closure', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    f.store.put('archive', a.id, { ...a, phase: 'removing' });
    f.g(['worktree', 'remove', '--', a.worktree.path]);
    f.s.cleanup = new Cleanup(f.s);
    f.s.cleanup.recover();
    f.s.orchestration.refreshEvidence();
    assert.equal(f.s.task(f.t.id).status, 'completed');
    await f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true });
    assert.equal(f.h.closeCalls, 1);
  } finally {
    await f.close();
  }
});

test('revising a released, unarchived result schedules a new worker instead of reusing the closed pane', async () => {
  const f = fixture();
  try {
    await f.invoke('cleanup.release');
    const result = await f.invoke('plan.revise', {
      expectedRevision: 1,
      expectedTreeRevision: 1,
      patch: { title: 'Further work' },
    });
    assert.equal(result.status, 'queued');
    assert.equal(result.runId, undefined);
  } finally {
    await f.close();
  }
});

test('explicit retention policy is required for automatic collection', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    f.s.cleanup.tick();
    await f.s.cleanup.stop();
    assert.ok(existsSync(a.worktree.path));
    f.s.cleanup = new Cleanup(f.s);
    await f.invoke('cleanup.configure', {
      policy: { autoRelease: true, collectAfterHours: 0, deleteMergedBranches: false },
    });
    f.s.cleanup.tick();
    await f.s.cleanup.stop();
    assert.equal(existsSync(a.worktree.path), false);
    assert.ok(f.g(['branch', '--list', 'marionette/task']));
  } finally {
    await f.close();
  }
});

test('registered checkout consumers and archived-task retries are refused', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    f.store.put('project', 'other', {
      ...f.s.project('project'),
      id: 'other',
      root: a.worktree.cwd,
    });
    await assert.rejects(f.invoke('cleanup.collect', { archiveId: a.id }), /Registered project/);
    await assert.rejects(f.invoke('task.retry', { key: 'retry' }), /archived/);
    assert.ok(existsSync(a.worktree.path));
  } finally {
    await f.close();
  }
});

test('published branch can be recorded as merged and collected after its worktree was removed', async () => {
  const f = fixture();
  try {
    await f.worktree();
    await f.invoke('cleanup.release');
    const head = f.g(['rev-parse', 'HEAD']);
    f.g(['update-ref', 'refs/remotes/origin/review', head]);
    await f.invoke('cleanup.deliver', {
      disposition: 'published',
      targetRef: 'refs/remotes/origin/review',
    });
    const a = await f.invoke('cleanup.archive');
    await f.invoke('cleanup.collect', { archiveId: a.id });
    await f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    await f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true });
    assert.equal(f.g(['branch', '--list', 'marionette/task']), '');
    assert.equal(f.s.orchestration.unmet(f.o).length, 0);
  } finally {
    await f.close();
  }
});

test('explicit abandonment preserves unique commits in a bundle before deleting the exact branch', async () => {
  const f = fixture();
  try {
    const cwd = await f.worktree();
    writeFileSync(join(cwd, 'salvage.txt'), 'retain in bundle');
    f.g(['add', '.'], cwd);
    f.g(['commit', '-m', 'unique abandoned work'], cwd);
    const head = f.g(['rev-parse', 'HEAD'], cwd);
    f.s.updateTask(f.t, { status: 'failed' });
    await f.invoke('cleanup.release');
    await f.invoke('cleanup.deliver', { disposition: 'abandoned' });
    const a = await f.invoke('cleanup.archive');
    await f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true });
    assert.equal(f.g(['branch', '--list', 'marionette/task']), '');
    assert.ok(
      f
        .g(['bundle', 'list-heads', join(f.state, 'archives', a.id, 'commits.bundle')])
        .includes(head),
    );
  } finally {
    await f.close();
  }
});

test('already manually closed terminals are recorded without a duplicate close', async () => {
  const f = fixture();
  try {
    f.h.closed = true;
    await f.invoke('cleanup.release');
    assert.equal(f.h.closeCalls, 0);
    assert.equal(f.store.get<Run>('run', f.r.id)!.cleanup!.state, 'closed');
  } finally {
    await f.close();
  }
});

test('late branch movement is preserved and policy revocation prevents pending tab closure', async () => {
  const f = fixture();
  try {
    const a = await f.archived();
    await f.invoke('cleanup.collect', { archiveId: a.id });
    writeFileSync(join(f.repo, 'late.txt'), 'new work');
    f.g(['add', '.']);
    f.g(['commit', '-m', 'late work']);
    f.g(['update-ref', 'refs/heads/marionette/task', f.g(['rev-parse', 'HEAD'])]);
    await assert.rejects(
      f.invoke('cleanup.collect', { archiveId: a.id, deleteBranch: true }),
      /Branch moved/,
    );
    assert.ok(f.g(['branch', '--list', 'marionette/task']));
  } finally {
    await f.close();
  }
  const f2 = fixture();
  try {
    f2.h.beforeFinalRead = () =>
      f2.store.put('cleanup-policy', 'project', {
        autoRelease: false,
        collectAfterHours: null,
        deleteMergedBranches: false,
      });
    f2.s.cleanup.tick();
    await f2.s.cleanup.stop();
    assert.equal(f2.h.closeCalls, 0);
  } finally {
    await f2.close();
  }
});

test('changed live evidence after terminal release can continue in a fresh pane', async () => {
  const f = fixture();
  try {
    await f.invoke('cleanup.release');
    writeFileSync(join(f.repo, 'result.txt'), 'changed after release');
    f.s.orchestration.refreshEvidence();
    assert.equal(f.s.task(f.t.id).status, 'paused');
    await f.invoke('task.control', {
      key: 'fresh-continuation',
      type: 'reply',
      text: 'Recheck and repair the changed result',
    });
    assert.equal(f.s.task(f.t.id).status, 'queued');
    assert.equal(f.s.task(f.t.id).runId, undefined);
  } finally {
    await f.close();
  }
});

test('retained cleanup does not prevent a later native continuation', async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.s, 'http://127.0.0.1:4380', '/fixture/cli.js', 1);
  try {
    f.s.updateTask(f.t, { status: 'paused' });
    f.store.put('run', f.r.id, {
      ...f.r,
      cleanup: { state: 'retained', reason: 'inspection', updatedAt: now() },
    });
    const original = f.h.call.bind(f.h);
    let prompts = 0;
    f.h.call = async (method) => {
      if (method === 'agent.prompt') {
        prompts++;
        f.h.status = 'working';
        return {};
      }
      return original(method);
    };
    await f.invoke('task.control', {
      key: 'continue-retained',
      type: 'reply',
      text: 'Continue the native conversation',
    });
    supervisor.tick();
    await supervisor.stop();
    assert.equal(prompts, 1);
    assert.equal(f.s.task(f.t.id).status, 'running');
  } finally {
    await supervisor.stop();
    await f.close();
  }
});

test('archival fences concurrent task/evidence writes and aborts after handover', async () => {
  const f = fixture();
  try {
    await f.worktree();
    await f.invoke('cleanup.release');
    await f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    const original = f.h.call.bind(f.h);
    let entered!: () => void, proceed!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const proceedPromise = new Promise<void>((r) => {
      proceed = r;
    });
    f.h.call = async (method) => {
      if (method === 'pane.list') {
        entered();
        await proceedPromise;
      }
      return original(method);
    };
    const archival = f.invoke('cleanup.archive');
    const rejection = assert.rejects(archival, /Control belongs/);
    await enteredPromise;
    await assert.rejects(
      f.invoke('plan.revise', {
        expectedRevision: 1,
        expectedTreeRevision: 1,
        patch: { title: 'Race' },
      }),
      /cleanup is in progress/,
    );
    await assert.rejects(
      f.invoke('outcome.assess', {
        outcomeId: f.o.id,
        expectedRevision: 1,
        criterionId: 'correct',
        rationale: 'Race',
        references: ['task:task:result.txt'],
      }),
      /Cleanup is inspecting/,
    );
    await f.invoke('lead.handover', { toOwner: 'new-lead' });
    proceed();
    await rejection;
    assert.equal(f.s.task(f.t.id).archiveId, undefined);
    assert.ok(existsSync(f.s.task(f.t.id).cwd));
  } finally {
    await f.close();
  }
});

test('live task evidence preserves ownership checks through internal symlinks', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, 'owned'));
    symlinkSync('../result.txt', join(f.repo, 'owned', 'alias.txt'));
    f.s.updateTask(f.t, { ownership: ['owned'] });
    await assert.rejects(
      f.invoke('outcome.assess', {
        outcomeId: f.o.id,
        expectedRevision: 1,
        criterionId: 'correct',
        rationale: 'Test scope',
        references: ['task:task:owned/alias.txt'],
      }),
      /inside its ownership/,
    );
  } finally {
    await f.close();
  }
});

test('owned symlink evidence keeps its original reference after collection', async () => {
  const f = fixture();
  try {
    symlinkSync('result.txt', join(f.repo, 'alias.txt'));
    f.g(['add', '.']);
    f.g(['commit', '-m', 'owned alias']);
    const cwd = await f.worktree();
    f.s.updateTask(f.t, { receipt: { ...f.t.receipt!, artifacts: ['alias.txt'] } });
    const ref = { path: 'task:task:alias.txt', digest: digest(join(cwd, 'alias.txt'))! };
    f.store.put('outcome', f.o.id, {
      ...f.o,
      assessments: [{ ...f.o.assessments[0], references: [ref] }],
      integrated: { ...f.o.integrated!, evidence: [ref] },
    });
    await f.invoke('cleanup.release');
    await f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    const a = await f.invoke('cleanup.archive');
    await f.invoke('cleanup.collect', { archiveId: a.id });
    assert.match(
      readFileSync(f.s.orchestration.evidencePath('project', 'task:task:alias.txt'), 'utf8'),
      /verified/,
    );
    assert.equal(f.s.orchestration.unmet(f.s.orchestration.outcome(f.o.id)).length, 0);
  } finally {
    await f.close();
  }
});

test('directory artifact reports retain their committed contents without blocking collection', async () => {
  const f = fixture();
  try {
    await f.worktree();
    f.s.updateTask(f.t, { receipt: { ...f.t.receipt!, artifacts: ['.'] } });
    await f.invoke('cleanup.release');
    await f.invoke('cleanup.deliver', { disposition: 'merged', targetRef: 'refs/heads/main' });
    const a = await f.invoke('cleanup.archive');
    await f.invoke('cleanup.collect', { archiveId: a.id });
    assert.ok(existsSync(join(f.state, 'archives', a.id, 'commits.bundle')));
    assert.equal(f.s.orchestration.unmet(f.s.orchestration.outcome(f.o.id)).length, 0);
  } finally {
    await f.close();
  }
});
