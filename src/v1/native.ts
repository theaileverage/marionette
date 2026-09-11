import { statSync } from 'node:fs';
import { HerdrClient, type ResponseTypes } from '../herdr-sdk.js';

export type NativeBinding = {
  hostId: string;
  socketPath: string;
  workspaceId: string;
  endpoint: NativeEndpointEvidence;
};

export type NativeEndpointEvidence = {
  device: number;
  inode: number;
  birthtimeMs: number;
  serverStartToken: string;
  protocol: number;
  endpointProtocolGeneration?: number;
};

export type NativeIdentity = {
  binding: NativeBinding;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentKind: string;
  agentName: string;
  nativeSession: string;
  identityRevision: number;
  ownedTabId: string;
};

export type NativeEffect =
  | { kind: 'create-tab'; workspaceId: string }
  | { kind: 'start-agent'; paneId: string; agentKind: string }
  | { kind: 'prompt'; paneId: string; textDigest: string }
  | { kind: 'interrupt'; paneId: string }
  | { kind: 'cleanup'; tabId: string };

export type PreparedEffect =
  { kind: 'prepared'; operationId: string } | { kind: 'rejected'; reason: string };

export interface NativeJournal {
  prepare(effect: NativeEffect): Promise<PreparedEffect>;
}

export interface NativeEndpointInspector {
  serverStartToken(socketPath: string): Promise<string | undefined>;
}

export type NativeSubmission =
  | { kind: 'submitted'; operationId: string }
  | { kind: 'unconfirmed'; operationId: string; reason: string }
  | { kind: 'unsupported'; reason: string };

export type NativeObservation =
  | { kind: 'ready'; identity: NativeIdentity }
  | { kind: 'working'; identity: NativeIdentity }
  | { kind: 'blocked'; identity: NativeIdentity; reason: string }
  | { kind: 'settled'; identity: NativeIdentity; slotReady: true }
  | { kind: 'unconfirmed'; reason: string };

export type LaunchRequest = {
  cwd: string;
  agentKind: string;
  agentName: string;
  args?: string[];
  timeoutMs?: number;
};

export type LaunchResult =
  | { kind: 'launched'; identity: NativeIdentity }
  | { kind: 'unconfirmed'; operationId: string; reason: string }
  | { kind: 'unsupported'; reason: string };

export type CleanupResult =
  | { kind: 'cleaned'; operationId: string }
  | { kind: 'unconfirmed'; operationId: string; reason: string }
  | { kind: 'unsupported'; reason: string };

function socketEvidence(socketPath: string) {
  const stat = statSync(socketPath);
  return { device: stat.dev, inode: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function sameSocket(a: NativeEndpointEvidence, b: ReturnType<typeof socketEvidence>) {
  return a.device === b.device && a.inode === b.inode && a.birthtimeMs === b.birthtimeMs;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function promptDigest(text: string) {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return (value >>> 0).toString(16);
}

function endpointGeneration(pong: ResponseTypes.ResponseResult) {
  if (pong.type !== 'pong') return undefined;
  return pong.capabilities?.endpoint_protocol_generation ?? undefined;
}

function agentIdentity(
  binding: NativeBinding,
  agent: ResponseTypes.AgentInfo,
  request: Pick<LaunchRequest, 'agentKind' | 'agentName'>,
  ownedTabId: string,
) {
  const nativeSession = agent.agent_session?.value;
  if (
    !nativeSession ||
    agent.workspace_id !== binding.workspaceId ||
    agent.tab_id !== ownedTabId ||
    agent.agent !== request.agentKind ||
    agent.name !== request.agentName
  )
    return undefined;
  return {
    binding,
    tabId: agent.tab_id,
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    agentKind: request.agentKind,
    agentName: request.agentName,
    nativeSession,
    identityRevision: agent.revision,
    ownedTabId,
  } satisfies NativeIdentity;
}

function sameIdentity(identity: NativeIdentity, agent: ResponseTypes.AgentInfo) {
  return (
    agent.workspace_id === identity.binding.workspaceId &&
    agent.tab_id === identity.tabId &&
    agent.pane_id === identity.paneId &&
    agent.terminal_id === identity.terminalId &&
    agent.agent === identity.agentKind &&
    agent.name === identity.agentName &&
    agent.agent_session?.value === identity.nativeSession
  );
}

/** Thin Herdr boundary. Store and runner own admission, control revisions, and result acceptance. */
export class HerdrNativeAdapter {
  constructor(
    private readonly journal: NativeJournal,
    private readonly endpointInspector: NativeEndpointInspector,
    private readonly clientFor = (socketPath: string) => new HerdrClient(socketPath),
  ) {}

  async register(input: {
    hostId: string;
    socketPath: string;
    workspaceId: string;
  }): Promise<NativeBinding | { kind: 'unsupported'; reason: string }> {
    try {
      const endpoint = socketEvidence(input.socketPath);
      const serverStartToken = await this.endpointInspector.serverStartToken(input.socketPath);
      if (!serverStartToken)
        return { kind: 'unsupported', reason: 'The Herdr server has no verifiable start token' };
      const client = this.clientFor(input.socketPath);
      const ping = await client.request('ping', {});
      if (ping.type !== 'pong') return { kind: 'unsupported', reason: 'Herdr did not return pong' };
      const workspace = await client.request('workspace.get', { workspace_id: input.workspaceId });
      if (
        workspace.type !== 'workspace_info' ||
        workspace.workspace.workspace_id !== input.workspaceId
      )
        return { kind: 'unsupported', reason: 'The registered workspace is unavailable' };
      const generation = endpointGeneration(ping);
      return {
        hostId: input.hostId,
        socketPath: input.socketPath,
        workspaceId: input.workspaceId,
        endpoint: {
          ...endpoint,
          serverStartToken,
          protocol: ping.protocol,
          ...(generation === undefined ? {} : { endpointProtocolGeneration: generation }),
        },
      };
    } catch (error) {
      return { kind: 'unsupported', reason: `Cannot register Herdr endpoint: ${errorText(error)}` };
    }
  }

  private async client(binding: NativeBinding) {
    const observed = socketEvidence(binding.socketPath);
    if (!sameSocket(binding.endpoint, observed)) throw new Error('Herdr socket identity changed');
    const serverStartToken = await this.endpointInspector.serverStartToken(binding.socketPath);
    if (!serverStartToken || serverStartToken !== binding.endpoint.serverStartToken)
      throw new Error('Herdr server start identity changed');
    const client = this.clientFor(binding.socketPath);
    const ping = await client.request('ping', {});
    if (ping.type !== 'pong' || ping.protocol !== binding.endpoint.protocol)
      throw new Error('Herdr protocol identity changed');
    // Herdr names this a protocol capability. It is registration metadata, not an instance fence.
    void endpointGeneration(ping);
    return client;
  }

  private async prepared(effect: NativeEffect) {
    const prepared = await this.journal.prepare(effect);
    if (prepared.kind === 'rejected') return prepared;
    return prepared;
  }

  async launch(binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult> {
    const create = await this.prepared({ kind: 'create-tab', workspaceId: binding.workspaceId });
    if (create.kind === 'rejected') return { kind: 'unsupported', reason: create.reason };
    let client: HerdrClient;
    try {
      client = await this.client(binding);
      const tab = await client.request('tab.create', {
        workspace_id: binding.workspaceId,
        cwd: request.cwd,
        label: request.agentName,
        focus: false,
      });
      if (
        tab.type !== 'tab_created' ||
        tab.tab.workspace_id !== binding.workspaceId ||
        tab.root_pane.workspace_id !== binding.workspaceId ||
        tab.root_pane.tab_id !== tab.tab.tab_id
      )
        return {
          kind: 'unconfirmed',
          operationId: create.operationId,
          reason: 'Herdr returned an unexpected tab',
        };
      const start = await this.prepared({
        kind: 'start-agent',
        paneId: tab.root_pane.pane_id,
        agentKind: request.agentKind,
      });
      if (start.kind === 'rejected') return { kind: 'unsupported', reason: start.reason };
      const started = await client.request('agent.start', {
        pane_id: tab.root_pane.pane_id,
        name: request.agentName,
        kind: request.agentKind,
        args: request.args ?? [],
        timeout_ms: request.timeoutMs ?? 30000,
      });
      if (started.type !== 'agent_started')
        return {
          kind: 'unconfirmed',
          operationId: start.operationId,
          reason: 'Herdr did not acknowledge agent start',
        };
      const current = await client.request('agent.get', { target: tab.root_pane.pane_id });
      if (current.type !== 'agent_info')
        return {
          kind: 'unconfirmed',
          operationId: start.operationId,
          reason: 'Herdr did not return agent identity',
        };
      const identity = agentIdentity(binding, current.agent, request, tab.tab.tab_id);
      if (!identity)
        return {
          kind: 'unconfirmed',
          operationId: start.operationId,
          reason: 'Native agent identity did not match launch',
        };
      const observation = await this.observe(identity);
      if (observation.kind === 'ready' || observation.kind === 'settled')
        return { kind: 'launched', identity };
      return {
        kind: 'unconfirmed',
        operationId: start.operationId,
        reason: `Agent is ${observation.kind}`,
      };
    } catch (error) {
      return { kind: 'unconfirmed', operationId: create.operationId, reason: errorText(error) };
    }
  }

  async observe(identity: NativeIdentity): Promise<NativeObservation> {
    try {
      const current = await (
        await this.client(identity.binding)
      ).request('agent.get', {
        target: identity.paneId,
      });
      if (current.type !== 'agent_info' || !sameIdentity(identity, current.agent))
        return { kind: 'unconfirmed', reason: 'Native agent identity changed' };
      if (current.agent.agent_status === 'working') return { kind: 'working', identity };
      if (current.agent.agent_status === 'blocked')
        return { kind: 'blocked', identity, reason: 'Native agent is blocked' };
      if (
        (current.agent.agent_status === 'idle' || current.agent.agent_status === 'done') &&
        !current.agent.launch_pending &&
        current.agent.interactive_ready !== false
      )
        return { kind: 'settled', identity, slotReady: true };
      if (current.agent.interactive_ready !== false && !current.agent.launch_pending)
        return { kind: 'ready', identity };
      return { kind: 'unconfirmed', reason: 'Native agent is still launching' };
    } catch (error) {
      return { kind: 'unconfirmed', reason: errorText(error) };
    }
  }

  async prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission> {
    const prepared = await this.prepared({
      kind: 'prompt',
      paneId: identity.paneId,
      textDigest: promptDigest(text),
    });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
    const observation = await this.observe(identity);
    if (observation.kind !== 'settled' && observation.kind !== 'ready')
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: `Agent is ${observation.kind}`,
      };
    try {
      const result = await (
        await this.client(identity.binding)
      ).request('agent.prompt', {
        target: identity.paneId,
        text,
      });
      if (result.type !== 'agent_prompted')
        return {
          kind: 'unconfirmed',
          operationId: prepared.operationId,
          reason: 'Herdr did not acknowledge prompt',
        };
      return { kind: 'submitted', operationId: prepared.operationId };
    } catch (error) {
      return { kind: 'unconfirmed', operationId: prepared.operationId, reason: errorText(error) };
    }
  }

  async interrupt(identity: NativeIdentity): Promise<NativeSubmission> {
    const prepared = await this.prepared({ kind: 'interrupt', paneId: identity.paneId });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
    const observation = await this.observe(identity);
    if (observation.kind === 'unconfirmed')
      return { kind: 'unconfirmed', operationId: prepared.operationId, reason: observation.reason };
    try {
      await (
        await this.client(identity.binding)
      ).request('agent.send_keys', {
        target: identity.paneId,
        keys: ['esc'],
      });
      return { kind: 'submitted', operationId: prepared.operationId };
    } catch (error) {
      return { kind: 'unconfirmed', operationId: prepared.operationId, reason: errorText(error) };
    }
  }

  approval(): NativeSubmission {
    return {
      kind: 'unsupported',
      reason: 'Native approvals require a supported user action adapter',
    };
  }

  async cleanup(identity: NativeIdentity, authorized: boolean): Promise<CleanupResult> {
    if (!authorized)
      return { kind: 'unsupported', reason: 'Cleanup requires explicit authorization' };
    const prepared = await this.prepared({ kind: 'cleanup', tabId: identity.ownedTabId });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
    const observation = await this.observe(identity);
    if (observation.kind !== 'settled')
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: `Agent is ${observation.kind}`,
      };
    try {
      const result = await (
        await this.client(identity.binding)
      ).request('tab.close', {
        tab_id: identity.ownedTabId,
      });
      if (result.type !== 'ok')
        return {
          kind: 'unconfirmed',
          operationId: prepared.operationId,
          reason: 'Herdr did not acknowledge tab cleanup',
        };
      return { kind: 'cleaned', operationId: prepared.operationId };
    } catch (error) {
      return { kind: 'unconfirmed', operationId: prepared.operationId, reason: errorText(error) };
    }
  }
}
