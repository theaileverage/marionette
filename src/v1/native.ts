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
  nativeSession?: string;
  foregroundProcess?: NativeForegroundProcess;
  identityRevision: number;
  ownedTabId: string;
};

export type NativeForegroundProcess = { pid: number; startToken: string };

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
    nativeSession: z.string().min(1).optional(),
    foregroundProcess: z
      .object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
      .strict()
      .optional(),
    identityRevision: z.number().int().nonnegative(),
    ownedTabId: z.string().min(1),
  })
  .strict()
  .superRefine((identity, context) => {
    if (!identity.nativeSession && !identity.foregroundProcess)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Native identity needs a native session or foreground process instance',
      });
  });

export type NativeLaunchLocator = {
  binding: NativeBinding;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentKind: string;
  agentName: string;
  ownedTabId: string;
  nativeSession?: string;
  foregroundProcess?: NativeForegroundProcess;
  identityRevision?: number;
};

export const NativeLaunchLocatorSchema = z
  .object({
    binding: NativeBindingSchema,
    tabId: z.string().min(1),
    paneId: z.string().min(1),
    terminalId: z.string().min(1),
    agentKind: z.string().min(1),
    agentName: z.string().min(1),
    ownedTabId: z.string().min(1),
    nativeSession: z.string().min(1).optional(),
    foregroundProcess: z
      .object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
      .strict()
      .optional(),
    identityRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((locator, context) => {
    if (!locator.nativeSession && !locator.foregroundProcess)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Native launch locator needs a native session or foreground process instance',
      });
  });

export const NativeAdoptionLocatorSchema = z
  .object({
    binding: NativeBindingSchema,
    tabId: z.string().min(1),
    paneId: z.string().min(1),
    terminalId: z.string().min(1),
    agentKind: z.string().min(1),
    agentName: z.string().min(1),
    ownedTabId: z.string().min(1),
    nativeSession: z.string().min(1).optional(),
    foregroundProcess: z
      .object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
      .strict()
      .optional(),
    identityRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type NativeFixtureRecoveryAuthorization = {
  kind: 'explicit-fixture-recovery';
  binding: NativeBinding;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentKind: string;
  agentName: string;
  ownedTabId: string;
};

export const NativeFixtureRecoveryAuthorizationSchema = z
  .object({
    kind: z.literal('explicit-fixture-recovery'),
    binding: NativeBindingSchema,
    tabId: z.string().min(1),
    paneId: z.string().min(1),
    terminalId: z.string().min(1),
    agentKind: z.string().min(1),
    agentName: z.string().min(1),
    ownedTabId: z.string().min(1),
  })
  .strict();

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

export interface NativeProcessInspector {
  startToken(processId: number): Promise<string | undefined>;
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

async function processStartToken(
  commands: LocalCommandRunner,
  processId: number,
): Promise<string | undefined> {
  const started = await commands.run('ps', ['-o', 'lstart=', '-p', String(processId)]);
  if (!started) return undefined;
  const start = processStartSchema.safeParse(started.stdout.trim());
  if (!start.success) return undefined;
  return createHash('sha256').update(`${processId}\u0000${start.data}`).digest('base64url');
}

export class LocalProcessInspector implements NativeProcessInspector {
  constructor(private readonly commands: LocalCommandRunner = localCommandRunner) {}

  startToken(processId: number): Promise<string | undefined> {
    return processStartToken(this.commands, processId);
  }
}

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
    return processStartToken(this.commands, Number(processId));
  }
}

export type NativeSubmission =
  | { kind: 'submitted'; operationId: string }
  | { kind: 'unconfirmed'; operationId: string; reason: string }
  | { kind: 'unsupported'; reason: string };

export type NativeObservation =
  | { kind: 'working'; identity: NativeIdentity }
  | { kind: 'blocked'; identity: NativeIdentity; reason: string }
  | { kind: 'manual-required'; identity: NativeIdentity; reason: string }
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
  foregroundProcess?: NativeForegroundProcess,
) {
  const nativeSession = agent.agent_session?.value;
  if (
    (!nativeSession && !foregroundProcess) ||
    agent.workspace_id !== binding.workspaceId ||
    agent.tab_id !== ownedTabId ||
    agent.agent !== request.agentKind ||
    agent.name !== request.agentName
  )
    return undefined;
  const identity: NativeIdentity = {
    binding,
    tabId: agent.tab_id,
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    agentKind: request.agentKind,
    agentName: request.agentName,
    identityRevision: agent.revision,
    ownedTabId,
  };
  if (nativeSession) identity.nativeSession = nativeSession;
  if (foregroundProcess) identity.foregroundProcess = foregroundProcess;
  return identity;
}

type NativeAgentTarget = Pick<
  NativeIdentity,
  'binding' | 'tabId' | 'paneId' | 'terminalId' | 'agentKind' | 'agentName'
>;

function sameAgent(identity: NativeAgentTarget, agent: ResponseTypes.AgentInfo) {
  return (
    agent.workspace_id === identity.binding.workspaceId &&
    agent.tab_id === identity.tabId &&
    agent.pane_id === identity.paneId &&
    agent.terminal_id === identity.terminalId &&
    agent.agent === identity.agentKind &&
    agent.name === identity.agentName
  );
}

function sameBinding(a: NativeBinding, b: NativeBinding) {
  return (
    a.hostId === b.hostId &&
    a.socketPath === b.socketPath &&
    a.workspaceId === b.workspaceId &&
    a.endpoint.device === b.endpoint.device &&
    a.endpoint.inode === b.endpoint.inode &&
    a.endpoint.birthtimeMs === b.endpoint.birthtimeMs &&
    a.endpoint.serverStartToken === b.endpoint.serverStartToken &&
    a.endpoint.protocol === b.endpoint.protocol
  );
}

function sameFixtureAuthorization(
  locator: NativeLaunchLocator,
  authorization: NativeFixtureRecoveryAuthorization,
) {
  return (
    sameBinding(locator.binding, authorization.binding) &&
    locator.tabId === authorization.tabId &&
    locator.paneId === authorization.paneId &&
    locator.terminalId === authorization.terminalId &&
    locator.agentKind === authorization.agentKind &&
    locator.agentName === authorization.agentName &&
    locator.ownedTabId === authorization.ownedTabId
  );
}

function manualRequirement(text: string) {
  if (
    /do you trust the contents of this project\?/i.test(text) ||
    /yes, i trust this folder/i.test(text)
  )
    return 'Native trust prompt requires an explicit user action';
  if (/approval required/i.test(text) || /awaiting (?:your )?approval/i.test(text))
    return 'Native approval prompt requires an explicit user action';
  return undefined;
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
    private readonly processInspector: NativeProcessInspector = new LocalProcessInspector(),
  ) {}

  private async foregroundProcess(client: HerdrClient, paneId: string, agentKind: string) {
    const response = await client.request('pane.process_info', { pane_id: paneId });
    if (response.type !== 'pane_process_info' || response.process_info.pane_id !== paneId)
      return undefined;
    const matches = (response.process_info.foreground_processes ?? []).filter(
      (process) => process.name === agentKind && process.argv0 === agentKind,
    );
    if (matches.length !== 1) return undefined;
    const process = matches[0];
    const startToken = await this.processInspector.startToken(process.pid);
    return startToken ? { pid: process.pid, startToken } : undefined;
  }

  private async identity(
    client: HerdrClient,
    binding: NativeBinding,
    agent: ResponseTypes.AgentInfo,
    request: Pick<LaunchRequest, 'agentKind' | 'agentName'>,
    ownedTabId: string,
  ) {
    if (agent.agent_session?.value) return agentIdentity(binding, agent, request, ownedTabId);
    const foregroundProcess = await this.foregroundProcess(
      client,
      agent.pane_id,
      request.agentKind,
    );
    return agentIdentity(binding, agent, request, ownedTabId, foregroundProcess);
  }

  private async sameIdentity(
    client: HerdrClient,
    identity: NativeIdentity,
    agent: ResponseTypes.AgentInfo,
  ) {
    if (!sameAgent(identity, agent)) return false;
    if (identity.nativeSession) return agent.agent_session?.value === identity.nativeSession;
    if (!identity.foregroundProcess) return false;
    const foregroundProcess = await this.foregroundProcess(
      client,
      identity.paneId,
      identity.agentKind,
    );
    return (
      foregroundProcess?.pid === identity.foregroundProcess.pid &&
      foregroundProcess.startToken === identity.foregroundProcess.startToken
    );
  }

  /** Reopens a persisted launch locator using read-only checks; it never creates or controls a pane. */
  async recover(binding: NativeBinding, locator: NativeLaunchLocator): Promise<NativeObservation> {
    if (!NativeLaunchLocatorSchema.safeParse(locator).success)
      return { kind: 'unconfirmed', reason: 'Persisted native launch locator is invalid' };
    if (!sameBinding(binding, locator.binding) || locator.ownedTabId !== locator.tabId)
      return { kind: 'unconfirmed', reason: 'Persisted native launch locator changed' };
    try {
      const client = await this.client(binding);
      const current = await client.request('agent.get', { target: locator.paneId });
      if (current.type !== 'agent_info' || !sameAgent(locator, current.agent))
        return { kind: 'unconfirmed', reason: 'Native agent locator no longer matches' };
      if (locator.nativeSession) {
        if (current.agent.agent_session?.value !== locator.nativeSession)
          return { kind: 'unconfirmed', reason: 'Native agent session changed' };
        const identity = agentIdentity(binding, current.agent, locator, locator.ownedTabId);
        if (!identity)
          return { kind: 'unconfirmed', reason: 'Native agent identity is unavailable' };
        return this.observe(identity);
      }
      if (!locator.foregroundProcess)
        return { kind: 'unconfirmed', reason: 'Native process identity is unavailable' };
      const foregroundProcess = await this.foregroundProcess(
        client,
        locator.paneId,
        locator.agentKind,
      );
      if (
        foregroundProcess?.pid !== locator.foregroundProcess.pid ||
        foregroundProcess.startToken !== locator.foregroundProcess.startToken
      )
        return { kind: 'unconfirmed', reason: 'Native foreground process changed' };
      const identity = agentIdentity(
        binding,
        current.agent,
        locator,
        locator.ownedTabId,
        foregroundProcess,
      );
      if (!identity) return { kind: 'unconfirmed', reason: 'Native agent identity is unavailable' };
      return this.observe(identity);
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? errorText(error) : 'Native recovery failed',
      };
    }
  }

  /**
   * Adopts a disposable fixture only when its caller has explicitly scoped the target.
   * It observes the existing pane and never creates or controls it.
   */
  async adopt(
    binding: NativeBinding,
    locator: NativeLaunchLocator,
    authorization: NativeFixtureRecoveryAuthorization,
  ): Promise<NativeObservation> {
    if (!NativeAdoptionLocatorSchema.safeParse(locator).success)
      return { kind: 'unconfirmed', reason: 'Native fixture adoption locator is invalid' };
    if (!NativeFixtureRecoveryAuthorizationSchema.safeParse(authorization).success)
      return { kind: 'unconfirmed', reason: 'Native fixture adoption authorization is invalid' };
    if (
      !sameBinding(binding, locator.binding) ||
      !sameBinding(binding, authorization.binding) ||
      locator.ownedTabId !== locator.tabId ||
      !sameFixtureAuthorization(locator, authorization)
    )
      return { kind: 'unconfirmed', reason: 'Native fixture adoption target changed' };
    try {
      const client = await this.client(binding);
      const current = await client.request('agent.get', { target: locator.paneId });
      if (current.type !== 'agent_info' || !sameAgent(locator, current.agent))
        return { kind: 'unconfirmed', reason: 'Native fixture agent locator no longer matches' };
      const identity = await this.identity(
        client,
        binding,
        current.agent,
        locator,
        locator.ownedTabId,
      );
      if (!identity)
        return { kind: 'unconfirmed', reason: 'Native fixture agent identity is unavailable' };
      return this.observe(identity);
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? errorText(error) : 'Native fixture adoption failed',
      };
    }
  }

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
      const startedIdentity = await this.identity(
        client,
        binding,
        started.agent,
        request,
        tab.tab.tab_id,
      );
      if (startedIdentity) locator = identityLocator(startedIdentity);
      client = await this.client(binding);
      const current = await client.request('agent.get', { target: tab.root_pane.pane_id });
      if (current.type !== 'agent_info')
        return unconfirmedLaunch(operationId, 'Herdr did not return agent identity', locator);
      const identity = await this.identity(client, binding, current.agent, request, tab.tab.tab_id);
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
      const client = await this.client(identity.binding);
      const current = await client.request('agent.get', {
        target: identity.paneId,
      });
      if (
        current.type !== 'agent_info' ||
        !(await this.sameIdentity(client, identity, current.agent))
      )
        return { kind: 'unconfirmed', reason: 'Native agent identity changed' };
      if (current.agent.agent_status === 'idle' || current.agent.agent_status === 'done') {
        const screen = await client.request('pane.read', {
          pane_id: identity.paneId,
          source: 'recent_unwrapped',
          format: 'text',
          lines: 120,
          strip_ansi: true,
        });
        if (
          screen.type !== 'pane_read' ||
          screen.read.pane_id !== identity.paneId ||
          screen.read.tab_id !== identity.tabId ||
          screen.read.workspace_id !== identity.binding.workspaceId
        )
          return {
            kind: 'unconfirmed',
            reason: 'Native pane read did not match the registered pane',
          };
        const required = manualRequirement(screen.read.text);
        if (required) return { kind: 'manual-required', identity, reason: required };
      }
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
    if (observation.kind === 'unconfirmed' || observation.kind === 'manual-required')
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
