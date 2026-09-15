import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProjectSkillInstallation = {
  readonly status: 'installed' | 'existing';
  readonly path: string;
};

export function installProjectSkill(repositoryRoot: string): ProjectSkillInstallation {
  const source = fileURLToPath(new URL('../../skills/marionette/', import.meta.url));
  const target = join(repositoryRoot, '.agents', 'skills', 'marionette');

  if (existsSync(target)) return { status: 'existing', path: join(target, 'SKILL.md') };
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, errorOnExist: true });

  return { status: 'installed', path: join(target, 'SKILL.md') };
}
