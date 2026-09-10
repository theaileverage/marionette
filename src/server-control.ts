import { workerRequestEffect } from './worker-transport.js';
export { workerRequestEffect } from './worker-transport.js';
import { Effect, Result, Schedule, Schema } from 'effect';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initConfig, loadConfig } from './config.js';
import { sync } from './effect-runtime.js';
import { callUrlEffect, healthEffect } from './http-client.js';
import { installRuntime } from './runtime.js';
import { startDaemonEffect } from './setup.js';
import { AppError } from './types.js';

export const startInstanceEffect = Effect.fn('ServerControl.start')(function* (
  home: string,
  port = 4380,
) {
  const config = yield* sync('ServerControl.config', () => initConfig(home, port));
  const url = `http://127.0.0.1:${config.port}`;
  const initial = yield* Effect.result(healthEffect(`${url}/health`));
  if (Result.isSuccess(initial)) {
    if (initial.success.id !== config.id)
      return yield* new AppError({
        code: 'port_occupied',
        message: 'Port is occupied by a different service',
        status: 409,
      });
    return { running: true, url };
  }
  if (initial.failure instanceof AppError) return yield* initial.failure;
  const cli = yield* sync('ServerControl.install', () =>
    resolve(installRuntime(home), 'dist/cli.js'),
  );
  if (!existsSync(cli))
    return yield* new AppError({
      code: 'runtime_missing',
      message: 'Run bun run build before starting the background supervisor',
      status: 400,
    });
  yield* startDaemonEffect(
    process.execPath,
    [cli, 'serve', '--home', home],
    resolve(home, 'supervisor.log'),
  );
  const health = yield* healthEffect(`${url}/health`).pipe(
    Effect.filterOrFail(
      (health) => health.id === config.id,
      () =>
        new AppError({
          code: 'startup_pending',
          message: 'Waiting for this supervisor instance',
          status: 400,
        }),
    ),
    Effect.retry(Schedule.spaced(100).pipe(Schedule.upTo({ times: 49 }))),
  );
  return { running: true, pid: health.pid, url };
});
export const stopInstanceEffect = Effect.fn('ServerControl.stop')(function* (home: string) {
  const config = yield* sync('ServerControl.config', () => loadConfig(home));
  const url = `http://127.0.0.1:${config.port}`;
  yield* callUrlEffect(`${url}/api/shutdown`, config.token, {}, 5000);
  const pass = Effect.gen(function* () {
    const health = yield* Effect.result(healthEffect(`${url}/health`));
    if (Result.isFailure(health)) return { stopped: true, workersPreserved: true };
    if (health.success.id !== config.id) return { stopped: true };
    return yield* new AppError({
      code: 'shutdown_pending',
      message:
        'Shutdown is still draining a pending operation. Inspect the supervisor log; workers remain in Herdr.',
      status: 503,
    });
  });
  return yield* pass.pipe(Effect.retry(Schedule.spaced(500).pipe(Schedule.upTo({ times: 119 }))));
});
export const workerCallEffect = Effect.fn('Worker.report')(function* (
  mode: 'worker-call' | 'worker-report',
  file?: string,
) {
  const input = yield* sync('Worker.readReport', () =>
    Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(readFileSync(file ?? 0, 'utf8'))),
  );
  return yield* workerRequestEffect(mode, input);
});
