import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { Deferred, Effect, Fiber, Predicate, Schema } from 'effect';

import { ClientOperationError, Marionette } from '../src/v1/client.js';
import { OperationError } from '../src/v1/operations.js';
import { acquireMarionette, marionetteLayer, MarionetteService } from '../src/v1/service.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-effect-service-'));
  const repositoryRoot = join(root, 'repository');
  const stateHome = join(root, 'state');
  mkdirSync(repositoryRoot);
  const initialized = Marionette.init({ repositoryRoot, stateHome });
  const expectedContext = initialized.context();
  initialized.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return {
    root,
    repositoryRoot,
    stateHome,
    expectedContext,
    options: {
      cwd: repositoryRoot,
      env: { MARIONETTE_STATE_HOME: stateHome },
    },
  };
}

function assertDatabaseClosed(client: Marionette): void {
  assert.throws(() => client.context(), /Store is closed/);
}

test('the scoped Marionette resource closes SQLite after successful use', async (t) => {
  const current = fixture(t);
  let acquired: Marionette | undefined;

  const context = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* acquireMarionette(current.options);
        acquired = client;

        return client.context();
      }),
    ),
  );

  assert.deepEqual(context, current.expectedContext);

  if (acquired === undefined) assert.fail('Scoped acquisition did not run');
  assertDatabaseClosed(acquired);
});

test('the scoped Marionette resource closes SQLite deterministically on interruption', async (t) => {
  const current = fixture(t);

  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<Marionette>();

      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* acquireMarionette(current.options);
          yield* Deferred.succeed(acquired, client);

          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);

      const client = yield* Deferred.await(acquired);
      yield* Fiber.interrupt(fiber);

      return client;
    }),
  );

  assertDatabaseClosed(client);
});

test('the Marionette service layer composes typed operations inside its scope', async (t) => {
  const current = fixture(t);

  const context = await Effect.runPromise(
    MarionetteService.use((service) => service.execute({ operation: 'context' })).pipe(
      Effect.provide(marionetteLayer(current.options)),
    ),
  );

  assert.deepEqual(context, current.expectedContext);
});

test('scoped connection reports authentication failure in the typed channel', async (t) => {
  const current = fixture(t);
  const localUserPath = join(current.expectedContext.project.stateDirectory, 'local-user.json');

  const localUser = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(readFileSync(localUserPath, 'utf8')),
  );

  const forgedContext = join(current.root, 'forged-context.json');
  writeFileSync(forgedContext, JSON.stringify({ ...localUser, token: '0'.repeat(64) }), {
    mode: 0o600,
  });

  const error = await Effect.runPromise(
    Effect.scoped(
      acquireMarionette({
        cwd: current.repositoryRoot,
        env: {
          MARIONETTE_STATE_HOME: current.stateHome,
          MARIONETTE_CONTEXT: forgedContext,
        },
      }),
    ).pipe(Effect.flip),
  );

  assert.equal(error instanceof ClientOperationError, true);
  assert.equal(error.operation, 'connect');
  assert.match(error.message, /Invalid session token/);

  const database = new DatabaseSync(
    join(current.expectedContext.project.stateDirectory, 'project.sqlite'),
    {
      readOnly: true,
    },
  );

  try {
  assert.ok(Predicate.isNumber(database.prepare('PRAGMA user_version').get()?.user_version));
  } finally {
    database.close();
  }
});

test('service execution reports schema failure in the typed operation channel', async (t) => {
  const current = fixture(t);

  const error = await Effect.runPromise(
    MarionetteService.use((service) =>
      service.execute({ operation: 'context', unexpected: true }).pipe(Effect.flip),
    ).pipe(Effect.provide(marionetteLayer(current.options))),
  );

  assert.equal(error instanceof OperationError, true);
  assert.equal(error.operation, 'context');
  assert.match(error.message, /unexpected|Unrecognized key/i);
});

test('service execution reports authentication failure in the typed operation channel', async (t) => {
  const current = fixture(t);
  const databasePath = join(current.expectedContext.project.stateDirectory, 'project.sqlite');

  const error = await Effect.runPromise(
    MarionetteService.use((service) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          const database = new DatabaseSync(databasePath);

          try {
            database.prepare('UPDATE agent_sessions SET token_hash = ?').run('0'.repeat(64));
          } finally {
            database.close();
          }
        });

        return yield* service.execute({ operation: 'context' }).pipe(Effect.flip);
      }),
    ).pipe(Effect.provide(marionetteLayer(current.options))),
  );

  assert.equal(error instanceof OperationError, true);
  assert.equal(error.operation, 'context');
  assert.match(error.message, /Invalid session token/);
});
