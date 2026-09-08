import { Effect } from 'effect';
import { herdrCall } from './effect-runtime.js';
import type { ResponseTypes } from './herdr-protocol.js';
import { AppError, type HerdrPort } from './types.js';

interface WorkspaceSelection {
  root: string;
  workspaceLabel: string;
  workspace?: string;
  workspaceExplicit: boolean;
  ownsWorkspace: boolean;
}

/** Saved workspace IDs may disappear when a session is reset or its workspace is closed. */
export const setupWorkspaceEffect = Effect.fn('Setup.workspace')(function* (
  h: HerdrPort,
  plan: WorkspaceSelection,
) {
  const { workspaces }: { workspaces: ResponseTypes.WorkspaceInfo[] } = yield* herdrCall(
    h,
    'workspace.list',
  );
  let workspaceId = plan.workspace;
  let ownsWorkspace = plan.ownsWorkspace;
  const missing = !!workspaceId && !workspaces.some((w) => w.workspace_id === workspaceId);
  if (missing && plan.workspaceExplicit)
    return yield* new AppError({
      code: 'workspace_not_found',
      message: `Requested workspace ${workspaceId} does not exist in the selected session. Choose an existing --workspace or omit it to recover the saved project workspace.`,
      status: 404,
    });
  if (missing) {
    workspaceId = undefined;
    ownsWorkspace = false;
  }
  if (!workspaceId) {
    const matches = workspaces.filter((w) => w.label === plan.workspaceLabel);
    if (matches.length > 1)
      return yield* new AppError({
        code: 'workspace_ambiguous',
        message: 'Multiple matching Herdr workspaces; select one with --workspace.',
        status: 409,
      });
    workspaceId = matches[0]?.workspace_id;
    if (!workspaceId) {
      const { workspace }: { workspace: ResponseTypes.WorkspaceInfo } = yield* herdrCall(
        h,
        'workspace.create',
        {
          cwd: plan.root,
          label: plan.workspaceLabel,
          focus: false,
        },
      );
      workspaceId = workspace.workspace_id;
      ownsWorkspace = true;
    }
  }
  yield* herdrCall(h, 'workspace.get', { workspace_id: workspaceId });
  return { workspaceId, ownsWorkspace, recovered: missing };
});
