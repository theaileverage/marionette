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
import { VERSION } from './version.js';

import { bundledGuard } from './runtime-bundle.js';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Copy the bundled executable and UI out of the ephemeral package cache. */
export function installRuntime(home: string, source = packageRoot) {
  const files: string[] = ['package.json'];
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
  walk('dist');
  walk('public');
  const version = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version;
  const guard = 'dist/harness-guard.js';
  const embeddedGuard = version === VERSION ? bundledGuard() : undefined;
  const recoverGuard = !files.includes(guard) && embeddedGuard !== undefined;
  // An older updater has already bound projects to this managed runtime path.
  // Repair its omitted guard in place; changing the path would fail that updater's
  // supervisor identity check and roll back an otherwise healthy upgrade.
  if (dirname(source) === resolve(home, 'runtimes') && existsSync(resolve(source, '.complete'))) {
    if (recoverGuard) writeFileSync(resolve(source, guard), embeddedGuard);
    return source;
  }
  if (recoverGuard) files.push(guard);
  const contents = (file: string) =>
    file === guard && recoverGuard
      ? Buffer.from(embeddedGuard ?? '')
      : readFileSync(resolve(source, file));
  const digest = createHash('sha256');
  for (const file of files.sort()) digest.update(file).update(contents(file));
  const target = resolve(home, 'runtimes', version + '-' + digest.digest('hex').slice(0, 16));
  if (relative(source, target) === '') return target;
  if (existsSync(resolve(target, '.complete'))) return target;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomUUID();
  mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of files) {
      mkdirSync(dirname(resolve(temp, file)), { recursive: true });
      if (file === guard && recoverGuard) writeFileSync(resolve(temp, file), contents(file));
      else cpSync(resolve(source, file), resolve(temp, file));
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
