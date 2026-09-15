import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const packagePath = join(root, 'package.json');

const changelogPath = join(root, 'CHANGELOG.md');

const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));

function run(argv, cwd, env = process.env) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  return result.stdout;
}

function check() {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.equal(manifest.private, undefined, 'The release package must be publishable');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.description && manifest.repository?.url && manifest.homepage && manifest.bugs?.url);
  assert.equal(manifest.engines.node, '>=26.8.1');
  assert.ok(readFileSync(changelogPath, 'utf8').includes(`## ${manifest.version}`));

  for (const name of ['check', 'test', 'build', 'prepack', 'format:check',
    'release:check', 'release:prepare', 'boundaries:check', 'package:smoke']) {
    assert.ok(Object.hasOwn(manifest.scripts, name) && manifest.scripts[name], `Missing script ${name}`);
  }

  const source = readFileSync(join(root, 'src/herdr-protocol.ts'), 'utf8');
  const contract = JSON.parse(readFileSync(join(root, 'vendor/herdr-0.9.0/contract.json')));
  assert.ok(source.includes(`HERDR_PROTOCOL = ${contract.protocol} as const`));
  assert.ok(source.includes(contract.schemaSha256));
  const methods = source.match(/export const HERDR_METHODS = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(methods, 'Missing generated method list');
  const entries = [...methods.matchAll(/^\s+'([^']+)',?$/gm)].map((match) => match[1]);
  assert.equal(entries.length, contract.methodCount);
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(source.includes('export type HerdrMethod = keyof HerdrParams'));

  for (const workflow of ['ci.yml', 'release.yml']) {
    const text = readFileSync(join(root, '.github/workflows', workflow), 'utf8');

    for (const match of text.matchAll(/npm run ([\w:-]+)/g))
      assert.ok(manifest.scripts[match[1]], `${workflow}: missing ${match[1]}`);
  }

  process.stdout.write(`VERIFIED: release scripts, version ${manifest.version}, and captured Herdr contract.\n`);
}

function prepare(version) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  const changelog = readFileSync(changelogPath, 'utf8');
  const previous = manifest.version;
  assert.ok(changelog.includes(`## ${previous}`), 'Current changelog entry missing');
  assert.ok(!changelog.includes(`## ${version}`), 'Target version already has a changelog entry');
  manifest.version = version;
  writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(changelogPath, changelog.replace(`## ${previous}`, `## ${version}`));
  process.stdout.write(`Prepared ${version}; review the changelog and update bun.lock before tagging.\n`);
}

function smoke(tarball) {
  assert.ok(tarball, 'Usage: node scripts/release.mjs smoke /absolute/path/to/package.tgz');
  const temp = mkdtempSync(join(tmpdir(), 'marionette-release-'));

  try {
    const project = join(temp, 'project');
    run([process.execPath, '-e', `require('fs').mkdirSync(${JSON.stringify(project)})`], root);
    run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefix', project, resolve(tarball)], root);
    const installed = join(project, 'node_modules/@theaileverage/marionette');
    const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(installedManifest.version, manifest.version);
    const cli = join(installed, installedManifest.bin.marionette);
    assert.ok(run([process.execPath, cli, '--version'], project).includes(manifest.version));
    run([process.execPath, '--input-type=module', '-e',
      `await Promise.all(${JSON.stringify(Object.keys(manifest.exports).map((path) =>
        path === '.' ? manifest.name : manifest.name + path.slice(1)))}.map((name) => import(name)))`],
    project);
    process.stdout.write(`VERIFIED: installed tarball ${manifest.version} CLI and all export subpaths.\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const [action, value] = process.argv.slice(2);

try {
  if (action === 'check') check();
  else if (action === 'prepare') prepare(value);
  else if (action === 'smoke') smoke(value);
  else throw new Error('Usage: node scripts/release.mjs check|prepare VERSION|smoke TARBALL');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
