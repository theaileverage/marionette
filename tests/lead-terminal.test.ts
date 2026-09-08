import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Effect } from 'effect';
import { openLeadTerminalEffect, terminalLeadArgs } from '../src/lead-terminal.js';
import { leadPrompt } from '../src/setup.js';
import { AppError, type HerdrPort } from '../src/types.js';

function fixture() {
  const calls: { method: string; params: any }[] = [];
  const agents: any[] = [];
  const tabs: any[] = [];
  const panes: any[] = [];
  const processInfo: any = {
    pane_id: 'w9:p7',
    shell_pid: 100,
    foreground_process_group_id: 100,
    foreground_processes: [{ pid: 100, name: 'zsh' }],
  };
  let rejectStart = false;
  const h: HerdrPort = {
    async call(method, params = {}) {
      calls.push({ method, params });
      const result: any = {};
      if (method === 'agent.list') result.agents = agents;
      if (method === 'tab.list') result.tabs = tabs;
      if (method === 'pane.list') result.panes = panes;
      if (method === 'pane.process_info') result.process_info = processInfo;
      if (method === 'tab.create') {
        tabs.push({ label: params.label, tab_id: 'w9:t7', workspace_id: 'w9', pane_count: 1 });
        panes.push({
          pane_id: 'w9:p7',
          tab_id: 'w9:t7',
          workspace_id: 'w9',
          cwd: '/project with spaces',
        });
        result.root_pane = { pane_id: 'w9:p7' };
      }
      if (method === 'agent.start') {
        assert.ok(Array.isArray(params.args));
        if (params.args.some((arg) => /\p{Cc}/u.test(String(arg))))
          throw new Error('agent arguments cannot be encoded safely for the target shell');
        if (rejectStart) {
          processInfo.foreground_process_group_id = 101;
          processInfo.foreground_processes = [{ pid: 101, name: 'codex' }];
          throw new Error('Connection lost after launch');
        }
        const agent = {
          name: params.name,
          agent: params.kind,
          workspace_id: 'w9',
          cwd: '/project with spaces',
          pane_id: 'w9:p7',
          tab_id: 'w9:t7',
        };
        agents.push(agent);
        result.agent = agent;
      }
      return result;
    },
  };
  const lead = {
    projectId: 'project-1',
    root: '/project with spaces',
    workspace: 'w9',
    epoch: 2,
    kind: 'codex',
    owner: 'Ada',
    args: ['--model', 'chosen', 'Bootstrap prompt'],
  };
  return {
    calls,
    agents,
    tabs,
    panes,
    processInfo,
    lead,
    h,
    failStart: () => {
      rejectStart = true;
    },
  };
}

test('lead opens in the configured Herdr workspace and reuses the same agent without replaying its prompt', async () => {
  const f = fixture();
  const first = await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') throw new Error('Expected a running lead');
  assert.equal(first.agent.pane_id, 'w9:p7');
  assert.deepEqual(f.calls.find((c) => c.method === 'tab.create')?.params, {
    workspace_id: 'w9',
    cwd: '/project with spaces',
    label: f.tabs[0].label,
    focus: true,
  });
  const launch = f.calls.find((c) => c.method === 'agent.start')?.params;
  assert.deepEqual(launch.args, f.lead.args);
  assert.equal(launch.pane_id, 'w9:p7');
  assert.equal(launch.kind, 'codex');
  await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  assert.equal(f.calls.filter((c) => c.method === 'agent.start').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'tab.create').length, 1);
  assert.deepEqual(f.calls.at(-1), { method: 'tab.focus', params: { tab_id: 'w9:t7' } });
});

test('ambiguous lead startup opens its surviving tab for inspection without replaying launch', async () => {
  const f = fixture();
  f.failStart();
  await assert.rejects(Effect.runPromise(openLeadTerminalEffect(f.h, f.lead)), /Connection lost/);
  const result = await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  assert.equal(result.status, 'inspect');
  assert.deepEqual(f.calls.at(-1), { method: 'tab.focus', params: { tab_id: 'w9:t7' } });
  assert.equal(f.calls.filter((c) => c.method === 'agent.start').length, 1);
  assert.equal(f.tabs.length, 1);
});

test('reusing a lead verifies project identity and a new lease epoch gets a distinct agent', async () => {
  const f = fixture();
  await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  f.agents[0].workspace_id = 'w8';
  await assert.rejects(Effect.runPromise(openLeadTerminalEffect(f.h, f.lead)), /does not match/);
  await Effect.runPromise(openLeadTerminalEffect(f.h, { ...f.lead, epoch: 3 }));
  assert.notEqual(f.agents[0].name, f.agents[1].name);
});

test('lead startup waits for a newly created shell only after a definitive pre-launch refusal', async () => {
  const f = fixture();
  let attempts = 0;
  const h: HerdrPort = {
    async call(method, params, timeout, signal) {
      if (method === 'agent.start' && attempts++ === 0)
        throw new AppError({
          code: 'pane_not_available',
          message: 'Pane is not an available shell',
          status: 409,
        });
      return f.h.call(method, params, timeout, signal);
    },
  };
  await Effect.runPromise(openLeadTerminalEffect(h, f.lead));
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter((c) => c.method === 'tab.create').length, 1);
});

test('an exited lead restarts in the same verified shell without closing or duplicating its tab', async () => {
  const f = fixture();
  await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  f.agents.length = 0;
  const result = await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  assert.equal(result.status, 'ready');
  assert.equal(f.calls.filter((c) => c.method === 'tab.create').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'agent.start').length, 2);
  assert.equal(f.calls.filter((c) => c.method === 'tab.close').length, 0);
  assert.equal(f.calls.filter((c) => c.method === 'agent.start').at(-1)?.params.pane_id, 'w9:p7');
  await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
  assert.equal(f.calls.filter((c) => c.method === 'agent.start').length, 2);
});

for (const state of [
  'missing-processes',
  'other-process',
  'split-tab',
  'changed-directory',
  'agent-pending',
]) {
  test(`lead preserves an existing tab with ${state} for inspection`, async () => {
    const f = fixture();
    await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
    f.agents.length = 0;
    if (state === 'missing-processes') delete f.processInfo.foreground_processes;
    if (state === 'other-process')
      f.processInfo.foreground_processes.push({ pid: 200, name: 'editor' });
    if (state === 'split-tab') f.tabs[0].pane_count = 2;
    if (state === 'changed-directory') f.panes[0].cwd = '/another-project';
    if (state === 'agent-pending') f.agents.push({ pane_id: 'w9:p7', launch_pending: true });
    const result = await Effect.runPromise(openLeadTerminalEffect(f.h, f.lead));
    assert.equal(result.status, 'inspect');
    assert.equal(f.calls.filter((c) => c.method === 'agent.start').length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'tab.create').length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'tab.close').length, 0);
  });
}

for (const kind of ['codex', 'claude', 'agy']) {
  test(`${kind} starts with the full lead bootstrap as one argument without control characters`, async () => {
    const f = fixture();
    const prompt = leadPrompt(f.lead.projectId, "Ada O'Neil", '/state with spaces/lease.json');
    assert.ok(prompt.includes('\n'));
    const model = ['--model', 'chosen-model'];
    const args = terminalLeadArgs(kind, model, prompt);
    assert.deepEqual(args.slice(0, 2), model);
    if (kind === 'agy') assert.equal(args[2], '--prompt-interactive');
    assert.equal(args.length, kind === 'agy' ? 4 : 3);
    assert.equal(args.at(-1), prompt.replace(/\r\n|[\n\r\t]/g, ' '));
    assert.ok(args.at(-1)?.includes("Ada O'Neil"));
    assert.ok(args.at(-1)?.includes('/state with spaces/lease.json'));
    const result = await Effect.runPromise(openLeadTerminalEffect(f.h, { ...f.lead, kind, args }));
    assert.equal(result.status, 'ready');
    assert.deepEqual(f.calls.find((c) => c.method === 'agent.start')?.params.args, args);
  });
}

test('unsupported control characters in custom launch arguments fail before creating a tab', async () => {
  const f = fixture();
  await assert.rejects(
    Effect.runPromise(
      openLeadTerminalEffect(f.h, {
        ...f.lead,
        args: terminalLeadArgs('codex', ['--model', 'bad\u0000model'], 'Prose prompt'),
      }),
    ),
    /control characters unsupported by Herdr/,
  );
  assert.equal(f.calls.length, 0);
});
