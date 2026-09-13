import { afterEach, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { installProjectSkills } from '../src/project-skills.js';
import { installRuntime, packageRoot } from '../src/runtime.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(resolve(tmpdir(), 'marionette-skills-'));
  roots.push(base);
  const root = resolve(base, 'project'),
    source = resolve(base, 'package');
  mkdirSync(root);
  mkdirSync(resolve(source, 'skills/marionette/references'), { recursive: true });
  writeFileSync(resolve(source, 'skills/marionette/SKILL.md'), 'Skill');
  writeFileSync(resolve(source, 'skills/marionette/references/recipe.md'), 'Recipe');
  return { base, root, source };
}
test('copies the full tree to both clients and reruns unchanged', () => {
  const { root, source } = fixture();
  expect(installProjectSkills(root, source).map((item) => item.status)).toEqual([
    'installed',
    'installed',
  ]);
  for (const folder of ['.agents', '.claude'])
    expect(
      readFileSync(resolve(root, folder, 'skills/marionette/references/recipe.md'), 'utf8'),
    ).toBe('Recipe');
  expect(installProjectSkills(root, source).map((item) => item.status)).toEqual([
    'unchanged',
    'unchanged',
  ]);
});
test('customized files block all writes for that destination', () => {
  const { root, source } = fixture();
  const target = resolve(root, '.agents/skills/marionette');
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, 'SKILL.md'), 'User skill');
  const result = installProjectSkills(root, source);
  expect(result[0].status).toBe('conflict');
  expect(result[0].conflicts).toContain('.agents/skills/marionette/SKILL.md');
  expect(readFileSync(resolve(target, 'SKILL.md'), 'utf8')).toBe('User skill');
  expect(existsSync(resolve(target, 'references'))).toBe(false);
  expect(result[1].status).toBe('installed');
});
test('symlink ancestors and nested directories cannot redirect installation', () => {
  const { root, source, base } = fixture();
  const outside = resolve(base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, resolve(root, '.agents'));
  const nested = resolve(root, '.claude/skills/marionette');
  mkdirSync(nested, { recursive: true });
  symlinkSync(outside, resolve(nested, 'references'));
  expect(installProjectSkills(root, source).map((item) => item.status)).toEqual([
    'conflict',
    'conflict',
  ]);
  expect(existsSync(resolve(outside, 'recipe.md'))).toBe(false);
  expect(existsSync(resolve(nested, 'SKILL.md'))).toBe(false);
});
test('missing source fails with a useful error', () => {
  const { root, source } = fixture();
  rmSync(resolve(source, 'skills'), { recursive: true });
  expect(() => installProjectSkills(root, source)).toThrow('Marionette skill directory is missing');
});
test('durable runtime retains the skill after the source disappears', () => {
  const { base, root, source } = fixture();
  mkdirSync(resolve(source, 'dist'));
  mkdirSync(resolve(source, 'public'));
  writeFileSync(resolve(source, 'dist/cli.js'), 'cli');
  writeFileSync(resolve(source, 'public/index.html'), 'ui');
  writeFileSync(resolve(source, 'package.json'), JSON.stringify({ version: 'test' }));
  const runtime = installRuntime(resolve(base, 'home'), source);
  rmSync(source, { recursive: true });
  expect(installProjectSkills(root, runtime).map((item) => item.status)).toEqual([
    'installed',
    'installed',
  ]);
});

test('CLI defaults do not treat --yes as skill consent', () => {
  const { root, base } = fixture();
  function plan(args: string[]) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, '../src/cli.ts'),
        'setup',
        '--project',
        root,
        '--home',
        resolve(base, 'home'),
        '--yes',
        '--dry-run',
        '--json',
        ...args,
      ],
      { cwd: root, env: { ...process.env, MARIONETTE_HOME: resolve(base, 'home') } },
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  }
  expect(plan([]).installSkills).toBe(false);
  expect(plan(['--install-skills']).installSkills).toBe(true);
  expect(plan(['--no-install-skills']).installSkills).toBe(false);
  expect(plan([]).authorityMode).toBe('conversation');
  expect(plan(['--authority-mode', 'external']).authorityMode).toBe('external');
  expect(existsSync(resolve(root, '.agents'))).toBe(false);
});

test('a symlink file remains untouched and blocks the destination', () => {
  const { root, source, base } = fixture();
  const target = resolve(root, '.agents/skills/marionette');
  const userFile = resolve(base, 'user.md');
  mkdirSync(target, { recursive: true });
  writeFileSync(userFile, 'User instructions');
  symlinkSync(userFile, resolve(target, 'SKILL.md'));
  expect(installProjectSkills(root, source)[0].status).toBe('conflict');
  expect(readFileSync(userFile, 'utf8')).toBe('User instructions');
  expect(existsSync(resolve(target, 'references'))).toBe(false);
});

test('setup preserves an explicitly saved external authority policy', async () => {
  const { setupPlan } = await import('../src/setup.js');
  const { root, base } = fixture();
  const savedHome = resolve(base, 'saved');
  mkdirSync(resolve(root, '.marionette'));
  writeFileSync(
    resolve(root, '.marionette/project.json'),
    JSON.stringify({
      home: savedHome,
      authorityMode: 'external',
      session: 'default',
    }),
  );
  expect(setupPlan({ project: root }).authorityMode).toBe('external');
  expect(setupPlan({ project: root, authorityMode: 'conversation' }).authorityMode).toBe(
    'conversation',
  );
  expect(setupPlan({ project: root }).installSkills).toBe(false);
});

test('the built skill artifact survives an old updater that copies only dist and public', () => {
  const { base, root, source } = fixture();
  rmSync(source, { recursive: true });
  mkdirSync(resolve(source, 'dist'), { recursive: true });
  cpSync(
    resolve(packageRoot, 'dist/marionette-skills.json'),
    resolve(source, 'dist/marionette-skills.json'),
  );
  cpSync(resolve(packageRoot, 'package.json'), resolve(source, 'package.json'));
  const runtime = resolve(base, 'home/runtimes/old-updater');
  mkdirSync(runtime, { recursive: true });
  cpSync(resolve(source, 'dist'), resolve(runtime, 'dist'), { recursive: true });
  cpSync(resolve(source, 'package.json'), resolve(runtime, 'package.json'));
  writeFileSync(resolve(runtime, '.complete'), '1\n');
  rmSync(source, { recursive: true });
  expect(existsSync(resolve(runtime, 'skills'))).toBe(false);
  expect(installProjectSkills(root, runtime).map((item) => item.status)).toEqual([
    'installed',
    'installed',
  ]);
  for (const folder of ['.agents', '.claude']) {
    expect(readFileSync(resolve(root, folder, 'skills/marionette/SKILL.md'), 'utf8')).toBe(
      readFileSync(resolve(packageRoot, 'skills/marionette/SKILL.md'), 'utf8'),
    );
    expect(
      readFileSync(
        resolve(root, folder, 'skills/marionette/references/recipes/recover.md'),
        'utf8',
      ),
    ).toBe(
      readFileSync(resolve(packageRoot, 'skills/marionette/references/recipes/recover.md'), 'utf8'),
    );
  }
});

test('portable bundles reject unsafe paths and mismatched versions before writing', () => {
  const { root, source } = fixture();
  rmSync(resolve(source, 'skills'), { recursive: true });
  mkdirSync(resolve(source, 'dist'));
  writeFileSync(resolve(source, 'package.json'), JSON.stringify({ version: 'test' }));
  const path = resolve(source, 'dist/marionette-skills.json');
  for (const files of [
    { '../escape': 'WA==' },
    { '/escape': 'WA==' },
    { 'SKILL.md': 'WA==', 'SKILL.md/child': 'WA==' },
  ]) {
    writeFileSync(path, JSON.stringify({ version: 'test', files }));
    expect(() => installProjectSkills(root, source)).toThrow();
    expect(existsSync(resolve(root, '.agents'))).toBe(false);
  }
  writeFileSync(path, JSON.stringify({ version: 'other', files: { 'SKILL.md': 'WA==' } }));
  expect(() => installProjectSkills(root, source)).toThrow('version mismatch');
});
