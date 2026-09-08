import { Config, Effect, Schema } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Kind, Project } from './types.js';

const object = Schema.Record(Schema.String, Schema.mutableKey(Schema.MutableJson));
const decodeObject = Schema.decodeUnknownSync(object);
const receiptSchema = Schema.Struct({
  kind: Schema.Literals(['codex', 'claude', 'agy']),
  root: Schema.String,
  settingsPath: Schema.String,
  previous: Schema.NullOr(Schema.Union([Schema.String, Schema.Boolean])),
  createdSection: Schema.Boolean,
  consumers: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
});

export function workspaceTrustEnabled(
  project: Pick<Project, 'trustWorkspaces' | 'trustAgyWorkspaces'>,
  kind: Kind,
) {
  // Legacy opt-in authorized AGY only. Upgrades must not silently broaden its scope.
  return project.trustWorkspaces ?? (kind === 'agy' && project.trustAgyWorkspaces === true);
}
export function trustSettingsPath(kind: Kind) {
  const env = (name: string, fallback: string) =>
    Effect.runSync(Config.string(name).pipe(Config.withDefault(fallback)));
  if (kind === 'agy')
    return resolve(
      env('MARIONETTE_AGY_SETTINGS', resolve(homedir(), '.gemini/antigravity-cli/settings.json')),
    );
  if (kind === 'claude')
    return resolve(
      env(
        'MARIONETTE_CLAUDE_SETTINGS',
        resolve(env('CLAUDE_CONFIG_DIR', homedir()), '.claude.json'),
      ),
    );
  return resolve(env('CODEX_HOME', resolve(homedir(), '.codex')), 'config.toml');
}
function writeAtomic(path: string, text: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, text, { flag: 'wx', mode });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function settingsLock<T>(path: string, fn: () => T) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.marionette.lock';
  const fd = openSync(lock, 'wx', 0o600);
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
function parseSettings(kind: Kind, text: string) {
  return decodeObject(kind === 'codex' ? Bun.TOML.parse(text) : JSON.parse(text || '{}'));
}
function projectSettings(settings: Schema.MutableJson, root: string) {
  const projects = decodeObject(decodeObject(settings).projects ?? {});
  return decodeObject(projects[root] ?? {});
}
function trustValue(kind: Kind, settings: Schema.MutableJson, root: string) {
  if (kind === 'agy')
    return Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      decodeObject(settings).trustedWorkspaces ?? [],
    ).includes(root);
  const p = projectSettings(settings, root);
  const value = p[kind === 'codex' ? 'trust_level' : 'hasTrustDialogAccepted'];
  if (value === undefined) return null;
  return kind === 'codex'
    ? Schema.decodeUnknownSync(Schema.String)(value)
    : Schema.decodeUnknownSync(Schema.Boolean)(value);
}
function editCodex(text: string, root: string, value: string | null, removeEmptySection: boolean) {
  const lines = text.split('\n');
  let start = -1,
    end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[/.test(lines[i])) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    try {
      const probe = decodeObject(Bun.TOML.parse(lines[i] + '\n__marionette_probe = true'));
      if (projectSettings(probe, root).__marionette_probe === true) start = i;
    } catch {
      /* A multiline value or a different table is not the project table. */
    }
  }
  if (start < 0) {
    if (value === null)
      throw new Error(
        'Cannot locate the Codex project trust setting; preserve the configuration and edit it manually.',
      );
    return (
      text.replace(/\s*$/, '') +
      `\n\n[projects.${JSON.stringify(root)}]\ntrust_level = ${JSON.stringify(value)}\n`
    );
  }
  let key = -1;
  for (let i = start + 1; i < end; i++)
    if (/^\s*(?:trust_level|"trust_level"|'trust_level')\s*=/.test(lines[i])) key = i;
  if (key >= 0) {
    if (value === null) lines.splice(key, 1);
    else {
      const match =
        /^(\s*(?:trust_level|"trust_level"|'trust_level')\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(
          lines[key],
        );
      if (!match)
        throw new Error(
          'Codex trust setting uses unsupported TOML syntax; preserve the configuration and edit it manually.',
        );
      lines[key] = match[1] + JSON.stringify(value) + match[2];
    }
  } else if (value !== null) lines.splice(start + 1, 0, `trust_level = ${JSON.stringify(value)}`);
  if (value === null && removeEmptySection) {
    const next = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
    const stop = next < 0 ? lines.length : next;
    if (lines.slice(start + 1, stop).every((line) => !line.trim()))
      lines.splice(start, stop - start);
  }
  return lines.join('\n');
}
function editTrust(
  kind: Kind,
  before: string,
  root: string,
  value: string | boolean | null,
  createdSection: boolean,
) {
  if (kind === 'codex') {
    const after = editCodex(
      before,
      root,
      value === null ? null : Schema.decodeUnknownSync(Schema.String)(value),
      createdSection,
    );
    const parsed = parseSettings(kind, after);
    if (trustValue(kind, parsed, root) !== value)
      throw new Error('Could not safely update the Codex project trust setting.');
    return after;
  }
  const settings = parseSettings(kind, before);
  if (kind === 'agy') {
    const trusted = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      settings.trustedWorkspaces ?? [],
    );
    settings.trustedWorkspaces =
      value === true ? [...new Set([...trusted, root])] : trusted.filter((path) => path !== root);
    if (createdSection && !settings.trustedWorkspaces.length) delete settings.trustedWorkspaces;
  } else {
    const projects = decodeObject(settings.projects ?? {});
    const p = decodeObject(projects[root] ?? {});
    if (value === null) delete p.hasTrustDialogAccepted;
    else p.hasTrustDialogAccepted = Schema.decodeUnknownSync(Schema.Boolean)(value);
    if (createdSection && !Object.keys(p).length) delete projects[root];
    else projects[root] = p;
    if (Object.keys(projects).length) settings.projects = projects;
    else delete settings.projects;
  }
  return JSON.stringify(settings, null, 2) + '\n';
}
function receiptPath(home: string, kind: Kind, root: string, settingsPath: string) {
  return resolve(
    home,
    'trust',
    createHash('sha256')
      .update(JSON.stringify([kind, root, settingsPath]))
      .digest('hex') + '.json',
  );
}

/** Registers workspace trust only, recording exactly the field Marionette changed for removal. */
export function trustWorkspace(
  root: string,
  kind: Kind,
  home: string,
  projectId: string,
  settingsPath = trustSettingsPath(kind),
) {
  root = realpathSync(root);
  settingsPath = existsSync(settingsPath) ? realpathSync(settingsPath) : resolve(settingsPath);
  if (!statSync(root).isDirectory()) throw new Error('Workspace trust requires a directory');
  return settingsLock(settingsPath, () => {
    const file = receiptPath(home, kind, root, settingsPath);
    const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
    const settings = parseSettings(kind, before);
    const previous = trustValue(kind, settings, root);
    const trusted = kind === 'codex' ? 'trusted' : true;
    let receipt = existsSync(file)
      ? Schema.decodeUnknownSync(receiptSchema)(JSON.parse(readFileSync(file, 'utf8')))
      : undefined;
    if (previous === trusted && !receipt) return { kind, root, changed: false, preexisting: true };
    if (!receipt)
      receipt = {
        kind,
        root,
        settingsPath,
        previous,
        createdSection:
          kind === 'agy'
            ? settings.trustedWorkspaces === undefined
            : decodeObject(settings.projects ?? {})[root] === undefined,
        consumers: [],
      };
    if (!receipt.consumers.includes(projectId)) receipt.consumers.push(projectId);
    // Persist ownership before changing another application's file, so interruption is recoverable.
    writeAtomic(file, JSON.stringify(receipt, null, 2) + '\n');
    if (previous === trusted) return { kind, root, changed: false };
    const after = editTrust(kind, before, root, trusted, receipt.createdSection);
    if ((existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '') !== before)
      throw new Error(`${kind} settings changed during trust registration; retry.`);
    writeAtomic(
      settingsPath,
      after,
      existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : 0o600,
    );
    return { kind, root, changed: true };
  });
}

export function removeWorkspaceTrust(home: string, projectId: string) {
  const dir = resolve(home, 'trust');
  const results: { kind: Kind; root: string; restored: boolean }[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const file = resolve(dir, entry);
    const initial = Schema.decodeUnknownSync(receiptSchema)(JSON.parse(readFileSync(file, 'utf8')));
    if (!initial.consumers.includes(projectId)) continue;
    settingsLock(initial.settingsPath, () => {
      const receipt = Schema.decodeUnknownSync(receiptSchema)(
        JSON.parse(readFileSync(file, 'utf8')),
      );
      receipt.consumers = receipt.consumers.filter((id) => id !== projectId);
      if (receipt.consumers.length) {
        writeAtomic(file, JSON.stringify(receipt, null, 2) + '\n');
        return;
      }
      const before = existsSync(receipt.settingsPath)
        ? readFileSync(receipt.settingsPath, 'utf8')
        : '';
      const trusted = receipt.kind === 'codex' ? 'trusted' : true;
      const restored =
        trustValue(receipt.kind, parseSettings(receipt.kind, before), receipt.root) === trusted;
      if (restored) {
        const after = editTrust(
          receipt.kind,
          before,
          receipt.root,
          receipt.previous,
          receipt.createdSection,
        );
        if (
          (existsSync(receipt.settingsPath) ? readFileSync(receipt.settingsPath, 'utf8') : '') !==
          before
        )
          throw new Error(`${receipt.kind} settings changed during trust removal; retry.`);
        writeAtomic(receipt.settingsPath, after, statSync(receipt.settingsPath).mode & 0o777);
      }
      unlinkSync(file);
      results.push({ kind: receipt.kind, root: receipt.root, restored });
    });
  }
  return results;
}
