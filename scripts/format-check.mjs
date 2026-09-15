import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'package.json', '.github/workflows/ci.yml', '.github/workflows/release.yml',
  'README.md', 'RELEASING.md', 'docs/herdr-contract.md',
  'evidence/effect-source-manifest.json',
  'scripts/format-check.mjs', 'scripts/release.mjs',
];

for (const file of files) {
  const content = readFileSync(join(root, file), 'utf8');
  assert.ok(content.endsWith('\n'), `${file}: missing final newline`);
  assert.doesNotMatch(content, /\r|[^\S\n]+$/m, `${file}: CRLF or trailing whitespace`);
}

process.stdout.write(`VERIFIED: ${files.length} release-owned files have clean whitespace.\n`);
