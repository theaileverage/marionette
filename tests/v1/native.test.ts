import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HerdrNativeAdapter,
  LocalEndpointInspector,
  type LocalCommandRunner,
  type NativeEffect,
  type NativeJournal,
} from '../../src/v1/native.js';

type Request = { id: string; method: string; params: object };
type HerdrReply = object;
type RecordedJournal = { value: NativeJournal; effects: NativeEffect[] };

function agent(
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown' = 'idle',
  paneId = 'pane-1',
) {
  return {
    agent: 'agy',
    agent_session: { agent: 'agy', kind: 'id', source: 'test', value: 'native-1' },
    agent_status: status,
    interactive_ready: true,
    launch_pending: false,
    name: 'worker',
    pane_id: paneId,
    revision: 4,
    tab_id: 'tab-1',
    terminal_id: 'terminal-1',
    workspace_id: 'workspace-1',
  };
}

async function fakeHerdr(socketPath: string, onRequest: (request: Request) => HerdrReply) {
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

function journal(): RecordedJournal {
  const effects: NativeEffect[] = [];
  return {
    effects,
    value: {
      async prepare(effect) {
        effects.push(effect);
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

test('local endpoint inspector ties a socket owner to its process start instance', async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const commands: LocalCommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === 'lsof')
        return {
          stdout: 'p22\nf1\nn/private/tmp/other.sock\np481\nf4\nn/private/tmp/herdr.sock\n',
        };
      return { stdout: 'Wed Sep 11 10:22:33 2026\n' };
    },
  };
  const first = await new LocalEndpointInspector(commands).serverStartToken(
    '/private/tmp/herdr.sock',
  );
  assert.ok(first);
  assert.deepEqual(calls[0], {
    command: 'lsof',
    args: ['-a', '-Fpn', '-U', '/private/tmp/herdr.sock'],
  });
  assert.deepEqual(calls[1], { command: 'ps', args: ['-o', 'lstart=', '-p', '481'] });
  const restarted: LocalCommandRunner = {
    async run(command) {
      if (command === 'lsof') return { stdout: 'p481\nf4\nn/private/tmp/herdr.sock\n' };
      return { stdout: 'Wed Sep 11 10:22:34 2026\n' };
    },
  };
  assert.notEqual(
    first,
    await new LocalEndpointInspector(restarted).serverStartToken('/private/tmp/herdr.sock'),
  );
});

test('local endpoint inspector rejects a socket with more than one owner', async () => {
  const commands: LocalCommandRunner = {
    async run(command) {
      if (command === 'lsof')
        return {
          stdout: 'p481\nf4\nn/private/tmp/herdr.sock\np482\nf6\nn/private/tmp/herdr.sock\n',
        };
      throw new Error('ps must not run for ambiguous ownership');
    },
  };
  assert.equal(
    await new LocalEndpointInspector(commands).serverStartToken('/private/tmp/herdr.sock'),
    undefined,
  );
});

test('native adapter registers, launches AGY in an owned tab, prompts, settles, and cleans up', async () => {
  const root = mkdtempSync('/private/tmp/marionette-v1-native-');
  const socketPath = join(root, 'herdr.sock');
  const requests: string[] = [];
  const tabCreates: object[] = [];
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
    if (request.method === 'tab.create') {
      tabCreates.push(request.params);
      return {
        type: 'tab_created',
        tab: { tab_id: 'tab-1', workspace_id: 'workspace-1' },
        root_pane: { ...agent(), agent: null, agent_session: null, name: null },
      };
    }
    if (request.method === 'agent.start')
      return { type: 'agent_started', agent: agent(), argv: ['agy'] };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    if (request.method === 'agent.prompt')
      return { type: 'agent_prompted', agent: agent('working') };
    if (request.method === 'agent.send_keys') return { type: 'ok' };
    if (request.method === 'pane.list') return { type: 'pane_list', panes: [agent()] };
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
      env: { MARIONETTE_CONTEXT: '/private/session.json', MARIONETTE_STATE_HOME: '/private/state' },
      agentKind: 'agy',
      agentName: 'worker',
    });
    assert.equal(launched.kind, 'launched');
    if (launched.kind !== 'launched') return;
    assert.equal(launched.identity.agentKind, 'agy');
    assert.equal((await adapter.prompt(launched.identity, 'inspect only')).kind, 'submitted');
    assert.equal((await adapter.interrupt(launched.identity)).kind, 'submitted');
    assert.equal((await adapter.cleanup(launched.identity, true)).kind, 'cleaned');
    assert.deepEqual(
      recorded.effects.map((effect) => effect.kind),
      ['create-tab', 'start-agent', 'prompt', 'interrupt', 'cleanup'],
    );
    const prompt = recorded.effects.find((effect) => effect.kind === 'prompt');
    assert.equal(prompt?.textDigest, createHash('sha256').update('inspect only').digest('hex'));
    assert.deepEqual(tabCreates, [
      {
        workspace_id: 'workspace-1',
        cwd: '/work/project',
        env: {
          MARIONETTE_CONTEXT: '/private/session.json',
          MARIONETTE_STATE_HOME: '/private/state',
        },
        label: 'worker',
        focus: false,
      },
    ]);
    assert.ok(requests.includes('tab.create'));
    assert.ok(requests.includes('agent.start'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native cleanup does not close a tab after another pane joins it', async () => {
  const root = mkdtempSync('/private/tmp/marionette-v1-native-');
  const socketPath = join(root, 'herdr.sock');
  let tabCloseCalls = 0;
  let siblingAdded = false;
  const server = await fakeHerdr(socketPath, (request) => {
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };
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
    if (request.method === 'pane.list')
      return {
        type: 'pane_list',
        panes: siblingAdded ? [agent(), agent('idle', 'pane-2')] : [agent()],
      };
    if (request.method === 'tab.close') {
      tabCloseCalls += 1;
      return { type: 'ok' };
    }
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
    const launch = await adapter.launch(binding, {
      cwd: '/work/project',
      env: { MARIONETTE_CONTEXT: '/private/session.json', MARIONETTE_STATE_HOME: '/private/state' },
      agentKind: 'agy',
      agentName: 'worker',
    });
    assert.equal(launch.kind, 'launched');
    if (launch.kind !== 'launched') return;
    siblingAdded = true;
    assert.equal((await adapter.cleanup(launch.identity, true)).kind, 'unconfirmed');
    assert.equal(tabCloseCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native launch retains a known locator when the started agent is not explicitly ready', async () => {
  const root = mkdtempSync('/private/tmp/marionette-v1-native-');
  const socketPath = join(root, 'herdr.sock');
  const server = await fakeHerdr(socketPath, (request) => {
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'tab.create')
      return {
        type: 'tab_created',
        tab: { tab_id: 'tab-1', workspace_id: 'workspace-1' },
        root_pane: { ...agent(), agent: null, agent_session: null, name: null },
      };
    if (request.method === 'agent.start')
      return { type: 'agent_started', agent: agent('unknown'), argv: ['agy'] };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent('unknown') };
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
    const launch = await adapter.launch(binding, {
      cwd: '/work/project',
      env: { MARIONETTE_CONTEXT: '/private/session.json', MARIONETTE_STATE_HOME: '/private/state' },
      agentKind: 'agy',
      agentName: 'worker',
    });
    assert.equal(launch.kind, 'unconfirmed');
    if (launch.kind !== 'unconfirmed') return;
    assert.equal(launch.operationId, 'op-2');
    assert.equal(launch.locator?.nativeSession, 'native-1');
    assert.equal(launch.locator?.paneId, 'pane-1');
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
