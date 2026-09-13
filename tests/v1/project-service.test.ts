import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Board } from '../../src/v1/board.js';
import { Store } from '../../src/v1/store.js';
import { ServiceLifecycle } from '../../src/v1/service/lifecycle.js';
import { AgentSessionIdSchema, ProjectBindingSchema } from '../../src/v1/model.js';
import { ServiceOwnership } from '../../src/v1/service/ownership.js';
import { runProjectService } from '../../src/v1/service/project-service.js';
import { nudgeService, wakeSocketPath } from '../../src/v1/service/wake-port.js';
import { RecoveryRegistry, scanRecovery } from '../../src/v1/service/recovery.js';
import {
  serviceDefinition,
  installService,
  uninstallService,
} from '../../src/v1/service/installers/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marionette-service-'));
  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: ProjectBindingSchema.parse({
      id: 'service-project',
      hostId: 'host-a',
      repositoryRoot: root,
      stateDirectory: root,
    }),
  });
  return {
    root,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const identity = (pid: number) => JSON.stringify({ pid, startToken: 'exact-start-' + pid });
test('service heartbeat expiry never proves absence and old generation is fenced after confirmed crash', async () => {
  const f = fixture();
  try {
    const first = await ServiceOwnership.acquire({
      store: f.store,
      processIdentity: identity(1),
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
    });
    f.store.transaction((db) =>
      db.prepare("UPDATE service_instances SET heartbeat_at='2000-01-01'").run(),
    );
    await assert.rejects(
      ServiceOwnership.acquire({
        store: f.store,
        processIdentity: identity(2),
        livenessPort: {
          async confirmAbsent() {
            return false;
          },
        },
      }),
      /confirmed former process absence/,
    );
    const second = await ServiceOwnership.acquire({
      store: f.store,
      processIdentity: identity(2),
      livenessPort: {
        async confirmAbsent() {
          return true;
        },
      },
    });
    assert.notEqual(first.generation, second.generation);
    assert.throws(() => first.heartbeat(), /no longer owns/);
    second.stop();
  } finally {
    f.close();
  }
});
test('project service scans at startup and watchdog without wake and does not exit when idle', async () => {
  const f = fixture();
  const abort = new AbortController();
  let scans = 0;
  let recovery = 0;
  try {
    await runProjectService({
      store: f.store,
      signal: abort.signal,
      watchdogMs: 10,
      processIdentity: identity(1),
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      async recover(owner) {
        recovery++;
        await new RecoveryRegistry().recover(owner);
      },
      async scan() {
        scans++;
        if (scans === 3) abort.abort();
      },
    });
    assert.equal(scans, 3);
    assert.equal(recovery, 1);
    assert.equal(ServiceOwnership.status(f.store)?.state, 'stopped');
  } finally {
    f.close();
  }
});
test('lost wake is harmless and active socket wakes service before watchdog', async () => {
  const f = fixture();
  const abort = new AbortController();
  let scans = 0;
  try {
    assert.equal(await nudgeService(wakeSocketPath(f.root)), false);
    await runProjectService({
      store: f.store,
      signal: abort.signal,
      watchdogMs: 60_000,
      processIdentity: identity(1),
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      async recover() {},
      async scan() {
        scans++;
        if (scans === 1) assert.equal(await nudgeService(wakeSocketPath(f.root)), true);
        else abort.abort();
      },
    });
    assert.equal(scans, 2);
  } finally {
    f.close();
  }
});
test('recovery classifies notification claim as ambiguous without replay or acknowledgement', async () => {
  const f = fixture();
  try {
    const board = Board.create({ store: f.store });
    const thread = board.createThread({
      title: 'Recovery',
      author: { kind: 'system', id: 'test' },
      idempotencyKey: 'thread',
    });
    board.subscribe({ subscriber: { kind: 'desktop', id: 'test' }, threadId: thread.id });
    board.post({
      threadId: thread.id,
      author: { kind: 'system', id: 'test' },
      body: 'Pending notification',
      kind: 'question',
      idempotencyKey: 'post',
    });
    f.store.transaction((db) =>
      db
        .prepare("UPDATE notification_deliveries SET state='claimed',owner_generation='former'")
        .run(),
    );
    const records = scanRecovery(f.store);
    const delivery = records.find((row) => row.table === 'notification_deliveries');
    assert.equal(delivery?.classification, 'manual-reconciliation');
    assert.equal(
      f.store.read((db) => db.prepare('SELECT state FROM notification_deliveries').get()?.state),
      'claimed',
    );
  } finally {
    f.close();
  }
});
test('service definitions escape native configuration and lifecycle never uses shell', async () => {
  const f = fixture();
  try {
    const input = {
      projectId: 'project',
      hostId: 'host',
      executable: '/bin/node',
      arguments: ['/path/a & b.js', '%name $VALUE "quoted"'],
      workingDirectory: f.root,
      stateDirectory: f.root,
      homeDirectory: f.root,
      platform: 'darwin' as const,
      uid: 501,
    };
    const mac = serviceDefinition(input);
    assert.match(mac.content, /a &amp; b/);
    assert.match(mac.content, /&quot;quoted&quot;/);
    assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/);
    const linux = serviceDefinition({ ...input, platform: 'linux' });
    assert.match(linux.content, /%%name \$\$VALUE/);
    assert.match(linux.content, /Restart=always/);
    installService(linux);
    const commands: string[] = [];
    await uninstallService(linux, {
      async run(command, args) {
        commands.push([command, ...args].join(' '));
        return '';
      },
    });
    assert.deepEqual(commands, [
      `systemctl --user disable --now ${linux.label}.service`,
      'systemctl --user daemon-reload',
    ]);
    assert.throws(
      () => serviceDefinition({ ...input, arguments: ['bad\nargument'] }),
      /control characters/,
    );
  } finally {
    f.close();
  }
});

test('service lifecycle durably claims commands and ambiguous actions cannot replay', async () => {
  const f = fixture();
  try {
    const actor = f.store.registerSession({
      id: AgentSessionIdSchema.parse('service-user'),
      generation: 1,
      workspaceId: null,
      role: 'user',
      executionRole: 'user',
      tokenHash: 'a'.repeat(64),
      parentWorkflowId: null,
      attemptId: null,
      nativeKind: null,
      nativeServerGeneration: null,
      nativeLocator: null,
    });
    const definition = serviceDefinition({
      projectId: f.store.project.id,
      hostId: f.store.project.hostId,
      executable: '/bin/node',
      arguments: ['/service.js'],
      workingDirectory: f.root,
      stateDirectory: f.root,
      homeDirectory: f.root,
      platform: 'linux',
      uid: 501,
    });
    let calls = 0;
    const port = {
      async run() {
        calls++;
        throw new Error('response lost');
      },
    };
    const lifecycle = new ServiceLifecycle(f.store, definition, port, actor);
    const installed = await lifecycle.apply({
      action: 'install',
      expectedRevision: 0,
      idempotencyKey: 'install',
    });
    assert.equal(installed.state, 'completed');
    const input = { action: 'start' as const, expectedRevision: 1, idempotencyKey: 'start' };
    const claim = await lifecycle.apply(input);
    assert.equal(claim.state, 'unconfirmed');
    assert.equal(calls, 1);
    assert.equal((await lifecycle.apply(input)).id, claim.id);
    assert.equal(calls, 1);
    await assert.rejects(
      lifecycle.apply({ action: 'stop', expectedRevision: 2, idempotencyKey: 'stop' }),
      /requires reconciliation/,
    );
    const reconciler = new ServiceLifecycle(
      f.store,
      definition,
      {
        async run() {
          return `ActiveState=active\nUnitFileState=enabled\nFragmentPath=${definition.path}\n`;
        },
      },
      actor,
    );
    assert.equal(
      (await reconciler.reconcile({ claimId: claim.id, expectedRevision: 2 })).state,
      'completed',
    );
    f.store.transaction((db) =>
      db.prepare("UPDATE agent_sessions SET state='settled' WHERE id=?").run(actor.id),
    );
    await assert.rejects(
      lifecycle.apply({ action: 'stop', expectedRevision: 2, idempotencyKey: 'stop' }),
      /active local user/,
    );
  } finally {
    f.close();
  }
});
