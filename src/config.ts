import { Effect, Config as Environment, Schema } from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { callUrlEffect } from './http-client.js';
export const configSchema = Schema.Struct({
  version: Schema.mutableKey(Schema.Literal(1)),
  id: Schema.mutableKey(Schema.String),
  port: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1024))
      .check(Schema.isLessThanOrEqualTo(65535)),
  ),
  token: Schema.mutableKey(Schema.String.check(Schema.isMinLength(32))),
});
export type Config = Schema.Schema.Type<typeof configSchema>;
export function homePath(home?: string) {
  const configuredHome = Effect.runSync(
    Environment.string('MARIONETTE_HOME').pipe(Environment.withDefault('')),
  );
  const dataHome = Effect.runSync(
    Environment.string('XDG_DATA_HOME').pipe(
      Environment.withDefault(resolve(homedir(), '.local/share')),
    ),
  );
  if (home || configuredHome) return resolve(home ?? configuredHome);
  let dir = process.cwd();
  while (true) {
    const binding = resolve(dir, '.marionette/project.json');
    if (existsSync(binding)) {
      const data = JSON.parse(readFileSync(binding, 'utf8'));
      return resolve(Schema.decodeUnknownSync(Schema.String)(data.home));
    }
    if (existsSync(resolve(dir, '.marionette/config.json'))) return resolve(dir, '.marionette');
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return resolve(dataHome, 'marionette');
}
export function initConfig(home: string, port = 4380): Config {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = resolve(home, 'config.json');
  if (existsSync(path))
    return Schema.decodeUnknownSync(configSchema)(JSON.parse(readFileSync(path, 'utf8')));
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
  return Schema.decodeUnknownSync(configSchema)(
    JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf8')),
  );
}
export const callEffect = Effect.fn('Configuration.call')(function* (
  home: string,
  action: string,
  input: Schema.MutableJson = {},
) {
  const config = yield* sync('Configuration.read', () => loadConfig(home));
  return yield* callUrlEffect(
    `http://127.0.0.1:${config.port}/api/call`,
    config.token,
    { action, input },
    action.startsWith('cleanup.') ? 300000 : action === 'profile.validate' ? 135000 : 45000,
  );
});
export const call = (home: string, action: string, input: Schema.MutableJson = {}) =>
  Effect.runPromise(callEffect(home, action, input));
