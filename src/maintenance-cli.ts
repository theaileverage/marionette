import { Effect } from 'effect';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prompts, promptEffect } from './cli-prompts.js';
import { sync } from './effect-runtime.js';
import { readInstanceState, runtimeVersion } from './instance-state.js';
import {
  changeGlobalPackageEffect,
  downloadPackageEffect,
  globalPackagesEffect,
  latestVersionEffect,
} from './package-management.js';
import { findBinding } from './project-binding.js';
import { inspectRemovalEffect, removeProjectsEffect } from './removal.js';
import { packageRoot } from './runtime.js';
import { runtimeStatusEffect, upgradeInstanceEffect } from './runtime-upgrade.js';
import { AppError } from './types.js';

export const maintenanceCommandEffect = Effect.fn('CLI.maintenance')(function* (
  command: string,
  args: string[],
  defaultHome: string,
) {
  const update = command === 'update' || command === 'upgrade';
  const values = yield* sync(
    'Maintenance.arguments',
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          home: { type: 'string' },
          project: { type: 'string' },
          'project-id': { type: 'string' },
          from: { type: 'string' },
          global: { type: 'boolean' },
          'runtime-only': { type: 'boolean' },
          yes: { type: 'boolean' },
          json: { type: 'boolean' },
          'dry-run': { type: 'boolean' },
          check: { type: 'boolean' },
          'stop-agents': { type: 'boolean' },
          'keep-herdr': { type: 'boolean' },
          force: { type: 'boolean' },
          help: { type: 'boolean' },
        },
      }).values,
  );
  if (values.help) {
    console.log(
      update
        ? 'Usage: marionette update|upgrade [--home DIR] [--project DIR] [--check|--dry-run] [--json]\n  --from DIR upgrades from a local built package.\n  --runtime-only leaves any global CLI package unchanged.\nUpdates all projects sharing this instance; preserves workers and rolls back a failed restart.'
        : `Usage: marionette ${command} [--home DIR] [--yes] [--dry-run] [--json]\n${command === 'remove' ? '  --project DIR or --project-id ID selects one project.\n' : '  --global also uninstalls detected Bun/npm global CLI packages.\n'}  --stop-agents permits closing verified lead and worker panes.\n  --keep-herdr retains Herdr resources.\n--force discards unfinished tasks/waits, closes verified agents and retains unverified/busy panes.\nUnresolved operations and existing managed worktrees must be resolved first, even with --force. Source files are preserved.`,
    );
    return;
  }
  const invalid = update
    ? ['project-id', 'stop-agents', 'keep-herdr', 'force']
    : [
        'from',
        'runtime-only',
        'check',
        ...(command === 'remove' ? ['global'] : ['project', 'project-id']),
      ];
  for (const key of invalid)
    if (args.some((arg) => arg === '--' + key || arg.startsWith('--' + key + '=')))
      return yield* new AppError({
        code: 'invalid_option',
        message: `--${key} is not supported by ${command}.`,
        status: 400,
      });
  if (values.from && values.global)
    return yield* new AppError({
      code: 'invalid_option',
      message:
        '--from cannot replace a global package; it updates the saved runtime from a local build.',
      status: 400,
    });
  if (values['keep-herdr'] && values['stop-agents'])
    return yield* new AppError({
      code: 'invalid_option',
      message: 'Choose either --keep-herdr or --stop-agents.',
      status: 400,
    });
  const home = yield* sync('Maintenance.home', () => {
    if (values.home) return resolve(values.home);
    if (values.project && existsSync(resolve(values.project, '.marionette/project.json')))
      return findBinding(values.project).binding.home;
    if (command === 'remove' || update) {
      try {
        return findBinding(values.project).binding.home;
      } catch {
        /* No project binding: use the explicitly configured/default instance. */
      }
    }
    return resolve(defaultHome);
  });
  const json = values.json === true;
  const interactive = process.stdin.isTTY && !json;
  const print = <T>(value: T) => console.log(JSON.stringify(value, null, 2));
  if (update) {
    const localSource = values.from;
    const version = localSource
      ? yield* sync('Package.local', () => runtimeVersion(realpathSync(localSource)))
      : yield* latestVersionEffect();
    const globals = !values.from && !values['runtime-only'] ? yield* globalPackagesEffect() : [];
    const status = existsSync(resolve(home, 'config.json'))
      ? yield* runtimeStatusEffect(home)
      : undefined;
    const plan = {
      home,
      currentCli: runtimeVersion(packageRoot),
      latest: version,
      projects: status?.projects ?? [],
      savedVersions: status?.versions ?? [],
      runningVersion: status?.runningVersion,
      globalPackages: globals,
    };
    if (values.check || values['dry-run']) {
      print(plan);
      return;
    }
    if (!status && !globals.length)
      return yield* new AppError({
        code: 'nothing_to_update',
        message:
          'No configured instance or global Marionette installation found. Run setup first or pass --home DIR.',
        status: 404,
      });
    if (interactive)
      prompts.log.info(
        `Updating to ${version}; ${plan.projects.length} project(s) share this supervisor.`,
        { output: process.stderr },
      );
    const progress = interactive ? prompts.spinner({ output: process.stderr }) : undefined;
    progress?.start('Preparing the runtime update');
    const work = Effect.gen(function* () {
      const source = values.from
        ? realpathSync(values.from)
        : yield* downloadPackageEffect(version);
      const runtime = status ? yield* upgradeInstanceEffect(home, source) : undefined;
      const packages = [];
      for (const pkg of globals)
        if (pkg.version !== version)
          packages.push(
            yield* changeGlobalPackageEffect(pkg, version).pipe(
              Effect.mapError(
                (error) =>
                  new AppError({
                    code: 'global_update_failed',
                    message: `${runtime ? 'The instance runtime was updated successfully. ' : ''}Global CLI update failed: ${error.message}. Retry update to finish the global installation.`,
                    status: 500,
                  }),
              ),
            ),
          );
      return { ok: true, runtime, globalPackages: packages };
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.sync(() =>
          progress?.stop(exit._tag === 'Success' ? 'Update complete' : 'Update failed'),
        ),
      ),
    );
    const result = yield* work;
    if (json) print(result);
    else
      console.log(
        `Marionette ${version} is ready. ${plan.projects.length} project binding(s) updated. Refresh or restart agent MCP clients to load the new runtime.`,
      );
    return;
  }
  const all = command === 'uninstall';
  const globals = all && values.global ? yield* globalPackagesEffect() : [];
  if (!existsSync(resolve(home, 'config.json'))) {
    if (!all || !globals.length)
      return yield* new AppError({
        code: 'not_configured',
        message: `No Marionette instance found at ${home}.`,
        status: 404,
      });
    if (values['dry-run']) {
      print({ home, projects: [], globalPackages: globals });
      return;
    }
    yield* confirmRemovalEffect(
      'Uninstall the detected global Marionette CLI packages?',
      values.yes === true,
      interactive,
    );
    const removed = [];
    for (const pkg of globals) removed.push(yield* changeGlobalPackageEffect(pkg));
    print({ ok: true, globalPackages: removed });
    return;
  }
  const state = yield* sync('Removal.state', () => readInstanceState(home));
  const ids = yield* sync('Removal.selection', () => {
    if (all) return state.projects.map((p) => p.id);
    if (values['project-id']) return [values['project-id']];
    const root = values.project ? resolve(values.project) : undefined;
    if (root) {
      const project = state.projects.find(
        (p) => p.root === (existsSync(root) ? realpathSync(root) : root),
      );
      if (project) return [project.id];
    }
    return [findBinding(root).binding.projectId];
  });
  if (ids.some((id) => !state.projects.some((p) => p.id === id)))
    return yield* new AppError({
      code: 'project_not_found',
      message: 'The selected project does not belong to this Marionette instance.',
      status: 404,
    });
  const options = {
    all,
    stopAgents: values['stop-agents'] === true,
    keepHerdr: values['keep-herdr'] === true,
    force: values.force === true,
  };
  const plan = { ...(yield* inspectRemovalEffect(state, ids, options)), globalPackages: globals };
  if (values['dry-run']) {
    print(plan);
    return;
  }
  if (plan.blockers.length)
    return yield* new AppError({
      code: 'removal_blocked',
      message:
        plan.blockers.join('\n') +
        (options.force
          ? ''
          : '\nUse --force to discard unfinished tasks/waits and close verified agents while preserving unverified panes. Review with --force --dry-run first.'),
      status: 409,
    });
  if (interactive && options.force)
    prompts.log.warn(
      options.keepHerdr
        ? 'Force removal discards unfinished task/wait records. All Herdr terminals are retained.'
        : 'Force removal discards unfinished task/wait records and closes verified agents. Unverified or busy panes are retained. Use --keep-herdr to retain all terminals.',
      { output: process.stderr },
    );
  if (interactive && plan.preserved.length)
    prompts.note(plan.preserved.join('\n'), 'Retained resources', { output: process.stderr });
  if (interactive)
    prompts.note(
      `${plan.projects.map((p) => p.name + ' — ' + p.root).join('\n')}\n${plan.records} stored records will be deleted.\n${all ? 'The instance state, logs, saved runtimes, archives and recovery backups will be deleted.' : 'Shared state and MCP registrations remain while other projects use them.'}\n${globals.length} global CLI package(s) will be removed.\nProject source files are preserved.`,
      'Removal preview',
      { output: process.stderr },
    );
  yield* confirmRemovalEffect(
    all ? 'Uninstall this Marionette instance?' : 'Remove this project from Marionette?',
    values.yes === true,
    interactive,
  );
  const result = yield* removeProjectsEffect(home, ids, options);
  const removed = [];
  for (const pkg of globals) removed.push(yield* changeGlobalPackageEffect(pkg));
  if (json) print({ ok: true, ...result, globalPackages: removed });
  else
    console.log(
      `${all ? 'Marionette instance uninstalled' : 'Project removed from Marionette'}. Source files preserved.${globals.length ? ' Global CLI packages removed.' : ''}${result.preserved.length ? '\n' + result.preserved.join('\n') : ''}`,
    );
}, Effect.scoped);
const confirmRemovalEffect = Effect.fn('Removal.confirm')(function* (
  message: string,
  yes: boolean,
  interactive: boolean,
) {
  if (yes) return;
  if (!interactive)
    return yield* new AppError({
      code: 'confirmation_required',
      message: 'Review --dry-run, then pass --yes to confirm removal.',
      status: 400,
    });
  const confirmed = yield* promptEffect((signal) =>
    prompts.confirm({ message, initialValue: false, signal, output: process.stderr }),
  );
  if (!confirmed) {
    prompts.cancel('Removal cancelled.', { output: process.stderr });
    return yield* new AppError({
      code: 'operation_cancelled',
      message: 'Removal cancelled.',
      status: 400,
    });
  }
});
