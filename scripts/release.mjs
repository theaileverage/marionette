import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePackage } from './package-smoke-v1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

export function versionParts(version) {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    'Use an exact SemVer without build metadata',
  );
  const [base, ...suffix] = version.split('-');
  const pre = suffix.join('-').split('.').filter(Boolean);
  for (const part of pre)
    assert.ok(!/^0\d+$/.test(part), 'Numeric prerelease identifiers cannot have leading zeroes');
  return { base: base.split('.').map(BigInt), pre };
}

export function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let index = 0; index < 3; index += 1)
    if (x.base[index] !== y.base[index]) return x.base[index] > y.base[index] ? 1 : -1;
  if (!x.pre.length || !y.pre.length)
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(x.pre.length, y.pre.length); index += 1) {
    const left = x.pre[index];
    const right = y.pre[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

export function notesFor(changelog, version) {
  versionParts(version);
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find((candidate) =>
    new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(candidate),
  );
  assert.ok(section, `Add a changelog section for ${version}`);
  const body = section.replace(/^.*\n/, '').trim();
  assert.ok(
    body && !body.includes('Describe the release here.'),
    'Write release notes before tagging',
  );
  return `${body}\n`;
}

export function check(tag) {
  const pkg = read('package.json');
  versionParts(pkg.version);
  assert.equal(pkg.engines?.node, '>=26.8.1');
  assert.equal(pkg.bin?.marionette, 'dist/v1/cli.js');
  assert.equal(pkg.types, './dist/v1/index.d.ts');
  assert.equal(pkg.exports?.['.']?.import, './dist/v1/index.js');
  assert.equal(pkg.exports?.['.']?.types, './dist/v1/index.d.ts');
  assert.equal(pkg.exports?.['./herdr-sdk']?.import, './dist/herdr-sdk.js');
  assert.equal(pkg.exports?.['./herdr-sdk']?.types, './dist/herdr-sdk.d.ts');
  assert.equal(pkg.dependencies?.zod, '^3.25.0');
  assert.equal(pkg.repository?.url, 'git+https://github.com/theaileverage/marionette.git');
  assert.equal(pkg.license, 'MIT');
  for (const path of ['LICENSE', 'vendor/herdr-0.9.0/LICENSE', 'workflows/feature.json'])
    assert.ok(existsSync(resolve(root, path)), `Missing package resource ${path}`);
  notesFor(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), pkg.version);
  if (tag) {
    assert.equal(tag, `v${pkg.version}`, 'Tag must match package version');
    if (process.env.GITHUB_ACTIONS === 'true')
      assert.equal(
        process.env.GITHUB_REF,
        `refs/tags/${tag}`,
        'Dispatch the workflow on its version tag',
      );
  }
  return pkg;
}

export function prepare(version) {
  const pkg = read('package.json');
  assert.ok(compareVersions(version, pkg.version) > 0, 'New version must increase');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    '',
    'Start from a clean checkout',
  );
  pkg.version = version;
  writeFileSync(resolve(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const changelogPath = resolve(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  writeFileSync(
    changelogPath,
    changelog.replace(
      '# Changelog\n',
      `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n\nDescribe the release here.\n`,
    ),
  );
  console.log(`Prepared ${version}. Verify the package before creating a release tag.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, argument] = process.argv.slice(2);
  if (action === 'prepare') prepare(argument);
  else if (action === 'check') {
    check(argument);
    console.log('Release metadata is consistent');
  } else if (action === 'smoke') smokePackage(argument);
  else throw new Error('Use prepare VERSION, check [TAG], or smoke TARBALL');
}
