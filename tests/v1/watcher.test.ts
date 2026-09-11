import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { Board } from '../../src/v1/board.js';
import { ProjectBindingSchema } from '../../src/v1/model.js';
import { Store } from '../../src/v1/store.js';
import { Watcher, type DeliveryPort } from '../../src/v1/watcher.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-watcher-'));
  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: ProjectBindingSchema.parse({
      id: 'project-a',
      hostId: 'host-a',
      repositoryRoot: root,
      stateDirectory: root,
    }),
  });
  const board = Board.create({ store });
  const thread = board.createThread({
    title: 'Notifications',
    author: { kind: 'system', id: 'controller' },
    idempotencyKey: 'notifications-thread',
  });
  board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
  const post = board.post({
    threadId: thread.id,
    author: { kind: 'system', id: 'controller' },
    body: 'Please inspect the board.',
    kind: 'question',
    idempotencyKey: 'post',
  });
  const delivery = store.read((db) =>
    db.prepare('SELECT id FROM notification_deliveries WHERE project_id=?').get('project-a'),
  );
  const deliveryId = z.object({ id: z.string().uuid() }).parse(delivery).id;
  return { root, store, post, deliveryId };
}

function port(): DeliveryPort & { readonly messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async checkReady() {
      return { kind: 'ready' };
    },
    async deliver(input) {
      messages.push(input.message);
      return { kind: 'submitted' };
    },
  };
}

test('watcher checks readiness then acknowledges a durable claimed delivery', async () => {
  const f = fixture();
  const deliveryPort = port();
  try {
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort,
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'watcher-one',
      pollIntervalMs: 60_000,
    });
    try {
      assert.equal(await watcher.pollOnce(), 1);
      assert.equal(deliveryPort.messages.length, 1);
      assert.equal(
        f.store.read(
          (db) =>
            db.prepare('SELECT state FROM notification_deliveries WHERE id=?').get(f.deliveryId)
              ?.state,
        ),
        'acknowledged',
      );
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('watcher takeover needs proven former absence and never replays an uncertain claimed delivery', async () => {
  const f = fixture();
  try {
    f.store.transaction((db) => {
      db.prepare(
        'INSERT INTO watcher_owners(project_id,generation,process_identity,claimed_at,settled_at) VALUES(?,?,?,?,NULL)',
      ).run(
        'project-a',
        '11111111-1111-4111-8111-111111111111',
        'former-process',
        new Date().toISOString(),
      );
      db.prepare(
        "UPDATE notification_deliveries SET state='claimed',owner_generation='11111111-1111-4111-8111-111111111111',claimed_at=? WHERE id=?",
      ).run(new Date().toISOString(), f.deliveryId);
    });
    await assert.rejects(
      Watcher.start({
        store: f.store,
        deliveryPort: port(),
        livenessPort: {
          async confirmAbsent() {
            return false;
          },
        },
        processIdentity: 'replacement',
        pollIntervalMs: 60_000,
      }),
      /confirmed former process absence/,
    );
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort: port(),
      livenessPort: {
        async confirmAbsent() {
          return true;
        },
      },
      processIdentity: 'replacement',
      pollIntervalMs: 60_000,
    });
    try {
      assert.equal(
        f.store.read(
          (db) =>
            db.prepare('SELECT state FROM notification_deliveries WHERE id=?').get(f.deliveryId)
              ?.state,
        ),
        'unconfirmed',
      );
      assert.equal(await watcher.pollOnce(), 0);
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
