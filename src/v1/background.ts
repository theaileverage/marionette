import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schema } from 'effect';
import { LocalProcessInspector } from './native.js';
import type { Store } from './store.js';
import {
  WatcherError,
  type OwnerLivenessEffectPort,
  type OwnerLivenessPromisePort,
} from './watcher.js';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

const processIdentitySchema = Schema.Struct({
  pid: Schema.Finite.check(Schema.makeFilter(Number.isInteger), Schema.isGreaterThan(0)),
  startToken: nonEmpty,
});

const priorOwnerSchema = Schema.Struct({
  process_identity: Schema.String,
  settled_at: Schema.NullOr(Schema.String),
});

export class BackgroundError extends Schema.TaggedError<BackgroundError>()('BackgroundError', {
  operation: nonEmpty,
  message: nonEmpty,
  cause: Schema.Defect(),
}) {}

const backgroundError = (operation: string, cause: unknown) =>
  new BackgroundError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const watcherError = (operation: string, cause: unknown) =>
  new WatcherError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const decode = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(schema: S, value: Value): S['Type'] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

const confirmAbsentEffect = Effect.fn('Background.confirmAbsent')(function* (
  input: Parameters<OwnerLivenessEffectPort['confirmAbsentEffect']>[0],
) {
  const identity = yield* Effect.try({
    try: () => decode(processIdentitySchema, JSON.parse(input.processIdentity)),
    catch: (cause) => watcherError('Background.confirmAbsent.decodeIdentity', cause),
  });

  const probe = yield* Effect.sync((): boolean | undefined => {
    try {
      process.kill(identity.pid, 0);

      return undefined;
    } catch (cause) {
      return cause instanceof Error && 'code' in cause && cause.code === 'ESRCH';
    }
  });

  if (probe !== undefined) return probe;

  const current = yield* Effect.tryPromise({
    try: () => new LocalProcessInspector().startToken(identity.pid),
    catch: (cause) => watcherError('Background.confirmAbsent.inspectProcess', cause),
  });

  return current !== undefined && current !== identity.startToken;
});

export const localOwnerLiveness: OwnerLivenessEffectPort & OwnerLivenessPromisePort = {
  confirmAbsentEffect,
  confirmAbsent: (input) => Effect.runPromise(confirmAbsentEffect(input)),
};

export const currentProcessIdentityEffect = Effect.fn('Background.currentProcessIdentity')(
  function* () {
    const startToken = yield* Effect.tryPromise({
      try: () => new LocalProcessInspector().startToken(process.pid),
      catch: (cause) => backgroundError('Background.currentProcessIdentity.inspectProcess', cause),
    });

    if (!startToken) {
      return yield* backgroundError(
        'Background.currentProcessIdentity',
        new Error('Cannot establish the watcher process identity'),
      );
    }

    return JSON.stringify({ pid: process.pid, startToken });
  },
);

export function currentProcessIdentity(): Promise<string> {
  return Effect.runPromise(currentProcessIdentityEffect());
}

const awaitSpawn = Effect.fn('Background.awaitSpawn')((child: ReturnType<typeof spawn>) =>
  Effect.callback<void, BackgroundError>((resume) => {
    let settled = false;

    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };

    const finish = (effect: Effect.Effect<void, BackgroundError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };

    const onSpawn = () => {
      child.unref();
      finish(Effect.void);
    };

    const onError = (cause: Error) =>
      finish(Effect.fail(backgroundError('Background.ensureWatcher.spawn', cause)));

    child.once('spawn', onSpawn);
    child.once('error', onError);

    return Effect.sync(() => {
      cleanup();

      if (!settled && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    });
  }),
);

export const ensureBackgroundWatcherEffect = Effect.fn('Background.ensureWatcher')(
  function* (store: Store, bindingPath: string) {
    const prior = yield* Effect.try({
      try: () =>
        store.read((db) =>
          db
            .prepare('SELECT process_identity,settled_at FROM watcher_owners WHERE project_id=?')
            .get(store.project.id),
        ),
      catch: (cause) => backgroundError('Background.ensureWatcher.readOwner', cause),
    });

    if (prior) {
      const owner = yield* Effect.try({
        try: () => decode(priorOwnerSchema, prior),
        catch: (cause) => backgroundError('Background.ensureWatcher.decodeOwner', cause),
      });

      if (!owner.settled_at) {
        const absent = yield* confirmAbsentEffect({
          project: store.project,
          processIdentity: owner.process_identity,
        }).pipe(
          Effect.mapError((cause) => backgroundError('Background.ensureWatcher.confirmAbsent', cause)),
        );

        if (!absent) return;
      }
    }

    yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => openSync(join(store.project.stateDirectory, 'watcher.log'), 'a', 0o600),
        catch: (cause) => backgroundError('Background.ensureWatcher.openLog', cause),
      }),
      (log) => Effect.gen(function* () {
        const child = yield* Effect.try({
          try: () =>
            spawn(
              process.execPath,
              [
                fileURLToPath(new URL('./cli.js', import.meta.url)),
                'watch',
                '--project',
                bindingPath,
                '--foreground',
              ],
              {
                cwd: store.project.repositoryRoot,
                detached: true,
                stdio: ['ignore', log, log],
                env: {
                  ...process.env,
                  MARIONETTE_STATE_HOME: dirname(dirname(store.project.stateDirectory)),
                },
              },
            ),
          catch: (cause) => backgroundError('Background.ensureWatcher.spawn', cause),
        });

        yield* awaitSpawn(child);
      }),
      (descriptor) => Effect.sync(() => closeSync(descriptor)),
    );
  },
);

export function ensureBackgroundWatcher(store: Store, bindingPath: string): Promise<void> {
  return Effect.runPromise(ensureBackgroundWatcherEffect(store, bindingPath));
}
