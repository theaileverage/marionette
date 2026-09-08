import { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
export function privateJson<T>(path: string, data: T) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
