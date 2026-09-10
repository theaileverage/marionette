import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Schema } from 'effect';
import { privateJson } from './private-json.js';

/** Stable short aliases for PTY launch arguments; target files remain in private state. */
export function terminalPath(directory: string) {
  const target = realpathSync(directory);
  const receipt = join(directory, 'terminal-path.json');
  if (existsSync(receipt)) {
    const path = Schema.decodeUnknownSync(Schema.String)(JSON.parse(readFileSync(receipt, 'utf8')));
    const parent = dirname(path);
    // A receipt may be stale after /tmp is cleared. Never reuse an unverified alias.
    if (
      dirname(parent) === '/tmp' &&
      basename(parent).startsWith('mnett-') &&
      basename(path) === 'g' &&
      existsSync(path)
    ) {
      const info = lstatSync(parent);
      if (
        info.isDirectory() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o077) === 0 &&
        lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === target
      )
        return path;
    }
  }
  // /tmp is deliberately used instead of macOS's long per-user TMPDIR: this
  // path is typed into a terminal, and contains no credentials or policy data.
  const parent = mkdtempSync('/tmp/mnett-');
  const path = join(parent, 'g');
  symlinkSync(target, path, 'dir');
  privateJson(receipt, path);
  return path;
}
