import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkerPane } from '../src/worker-layout.js';
import type { Run, HerdrPort } from '../src/types.js';

function fixture(count = 1, width = 180, height = 48) {
  const panes = Array.from({ length: count }, (_, n) => ({
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    pane_id: `w1:p${n}`,
    terminal_id: `term-${n}`,
  }));
  const runs = panes.map((p) => ({
    id: p.pane_id,
    terminalScope: 'pane',
    paneId: p.pane_id,
    tabId: p.tab_id,
    terminalId: p.terminal_id,
    phase: 'running',
  })) as Run[];
  const h: HerdrPort = {
    async call(method) {
      if (method === 'pane.list') return { panes };
      if (method === 'pane.layout')
        return {
          layout: {
            workspace_id: 'w1',
            tab_id: 'w1:t1',
            panes: panes.map((p) => ({ pane_id: p.pane_id, rect: { width, height } })),
          },
        };
      throw new Error('Unexpected mutation ' + method);
    },
  };
  return { panes, runs, h };
}

test('worker layout chooses geometry and caps tabs at four panes', async () => {
  for (const [count, width, height, mode, direction] of [
    [1, 180, 48, 'pane', 'right'],
    [2, 90, 48, 'pane', 'down'],
    [3, 90, 24, 'tab', undefined],
    [4, 240, 100, 'tab', undefined],
  ] as const) {
    const f = fixture(count, width, height);
    const plan = await planWorkerPane(f.h, 'w1', f.runs);
    assert.equal(plan.mode, mode);
    assert.equal(plan.direction, direction);
    if (mode === 'pane')
      assert.deepEqual(
        plan.beforePaneIds,
        f.panes.map((p) => p.pane_id),
      );
  }
});
test('worker layout refuses user members, changed identities, legacy tabs, and uncertain creation', async () => {
  for (const change of ['user', 'terminal', 'legacy', 'creating', 'cleanup'] as const) {
    const f = fixture(2);
    if (change === 'user') f.runs.pop();
    if (change === 'terminal') f.runs[0].terminalId = 'replaced';
    if (change === 'legacy') delete f.runs[0].terminalScope;
    if (change === 'creating')
      f.runs.push({ phase: 'creating', creation: { mode: 'pane', tabId: 'w1:t1' } } as Run);
    if (change === 'cleanup')
      f.runs[0].cleanup = { state: 'closing', reason: 'release', updatedAt: '' };
    assert.equal((await planWorkerPane(f.h, 'w1', f.runs)).mode, 'tab', change);
  }
});
test('worker layout chooses the largest eligible pane, not the focused one', async () => {
  const f = fixture(2);
  const original = f.h.call;
  f.h.call = async (method, params) => {
    const response = await original(method, params);
    if (method === 'pane.layout') response.layout.panes[0].rect.width = 65;
    return response;
  };
  assert.equal((await planWorkerPane(f.h, 'w1', f.runs)).targetPaneId, 'w1:p1');
});
