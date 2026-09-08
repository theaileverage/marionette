import { Effect, Latch } from 'effect';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, setSystemTime } from 'bun:test';
import { command, safePath } from '../src/files.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { AppError, now, type HerdrPort, type Project, type Run } from '../src/types.js';
import { createWorktree, planWorktree } from '../src/worktrees.js';

// A deterministic protocol double for failure injection, NOT evidence of live Herdr success.
class ProtocolDouble implements HerdrPort {
  calls: { method: string; params: any }[] = [];
  agents = new Map<string, any>();
  envs = new Map<string, any>();
  panes = new Map<string, any>();
  status = 'idle';
  failPrompt = false;
  createCount = 0;
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
      const n = ++this.createCount,
        pane = {
          pane_id: `w1:p${n}`,
          tab_id:
            method === 'pane.split' ? this.panes.get(params.target_pane_id).tab_id : `w1:t${n}`,
          terminal_id: `term${n}`,
          workspace_id: 'w1',
        };
      this.envs.set(pane.pane_id, params.env);
      this.panes.set(pane.pane_id, { ...pane, cwd: params.cwd });
      return method === 'pane.split' ? { pane } : { root_pane: pane };
    }
    if (method === 'agent.start') {
      const a = {
        pane_id: params.pane_id,
        terminal_id: 'term' + params.pane_id.split('p')[1],
        workspace_id: 'w1',
        agent: params.kind,
        name: params.name,
        agent_status: this.status,
        state_change_seq: 0,
      };
      this.agents.set(params.pane_id, a);
      return { agent: a };
    }
    if (method === 'agent.get') {
      const a = this.agents.get(params.target);
      if (!a) throw new AppError({ code: 'agent_not_found', message: 'missing', status: 400 });
      return { agent: { ...a } };
    }
    if (method === 'agent.prompt') {
      if (this.failPrompt)
        throw new AppError({ code: 'herdr_timeout', message: 'ambiguous', status: 400 });
      this.agents.get(params.target).agent_status = 'working';
      return {};
    }
    if (method === 'agent.send_keys') {
      this.agents.get(params.target).agent_status = 'idle';
      return {};
    }
    if (method === 'pane.read') return { read: { text: 'real tests use the installed server' } };
    throw new Error('Unimplemented double method ' + method);
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-test-'))),
    db = join(root, 'state.sqlite'),
    store = new Store(db),
    herdr = new ProtocolDouble(),
    service = new Service(store, () => herdr);
  const p: Project = {
    id: 'project',
    name: 'Test',
    root,
    session: 'test-only',
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
      owner: 'desktop',
      expectedEpoch: 0,
      reason: 'test',
    })
  ).lease;
  const supervisor = new Supervisor(service, 'http://127.0.0.1:4380', '/test/cli.js', 1);
  const submit = (key: string, extra: any = {}) =>
    service.invoke('task.submit', {
      lease,
      assignment: {
        projectId: p.id,
        key,
        title: key,
        kind: 'codex',
        prompt: 'Make the artifact',
        ownership: [key],
        checks: [{ type: 'file', path: key + '/result.txt', contains: 'verified' }],
        ...extra,
      },
    });
  const pump = async () => {
    supervisor.tick();
    await new Promise((r) => setTimeout(r, 25));
  };
  return {
    root,
    db,
    store,
    herdr,
    service,
    p,
    lease,
    supervisor,
    submit,
    pump,
    async close() {
      await supervisor.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('submission is nonblocking, idempotent and rejects reused keys with different intent', async () => {
  const f = await fixture();
  try {
    const start = performance.now(),
      a = await f.submit('a'),
      b = await f.submit('a');
    assert.equal(a.id, b.id);
    assert.ok(performance.now() - start < 100);
    assert.equal(f.herdr.calls.length, 0);
    await assert.rejects(f.submit('a', { prompt: 'Different' }), /already used/);
    assert.equal(f.service.tasks('project').length, 1);
  } finally {
    await f.close();
  }
});
test('handover persists a briefing, fences the old lead, and rejects simultaneous takeover', async () => {
  const f = await fixture();
  try {
    await f.service.invoke('decision.record', {
      lease: f.lease,
      text: 'Use SQLite',
      rationale: 'Local durability',
    });
    const b = await f.service.invoke('lead.handover', {
      lease: f.lease,
      toOwner: 'terminal',
      reason: 'Switching surfaces',
    });
    assert.equal(b.briefing.decisions.length, 1);
    await assert.rejects(f.submit('a'), /Control belongs/);
    await assert.rejects(
      f.service.invoke('lead.acquire', {
        projectId: 'project',
        owner: 'other',
        expectedEpoch: 1,
        takeover: true,
        reason: 'stale',
      }),
      /changed/,
    );
    assert.equal(f.service.guard(b.lease).epoch, 2);
  } finally {
    await f.close();
  }
});
test('concurrent independent ownership runs; overlap and dependencies wait', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('backend'),
      b = await f.submit('design'),
      c = await f.submit('nested', { ownership: ['backend/nested'] }),
      d = await f.submit('dependent', { dependencies: [a.id] });
    await f.pump();
    assert.equal(f.herdr.createCount, 2);
    assert.equal(f.service.task(a.id).status, 'running');
    assert.equal(f.service.task(b.id).status, 'running');
    assert.equal(f.service.task(c.id).status, 'queued');
    assert.match(f.service.task(c.id).waitReason!, /ownership/);
    assert.match(f.service.task(d.id).waitReason!, /dependencies/);
  } finally {
    await f.close();
  }
});

function repoGit(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Marionette Test',
      '-c',
      'user.email=test@example.invalid',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
function initRepo(root: string) {
  repoGit(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'shared.txt'), 'committed base\n');
  mkdirSync(join(root, 'package'));
  writeFileSync(join(root, 'package', 'file.txt'), 'package base\n');
  repoGit(root, 'add', 'shared.txt', 'package/file.txt');
  repoGit(root, 'commit', '-m', 'Base');
}
const isolated = {
  execution: { mode: 'worktree' },
  ownership: ['shared.txt'],
  checks: [{ type: 'file', path: 'shared.txt', allowUnchanged: true }],
};
async function prepared(f: Awaited<ReturnType<typeof fixture>>, ...ids: string[]) {
  const deadline = Date.now() + 10000;
  do {
    await f.pump();
    if (ids.every((id) => !['queued', 'preparing'].includes(f.service.task(id).status))) return;
  } while (Date.now() < deadline);
  assert.fail('Timed out preparing tasks: ' + JSON.stringify(ids.map((id) => f.service.task(id))));
}
test('delegated children inherit the real managed checkout and task evidence stays scoped', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const parent = await f.submit('coordinator', {
      ...isolated,
      ownership: ['.'],
      canDelegate: true,
    });
    await prepared(f, parent.id);
    const p = f.service.task(parent.id),
      run = f.store.get<Run>('run', p.runId!)!;
    const token = f.herdr.envs.get(run.paneId!).MARIONETTE_WORKER_TOKEN;
    const result = await f.service.orchestration.delegate(p.id, token, {
      revision: p.revision,
      assignment: {
        projectId: p.projectId,
        outcomeId: p.outcomeId,
        expectedTreeRevision: f.service.orchestration.outcome(p.outcomeId!).revision,
        parentId: p.id,
        key: 'child',
        title: 'Child',
        kind: 'codex',
        prompt: 'Review the shared artifact',
        ownership: ['shared.txt'],
        checks: [{ type: 'file', path: 'shared.txt', allowUnchanged: true }],
      },
    });
    assert.equal(result.task.cwd, p.cwd);
    assert.equal(result.task.worktree?.branch, p.worktree?.branch);
    assert.notEqual(p.cwd, f.root);
    assert.equal(
      repoGit(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
      2,
    );
    assert.equal(
      f.service.orchestration.references(p.projectId, [`task:${result.task.id}:shared.txt`]).length,
      1,
    );
    assert.throws(
      () =>
        f.service.orchestration.references(p.projectId, [`task:${result.task.id}:../state.sqlite`]),
      /outside|escape|relative|scope|within/i,
    );
    f.service.report(p.id, token, {
      revision: result.parentRevision,
      type: 'yield',
      summary: 'Ownership transferred to child',
    });
    f.herdr.agents.get(run.paneId!).agent_status = 'idle';
    await f.pump();
    await f.pump();
    await prepared(f, result.task.id);
    assert.equal(f.service.task(result.task.id).status, 'running');
    assert.equal(
      repoGit(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
      2,
    );
  } finally {
    await f.close();
  }
});
test('managed worktrees run same-file tasks concurrently and preserve the shared checkout', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    writeFileSync(join(f.root, 'shared.txt'), 'uncommitted source\n');
    const a = await f.submit('first', {
        ...isolated,
        checks: [
          { type: 'file', path: 'shared.txt', contains: 'first worker' },
          {
            type: 'command',
            command: process.execPath,
            args: [
              '-e',
              'const fs=require("fs");if(!fs.existsSync(".git") || fs.readFileSync("shared.txt","utf8")!=="first worker\\n")process.exit(1)',
            ],
          },
        ],
      }),
      b = await f.submit('second', isolated);
    const shared = await f.submit('shared', { ...isolated, execution: { mode: 'shared' } });
    await prepared(f, a.id, b.id, shared.id);
    const ta = f.service.task(a.id),
      tb = f.service.task(b.id);
    assert.equal(ta.status, 'running', ta.error);
    assert.equal(tb.status, 'running', tb.error);
    assert.equal(f.service.task(shared.id).status, 'running');
    assert.notEqual(ta.cwd, tb.cwd);
    assert.equal(ta.worktree!.state, 'ready');
    assert.equal(repoGit(ta.cwd, 'branch', '--show-current'), ta.worktree!.branch);
    assert.equal(repoGit(f.root, 'branch', '--show-current'), 'main');
    assert.equal(readFileSync(join(ta.cwd, 'shared.txt'), 'utf8'), 'committed base\n');
    writeFileSync(join(ta.cwd, 'shared.txt'), 'first worker\n');
    assert.equal(readFileSync(join(tb.cwd, 'shared.txt'), 'utf8'), 'committed base\n');
    assert.equal(readFileSync(join(f.root, 'shared.txt'), 'utf8'), 'uncommitted source\n');
    const tabs = f.herdr.calls.filter(
      (c) => c.method === 'tab.create' || c.method === 'pane.split',
    );
    assert.deepEqual(new Set(tabs.map((c) => c.params.cwd)), new Set([ta.cwd, tb.cwd, f.root]));
    // Completion independently verifies inside the managed checkout, not the dirty source.
    const r = f.store.get<Run>('run', ta.runId!)!;
    f.service.report(ta.id, f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN, {
      revision: 1,
      type: 'complete',
      summary: 'Changed the isolated file',
      artifacts: ['shared.txt'],
      evidence: ['Ready for review'],
    });
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    r.settledAt = Date.now() - 100;
    f.store.put('run', r.id, r);
    const deadline = Date.now() + 3000;
    while (f.service.task(ta.id).status !== 'completed' && Date.now() < deadline) await f.pump();
    assert.equal(f.service.task(ta.id).status, 'completed', f.service.task(ta.id).error);
    assert.ok(f.service.task(ta.id).verification!.every((v) => v.passed));
    assert.equal(existsSync(ta.worktree!.path), true);
    assert.equal(readFileSync(join(f.root, 'shared.txt'), 'utf8'), 'uncommitted source\n');
  } finally {
    await f.close();
  }
});
test('worktree requests still respect dependencies and the project concurrency limit', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    f.store.put('project', f.p.id, { ...f.p, maxConcurrency: 1 });
    const a = await f.submit('first', isolated);
    const b = await f.submit('second', isolated);
    const c = await f.submit('dependent', { ...isolated, dependencies: [a.id] });
    await prepared(f, a.id);
    assert.match(f.service.task(b.id).waitReason!, /slot/);
    assert.match(f.service.task(c.id).waitReason!, /dependencies/);
    assert.equal(f.herdr.createCount, 1);
  } finally {
    await f.close();
  }
});
test('whole-directory ownership schedules separate worktrees before their directories exist', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('root-a', { ...isolated, ownership: ['.'] });
    const b = await f.submit('root-b', { ...isolated, ownership: ['.'] });
    await prepared(f, a.id, b.id);
    assert.equal(f.service.task(a.id).status, 'running', f.service.task(a.id).error);
    assert.equal(f.service.task(b.id).status, 'running', f.service.task(b.id).error);
    assert.throws(() => safePath(join(f.root, 'missing-root'), '.'), /ENOENT/);
  } finally {
    await f.close();
  }
});
test('non-Git projects and invalid base refs fail without launching workers', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('not-git', isolated);
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'failed');
    initRepo(f.root);
    const b = await f.submit('bad-base', {
      ...isolated,
      execution: { mode: 'worktree', baseRef: '--not-a-revision' },
    });
    await prepared(f, b.id);
    assert.equal(f.service.task(b.id).status, 'failed');
    assert.equal(f.herdr.createCount, 0);
    assert.equal(repoGit(f.root, 'branch', '--show-current'), 'main');
    assert.equal(
      repoGit(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
      1,
    );
  } finally {
    await f.close();
  }
});
test('a subdirectory task uses its matching directory in the selected committed base', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const base = repoGit(f.root, 'rev-parse', 'HEAD');
    writeFileSync(join(f.root, 'package', 'file.txt'), 'newer commit\n');
    repoGit(f.root, 'commit', '-am', 'Newer');
    const a = await f.submit('package', {
      ...isolated,
      cwd: join(f.root, 'package'),
      execution: { mode: 'worktree', baseRef: base },
      ownership: ['file.txt'],
      checks: [{ type: 'file', path: 'file.txt' }],
    });
    await prepared(f, a.id);
    const t = f.service.task(a.id);
    assert.equal(t.status, 'running', t.error);
    assert.equal(t.cwd, join(t.worktree!.path, 'package'));
    assert.equal(t.worktree!.baseCommit, base);
    assert.equal(readFileSync(join(t.cwd, 'file.txt'), 'utf8'), 'package base\n');
  } finally {
    await f.close();
  }
});
test('retry reuses the managed branch with worker commits and uncommitted edits intact', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('retry', isolated);
    await prepared(f, a.id);
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    writeFileSync(join(t.cwd, 'shared.txt'), 'worker commit\n');
    repoGit(t.cwd, 'commit', '-am', 'Worker');
    const head = repoGit(t.cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(t.cwd, 'shared.txt'), 'unfinished work\n');
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    f.store.put('run', r.id, { ...r, phase: 'stopped' });
    f.service.updateTask(t, { status: 'failed' });
    await f.service.invoke('task.retry', { lease: f.lease, taskId: a.id, key: 'retry-once' });
    await prepared(f, a.id);
    const retried = f.service.task(a.id);
    assert.equal(retried.status, 'running', retried.error);
    assert.equal(retried.cwd, t.cwd);
    assert.equal(retried.attempt, 2);
    assert.equal(repoGit(t.cwd, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(t.cwd, 'shared.txt'), 'utf8'), 'unfinished work\n');
    assert.equal(
      repoGit(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
      2,
    );
  } finally {
    await f.close();
  }
});
test('restart recovers a completed Git creation without creating a second checkout', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('recovery', isolated);
    const plan = await planWorktree(a, f.root);
    f.service.updateTask(a, { status: 'preparing', worktree: { ...plan, state: 'creating' } });
    await createWorktree(plan); // Simulate a crash after Git finishes but before the ready record.
    f.supervisor.recover();
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'running', f.service.task(a.id).error);
    assert.equal(f.service.task(a.id).cwd, plan.cwd);
    assert.equal(
      repoGit(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
      2,
    );
  } finally {
    await f.close();
  }
});
test('incomplete creation is preserved and never reset or silently replayed', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('incomplete', isolated);
    const plan = await planWorktree(a, f.root);
    await createWorktree(plan);
    writeFileSync(join(plan.path, 'shared.txt'), 'preserve me\n');
    f.service.updateTask(a, { status: 'preparing', worktree: { ...plan, state: 'creating' } });
    f.supervisor.recover();
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'failed');
    assert.match(f.service.task(a.id).error!, /not clean/);
    assert.equal(f.herdr.createCount, 0);
    assert.equal(readFileSync(join(plan.path, 'shared.txt'), 'utf8'), 'preserve me\n');
    assert.equal(existsSync(join(plan.path, '.git')), true);
  } finally {
    await f.close();
  }
});
test('a reserved path collision preserves existing files and starts no worker', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('collision', isolated);
    const plan = await planWorktree(a, f.root);
    mkdirSync(plan.path, { recursive: true });
    writeFileSync(join(plan.path, 'keep.txt'), 'existing files');
    f.service.updateTask(a, { worktree: plan });
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'failed');
    assert.equal(f.herdr.createCount, 0);
    assert.equal(readFileSync(join(plan.path, 'keep.txt'), 'utf8'), 'existing files');
  } finally {
    await f.close();
  }
});
test('cancel during Git preparation preserves the checkout and prevents worker launch', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('cancel-preparation', isolated);
    f.supervisor.tick();
    const deadline = Date.now() + 3000;
    while (f.service.task(a.id).worktree?.state !== 'creating' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(f.service.task(a.id).worktree?.state, 'creating');
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'cancel-preparation',
      type: 'cancel',
    });
    await f.supervisor.stop();
    const t = f.service.task(a.id);
    assert.equal(t.status, 'cancelled');
    assert.equal(t.worktree?.state, 'ready');
    assert.equal(existsSync(t.worktree!.path), true);
    assert.equal(f.herdr.createCount, 0);
  } finally {
    await f.close();
  }
});
test('worktree paths must be relative and symlinks are rechecked in the selected base', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    await assert.rejects(
      f.submit('absolute-owned', { ...isolated, ownership: [join(f.root, 'shared.txt')] }),
      /relative/,
    );
    await assert.rejects(
      f.submit('absolute-check', {
        ...isolated,
        checks: [{ type: 'file', path: join(f.root, 'shared.txt') }],
      }),
      /relative/,
    );
    symlinkSync(realpathSync(tmpdir()), join(f.root, 'escape'));
    repoGit(f.root, 'add', 'escape');
    repoGit(f.root, 'commit', '-m', 'Symlink base');
    const base = repoGit(f.root, 'rev-parse', 'HEAD');
    repoGit(f.root, 'rm', 'escape');
    repoGit(f.root, 'commit', '-m', 'Remove link');
    const a = await f.submit('symlink-base', {
      ...isolated,
      execution: { mode: 'worktree', baseRef: base },
      ownership: ['escape/result.txt'],
    });
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'failed');
    assert.match(f.service.task(a.id).error!, /symlink escapes/i);
    assert.equal(f.herdr.createCount, 0);
  } finally {
    await f.close();
  }
});
test('a changed branch identity is refused on retry without resetting work', async () => {
  const f = await fixture();
  try {
    initRepo(f.root);
    const a = await f.submit('changed-identity', isolated);
    await prepared(f, a.id);
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    repoGit(t.cwd, 'switch', '-c', 'manual-branch');
    writeFileSync(join(t.cwd, 'shared.txt'), 'manual work');
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    f.store.put('run', r.id, { ...r, phase: 'stopped' });
    f.service.updateTask(t, { status: 'failed' });
    await f.service.invoke('task.retry', { lease: f.lease, taskId: a.id, key: 'retry-identity' });
    await prepared(f, a.id);
    assert.equal(f.service.task(a.id).status, 'failed');
    assert.match(f.service.task(a.id).error!, /identity/);
    assert.equal(f.herdr.createCount, 1);
    assert.equal(readFileSync(join(t.cwd, 'shared.txt'), 'utf8'), 'manual work');
    assert.equal(repoGit(t.cwd, 'branch', '--show-current'), 'manual-branch');
  } finally {
    await f.close();
  }
});
test('fenced worker reports, independent verification, and durable inbox cursors', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('artifact');
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    const token = f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN;
    assert.throws(
      () =>
        f.service.report(t.id, 'wrong', {
          revision: 1,
          type: 'complete',
          summary: 'done',
          evidence: ['claimed'],
        }),
      /token/,
    );
    f.service.report(t.id, token, {
      revision: 1,
      type: 'complete',
      summary: 'done',
      evidence: ['claimed'],
    });
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    r.settledAt = Date.now() - 100;
    f.store.put('run', r.id, r);
    await f.pump();
    assert.equal(f.service.task(t.id).status, 'failed');
    assert.equal(f.service.task(t.id).verification![0].passed, false);
    const inbox = await f.service.invoke('inbox.read', {
      projectId: 'project',
      consumer: 'desktop',
    });
    await f.service.invoke('inbox.ack', {
      projectId: 'project',
      consumer: 'desktop',
      cursor: inbox.cursor,
    });
    assert.equal(
      (await f.service.invoke('inbox.read', { projectId: 'project', consumer: 'desktop' })).events
        .length,
      0,
    );
    assert.ok(
      (await f.service.invoke('inbox.read', { projectId: 'project', consumer: 'terminal' })).events
        .length > 0,
    );
    await assert.rejects(
      f.service.invoke('inbox.ack', { projectId: 'project', consumer: 'desktop', cursor: 999999 }),
      /does not exist/,
    );
  } finally {
    await f.close();
  }
});
test('a fresh artifact and passing command produce verified completion', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('artifact', {
      checks: [
        { type: 'file', path: 'artifact/result.txt', contains: 'verified' },
        { type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    });
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    mkdirSync(join(f.root, 'artifact'));
    writeFileSync(join(f.root, 'artifact/result.txt'), 'verified by test');
    f.service.report(t.id, f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN, {
      revision: 1,
      type: 'complete',
      summary: 'Implemented',
      artifacts: ['artifact/result.txt'],
      evidence: ['command will be verified'],
    });
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    r.settledAt = Date.now() - 100;
    f.store.put('run', r.id, r);
    await f.pump();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.service.task(t.id).status, 'completed');
    assert.ok(f.service.task(t.id).verification!.every((v) => v.passed));
  } finally {
    await f.close();
  }
});
test('redirect rejects stale reports and waits for the previous turn to settle', async () => {
  const clockStart = Date.now();
  setSystemTime(clockStart);
  const f = await fixture();
  try {
    const a = await f.submit('a');
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!,
      token = f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN;
    const op = await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: t.id,
      key: 'redirect-1',
      type: 'redirect',
      text: 'Updated objective',
    });
    assert.throws(
      () =>
        f.service.report(t.id, token, {
          revision: 1,
          type: 'complete',
          summary: 'old',
          evidence: ['old'],
        }),
      /obsolete/,
    );
    await f.pump();
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 1);
    await f.pump();
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 1);
    setSystemTime(clockStart + 10);
    await f.pump();
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 2);
    assert.equal(f.service.task(t.id).prompt, 'Updated objective');
    assert.equal(f.store.get<any>('operation', op.id).phase, 'done');
  } finally {
    setSystemTime();
    await f.close();
  }
});
test('a blocked worker question survives and can be answered', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a');
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!,
      token = f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN;
    f.service.report(t.id, token, { revision: 1, type: 'blocked', summary: 'Which currency?' });
    assert.equal(f.service.task(t.id).status, 'blocked');
    assert.equal(f.service.briefing('project').questions[0].text, 'Which currency?');
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: t.id,
      key: 'answer',
      type: 'reply',
      text: 'Use INR',
    });
    await f.pump();
    assert.equal(f.service.task(t.id).status, 'running');
    assert.equal(f.service.briefing('project').questions[0].answer, 'Use INR');
  } finally {
    await f.close();
  }
});
test('ambiguous prompt delivery is never retried automatically, including restart', async () => {
  const f = await fixture();
  try {
    f.herdr.failPrompt = true;
    const a = await f.submit('a');
    await f.pump();
    assert.equal(f.service.task(a.id).status, 'uncertain');
    const count = f.herdr.calls.filter((c) => c.method === 'agent.prompt').length;
    f.supervisor.recover();
    await f.pump();
    await f.pump();
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, count);
    await assert.rejects(
      f.service.invoke('task.retry', { lease: f.lease, taskId: a.id, key: 'retry' }),
      /Reconcile/,
    );
  } finally {
    await f.close();
  }
});
test('SQLite restart recovers running tasks and credentials without redispatch', async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const a = await f.submit('a');
    await f.pump();
    await f.supervisor.stop();
    f.store.close();
    reopened = new Store(f.db);
    const service = new Service(reopened, () => f.herdr),
      supervisor = new Supervisor(service, 'http://127.0.0.1:4380', '/test/cli.js', 1000);
    supervisor.recover();
    assert.equal(service.guard(f.lease).owner, 'desktop');
    assert.equal(service.task(a.id).status, 'running');
    supervisor.tick();
    await new Promise((r) => setTimeout(r, 25));
    await supervisor.stop();
    assert.equal(f.herdr.createCount, 1);
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 1);
  } finally {
    reopened?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('replaced pane occupants are never controlled', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a');
    await f.pump();
    const r = f.store.get<Run>('run', f.service.task(a.id).runId!)!;
    f.herdr.agents.get(r.paneId!).terminal_id = 'someone-else';
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'cancel',
      type: 'cancel',
    });
    await f.pump();
    assert.equal(f.service.task(a.id).status, 'uncertain');
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.send_keys').length, 0);
  } finally {
    await f.close();
  }
});
test('bounded retries and queued controls', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('a', { maxAttempts: 1 });
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'pause',
      type: 'pause',
    });
    await f.pump();
    assert.equal(f.herdr.createCount, 0);
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'resume',
      type: 'reply',
      text: 'Proceed',
    });
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    f.service.updateTask(t, { status: 'failed' });
    await assert.rejects(
      f.service.invoke('task.retry', { lease: f.lease, taskId: a.id, key: 'retry' }),
      /limit reached/,
    );
  } finally {
    await f.close();
  }
});
test('path traversal and symlinks cannot escape the registered task root', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.submit('escape', { ownership: ['../outside'] }), /within/);
    symlinkSync(tmpdir(), join(f.root, 'external'));
    await assert.rejects(
      f.submit('symlink', { checks: [{ type: 'file', path: 'external/anything' }] }),
      /escapes/,
    );
    await assert.rejects(f.submit('glob', { ownership: ['src/**'] }), /not globs/);
  } finally {
    await f.close();
  }
});
test('verification timeouts stop their process group and capture failure', async () => {
  const result = await command(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    process.cwd(),
    100,
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});
test('late output snapshots cannot roll back a concurrent redirect or receipt', async () => {
  const f = await fixture();
  try {
    const old = await f.submit('a');
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: old.id,
      key: 'new',
      type: 'redirect',
      text: 'New objective',
    });
    f.service.updateTask(old, { output: 'late pane output' });
    assert.equal(f.service.task(old.id).revision, 2);
    assert.equal(f.service.task(old.id).prompt, 'New objective');
  } finally {
    await f.close();
  }
});

test('late completion evidence resumes missing-report blocking without a new prompt', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('late');
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    f.service.updateTask(t, { status: 'blocked', blockKind: 'missing-report' });
    f.service.ask(t, 'Missing report');
    mkdirSync(join(f.root, 'late'));
    writeFileSync(join(f.root, 'late/result.txt'), 'verified');
    f.service.report(t.id, f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN, {
      revision: 1,
      type: 'complete',
      summary: 'Late transport retry',
      artifacts: ['late/result.txt'],
    });
    f.herdr.agents.get(r.paneId!).agent_status = 'idle';
    r.settledAt = Date.now() - 100;
    f.store.put('run', r.id, r);
    await f.pump();
    assert.equal(f.service.task(t.id).status, 'completed');
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 1);
    assert.ok(f.service.briefing('project').questions.every((q) => q.answeredAt));
  } finally {
    await f.close();
  }
});

test('a question report arriving before prompt ACK is preserved', async () => {
  const f = await fixture();
  try {
    const original = f.herdr.call.bind(f.herdr);
    f.herdr.call = async (method, params) => {
      const result = await original(method, params);
      if (method === 'agent.prompt') {
        const t = f.service.tasks('project')[0],
          r = f.store.get<Run>('run', t.runId!)!;
        f.service.report(t.id, f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN, {
          revision: 1,
          type: 'blocked',
          summary: 'Which currency?',
        });
      }
      return result;
    };
    const a = await f.submit('race');
    await f.pump();
    assert.equal(f.service.task(a.id).status, 'blocked');
    assert.equal(f.service.task(a.id).blockKind, 'question');
  } finally {
    await f.close();
  }
});

test('interrupted pane creation can be explicitly closed without replay or touching a shell', async () => {
  const f = await fixture();
  try {
    const original = f.herdr.call.bind(f.herdr);
    f.herdr.call = async (method, params) => {
      if (method === 'tab.create')
        throw new AppError({
          code: 'herdr_disconnected',
          message: 'lost creation acknowledgement',
          status: 400,
        });
      if (method === 'tab.list') return { tabs: [] };
      return original(method, params);
    };
    const a = await f.submit('orphan');
    await f.pump();
    assert.equal(f.service.task(a.id).status, 'uncertain');
    await assert.rejects(
      f.service.invoke('task.reconcile', {
        lease: f.lease,
        taskId: a.id,
        resolution: 'delivered',
        reason: 'No prompt attempted',
      }),
      /No task prompt/,
    );
    await f.service.invoke('task.reconcile', {
      lease: f.lease,
      taskId: a.id,
      resolution: 'not-delivered',
      reason: 'Workspace inspected; no matching pane exists',
    });
    assert.equal(f.service.task(a.id).status, 'failed');
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 0);
    await f.service.invoke('task.retry', { lease: f.lease, taskId: a.id, key: 'explicit-retry' });
    assert.equal(f.service.task(a.id).status, 'queued');
  } finally {
    await f.close();
  }
});

test('reconciliation refuses an orphan tab now occupied by another agent', async () => {
  const f = await fixture();
  try {
    const original = f.herdr.call.bind(f.herdr);
    f.herdr.call = async (method, params) => {
      if (method === 'tab.create')
        throw new AppError({ code: 'herdr_disconnected', message: 'lost ACK', status: 400 });
      if (method === 'tab.list') {
        const t = f.service.tasks('project')[0],
          r = f.store.get<Run>('run', t.runId!)!;
        return { tabs: [{ tab_id: 'w1:t8', workspace_id: 'w1', label: r.agentName }] };
      }
      if (method === 'pane.list')
        return { panes: [{ tab_id: 'w1:t8', workspace_id: 'w1', cwd: f.root, agent: 'claude' }] };
      return original(method, params);
    };
    const a = await f.submit('occupied');
    await f.pump();
    await assert.rejects(
      f.service.invoke('task.reconcile', {
        lease: f.lease,
        taskId: a.id,
        resolution: 'not-delivered',
        reason: 'Inspect',
      }),
      /no longer an untouched shell/,
    );
    assert.equal(f.service.task(a.id).status, 'uncertain');
  } finally {
    await f.close();
  }
});

test('raw agent.start acknowledgement does not cause a prompt before interactive readiness', async () => {
  const f = await fixture();
  try {
    const original = f.herdr.call.bind(f.herdr);
    let getCount = 0;
    f.herdr.call = async (method, params) => {
      const result = await original(method, params);
      if (method === 'pane.read') assert.equal(params.source, 'recent_unwrapped');
      if (method === 'agent.get' && getCount++ === 0)
        return { agent: { ...result.agent, launch_pending: true, interactive_ready: false } };
      if (method === 'agent.prompt') assert.ok(getCount >= 3);
      return result;
    };
    const a = await f.submit('startup');
    f.supervisor.tick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 0);
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(f.service.task(a.id).status, 'running');
  } finally {
    await f.close();
  }
});

test('completion cannot claim an artifact owned by another assignment', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('owned');
    await f.pump();
    const t = f.service.task(a.id),
      r = f.store.get<Run>('run', t.runId!)!;
    writeFileSync(join(f.root, 'other.txt'), 'other work');
    assert.throws(
      () =>
        f.service.report(t.id, f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN, {
          revision: 1,
          type: 'complete',
          summary: 'claim',
          artifacts: ['other.txt'],
        }),
      /belong to this assignment/,
    );
  } finally {
    await f.close();
  }
});

test('an ignored interrupt becomes actionable instead of blocking controls forever', async () => {
  const f = await fixture();
  try {
    const a = await f.submit('stuck');
    await f.pump();
    const original = f.herdr.call.bind(f.herdr);
    f.herdr.call = async (method, params) =>
      method === 'agent.send_keys' ? {} : original(method, params);
    const op = await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'pause',
      type: 'pause',
    });
    await f.pump();
    const pending = f.store.get<any>('operation', op.id);
    f.store.put('operation', op.id, { ...pending, interruptedAt: Date.now() - 31000 });
    await f.pump();
    assert.equal(f.store.get<any>('operation', op.id).phase, 'failed');
    assert.equal(f.service.task(a.id).status, 'blocked');
    assert.match(f.service.task(a.id).error!, /30 seconds/);
    await f.service.invoke('task.control', {
      lease: f.lease,
      taskId: a.id,
      key: 'specific-key',
      type: 'keys',
      keys: ['enter'],
    });
  } finally {
    await f.close();
  }
});

test('restart recovers a scheduling reservation made before any external side effect', async () => {
  const f = await fixture();
  try {
    const t = await f.submit('reserved');
    f.service.updateTask(t, { status: 'preparing' });
    f.supervisor.recover();
    assert.equal(f.service.task(t.id).status, 'queued');
    await f.pump();
    assert.equal(f.herdr.createCount, 1);
    assert.equal(f.service.task(t.id).attempt, 1);
  } finally {
    await f.close();
  }
});

test('concurrent workers share new panes with distinct credentials and working directories', async () => {
  const f = await fixture();
  try {
    const tasks = await Promise.all(
      ['layout-a', 'layout-b', 'layout-c'].map((key) => f.submit(key)),
    );
    await f.pump();
    const runs = tasks.map((t) => f.store.get<Run>('run', f.service.task(t.id).runId!)!);
    assert.equal(new Set(runs.map((r) => r.tabId)).size, 1);
    assert.equal(new Set(runs.map((r) => r.paneId)).size, 3);
    assert.ok(runs.every((r) => r.terminalScope === 'pane'));
    assert.equal(f.herdr.calls.filter((c) => c.method === 'tab.create').length, 1);
    assert.equal(f.herdr.calls.filter((c) => c.method === 'pane.split').length, 2);
    for (const call of f.herdr.calls.filter((c) =>
      ['tab.create', 'pane.split'].includes(c.method),
    )) {
      assert.equal(call.params.focus, false);
      assert.equal(call.params.cwd, f.root);
      assert.ok(call.params.env.MARIONETTE_WORKER_TOKEN);
      if (call.method === 'pane.split') assert.ok(call.params.target_pane_id);
    }
    assert.equal(
      new Set(runs.map((r) => f.herdr.envs.get(r.paneId!).MARIONETTE_WORKER_TOKEN)).size,
      3,
    );
  } finally {
    await f.close();
  }
});
test('lost split acknowledgement persists intent and reconciles without replaying or prompting', async () => {
  const f = await fixture();
  try {
    await f.submit('split-parent');
    await f.pump();
    const original = f.herdr.call.bind(f.herdr);
    f.herdr.call = async (method, params) => {
      const result = await original(method, params);
      if (method === 'pane.split')
        throw new AppError({ code: 'herdr_disconnected', message: 'Lost split ACK', status: 400 });
      return result;
    };
    const child = await f.submit('split-lost');
    await f.pump();
    const task = f.service.task(child.id),
      run = f.store.get<Run>('run', task.runId!)!;
    assert.equal(task.status, 'uncertain');
    assert.equal(run.creation!.mode, 'pane');
    assert.equal(run.paneId, undefined);
    const orphan = [...f.herdr.panes.values()].find(
      (p) => !run.creation!.beforePaneIds!.includes(p.pane_id),
    )!;
    orphan.agent = 'claude';
    await assert.rejects(
      f.service.invoke('task.reconcile', {
        lease: f.lease,
        taskId: task.id,
        resolution: 'not-delivered',
        reason: 'Inspect split',
      }),
      /untouched shell/,
    );
    delete orphan.agent;
    await f.service.invoke('task.reconcile', {
      lease: f.lease,
      taskId: task.id,
      resolution: 'not-delivered',
      reason: 'Confirmed untouched shell',
    });
    assert.equal(f.service.task(task.id).status, 'failed');
    assert.equal(f.store.get<Run>('run', run.id)!.paneId, orphan.pane_id);
    assert.equal(f.herdr.calls.filter((c) => c.method === 'pane.split').length, 1);
    assert.equal(f.herdr.calls.filter((c) => c.method === 'agent.prompt').length, 1);
  } finally {
    await f.close();
  }
});

test('graceful supervisor shutdown drains a held prompt before the final database write', async () => {
  const f = await fixture();
  const entered = Latch.makeUnsafe();
  const release = Latch.makeUnsafe();
  const original = f.herdr.call.bind(f.herdr);
  f.herdr.call = async (method, params = {}) => {
    if (method === 'agent.prompt') {
      entered.openUnsafe();
      await Effect.runPromise(release.await);
    }
    return original(method, params);
  };
  try {
    const task = await f.submit('held-shutdown');
    f.supervisor.tick();
    await Effect.runPromise(entered.await);
    let stopped = false;
    const stopping = f.supervisor.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    const calls = f.herdr.calls.length;
    f.supervisor.tick();
    assert.equal(f.herdr.calls.length, calls);
    release.openUnsafe();
    await stopping;
    assert.equal(f.store.all<Run>('run').find((run) => run.taskId === task.id)?.phase, 'running');
    assert.equal(f.service.task(task.id).status, 'running');
  } finally {
    release.openUnsafe();
    await f.close();
  }
});
