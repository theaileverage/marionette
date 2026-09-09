import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { AppError, now, type HerdrPort, type Project, type Run, type Task } from '../src/types.js';
class Agents implements HerdrPort {
  agents = new Map<string, any>();
  envs = new Map<string, any>();
  panes = new Map<string, any>();
  calls: { method: string; params: any }[] = [];
  failPrompt = false;
  next = 0;
  async call(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'ping' || method === 'workspace.get') return {};
    if (method === 'pane.list') return { panes: [...this.panes.values()] };
    if (method === 'pane.layout') {
      const tab = this.panes.get(params.pane_id).tab_id;
      return {
        layout: {
          workspace_id: 'w1',
          tab_id: tab,
          panes: [...this.panes.values()]
            .filter((p) => p.tab_id === tab)
            .map((p) => ({ pane_id: p.pane_id, rect: { x: 0, y: 0, width: 180, height: 48 } })),
        },
      };
    }
    if (method === 'tab.create' || method === 'pane.split') {
      const n = ++this.next,
        pane = {
          pane_id: `w1:p${n}`,
          tab_id:
            method === 'pane.split' ? this.panes.get(params.target_pane_id).tab_id : `w1:t${n}`,
          workspace_id: 'w1',
          terminal_id: `terminal-${n}`,
        };
      this.envs.set(pane.pane_id, params.env);
      this.panes.set(pane.pane_id, { ...pane, cwd: params.cwd });
      return method === 'pane.split' ? { pane } : { root_pane: pane };
    }
    if (method === 'agent.start') {
      const n = params.pane_id.split('p')[1];
      const a = {
        pane_id: params.pane_id,
        terminal_id: `terminal-${n}`,
        workspace_id: 'w1',
        name: params.name,
        agent: params.kind,
        agent_status: 'idle',
        state_change_seq: 0,
        agent_session: { value: `native-${n}` },
      };
      this.agents.set(a.pane_id, a);
      return { agent: a };
    }
    if (method === 'agent.get') {
      const a = this.agents.get(params.target);
      if (!a)
        throw new AppError({ code: 'agent_not_found', message: 'Missing test agent', status: 400 });
      return { agent: { ...a } };
    }
    if (method === 'agent.prompt') {
      if (this.failPrompt)
        throw new AppError({
          code: 'herdr_timeout',
          message: 'Lost delivery acknowledgement',
          status: 400,
        });
      const a = this.agents.get(params.target);
      a.agent_status = 'working';
      a.state_change_seq++;
      return {};
    }
    if (method === 'agent.send_keys') {
      this.agents.get(params.target).agent_status = 'idle';
      return {};
    }
    if (method === 'pane.read') return { read: { text: 'Protocol fixture; no real agent work.' } };
    throw new Error('Unexpected protocol method ' + method);
  }
}
export async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-outcomes-'))),
    store = new Store(join(root, 'state.sqlite'));
  const agents = new Agents(),
    service = new Service(store, () => agents),
    supervisor = new Supervisor(service, 'http://localhost:1', '/test/cli.js', 1);
  const p: Project = {
    id: 'project',
    name: 'Test',
    root,
    session: 'test',
    socketPath: join(root, 'herdr.sock'),
    workspaceId: 'w1',
    maxConcurrency: 3,
    agentArgs: {},
    createdAt: now(),
  };
  store.put('project', p.id, p);
  const lease = (
    await service.invoke('lead.acquire', {
      projectId: p.id,
      owner: 'lead',
      expectedEpoch: 0,
      reason: 'Test outcome orchestration',
    })
  ).lease;
  const invoke = (action: string, raw: any = {}) => service.invoke(action, { ...raw, lease });
  const outcome = await invoke('outcome.create', {
    outcome: {
      projectId: p.id,
      key: 'outcome',
      objective: 'Deliver the integrated result',
      scope: ['.'],
      criteria: [
        {
          id: 'correct',
          description: 'The result meets the contract',
          requiredEvidence: 'Independent tests and integrated review',
        },
      ],
    },
  });
  const submit = (title: string, extra: any = {}) =>
    invoke('task.submit', {
      assignment: {
        projectId: p.id,
        key: title,
        title,
        kind: 'codex',
        prompt: title,
        ownership: [title],
        checks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        outcomeId: outcome.id,
        expectedTreeRevision: service.orchestration.outcome(outcome.id).revision,
        ...extra,
      },
    });
  const run = (t: Task) => store.get<Run>('run', service.task(t.id).runId!)!;
  const token = (t: Task) => agents.envs.get(run(t).paneId!).MARIONETTE_WORKER_TOKEN;
  const settle = (t: Task) => {
    const a = agents.agents.get(run(t).paneId!);
    a.agent_status = 'idle';
    a.state_change_seq++;
    run(t).settledAt = Date.now() - 50;
  };
  const tick = async () => {
    supervisor.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const complete = async (t: Task) => {
    const current = service.task(t.id);
    service.report(t.id, token(t), {
      revision: current.revision,
      type: 'complete',
      summary: 'Produced tested result',
      evidence: ['Independent check pending'],
    });
    settle(t);
    for (let n = 0; n < 80 && !['completed', 'failed'].includes(service.task(t.id).status); n++)
      await tick();
    return service.task(t.id);
  };
  const done = (t: Task) =>
    service.updateTask(t, {
      status: 'completed',
      verification: [
        { check: t.checks[0], passed: true, detail: 'Fixture evidence', checkedAt: now() },
      ],
    });
  const leadAgent = () => {
    const a = {
      pane_id: 'w1:plead',
      terminal_id: 'lead-terminal',
      workspace_id: 'w1',
      name: 'root-lead',
      agent: 'claude',
      agent_status: 'idle',
      state_change_seq: 0,
      agent_session: { value: 'lead-native-session' },
    };
    agents.agents.set(a.pane_id, a);
    return {
      type: 'herdr' as const,
      paneId: a.pane_id,
      terminalId: a.terminal_id,
      name: a.name,
      kind: 'claude' as const,
      nativeSession: a.agent_session.value,
    };
  };
  const close = async () => {
    await supervisor.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    store,
    agents,
    service,
    supervisor,
    p,
    lease,
    invoke,
    outcome,
    submit,
    run,
    token,
    settle,
    tick,
    complete,
    done,
    leadAgent,
    close,
  };
}
