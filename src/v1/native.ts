import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
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

export const NativeBindingSchema = z
  .object({
    hostId: z.string().min(1),
    socketPath: z.string().min(1),
    workspaceId: z.string().min(1),
    endpoint: z
      .object({
        device: z.number().finite(),
        inode: z.number().finite(),
        birthtimeMs: z.number().finite(),
        serverStartToken: z.string().min(1),
        protocol: z.number().int().positive(),
        endpointProtocolGeneration: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export const NativeIdentitySchema = z
  .object({
    binding: NativeBindingSchema,
    tabId: z.string().min(1),
    paneId: z.string().min(1),
    terminalId: z.string().min(1),
    agentKind: z.string().min(1),
    agentName: z.string().min(1),
    nativeSession: z.string().min(1),
    identityRevision: z.number().int().nonnegative(),
    ownedTabId: z.string().min(1),
  })
  .strict();

export type NativeLaunchLocator = {
  binding: NativeBinding;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentKind: string;
  agentName: string;
  ownedTabId: string;
  nativeSession?: string;
  identityRevision?: number;
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

export type LocalCommandResult = { stdout: string };

export interface LocalCommandRunner {
  run(command: 'lsof' | 'ps', args: readonly string[]): Promise<LocalCommandResult | undefined>;
}

const processIdSchema = z.string().regex(/^\d+$/);
const processStartSchema = z.string().min(1);

const execFileAsync = promisify(execFile);

const localCommandRunner: LocalCommandRunner = {
  async run(command, args) {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return { stdout: result.stdout };
    } catch {
      return undefined;
    }
  },
};

/** Maps a local Unix socket to a process start instance; absence is never treated as proof. */
export class LocalEndpointInspector implements NativeEndpointInspector {
  constructor(private readonly commands: LocalCommandRunner = localCommandRunner) {}

  async serverStartToken(socketPath: string): Promise<string | undefined> {
    const owners = await this.commands.run('lsof', ['-a', '-Fpn', '-U', socketPath]);
    if (!owners) return undefined;
    const processIds = new Set<string>();
    let currentProcessId: string | undefined;
    for (const line of owners.stdout.split('\n')) {
      if (line.startsWith('p')) {
        const parsed = processIdSchema.safeParse(line.slice(1));
        currentProcessId = parsed.success ? parsed.data : undefined;
      } else if (line.startsWith('n') && line.slice(1) === socketPath && currentProcessId) {
        processIds.add(currentProcessId);
      }
    }
    if (processIds.size !== 1) return undefined;
    const [processId] = processIds;
    if (!processId) return undefined;
    const started = await this.commands.run('ps', ['-o', 'lstart=', '-p', processId]);
    if (!started) return undefined;
    const start = processStartSchema.safeParse(started.stdout.trim());
    if (!start.success) return undefined;
    return createHash('sha256').update(`${processId}\u0000${start.data}`).digest('base64url');
  }
}

export type NativeSubmission =
  | { kind: 'submitted'; operationId: string }
  | { kind: 'unconfirmed'; operationId: string; reason: string }
  | { kind: 'unsupported'; reason: string };

export type NativeObservation =
  | { kind: 'working'; identity: NativeIdentity }
  | { kind: 'blocked'; identity: NativeIdentity; reason: string }
  | { kind: 'settled'; identity: NativeIdentity; slotReady: true }
  | { kind: 'unconfirmed'; reason: string };

export type LaunchRequest = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  agentKind: string;
  agentName: string;
  args?: string[];
  timeoutMs?: number;
};

export type LaunchResult =
  | { kind: 'launched'; identity: NativeIdentity }
  | { kind: 'unconfirmed'; operationId: string; reason: string; locator?: NativeLaunchLocator }
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

function errorText(error: Error) {
  return error.message;
}

function promptDigest(text: string) {
  return createHash('sha256').update(text).digest('hex');
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

function launchLocator(
  binding: NativeBinding,
  pane: Pick<ResponseTypes.PaneInfo, 'tab_id' | 'pane_id' | 'terminal_id'>,
  request: Pick<LaunchRequest, 'agentKind' | 'agentName'>,
): NativeLaunchLocator {
  return {
    binding,
    tabId: pane.tab_id,
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    agentKind: request.agentKind,
    agentName: request.agentName,
    ownedTabId: pane.tab_id,
  };
}

function identityLocator(identity: NativeIdentity): NativeLaunchLocator {
  return {
    ...identity,
    nativeSession: identity.nativeSession,
    identityRevision: identity.identityRevision,
  };
}

type UnconfirmedLaunch = Extract<LaunchResult, { kind: 'unconfirmed' }>;

function unconfirmedLaunch(
  operationId: string,
  reason: string,
  locator?: NativeLaunchLocator,
): UnconfirmedLaunch {
  const result: UnconfirmedLaunch = { kind: 'unconfirmed', operationId, reason };
  if (locator) result.locator = locator;
  return result;
}

/** Thin Herdr boundary. Store and runner own admission, control revisions, and result acceptance. */
export class HerdrNativeAdapter {
  constructor(
    private readonly journal: NativeJournal,
    private readonly endpointInspector: NativeEndpointInspector = new LocalEndpointInspector(),
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
      const evidence: NativeEndpointEvidence = {
        ...endpoint,
        serverStartToken,
        protocol: ping.protocol,
      };
      if (generation !== undefined) evidence.endpointProtocolGeneration = generation;
      return {
        hostId: input.hostId,
        socketPath: input.socketPath,
        workspaceId: input.workspaceId,
        endpoint: evidence,
      };
    } catch (error) {
      return {
        kind: 'unsupported',
        reason: `Cannot register Herdr endpoint: ${error instanceof Error ? errorText(error) : 'unknown error'}`,
      };
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

  async launch(binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult> {
    const create = await this.journal.prepare({
      kind: 'create-tab',
      workspaceId: binding.workspaceId,
    });
    if (create.kind === 'rejected') return { kind: 'unsupported', reason: create.reason };
    let operationId = create.operationId;
    let locator: NativeLaunchLocator | undefined;
    let client: HerdrClient;
    try {
      client = await this.client(binding);
      const tab = await client.request('tab.create', {
        workspace_id: binding.workspaceId,
        cwd: request.cwd,
        env: request.env,
        label: request.agentName,
        focus: false,
      });
      if (
        tab.type !== 'tab_created' ||
        tab.tab.workspace_id !== binding.workspaceId ||
        tab.root_pane.workspace_id !== binding.workspaceId ||
        tab.root_pane.tab_id !== tab.tab.tab_id
      )
        return unconfirmedLaunch(operationId, 'Herdr returned an unexpected tab');
      locator = launchLocator(binding, tab.root_pane, request);
      const start = await this.journal.prepare({
        kind: 'start-agent',
        paneId: tab.root_pane.pane_id,
        agentKind: request.agentKind,
      });
      if (start.kind === 'rejected') return { kind: 'unsupported', reason: start.reason };
      operationId = start.operationId;
      client = await this.client(binding);
      const started = await client.request('agent.start', {
        pane_id: tab.root_pane.pane_id,
        name: request.agentName,
        kind: request.agentKind,
        args: request.args ?? [],
        timeout_ms: request.timeoutMs ?? 30000,
      });
      if (started.type !== 'agent_started')
        return unconfirmedLaunch(operationId, 'Herdr did not acknowledge agent start', locator);
      const startedIdentity = agentIdentity(binding, started.agent, request, tab.tab.tab_id);
      if (startedIdentity) locator = identityLocator(startedIdentity);
      client = await this.client(binding);
      const current = await client.request('agent.get', { target: tab.root_pane.pane_id });
      if (current.type !== 'agent_info')
        return unconfirmedLaunch(operationId, 'Herdr did not return agent identity', locator);
      const identity = agentIdentity(binding, current.agent, request, tab.tab.tab_id);
      if (!identity)
        return unconfirmedLaunch(
          operationId,
          'Native agent identity did not match launch',
          locator,
        );
      locator = identityLocator(identity);
      const observation = await this.observe(identity);
      if (observation.kind === 'settled') return { kind: 'launched', identity };
      return unconfirmedLaunch(operationId, `Agent is ${observation.kind}`, locator);
    } catch (error) {
      return unconfirmedLaunch(
        operationId,
        error instanceof Error ? errorText(error) : 'Native launch failed',
        locator,
      );
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
        current.agent.interactive_ready === true
      )
        return { kind: 'settled', identity, slotReady: true };
      return { kind: 'unconfirmed', reason: 'Native agent is not explicitly ready' };
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? errorText(error) : 'Native observation failed',
      };
    }
  }

  async prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission> {
    const prepared = await this.journal.prepare({
      kind: 'prompt',
      paneId: identity.paneId,
      textDigest: promptDigest(text),
    });
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
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: error instanceof Error ? errorText(error) : 'Native prompt failed',
      };
    }
  }

  async interrupt(identity: NativeIdentity): Promise<NativeSubmission> {
    const prepared = await this.journal.prepare({ kind: 'interrupt', paneId: identity.paneId });
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
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: error instanceof Error ? errorText(error) : 'Native interrupt failed',
      };
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
    const prepared = await this.journal.prepare({ kind: 'cleanup', tabId: identity.ownedTabId });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
    const observation = await this.observe(identity);
    if (observation.kind !== 'settled')
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: `Agent is ${observation.kind}`,
      };
    try {
      const client = await this.client(identity.binding);
      const panes = await client.request('pane.list', {
        workspace_id: identity.binding.workspaceId,
      });
      const ownedPanes =
        panes.type === 'pane_list'
          ? panes.panes.filter((pane) => pane.tab_id === identity.ownedTabId)
          : [];
      if (
        ownedPanes.length !== 1 ||
        ownedPanes[0].pane_id !== identity.paneId ||
        ownedPanes[0].terminal_id !== identity.terminalId
      )
        return {
          kind: 'unconfirmed',
          operationId: prepared.operationId,
          reason: 'Owned tab no longer contains exactly the registered pane',
        };
      const result = await client.request('tab.close', {
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
      return {
        kind: 'unconfirmed',
        operationId: prepared.operationId,
        reason: error instanceof Error ? errorText(error) : 'Native cleanup failed',
      };
    }
  }
}
