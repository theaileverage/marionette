import { Context, Effect, Layer, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initConfig, type Config } from './config.js';
import { sync } from './effect-runtime.js';
import { Service } from './service.js';
import { Store } from './store.js';
import { AppError } from './types.js';

export class RuntimeConfiguration extends Context.Service<RuntimeConfiguration, Config>()(
  'Marionette.Configuration',
) {}
export class Persistence extends Context.Service<Persistence, Store>()('Marionette.Persistence') {}
class SupervisorLock extends Context.Service<SupervisorLock, { readonly id: string }>()(
  'Marionette.SupervisorLock',
) {}
export class Application extends Context.Service<
  Application,
  {
    readonly core: Service;
    readonly invoke: Service['invokeEffect'];
    readonly workerAction: Service['orchestration']['workerActionEffect'];
  }
>()('Marionette.Application') {}

const LockRecord = Schema.Struct({ pid: Schema.Int, id: Schema.String });
const MissingProcess = Schema.Struct({ code: Schema.Literal('ESRCH') });

export const applicationLayer = (home: string, port?: number) => {
  const configuration = Layer.effect(
    RuntimeConfiguration,
    sync('Configuration.load', () => initConfig(home, port)),
  );
  const lock = Layer.effect(
    SupervisorLock,
    Effect.gen(function* () {
      yield* RuntimeConfiguration;
      const path = resolve(home, 'supervisor.lock');
      const id = randomUUID();
      return yield* Effect.acquireRelease(
        sync('SupervisorLock.acquire', () => {
          if (existsSync(path)) {
            const previous = Schema.decodeUnknownSync(LockRecord)(
              JSON.parse(readFileSync(path, 'utf8')),
            );
            try {
              process.kill(previous.pid, 0);
              throw new AppError({
                code: 'already_running',
                message: `Supervisor process ${previous.pid} is already running`,
                status: 409,
              });
            } catch (error) {
              if (!Schema.is(MissingProcess)(error)) throw error;
              // Recheck ownership before removing a stale lock.
              const current = Schema.decodeUnknownSync(LockRecord)(
                JSON.parse(readFileSync(path, 'utf8')),
              );
              if (current.id !== previous.id)
                throw new AppError({
                  code: 'lock_changed',
                  message: 'Supervisor lock changed during acquisition',
                  status: 409,
                });
              unlinkSync(path);
            }
          }
          writeFileSync(path, JSON.stringify({ pid: process.pid, id }), {
            flag: 'wx',
            mode: 0o600,
          });
          return SupervisorLock.of({ id });
        }),
        () =>
          Effect.sync(() => {
            if (!existsSync(path)) return;
            const current = Schema.decodeUnknownOption(LockRecord)(
              JSON.parse(readFileSync(path, 'utf8')),
            );
            if (current._tag === 'Some' && current.value.id === id) unlinkSync(path);
          }),
      );
    }),
  ).pipe(Layer.provide(configuration));
  const persistence = Layer.effect(
    Persistence,
    Effect.gen(function* () {
      yield* SupervisorLock;
      return yield* Effect.acquireRelease(
        sync('Persistence.open', () => new Store(resolve(home, 'state.sqlite'))),
        (store) => Effect.sync(() => store.close()),
      );
    }),
  ).pipe(Layer.provide(lock));
  const application = Layer.effect(
    Application,
    Effect.gen(function* () {
      const store = yield* Persistence;
      const core = yield* Effect.acquireRelease(
        sync('Application.make', () => new Service(store)),
        (core) =>
          Effect.gen(function* () {
            yield* core.continuation.stopEffect();
            yield* core.cleanup.stopEffect();
          }),
      );
      return Application.of({
        core,
        invoke: core.invokeEffect,
        workerAction: core.orchestration.workerActionEffect,
      });
    }),
  ).pipe(Layer.provide(persistence));
  return Layer.mergeAll(configuration, application);
};
