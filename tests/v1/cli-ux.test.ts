import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { z } from 'zod';

import { bindingSchema } from '../../src/v1/context.js';
import {
  operationOutputSchemas,
  retirementPreviewOutputSchema,
} from '../../src/v1/output-contracts.js';

const projectRoot = process.cwd();
const buildDirectory = join(projectRoot, '.v1-test', 'cli-ux');
const cliPath = join(buildDirectory, 'cli.js');

type CliResult = { status: number | null; stdout: string; stderr: string };
type ProjectFixture = {
  cwd: string;
  root: string;
  repositoryRoot: string;
  stateHome: string;
  stateDirectory: string;
  bindingPath: string;
};
const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        fields: z.array(z.string()),
        retry: z.string(),
        mutation: z.enum(['not-started', 'unknown']),
      })
      .strict(),
  })
  .strict();
type MachineError = z.infer<typeof errorEnvelopeSchema>['error'];

before(async () => {
  rmSync(buildDirectory, { recursive: true, force: true });
  await build({
    entryPoints: { cli: 'src/v1/cli.ts', 'sql-worker': 'src/v1/sql-worker.ts' },
    outdir: buildDirectory,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: 'inline',
  });
});

function environment(stateHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    MARIONETTE_STATE_HOME: stateHome,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'MARIONETTE_CONTEXT')) delete result.MARIONETTE_CONTEXT;
  return result;
}

function runCli(
  args: readonly string[],
  options: { cwd: string; stateHome: string; input?: string; env?: NodeJS.ProcessEnv },
): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: environment(options.stateHome, options.env),
    input: options.input,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const ptyDriver = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execve(sys.argv[2], sys.argv[2:], os.environ)
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    os.write(1, data)
_, status = os.waitpid(pid, 0)
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + os.WTERMSIG(status))
`;

function runCliInPty(
  args: readonly string[],
  options: { cwd: string; stateHome: string },
): CliResult {
  const result = spawnSync(
    'python3',
    ['-c', ptyDriver, options.cwd, process.execPath, cliPath, ...args],
    {
      env: environment(options.stateHome),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function parseCliJson<Output>(result: CliResult, schema: z.ZodType<Output>): Output {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^\{.*\}\n$|^\[.*\]\n$/s);
  return schema.parse(JSON.parse(result.stdout));
}

function createProject(): ProjectFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-cli-')));
  const repositoryRoot = join(root, 'repository');
  const stateHome = join(root, 'state');
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.name', 'CLI Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  const context = parseCliJson(
    runCli(['init', '--project', repositoryRoot, '--state-home', stateHome, '--output', 'json'], {
      cwd: root,
      stateHome,
    }),
    operationOutputSchemas.context,
  );
  assert.doesNotMatch(JSON.stringify(context), /token/i);
  assert.deepEqual(context.authentication, {
    source: 'local-session-file',
    projectId: context.project.id,
    role: 'user',
    workspaceId: null,
  });
  return {
    cwd: repositoryRoot,
    root,
    repositoryRoot,
    stateHome,
    stateDirectory: context.project.stateDirectory,
    bindingPath: context.bindingPath,
  };
}

function assertMachineError(
  result: CliResult,
  expected: { status: number; code: string; fields?: readonly string[] },
): MachineError {
  assert.equal(result.status, expected.status);
  assert.equal(result.stdout, '');
  const envelope = errorEnvelopeSchema.parse(JSON.parse(result.stderr));
  assert.deepEqual(Object.keys(envelope), ['error']);
  assert.deepEqual(Object.keys(envelope.error), ['code', 'message', 'fields', 'retry', 'mutation']);
  assert.equal(envelope.error.code, expected.code);
  assert.deepEqual(envelope.error.fields, expected.fields ?? []);
  return envelope.error;
}

function retirementCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(
      database.prepare('SELECT count(*) AS count FROM workspace_retirements').get()?.count,
    );
  } finally {
    database.close();
  }
}

test('flags, file input, stdin, inline JSON, and full exec JSON produce the same raw result', () => {
  const fixture = createProject();
  try {
    const request = { title: 'CLI parity', idempotencyKey: 'cli-parity' };
    const requestPath = join(fixture.root, 'request.json');
    const fullRequest = { operation: 'board.create', ...request };
    writeFileSync(requestPath, JSON.stringify(request));
    const common = ['--project', fixture.bindingPath, '--output', 'json'];
    const flagsResult = parseCliJson(
      runCli(
        [
          'board',
          'create',
          '--title',
          request.title,
          '--idempotency-key',
          request.idempotencyKey,
          ...common,
        ],
        fixture,
      ),
      operationOutputSchemas['board.create'],
    );
    const equivalentResults = [
      parseCliJson(
        runCli(['board', 'create', '--input', requestPath, ...common], fixture),
        operationOutputSchemas['board.create'],
      ),
      parseCliJson(
        runCli(['board', 'create', '--input', '-', ...common], {
          ...fixture,
          input: JSON.stringify(request),
        }),
        operationOutputSchemas['board.create'],
      ),
      parseCliJson(
        runCli(['board', 'create', '--json', JSON.stringify(request), ...common], fixture),
        operationOutputSchemas['board.create'],
      ),
      parseCliJson(
        runCli(['exec', '--json', JSON.stringify(fullRequest), ...common], fixture),
        operationOutputSchemas['board.create'],
      ),
    ];
    for (const result of equivalentResults) assert.deepEqual(result, flagsResult);
    assert.equal(flagsResult.title, request.title);

    const post = parseCliJson(
      runCli(
        [
          'board',
          'post',
          '--thread-id',
          flagsResult.id,
          '--body',
          'No background process',
          '--kind',
          'progress',
          '--idempotency-key',
          'no-watcher',
          '--no-watch',
          ...common,
        ],
        fixture,
      ),
      operationOutputSchemas['board.post'],
    );
    assert.equal(post.body, 'No background process');
    assert.equal(existsSync(join(fixture.stateDirectory, 'watcher.log')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('invalid command input exits 2 before project discovery and never exposes parser input', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-cli-invalid-')));
  const stateHome = join(root, 'state');
  try {
    const cases = [
      {
        args: ['unknown-command', '--output', 'json'],
        code: 'unknown-command',
        fields: [],
      },
      {
        args: ['board', 'list', 'surplus', '--output', 'json'],
        code: 'extra-arguments',
        fields: [],
      },
      {
        args: [
          'board',
          'create',
          '--title',
          'TOP_SECRET_CONFLICT',
          '--json',
          '{"idempotencyKey":"key"}',
          '--output',
          'json',
        ],
        code: 'conflicting-input',
        fields: [],
      },
      {
        args: ['board', 'create', '--json', '{TOP_SECRET_JSON', '--output', 'json'],
        code: 'invalid-json',
        fields: [],
      },
      {
        args: ['board', 'create', '--idempotency-key', 'key', '--no-input', '--output', 'json'],
        code: 'invalid-input',
        fields: ['title'],
      },
      {
        args: ['board', 'list', '--limit', 'TOP_SECRET_NUMBER', '--output', 'json'],
        code: 'invalid-input',
        fields: ['limit'],
      },
    ];
    for (const entry of cases) {
      const result = runCli(entry.args, { cwd: root, stateHome });
      const error = assertMachineError(result, {
        status: 2,
        code: entry.code,
        fields: entry.fields,
      });
      assert.equal(error.mutation, 'not-started');
      assert.doesNotMatch(result.stderr, /TOP_SECRET|Zod|issues|received/i);
    }
    assert.equal(existsSync(stateHome), false);
    assert.equal(existsSync(join(root, '.marionette-v1')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed credential JSON is redacted at the process boundary', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-cli-credential-')));
  const stateHome = join(root, 'state');
  const contextPath = join(root, 'context.json');
  writeFileSync(contextPath, 'TOP_SECRET_CREDENTIAL_FRAGMENT{');
  try {
    const result = runCli(['context', '--output', 'json'], {
      cwd: root,
      stateHome,
      env: { MARIONETTE_CONTEXT: contextPath },
    });
    const error = assertMachineError(result, { status: 1, code: 'operation-failed' });
    assert.equal(error.message, 'Stored or external JSON is invalid.');
    assert.equal(error.mutation, 'not-started');
    assert.doesNotMatch(result.stderr, /TOP_SECRET_CREDENTIAL_FRAGMENT|SyntaxError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TTY defaults to bounded escaped human output while an explicit machine mode stays machine-readable', () => {
  const fixture = createProject();
  try {
    const title = `unsafe\u001b[31m\u009b${'x'.repeat(5_000)}`;
    parseCliJson(
      runCli(
        [
          'board',
          'create',
          '--json',
          JSON.stringify({ title, idempotencyKey: 'human-output' }),
          '--project',
          fixture.bindingPath,
          '--output',
          'json',
        ],
        fixture,
      ),
      operationOutputSchemas['board.create'],
    );

    const human = runCliInPty(['board', 'list', '--project', fixture.bindingPath], fixture);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /Human output abbreviated/);
    assert.match(human.stdout, /\\u001b/);
    assert.match(human.stdout, /\\u009b/);
    assert.equal(human.stdout.includes('\u001b'), false);
    assert.equal(human.stdout.includes('\u009b'), false);
    assert.ok(Buffer.byteLength(human.stdout) < 4_200);

    const machine = runCliInPty(
      ['board', 'list', '--unknown=TOP_SECRET_PTY', '--output', 'json'],
      fixture,
    );
    assert.equal(machine.status, 2);
    const error = errorEnvelopeSchema.parse(JSON.parse(machine.stdout.trim()));
    assert.equal(error.error.code, 'invalid-options');
    assert.doesNotMatch(machine.stdout, /Error:|TOP_SECRET_PTY/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('workspace retirement dry-run validates its preview and leaves the real target and state unchanged', () => {
  const fixture = createProject();
  const workspacePath = join(fixture.root, 'workspace');
  const workspaceId = 'workspace_cli_dry_run';
  try {
    git(fixture.repositoryRoot, [
      'worktree',
      'add',
      '-q',
      '-b',
      'cli-dry-run',
      workspacePath,
      'HEAD',
    ]);
    const baseCommit = git(fixture.repositoryRoot, ['rev-parse', 'HEAD']);
    parseCliJson(
      runCli(
        [
          'workspace',
          'register',
          '--json',
          JSON.stringify({
            id: workspaceId,
            kind: 'isolated',
            path: workspacePath,
            repositoryRoot: fixture.repositoryRoot,
            baseCommit,
            access: 'write',
            writes: [],
            idempotencyKey: 'register-cli-dry-run',
          }),
          '--project',
          fixture.bindingPath,
          '--output',
          'json',
        ],
        fixture,
      ),
      operationOutputSchemas['workspace.register'],
    );
    const databasePath = bindingSchema.parse(
      JSON.parse(readFileSync(fixture.bindingPath, 'utf8')),
    ).databasePath;
    const beforeWorkspace = parseCliJson(
      runCli(
        [
          'workspace',
          'get',
          '--id',
          workspaceId,
          '--project',
          fixture.bindingPath,
          '--output',
          'json',
        ],
        fixture,
      ),
      operationOutputSchemas['workspace.get'],
    );
    const beforeBinding = readFileSync(fixture.bindingPath);
    const beforeWorktrees = git(fixture.repositoryRoot, ['worktree', 'list', '--porcelain']);
    assert.equal(retirementCount(databasePath), 0);

    const previewResult = runCli(
      [
        'workspace',
        'retire',
        '--workspace-id',
        workspaceId,
        '--idempotency-key',
        'preview-cli-dry-run',
        '--dry-run',
        '--project',
        fixture.bindingPath,
        '--output',
        'json',
      ],
      fixture,
    );
    const preview = parseCliJson(previewResult, retirementPreviewOutputSchema);
    assert.equal(preview.kind, 'ready');
    assert.equal(preview.workspaceId, workspaceId);
    assert.deepEqual(
      preview.effects.map((effect) => effect.kind),
      ['remove-worktree', 'mark-workspace-retired'],
    );

    assert.deepEqual(
      parseCliJson(
        runCli(
          [
            'workspace',
            'get',
            '--id',
            workspaceId,
            '--project',
            fixture.bindingPath,
            '--output',
            'json',
          ],
          fixture,
        ),
        operationOutputSchemas['workspace.get'],
      ),
      beforeWorkspace,
    );
    assert.deepEqual(readFileSync(fixture.bindingPath), beforeBinding);
    assert.equal(git(fixture.repositoryRoot, ['worktree', 'list', '--porcelain']), beforeWorktrees);
    assert.equal(git(workspacePath, ['status', '--porcelain']), '');
    assert.equal(readFileSync(join(workspacePath, 'tracked.txt'), 'utf8'), 'base\n');
    assert.equal(retirementCount(databasePath), 0);

    const localCredential = join(fixture.stateDirectory, 'local-user.json');
    rmSync(localCredential);
    const missingCredential = runCli(
      [
        'workspace',
        'retire',
        '--workspace-id',
        workspaceId,
        '--idempotency-key',
        'preview-without-credential',
        '--dry-run',
        '--project',
        fixture.bindingPath,
        '--output',
        'json',
      ],
      fixture,
    );
    assertMachineError(missingCredential, { status: 1, code: 'operation-failed' });
    assert.equal(existsSync(localCredential), false);
    assert.equal(existsSync(workspacePath), true);
    assert.equal(retirementCount(databasePath), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
