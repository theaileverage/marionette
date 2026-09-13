import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { Effect } from 'effect';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

async function projectFixture(workspaceId = 'w1') {
  const f = workspaceFixture(),
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-reconnect-')));
  const store = new Store(resolve(root, 'state.sqlite')),
    service = new Service(store, () => f.h);
  onTestFinished(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  f.workspaces.push({ workspace_id: workspaceId, label: f.plan.workspaceLabel });
  const project = await service.invoke('project.register', {
    name: 'Menderly',
    root,
    session: 'test',
    socketPath: resolve(root, 'herdr.sock'),
    workspaceId,
  });
  const { lease } = await service.invoke('lead.acquire', {
    projectId: project.id,
    owner: 'Mendy',
    agent: 'codex',
    expectedEpoch: 0,
    reason: 'Workspace recovery test',
  });
  f.workspaces.splice(0, 1, { workspace_id: 'w7', label: f.plan.workspaceLabel });
  const input = { lease, expectedWorkspaceId: workspaceId, workspaceId: 'w7' };
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

test('registration and subsequent recovery accept Herdr alphanumeric source IDs', async () => {
  const f = await projectFixture('wG');
  assert.equal(f.project.workspaceId, 'wG');
  const updated = await f.service.invoke('project.reconnect', f.input);
  assert.equal(updated.workspaceId, 'w7');
  assert.equal(updated.id, f.project.id);
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

test('preflight rejects busy projects before contacting Herdr or allocating workspaces', async () => {
  const f = await projectFixture();
  f.store.put('task', 'active', { id: 'active', projectId: f.project.id, status: 'running' });
  f.calls.length = 0;
  await assert.rejects(
    f.service.invoke('project.reconnect', {
      ...f.input,
      workspaceId: f.project.workspaceId,
      preflight: true,
    }),
    /Resolve active tasks/,
  );
  assert.deepEqual(f.calls, []);
});

test('explicit session migration preserves identity even when workspace IDs match', async () => {
  const f = await projectFixture();
  f.workspaces.push({ workspace_id: 'w1', label: 'destination' });
  const input = {
    ...f.input,
    workspaceId: 'w1',
    session: 'default',
    socketPath: resolve(f.project.root, 'default.sock'),
    expectedSocketPath: f.project.socketPath,
    expectedSession: f.project.session,
  };
  await f.service.invoke('project.reconnect', { ...input, preflight: true });
  const updated = await f.service.invoke('project.reconnect', input);
  assert.equal(updated.id, f.project.id);
  assert.equal(updated.session, 'default');
  assert.equal(updated.socketPath, input.socketPath);
  assert.equal(f.service.guard(f.lease).epoch, f.lease.epoch);
  assert.deepEqual(await f.service.invoke('project.reconnect', input), updated);
  assert.equal(f.calls.includes('workspace.close'), false);
});

test('session migration accepts a Herdr alphanumeric workspace ID and reuses it on retry', async () => {
  const f = await projectFixture();
  f.workspaces.push({ workspace_id: 'wG', label: f.plan.workspaceLabel });
  const input = {
    ...f.input,
    workspaceId: 'wG',
    session: 'default',
    socketPath: resolve(f.project.root, 'default.sock'),
    expectedSocketPath: f.project.socketPath,
    expectedSession: f.project.session,
  };
  const preflight = await f.service.invoke('project.reconnect', {
    ...input,
    workspaceId: f.project.workspaceId,
    preflight: true,
  });
  assert.equal(preflight.reconnectProtocol, 1);
  const updated = await f.service.invoke('project.reconnect', input);
  assert.equal(updated.workspaceId, 'wG');
  assert.equal(updated.session, 'default');
  assert.equal(updated.id, f.project.id);
  assert.equal(f.service.guard(f.lease).epoch, f.lease.epoch);
  assert.deepEqual(await f.service.invoke('project.reconnect', input), updated);
});

test('session migration fences a stale source connection and refuses occupied destinations', async () => {
  const f = await projectFixture();
  await assert.rejects(
    f.service.invoke('project.reconnect', {
      ...f.input,
      expectedSocketPath: '/stale.sock',
      expectedSession: f.project.session,
      session: 'default',
      socketPath: '/new.sock',
    }),
    /connection changed/,
  );
  f.store.put('project', 'other', {
    ...f.project,
    id: 'other',
    socketPath: '/new.sock',
    workspaceId: 'w7',
  });
  await assert.rejects(
    f.service.invoke('project.reconnect', {
      ...f.input,
      session: 'default',
      socketPath: '/new.sock',
      expectedSocketPath: f.project.socketPath,
      expectedSession: f.project.session,
    }),
    /already bound/,
  );
});

for (const state of ['waiting', 'ready']) {
  test(`recovery preserves a ${state} next-message wait and inbox without invalidation`, async () => {
    const f = await projectFixture();
    const wait = {
      id: 'pending',
      projectId: f.project.id,
      owner: f.lease.owner,
      epoch: f.lease.epoch,
      adapter: { type: 'next-message' },
      state,
      cursor: 12,
      eventIds: [13, 14],
      reservation: false,
    };
    const inbox = { projectId: f.project.id, body: 'Read this after reconnecting' };
    f.store.put('lead-wait', wait.id, wait);
    f.store.put('inbox', 'message', inbox);
    f.store.put('task', 'finished', { projectId: f.project.id, status: 'completed' });
    await f.service.invoke('project.reconnect', { ...f.input, preflight: true });
    await f.service.invoke('project.reconnect', f.input);
    assert.deepEqual(f.store.get('lead-wait', wait.id), wait);
    assert.deepEqual(f.store.get('inbox', 'message'), inbox);
    assert.equal(f.service.guard(f.lease).epoch, f.lease.epoch);
  });
}

test('recovery still refuses Herdr waits, reserved waits, uncertain waits and pending operations', async () => {
  for (const wait of [
    { adapter: { type: 'herdr' }, state: 'waiting', reservation: false },
    { adapter: { type: 'next-message' }, state: 'ready', reservation: true },
    { adapter: { type: 'next-message' }, state: 'uncertain', reservation: false },
  ]) {
    const f = await projectFixture();
    const record = { id: 'pending', projectId: f.project.id, ...wait };
    f.store.put('lead-wait', record.id, record);
    await assert.rejects(f.service.invoke('project.reconnect', f.input), /Resolve active tasks/);
    assert.deepEqual(f.store.get('lead-wait', record.id), record);
  }
  const f = await projectFixture();
  f.store.put('operation', 'pending', { projectId: f.project.id, phase: 'intent' });
  await assert.rejects(f.service.invoke('project.reconnect', f.input), /Resolve active tasks/);
});

test('reconnect rejects partial connections and relative socket paths before Herdr access', async () => {
  const f = await projectFixture();
  f.calls.length = 0;
  for (const connection of [
    { session: 'default' },
    { socketPath: '/new.sock' },
    { session: 'default', socketPath: '/new.sock' },
    { session: 'default', socketPath: '/new.sock', expectedSocketPath: f.project.socketPath },
    {
      session: 'default',
      socketPath: 'new.sock',
      expectedSocketPath: f.project.socketPath,
      expectedSession: f.project.session,
    },
    {
      session: 'default',
      socketPath: '/new.sock',
      expectedSocketPath: 'old.sock',
      expectedSession: f.project.session,
    },
  ]) {
    await assert.rejects(f.service.invoke('project.reconnect', { ...f.input, ...connection }));
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.service.project(f.project.id), f.project);
});

test('source session changes fence migration before and during destination verification', async () => {
  const f = await projectFixture();
  const input = {
    ...f.input,
    session: 'default',
    socketPath: '/new.sock',
    expectedSocketPath: f.project.socketPath,
    expectedSession: f.project.session,
  };
  await assert.rejects(
    f.service.invoke('project.reconnect', { ...input, expectedSession: 'stale' }),
    /connection changed/,
  );
  f.beforeGet(() => f.store.put('project', f.project.id, { ...f.project, session: 'changed' }));
  await assert.rejects(f.service.invoke('project.reconnect', input), /connection changed/);
  assert.equal(f.service.project(f.project.id).socketPath, f.project.socketPath);
});

test('session-only destination differences are not treated as completed reconnects', async () => {
  const f = await projectFixture();
  const updated = await f.service.invoke('project.reconnect', f.input);
  await assert.rejects(
    f.service.invoke('project.reconnect', {
      ...f.input,
      expectedWorkspaceId: updated.workspaceId,
      session: 'renamed',
      socketPath: updated.socketPath,
      expectedSession: updated.session,
      expectedSocketPath: updated.socketPath,
    }),
    /original workspace still exists/,
  );
});

test('migration rejects an existing source workspace before destination allocation', async () => {
  const f = await projectFixture();
  writeFileSync(f.project.socketPath, 'source endpoint fixture');
  f.workspaces.push({ workspace_id: 'w1', label: 'original lead workspace' });
  const input = {
    ...f.input,
    session: 'default',
    socketPath: '/new.sock',
    expectedSocketPath: f.project.socketPath,
    expectedSession: f.project.session,
  };
  await assert.rejects(
    f.service.invoke('project.reconnect', { ...input, preflight: true }),
    /Stop its lead and close/,
  );
  assert.equal(f.service.project(f.project.id).socketPath, f.project.socketPath);
  assert.equal(f.service.guard(f.lease).epoch, f.lease.epoch);
  assert.equal(f.calls.includes('workspace.create'), false);
});

test('recovery preflight advertises its protocol without rebinding the project', async () => {
  const f = await projectFixture();
  const response = await f.service.invoke('project.reconnect', {
    ...f.input,
    workspaceId: f.project.workspaceId,
    preflight: true,
  });
  assert.equal(response.reconnectProtocol, 1);
  assert.deepEqual(f.service.project(f.project.id), f.project);
});
