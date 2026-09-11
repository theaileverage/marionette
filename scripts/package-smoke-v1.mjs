import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    'Marionette v1 requires Node.js 24.10.0 or newer',
  );
}

export function smokePackage(tarball) {
  requireSupportedNode();
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const archive = resolve(tarball);
  assert.ok(existsSync(archive), `Package tarball does not exist: ${archive}`);
  const directory = mkdtempSync(join(tmpdir(), 'marionette-v1-package-'));
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
    const initialized = JSON.parse(
      run(process.execPath, [cli, 'init', '--project', project, '--state-home', stateHome]),
    );
    assert.equal(initialized.project.repositoryRoot, project);
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { Marionette } from ${JSON.stringify(pkg.name)};
         import { HERDR_PROTOCOL, HerdrClient } from ${JSON.stringify(`${pkg.name}/herdr-sdk`)};
         if (typeof Marionette.connect !== 'function' || HERDR_PROTOCOL !== 22) process.exit(1);
         new HerdrClient('/tmp/marionette-v1-smoke.sock');`,
      ],
      { cwd: directory },
    );
    const typecheck = join(directory, 'sdk-smoke.mts');
    writeFileSync(
      typecheck,
      `import { Marionette } from ${JSON.stringify(pkg.name)};
       import { HerdrClient } from ${JSON.stringify(`${pkg.name}/herdr-sdk`)};
       const client = new HerdrClient('/tmp/marionette-v1-smoke.sock');
       const marionette: typeof Marionette = Marionette;
       void client.request('ping');
       void marionette;\n`,
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
