import { Config, Effect } from 'effect';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Herdr 0.9 reserves default for the top-level socket, not sessions/default. */
export function herdrSessionSocket(session: string) {
  const config = Effect.runSync(
    Config.string('XDG_CONFIG_HOME').pipe(Config.withDefault(resolve(homedir(), '.config'))),
  );
  return session === 'default'
    ? resolve(config, 'herdr/herdr.sock')
    : resolve(config, 'herdr/sessions', session, 'herdr.sock');
}
