import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Copy the bundled executable and UI out of the ephemeral package cache. */
export function installRuntime(home: string, source = packageRoot) {
  const files: string[] = ['dist/cli.js', 'dist/mcp.js', 'dist/harness-guard.js', 'package.json'];
  if (existsSync(resolve(source, 'THIRD_PARTY_NOTICES.md'))) files.push('THIRD_PARTY_NOTICES.md');
  function walk(dir: string) {
    for (const entry of readdirSync(resolve(source, dir), { withFileTypes: true })) {
      const path = dir + '/' + entry.name;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  }
  if (
    !existsSync(resolve(source, 'dist/cli.js')) ||
    !existsSync(resolve(source, 'public/index.html'))
  )
    throw new Error('Build Marionette first with bun run build');
  walk('public');
  const digest = createHash('sha256');
  for (const file of files.sort()) digest.update(file).update(readFileSync(resolve(source, file)));
  const version = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version;
  const target = resolve(home, 'runtimes', version + '-' + digest.digest('hex').slice(0, 16));
  if (relative(source, target) === '') return target;
  if (existsSync(resolve(target, '.complete'))) return target;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomUUID();
  mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of files) {
      mkdirSync(dirname(resolve(temp, file)), { recursive: true });
      cpSync(resolve(source, file), resolve(temp, file));
    }
    writeFileSync(resolve(temp, '.complete'), '1\n');
    try {
      renameSync(temp, target);
    } catch (e) {
      if (!existsSync(resolve(target, '.complete'))) throw e;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return target;
}
