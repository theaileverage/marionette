import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const repo = resolve(import.meta.dir, '../..');
const output = mkdtempSync(join(tmpdir(), 'marionette-wterm-runtime-'));
mkdirSync(join(output, 'dist'));
for (const name of ['cli', 'mcp', 'harness-guard'])
  await build({
    absWorkingDir: repo,
    entryPoints: [`src/${name}.ts`],
    outfile: join(output, `dist/${name}.js`),
    bundle: true,
    loader: { '.mustache': 'text' },
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    external: ['bun:*'],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
for (const path of ['package.json', 'public', 'THIRD_PARTY_NOTICES.md'])
  cpSync(join(repo, path), join(output, path), { recursive: true });
console.log(join(output, 'dist/cli.js'));
