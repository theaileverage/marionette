import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function agySettingsPath() {
  return resolve(
    process.env.MARIONETTE_AGY_SETTINGS ??
      resolve(homedir(), '.gemini/antigravity-cli/settings.json'),
  );
}
/** Opted-in project trust only; never changes AGY's tool permission policy. */
export function trustAgyWorkspace(root: string, settingsPath = agySettingsPath()) {
  root = realpathSync(root);
  if (!statSync(root).isDirectory()) throw new Error('AGY trust requires a directory');
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  const lock = settingsPath + '.marionette.lock';
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error(`AGY settings are being edited. Retry after checking ${lock}`);
  }
  const temp = settingsPath + '.' + randomUUID() + '.tmp';
  try {
    const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
    const settings = before === null ? {} : JSON.parse(before);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('AGY settings must be a JSON object');
    const trusted = settings.trustedWorkspaces ?? [];
    if (!Array.isArray(trusted) || trusted.some((p: unknown) => typeof p !== 'string'))
      throw new Error('AGY trustedWorkspaces must be a string array');
    if (trusted.includes(root)) return { changed: false, root, settingsPath };
    settings.trustedWorkspaces = [...trusted, root];
    const mode = before === null ? 0o600 : statSync(settingsPath).mode & 0o777;
    writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode });
    // Detect edits from AGY or another editor that does not participate in our lock.
    const current = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
    if (current !== before) throw new Error('AGY settings changed during registration; retry');
    renameSync(temp, settingsPath);
    return { changed: true, root, settingsPath };
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(fd);
    unlinkSync(lock);
  }
}
