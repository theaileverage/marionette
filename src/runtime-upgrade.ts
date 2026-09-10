import { Database } from 'bun:sqlite';
import { Effect, Result, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { inside } from './files.js';
import { readInstanceState, runtimeVersion, type InstanceState } from './instance-state.js';
import {
  maintenanceLockEffect,
  probeInstanceEffect,
  runtimeExecutable,
  startRuntimeEffect,
  stopForMaintenanceEffect,
} from './maintenance.js';
import {
  installMcpEffect,
  inspectMcpInstall,
  mcpCommand,
  listClientReceipts,
  readMcpRegistration,
  sameMcpServer,
  type McpServer,
} from './mcp-registration.js';
import { privateJson } from './private-json.js';
import { installRuntime, packageRoot } from './runtime.js';
import { AppError, type Kind } from './types.js';

const kinds: Kind[] = ['codex', 'claude', 'agy', 'omp'];
export function previousRuntime(state: InstanceState, version?: string, runningRuntime?: string) {
  const pointer = resolve(state.home, 'runtime.json');
  const candidates = [
    ...(runningRuntime ? [runningRuntime] : []),
    ...(existsSync(pointer)
      ? [
          Schema.decodeUnknownSync(Schema.Struct({ runtime: Schema.String }))(
            JSON.parse(readFileSync(pointer, 'utf8')),
          ).runtime,
        ]
      : []),
    ...state.bindings.map(({ binding }) => binding.runtime),
    ...kinds.flatMap((kind) =>
      listClientReceipts(state.home, kind).map(({ receipt }) => receipt.runtime),
    ),
  ];
  return candidates.find(
    (runtime) =>
      inside(resolve(state.home, 'runtimes'), runtime) &&
      runtimeVersion(runtime) !== 'missing' &&
      (!version || runtimeVersion(runtime) === version),
  );
}
export const runtimeStatusEffect = Effect.fn('Runtime.status')(function* (
  home: string,
  source = packageRoot,
) {
  if (!existsSync(resolve(home, 'config.json')))
    return {
      needsUpgrade: false,
      targetVersion: runtimeVersion(source),
      versions: [],
      runningVersion: undefined,
      projects: [],
    };
  const state = yield* sync('Runtime.state', () => readInstanceState(home));
  const health = yield* probeInstanceEffect(home);
  const targetVersion = runtimeVersion(source);
  const versions = yield* sync('Runtime.savedVersions', () => [
    ...new Set([
      ...state.bindings.map(({ binding }) => runtimeVersion(binding.runtime)),
      ...kinds.flatMap((kind) =>
        listClientReceipts(home, kind).flatMap(({ receipt }) =>
          receipt.runtime !== '.' ? [runtimeVersion(receipt.runtime)] : [],
        ),
      ),
    ]),
  ]);
  return {
    needsUpgrade:
      versions.some((version) => version !== targetVersion) ||
      !!(health && health.version !== targetVersion),
    targetVersion,
    versions,
    runningVersion: health?.version,
    projects: state.projects.map((p) => p.name),
  };
});
interface ClientBackup {
  kind: Kind;
  name: string;
  server?: McpServer;
  receipt?: string;
  receiptPath: string;
}
function snapshotClients(home: string) {
  return kinds.flatMap((kind): ClientBackup[] =>
    listClientReceipts(home, kind).map(({ path, receipt }) => ({
      kind,
      name: receipt.name,
      server: readMcpRegistration(kind, receipt.name)?.server,
      receipt: readFileSync(path, 'utf8'),
      receiptPath: path,
    })),
  );
}
function snapshotDatabase(home: string, backup: string) {
  if (!existsSync(resolve(home, 'state.sqlite'))) return;
  // A stopped Node runtime may have removed the WAL sidecars. Let SQLite
  // recreate its bookkeeping before reading the source for VACUUM INTO.
  const db = new Database(resolve(home, 'state.sqlite'), { readwrite: true, create: false });
  // VACUUM INTO creates a standalone database, including committed WAL contents.
  // serialize() can retain WAL-mode headers that require absent sidecar files.
  try {
    db.query('VACUUM INTO ?').run(resolve(backup, 'state.sqlite'));
    chmodSync(resolve(backup, 'state.sqlite'), 0o600);
  } finally {
    db.close();
  }
}

/** Every project and MCP registration in a shared instance moves together; failed upgrades roll back. */
export const upgradeInstanceEffect = Effect.fn('Runtime.upgrade')(function* (
  home: string,
  source = packageRoot,
) {
  yield* maintenanceLockEffect(home);
  const initial = yield* sync('Runtime.state', () => readInstanceState(home));
  const initialHealth = yield* probeInstanceEffect(home);
  const version = yield* sync('Runtime.version', () => runtimeVersion(source));
  for (const old of [
    ...initial.bindings.map(({ binding }) => runtimeVersion(binding.runtime)),
    ...(initialHealth?.version ? [initialHealth.version] : []),
  ]) {
    if (old !== 'missing' && Bun.semver.order(old, version) > 0)
      return yield* new AppError({
        code: 'runtime_downgrade',
        message: `Refusing to replace runtime ${old} with older ${version}.`,
        status: 409,
      });
  }
  const previous = yield* sync('Runtime.previous', () =>
    previousRuntime(initial, initialHealth?.version, initialHealth?.runtime),
  );
  if (initialHealth && !previous)
    return yield* new AppError({
      code: 'rollback_runtime_missing',
      message:
        'Cannot locate the running runtime for rollback. Restore its saved runtime before upgrading.',
      status: 409,
    });
  if (previous && initialHealth) yield* awaitVersionEffect(previous);
  const runtime = yield* sync('Runtime.install', () => installRuntime(home, source));
  // Execute the copied entry point before stopping the existing supervisor.
  const validation = yield* awaitVersionEffect(runtime);
  if (validation !== version)
    return yield* new AppError({
      code: 'runtime_version_mismatch',
      message: 'The copied CLI version does not match its package metadata.',
      status: 409,
    });
  const clients = yield* sync('Runtime.clients', () => snapshotClients(home));
  for (const client of clients)
    yield* sync('Runtime.mcpPreflight', () =>
      inspectMcpInstall(mcpCommand(client.kind, client.name, runtime, home), client.name, home),
    );
  if (
    initialHealth?.runtime === runtime &&
    initial.bindings.every(({ binding }) => binding.runtime === runtime) &&
    clients.every(
      (c) => c.server && sameMcpServer(c.server, mcpCommand(c.kind, c.name, runtime, home).server),
    )
  )
    return { updated: false, version, runtime, projects: initial.projects.length };
  const backup = resolve(home, 'updates', randomUUID());
  yield* sync('Runtime.backupDirectory', () => mkdirSync(backup, { recursive: true, mode: 0o700 }));
  const pointer = resolve(home, 'runtime.json');
  const oldPointer = yield* sync('Runtime.pointer', () =>
    existsSync(pointer) ? readFileSync(pointer, 'utf8') : undefined,
  );
  const wasRunning = !!(yield* stopForMaintenanceEffect(home));
  let state = initial;
  let prepared = false;
  const change = Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* maintenanceLockEffect(home, 'supervisor.lock');
      state = yield* sync('Runtime.stoppedState', () => readInstanceState(home));
      yield* sync('Runtime.backup', () => {
        snapshotDatabase(home, backup);
        privateJson(resolve(backup, 'rollback.json'), {
          previous,
          runtime,
          bindings: state.bindings,
          clients,
          oldPointer,
        });
      });
      prepared = true;
      for (const client of clients)
        yield* installMcpEffect(
          mcpCommand(client.kind, client.name, runtime, home),
          client.name,
          home,
        );
      yield* sync('Runtime.bindings', () => {
        for (const item of state.bindings) {
          if (readFileSync(item.path, 'utf8') !== item.text)
            throw new Error(`Project binding changed during upgrade: ${item.path}`);
          privateJson(item.path, {
            ...item.binding,
            runtime,
            runtimeExecutable: runtimeExecutable(runtime),
          });
        }
        privateJson(pointer, { runtime, version });
      });
    }).pipe(Effect.scoped);
    const health = yield* startRuntimeEffect(home, runtime);
    if (health.version !== version || (health.runtime && health.runtime !== runtime))
      return yield* new AppError({
        code: 'runtime_verification',
        message: 'The supervisor did not start from the requested runtime.',
        status: 409,
      });
  });
  const outcome = yield* Effect.result(change);
  if (Result.isFailure(outcome)) {
    const rollback = yield* Effect.result(
      Effect.gen(function* () {
        yield* stopForMaintenanceEffect(home);
        yield* Effect.gen(function* () {
          yield* maintenanceLockEffect(home, 'supervisor.lock');
          if (prepared) {
            for (const client of clients) {
              if (client.server) {
                const desired = mcpCommand(client.kind, client.name, runtime, home);
                // Restore the exact prior executable too (legacy runtimes may require Node).
                desired.server = client.server;
                desired.args = mcpAddArgs(client.kind, client.name, client.server);
                yield* installMcpEffect(desired, client.name, home);
              } else yield* removeMcpEffect(home, client.kind, client.name);
              yield* sync('Runtime.restoreClientReceipt', () => {
                const file = client.receiptPath;
                if (client.receipt) writeFileSync(file, client.receipt, { mode: 0o600 });
                else if (existsSync(file)) unlinkSync(file);
              });
            }
            yield* sync('Runtime.restoreState', () => {
              for (const item of state.bindings)
                writeFileSync(item.path, item.text, { mode: 0o600 });
              for (const suffix of ['-wal', '-shm'])
                if (existsSync(resolve(home, 'state.sqlite' + suffix)))
                  unlinkSync(resolve(home, 'state.sqlite' + suffix));
              if (existsSync(resolve(backup, 'state.sqlite'))) {
                writeFileSync(
                  resolve(home, 'state.sqlite'),
                  readFileSync(resolve(backup, 'state.sqlite')),
                  { mode: 0o600 },
                );
              } else if (existsSync(resolve(home, 'state.sqlite')))
                unlinkSync(resolve(home, 'state.sqlite'));
              if (oldPointer) writeFileSync(pointer, oldPointer, { mode: 0o600 });
              else if (existsSync(pointer)) unlinkSync(pointer);
            });
          }
        }).pipe(Effect.scoped);
        if (wasRunning && previous) yield* startRuntimeEffect(home, previous);
      }),
    );
    if (Result.isSuccess(rollback))
      yield* sync('Runtime.removeBackup', () => rmSync(backup, { recursive: true }));
    return yield* new AppError({
      code: 'upgrade_failed',
      message: `Upgrade failed: ${outcome.failure.message}\n${Result.isSuccess(rollback) ? 'Previous runtime and configuration restored.' : 'Automatic rollback needs attention: ' + rollback.failure.message + '\nRecovery backup: ' + backup}`,
      status: 500,
    });
  }
  yield* sync('Runtime.removeBackup', () => rmSync(backup, { recursive: true }));
  return { updated: true, version, runtime, previous, projects: state.projects.length };
}, Effect.scoped);

import { execEffect } from './process.js';
import { mcpAddArgs, removeMcpEffect } from './mcp-registration.js';
const awaitVersionEffect = Effect.fn('Runtime.verifyPackage')(function* (runtime: string) {
  const result = yield* execEffect(
    runtimeExecutable(runtime),
    [resolve(runtime, 'dist/cli.js'), '--version'],
    { timeout: 10000 },
  );
  return result.stdout.trim();
});
