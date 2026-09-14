import { createHerdrAdapter } from '../../src/v1/adapters/herdr.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HerdrNativeAdapter,
  LocalEndpointInspector,
  type LocalCommandRunner,
  type NativeEffect,
  type NativeFixtureRecoveryAuthorization,
  type NativeIdentity,
  type NativeJournal,
  type NativeLaunchLocator,
} from '../../src/v1/native.js';
import { herdrSessionPointer } from '../../src/v1/native-session.js';

type Request = { id: string; method: string; params: object };
type HerdrReply = object;
type RecordedJournal = { value: NativeJournal; effects: NativeEffect[] };

function agent(
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown' = 'idle',
  paneId = 'pane-1',
) {
  return {
    agent: 'agy',
    agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'native-1' },
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

function agentWithoutSession(status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown' = 'idle') {
  return { ...agent(status), agent_session: null };
}

async function fakeHerdr(socketPath: string, onRequest: (request: Request) => HerdrReply) {
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request: Request = JSON.parse(input.slice(0, newline));
      const reply = onRequest(request);
      socket.end(
        JSON.stringify(
          'error' in reply
            ? { id: request.id, error: reply.error }
            : { id: request.id, result: reply },
        ) + '\n',
      );
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

test('Herdr references require the official source and harness pairing', () => {
  assert.deepEqual(
    herdrSessionPointer({
      source: 'herdr:pi',
      agent: 'pi',
      kind: 'path',
      value: '/private/tmp/pi-session.jsonl',
    }),
    { harness: 'pi', kind: 'path', value: '/private/tmp/pi-session.jsonl', source: 'herdr:pi' },
  );
  assert.equal(
    herdrSessionPointer({ source: 'herdr:pi', agent: 'agy', kind: 'id', value: 'unrelated' }),
    undefined,
  );
});

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
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
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
    if (request.method === 'agent.start') {
      if (requests.filter((method) => method === 'agent.start').length === 1)
        return {
          error: {
            code: 'not_ready',
            message: 'agent target pane pane-1 is not an available shell',
          },
        };
      return { type: 'agent_started', agent: agent(), argv: ['agy'] };
    }
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'workspace-1', text: '' },
      };
    if (request.method === 'agent.prompt')
      return { type: 'agent_prompted', agent: agent('working') };
    if (request.method === 'agent.send_keys') return { type: 'ok' };
    if (request.method === 'pane.list') return { type: 'pane_list', panes: [agent()] };
    if (request.method === 'tab.close') return { type: 'ok' };
    throw new Error(`unexpected ${request.method}`);
  });
  try {
    const recorded = journal();
    const adapter = createHerdrAdapter(recorded.value, { endpointInspector });
    const binding = await adapter.invoke('register', {
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });
    assert.ok(!('kind' in binding));
    if ('kind' in binding) return;
    const launched = await adapter.invoke('launch', {
      binding,
      request: {
        cwd: '/work/project',
        env: {
          MARIONETTE_CONTEXT: '/private/session.json',
          MARIONETTE_STATE_HOME: '/private/state',
        },
        agentKind: 'agy',
        agentName: 'worker',
      },
    });
    assert.equal(launched.kind, 'launched');
    if (launched.kind !== 'launched') return;
    assert.equal(launched.identity.agentKind, 'agy');
    assert.equal(
      (await adapter.invoke('prompt', { identity: launched.identity, text: 'inspect only' })).kind,
      'submitted',
    );
    assert.equal(
      (await adapter.invoke('interrupt', { identity: launched.identity })).kind,
      'submitted',
    );
    assert.equal(
      (await adapter.invoke('cleanup', { identity: launched.identity, authorized: true })).kind,
      'cleaned',
    );
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
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
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
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'workspace-1', text: '' },
      };
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

test('native trust screen is manual-required and never receives a prompt or key press', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
  const socketPath = join(root, 'herdr.sock');
  const methods: string[] = [];
  const server = await fakeHerdr(socketPath, (request) => {
    methods.push(request.method);
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: {
          pane_id: 'pane-1',
          tab_id: 'tab-1',
          workspace_id: 'workspace-1',
          text: 'Do you trust the contents of this project?\n> Yes, I trust this folder',
        },
      };
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
    const identity: NativeIdentity = {
      binding,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'agy',
      agentName: 'worker',
      nativeSession: 'native-1',
      identityRevision: 4,
      ownedTabId: 'tab-1',
    };
    const observation = await adapter.observe(identity);
    assert.equal(observation.kind, 'manual-required');
    const prompt = await adapter.prompt(identity, 'must not reach the trust dialog');
    assert.equal(prompt.kind, 'unconfirmed');
    const interrupt = await adapter.interrupt(identity);
    assert.equal(interrupt.kind, 'unconfirmed');
    assert.equal(methods.includes('agent.prompt'), false);
    assert.equal(methods.includes('agent.send_keys'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native adapter uses a foreground process start identity when AGY has no native session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
  const socketPath = join(root, 'herdr.sock');
  const methods: string[] = [];
  let startToken = 'process-start-1';
  const server = await fakeHerdr(socketPath, (request) => {
    methods.push(request.method);
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
      return { type: 'agent_started', agent: agentWithoutSession(), argv: ['agy'] };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agentWithoutSession() };
    if (request.method === 'pane.process_info')
      return {
        type: 'pane_process_info',
        process_info: {
          pane_id: 'pane-1',
          foreground_processes: [{ name: 'agy', argv0: 'agy', pid: 19937 }],
        },
      };
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'workspace-1', text: '' },
      };
    if (request.method === 'agent.prompt')
      return { type: 'agent_prompted', agent: agentWithoutSession('working') };
    throw new Error(`unexpected ${request.method}`);
  });
  try {
    const processInspector = {
      async startToken(processId: number) {
        assert.equal(processId, 19937);
        return startToken;
      },
    };
    const adapter = new HerdrNativeAdapter(
      journal().value,
      endpointInspector,
      undefined,
      processInspector,
    );
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
    assert.deepEqual(launch.identity.foregroundProcess, {
      pid: 19937,
      startToken: 'process-start-1',
    });
    assert.equal(launch.identity.nativeSession, undefined);
    startToken = 'process-start-2';
    assert.equal(
      (await adapter.prompt(launch.identity, 'must not reach a reused process')).kind,
      'unconfirmed',
    );
    assert.equal(methods.includes('agent.prompt'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native recovery reopens only an unchanged session locator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
  const socketPath = join(root, 'herdr.sock');
  const methods: string[] = [];
  const server = await fakeHerdr(socketPath, (request) => {
    methods.push(request.method);
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent() };
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'workspace-1', text: '' },
      };
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
    const locator: NativeLaunchLocator = {
      binding,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'agy',
      agentName: 'worker',
      ownedTabId: 'tab-1',
      nativeSession: 'native-1',
      identityRevision: 4,
    };
    assert.equal((await adapter.recover(binding, locator)).kind, 'settled');
    assert.equal(
      (await adapter.recover(binding, { ...locator, nativeSession: 'native-session-changed' }))
        .kind,
      'unconfirmed',
    );
    assert.deepEqual(
      await adapter.observe({
        ...locator,
        nativeSession: undefined,
        sessionReference: {
          harness: 'agy',
          kind: 'id',
          value: 'prior-native-session',
          source: 'herdr:antigravity_cli',
        },
        identityRevision: 4,
      }),
      {
        kind: 'unconfirmed',
        reason: 'Native conversation reference changed without stable process evidence',
        failure: {
          kind: 'unknown',
          diagnostic: {
            source: 'adapter',
            detail: 'Native conversation reference changed without stable process evidence',
          },
        },
        candidate: {
          reference: { harness: 'agy', kind: 'id', value: 'native-1', source: 'herdr:antigravity_cli' },
          identityRevision: 4,
        },
      },
    );
    assert.equal(methods.includes('tab.create'), false);
    assert.equal(methods.includes('agent.start'), false);
    assert.equal(methods.includes('agent.prompt'), false);
    assert.equal(methods.includes('agent.send_keys'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native fixture adoption pins an observed AGY process after exact caller authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
  const socketPath = join(root, 'herdr.sock');
  const methods: string[] = [];
  const server = await fakeHerdr(socketPath, (request) => {
    methods.push(request.method);
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };
    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };
    if (request.method === 'agent.get') return { type: 'agent_info', agent: agentWithoutSession() };
    if (request.method === 'pane.process_info')
      return {
        type: 'pane_process_info',
        process_info: {
          pane_id: 'pane-1',
          foreground_processes: [{ name: 'agy', argv0: 'agy', pid: 19937 }],
        },
      };
    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'workspace-1', text: '' },
      };
    throw new Error(`unexpected ${request.method}`);
  });
  try {
    const processInspector = {
      async startToken() {
        return 'process-start-1';
      },
    };
    const adapter = new HerdrNativeAdapter(
      journal().value,
      endpointInspector,
      undefined,
      processInspector,
    );
    const binding = await adapter.register({
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });
    assert.ok(!('kind' in binding));
    if ('kind' in binding) return;
    const locator: NativeLaunchLocator = {
      binding,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'agy',
      agentName: 'worker',
      ownedTabId: 'tab-1',
    };
    const authorization: NativeFixtureRecoveryAuthorization = {
      kind: 'explicit-fixture-recovery',
      ...locator,
    };
    const adopted = await adapter.adopt(binding, locator, authorization);
    assert.equal(adopted.kind, 'settled');
    if (adopted.kind === 'settled')
      assert.deepEqual(adopted.identity.foregroundProcess, {
        pid: 19937,
        startToken: 'process-start-1',
      });
    const requestsBeforeMismatch = methods.length;
    assert.equal(
      (await adapter.adopt(binding, locator, { ...authorization, paneId: 'pane-2' })).kind,
      'unconfirmed',
    );
    assert.equal(methods.length, requestsBeforeMismatch);
    assert.equal(methods.includes('tab.create'), false);
    assert.equal(methods.includes('agent.start'), false);
    assert.equal(methods.includes('agent.prompt'), false);
    assert.equal(methods.includes('agent.send_keys'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native launch retains a known locator when the started agent is not explicitly ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
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
    assert.equal(launch.locator?.sessionReference?.value, 'native-1');
    assert.equal(launch.locator?.paneId, 'pane-1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('native adapter does not prompt when socket identity changes after registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-native-'));
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
