import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const scratch = join(root, '.test-output', `package-smoke-${process.pid}`);

const staged = join(scratch, 'package');

mkdirSync(staged, { recursive: true });

for (const file of [
  'dist',
  'workflows',
  'skills',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]) {
  cpSync(join(root, file), join(staged, file), { recursive: true });
}

symlinkSync(join(root, 'node_modules'), join(staged, 'node_modules'), 'dir');

const repo = join(scratch, 'repo');

mkdirSync(repo);

const env = { ...process.env, MARIONETTE_STATE_HOME: join(scratch, 'state') };

delete env.MARIONETTE_CONTEXT;

function cli(args, status = 0) {
  const result = spawnSync(process.execPath, [join(staged, 'dist/v1/cli.js'), ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr);

  return JSON.parse(status === 0 ? result.stdout : result.stderr);
}

try {
  assert.equal(cli(['--version']).version, manifest.version);
  cli(['init', '--project', repo, '--state-home', env.MARIONETTE_STATE_HOME]);
  assert.ok(existsSync(join(repo, '.agents/skills/marionette/SKILL.md')));
  const context = cli(['context']);

  const thread = cli([
    'board',
    'create',
    '--title',
    'Packaged Effect smoke',
    '--idempotency-key',
    'thread',
  ]);

  const post = cli([
    'board',
    'post',
    '--thread-id',
    thread.id,
    '--body',
    'Durable packaged result',
    '--kind',
    'result',
    '--idempotency-key',
    'post',
    '--no-watch',
  ]);

  const read = cli(['board', 'read', '--thread-id', thread.id]);
  assert.equal(read.entries[0].id, post.id);

  const sql = cli([
    'sql',
    'read',
    '--sql',
    'SELECT id FROM public_board_threads',
    '--max-rows',
    '10',
  ]);

  assert.equal(sql.rows[0].id, thread.id);
  assert.equal(cli(['board', 'read', '--no-such-flag'], 2).error.code, 'invalid-options');

  const stagedManifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));

  const imports = Object.keys(stagedManifest.exports).map((subpath) =>
    subpath === '.' ? stagedManifest.name : stagedManifest.name + subpath.slice(1));

  const importedPackage = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await Promise.all(${JSON.stringify(imports)}.map((name) => import(name)))`], {
    cwd: staged, encoding: 'utf8', timeout: 10_000,
  });

  assert.equal(importedPackage.status, 0, importedPackage.stderr);

  const consumer = join(staged, 'consumer.ts');
  writeFileSync(consumer, [
    "import { Effect, Schema } from 'effect';",
    `import { MarionetteService, marionetteLayer, OperationError, ClientOperationError, JobIdSchema } from '${stagedManifest.name}';`,
    "const id: typeof JobIdSchema.Type = Schema.decodeUnknownSync(JobIdSchema)('job-consumer');",
    "const program = Effect.gen(function* () { const client = yield* MarionetteService; return yield* client.execute({ operation: 'context' }); });",
    "const runnable = program.pipe(Effect.provide(marionetteLayer({ cwd: '/fixture' })));",
    "const knownErrors: ReadonlyArray<typeof OperationError | typeof ClientOperationError> = [OperationError, ClientOperationError];",
    "void id; void runnable; void knownErrors;",
  ].join('\n'));

  const types = spawnSync(join(root, 'node_modules/.bin/tsc'), [
    '--ignoreConfig', '--noEmit', '--target', 'ES2024', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', consumer,
  ], { cwd: staged, encoding: 'utf8', timeout: 30_000 });

  assert.equal(types.status, 0, types.stdout + types.stderr);

  const isolatedSdk = join(scratch, 'sdk-only');
  mkdirSync(isolatedSdk);
  writeFileSync(join(isolatedSdk, 'package.json'), '{"type":"module"}\n');

  for (const file of ['herdr-sdk', 'herdr-protocol', 'herdr-streams', 'herdr-transport']) {
    cpSync(join(staged, 'dist', `${file}.js`), join(isolatedSdk, `${file}.js`));
  }

  // Import in a directory with no package dependency links; static scan guards accidental Effect coupling.
  for (const file of ['herdr-sdk', 'herdr-protocol', 'herdr-streams', 'herdr-transport']) {
    assert.doesNotMatch(
      readFileSync(join(isolatedSdk, `${file}.js`), 'utf8'),
      /from ["'](?:effect|zod)(?:["'/])/,
    );
  }

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./herdr-sdk.js')"],
    {
      cwd: isolatedSdk,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  assert.equal(imported.status, 0, imported.stderr);
  writeFileSync(
    join(root, '.test-output/package-smoke.json'),
    JSON.stringify(
      {
        verified: [
          'staged CLI version',
          'project initialization and installed skill',
          'durable board roundtrip',
          'read-only SQL worker',
          'invalid-input exit code',
          'dependency-free Herdr SDK import',
          'all declared package export subpaths',
          'public Effect consumer declarations',
        ],
        cliVersion: manifest.version,
        projectId: context.project.id,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    'VERIFIED: staged root Marionette CLI, SQLite, resources, and Herdr SDK.\n',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
