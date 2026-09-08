import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { Effect } from 'effect';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setupWorkspaceEffect } from '../src/setup-workspace.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { AppError, type HerdrPort } from '../src/types.js';

function workspaceFixture() {
  const calls: string[] = [];
  const workspaces: { workspace_id: string; label: string }[] = [];
  let failList = false;
  let beforeGet: (() => void) | undefined;
  const h: HerdrPort = {
    async call(method, params = {}) {
      calls.push(method);
      if (method === 'ping') return { pong: true };
      if (method === 'workspace.list') {
        if (failList)
          throw new AppError({ code: 'herdr_timeout', message: 'Connection lost', status: 503 });
        return { workspaces };
      }
      if (method === 'workspace.create') {
        const workspace = { workspace_id: 'w7', label: String(params.label) };
        workspaces.push(workspace);
        assert.equal(params.focus, false);
        return { workspace };
      }
      if (method === 'workspace.get') {
        beforeGet?.();
        const workspace = workspaces.find((w) => w.workspace_id === params.workspace_id);
        if (!workspace)
          throw new AppError({
            code: 'workspace_not_found',
            message: 'workspace not found',
            status: 404,
          });
        return { workspace };
      }
      throw new Error('Unexpected method ' + method);
    },
  };
  const plan = {
    root: '/project',
    workspaceLabel: 'Marionette project',
    workspace: 'w1',
    workspaceExplicit: false,
    ownsWorkspace: true,
  };
  return {
    h,
    calls,
    workspaces,
    plan,
    failList: () => {
      failList = true;
    },
    beforeGet: (f: () => void) => {
      beforeGet = f;
    },
  };
}

test('saved missing workspace creates a replacement, while a valid saved workspace is reused', async () => {
  const f = workspaceFixture();
  const replacement = await Effect.runPromise(setupWorkspaceEffect(f.h, f.plan));
  assert.deepEqual(replacement, { workspaceId: 'w7', ownsWorkspace: true, recovered: true });
  const again = await Effect.runPromise(setupWorkspaceEffect(f.h, { ...f.plan, workspace: 'w7' }));
  assert.equal(again.recovered, false);
  assert.equal(f.calls.filter((m) => m === 'workspace.create').length, 1);
});

test('a retry finds a replacement by label and does not create a duplicate', async () => {
  const f = workspaceFixture();
  f.workspaces.push({ workspace_id: 'w5', label: f.plan.workspaceLabel });
  const result = await Effect.runPromise(setupWorkspaceEffect(f.h, f.plan));
  assert.equal(result.workspaceId, 'w5');
  assert.equal(f.calls.includes('workspace.create'), false);
});

test('explicit missing IDs, ambiguous labels and connection errors never select a replacement', async () => {
  const explicit = workspaceFixture();
  await assert.rejects(
    Effect.runPromise(
      setupWorkspaceEffect(explicit.h, { ...explicit.plan, workspaceExplicit: true }),
    ),
    /Requested workspace w1/,
  );
  assert.equal(explicit.calls.includes('workspace.create'), false);
  const ambiguous = workspaceFixture();
  ambiguous.workspaces.push(
    { workspace_id: 'w5', label: ambiguous.plan.workspaceLabel },
    { workspace_id: 'w6', label: ambiguous.plan.workspaceLabel },
  );
  await assert.rejects(
    Effect.runPromise(setupWorkspaceEffect(ambiguous.h, ambiguous.plan)),
    /Multiple matching/,
  );
  const disconnected = workspaceFixture();
  disconnected.failList();
  await assert.rejects(
    Effect.runPromise(setupWorkspaceEffect(disconnected.h, disconnected.plan)),
    /Connection lost/,
  );
  assert.equal(disconnected.calls.includes('workspace.create'), false);
});

async function projectFixture() {
  const f = workspaceFixture(),
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-reconnect-')));
  const store = new Store(resolve(root, 'state.sqlite')),
    service = new Service(store, () => f.h);
  onTestFinished(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  f.workspaces.push({ workspace_id: 'w1', label: f.plan.workspaceLabel });
  const project = await service.invoke('project.register', {
    name: 'Menderly',
    root,
    session: 'test',
    socketPath: resolve(root, 'herdr.sock'),
    workspaceId: 'w1',
  });
  const { lease } = await service.invoke('lead.acquire', {
    projectId: project.id,
    owner: 'Mendy',
    agent: 'codex',
    expectedEpoch: 0,
    reason: 'Workspace recovery test',
  });
  f.workspaces.splice(0, 1, { workspace_id: 'w7', label: f.plan.workspaceLabel });
  const input = { lease, expectedWorkspaceId: 'w1', workspaceId: 'w7' };
  return { ...f, store, service, project, lease, input };
}

test('reconnection preserves project identity, lead authority and historical records', async () => {
  const f = await projectFixture();
  const lead = f.store.get('lead', f.project.id);
  f.store.put('decision', 'saved-decision', { projectId: f.project.id, message: 'preserve' });
  const updated = await f.service.invoke('project.reconnect', f.input);
  assert.deepEqual(updated, { ...f.project, workspaceId: 'w7' });
  assert.deepEqual(f.store.get('lead', f.project.id), lead);
  assert.deepEqual(f.store.get('decision', 'saved-decision'), {
    projectId: f.project.id,
    message: 'preserve',
  });
  assert.equal(f.store.all('project').length, 1);
  assert.equal(f.service.guard(f.lease).epoch, f.lease.epoch);
  assert.deepEqual(await f.service.invoke('project.reconnect', f.input), updated);
});

test('reconnection refuses active work, a surviving original workspace and another project ownership', async () => {
  const busy = await projectFixture();
  busy.store.put('task', 'active', { id: 'active', projectId: busy.project.id, status: 'running' });
  await assert.rejects(
    busy.service.invoke('project.reconnect', busy.input),
    /Resolve active tasks/,
  );
  assert.equal(busy.service.project(busy.project.id).workspaceId, 'w1');
  const present = await projectFixture();
  present.workspaces.push({ workspace_id: 'w1', label: 'original' });
  await assert.rejects(
    present.service.invoke('project.reconnect', present.input),
    /original workspace still exists/,
  );
  const shared = await projectFixture();
  shared.store.put('project', 'other', { ...shared.project, id: 'other', workspaceId: 'w7' });
  await assert.rejects(
    shared.service.invoke('project.reconnect', shared.input),
    /already bound to another project/,
  );
});

test('a handover during workspace verification fences the reconnect commit', async () => {
  const f = await projectFixture();
  f.beforeGet(() => {
    const lead = f.service.publicLead(f.project.id);
    f.store.put('lead', f.project.id, {
      ...lead,
      epoch: f.lease.epoch + 1,
      tokenHash: 'replacement',
    });
  });
  await assert.rejects(
    f.service.invoke('project.reconnect', f.input),
    /Control belongs to another lead/,
  );
  assert.equal(f.service.project(f.project.id).workspaceId, 'w1');
});
