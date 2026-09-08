import { Effect } from 'effect';
import { herdrCall } from './effect-runtime.js';
import type { Pane, PaneLayout } from './herdr-sdk.js';
import type { HerdrPort, Run } from './types.js';
import { AppError } from './types.js';

/** Only split tabs whose entire live membership is pinned to known Marionette runs. */
export const planWorkerPaneEffect = Effect.fn('WorkerLayout.plan')(function* (
  h: HerdrPort,
  workspaceId: string,
  runs: Run[],
) {
  const panes: Pane[] = (yield* herdrCall(h, 'pane.list', { workspace_id: workspaceId })).panes;
  if (!Array.isArray(panes))
    return yield* new AppError({
      code: 'invalid_panes',
      message: 'Herdr did not return workspace panes',
      status: 502,
    });
  const candidates = runs.filter(
    (r) =>
      r.terminalScope === 'pane' && r.paneId && r.tabId && !r.cleanup && r.phase !== 'creating',
  );
  for (const tabId of new Set(candidates.map((r) => r.tabId!))) {
    if (runs.some((r) => r.phase === 'creating' && r.creation?.tabId === tabId)) continue;
    const members = panes.filter((p) => p.workspace_id === workspaceId && p.tab_id === tabId);
    if (!members.length || members.length >= 4) continue;
    if (
      !members.every((p) =>
        candidates.some(
          (r) => r.paneId === p.pane_id && r.terminalId === p.terminal_id && r.tabId === p.tab_id,
        ),
      )
    )
      continue;
    const layout: PaneLayout = (yield* herdrCall(h, 'pane.layout', { pane_id: members[0].pane_id }))
      .layout;
    if (
      layout?.workspace_id !== workspaceId ||
      layout.tab_id !== tabId ||
      !Array.isArray(layout.panes)
    )
      continue;
    // Minimum 60 columns x 12 rows per resulting worker; prefer balanced rectangles.
    const choices = layout.panes
      .flatMap((p) => {
        if (!members.some((m) => m.pane_id === p.pane_id)) return [];
        const { width, height } = p.rect;
        const right = width >= 121 && height >= 12;
        const down = height >= 25 && width >= 60;
        if (!right && !down) return [];
        return [
          {
            paneId: p.pane_id,
            area: width * height,
            direction: right && (!down || width >= height * 3) ? 'right' : 'down',
          },
        ] satisfies { paneId: string; area: number; direction: 'right' | 'down' }[];
      })
      .sort((a, b) => b.area - a.area);
    if (choices.length)
      return {
        mode: 'pane',
        tabId,
        targetPaneId: choices[0].paneId,
        direction: choices[0].direction,
        beforePaneIds: panes.map((p) => p.pane_id),
      } satisfies NonNullable<Run['creation']>;
  }
  return { mode: 'tab' } satisfies NonNullable<Run['creation']>;
});
export const planWorkerPane = (h: HerdrPort, workspaceId: string, runs: Run[]) =>
  Effect.runPromise(planWorkerPaneEffect(h, workspaceId, runs));
