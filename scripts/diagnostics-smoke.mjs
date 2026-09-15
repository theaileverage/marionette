import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const probe = join(root, '.test-output', 'diagnostics-probe');

mkdirSync(probe, { recursive: true });

writeFileSync(join(probe, 'probe.ts'), 'import { Effect } from "effect";\nEffect.succeed(1);\n');

writeFileSync(
  join(probe, 'tsconfig.json'),
  JSON.stringify({
    extends: '../../tsconfig.json',
    include: ['probe.ts'],
    exclude: [],
  }),
);

const result = spawnSync(
  join(root, 'node_modules', '.bin', 'effect-tsgo'),
  ['diagnostics', '--project', join(probe, 'tsconfig.json'), '--format', 'json'],
  { cwd: root, encoding: 'utf8', timeout: 60_000 },
);

assert.ifError(result.error);

const report = JSON.parse(result.stdout);

assert.ok(
  Array.isArray(report.diagnostics),
  'Diagnostics command must return structured diagnostics',
);

assert.ok(
  report.diagnostics.some((entry) => entry.name === 'floatingEffect' && entry.severity === 'error'),
  'Effect LSP must detect the intentionally floating Effect',
);

assert.notEqual(result.status, 0, 'Effect errors must fail the diagnostics command');

const versions = Object.fromEntries(
  ['effect', '@effect/tsgo', 'typescript'].map((name) => [
    name,
    JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version,
  ]),
);

writeFileSync(
  join(root, 'evidence', 'diagnostics-smoke.json'),
  JSON.stringify(
    {
      versions,
      expectedFailure: true,
      exitCode: result.status,
      ...report,
    },
    null,
    2,
  ) + '\n',
);

process.stdout.write(
  `VERIFIED: Effect floatingEffect diagnostic and failing exit code (${JSON.stringify(versions)})\n`,
);
