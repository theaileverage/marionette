import { Config, Effect, Result, Schedule, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { sync } from './effect-runtime.js';
import { healthEffect } from './http-client.js';
import { execEffect } from './process.js';
import { stopInstanceEffect } from './server-control.js';
import { AppError } from './types.js';

const lockSchema = Schema.Struct({ pid: Schema.Int, id: Schema.optional(Schema.String) });
const missingProcess = Schema.Struct({ code: Schema.Literal('ESRCH') });
export function liveLock(path: string) {
  if (!existsSync(path)) return false;
  const lock = Schema.decodeUnknownSync(lockSchema)(JSON.parse(readFileSync(path, 'utf8')));
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    if (Schema.is(missingProcess)(error)) return false;
    throw error;
  }
}
export const maintenanceLockEffect = Effect.fn('Maintenance.lock')(function* (
  home: string,
  filename = 'maintenance.lock',
) {
  const path = resolve(home, filename),
    id = randomUUID();
  yield* Effect.acquireRelease(
    sync('Maintenance.acquire', () => {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        const before = readFileSync(path, 'utf8');
        if (liveLock(path))
          throw new AppError({
            code: 'maintenance_busy',
            message: `Another Marionette operation owns ${path}. Wait for it to finish.`,
            status: 409,
          });
        if (readFileSync(path, 'utf8') !== before)
          throw new Error('Maintenance lock changed; retry.');
        unlinkSync(path);
      }
      writeFileSync(path, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
    }),
    () =>
      Effect.sync(() => {
        if (
          existsSync(path) &&
          Schema.decodeUnknownSync(lockSchema)(JSON.parse(readFileSync(path, 'utf8'))).id === id
        )
          unlinkSync(path);
      }),
  );
});
export const probeInstanceEffect = Effect.fn('Maintenance.probe')(function* (home: string) {
  const config = yield* sync('Maintenance.config', () => loadConfig(home));
  const health = yield* Effect.result(healthEffect(`http://127.0.0.1:${config.port}/health`));
  if (Result.isSuccess(health)) {
    if (health.success.id !== config.id)
      return yield* new AppError({
        code: 'instance_mismatch',
        message: 'The configured port belongs to another service. No process was stopped.',
        status: 409,
      });
    return health.success;
  }
  if (yield* sync('Maintenance.liveLock', () => liveLock(resolve(home, 'supervisor.lock'))))
    return yield* new AppError({
      code: 'supervisor_unreachable',
      message:
        'The supervisor process is still alive but its health endpoint is unreachable. Recover it before maintenance.',
      status: 409,
    });
  return undefined;
});
export const stopForMaintenanceEffect = Effect.fn('Maintenance.stop')(function* (home: string) {
  const health = yield* probeInstanceEffect(home);
  if (health) {
    yield* stopInstanceEffect(home);
    // HTTP closes before the scoped database and supervisor lock finish releasing.
    // Maintenance must wait for both, otherwise it can race the old database owner.
    yield* sync('Maintenance.awaitShutdown', () => {
      if (liveLock(resolve(home, 'supervisor.lock')))
        throw new AppError({
          code: 'shutdown_pending',
          message:
            'The supervisor is still releasing its database lock. Retry maintenance after shutdown finishes.',
          status: 503,
        });
    }).pipe(Effect.retry(Schedule.spaced(100).pipe(Schedule.upTo({ times: 299 }))));
  }
  return health;
});
export function runtimeExecutable(runtime: string) {
  const cli = readFileSync(resolve(runtime, 'dist/cli.js'), 'utf8');
  if (cli.startsWith('#!/usr/bin/env node')) {
    const path = Effect.runSync(Config.string('PATH').pipe(Config.withDefault('')));
    const node = Bun.which('node', { PATH: path });
    if (!node)
      throw new Error('The previous runtime needs Node for rollback, but node is not on PATH.');
    return node;
  }
  return process.execPath;
}
export const startRuntimeEffect = Effect.fn('Maintenance.start')(function* (
  home: string,
  runtime: string,
) {
  const executable = yield* sync('Maintenance.executable', () => runtimeExecutable(runtime));
  yield* execEffect(executable, [resolve(runtime, 'dist/cli.js'), 'start', '--home', home], {
    timeout: 20000,
  });
  const health = yield* probeInstanceEffect(home);
  if (!health)
    return yield* new AppError({
      code: 'runtime_start_failed',
      message: 'The updated supervisor did not become healthy.',
      status: 503,
    });
  return health;
});
