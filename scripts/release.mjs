import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
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
    lock = Bun.JSON5.parse(readFileSync(join(root, 'bun.lock'), 'utf8'));
  versionParts(pkg.version);
  assert.equal(lock.workspaces[''].name, pkg.name);
  assert.deepEqual(
    lock.workspaces[''].devDependencies,
    pkg.devDependencies,
    'bun.lock must match package.json',
  );
  assert.equal(pkg.packageManager, 'bun@1.3.14');
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
  pkg.version = version;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
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
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { [pkg.name]: resolve(tarball) },
    }),
  );
  run(
    process.execPath,
    ['install', '--production', '--ignore-scripts', '--cache-dir', join(dir, 'cache')],
    { cwd: dir, timeout: 60000 },
  );
  const output = run(join(dir, 'node_modules', '.bin', 'marionette'), ['--version'], {
    cwd: dir,
    timeout: 30000,
  });
  assert.equal(output, pkg.version, 'Installed package CLI version differs');
  const cli = join(dir, 'node_modules', '.bin', 'marionette');
  const plan = JSON.parse(run(process.execPath, [cli, 'setup', '--dry-run'], { cwd: dir }));
  assert.equal(
    plan.root,
    realpathSync(dir),
    'Fresh package setup must use the caller project directory',
  );
  assert.equal(existsSync(join(dir, '.marionette')), false, 'Dry-run must not create state');
  assert.equal(plan.session, 'default', 'New projects must join the shared default session');
  assert.ok(!plan.socket.includes('/sessions/default/'), 'Default uses the top-level Herdr socket');
  const help = run(process.execPath, [cli, '--help'], { cwd: dir });
  for (const command of [
    'profiles',
    'roles',
    'profile.validate',
    'swarm.dispatch',
    'cleanup.collect',
  ])
    assert.ok(help.includes(command), `Installed help is missing ${command}`);
  // Exercise the copied runtime, not only the package-cache entry point. This
  // catches missing auxiliary bundles before publishing another updater.
  const home = join(dir, 'runtime-smoke');
  const legacy = join(home, 'runtimes', pkg.version + '-legacy-installer');
  mkdirSync(join(legacy, 'dist'), { recursive: true });
  const installed = join(dir, 'node_modules', '@theaileverage', 'marionette');
  for (const file of ['dist/cli.js', 'dist/mcp.js', 'package.json', 'public'])
    cpSync(join(installed, file), join(legacy, file), { recursive: true });
  writeFileSync(join(legacy, '.complete'), '1\n');
  const legacyCli = join(legacy, 'dist/cli.js');
  const port = run(
    process.execPath,
    [
      '--eval',
      "const s = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('smoke')}); console.log(s.port); s.stop(true);",
    ],
    { cwd: dir },
  );
  try {
    run(process.execPath, [legacyCli, 'start', '--home', home, '--port', port], {
      cwd: dir,
      timeout: 30000,
    });
    const runtimes = readdirSync(join(home, 'runtimes'));
    assert.equal(
      runtimes.length,
      1,
      'Legacy upgrades must retain the runtime path pinned by the old updater',
    );
    for (const bundle of ['cli.js', 'mcp.js', 'harness-guard.js'])
      assert.ok(
        existsSync(join(home, 'runtimes', runtimes[0], 'dist', bundle)),
        `Copied runtime lacks ${bundle}`,
      );
    assert.equal(
      run(process.execPath, [join(home, 'runtimes', runtimes[0], 'dist/cli.js'), '--version']),
      pkg.version,
    );
  } finally {
    if (existsSync(join(home, 'config.json')))
      run(process.execPath, [cli, 'stop', '--home', home], { cwd: dir, timeout: 30000 });
  }

  assert.ok(
    !readFileSync(cli, 'utf8').includes('node:sqlite'),
    'Bun package must not load node:sqlite',
  );
  assert.equal(
    existsSync(join(dir, 'node_modules', 'effect')),
    false,
    'The published package must remain self-contained',
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
       import { HerdrClient, HERDR_PROTOCOL } from '@theaileverage/marionette/herdr-sdk';
       assert.equal(HERDR_PROTOCOL, 22);
       const client = new HerdrClient('/tmp/marionette-sdk-smoke.sock');
       assert.equal(client.socketPath, '/tmp/marionette-sdk-smoke.sock');
       assert.ok(Object.hasOwn(client.api, 'agent.prompt'));
       await assert.rejects(client.call('events.subscribe'), /subscribe|stream/);`,
    ],
    { cwd: dir, timeout: 30000 },
  );
  writeFileSync(
    join(dir, 'sdk-smoke.mts'),
    `import { HerdrClient } from '@theaileverage/marionette/herdr-sdk';
     const client = new HerdrClient('/tmp/marionette-sdk-smoke.sock');
     void client.request('ping');
     void client.agent.get('w1:p1');\n`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(root, 'node_modules', '@types')],
      },
      files: ['sdk-smoke.mts'],
    }),
  );
  run(
    process.execPath,
    ['--bun', join(root, 'node_modules', '.bin', 'tsc'), '--project', join(dir, 'tsconfig.json')],
    {
      cwd: dir,
      timeout: 30000,
    },
  );
  console.log(
    `Installed tarball smoke passed: CLI ${output}, standalone Herdr SDK and declarations`,
  );
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
