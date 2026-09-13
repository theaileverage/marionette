import { Schema } from 'effect';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { packageRoot } from './runtime.js';

export type ProjectSkillInstall = {
  path: string;
  status: 'installed' | 'unchanged' | 'conflict';
  conflicts: string[];
};

export function installProjectSkills(root: string, source = packageRoot): ProjectSkillInstall[] {
  root = realpathSync(root);
  source = realpathSync(source);
  const skill = resolve(source, 'skills/marionette');
  const files = new Map<string, Buffer>();
  const directories: string[] = [''];
  function readTree(path: string) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory())
      throw new Error(`Marionette skill directory is missing or unsafe: ${path}`);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Marionette skill source contains a symlink: ${child}`);
      if (entry.isDirectory()) {
        directories.push(relative(skill, child));
        readTree(child);
      } else if (entry.isFile()) files.set(relative(skill, child), readFileSync(child));
      else throw new Error(`Unsupported Marionette skill source: ${child}`);
    }
  }
  const sourceSkills = lstatSync(resolve(source, 'skills'), { throwIfNoEntry: false });
  if (sourceSkills) {
    if (!sourceSkills.isDirectory())
      throw new Error(`Unsafe Marionette skills directory: ${source}/skills`);
    readTree(skill);
  } else {
    const artifact = resolve(source, 'dist/marionette-skills.json');
    const artifactStat = lstatSync(artifact, { throwIfNoEntry: false });
    if (!artifactStat) throw new Error(`Marionette skill directory is missing: ${skill}`);
    if (!lstatSync(resolve(source, 'dist')).isDirectory() || !artifactStat.isFile())
      throw new Error(`Unsafe Marionette skill bundle: ${artifact}`);
    const bundle = Schema.decodeUnknownSync(
      Schema.Struct({
        version: Schema.String,
        files: Schema.Record(Schema.String, Schema.String),
      }),
    )(JSON.parse(readFileSync(artifact, 'utf8')));
    const metadata = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
      JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')),
    );
    if (bundle.version !== metadata.version)
      throw new Error(`Marionette skill bundle version mismatch: ${artifact}`);
    for (const [name, encoded] of Object.entries(bundle.files)) {
      if (
        name.split('/').some((part) => !part || part === '.' || part === '..') ||
        name.includes('\\')
      )
        throw new Error(`Unsafe Marionette skill bundle path: ${name}`);
      files.set(name, Buffer.from(encoded, 'base64'));
      let parent = dirname(name);
      while (parent !== '.') {
        directories.push(parent);
        parent = dirname(parent);
      }
    }
    if (directories.some((directory) => files.has(directory)))
      throw new Error(`Conflicting Marionette skill bundle paths: ${artifact}`);
  }
  if (!files.has('SKILL.md')) throw new Error(`Marionette skill is missing SKILL.md: ${skill}`);
  return ['.agents', '.claude'].map((folder) => {
    const path = resolve(root, folder, 'skills/marionette');
    const conflicts = new Set<string>();
    const missing = new Map<string, Buffer>();
    function checkDirectory(directory: string): boolean {
      if (directory === root) return true;
      if (!checkDirectory(dirname(directory))) return false;
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) {
        conflicts.add(relative(root, directory));
        return false;
      }
      return true;
    }
    checkDirectory(path);
    if (conflicts.size === 0) {
      for (const directory of directories) checkDirectory(resolve(path, directory));
    }
    if (conflicts.size === 0) {
      for (const [name, contents] of files) {
        const target = resolve(path, name);
        const stat = lstatSync(target, { throwIfNoEntry: false });
        if (!stat) missing.set(name, contents);
        else if (!stat.isFile() || !readFileSync(target).equals(contents))
          conflicts.add(relative(root, target));
      }
    }
    if (conflicts.size) return { path, status: 'conflict', conflicts: [...conflicts] };
    for (const directory of directories) mkdirSync(resolve(path, directory), { recursive: true });
    for (const [name, contents] of missing)
      writeFileSync(resolve(path, name), contents, { flag: 'wx' });
    return { path, status: missing.size ? 'installed' : 'unchanged', conflicts: [] };
  });
}
