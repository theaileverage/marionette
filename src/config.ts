import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
export const configSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  port: z.number().int().min(1024).max(65535),
  token: z.string().min(32),
});
export type Config = z.infer<typeof configSchema>;
export function homePath(home?: string) {
  if (home || process.env.MARIONETTE_HOME) return resolve(home ?? process.env.MARIONETTE_HOME!);
  let dir = process.cwd();
  while (true) {
    const binding = resolve(dir, '.marionette/project.json');
    if (existsSync(binding)) {
      const data = JSON.parse(readFileSync(binding, 'utf8'));
      return resolve(z.string().parse(data.home));
    }
    if (existsSync(resolve(dir, '.marionette/config.json'))) return resolve(dir, '.marionette');
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'), 'marionette');
}
export function initConfig(home: string, port = 4380): Config {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = resolve(home, 'config.json');
  if (existsSync(path)) return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const config: Config = {
    version: 1,
    id: randomUUID(),
    port,
    token: randomBytes(32).toString('hex'),
  };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return config;
}
export function loadConfig(home: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf8')));
}
export async function call(home: string, action: string, input: unknown = {}) {
  const c = loadConfig(home),
    response = await fetch(`http://127.0.0.1:${c.port}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ action, input }),
      signal: AbortSignal.timeout(
        action.startsWith('cleanup.') ? 300000 : action === 'profile.validate' ? 135000 : 45000,
      ),
    });
  const body = (await response.json()) as any;
  if (!response.ok)
    throw new Error(
      `${body.error?.code ?? response.status}: ${body.error?.message ?? response.statusText}`,
    );
  return body.result;
}
