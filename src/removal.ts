import { Database } from 'bun:sqlite';
import { Effect, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { herdrCall, sync } from './effect-runtime.js';
import { safePath } from './files.js';
import { Herdr } from './herdr.js';
import type { ResponseTypes } from './herdr-protocol.js';
import {
  assertRemovalReady,
  projectRecordKeys,
  readInstanceState,
  type InstanceState,
} from './instance-state.js';
import {
  maintenanceLockEffect,
  probeInstanceEffect,
  startRuntimeEffect,
  stopForMaintenanceEffect,
} from './maintenance.js';
import {
  ownsMcpServer,
  listClientReceipts,
  readMcpRegistration,
  removeMcpEffect,
} from './mcp-registration.js';
import { previousRuntime } from './runtime-upgrade.js';
import { removeWorkspaceTrust } from './workspace-trust.js';
import { AppError, type HerdrPort } from './types.js';

const identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const runSchema = Schema.Struct({
  taskId: Schema.String,
  paneId: Schema.optional(Schema.String),
  terminalId: Schema.optional(Schema.String),
  agentName: Schema.String,
  kind: Schema.String,
  nativeSession: Schema.optional(Schema.String),
});
const leadTerminalSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
  agent_session: Schema.optional(Schema.NullOr(Schema.Struct({ value: Schema.String }))),
});
interface PaneRemoval {
  paneId: string;
  terminalId: string;
  name?: string | null;
  kind?: string | null;
  nativeSession?: string | null;
  idleShell: boolean;
}
interface WorkspaceRemoval {
  projectId: string;
  socket: string;
  workspace: string;
  session: string;
  ownsWorkspace: boolean;
  ownsSession: boolean;
  panes: PaneRemoval[];
  offline: boolean;
}
export interface RemovalOptions {
  all: boolean;
  stopAgents: boolean;
  keepHerdr: boolean;
}

export const inspectRemovalEffect = Effect.fn('Removal.inspect')(function* (
  state: InstanceState,
  projectIds: string[],
  options: RemovalOptions,
  port: (socket: string) => HerdrPort = (socket) => new Herdr(socket),
) {
  const blockers = yield* sync('Removal.preflight', () => assertRemovalReady(state, projectIds));
  const workspaces: WorkspaceRemoval[] = [];
  const records = new Set(
    projectRecordKeys(state, projectIds).map((row) => row.kind + ':' + row.id),
  );
  const runs = state.rows
    .filter((row) => row.kind === 'run' && records.has(row.kind + ':' + row.id))
    .map((row) => Schema.decodeUnknownSync(runSchema)(JSON.parse(row.data)));
  for (const project of state.projects.filter((p) => projectIds.includes(p.id))) {
    const binding = state.bindings.find((b) => b.binding.projectId === project.id)?.binding;
    const target: WorkspaceRemoval = {
      projectId: project.id,
      socket: project.socketPath,
      workspace: project.workspaceId,
      session: project.session,
      ownsWorkspace: binding?.ownsWorkspace === true,
      ownsSession: binding?.ownsSession === true,
      panes: [],
      offline: false,
    };
    workspaces.push(target);
    if (options.keepHerdr) continue;
    if (
      state.projects.some(
        (p) =>
          !projectIds.includes(p.id) &&
          p.socketPath === project.socketPath &&
          p.workspaceId === project.workspaceId,
      )
    ) {
      blockers.push(
        `Workspace ${project.workspaceId} is shared with another project; use --keep-herdr.`,
      );
      continue;
    }
    const h = port(project.socketPath);
    const inspection = yield* Effect.result(
      herdrCall(h, 'pane.list', { workspace_id: project.workspaceId }),
    );
    if (Result.isFailure(inspection)) {
      if (!existsSync(project.socketPath)) {
        target.offline = true;
        blockers.push(
          `Session ${project.session} is offline; start it for inspection or use --keep-herdr to retain its resources.`,
        );
        continue;
      }
      blockers.push(`Cannot inspect ${project.session}: ${inspection.failure.message}`);
      continue;
    }
    const panes: ResponseTypes.PaneInfo[] = inspection.success.panes;
    const leadPath = resolve(state.home, 'leads', project.id + '.terminal.json');
    const lead = existsSync(leadPath)
      ? Schema.decodeUnknownSync(leadTerminalSchema)(JSON.parse(readFileSync(leadPath, 'utf8')))
      : undefined;
    for (const pane of panes) {
      const run = runs.find((r) => r.paneId === pane.pane_id && r.terminalId === pane.terminal_id);
      const ownedLead =
        lead?.pane_id === pane.pane_id && lead.terminal_id === pane.terminal_id ? lead : undefined;
      if (pane.agent) {
        const { agent }: { agent: ResponseTypes.AgentInfo } = yield* herdrCall(h, 'agent.get', {
          target: pane.pane_id,
        });
        const expectedName = run?.agentName ?? ownedLead?.name;
        const expectedKind = run?.kind ?? ownedLead?.agent;
        const expectedSession = run?.nativeSession ?? ownedLead?.agent_session?.value;
        if (
          !expectedName ||
          agent.name !== expectedName ||
          agent.agent !== expectedKind ||
          agent.terminal_id !== pane.terminal_id ||
          (expectedSession && agent.agent_session?.value !== expectedSession)
        ) {
          blockers.push(
            `Pane ${pane.pane_id} contains an unverified agent; preserve it or use --keep-herdr.`,
          );
          continue;
        }
        if (!options.stopAgents)
          blockers.push(
            `Agent ${expectedName} is still open; exit it or explicitly use --stop-agents.`,
          );
        target.panes.push({
          paneId: pane.pane_id,
          terminalId: pane.terminal_id,
          name: agent.name,
          kind: agent.agent,
          nativeSession: agent.agent_session?.value,
          idleShell: false,
        });
      } else {
        if (!target.ownsWorkspace && !run && !ownedLead) continue;
        const { process_info: info }: { process_info: ResponseTypes.PaneProcessInfo } =
          yield* herdrCall(h, 'pane.process_info', { pane_id: pane.pane_id });
        if (
          !info.shell_pid ||
          !info.foreground_processes?.length ||
          info.foreground_processes.some((p) => p.pid !== info.shell_pid)
        ) {
          blockers.push(
            `Pane ${pane.pane_id} is not an idle shell; stop its command before removal.`,
          );
          continue;
        }
        target.panes.push({ paneId: pane.pane_id, terminalId: pane.terminal_id, idleShell: true });
      }
    }
  }
  if (options.all) {
    if (
      [resolve('/'), resolve(homedir()), ...state.projects.map((p) => p.root)].includes(state.home)
    )
      blockers.push(
        'The state directory overlaps a protected directory. Refusing recursive uninstallation.',
      );
    const known =
      /^(?:config\.json|state\.sqlite(?:-wal|-shm)?|runtime\.json|supervisor\.log|(?:maintenance|supervisor|setup)\.lock|setup-project-[a-f0-9]+\.json|runtimes|updates|clients|trust|leads|archives|worktrees)$/;
    const unknown = readdirSync(state.home).filter((name) => !known.test(name));
    if (unknown.length)
      blockers.push(
        `Unrecognized files in the state directory must be moved before uninstallation: ${unknown.join(', ')}.`,
      );
    const worktrees = resolve(state.home, 'worktrees');
    if (
      existsSync(worktrees) &&
      readdirSync(worktrees).some((name) => {
        const path = resolve(worktrees, name);
        return !lstatSync(path).isDirectory() || readdirSync(path).length > 0;
      })
    )
      blockers.push(
        `Managed worktrees remain under ${worktrees}. Preserve or collect them before uninstalling.`,
      );
  }
  const removeClients = options.all || state.projects.every((p) => projectIds.includes(p.id));
  const clients = (['codex', 'claude', 'agy'] as const).flatMap((kind) =>
    listClientReceipts(state.home, kind).flatMap(({ receipt }) => {
      if (!removeClients && (!receipt.projectId || !projectIds.includes(receipt.projectId)))
        return [];
      const registration = readMcpRegistration(kind, receipt.name);
      if (registration && !ownsMcpServer(state.home, kind, receipt.name, registration.server))
        blockers.push(
          `${kind} MCP registration ${receipt.name} was changed outside Marionette; resolve it before removal.`,
        );
      return [{ kind, name: receipt.name }];
    }),
  );
  return {
    home: state.home,
    all: options.all,
    projects: state.projects
      .filter((p) => projectIds.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, root: p.root })),
    workspaces,
    clients,
    blockers,
    keepHerdr: options.keepHerdr,
    records: projectRecordKeys(state, projectIds).length,
    preserveSourceFiles: true,
  };
});

const recheckPaneEffect = Effect.fn('Removal.recheckPane')(function* (
  h: HerdrPort,
  pane: PaneRemoval,
) {
  const { pane: current }: { pane: ResponseTypes.PaneInfo } = yield* herdrCall(h, 'pane.get', {
    pane_id: pane.paneId,
  });
  if (current.terminal_id !== pane.terminalId)
    return yield* new AppError({
      code: 'removal_identity',
      message: `Pane ${pane.paneId} changed during removal.`,
      status: 409,
    });
  if (pane.idleShell) {
    const { process_info: info }: { process_info: ResponseTypes.PaneProcessInfo } =
      yield* herdrCall(h, 'pane.process_info', { pane_id: pane.paneId });
    if (
      current.agent ||
      !info.shell_pid ||
      !info.foreground_processes?.length ||
      info.foreground_processes.some((p) => p.pid !== info.shell_pid)
    )
      return yield* new AppError({
        code: 'removal_busy',
        message: `Pane ${pane.paneId} is no longer an idle shell.`,
        status: 409,
      });
  } else {
    const { agent }: { agent: ResponseTypes.AgentInfo } = yield* herdrCall(h, 'agent.get', {
      target: pane.paneId,
    });
    if (
      agent.name !== pane.name ||
      agent.agent !== pane.kind ||
      agent.terminal_id !== pane.terminalId ||
      agent.agent_session?.value !== pane.nativeSession
    )
      return yield* new AppError({
        code: 'removal_identity',
        message: `Agent in ${pane.paneId} changed during removal.`,
        status: 409,
      });
  }
});
export function deleteProjectRecords(home: string, state: InstanceState, ids: string[]) {
  if (!existsSync(resolve(home, 'state.sqlite'))) return;
  const db = new Database(resolve(home, 'state.sqlite'));
  try {
    db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    try {
      for (const { kind, id } of projectRecordKeys(state, ids))
        db.query('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
      for (const id of ids) db.query('DELETE FROM events WHERE project_id=?').run(id);
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
function removeProjectFiles(state: InstanceState, ids: string[]) {
  for (const { path, binding, text } of state.bindings.filter((b) =>
    ids.includes(b.binding.projectId),
  )) {
    if (readFileSync(path, 'utf8') !== text)
      throw new Error(`Binding changed during removal: ${path}`);
    unlinkSync(path);
    const dir = dirname(path),
      ignore = resolve(dir, '.gitignore');
    if (existsSync(ignore) && readFileSync(ignore, 'utf8') === '*\n') unlinkSync(ignore);
    if (!readdirSync(dir).length) rmdirSync(dir);
    const setupReceipt = resolve(
      state.home,
      'setup-project-' +
        createHash('sha256').update(binding.root).digest('hex').slice(0, 10) +
        '.json',
    );
    if (existsSync(setupReceipt)) unlinkSync(setupReceipt);
  }
  for (const id of ids) {
    Schema.decodeUnknownSync(identifier)(id);
    for (const suffix of ['.json', '.md', '.terminal.json']) {
      const path = safePath(state.home, `leads/${id}${suffix}`);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  for (const row of state.rows.filter((row) => row.kind === 'archive')) {
    const archive = Schema.decodeUnknownSync(Schema.Struct({ projectId: Schema.String }))(
      JSON.parse(row.data),
    );
    if (ids.includes(archive.projectId)) {
      Schema.decodeUnknownSync(identifier)(row.id);
      const path = safePath(state.home, `archives/${row.id}`);
      if (existsSync(path)) rmSync(path, { recursive: true });
    }
  }
}
export const removeProjectsEffect = Effect.fn('Removal.execute')(function* (
  home: string,
  ids: string[],
  options: RemovalOptions,
  port: (socket: string) => HerdrPort = (socket) => new Herdr(socket),
) {
  yield* maintenanceLockEffect(home);
  const before = yield* sync('Removal.state', () => readInstanceState(home));
  if (options.all && before.projects.some((p) => !ids.includes(p.id)))
    return yield* new AppError({
      code: 'removal_changed',
      message: 'Project list changed. Review uninstallation again.',
      status: 409,
    });
  const preview = yield* inspectRemovalEffect(before, ids, options, port);
  if (preview.blockers.length)
    return yield* new AppError({
      code: 'removal_blocked',
      message: preview.blockers.join('\n'),
      status: 409,
    });
  const health = yield* probeInstanceEffect(home);
  const previous = yield* sync('Removal.previousRuntime', () =>
    previousRuntime(before, health?.version, health?.runtime),
  );
  if (health && !previous)
    return yield* new AppError({
      code: 'runtime_missing',
      message:
        'The running supervisor runtime is missing. Restore it before removal so unaffected projects can restart.',
      status: 409,
    });
  yield* stopForMaintenanceEffect(home);
  const result = yield* Effect.result(
    Effect.gen(function* () {
      yield* maintenanceLockEffect(home, 'supervisor.lock');
      const state = yield* sync('Removal.stoppedState', () => readInstanceState(home));
      const plan = yield* inspectRemovalEffect(state, ids, options, port);
      if (plan.blockers.length)
        return yield* new AppError({
          code: 'removal_changed',
          message: plan.blockers.join('\n'),
          status: 409,
        });
      if (!options.keepHerdr)
        for (const workspace of plan.workspaces) {
          if (workspace.offline) continue;
          const h = port(workspace.socket);
          for (const pane of workspace.panes) yield* recheckPaneEffect(h, pane);
          if (workspace.ownsWorkspace) {
            const { panes }: { panes: ResponseTypes.PaneInfo[] } = yield* herdrCall(
              h,
              'pane.list',
              { workspace_id: workspace.workspace },
            );
            if (
              panes.length !== workspace.panes.length ||
              panes.some(
                (pane) =>
                  !workspace.panes.some(
                    (p) => p.paneId === pane.pane_id && p.terminalId === pane.terminal_id,
                  ),
              )
            )
              return yield* new AppError({
                code: 'removal_changed',
                message: 'Workspace contents changed during removal.',
                status: 409,
              });
            yield* herdrCall(h, 'workspace.close', { workspace_id: workspace.workspace });
          } else
            for (const pane of workspace.panes) {
              yield* recheckPaneEffect(h, pane);
              yield* herdrCall(h, 'pane.close', { pane_id: pane.paneId });
            }
          if (
            workspace.ownsSession &&
            !state.projects.some((p) => !ids.includes(p.id) && p.socketPath === workspace.socket)
          ) {
            const { workspaces }: { workspaces: ResponseTypes.WorkspaceInfo[] } = yield* herdrCall(
              h,
              'workspace.list',
            );
            if (!workspaces.length) yield* herdrCall(h, 'server.stop');
          }
        }
      for (const client of plan.clients) yield* removeMcpEffect(home, client.kind, client.name);
      yield* sync('Removal.files', () => {
        for (const id of ids) removeWorkspaceTrust(home, id);
        removeProjectFiles(state, ids);
        deleteProjectRecords(home, state, ids);
      });
      if (options.all)
        yield* sync('Removal.instance', () => {
          const remaining = readInstanceState(home);
          if (remaining.projects.length)
            throw new Error('Projects remain; refusing to delete the instance.');
          if (lstatSync(home).isSymbolicLink())
            throw new Error('Refusing to recursively remove a symlinked state directory.');
          rmSync(home, { recursive: true });
        });
      return {
        removedProjects: plan.projects,
        clients: plan.clients,
        herdrPreserved: options.keepHerdr,
        sourceFilesPreserved: true,
      };
    }).pipe(Effect.scoped),
  );
  if (
    !options.all &&
    health &&
    previous &&
    (Result.isFailure(result) || before.projects.some((p) => !ids.includes(p.id)))
  )
    yield* startRuntimeEffect(home, previous);
  if (Result.isFailure(result)) {
    if (options.all && health && previous) yield* startRuntimeEffect(home, previous);
    return yield* result.failure;
  }
  return { ...result.success, uninstalled: options.all };
}, Effect.scoped);
