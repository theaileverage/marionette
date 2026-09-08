import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const run = (command, args, options = {}) =>
  (
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }) ?? ''
  ).trim();
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
  const x = versionParts(a),
    y = versionParts(b);
  for (let n = 0; n < 3; n++) if (x.base[n] !== y.base[n]) return x.base[n] > y.base[n] ? 1 : -1;
  if (!x.pre.length || !y.pre.length)
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let n = 0; n < Math.max(x.pre.length, y.pre.length); n++) {
    const p = x.pre[n],
      q = y.pre[n];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
export function notesFor(changelog, version) {
  versionParts(version);
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find((s) =>
    new RegExp('^## ' + version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)').test(s),
  );
  assert.ok(section, 'Add a changelog section for ' + version);
  const body = section.replace(/^.*\n/, '').trim();
  assert.ok(
    body && !body.includes('Describe the release here.'),
    'Write release notes before tagging',
  );
  return body + '\n';
}
function check(tag) {
  const pkg = read('package.json'),
    lock = read('package-lock.json');
  versionParts(pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const source = readFileSync(join(root, 'src/version.ts'), 'utf8');
  assert.ok(
    source.includes(`VERSION = '${pkg.version}'`),
    'src/version.ts must match package.json',
  );
  assert.equal(pkg.repository.url, 'git+https://github.com/theaileverage/marionette.git');
  assert.equal(pkg.license, 'MIT');
  notesFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), pkg.version);
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
function prepare(version) {
  const pkg = read('package.json');
  assert.ok(compareVersions(version, pkg.version) > 0, 'New version must increase');
  assert.equal(run('git', ['status', '--porcelain']), '', 'Start from a clean checkout');
  const lock = read('package-lock.json');
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const source = readFileSync(join(root, 'src/version.ts'), 'utf8').replace(
    /VERSION = '[^']+'/g,
    `VERSION = '${version}'`,
  );
  writeFileSync(join(root, 'src/version.ts'), source);
  const path = join(root, 'CHANGELOG.md'),
    log = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    log.replace(
      '# Changelog\n',
      '# Changelog\n\n## ' +
        version +
        ' — ' +
        new Date().toISOString().slice(0, 10) +
        '\n\nDescribe the release here.\n',
    ),
  );
  console.log(
    `Prepared ${version}. Write its changelog, open a pull request, and tag the merged main commit v${version}.`,
  );
}
function smoke(tarball) {
  const pkg = check(),
    dir = mkdtempSync(join(tmpdir(), 'marionette-package-'));
  const output = run(
    'npm',
    [
      'exec',
      '--yes',
      '--offline',
      '--ignore-scripts',
      '--cache',
      join(dir, 'cache'),
      '--package',
      resolve(tarball),
      '--',
      'marionette',
      '--version',
    ],
    { cwd: dir, timeout: 60000 },
  );
  assert.equal(output, pkg.version, 'Installed package CLI version differs');
  console.log(`Installed tarball smoke passed: ${output}`);
}
const sri = (path) => 'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64');
async function registry(pkg) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (response.status === 404) return null;
  assert.ok(response.ok, `Registry request failed: ${response.status}`);
  return response.json();
}
async function publish(directory) {
  const pkg = check(process.env.RELEASE_TAG),
    dir = resolve(directory),
    file = join(dir, `theaileverage-marionette-${pkg.version}.tgz`),
    baseline = read('.github/release-baseline.json');
  assert.ok(existsSync(file), 'Build the tarball first');
  let existing = await registry(pkg);
  if (existing && pkg.version === baseline.version) {
    assert.equal(
      existing.dist.integrity,
      baseline.integrity,
      'Existing baseline differs from verified artifact',
    );
    const url = new URL(existing.dist.tarball);
    assert.equal(url.hostname, 'registry.npmjs.org');
    assert.equal(url.protocol, 'https:');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      baseline.integrity,
    );
    writeFileSync(file, bytes);
  } else if (existing)
    assert.equal(
      existing.dist.integrity,
      sri(file),
      'Published version differs; never overwrite a release',
    );
  else {
    run(
      'npm',
      [
        'publish',
        file,
        '--access',
        'public',
        '--tag',
        pkg.version.includes('-') ? 'next' : 'latest',
        '--provenance',
        '--ignore-scripts',
      ],
      { stdio: 'inherit', timeout: 120000 },
    );
    for (let n = 0; n < 10; n++) {
      existing = await registry(pkg);
      if (existing) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.equal(
      existing?.dist.integrity,
      sri(file),
      'Registry integrity must match the tested artifact',
    );
  }
  writeFileSync(
    join(dir, 'SHA256SUMS'),
    createHash('sha256').update(readFileSync(file)).digest('hex') + '  ' + basename(file) + '\n',
  );
  writeFileSync(
    join(dir, 'release-notes.md'),
    notesFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), pkg.version) +
      (pkg.version === baseline.version
        ? '\nThis initial GitHub release attaches the original npm artifact published before the repository was initialized.\n'
        : ''),
  );
  console.log(`Verified npm ${pkg.name}@${pkg.version}: ${sri(file)}`);
}
function github(directory) {
  const pkg = check(process.env.RELEASE_TAG),
    dir = resolve(directory),
    tag = `v${pkg.version}`,
    repo = 'theaileverage/marionette';
  let release;
  try {
    release = JSON.parse(
      run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets,url']),
    );
  } catch (error) {
    if (!/not found|HTTP 404/i.test(String(error.stderr))) throw error;
  }
  const files = [join(dir, `theaileverage-marionette-${pkg.version}.tgz`), join(dir, 'SHA256SUMS')];
  if (!release) {
    run(
      'gh',
      [
        'release',
        'create',
        tag,
        ...files,
        '--repo',
        repo,
        '--verify-tag',
        '--title',
        tag,
        '--notes-file',
        join(dir, 'release-notes.md'),
        ...(pkg.version.includes('-') ? ['--prerelease', '--latest=false'] : ['--latest']),
      ],
      { stdio: 'inherit' },
    );
  } else {
    for (const file of files) {
      if (release.assets.some((a) => a.name === basename(file))) {
        const temp = mkdtempSync(join(tmpdir(), 'marionette-release-asset-'));
        run('gh', [
          'release',
          'download',
          tag,
          '--repo',
          repo,
          '--pattern',
          basename(file),
          '--dir',
          temp,
        ]);
        assert.equal(
          sri(join(temp, basename(file))),
          sri(file),
          'Existing GitHub release asset differs',
        );
      } else run('gh', ['release', 'upload', tag, file, '--repo', repo], { stdio: 'inherit' });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, arg] = process.argv.slice(2);
  if (action === 'prepare') prepare(arg);
  else if (action === 'check') {
    check(arg);
    console.log('Release metadata is consistent');
  } else if (action === 'smoke') smoke(arg);
  else if (action === 'publish') await publish(arg);
  else if (action === 'github') github(arg);
  else
    throw new Error(
      'Use prepare VERSION, check [TAG], smoke TARBALL, publish DIRECTORY, or github DIRECTORY',
    );
}
