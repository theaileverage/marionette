import { Config, Effect, Result } from 'effect';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { prompts, promptEffect } from './cli-prompts.js';
import { sync } from './effect-runtime.js';
import { execEffect } from './process.js';
import type { SetupOptions } from './setup.js';
import { AppError } from './types.js';

interface ToolRequirement {
  binary: string;
  required: boolean;
  help: string;
}
export function setupRequirements(options: Pick<SetupOptions, 'lead' | 'mcp'>): ToolRequirement[] {
  const lead = options.lead === 'codex-desktop' ? 'codex' : options.lead;
  return [
    {
      binary: 'git',
      required: true,
      help: 'Install Git with your system package manager (macOS: xcode-select --install or brew install git).',
    },
    { binary: 'herdr', required: true, help: 'Install Herdr: https://herdr.dev/docs/install/' },
    ...['codex', 'claude', 'agy', 'omp'].map((binary) => ({
      binary,
      required: binary === lead && (options.lead !== 'codex-desktop' || options.mcp === 'install'),
      help:
        binary === 'agy'
          ? 'Install AGY and sign in before using it: https://antigravity.google/'
          : `Install ${binary} and sign in before starting the lead.`,
    })),
  ];
}
type ToolInstaller = { binary: string; args: string[] } | { url: string; shell: string };
export function toolInstaller(
  binary: string,
  brew: boolean,
  npm: boolean,
): ToolInstaller | undefined {
  if (binary === 'herdr')
    return brew
      ? { binary: 'brew', args: ['install', 'herdr'] }
      : { url: 'https://herdr.dev/install.sh', shell: 'sh' };
  if (binary === 'git' && brew) return { binary: 'brew', args: ['install', 'git'] };
  if (binary === 'codex' && npm) return { binary: 'npm', args: ['install', '-g', '@openai/codex'] };
  if (binary === 'omp')
    return { binary: process.execPath, args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] };
  if (binary === 'claude') return { url: 'https://claude.ai/install.sh', shell: 'bash' };
  return undefined;
}

/** Make standard user-local installer locations available to this process and its children. */
export const toolPathEffect = Effect.fn('Setup.toolPath')(function* () {
  const path = yield* Config.string('PATH').pipe(Config.withDefault(''));
  const paths = path.split(delimiter);
  for (const dir of [resolve(homedir(), '.local/bin')]) if (!paths.includes(dir)) paths.push(dir);
  yield* sync('Setup.toolPath', () => {
    process.env.PATH = paths.join(delimiter);
  });
});

export function versionAtLeast(output: string, minimum: [number, number, number]) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

export const ensureDependenciesEffect = Effect.fn('Setup.dependencies')(function* (
  options: Pick<SetupOptions, 'lead' | 'mcp' | 'installTools'>,
  interactive: boolean,
) {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return yield* new AppError({
      code: 'setup_platform',
      message: 'Marionette requires macOS or Linux.',
      status: 400,
    });
  if (!versionAtLeast(process.versions.bun ?? '', [1, 3, 14]))
    return yield* new AppError({
      code: 'setup_runtime',
      message: 'Marionette requires Bun 1.3.14 or newer. Upgrade Bun, then run setup again.',
      status: 400,
    });
  yield* toolPathEffect();
  const requirements = setupRequirements(options);
  const checks = yield* Effect.forEach(
    requirements,
    (tool) =>
      execEffect(tool.binary, ['--version'], { timeout: 10000 }).pipe(
        Effect.match({
          onSuccess: ({ stdout, stderr }) => ({
            ...tool,
            available: true,
            version: (stdout || stderr).trim().split('\n')[0],
          }),
          onFailure: () => ({ ...tool, available: false, version: '' }),
        }),
      ),
    { concurrency: 5 },
  );
  if (interactive)
    for (const check of checks) {
      const message = `${check.binary}: ${check.available ? check.version : check.required ? 'missing or not runnable (required)' : 'not installed (optional worker)'}`;
      prompts.log.info(message, { output: process.stderr });
    }
  const herdr = checks.find((tool) => tool.binary === 'herdr');
  if (herdr?.available && !versionAtLeast(herdr.version, [0, 9, 0]))
    return yield* new AppError({
      code: 'setup_dependency',
      status: 400,
      message: `Herdr 0.9.0 or newer is required; found ${herdr.version}. Upgrade Herdr before setup (herdr update; use --handoff to preserve active sessions).`,
    });
  const missing = checks.filter((tool) => tool.required && !tool.available);
  if (!missing.length) return checks;
  const brew = Result.isSuccess(
    yield* Effect.result(execEffect('brew', ['--version'], { timeout: 10000 })),
  );
  const npm = Result.isSuccess(
    yield* Effect.result(execEffect('npm', ['--version'], { timeout: 10000 })),
  );
  const installs = missing.map((tool) => ({
    tool,
    command: toolInstaller(tool.binary, brew, npm),
  }));
  const manual = installs.filter(({ command }) => !command);
  if (manual.length)
    return yield* new AppError({
      code: 'setup_dependency',
      status: 400,
      message: manual.map(({ tool }) => `${tool.binary}: ${tool.help}`).join('\n'),
    });
  const description = installs
    .map(
      ({ command }) =>
        command &&
        ('url' in command
          ? `${command.shell} installer from ${command.url}`
          : [command.binary, ...command.args].join(' ')),
    )
    .join('\n');
  const approved =
    options.installTools ||
    (interactive &&
      (yield* promptEffect((signal) =>
        prompts.confirm({
          message: `Install missing required tools?\n${description}`,
          initialValue: false,
          signal,
          output: process.stderr,
        }),
      )));
  if (!approved)
    return yield* new AppError({
      code: 'setup_dependency',
      status: 400,
      message: `Missing required tools: ${missing.map((tool) => tool.binary).join(', ')}.\n${description}\nRun setup --install-tools to install them, or install them yourself and repeat setup.`,
    });
  for (const { tool, command } of installs) {
    if (!command) continue;
    const progress = interactive ? prompts.spinner({ output: process.stderr }) : undefined;
    progress?.start(`Installing ${tool.binary}`);
    const installation = Effect.gen(function* () {
      if ('url' in command) {
        const dir = yield* Effect.acquireRelease(
          sync('Setup.installerDirectory', () =>
            mkdtempSync(resolve(tmpdir(), 'marionette-install-')),
          ),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const file = resolve(dir, 'install.sh');
        yield* execEffect(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '--location',
            '--proto',
            '=https',
            '--proto-redir',
            '=https',
            '--max-time',
            '120',
            command.url,
            '--output',
            file,
          ],
          { timeout: 125000 },
        );
        yield* execEffect(command.shell, [file], { timeout: 300000 });
      } else yield* execEffect(command.binary, command.args, { timeout: 300000 });
      const version = yield* execEffect(tool.binary, ['--version'], { timeout: 10000 });
      tool.version = (version.stdout || version.stderr).trim().split('\n')[0];
      if (tool.binary === 'herdr' && !versionAtLeast(tool.version, [0, 9, 0]))
        return yield* new AppError({
          code: 'setup_dependency',
          message: `Herdr installation did not provide version 0.9.0 or newer: ${tool.version}`,
          status: 400,
        });
      tool.available = true;
    }).pipe(Effect.scoped);
    yield* installation.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          progress?.stop(
            exit._tag === 'Success'
              ? `${tool.binary} installed`
              : `${tool.binary} installation failed`,
          ),
        ),
      ),
    );
  }
  if (interactive)
    prompts.log.info(
      'Agent installation does not sign you in. Complete the agent’s login before starting your lead.',
      { output: process.stderr },
    );
  return checks;
});
