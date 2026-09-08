import {
  HERDR_METHODS,
  type HerdrMethod,
  type HerdrParams,
  type HerdrResult,
  type ResponseTypes,
  type RequestTypes,
} from './herdr-protocol.js';
import {
  HerdrEventStream,
  HerdrGraphicsStream,
  type GraphicsStreamParams,
} from './herdr-streams.js';
import {
  socketRequest,
  validateSocketPath,
  type RequestOptions,
  type StreamOptions,
} from './herdr-transport.js';
export * from './herdr-protocol.js';
export { HerdrError } from './herdr-transport.js';
export type { RequestOptions, StreamOptions } from './herdr-transport.js';
export { HerdrEventStream, HerdrGraphicsStream } from './herdr-streams.js';
export type {
  GraphicsStreamParams,
  GraphicsFrame,
  GraphicsFileFrame,
  GraphicsFrameAck,
} from './herdr-streams.js';

export type Pane = ResponseTypes.PaneInfo;
export type Agent = ResponseTypes.AgentInfo;
export type PaneLayout = ResponseTypes.PaneLayoutSnapshot;
export type RequestMethod = Exclude<HerdrMethod, 'events.subscribe'>;
export type RequestArgs<M extends RequestMethod> = {} extends HerdrParams[M]
  ? [params?: HerdrParams[M], options?: RequestOptions]
  : [params: HerdrParams[M], options?: RequestOptions];
export type HerdrApi = {
  readonly [M in RequestMethod]: (...args: RequestArgs<M>) => Promise<HerdrResult>;
} & {
  readonly 'events.subscribe': (
    params: HerdrParams['events.subscribe'],
    options?: StreamOptions,
  ) => Promise<HerdrEventStream>;
  readonly 'pane.graphics.stream': (
    params: GraphicsStreamParams,
    options?: StreamOptions,
  ) => Promise<HerdrGraphicsStream>;
};

/** Respect server waits; the transport must not time out an otherwise valid long wait. */
function deadline(method: string, params: any): number | null {
  if (method === 'agent.start') return (params.timeout_ms ?? 30000) + 5000;
  const wait =
    method === 'agent.prompt'
      ? params.wait
      : ['agent.wait', 'events.wait', 'pane.wait_for_output'].includes(method)
        ? params
        : undefined;
  if (wait) return wait.timeout_ms == null ? null : wait.timeout_ms + 5000;
  return 10000;
}
export interface LaunchOptions {
  cwd: string;
  env?: Record<string, string>;
  focus?: boolean;
}
export interface WaitOptions {
  timeout_ms: number;
  until?: ('idle' | 'working' | 'blocked' | 'done' | 'unknown')[];
}

/** Explicit connection selection, typed wire APIs, and small convenience helpers. */
export class HerdrClient {
  constructor(public readonly socketPath: string) {
    validateSocketPath(socketPath);
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    if (env.HERDR_ENV !== '1' || !env.HERDR_SOCKET_PATH)
      throw new Error('Run inside Herdr or supply an explicitly selected socket path');
    return new HerdrClient(env.HERDR_SOCKET_PATH);
  }
  /** Escape hatch for future one-shot methods. Streams require their dedicated transports. */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<T> {
    if (method === 'events.subscribe' || method === 'pane.graphics.stream')
      return Promise.reject(
        new TypeError('Use subscribe(), graphicsStream(), or api for a streaming method'),
      );
    return socketRequest<T>(this.socketPath, method, params, { timeoutMs });
  }
  /** All schema-defined one-shot methods with exact typed parameter objects. */
  request<M extends RequestMethod>(method: M, ...args: RequestArgs<M>): Promise<HerdrResult> {
    const [params = {}, options = {}] = args;
    if (
      !(HERDR_METHODS as readonly string[]).includes(method) ||
      (method as string) === 'events.subscribe'
    )
      return Promise.reject(
        new TypeError(
          'Unknown one-shot method; use call() for extensions or subscribe() for events',
        ),
      );
    return socketRequest<HerdrResult>(this.socketPath, method, params, {
      ...options,
      timeoutMs: options.timeoutMs === undefined ? deadline(method, params) : options.timeoutMs,
    });
  }
  subscribe(subscriptions: RequestTypes.Subscription[], options?: StreamOptions) {
    return HerdrEventStream.open(this.socketPath, subscriptions, options);
  }
  graphicsStream(params: GraphicsStreamParams, options?: StreamOptions) {
    return HerdrGraphicsStream.open(this.socketPath, params, options);
  }
  /** One-to-one method names, including streams, for discovery and generated agent code. */
  readonly api: HerdrApi = Object.freeze(
    Object.fromEntries([
      ...HERDR_METHODS.map((method) => [
        method,
        method === 'events.subscribe'
          ? (params: HerdrParams['events.subscribe'], options?: StreamOptions) =>
              this.subscribe(params.subscriptions, options)
          : (params: any = {}, options?: RequestOptions) => this.request(method, params, options),
      ]),
      [
        'pane.graphics.stream',
        (params: GraphicsStreamParams, options?: StreamOptions) =>
          this.graphicsStream(params, options),
      ],
    ]),
  ) as HerdrApi;
  readonly workspace = {
    list: () =>
      this.call<{ workspaces: { workspace_id: string; label?: string }[] }>('workspace.list'),
    create: (options: LaunchOptions & { label: string }) =>
      this.call<{ root_pane: Pane; workspace: { workspace_id: string } }>('workspace.create', {
        focus: false,
        ...options,
      }),
  };
  readonly tab = {
    create: (workspaceId: string, options: LaunchOptions & { label?: string }) =>
      this.call<{ root_pane: Pane }>('tab.create', {
        focus: false,
        ...options,
        workspace_id: workspaceId,
      }),
    list: (workspaceId: string) =>
      this.call<{
        tabs: { tab_id: string; workspace_id: string; label?: string; pane_count: number }[];
      }>('tab.list', { workspace_id: workspaceId }),
    close: (tabId: string) => this.call('tab.close', { tab_id: tabId }),
  };
  readonly pane = {
    list: (workspaceId: string) =>
      this.call<{ panes: Pane[] }>('pane.list', { workspace_id: workspaceId }),
    layout: (paneId: string) =>
      this.call<{ layout: PaneLayout }>('pane.layout', { pane_id: paneId }),
    split: (
      paneId: string,
      options: LaunchOptions & { direction: 'right' | 'down'; ratio?: number },
    ) =>
      this.call<{ pane: Pane }>('pane.split', { focus: false, ...options, target_pane_id: paneId }),
    read: (paneId: string, lines = 120) =>
      this.call<{ read: { text: string } }>('pane.read', {
        pane_id: paneId,
        source: 'recent_unwrapped',
        format: 'text',
        lines,
      }),
    sendText: (paneId: string, text: string) =>
      this.call('pane.send_text', { pane_id: paneId, text }),
    sendKeys: (paneId: string, keys: string[]) =>
      this.call('pane.send_keys', { pane_id: paneId, keys }),
    close: (paneId: string) => this.call('pane.close', { pane_id: paneId }),
  };
  readonly agent = {
    start: (paneId: string, name: string, kind: string, args: string[] = [], timeoutMs = 30000) =>
      this.call(
        'agent.start',
        { pane_id: paneId, name, kind, args, timeout_ms: timeoutMs },
        timeoutMs + 5000,
      ),
    get: (target: string) => this.call<{ agent: Agent }>('agent.get', { target }),
    prompt: (target: string, text: string, wait?: WaitOptions) =>
      this.call(
        'agent.prompt',
        { target, text, ...(wait ? { wait } : {}) },
        wait ? wait.timeout_ms + 5000 : 10000,
      ),
    wait: (target: string, options: WaitOptions) =>
      this.call('agent.wait', { target, ...options }, options.timeout_ms + 5000),
    sendKeys: (target: string, keys: string[]) => this.call('agent.send_keys', { target, keys }),
  };
}
