import { Schema } from 'effect';
import { AppError, type Kind } from './types.js';

export const accessModeSchema = Schema.Literals(['inherit', 'full-access']);
export const agentAccessSchema = Schema.Struct({
  codex: Schema.mutableKey(Schema.optionalKey(accessModeSchema)),
  claude: Schema.mutableKey(Schema.optionalKey(accessModeSchema)),
  agy: Schema.mutableKey(Schema.optionalKey(accessModeSchema)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type AgentAccess = Schema.Schema.Type<typeof agentAccessSchema>;

/** User-selected launch policy. Never changes a running process or host-managed restrictions. */
export function agentAccessArgs(
  kind: Kind,
  policy: AgentAccess | undefined,
  custom: string[] = [],
) {
  if (policy?.[kind] !== 'full-access') return [...custom];
  const permissionFlags =
    kind === 'codex'
      ? [
          '--sandbox',
          '-s',
          '--approve-for-me',
          '--full-auto',
          '--ask-for-approval',
          '-a',
          '--dangerously-bypass-approvals-and-sandbox',
          '--yolo',
        ]
      : kind === 'claude'
        ? [
            '--permission-mode',
            '--dangerously-skip-permissions',
            '--allow-dangerously-skip-permissions',
            '--settings',
          ]
        : ['--sandbox', '--dangerously-skip-permissions', '--mode'];
  const conflict = custom.some(
    (arg) =>
      permissionFlags.some((flag) => arg === flag || arg.startsWith(flag + '=')) ||
      (kind === 'codex' &&
        /^(?:-c|--config=)?(?:sandbox(?:_|\.)|approval_policy|permissions(?:\.|=))/.test(arg)),
  );
  if (conflict)
    throw new AppError({
      code: 'access_conflict',
      status: 400,
      message: `${kind} agentArgs contain permission or sandbox settings that conflict with agentAccess.full-access. Remove those arguments or select inherit to manage the harness policy yourself.`,
    });
  if (kind === 'codex') return [...custom, '--dangerously-bypass-approvals-and-sandbox'];
  if (kind === 'claude')
    return [
      ...custom,
      '--dangerously-skip-permissions',
      '--settings',
      '{"sandbox":{"enabled":false}}',
    ];
  return [...custom, '--dangerously-skip-permissions', '--sandbox=false'];
}
