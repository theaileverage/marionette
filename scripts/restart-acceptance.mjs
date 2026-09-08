import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const cli = resolve(import.meta.dirname, '../dist/cli.js');
const home = resolve(import.meta.dirname, '../.runtime/v02-live/state');
for (const action of ['stop', 'start'])
  process.stdout.write(
    execFileSync(process.execPath, ['--no-warnings', cli, action, '--home', home], {
      encoding: 'utf8',
    }),
  );
