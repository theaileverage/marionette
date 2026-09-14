import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import { Effect, Schema } from 'effect';
import { HerdrClient, HerdrError, type ResponseTypes } from '../herdr-sdk.js';
import {
  NativeSessionPointerSchema,
  herdrSessionPointer,
  type NativeSessionPointer,
} from './native-session.js';

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
  sessionReference?: NativeSessionPointer;
  /** Present only when decoding pre-v7 persisted identity bytes. */
  nativeSession?: string;
  foregroundProcess?: NativeForegroundProcess;
  identityRevision: number;
  ownedTabId: string;
};

export type NativeForegroundProcess = { pid: number; startToken: string };

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const finite = Schema.Finite;
const positiveInteger = Schema.Finite.check(Schema.makeFilter((value) => Number.isInteger(value) && value > 0, { expected: 'a positive integer' }));
const nonNegativeInteger = Schema.Finite.check(Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, { expected: 'a non-negative integer' }));
const foregroundProcessSchema = Schema.Struct({ pid: positiveInteger, startToken: nonEmpty });

export const NativeBindingSchema = Schema.Struct({
  hostId: nonEmpty,
  socketPath: nonEmpty,
  workspaceId: nonEmpty,
  endpoint: Schema.Struct({
    device: finite,
    inode: finite,
    birthtimeMs: finite,
    serverStartToken: nonEmpty,
    protocol: positiveInteger,
    endpointProtocolGeneration: Schema.optional(nonNegativeInteger),
  }),
});

export const NativeIdentitySchema = Schema.Struct({
  binding: NativeBindingSchema,
  tabId: nonEmpty,
  paneId: nonEmpty,
  terminalId: nonEmpty,
  agentKind: nonEmpty,
  agentName: nonEmpty,
  sessionReference: Schema.optional(NativeSessionPointerSchema),
  nativeSession: Schema.optional(nonEmpty),
  foregroundProcess: Schema.optional(foregroundProcessSchema),
  identityRevision: nonNegativeInteger,
  ownedTabId: nonEmpty,
}).check(Schema.makeFilter((identity) => Boolean(identity.sessionReference || identity.nativeSession || identity.foregroundProcess), { expected: 'a native session or foreground process instance' }));

export type NativeLaunchLocator = {
  binding: NativeBinding;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentKind: string;
  agentName: string;
  ownedTabId: string;
  sessionReference?: NativeSessionPointer;
  /** Present only in pre-v7 persisted launch locators. */
  nativeSession?: string;
  foregroundProcess?: NativeForegroundProcess;
  identityRevision?: number;
};

const locatorFields = {
  binding: NativeBindingSchema,
  tabId: nonEmpty,
  paneId: nonEmpty,
  terminalId: nonEmpty,
  agentKind: nonEmpty,
  agentName: nonEmpty,
  ownedTabId: nonEmpty,
  sessionReference: Schema.optional(NativeSessionPointerSchema),
  nativeSession: Schema.optional(nonEmpty),
  foregroundProcess: Schema.optional(foregroundProcessSchema),
  identityRevision: Schema.optional(nonNegativeInteger),
};
export const NativeLaunchLocatorSchema = Schema.Struct(locatorFields).check(
  Schema.makeFilter((locator) => Boolean(locator.sessionReference || locator.nativeSession || locator.foregroundProcess), { expected: 'a native session or foreground process instance' }),
);
export const NativeAdoptionLocatorSchema = Schema.Struct(locatorFields);

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

export const NativeFixtureRecoveryAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('explicit-fixture-recovery'), binding: NativeBindingSchema,
  tabId: nonEmpty, paneId: nonEmpty, terminalId: nonEmpty, agentKind: nonEmpty,
  agentName: nonEmpty, ownedTabId: nonEmpty,
});

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
  prepareEffect?(effect: NativeEffect): Effect.Effect<PreparedEffect, Error, never>;
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

export class NativeBoundaryError extends Schema.TaggedError<NativeBoundaryError>()('NativeBoundaryError', {
  operation: nonEmpty,
  cause: Schema.Defect(),
}) {}

const nativeFailureDiagnosticSchema = Schema.Struct({
  source: Schema.Literals(['pane', 'status', 'transport', 'adapter']),
  detail: Schema.String,
  operation: Schema.optional(nonEmpty),
  code: Schema.optional(nonEmpty),
  truncated: Schema.optional(Schema.Boolean),
});

export const NativeFailureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('trust-required'), diagnostic: nativeFailureDiagnosticSchema }),
  Schema.Struct({ kind: Schema.Literal('provider-refusal'), diagnostic: nativeFailureDiagnosticSchema }),
  Schema.Struct({ kind: Schema.Literal('idle-without-result'), diagnostic: nativeFailureDiagnosticSchema }),
  Schema.Struct({ kind: Schema.Literal('transport-failure'), diagnostic: nativeFailureDiagnosticSchema }),
  Schema.Struct({ kind: Schema.Literal('unknown'), diagnostic: nativeFailureDiagnosticSchema }),
]);
export type NativeFailure = typeof NativeFailureSchema.Type;

export type NativeFailureEvidence =
  | { source: 'pane'; status: ResponseTypes.AgentStatus; text: string; truncated: boolean; interactiveReady?: boolean; launchPending?: boolean }
  | { source: 'boundary'; operation: string; cause: unknown }
  | { source: 'adapter'; detail: string };

const processIdSchema = Schema.String.check(Schema.isPattern(/^\d+$/));
const processStartSchema = nonEmpty;

const execFileAsync = promisify(execFile);

function decodeOptional<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] | undefined {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);
  } catch {
    return undefined;
  }
}

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
  const start = decodeOptional(processStartSchema, started.stdout.trim());
  if (start === undefined) return undefined;
  return createHash('sha256').update(`${processId}\u0000${start}`).digest('base64url');
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
        currentProcessId = decodeOptional(processIdSchema, line.slice(1));
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
  | { kind: 'blocked'; identity: NativeIdentity; reason: string; failure?: NativeFailure }
  | { kind: 'manual-required'; identity: NativeIdentity; reason: string; failure?: NativeFailure }
  | { kind: 'settled'; identity: NativeIdentity; slotReady: true; failure?: NativeFailure }
  | {
      kind: 'unconfirmed';
      reason: string;
      failure?: NativeFailure;
      candidate?: { reference: NativeSessionPointer; identityRevision: number };
    };

type RefreshedIdentity =
  | { kind: 'confirmed'; identity: NativeIdentity }
  | Extract<NativeObservation, { kind: 'unconfirmed' }>;

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

function boundaryReason(error: unknown, fallback: string) {
  if (error instanceof NativeBoundaryError && error.cause instanceof Error && error.cause.message) return error.cause.message;
  return error instanceof Error && error.message ? error.message : fallback;
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
  const sessionReference = agent.agent_session ? herdrSessionPointer(agent.agent_session) : undefined;
  if (
    (!sessionReference && !foregroundProcess) ||
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
  if (sessionReference) identity.sessionReference = sessionReference;
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

function explicitProviderRefusal(text: string) {
  return /^(?:(?:i(?:['’]m| am) sorry)[,.:;]?\s*(?:but\s+)?)?i (?:can(?:not|['’]t)|won['’]t|am unable to) (?:assist|help|comply|continue|proceed|fulfill)\b/im.test(text) ||
    /^provider (?:refused|rejected|declined) (?:the )?(?:request|prompt|task)\b/im.test(text);
}

function boundaryDiagnostic(evidence: Extract<NativeFailureEvidence, { source: 'boundary' }>) {
  const cause = evidence.cause instanceof NativeBoundaryError ? evidence.cause.cause : evidence.cause;
  const operation = evidence.cause instanceof NativeBoundaryError ? evidence.cause.operation : evidence.operation;
  const detail = cause instanceof Error && cause.message ? cause.message : boundaryReason(evidence.cause, 'Native boundary failed');
  const code = cause instanceof HerdrError && cause.code ? cause.code : undefined;
  const diagnostic: { source: 'transport' | 'adapter'; detail: string; operation: string; code?: string } = {
    source: code?.startsWith('herdr_') ? 'transport' : 'adapter', detail, operation,
  };
  if (code) diagnostic.code = code;
  return diagnostic;
}

/** Classifies only explicit Herdr evidence; ambiguous strings deliberately remain unknown. */
export function classifyNativeFailure(evidence: NativeFailureEvidence): NativeFailure {
  if (evidence.source === 'pane') {
    const diagnostic = { source: 'pane' as const, detail: evidence.text, truncated: evidence.truncated };
    if (manualRequirement(evidence.text)?.startsWith('Native trust prompt')) return { kind: 'trust-required', diagnostic };
    if (explicitProviderRefusal(evidence.text)) return { kind: 'provider-refusal', diagnostic };
    if ((evidence.status === 'idle' || evidence.status === 'done') && evidence.launchPending === false && evidence.interactiveReady === true)
      return { kind: 'idle-without-result', diagnostic };
    return { kind: 'unknown', diagnostic };
  }
  if (evidence.source === 'boundary') {
    const diagnostic = boundaryDiagnostic(evidence);
    if (diagnostic.code && ['provider_refusal', 'provider_refused', 'provider_rejected'].includes(diagnostic.code))
      return { kind: 'provider-refusal', diagnostic };
    return { kind: diagnostic.source === 'transport' ? 'transport-failure' : 'unknown', diagnostic };
  }
  return { kind: 'unknown', diagnostic: { source: 'adapter', detail: evidence.detail } };
}

function unconfirmedObservation(
  reason: string,
  evidence: NativeFailureEvidence = { source: 'adapter', detail: reason },
  candidate?: { reference: NativeSessionPointer; identityRevision: number },
): Extract<NativeObservation, { kind: 'unconfirmed' }> {
  return candidate
    ? { kind: 'unconfirmed', reason, failure: classifyNativeFailure(evidence), candidate }
    : { kind: 'unconfirmed', reason, failure: classifyNativeFailure(evidence) };
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
    sessionReference: identity.sessionReference,
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

  private boundary<A>(operation: string, evaluate: () => Promise<A>): Effect.Effect<A, NativeBoundaryError, never> {
    return Effect.tryPromise({ try: evaluate, catch: (cause) => new NativeBoundaryError({ operation, cause }) });
  }

  private prepareClaim(effect: NativeEffect): Effect.Effect<PreparedEffect, NativeBoundaryError | Error, never> {
    return this.journal.prepareEffect?.(effect) ?? this.boundary('NativeJournal.prepare', () => this.journal.prepare(effect));
  }

  private readonly foregroundProcessEffect = Effect.fn('HerdrNativeAdapter.foregroundProcess')(function* (this: HerdrNativeAdapter, client: HerdrClient, paneId: string, agentKind: string) {
    const response = yield* this.boundary('Herdr.pane.process_info', () => client.request('pane.process_info', { pane_id: paneId }));
    if (response.type !== 'pane_process_info' || response.process_info.pane_id !== paneId) return undefined;
    const matches = (response.process_info.foreground_processes ?? []).filter((process) => process.name === agentKind && process.argv0 === agentKind);
    if (matches.length !== 1) return undefined;
    const process = matches[0];
    const startToken = yield* this.boundary('NativeProcessInspector.startToken', () => this.processInspector.startToken(process.pid));
    return startToken ? { pid: process.pid, startToken } : undefined;
  }.bind(this));

  private readonly identityEffect = Effect.fn('HerdrNativeAdapter.identity')(function* (this: HerdrNativeAdapter, client: HerdrClient, binding: NativeBinding, agent: ResponseTypes.AgentInfo, request: Pick<LaunchRequest, 'agentKind' | 'agentName'>, ownedTabId: string) {
    const hasVerifiedReference = agent.agent_session ? herdrSessionPointer(agent.agent_session) !== undefined : false;
    const foregroundProcess = hasVerifiedReference
      ? undefined
      : yield* this.foregroundProcessEffect(client, agent.pane_id, request.agentKind);
    return agentIdentity(binding, agent, request, ownedTabId, foregroundProcess);
  }.bind(this));

  /**
   * Refreshes an identity's confirmation against a current Herdr observation. A
   * process-only identity may gain a conversation reference only while the same
   * foreground process instance is still verified; otherwise a changed reference
   * is retained as an unconfirmed candidate rather than silently rebinding.
   */
  private readonly refreshedIdentityEffect = Effect.fn('HerdrNativeAdapter.refreshedIdentity')(function* (this: HerdrNativeAdapter, client: HerdrClient, identity: NativeIdentity, agent: ResponseTypes.AgentInfo): Effect.fn.Return<RefreshedIdentity, NativeBoundaryError> {
    if (!sameAgent(identity, agent)) return unconfirmedObservation('Native agent locator no longer matches');
    if (agent.revision < identity.identityRevision)
      return unconfirmedObservation('Native agent identity revision moved backwards');
    const candidate = agent.agent_session ? herdrSessionPointer(agent.agent_session) : undefined;
    let foregroundProcess: NativeForegroundProcess | undefined;
    if (identity.foregroundProcess) {
      foregroundProcess = yield* this.foregroundProcessEffect(client, identity.paneId, identity.agentKind);
      if (foregroundProcess?.pid !== identity.foregroundProcess.pid || foregroundProcess.startToken !== identity.foregroundProcess.startToken)
        return unconfirmedObservation('Native foreground process changed');
    }
    if (identity.sessionReference && !foregroundProcess) {
      const prior = identity.sessionReference;
      if (!candidate || candidate.kind !== prior.kind || candidate.value !== prior.value || candidate.source !== prior.source || candidate.harness !== prior.harness) {
        const reason = 'Native conversation reference changed without stable process evidence';
        return unconfirmedObservation(
          reason,
          { source: 'adapter', detail: reason },
          candidate ? { reference: candidate, identityRevision: agent.revision } : undefined,
        );
      }
    }
    if (identity.nativeSession && !identity.sessionReference && !foregroundProcess) {
      if (agent.agent_session?.value !== identity.nativeSession)
        return unconfirmedObservation('Legacy native session value changed');
      return { kind: 'confirmed', identity: { ...identity, identityRevision: agent.revision } };
    }
    const refreshed = agentIdentity(identity.binding, agent, identity, identity.ownedTabId, foregroundProcess);
    return refreshed
      ? { kind: 'confirmed', identity: refreshed }
      : unconfirmedObservation('Native agent identity is unavailable');
  }.bind(this));

  private readonly clientEffect = Effect.fn('HerdrNativeAdapter.client')(function* (this: HerdrNativeAdapter, binding: NativeBinding) {
    const observed = yield* Effect.try({ try: () => socketEvidence(binding.socketPath), catch: (cause) => new NativeBoundaryError({ operation: 'Herdr.socket.stat', cause }) });
    if (!sameSocket(binding.endpoint, observed)) return yield* new NativeBoundaryError({ operation: 'Herdr.socket.verify', cause: new Error('Herdr socket identity changed') });
    const serverStartToken = yield* this.boundary('NativeEndpointInspector.serverStartToken', () => this.endpointInspector.serverStartToken(binding.socketPath));
    if (!serverStartToken || serverStartToken !== binding.endpoint.serverStartToken) return yield* new NativeBoundaryError({ operation: 'Herdr.server.verify', cause: new Error('Herdr server start identity changed') });
    const client = this.clientFor(binding.socketPath);
    const ping = yield* this.boundary('Herdr.ping', () => client.request('ping', {}));
    if (ping.type !== 'pong' || ping.protocol !== binding.endpoint.protocol) return yield* new NativeBoundaryError({ operation: 'Herdr.protocol.verify', cause: new Error('Herdr protocol identity changed') });
    void endpointGeneration(ping);
    return client;
  }.bind(this));

  readonly launchEffect = Effect.fn('HerdrNativeAdapter.launch')(function* (this: HerdrNativeAdapter, binding: NativeBinding, request: LaunchRequest) {
    const create = yield* this.prepareClaim({ kind: 'create-tab', workspaceId: binding.workspaceId });
    if (create.kind === 'rejected') return { kind: 'unsupported', reason: create.reason } as LaunchResult;
    let operationId = create.operationId;
    let locator: NativeLaunchLocator | undefined;
    const self = this;
    const workflow = Effect.gen(function* () {
      let client = yield* self.clientEffect(binding);
      const tab = yield* self.boundary('Herdr.tab.create', () => client.request('tab.create', { workspace_id: binding.workspaceId, cwd: request.cwd, env: request.env, label: request.agentName, focus: false }));
      if (tab.type !== 'tab_created' || tab.tab.workspace_id !== binding.workspaceId || tab.root_pane.workspace_id !== binding.workspaceId || tab.root_pane.tab_id !== tab.tab.tab_id)
        return unconfirmedLaunch(operationId, 'Herdr returned an unexpected tab');
      locator = launchLocator(binding, tab.root_pane, request);
      const start = yield* self.prepareClaim({ kind: 'start-agent', paneId: tab.root_pane.pane_id, agentKind: request.agentKind });
      if (start.kind === 'rejected') return { kind: 'unsupported', reason: start.reason } as LaunchResult;
      operationId = start.operationId;
      client = yield* self.clientEffect(binding);
      let started: ResponseTypes.ResponseResult | undefined;
      for (let retry = 0; retry <= 20; retry += 1) {
        const attempted = yield* Effect.result(self.boundary('Herdr.agent.start', () => client.request('agent.start', { pane_id: tab.root_pane.pane_id, name: request.agentName, kind: request.agentKind, args: request.args ?? [], timeout_ms: request.timeoutMs ?? 30000 })));
        if (attempted._tag === 'Success') { started = attempted.success; break; }
        const cause = attempted.failure.cause;
        if (!(cause instanceof HerdrError) || !cause.message.includes('not an available shell') || retry >= 20) return yield* attempted.failure;
        yield* Effect.sleep('250 millis');
        client = yield* self.clientEffect(binding);
      }
      if (!started || started.type !== 'agent_started') return unconfirmedLaunch(operationId, 'Herdr did not acknowledge agent start', locator);
      const startedIdentity = yield* self.identityEffect(client, binding, started.agent, request, tab.tab.tab_id);
      if (startedIdentity) locator = identityLocator(startedIdentity);
      let identity: NativeIdentity | undefined;
      for (let poll = 0; poll <= 20 && !identity; poll += 1) {
        if (poll > 0) yield* Effect.sleep('250 millis');
        client = yield* self.clientEffect(binding);
        const current = yield* self.boundary('Herdr.agent.get', () => client.request('agent.get', { target: tab.root_pane.pane_id }));
        if (current.type !== 'agent_info') break;
        identity = yield* self.identityEffect(client, binding, current.agent, request, tab.tab.tab_id);
      }
      if (!identity) return unconfirmedLaunch(operationId, 'Native agent identity did not match launch', locator);
      locator = identityLocator(identity);
      let observation = yield* self.observeEffect(identity);
      for (let poll = 0; observation.kind === 'unconfirmed' && observation.reason === 'Native agent is not explicitly ready' && poll < 20; poll += 1) {
        yield* Effect.sleep('250 millis');
        observation = yield* self.observeEffect(identity);
      }
      return observation.kind === 'settled'
        ? { kind: 'launched', identity } as LaunchResult
        : unconfirmedLaunch(operationId, `Agent is ${observation.kind}`, locator);
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed(unconfirmedLaunch(operationId, cause instanceof Error ? errorText(cause) : 'Native launch failed', locator))));
  }.bind(this));

  readonly observeEffect = Effect.fn('HerdrNativeAdapter.observe')(function* (this: HerdrNativeAdapter, identity: NativeIdentity) {
    const self = this;
    const workflow = Effect.gen(function* () {
      const client = yield* self.clientEffect(identity.binding);
      const current = yield* self.boundary('Herdr.agent.get', () => client.request('agent.get', { target: identity.paneId }));
      if (current.type !== 'agent_info') return unconfirmedObservation('Native agent identity changed');
      const refreshed = yield* self.refreshedIdentityEffect(client, identity, current.agent);
      if (refreshed.kind === 'unconfirmed') return refreshed;
      const observedIdentity = refreshed.identity;
      if (current.agent.agent_status === 'idle' || current.agent.agent_status === 'done' || current.agent.agent_status === 'blocked') {
        const screen = yield* self.boundary('Herdr.pane.read', () => client.request('pane.read', { pane_id: identity.paneId, source: 'recent_unwrapped', format: 'text', lines: 120, strip_ansi: true }));
        if (screen.type !== 'pane_read' || screen.read.pane_id !== identity.paneId || screen.read.tab_id !== identity.tabId || screen.read.workspace_id !== identity.binding.workspaceId)
          return unconfirmedObservation('Native pane read did not match the registered pane');
        const failure = classifyNativeFailure({ source: 'pane', status: current.agent.agent_status, text: screen.read.text, truncated: screen.read.truncated === true, interactiveReady: current.agent.interactive_ready, launchPending: current.agent.launch_pending });
        const required = manualRequirement(screen.read.text);
        if (required) return { kind: 'manual-required', identity: observedIdentity, reason: required, failure } satisfies NativeObservation;
        if (failure.kind === 'provider-refusal') return { kind: 'blocked', identity: observedIdentity, reason: 'Native provider refused the request', failure } satisfies NativeObservation;
        if (current.agent.agent_status === 'blocked') return { kind: 'blocked', identity: observedIdentity, reason: 'Native agent is blocked', failure } satisfies NativeObservation;
        if (!current.agent.launch_pending && current.agent.interactive_ready === true)
          return { kind: 'settled', identity: observedIdentity, slotReady: true, failure } satisfies NativeObservation;
      }
      if (current.agent.agent_status === 'working') return { kind: 'working', identity: observedIdentity } as NativeObservation;
      return unconfirmedObservation('Native agent is not explicitly ready', { source: 'adapter', detail: `Herdr reported status=${current.agent.agent_status}, interactive_ready=${String(current.agent.interactive_ready)}, launch_pending=${String(current.agent.launch_pending)}` });
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed(unconfirmedObservation(boundaryReason(cause, 'Native observation failed'), { source: 'boundary', operation: cause instanceof NativeBoundaryError ? cause.operation : 'HerdrNativeAdapter.observe', cause }))));
  }.bind(this));

  readonly recoverEffect = Effect.fn('HerdrNativeAdapter.recover')(function* (this: HerdrNativeAdapter, binding: NativeBinding, locator: NativeLaunchLocator) {
    if (decodeOptional(NativeLaunchLocatorSchema, locator) === undefined) return unconfirmedObservation('Persisted native launch locator is invalid');
    if (!sameBinding(binding, locator.binding) || locator.ownedTabId !== locator.tabId) return unconfirmedObservation('Persisted native launch locator changed');
    const self = this;
    const workflow = Effect.gen(function* () {
      const client = yield* self.clientEffect(binding);
      const current = yield* self.boundary('Herdr.agent.get', () => client.request('agent.get', { target: locator.paneId }));
      if (current.type !== 'agent_info' || !sameAgent(locator, current.agent)) return unconfirmedObservation('Native agent locator no longer matches');
      const persisted = decodeOptional(NativeIdentitySchema, {
        ...locator,
        identityRevision: locator.identityRevision ?? current.agent.revision,
      });
      if (!persisted) return unconfirmedObservation('Persisted native process identity is unavailable');
      const refreshed = yield* self.refreshedIdentityEffect(client, persisted, current.agent);
      return refreshed.kind === 'confirmed' ? yield* self.observeEffect(refreshed.identity) : refreshed;
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed(unconfirmedObservation(boundaryReason(cause, 'Native recovery failed'), { source: 'boundary', operation: cause instanceof NativeBoundaryError ? cause.operation : 'HerdrNativeAdapter.recover', cause }))));
  }.bind(this));

  readonly adoptEffect = Effect.fn('HerdrNativeAdapter.adopt')(function* (this: HerdrNativeAdapter, binding: NativeBinding, locator: NativeLaunchLocator, authorization: NativeFixtureRecoveryAuthorization) {
    if (decodeOptional(NativeAdoptionLocatorSchema, locator) === undefined) return unconfirmedObservation('Native fixture adoption locator is invalid');
    if (decodeOptional(NativeFixtureRecoveryAuthorizationSchema, authorization) === undefined) return unconfirmedObservation('Native fixture adoption authorization is invalid');
    if (!sameBinding(binding, locator.binding) || !sameBinding(binding, authorization.binding) || locator.ownedTabId !== locator.tabId || !sameFixtureAuthorization(locator, authorization))
      return unconfirmedObservation('Native fixture adoption target changed');
    const self = this;
    const workflow = Effect.gen(function* () {
      const client = yield* self.clientEffect(binding);
      const current = yield* self.boundary('Herdr.agent.get', () => client.request('agent.get', { target: locator.paneId }));
      if (current.type !== 'agent_info' || !sameAgent(locator, current.agent)) return unconfirmedObservation('Native fixture agent locator no longer matches');
      const identity = yield* self.identityEffect(client, binding, current.agent, locator, locator.ownedTabId);
      return identity ? yield* self.observeEffect(identity) : unconfirmedObservation('Native fixture agent identity is unavailable');
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed(unconfirmedObservation(boundaryReason(cause, 'Native fixture adoption failed'), { source: 'boundary', operation: cause instanceof NativeBoundaryError ? cause.operation : 'HerdrNativeAdapter.adopt', cause }))));
  }.bind(this));

  readonly registerEffect = Effect.fn('HerdrNativeAdapter.register')(function* (this: HerdrNativeAdapter, input: { hostId: string; socketPath: string; workspaceId: string }) {
    const self = this;
    const workflow = Effect.gen(function* () {
      const endpoint = yield* Effect.try({ try: () => socketEvidence(input.socketPath), catch: (cause) => new NativeBoundaryError({ operation: 'Herdr.socket.stat', cause }) });
      const serverStartToken = yield* self.boundary('NativeEndpointInspector.serverStartToken', () => self.endpointInspector.serverStartToken(input.socketPath));
      if (!serverStartToken) return { kind: 'unsupported', reason: 'The Herdr server has no verifiable start token' } as const;
      const client = self.clientFor(input.socketPath);
      const ping = yield* self.boundary('Herdr.ping', () => client.request('ping', {}));
      if (ping.type !== 'pong') return { kind: 'unsupported', reason: 'Herdr did not return pong' } as const;
      const workspace = yield* self.boundary('Herdr.workspace.get', () => client.request('workspace.get', { workspace_id: input.workspaceId }));
      if (workspace.type !== 'workspace_info' || workspace.workspace.workspace_id !== input.workspaceId) return { kind: 'unsupported', reason: 'The registered workspace is unavailable' } as const;
      const generation = endpointGeneration(ping);
      const evidence: NativeEndpointEvidence = { ...endpoint, serverStartToken, protocol: ping.protocol };
      if (generation !== undefined) evidence.endpointProtocolGeneration = generation;
      return { hostId: input.hostId, socketPath: input.socketPath, workspaceId: input.workspaceId, endpoint: evidence } as NativeBinding;
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed({ kind: 'unsupported', reason: `Cannot register Herdr endpoint: ${boundaryReason(cause, 'unknown error')}` } as const)));
  }.bind(this));

  readonly promptEffect = Effect.fn('HerdrNativeAdapter.prompt')(function* (this: HerdrNativeAdapter, identity: NativeIdentity, text: string) {
    const prepared = yield* this.prepareClaim({ kind: 'prompt', paneId: identity.paneId, textDigest: promptDigest(text) });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason } as NativeSubmission;
    const observation = yield* this.observeEffect(identity);
    if (observation.kind !== 'settled') return { kind: 'unconfirmed', operationId: prepared.operationId, reason: `Agent is ${observation.kind}` } as NativeSubmission;
    const client = yield* this.clientEffect(identity.binding).pipe(Effect.catch((cause) => Effect.succeed(cause)));
    if (client instanceof NativeBoundaryError) return { kind: 'unconfirmed', operationId: prepared.operationId, reason: boundaryReason(client, 'Native prompt failed') } as NativeSubmission;
    return yield* this.boundary('Herdr.agent.prompt', () => client.request('agent.prompt', { target: identity.paneId, text })).pipe(
      Effect.map((result) => result.type === 'agent_prompted' ? { kind: 'submitted', operationId: prepared.operationId } as NativeSubmission : { kind: 'unconfirmed', operationId: prepared.operationId, reason: 'Herdr did not acknowledge prompt' } as NativeSubmission),
      Effect.catch((cause) => Effect.succeed({ kind: 'unconfirmed', operationId: prepared.operationId, reason: errorText(cause) } as NativeSubmission)),
    );
  }.bind(this));

  readonly interruptEffect = Effect.fn('HerdrNativeAdapter.interrupt')(function* (this: HerdrNativeAdapter, identity: NativeIdentity) {
    const prepared = yield* this.prepareClaim({ kind: 'interrupt', paneId: identity.paneId });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason } as NativeSubmission;
    const observation = yield* this.observeEffect(identity);
    if (observation.kind === 'unconfirmed' || observation.kind === 'manual-required') return { kind: 'unconfirmed', operationId: prepared.operationId, reason: observation.reason } as NativeSubmission;
    const client = yield* this.clientEffect(identity.binding).pipe(Effect.catch((cause) => Effect.succeed(cause)));
    if (client instanceof NativeBoundaryError) return { kind: 'unconfirmed', operationId: prepared.operationId, reason: boundaryReason(client, 'Native interrupt failed') } as NativeSubmission;
    return yield* this.boundary('Herdr.agent.interrupt', () => client.request('agent.send_keys', { target: identity.paneId, keys: ['esc'] })).pipe(
      Effect.as({ kind: 'submitted', operationId: prepared.operationId } as NativeSubmission),
      Effect.catch((cause) => Effect.succeed({ kind: 'unconfirmed', operationId: prepared.operationId, reason: errorText(cause) } as NativeSubmission)),
    );
  }.bind(this));

  readonly cleanupEffect = Effect.fn('HerdrNativeAdapter.cleanup')(function* (this: HerdrNativeAdapter, identity: NativeIdentity, authorized: boolean) {
    if (!authorized) return { kind: 'unsupported', reason: 'Cleanup requires explicit authorization' } as CleanupResult;
    const prepared = yield* this.prepareClaim({ kind: 'cleanup', tabId: identity.ownedTabId });
    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason } as CleanupResult;
    const observation = yield* this.observeEffect(identity);
    if (observation.kind !== 'settled') return { kind: 'unconfirmed', operationId: prepared.operationId, reason: `Agent is ${observation.kind}` } as CleanupResult;
    const self = this;
    const workflow = Effect.gen(function* () {
      const client = yield* self.clientEffect(identity.binding);
      const panes = yield* self.boundary('Herdr.pane.list', () => client.request('pane.list', { workspace_id: identity.binding.workspaceId }));
      const ownedPanes = panes.type === 'pane_list' ? panes.panes.filter((pane) => pane.tab_id === identity.ownedTabId) : [];
      if (ownedPanes.length !== 1 || ownedPanes[0].pane_id !== identity.paneId || ownedPanes[0].terminal_id !== identity.terminalId)
        return { kind: 'unconfirmed', operationId: prepared.operationId, reason: 'Owned tab no longer contains exactly the registered pane' } as CleanupResult;
      const result = yield* self.boundary('Herdr.tab.close', () => client.request('tab.close', { tab_id: identity.ownedTabId }));
      return result.type === 'ok' ? { kind: 'cleaned', operationId: prepared.operationId } as CleanupResult : { kind: 'unconfirmed', operationId: prepared.operationId, reason: 'Herdr did not acknowledge tab cleanup' } as CleanupResult;
    });
    return yield* workflow.pipe(Effect.catch((cause) => Effect.succeed({ kind: 'unconfirmed', operationId: prepared.operationId, reason: boundaryReason(cause, 'Native cleanup failed') } as CleanupResult)));
  }.bind(this));

  register(input: { hostId: string; socketPath: string; workspaceId: string }) { return Effect.runPromise(this.registerEffect(input)); }
  launch(binding: NativeBinding, request: LaunchRequest) { return Effect.runPromise(this.launchEffect(binding, request)); }
  recover(binding: NativeBinding, locator: NativeLaunchLocator) { return Effect.runPromise(this.recoverEffect(binding, locator)); }
  adopt(binding: NativeBinding, locator: NativeLaunchLocator, authorization: NativeFixtureRecoveryAuthorization) { return Effect.runPromise(this.adoptEffect(binding, locator, authorization)); }
  observe(identity: NativeIdentity) { return Effect.runPromise(this.observeEffect(identity)); }
  prompt(identity: NativeIdentity, text: string) { return Effect.runPromise(this.promptEffect(identity, text)); }
  interrupt(identity: NativeIdentity) { return Effect.runPromise(this.interruptEffect(identity)); }
  approval(): NativeSubmission { return { kind: 'unsupported', reason: 'Native approvals require a supported user action adapter' }; }
  cleanup(identity: NativeIdentity, authorized: boolean) { return Effect.runPromise(this.cleanupEffect(identity, authorized)); }
}
