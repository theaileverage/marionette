import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Marionette } from '../../src/v1/client.js';
import { execute, operationSchema } from '../../src/v1/operations.js';
import { contextSchema } from '../../src/v1/context.js';
import { Schema } from 'effect';

test('SDK and parsed operations share durable state and derive the author from the session', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-client-'));
  const repo = join(root, 'repo');
  const stateHome = join(root, 'state');
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = Marionette.init({ repositoryRoot: repo, stateHome });
  const thread = first.createThread({ title: 'Client parity', idempotencyKey: 'thread' });
  const original = await execute(first, {
    operation: 'board.post',
    threadId: thread.id,
    body: 'Durable result',
    kind: 'result',
    idempotencyKey: 'post',
  });
  first.close();
  const second = Marionette.connect({ cwd: repo, env: { MARIONETTE_STATE_HOME: stateHome } });
  t.after(() => second.close());
  const replayed = second.post({
    threadId: thread.id,
    body: 'Durable result',
    kind: 'result',
    idempotencyKey: 'post',
  });
  assert.deepEqual(replayed, original);
  assert.equal(replayed.author.id, second.context().session.id);
  assert.equal(second.readThread({ threadId: thread.id }).entries.length, 1);
  await assert.rejects(
    async () =>
      execute(
        second,
        Schema.decodeUnknownSync(operationSchema)({
          operation: 'board.post',
          threadId: thread.id,
          body: 'Impersonated',
          kind: 'result',
          idempotencyKey: 'forged',
          author: { kind: 'system', id: 'another' },
        }),
      ),
    (error: unknown) => {
      assert.ok(Schema.isSchemaError(error));
      assert.match(error.message, /Expected no excess property/);
      assert.match(error.message, /\["author"\]/);
      return true;
    },
  );
  second.configureProfile({
    profile: {
      name: 'test',
      kind: 'agy',
      model: 'explicit-model',
      args: ['--model', 'explicit-model'],
    },
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  assert.equal(second.profiles()[0].model, 'explicit-model');
  assert.throws(
    () =>
      second.configureProfile({
        profile: {
          name: 'test',
          kind: 'agy',
          model: 'different-model',
          args: ['--model', 'different-model'],
        },
        expectedRevision: 0,
        idempotencyKey: 'stale-profile',
      }),
    /revision is stale/,
  );
});

test('managed SDK connection cannot promote a supplied context to a local user', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-client-auth-'));
  const repo = join(root, 'repo');
  const stateHome = join(root, 'state');
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = Marionette.init({ repositoryRoot: repo, stateHome });
  const context = client.context();
  client.close();
  const local = Schema.decodeUnknownSync(contextSchema)(
    JSON.parse(readFileSync(join(context.project.stateDirectory, 'local-user.json'), 'utf8')),
  );
  const forged = join(root, 'forged.json');
  writeFileSync(forged, JSON.stringify({ ...local, token: '0'.repeat(64) }));
  assert.throws(
    () =>
      Marionette.connect({
        cwd: repo,
        env: { MARIONETTE_STATE_HOME: stateHome, MARIONETTE_CONTEXT: forged },
      }),
    /Invalid session token/,
  );
  const inherited = process.env.MARIONETTE_CONTEXT;
  process.env.MARIONETTE_CONTEXT = forged;
  try {
    assert.throws(
      () => Marionette.connect({ cwd: repo, env: { MARIONETTE_STATE_HOME: stateHome } }),
      /Invalid session token/,
    );
    assert.throws(
      () => Marionette.init({ repositoryRoot: repo, stateHome }),
      /Managed sessions cannot initialize another project/,
    );
  } finally {
    if (inherited === undefined) delete process.env.MARIONETTE_CONTEXT;
    else process.env.MARIONETTE_CONTEXT = inherited;
  }
});

test('the real watcher settles its ownership before closing on abort', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-watch-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = Marionette.init({ repositoryRoot: repo, stateHome: join(root, 'state') });
  const context = client.context();
  try {
    const stopped = await client.watch({ signal: AbortSignal.timeout(1100) });
    assert.equal(stopped.stopped, true);
    const db = new DatabaseSync(join(context.project.stateDirectory, 'project.sqlite'), {
      readOnly: true,
    });
    try {
      const owner = db.prepare('SELECT generation,settled_at FROM watcher_owners').get();
      assert.equal(owner?.generation, stopped.generation);
      z.string().datetime().parse(owner?.settled_at);
    } finally {
      db.close();
    }
  } finally {
    client.close();
  }
});
