import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHerdrAdapter } from '../src/v1/adapters/herdr.js';
import { HerdrError } from '../src/herdr-sdk.js';
import {
  NativeBoundaryError,
  classifyNativeFailure,
  type NativeEffect,
  type NativeIdentity,
  type NativeJournal,
} from '../src/v1/native.js';

type Request = { id: string; method: string; params: object };

async function fakeHerdr(socketPath: string, reply: (request: Request) => object) {
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf('\n');

      if (newline < 0) return;
      const request: Request = JSON.parse(input.slice(0, newline));
      const body = reply(request);
      socket.end(
        `${JSON.stringify('error' in body ? { id: request.id, error: body.error } : { id: request.id, result: body })}\n`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  return server;
}

function journal(): NativeJournal {
  const effects: NativeEffect[] = [];

  return {
    async prepare(effect) {
      effects.push(effect);

      return { kind: 'prepared', operationId: `op-${effects.length}` };
    },
  };
}

const endpointInspector = {
  async serverStartToken() {
    return 'server-start-1';
  },
};

function agent(status: 'idle' | 'blocked' = 'idle') {
  return {
    agent: 'codex',
    agent_session: { agent: 'codex', kind: 'id', source: 'test', value: 'native-1' },
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

test('classifier defaults ambiguous pane and semantic boundary evidence to unknown', () => {
  const pane = classifyNativeFailure({
    source: 'pane',
    status: 'blocked',
    text: 'The brief says not to guess whether the provider refused.',
    truncated: false,
    interactiveReady: true,
    launchPending: false,
  });

  assert.equal(pane.kind, 'unknown');
  assert.equal(pane.diagnostic.detail, 'The brief says not to guess whether the provider refused.');

  const boundary = classifyNativeFailure({
    source: 'boundary',
    operation: 'Herdr.agent.get',
    cause: new NativeBoundaryError({
      operation: 'Herdr.agent.get',
      cause: new HerdrError('not_ready', 'Agent state is not ready'),
    }),
  });

  assert.equal(boundary.kind, 'unknown');
  assert.equal(boundary.diagnostic.code, 'not_ready');
  assert.equal(boundary.diagnostic.detail, 'Agent state is not ready');
});

test('Herdr adapter exposes explicit trust, provider refusal, and idle-without-result evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-native-failure-'));
  const socketPath = join(root, 'herdr.sock');
  let text = 'Do you trust the contents of this project?\n> Yes, I trust this folder';
  let status: 'idle' | 'blocked' = 'idle';

  const server = await fakeHerdr(socketPath, (request) => {
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };

    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };

    if (request.method === 'agent.get') return { type: 'agent_info', agent: agent(status) };

    if (request.method === 'pane.read')
      return {
        type: 'pane_read',
        read: {
          format: 'text',
          pane_id: 'pane-1',
          revision: 9,
          source: 'recent_unwrapped',
          tab_id: 'tab-1',
          text,
          truncated: false,
          workspace_id: 'workspace-1',
        },
      };
    throw new Error(`Unexpected request ${request.method}`);
  });

  try {
    const adapter = createHerdrAdapter(journal(), { endpointInspector });

    const registered = await adapter.invoke('register', {
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });

    assert.ok(!('kind' in registered));

    if ('kind' in registered) return;

    const identity: NativeIdentity = {
      binding: registered,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'codex',
      agentName: 'worker',
      nativeSession: 'native-1',
      identityRevision: 4,
      ownedTabId: 'tab-1',
    };

    const trust = await adapter.invoke('observe', { identity });
    assert.equal(trust.kind, 'manual-required');
    assert.equal(trust.failure?.kind, 'trust-required');
    assert.equal(trust.failure?.diagnostic.detail, text);

    status = 'blocked';
    text = 'I’m sorry, but I can’t assist with that request.';
    const refusal = await adapter.invoke('observe', { identity });
    assert.equal(refusal.kind, 'blocked');
    assert.equal(refusal.failure?.kind, 'provider-refusal');
    assert.equal(refusal.failure?.diagnostic.detail, text);

    status = 'idle';
    text = 'Implementation notes are visible, but there is no durable result signal here.';
    const idle = await adapter.invoke('observe', { identity });
    assert.equal(idle.kind, 'settled');
    assert.equal(idle.failure?.kind, 'idle-without-result');
    assert.equal(idle.failure?.diagnostic.detail, text);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Herdr adapter preserves transport code, operation, and message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-native-transport-'));
  const socketPath = join(root, 'herdr.sock');

  const server = await fakeHerdr(socketPath, (request) => {
    if (request.method === 'ping')
      return { type: 'pong', protocol: 22, version: '0.9.0', capabilities: {} };

    if (request.method === 'workspace.get')
      return { type: 'workspace_info', workspace: { workspace_id: 'workspace-1' } };

    if (request.method === 'agent.get')
      return { error: { code: 'herdr_unavailable', message: 'Socket reset while reading agent' } };
    throw new Error(`Unexpected request ${request.method}`);
  });

  try {
    const adapter = createHerdrAdapter(journal(), { endpointInspector });

    const registered = await adapter.invoke('register', {
      hostId: 'host-1',
      socketPath,
      workspaceId: 'workspace-1',
    });

    assert.ok(!('kind' in registered));

    if ('kind' in registered) return;

    const identity: NativeIdentity = {
      binding: registered,
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      agentKind: 'codex',
      agentName: 'worker',
      nativeSession: 'native-1',
      identityRevision: 4,
      ownedTabId: 'tab-1',
    };

    const observation = await adapter.invoke('observe', { identity });
    assert.equal(observation.kind, 'unconfirmed');
    assert.equal(observation.failure?.kind, 'transport-failure');
    assert.equal(observation.failure?.diagnostic.code, 'herdr_unavailable');
    assert.equal(observation.failure?.diagnostic.operation, 'Herdr.agent.get');
    assert.equal(observation.failure?.diagnostic.detail, 'Socket reset while reading agent');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
