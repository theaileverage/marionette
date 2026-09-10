import { Schema } from 'effect';
import { AppError, type Assignment } from './types.js';
import type { Profile } from './orchestration-types.js';

export const roleSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,80}$/)),
  profileId: Schema.String.check(Schema.isMinLength(1)),
  activity: Schema.Literals(['coordinate', 'inspect', 'documentation', 'implementation']),
  canDelegate: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type Role = Schema.Schema.Type<typeof roleSchema>;
export const suggestedRoles = {
  lead: 'coordinate',
  scout: 'inspect',
  researcher: 'inspect',
  architect: 'documentation',
  implementer: 'implementation',
  reviewer: 'inspect',
  verifier: 'inspect',
  documentation: 'documentation',
} as const;

export function resolveRole(roles: readonly Role[], assignment: Pick<Assignment, 'role'>) {
  if (!assignment.role) return undefined;
  const role = roles.find((r) => r.id === assignment.role);
  if (!role)
    throw new AppError({
      code: 'role_missing',
      message: `Configure role ${assignment.role} before dispatch. No fallback was selected.`,
      status: 409,
    });
  return role;
}

export function validateRoles(roles: readonly Role[], profiles: readonly Profile[]) {
  if (new Set(roles.map((r) => r.id)).size !== roles.length)
    throw new AppError({ code: 'role_ids', message: 'Role IDs must be unique', status: 400 });
  for (const role of roles) {
    const profile = profiles.find((p) => p.id === role.profileId);
    if (!profile)
      throw new AppError({
        code: 'profile_missing',
        message: `Role ${role.id} references an unknown profile`,
        status: 400,
      });
    if (role.canDelegate && !profile.canDelegate)
      throw new AppError({
        code: 'delegation_denied',
        message: `Profile for ${role.id} does not permit delegation`,
        status: 400,
      });
    if (role.id === 'lead' && (role.activity !== 'coordinate' || !role.canDelegate))
      throw new AppError({
        code: 'lead_role',
        message: 'The lead role must remain coordinator-only and permit delegation',
        status: 400,
      });
  }
}
