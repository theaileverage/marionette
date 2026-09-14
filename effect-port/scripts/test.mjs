import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyBaseline } from './baseline.mjs';

if (process.versions.bun) throw new Error('Run the parity harness with Node');

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(portRoot, '..');
const outputRoot = join(portRoot, '.test-output');
const workRoot = join(outputRoot, `work-${process.pid}`);
const logRoot = join(outputRoot, 'logs');
const require = createRequire(import.meta.url);

const usage = `Usage: node scripts/test.mjs [options] [slice ...]

Options:
  --baseline-only  Run matching captured tests only
  --port-only      Run matching effect-port/tests tests only
  --self-test      Verify the redirect harness without claiming parity
  --list           List available test slices
  --help           Show this message

A slice is a substring of a test filename, for example: sql, cli-ux, schema.`;

function testFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.test.ts'))
    .sort();
}

function copyDirectory(source, target) {
  if (existsSync(source)) cpSync(source, target, { recursive: true });
}

function parseArguments(argv) {
  const options = {
    baseline: true,
    port: true,
    selfTest: false,
    list: false,
    help: false,
    slices: [],
  };
  for (const argument of argv) {
    if (argument === '--baseline-only') options.port = false;
    else if (argument === '--port-only') options.baseline = false;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else options.slices.push(argument);
  }
  if (!options.baseline && !options.port) throw new Error('No test source selected');
  return options;
}

function select(files, slices) {
  if (slices.length === 0) return files;
  return files.filter((file) => slices.some((slice) => file.includes(slice)));
}

function writeSelfTest() {
  mkdirSync(join(workRoot, 'src', 'v1'), { recursive: true });
  mkdirSync(join(workRoot, 'tests', 'v1'), { recursive: true });
  writeFileSync(
    join(workRoot, 'src', 'v1', 'harness-probe.ts'),
    "export const implementation = 'effect-port-scratch';\n",
  );
  writeFileSync(
    join(workRoot, 'tests', 'v1', 'harness-probe.test.ts'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { implementation } from '../../src/v1/harness-probe.js';",
      "test('loads only the scratch port source', () => assert.equal(implementation, 'effect-port-scratch'));",
      '',
    ].join('\n'),
  );
  return [{ kind: 'harness', file: 'harness-probe.test.ts' }];
}

function prepareScratch(selected) {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(join(workRoot, 'tests', 'v1'), { recursive: true });
  mkdirSync(join(workRoot, 'tests-port'), { recursive: true });

  copyDirectory(join(portRoot, 'src'), join(workRoot, 'src'));
  copyDirectory(join(sourceRoot, 'workflows'), join(workRoot, 'workflows'));
  copyDirectory(join(sourceRoot, 'skills', 'marionette'), join(workRoot, 'skills', 'marionette'));
  cpSync(join(sourceRoot, 'package.json'), join(workRoot, 'package.json'));

  for (const entry of selected) {
    if (entry.kind === 'port') continue;
    const from =
      entry.kind === 'baseline'
        ? existsSync(join(portRoot, 'tests', 'v1', entry.file))
          ? join(portRoot, 'tests', 'v1', entry.file)
          : join(sourceRoot, 'tests', 'v1', entry.file)
        : join(portRoot, 'tests', entry.file);
    const to =
      entry.kind === 'baseline'
        ? join(workRoot, 'tests', 'v1', entry.file)
        : join(workRoot, 'tests-port', entry.file);
    cpSync(from, to);
  }
}

function redirectedPortImports() {
  const scratchSource = realpathSync(join(workRoot, 'src'));
  const legacySource = realpathSync(join(sourceRoot, 'src'));
  return {
    name: 'redirect-tests-to-effect-port',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (args) => {
        const suffix = args.path.slice('../../src/'.length).replace(/\.js$/, '.ts');
        if (args.importer.startsWith(`${join(portRoot, 'tests')}/`)) {
          const target = resolve(sourceRoot, 'src', suffix);
          if (!target.startsWith(`${join(sourceRoot, 'src')}/`) || !existsSync(target)) {
            return { errors: [{ text: `Baseline oracle source is missing: ${target}` }] };
          }
          return { path: target, namespace: 'baseline-oracle' };
        }
        const target = resolve(scratchSource, suffix);
        if (!target.startsWith(`${scratchSource}/`) || !existsSync(target)) {
          return { errors: [{ text: `Port source is missing for ${args.path}: ${target}` }] };
        }
        return { path: target };
      });
      buildApi.onResolve({ filter: /.*/, namespace: 'baseline-oracle' }, (args) => {
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        if (!args.path.startsWith('.')) {
          return { path: require.resolve(args.path, { paths: [sourceRoot] }) };
        }
        const target = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
        if (!target.startsWith(`${join(sourceRoot, 'src')}/`) || !existsSync(target)) {
          return { errors: [{ text: `Baseline oracle dependency is missing: ${target}` }] };
        }
        return { path: target, namespace: 'baseline-oracle' };
      });
      buildApi.onLoad({ filter: /\.ts$/, namespace: 'baseline-oracle' }, (args) => ({
        contents: readFileSync(args.path, 'utf8'),
        loader: 'ts',
        resolveDir: dirname(args.path),
      }));
      buildApi.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
        const path = resolve(args.path);
        if (path === legacySource || path.startsWith(`${legacySource}/`)) {
          return { errors: [{ text: `Parity harness refused legacy source: ${path}` }] };
        }
        return undefined;
      });
    },
  };
}

async function compile(selected) {
  const entryPoints = {};
  for (const entry of selected) {
    const prefix = entry.kind === 'baseline' ? 'baseline' : entry.kind;
    const source =
      entry.kind === 'baseline'
        ? join(workRoot, 'tests', 'v1', entry.file)
        : entry.kind === 'port'
          ? join(portRoot, 'tests', entry.file)
          : join(workRoot, 'tests', 'v1', entry.file);
    entryPoints[`${prefix}-${entry.file.replace(/\.test\.ts$/, '')}`] = source;
  }
  const compiledRoot = join(workRoot, '.compiled');
  await build({
    absWorkingDir: workRoot,
    entryPoints,
    outdir: compiledRoot,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    nodePaths: [join(sourceRoot, 'node_modules'), join(portRoot, 'node_modules')],
    sourcemap: 'inline',
    plugins: [redirectedPortImports()],
  });
  return Object.keys(entryPoints).map((name) => join(compiledRoot, `${name}.mjs`));
}

function retainLog(result, label, baseline) {
  mkdirSync(logRoot, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const body = [
    `mode=${label}`,
    `baseline=${baseline.head}`,
    `baselineFiles=${baseline.files}`,
    `status=${result.status ?? 'spawn-error'}`,
    '',
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n');
  const path = join(logRoot, `${stamp}-${label}.log`);
  writeFileSync(path, body);
  writeFileSync(join(outputRoot, 'latest.log'), body);
  return path;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const baselineFiles = testFiles(join(sourceRoot, 'tests', 'v1'));
  const portFiles = testFiles(join(portRoot, 'tests'));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (options.list) {
    process.stdout.write(
      [
        ...baselineFiles.map((file) => `baseline ${file}`),
        ...portFiles.map((file) => `port     ${file}`),
      ].join('\n') + '\n',
    );
    return;
  }

  const baseline = verifyBaseline();
  process.stdout.write(`BASELINE VERIFIED ${baseline.head} (${baseline.files} files)\n`);

  let selected;
  if (options.selfTest) {
    rmSync(workRoot, { recursive: true, force: true });
    selected = writeSelfTest();
  } else {
    selected = [
      ...(options.baseline
        ? select(baselineFiles, options.slices).map((file) => ({ kind: 'baseline', file }))
        : []),
      ...(options.port
        ? select(portFiles, options.slices).map((file) => ({ kind: 'port', file }))
        : []),
    ];
    if (selected.length === 0) throw new Error('No matching parity tests');
    prepareScratch(selected);
  }

  const compiled = await compile(selected);
  const result = spawnSync(process.execPath, ['--test', ...compiled], {
    cwd: workRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MARIONETTE_PARITY_SCRATCH: workRoot },
  });
  const label = options.selfTest ? 'harness-self-test' : 'parity';
  const log = retainLog(result, label, baseline);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`Evidence: ${relative(portRoot, log)}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else if (options.selfTest) {
    process.stdout.write('HARNESS VERIFIED; parity was not run\n');
  } else {
    process.stdout.write(
      `SELECTED CHECKS VERIFIED (${selected.length} test files); whole-project parity is not established\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
