import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrNativeAdapter, type NativeJournal } from '../../src/v1/native.js';

type Request = { id: string; method: string; params: Record<string, unknown> };

function agent(status: 'idle' | 'working' | 'blocked' | 'done' = 'idle') {
  return {
    agent: 'agy',
    agent_session: { agent: 'agy', kind: 'id', source: 'test', value: 'native-1' },
    agent_status: status,
    interactive_ready: true,
    launch_pending: false,
    name: 'worker',
    pane_id: 'pane-1',
    revision: 4,
    tab_id: 'tab-1',
    terminal_id: 'terminal-1',
    workspace_id: 'workspace-1',
  };
}

async function fakeHerdr(socketPath: string, onRequest: (request: Request) => unknown) {
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request: Request = JSON.parse(input.slice(0, newline));
      socket.end(JSON.stringify({ id: request.id, result: onRequest(request) }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function journal(): { value: NativeJournal; effects: string[] } {
  const effects: string[] = [];
  return {
    effects,
    value: {
      async prepare(effect) {
        effects.push(effect.kind);
        return { kind: 'prepared', operationId: `op-${effects.length}` };
      },
    },
  };
}

const endpointInspector = {
  async serverStartToken() {
    return 'server-start-1';
  },
};

test('native adapter registers, launches AGY in an owned tab, prompts, settles, and cleans up', async () => {
  const root = mkdtempSync('/private/tmp/marionette-v1-native-');
  const socketPath = join(root, 'herdr.sock');
  const requests: string[] = [];
  const server = await fakeHerdr(socketPath, (request) => {
    requests.push(request.method);
    if (request.method === 'ping')
      return {
        type: 'pong',
        protocol: 22,
        version: '0.9.0',
        capabilities: { endpoint_protocol_generation: 7, live_handoff: true },
      };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'tab.create')
      return {
        type: 'tab_created',
        tab: { tab_id: 'tab-1', workspace_id: 'workspace-1' },
        root_pane: { ...agent(), agent: null, agent_session: null, name: null },
      };
    if (request.method === 'agent.start')
      return { type: 'agent_started', agent: agent(), argv: ['agy'] };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    if (request.method === 'agent.prompt')
      return { type: 'agent_prompted', agent: agent('working') };
    if (request.method === 'agent.send_keys') return { type: 'ok' };
    if (request.method === 'tab.close') return { type: 'ok' };
    throw new Error(`unexpected ${request.method}`);
  });
  try {
    const recorded = journal();
    const adapter = new HerdrNativeAdapter(recorded.value, endpointInspector);
    const binding = await adapter.register({
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });
    assert.ok(!('kind' in binding));
    if ('kind' in binding) return;
    const launched = await adapter.launch(binding, {
      cwd: '/work/project',
      agentKind: 'agy',
      agentName: 'worker',
    });
    assert.equal(launched.kind, 'launched');
    if (launched.kind !== 'launched') return;
    assert.equal(launched.identity.agentKind, 'agy');
    assert.equal((await adapter.prompt(launched.identity, 'inspect only')).kind, 'submitted');
    assert.equal((await adapter.interrupt(launched.identity)).kind, 'submitted');
    assert.equal((await adapter.cleanup(launched.identity, true)).kind, 'cleaned');
    assert.deepEqual(recorded.effects, [
      'create-tab',
      'start-agent',
      'prompt',
      'interrupt',
      'cleanup',
    ]);
    assert.ok(requests.includes('tab.create'));
    assert.ok(requests.includes('agent.start'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native adapter does not prompt when socket identity changes after registration', async () => {
  const root = mkdtempSync('/private/tmp/marionette-v1-native-');
  const socketPath = join(root, 'herdr.sock');
  const methods: string[] = [];
  const server = await fakeHerdr(socketPath, (request) => {
    methods.push(request.method);
    if (request.method === 'ping')
      return {
        type: 'pong',
        protocol: 22,
        version: '0.9.0',
        capabilities: { endpoint_protocol_generation: 7, live_handoff: true },
      };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    throw new Error(`unexpected ${request.method}`);
  });
  try {
    const adapter = new HerdrNativeAdapter(journal().value, endpointInspector);
    const binding = await adapter.register({
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });
    assert.ok(!('kind' in binding));
    if ('kind' in binding) return;
    const changedBinding = {
      ...binding,
      endpoint: { ...binding.endpoint, inode: binding.endpoint.inode + 1 },
    };
    const identity = {
      binding: changedBinding,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'agy',
      agentName: 'worker',
      nativeSession: 'native-1',
      identityRevision: 4,
      ownedTabId: 'tab-1',
    };
    const result = await adapter.prompt(identity, 'must not send');
    assert.equal(result.kind, 'unconfirmed');
    assert.equal(methods.includes('agent.prompt'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
