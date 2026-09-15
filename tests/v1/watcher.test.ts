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
import { Schema } from 'effect';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-watcher-'));

  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: Schema.decodeUnknownSync(ProjectBindingSchema)({
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
    db
      .prepare('SELECT subscription_id AS id FROM board_subscription_wakes WHERE project_id=?')
      .get('project-a'),
  );

  const deliveryId = z.object({ id: z.string().uuid() }).parse(delivery).id;

  return { root, store, board, thread, post, deliveryId };
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

test('watcher checks readiness then records a submitted durable wake', async () => {
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
    });

    try {
      assert.equal(await watcher.pollOnce(), 1);
      assert.equal(deliveryPort.messages.length, 1);
      assert.equal(
        f.store.read(
          (db) =>
            db
              .prepare('SELECT state FROM board_subscription_wakes WHERE subscription_id=?')
              .get(f.deliveryId)?.state,
        ),
        'submitted',
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
        "UPDATE board_subscription_wakes SET state='claimed',owner_generation='11111111-1111-4111-8111-111111111111',claimed_revision=wake_revision,claimed_at=? WHERE subscription_id=?",
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
    });

    try {
      assert.equal(
        f.store.read(
          (db) =>
            db
              .prepare('SELECT state FROM board_subscription_wakes WHERE subscription_id=?')
              .get(f.deliveryId)?.state,
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

test('watcher records an unconfirmed outcome when delivery throws after a durable claim', async () => {
  const f = fixture();

  try {
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort: {
        async checkReady() {
          return { kind: 'ready' };
        },
        async deliver() {
          throw new Error('transport disconnected');
        },
      },
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'failing-watcher',
    });

    try {
      assert.equal(await watcher.pollOnce(), 0);
      assert.equal(
        f.store.read((db) =>
          db
            .prepare(
              'SELECT state,last_error FROM board_subscription_wakes WHERE subscription_id=?',
            )
            .get(f.deliveryId),
        )?.state,
        'unconfirmed',
      );
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a post arriving during an uncertain delivery stays fenced and is not replayed', async () => {
  const f = fixture();
  let deliveries = 0;

  try {
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort: {
        async checkReady() {
          return { kind: 'ready' };
        },
        async deliver() {
          deliveries += 1;
          f.board.post({
            threadId: f.thread.id,
            author: { kind: 'system', id: 'controller' },
            body: 'arrived while submission was uncertain',
            kind: 'question',
            idempotencyKey: 'post-during-delivery',
          });
          f.board.subscribe({
            subscriber: { kind: 'desktop', id: 'lead' },
            threadId: f.thread.id,
            startPolicy: { kind: 'beginning' },
          });
          throw new Error('transport disconnected after submission');
        },
      },
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'racing-watcher',
    });

    try {
      assert.equal(await watcher.pollOnce(), 0);
      assert.equal(await watcher.pollOnce(), 0);
      assert.equal(deliveries, 1);
      assert.equal(
        f.store.read((db) =>
          db
            .prepare('SELECT state FROM board_subscription_wakes WHERE subscription_id=?')
            .get(f.deliveryId),
        )?.state,
        'unconfirmed',
      );
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a readiness failure is isolated as unconfirmed and does not strand the watcher', async () => {
  const f = fixture();

  try {
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort: {
        async checkReady() {
          throw new Error('identity probe failed');
        },
        async deliver() {
          throw new Error('must not deliver');
        },
      },
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'readiness-failure-watcher',
    });

    try {
      assert.equal(await watcher.pollOnce(), 0);
      assert.equal(await watcher.pollOnce(), 0);

      const wake = f.store.read((db) =>
        db
          .prepare('SELECT state,last_error FROM board_subscription_wakes WHERE subscription_id=?')
          .get(f.deliveryId),
      );

      assert.equal(wake?.state, 'unconfirmed');
      assert.match(String(wake?.last_error), /readiness check failed: identity probe failed/);
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a busy recipient backs off without starving an idle recipient', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-watcher-fair-'));

  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: Schema.decodeUnknownSync(ProjectBindingSchema)({
      id: 'project-a',
      hostId: 'host-a',
      repositoryRoot: root,
      stateDirectory: root,
    }),
  });

  try {
    const board = Board.create({ store });

    const thread = board.createThread({
      title: 'Fairness',
      author: { kind: 'system', id: 'controller' },
      idempotencyKey: 'fairness',
    });

    board.subscribe({
      subscriber: { kind: 'desktop', id: 'busy' },
      threadId: thread.id,
      id: '00000000-0000-4000-8000-000000000001',
    });
    board.subscribe({
      subscriber: { kind: 'desktop', id: 'idle' },
      threadId: thread.id,
      id: '00000000-0000-4000-8000-000000000002',
    });
    board.post({
      threadId: thread.id,
      author: { kind: 'system', id: 'controller' },
      body: 'wake both',
      kind: 'question',
      idempotencyKey: 'wake-both',
    });
    const delivered: string[] = [];

    const watcher = await Watcher.start({
      store,
      deliveryPort: {
        async checkReady({ recipient }) {
          return recipient.id === 'busy' ? { kind: 'busy' } : { kind: 'ready' };
        },
        async deliver({ recipient }) {
          delivered.push(recipient.id);

          return { kind: 'submitted' };
        },
      },
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'fair-watcher',
      busyBackoffMs: 60_000,
    });

    try {
      assert.equal(await watcher.pollOnce(), 0);
      assert.equal(await watcher.pollOnce(), 1);
      assert.deepEqual(delivered, ['idle']);
      assert.equal(await watcher.hasPendingWork(), true);
    } finally {
      watcher.stop();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported delivery is truthfully undeliverable', async () => {
  const f = fixture();

  try {
    const watcher = await Watcher.start({
      store: f.store,
      deliveryPort: {
        async checkReady() {
          return { kind: 'unsupported', reason: 'native path unavailable' };
        },
        async deliver() {
          throw new Error('must not deliver');
        },
      },
      livenessPort: {
        async confirmAbsent() {
          return false;
        },
      },
      processIdentity: 'unsupported-watcher',
    });

    try {
      assert.equal(await watcher.pollOnce(), 0);

      const wake = f.store.read((db) =>
        db
          .prepare('SELECT state,last_error FROM board_subscription_wakes WHERE subscription_id=?')
          .get(f.deliveryId),
      );

      assert.equal(wake?.state, 'undeliverable');
      assert.equal(wake?.last_error, 'native path unavailable');
    } finally {
      watcher.stop();
    }
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
