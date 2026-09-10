import { Database } from 'bun:sqlite';
import { Schema } from 'effect';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { readBinding } from './project-binding.js';
import { projectSchema } from './response-schemas.js';
import { inside } from './files.js';

const rowSchema = Schema.Struct({ kind: Schema.String, id: Schema.String, data: Schema.String });
const referenceSchema = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});
export function readInstanceState(home: string) {
  home = realpathSync(home);
  const config = loadConfig(home);
  const database = resolve(home, 'state.sqlite');
  if (!existsSync(database))
    return { home, config, rows: [], projects: [], bindings: [], fingerprint: '' };
  // Node's SQLite removes WAL sidecars on clean shutdown. Bun needs read/write
  // access to recreate them, even for SELECTs; never create a missing database.
  const db = new Database(database, { readwrite: true, create: false });
  try {
    const rows = Schema.decodeUnknownSync(Schema.Array(rowSchema))(
      db.query('SELECT kind,id,data FROM records ORDER BY kind,id').all(),
    );
    const projects = rows
      .filter((row) => row.kind === 'project')
      .map((row) => Schema.decodeUnknownSync(projectSchema)(JSON.parse(row.data)));
    const bindings = projects.flatMap((project) => {
      if (!existsSync(resolve(project.root, '.marionette/project.json'))) return [];
      const value = readBinding(project.root);
      if (
        value.binding.projectId !== project.id ||
        realpathSync(value.binding.home) !== home ||
        value.binding.instanceId !== config.id
      )
        throw new Error(
          `Project binding for ${project.root} belongs to another instance. Repair it before maintenance.`,
        );
      return [value];
    });
    return {
      home,
      config,
      rows,
      projects,
      bindings,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(rows))
        .update(JSON.stringify(bindings.map((b) => b.text)))
        .digest('hex'),
    };
  } finally {
    db.close();
  }
}
export type InstanceState = ReturnType<typeof readInstanceState>;
export function projectRecordKeys(state: InstanceState, projectIds: string[]) {
  const projects = new Set(projectIds);
  const taskIds = new Set(
    state.rows
      .filter(
        (row) =>
          row.kind === 'task' &&
          projects.has(
            Schema.decodeUnknownSync(referenceSchema)(JSON.parse(row.data)).projectId ?? '',
          ),
      )
      .map((row) => row.id),
  );
  const directKinds = new Set([
    'project',
    'lead',
    'profiles',
    'profile-defaults',
    'roles',
    'limits',
    'cleanup-policy',
  ]);
  const prefixedKinds = new Set(['idempotency', 'cursor', 'model-catalog']);
  return state.rows
    .filter((row) => {
      if (directKinds.has(row.kind) && projects.has(row.id)) return true;
      if (prefixedKinds.has(row.kind) && projectIds.some((id) => row.id.startsWith(id + ':')))
        return true;
      const ref = Schema.decodeUnknownOption(referenceSchema)(JSON.parse(row.data));
      return (
        ref._tag === 'Some' &&
        (projects.has(ref.value.projectId ?? '') || taskIds.has(ref.value.taskId ?? ''))
      );
    })
    .map(({ kind, id }) => ({ kind, id }));
}
export function assertRemovalReady(state: InstanceState, projectIds: string[], force = false) {
  const keys = new Set(projectRecordKeys(state, projectIds).map((key) => key.kind + ':' + key.id));
  const blockers: string[] = [];
  for (const row of state.rows) {
    if (!keys.has(row.kind + ':' + row.id)) continue;
    if (row.kind === 'task') {
      const task = Schema.decodeUnknownSync(
        Schema.Struct({
          status: Schema.String,
          worktree: Schema.optional(Schema.Struct({ path: Schema.String })),
        }),
      )(JSON.parse(row.data));
      if (!force && !['completed', 'failed', 'cancelled'].includes(task.status))
        blockers.push(`Task ${row.id} is ${task.status}; finish or cancel it first.`);
      if (task.worktree && existsSync(task.worktree.path))
        blockers.push(
          `Preserve or collect managed worktree ${task.worktree.path} before removing its project.`,
        );
    }
    if (row.kind === 'operation') {
      const op = Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.String }))(
        JSON.parse(row.data),
      );
      if (op.phase !== 'done')
        blockers.push(`Operation ${row.id} is ${op.phase}; reconcile it first.`);
    }
    if (row.kind === 'lead-wait') {
      const wait = Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }))(
        JSON.parse(row.data),
      );
      if (!force && !['acknowledged', 'invalidated'].includes(wait.state))
        blockers.push(`Lead wait ${row.id} is ${wait.state}; acknowledge or reconcile it first.`);
    }
  }
  // A project stored inside the instance is source data, never an uninstall target.
  for (const p of state.projects)
    if (inside(state.home, p.root))
      blockers.push(
        `Project source ${p.root} is inside the state directory; relocate it before uninstallation.`,
      );
  return blockers;
}
export function runtimeVersion(runtime: string) {
  const path = resolve(runtime, 'package.json');
  return existsSync(path)
    ? Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
        JSON.parse(readFileSync(path, 'utf8')),
      ).version
    : 'missing';
}
