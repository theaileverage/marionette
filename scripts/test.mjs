import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.bun) throw new Error('Run the test harness with Node');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const outputRoot = join(root, '.test-output');

const workRoot = join(outputRoot, `work-${process.pid}`);

const baselineRoot = join(workRoot, 'baseline');

const baselineCommit = '0ddd61dcf87f0180b17c4a16dafcca83b14493a5';

function filesBelow(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name)).sort();
}

function command(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
  });

  if (result.error || result.status !== 0)
    throw new Error(`${argv.join(' ')} failed: ${result.error ?? result.stderr ?? result.status}`);

  return result;
}

function prepareBaseline() {
  mkdirSync(baselineRoot, { recursive: true });
  const archive = command(['git', 'archive', baselineCommit, 'src'], { encoding: null }).stdout;
  command(['tar', '-xf', '-', '-C', baselineRoot], { input: archive });

  if (!existsSync(join(baselineRoot, 'src/v1/operations.ts')))
    throw new Error(`Pinned baseline source is missing at ${baselineCommit}`);
}

function baselineImports() {
  return { name: 'pinned-baseline-imports', setup(api) {
    api.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (args) => {
      if (dirname(args.importer) !== join(root, 'tests')) return undefined;
      const suffix = args.path.slice('../../src/'.length).replace(/\.js$/, '.ts');
      const target = resolve(baselineRoot, 'src', suffix);

      if (!target.startsWith(`${join(baselineRoot, 'src')}/`) || !existsSync(target))
        return { errors: [{ text: `Pinned baseline module is missing: ${target}` }] };

      return { path: target };
    });
  } };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/test.mjs [--list] [filename slice ...]\n');

    return;
  }

  const files = filesBelow(join(root, 'tests'));

  if (args.includes('--list')) {
    process.stdout.write(files.map((file) => `${relative(root, file)}\n`).join(''));

    return;
  }

  if (args.some((arg) => arg.startsWith('-'))) throw new Error('Unknown test option');

  const selected = args.length === 0 ? files :
    files.filter((file) => args.some((slice) => relative(root, file).includes(slice)));

  if (selected.length === 0) throw new Error('No matching test files');

  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  cpSync(join(root, 'src'), join(workRoot, 'src'), { recursive: true });
  prepareBaseline();

  if (!existsSync(join(root, 'dist/v1/cli.js'))) command([process.execPath, 'scripts/build.mjs']);

  const entries = Object.fromEntries(selected.map((file) => [
    relative(join(root, 'tests'), file).replace(/\.test\.ts$/, ''), file,
  ]));

  const compiledRoot = join(workRoot, '.compiled');
  await build({
    absWorkingDir: root, entryPoints: entries, outdir: compiledRoot,
    outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node',
    format: 'esm', packages: 'external', sourcemap: 'inline',
    plugins: [baselineImports()],
  });
  const compiled = Object.keys(entries).map((name) => join(compiledRoot, `${name}.mjs`));
  const testEnvironment = { ...process.env, MARIONETTE_PARITY_SCRATCH: workRoot };
  delete testEnvironment.MARIONETTE_CONTEXT;

  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...compiled], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: testEnvironment,
  });

  mkdirSync(join(outputRoot, 'logs'), { recursive: true });
  const log = join(outputRoot, 'logs', `${new Date().toISOString().replaceAll(':', '-')}-tests.log`);
  writeFileSync(log, [
    `baseline=${baselineCommit}`, `testFiles=${selected.length}`,
    `exitCode=${result.status ?? 'spawn-error'}`, '', result.stdout ?? '', result.stderr ?? '',
  ].join('\n'));

  if (result.stdout) process.stdout.write(result.stdout);

  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`Evidence: ${relative(root, log)}\n`);

  if (result.error) throw result.error;

  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else process.stdout.write(`VERIFIED: ${selected.length} root test files\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
