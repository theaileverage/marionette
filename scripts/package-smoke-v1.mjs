import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) =>
  (
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }) ?? ''
  ).trim();
const packageVersion = (output) => {
  try {
    return JSON.parse(output).version;
  } catch {
    return output;
  }
};

export function requireSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  assert.ok(
    major > 24 || (major === 24 && minor >= 10),
    'Marionette v1 requires Node.js 26.8.1 or newer',
  );
}

export function smokePackage(tarball) {
  requireSupportedNode();
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const archive = resolve(tarball);
  assert.ok(existsSync(archive), `Package tarball does not exist: ${archive}`);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-package-')));
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [pkg.name]: archive } }),
    );
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory,
      timeout: 60000,
    });
    const installed = join(directory, 'node_modules', ...pkg.name.split('/'));
    const cli = join(directory, 'node_modules', '.bin', 'marionette');
    assert.equal(packageVersion(run(process.execPath, [cli, '--version'])), pkg.version);
    for (const path of [
      'dist/v1/cli.js',
      'dist/v1/index.js',
      'dist/v1/sql-worker.js',
      'dist/herdr-sdk.js',
      'dist/herdr-protocol.js',
      'dist/herdr-streams.js',
      'dist/herdr-transport.js',
      'workflows/feature.json',
      'vendor/herdr-0.9.0/LICENSE',
    ])
      assert.ok(existsSync(join(installed, path)), `Package omits ${path}`);
    const project = join(directory, 'project');
    const stateHome = join(directory, 'state');
    mkdirSync(project);
    const isolatedEnv = {
      ...process.env,
      MARIONETTE_CONTEXT: '',
      MARIONETTE_STATE_HOME: stateHome,
    };
    const setup = JSON.parse(
      run(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { Marionette } from ${JSON.stringify(pkg.name)};
           const client = Marionette.init({ repositoryRoot: ${JSON.stringify(project)}, stateHome: ${JSON.stringify(stateHome)} });
           try {
             const thread = client.createThread({ title: 'package smoke', idempotencyKey: 'package-smoke-thread' });
             client.post({ threadId: thread.id, body: 'installed SDK post', kind: 'progress', idempotencyKey: 'package-smoke-post' });
             console.log(JSON.stringify({ context: client.context(), threadId: thread.id }));
           } finally {
             client.close();
           }`,
        ],
        { cwd: directory, env: isolatedEnv },
      ),
    );
    assert.equal(setup.context.project.repositoryRoot, project);
    assert.equal(setup.context.bindingPath, join(project, '.marionette-v1', 'project.json'));
    const readInput = join(directory, 'board-read.json');
    writeFileSync(readInput, JSON.stringify({ operation: 'board.read', threadId: setup.threadId }));
    const read = JSON.parse(
      run(
        process.execPath,
        [cli, 'exec', '--project', setup.context.bindingPath, '--input', readInput],
        {
          cwd: directory,
          env: isolatedEnv,
        },
      ),
    );
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].body, 'installed SDK post');
    const flaggedRead = JSON.parse(
      run(
        process.execPath,
        [
          cli,
          'board',
          'read',
          '--project',
          setup.context.bindingPath,
          '--thread-id',
          setup.threadId,
          '--output',
          'json',
        ],
        { cwd: directory, env: isolatedEnv },
      ),
    );
    assert.deepEqual(flaggedRead, read);
    const contract = JSON.parse(
      run(process.execPath, [cli, 'schema', 'board.read', '--output', 'json'], {
        cwd: directory,
        env: isolatedEnv,
      }),
    );
    assert.equal(contract.version, pkg.version);
    assert.equal(contract.operations[0].operation, 'board.read');
    assert.equal(contract.operations[0].outputSchema.type, 'object');
    assert.ok(contract.operations[0].flags.some((flag) => flag.name === 'thread-id'));

    const sqlInput = join(directory, 'sql-read.json');
    writeFileSync(sqlInput, JSON.stringify({ operation: 'sql.read', sql: 'SELECT 1 AS value' }));
    const sql = JSON.parse(
      run(
        process.execPath,
        [cli, 'exec', '--project', setup.context.bindingPath, '--input', sqlInput],
        {
          cwd: directory,
          env: isolatedEnv,
        },
      ),
    );
    assert.equal(sql.rows[0].value, 1);
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { Marionette } from ${JSON.stringify(pkg.name)};
         import { HERDR_PROTOCOL, HerdrClient } from ${JSON.stringify(`${pkg.name}/herdr-sdk`)};
         import { loadPackage } from ${JSON.stringify(pkg.name)};
         import { composeAdapter, defineCapability, AdapterRegistry } from ${JSON.stringify(`${pkg.name}/adapters`)};
         import { createHerdrAdapter } from ${JSON.stringify(`${pkg.name}/adapters/herdr`)};
         import { createCodexAppServerAdapter } from ${JSON.stringify(`${pkg.name}/adapters/codex-app-server`)};
         import { z } from 'zod';
         const adapter = composeAdapter({ id: 'package-fixture', version: 1 }, { echo: defineCapability({ input: z.string(), output: z.string(), effect: 'read', summary: 'Installed fixture.', execute: (text) => text }) });
         const registry = new AdapterRegistry([adapter]);
         if (await registry.get({ id: 'package-fixture', version: 1 }).dispatch('echo', 'installed') !== 'installed') process.exit(1);
         const native = createHerdrAdapter({ prepare: async () => ({ kind: 'rejected', reason: 'Smoke only inspects the schema' }) });
         if (native.describe().capabilities.length !== 8 || typeof createCodexAppServerAdapter !== 'function') process.exit(1);

         const feature = loadPackage('feature');
         if (typeof Marionette.connect !== 'function' || HERDR_PROTOCOL !== 22 || feature.name !== 'feature') process.exit(1);
         new HerdrClient('/tmp/marionette-v1-smoke.sock');`,
      ],
      { cwd: directory, env: isolatedEnv },
    );
    const typecheck = join(directory, 'sdk-smoke.mts');
    writeFileSync(
      typecheck,
      `import { Marionette } from ${JSON.stringify(pkg.name)};
       import { HerdrClient } from ${JSON.stringify(`${pkg.name}/herdr-sdk`)};
       const client = new HerdrClient('/tmp/marionette-v1-smoke.sock');
       const marionette: typeof Marionette = Marionette;
       void client.request('ping');
       void marionette;
       import { composeAdapter, defineCapability } from ${JSON.stringify(`${pkg.name}/adapters`)};
       import { z } from 'zod';
       const adapter = composeAdapter({ id: 'declaration-fixture', version: 1 }, { echo: defineCapability({ input: z.string(), output: z.string(), effect: 'read', summary: 'Type fixture.', execute: (text) => text }) });
       const echoed: Promise<string> = adapter.invoke('echo', 'typed');
       // @ts-expect-error Installed declarations must retain capability input types.
       void adapter.invoke('echo', 42);
       void echoed;\n`,
    );
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          types: ['node'],
          typeRoots: [join(root, 'node_modules', '@types')],
        },
        files: [basename(typecheck)],
      }),
    );
    run(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '--project', 'tsconfig.json'],
      {
        cwd: directory,
        timeout: 30000,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tarball] = process.argv.slice(2);
  if (!tarball) throw new Error('Use node scripts/package-smoke-v1.mjs TARBALL');
  smokePackage(tarball);
  console.log(`Installed package smoke passed: ${tarball}`);
}
