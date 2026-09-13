import { Schema } from 'effect';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hash, inside } from './files.js';
import { readBinding } from './project-binding.js';
import type { Service } from './service.js';
import { AppError, credentialsSchema, now } from './types.js';

const skillPath = Schema.String.check(
  Schema.isPattern(/^\.(agents|claude)\/skills\/[a-zA-Z0-9_-]{1,80}\/SKILL\.md$/),
);
export const leadPreferencesSchema = Schema.Struct({
  profileId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  reasoning: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  instructions: Schema.String.check(Schema.isMaxLength(20000)),
  skills: Schema.Array(skillPath).check(Schema.isMaxLength(20)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export interface LeadPreferences extends Schema.Schema.Type<typeof leadPreferencesSchema> {
  projectId: string;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
}
const getInput = Schema.Struct({ projectId: Schema.String, lease: credentialsSchema });
const setInput = Schema.Struct({
  ...getInput.fields,
  expectedRevision: Schema.Int,
  preferences: leadPreferencesSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export function savedLeadPreferences(s: Service, projectId: string): LeadPreferences {
  s.project(projectId);
  return (
    s.store.get<LeadPreferences>('lead-preferences', projectId) ?? {
      projectId,
      revision: 0,
      instructions: '',
      skills: [],
    }
  );
}

export function leadSkillContents(root: string, paths: readonly string[]) {
  return paths.map((path) => {
    Schema.decodeSync(skillPath)(path);
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink())
        throw new AppError({
          code: 'skill_path',
          message: 'Selected skill paths cannot contain symlinks',
          status: 400,
        });
    }
    if (!inside(realpathSync(root), realpathSync(current)))
      throw new AppError({
        code: 'skill_path',
        message: 'Skill must stay inside this project',
        status: 400,
      });
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > 50000)
      throw new AppError({
        code: 'skill_size',
        message: 'Selected skill must be a file of at most 50 KB',
        status: 400,
      });
    const content = readFileSync(current, 'utf8');
    return { path, content, digest: hash(content) };
  });
}

export function getLeadPreferences<Input>(s: Service, raw: Input) {
  const input = Schema.decodeUnknownSync(getInput)(raw);
  const lease = s.guard(input.lease);
  if (lease.projectId !== input.projectId)
    throw new AppError({
      code: 'project_mismatch',
      message: 'Preferences belong to another project',
      status: 403,
    });
  const preferences = savedLeadPreferences(s, lease.projectId);
  return {
    ...preferences,
    skillContents: leadSkillContents(s.project(lease.projectId).root, preferences.skills),
    applies: {
      model: 'next-launch',
      reasoning: 'next-launch',
      instructions: 'next-read',
      skills: 'next-read',
    },
  };
}

export function setLeadPreferences<Input>(s: Service, raw: Input) {
  const input = Schema.decodeUnknownSync(setInput)(raw);
  const lease = s.guard(input.lease);
  if (lease.projectId !== input.projectId)
    throw new AppError({
      code: 'project_mismatch',
      message: 'Preferences belong to another project',
      status: 403,
    });
  const project = s.project(lease.projectId);
  const previous = savedLeadPreferences(s, project.id);
  if (input.expectedRevision !== previous.revision)
    throw new AppError({
      code: 'preferences_revision',
      message: 'Preferences changed. Read lead_preferences_get before updating.',
      status: 409,
    });
  const { preferences } = input;
  if (preferences.profileId) {
    const profile = s.orchestration
      .profiles(project.id)
      .find((p) => p.id === preferences.profileId);
    const { binding } = readBinding(project.root);
    if (!profile || profile.availability !== 'available' || profile.kind !== binding.lead)
      throw new AppError({
        code: 'lead_profile',
        message: 'Select an available exact profile matching the configured lead adapter',
        status: 400,
      });
    if (preferences.reasoning && !profile.supportedReasoning.includes(preferences.reasoning))
      throw new AppError({
        code: 'reasoning_unsupported',
        message: 'Reasoning is not supported by the selected profile',
        status: 400,
      });
  } else if (preferences.reasoning) {
    throw new AppError({
      code: 'lead_profile',
      message: 'Select an exact profile before setting reasoning',
      status: 400,
    });
  }
  leadSkillContents(project.root, preferences.skills);
  const saved: LeadPreferences = {
    ...preferences,
    projectId: project.id,
    revision: previous.revision + 1,
    updatedAt: now(),
    updatedBy: lease.owner,
  };
  s.store.transaction(() => {
    s.store.put('lead-preferences', project.id, saved);
    s.store.event(
      project.id,
      'lead.preferences.updated',
      'Lead saved project preferences',
      undefined,
      {
        revision: saved.revision,
        owner: lease.owner,
        profileId: saved.profileId,
        skills: saved.skills,
      },
    );
  });
  return getLeadPreferences(s, input);
}
