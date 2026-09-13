import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Board, type BoardAuthor, type BoardRecipient } from '../../src/v1/board.js';
import { ProjectBindingSchema } from '../../src/v1/model.js';
import { Store } from '../../src/v1/store.js';

function fixture(projectId = 'project-a') {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-board-'));
  const project = ProjectBindingSchema.parse({
    id: projectId,
    hostId: 'host-a',
    repositoryRoot: root,
    stateDirectory: root,
  });
  const store = Store.open({ databasePath: join(root, 'project.sqlite'), project });
  return { root, store, board: Board.create({ store }) };
}

test('board posts are immutable, persist across restart, and atomically create non-self notification intents', () => {
  const f = fixture();
  try {
    const author = { kind: 'system', id: 'controller' } satisfies BoardAuthor;
    const recipient = { kind: 'desktop', id: 'lead' } satisfies BoardRecipient;
    const self = { kind: 'user', id: 'author' } satisfies BoardAuthor;
    const thread = f.board.createThread({
      title: 'Durable findings',
      author,
      idempotencyKey: 'durable-findings-thread',
    });
    f.board.subscribe({ subscriber: recipient, threadId: thread.id, eventKinds: ['finding'] });
    f.board.subscribe({ subscriber: self, threadId: thread.id });
    const post = f.board.post({
      threadId: thread.id,
      author: self,
      body: 'The evidence is durable.',
      kind: 'finding',
      idempotencyKey: 'finding-1',
      references: [{ kind: 'file', value: 'evidence.md' }],
    });
    assert.equal(post.sequence, 1);
    assert.equal(
      f.store.read((db) =>
        Number(db.prepare('SELECT COUNT(*) AS count FROM notification_events').get()?.count),
      ),
      1,
    );
    assert.equal(
      f.store.read((db) =>
        Number(
          db
            .prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE state='pending'")
            .get()?.count,
        ),
      ),
      1,
    );
    const retry = f.board.post({
      threadId: thread.id,
      author: self,
      body: 'The evidence is durable.',
      kind: 'finding',
      idempotencyKey: 'finding-1',
      references: [{ kind: 'file', value: 'evidence.md' }],
    });
    assert.equal(retry.id, post.id);
    assert.equal(
      f.board.createThread({
        title: 'Durable findings',
        author,
        idempotencyKey: 'durable-findings-thread',
      }).id,
      thread.id,
    );
    assert.throws(
      () =>
        f.board.createThread({
          title: 'Changed thread title',
          author,
          idempotencyKey: 'durable-findings-thread',
        }),
      /thread idempotency key/,
    );
    assert.throws(
      () =>
        f.board.post({
          threadId: thread.id,
          author: self,
          body: 'Changed content',
          kind: 'finding',
          idempotencyKey: 'finding-1',
        }),
      /idempotency key/,
    );
    f.store.close();
    const reopened = Store.open({
      databasePath: join(f.root, 'project.sqlite'),
      project: ProjectBindingSchema.parse({
        id: 'project-a',
        hostId: 'host-a',
        repositoryRoot: f.root,
        stateDirectory: f.root,
      }),
    });
    try {
      const persisted = Board.create({ store: reopened }).readThread({ threadId: thread.id });
      assert.deepEqual(
        persisted.entries.map((entry) => ({
          id: entry.id,
          body: entry.body,
          references: entry.references,
        })),
        [
          {
            id: post.id,
            body: 'The evidence is durable.',
            references: [{ kind: 'file', value: 'evidence.md' }],
          },
        ],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('board cursors and writes cannot cross project scope', () => {
  const left = fixture('project-a');
  const right = fixture('project-b');
  try {
    const author = { kind: 'system', id: 'controller' } satisfies BoardAuthor;
    const leftThread = left.board.createThread({
      title: 'Left',
      author,
      idempotencyKey: 'left-thread',
    });
    const rightThread = right.board.createThread({
      title: 'Right',
      author,
      idempotencyKey: 'right-thread',
    });
    left.board.post({
      threadId: leftThread.id,
      author,
      body: 'left evidence',
      kind: 'finding',
      idempotencyKey: 'left',
    });
    right.board.post({
      threadId: rightThread.id,
      author,
      body: 'right evidence',
      kind: 'finding',
      idempotencyKey: 'right',
    });
    const leftPage = left.board.listThreads({ limit: 1 });
    assert.equal(leftPage.entries[0]?.id, leftThread.id);
    assert.throws(
      () => right.board.listThreads({ cursor: leftPage.nextCursor ?? 'not-a-cursor' }),
      /cursor/,
    );
    assert.throws(() => left.board.readThread({ threadId: rightThread.id }), /does not exist/);
    assert.deepEqual(
      left.board.search({ query: 'evidence' }).entries.map((post) => post.body),
      ['left evidence'],
    );
  } finally {
    left.store.close();
    right.store.close();
    rmSync(left.root, { recursive: true, force: true });
    rmSync(right.root, { recursive: true, force: true });
  }
});

test('default subscriptions notify questions, blockers, and results but leave progress on the board', () => {
  const f = fixture();
  try {
    const author = { kind: 'system', id: 'controller' } satisfies BoardAuthor;
    const thread = f.board.createThread({
      title: 'Notifications',
      author,
      idempotencyKey: 'notification-thread',
    });
    f.board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
    f.board.post({
      threadId: thread.id,
      author,
      body: 'Still working.',
      kind: 'progress',
      idempotencyKey: 'progress',
    });
    f.board.post({
      threadId: thread.id,
      author,
      body: 'A decision is needed.',
      kind: 'question',
      idempotencyKey: 'question',
    });
    assert.equal(
      f.store.read((db) =>
        Number(db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get()?.count),
      ),
      1,
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
