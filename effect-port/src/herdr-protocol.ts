// Generated from Herdr 0.9.0 (Apache-2.0); see vendor/herdr-0.9.0/LICENSE.
// Do not edit. Run npm run sdk:generate.
export const HERDR_PROTOCOL = 22 as const;
export const HERDR_SCHEMA_SHA256 =
  '5fb46b13fdaf39c88cf699b9806685868c7ee6b0142523d84391b1606416dc0a' as const;
export namespace RequestTypes {
  export type AgentPromptParams = {
    target: string;
    text: string;
    wait?: RequestTypes.AgentPromptWaitOptions | null;
  };
  export type AgentPromptWaitOptions = {
    timeout_ms?: number | null;
    until?: Array<RequestTypes.AgentStatus>;
  };
  export type AgentReadParams = {
    format?: RequestTypes.ReadFormat;
    lines?: number | null;
    source: RequestTypes.ReadSource;
    strip_ansi?: boolean;
    target: string;
  };
  export type AgentRenameParams = { name?: string | null; target: string };
  export type AgentSendKeysParams = { keys: Array<string>; target: string };
  export type AgentStartParams = {
    args?: Array<string>;
    kind: string;
    name: string;
    pane_id: string;
    /** Startup timeout in milliseconds. Values must be greater than 3000 and at most 300000. */
    timeout_ms?: number | null;
  };
  export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  export type AgentTarget = { target: string };
  export type AgentViewBuiltinField =
    'status' | 'workspace_id' | 'tab_id' | 'pane_id' | 'agent' | 'seen' | 'state_change_seq';
  export type AgentViewBuiltinSortField =
    | 'workspace_order'
    | 'tab_order'
    | 'pane_order'
    | 'attention'
    | 'status'
    | 'agent'
    | 'seen'
    | 'state_change_seq';
  export type AgentViewClearParams = { source?: string | null };
  export type AgentViewContext = 'current_workspace_id' | 'current_tab_id';
  export type AgentViewField = RequestTypes.AgentViewBuiltinField | { token: string };
  export type AgentViewFilter =
    | { filters: Array<RequestTypes.AgentViewFilter>; op: 'all' }
    | { filters: Array<RequestTypes.AgentViewFilter>; op: 'any' }
    | { filter: RequestTypes.AgentViewFilter; op: 'not' }
    | { field: RequestTypes.AgentViewField; op: 'eq'; value: RequestTypes.AgentViewValue }
    | { field: RequestTypes.AgentViewField; op: 'in'; values: Array<RequestTypes.AgentViewValue> }
    | { field: RequestTypes.AgentViewField; op: 'exists' };
  export type AgentViewSetParams = {
    filter?: RequestTypes.AgentViewFilter | null;
    label?: string | null;
    sort?: Array<RequestTypes.AgentViewSort>;
    source: string;
  };
  export type AgentViewSort = {
    field: RequestTypes.AgentViewSortField;
    order?: RequestTypes.AgentViewSortOrder;
  };
  export type AgentViewSortField = RequestTypes.AgentViewBuiltinSortField | { token: string };
  export type AgentViewSortOrder = 'asc' | 'desc';
  export type AgentViewValue =
    string | boolean | number | { context: RequestTypes.AgentViewContext };
  export type AgentWaitParams = {
    target: string;
    timeout_ms?: number | null;
    until?: Array<RequestTypes.AgentStatus>;
  };
  export type ClientShellSurfaceSetParams = { active: boolean };
  export type ClientWindowTitleSetParams = { title: string };
  export type CommandInvokeParams = {
    /** Opaque endpoint-issued command identifier from the client-shell projection. */
    command_id: string;
    pane_id?: string | null;
    /** Client-owned selection coordinates, validated against the pane's content revision. */
    selection?: RequestTypes.PaneSelectionReadParams | null;
    tab_id?: string | null;
    workspace_id?: string | null;
  };
  export type EmptyParams = Record<string, never>;
  export type EventMatch =
    | { event: 'workspace_created'; workspace_id?: string | null }
    | { event: 'workspace_updated'; workspace_id: string }
    | { event: 'workspace_closed'; workspace_id: string }
    | { event: 'workspace_renamed'; label?: string | null; workspace_id: string }
    | { event: 'workspace_moved'; workspace_id: string }
    | { event: 'workspace_focused'; workspace_id: string }
    | { event: 'tab_created'; tab_id?: string | null; workspace_id?: string | null }
    | { event: 'tab_closed'; tab_id: string }
    | { event: 'tab_renamed'; label?: string | null; tab_id: string }
    | { event: 'tab_moved'; tab_id: string }
    | { event: 'tab_focused'; tab_id: string }
    | { event: 'pane_created'; pane_id?: string | null; workspace_id?: string | null }
    | { event: 'pane_closed'; pane_id: string }
    | { event: 'pane_focused'; pane_id: string }
    | { event: 'pane_moved'; pane_id: string }
    | { event: 'pane_output_changed'; min_revision?: number | null; pane_id: string }
    | { event: 'pane_exited'; pane_id: string }
    | { agent?: string | null; event: 'pane_agent_detected'; pane_id: string }
    | {
        agent_status: RequestTypes.AgentStatus;
        event: 'pane_agent_status_changed';
        pane_id: string;
      };
  export type EventsSubscribeParams = { subscriptions: Array<RequestTypes.Subscription> };
  export type EventsWaitParams = {
    match_event: RequestTypes.EventMatch;
    timeout_ms?: number | null;
  };
  export type IntegrationInstallParams = { target: RequestTypes.IntegrationTarget };
  export type IntegrationTarget =
    | 'pi'
    | 'omp'
    | 'claude'
    | 'codex'
    | 'copilot'
    | 'devin'
    | 'droid'
    | 'kimi'
    | 'opencode'
    | 'kilo'
    | 'hermes'
    | 'qodercli'
    | 'qwen'
    | 'cursor'
    | 'mastracode'
    | 'antigravity_cli'
    | 'grok';
  export type IntegrationUninstallParams = { target: RequestTypes.IntegrationTarget };
  export type LayoutApplyParams = {
    focus?: boolean;
    root: RequestTypes.LayoutNode;
    tab_id?: string | null;
    tab_label?: string | null;
    workspace_id?: string | null;
  };
  export type LayoutExportParams = { pane_id?: string | null; tab_id?: string | null };
  export type LayoutNode =
    | {
        command?: Array<string> | null;
        cwd?: string | null;
        env?: { [key: string]: string };
        label?: string | null;
        pane_id?: string | null;
        type: 'pane';
      }
    | {
        direction: RequestTypes.SplitDirection;
        first: RequestTypes.LayoutNode;
        ratio: number;
        second: RequestTypes.LayoutNode;
        type: 'split';
      };
  export type LayoutSetSplitRatioParams = {
    pane_id?: string | null;
    path: Array<boolean>;
    ratio: number;
    tab_id?: string | null;
  };
  export type NotificationShowParams = {
    body?: string | null;
    position?: RequestTypes.ToastHerdrPosition | null;
    sound?: RequestTypes.NotificationShowSound;
    title: string;
  };
  export type NotificationShowSound = 'none' | 'done' | 'request';
  export type OutputMatch = { type: 'substring'; value: string } | { type: 'regex'; value: string };
  export type PaneAgentState = 'idle' | 'working' | 'blocked' | 'unknown';
  export type PaneClearAgentAuthorityParams = {
    pane_id: string;
    seq?: number | null;
    source?: string | null;
  };
  export type PaneCopyMotion =
    | 'line_end'
    | 'first_non_blank'
    | 'next_word_start'
    | 'previous_word_start'
    | 'next_word_end'
    | 'next_big_word_start'
    | 'previous_big_word_start'
    | 'next_big_word_end'
    | 'previous_paragraph'
    | 'next_paragraph';
  export type PaneCopyMotionParams = {
    content_revision?: number | null;
    cursor: RequestTypes.PaneTextPoint;
    motion: RequestTypes.PaneCopyMotion;
    pane_id: string;
  };
  export type PaneCopySearchDirection = 'forward' | 'backward';
  export type PaneCopySearchParams = {
    content_revision: number;
    cursor: RequestTypes.PaneTextPoint;
    direction: RequestTypes.PaneCopySearchDirection;
    pane_id: string;
    previous?: RequestTypes.PaneTextRange | null;
    query: string;
  };
  export type PaneCurrentParams = { caller_pane_id?: string | null };
  export type PaneDirection = 'left' | 'right' | 'up' | 'down';
  export type PaneEdgesParams = { pane_id?: string | null };
  export type PaneFocusDirectionParams = {
    direction: RequestTypes.PaneDirection;
    pane_id?: string | null;
  };
  export type PaneGraphicsClearParams = { layer_id?: string | null; pane_id: string };
  export type PaneGraphicsFormat = 'png' | 'rgb' | 'rgba' | 'bgra';
  export type PaneGraphicsPlacementParams = {
    grid_cols?: number;
    grid_rows?: number;
    viewport_col?: number;
    viewport_row?: number;
  };
  export type PaneGraphicsSetParams = {
    data_base64?: string;
    format: RequestTypes.PaneGraphicsFormat;
    image_height: number;
    image_width: number;
    layer_id?: string | null;
    pane_id: string;
    placement?: RequestTypes.PaneGraphicsPlacementParams;
    z_index?: number;
  };
  export type PaneInputSetParams = {
    pane_id: string;
    right_click: RequestTypes.PaneRightClickTarget;
  };
  export type PaneLayoutParams = { pane_id?: string | null };
  export type PaneLinkActivateParams = {
    col: number;
    content_revision?: number | null;
    offset_from_bottom?: number | null;
    pane_id: string;
    viewport_row: number;
  };
  export type PaneListParams = { workspace_id?: string | null };
  export type PaneMoveDestination =
    | {
        ratio?: number | null;
        split: RequestTypes.SplitDirection;
        tab_id: string;
        target_pane_id?: string | null;
        type: 'tab';
      }
    | { label?: string | null; type: 'new_tab'; workspace_id?: string | null }
    | { label?: string | null; tab_label?: string | null; type: 'new_workspace' };
  export type PaneMoveParams = {
    destination: RequestTypes.PaneMoveDestination;
    focus?: boolean;
    pane_id: string;
  };
  export type PaneNeighborParams = {
    direction: RequestTypes.PaneDirection;
    pane_id?: string | null;
  };
  export type PaneProcessInfoParams = { pane_id?: string | null };
  export type PaneReadParams = {
    format?: RequestTypes.ReadFormat;
    lines?: number | null;
    pane_id: string;
    source: RequestTypes.ReadSource;
    strip_ansi?: boolean;
  };
  export type PaneReleaseAgentParams = {
    agent: string;
    pane_id: string;
    seq?: number | null;
    source: string;
  };
  export type PaneRenameParams = { label?: string | null; pane_id: string };
  export type PaneReportAgentParams = {
    agent: string;
    agent_session_id?: string | null;
    agent_session_path?: string | null;
    message?: string | null;
    pane_id: string;
    seq?: number | null;
    source: string;
    state: RequestTypes.PaneAgentState;
  };
  export type PaneReportAgentSessionParams = {
    agent: string;
    agent_session_id?: string | null;
    agent_session_path?: string | null;
    pane_id: string;
    seq?: number | null;
    session_start_source?: string | null;
    source: string;
  };
  export type PaneReportMetadataParams = {
    agent?: string | null;
    applies_to_source?: string | null;
    clear_display_agent?: boolean;
    clear_state_labels?: boolean;
    clear_title?: boolean;
    display_agent?: string | null;
    pane_id: string;
    seq?: number | null;
    source: string;
    state_labels?: { [key: string]: string };
    title?: string | null;
    tokens?: { [key: string]: string | null };
    ttl_ms?: number | null;
  };
  export type PaneResizeParams = {
    amount?: number | null;
    direction: RequestTypes.PaneDirection;
    pane_id?: string | null;
  };
  export type PaneRightClickTarget = 'herdr' | 'pane';
  export type PaneScrollParams = { offset_from_bottom: number; pane_id: string };
  export type PaneSelectionReadParams = {
    anchor: RequestTypes.PaneTextPoint;
    content_revision?: number | null;
    cursor: RequestTypes.PaneTextPoint;
    pane_id: string;
  };
  export type PaneSendInputParams = { keys?: Array<string>; pane_id: string; text?: string };
  export type PaneSendKeysParams = { keys: Array<string>; pane_id: string };
  export type PaneSendTextParams = { pane_id: string; text: string };
  export type PaneSplitParams = {
    cwd?: string | null;
    direction: RequestTypes.SplitDirection;
    env?: { [key: string]: string };
    focus?: boolean;
    ratio?: number | null;
    right_click?: RequestTypes.PaneRightClickTarget;
    target_pane_id?: string | null;
    workspace_id?: string | null;
  };
  export type PaneSwapParams = {
    direction?: RequestTypes.PaneDirection | null;
    pane_id?: string | null;
    source_pane_id?: string | null;
    target_pane_id?: string | null;
  };
  export type PaneTarget = { pane_id: string };
  export type PaneTextPoint = { col: number; row: number };
  export type PaneTextRange = {
    end: RequestTypes.PaneTextPoint;
    start: RequestTypes.PaneTextPoint;
  };
  export type PaneWaitForOutputParams = {
    lines?: number | null;
    match: RequestTypes.OutputMatch;
    pane_id: string;
    source: RequestTypes.ReadSource;
    strip_ansi?: boolean;
    timeout_ms?: number | null;
  };
  export type PaneZoomMode = 'toggle' | 'on' | 'off';
  export type PaneZoomParams = { mode?: RequestTypes.PaneZoomMode; pane_id?: string | null };
  export type PingParams = Record<string, never>;
  export type PluginActionInvokeParams = {
    action_id: string;
    context?: RequestTypes.PluginInvocationContext | null;
    plugin_id?: string | null;
  };
  export type PluginActionListParams = { plugin_id?: string | null };
  export type PluginInvocationContext = {
    clicked_url?: string | null;
    correlation_id?: string | null;
    focused_pane_agent?: string | null;
    focused_pane_cwd?: string | null;
    focused_pane_id?: string | null;
    focused_pane_status?: RequestTypes.AgentStatus | null;
    invocation_source?: string | null;
    link_handler_id?: string | null;
    selected_text?: string | null;
    tab_id?: string | null;
    tab_label?: string | null;
    workspace_cwd?: string | null;
    workspace_id?: string | null;
    workspace_label?: string | null;
    worktree?: RequestTypes.WorkspaceWorktreeInfo | null;
  };
  export type PluginLinkParams = {
    enabled?: boolean;
    path: string;
    source?: RequestTypes.PluginSourceInfo | null;
  };
  export type PluginListParams = { plugin_id?: string | null };
  export type PluginLogListParams = { limit?: number | null; plugin_id?: string | null };
  export type PluginPaneCloseParams = { pane_id: string };
  export type PluginPaneFocusParams = { pane_id: string };
  export type PluginPaneOpenParams = {
    cwd?: string | null;
    direction?: RequestTypes.SplitDirection | null;
    entrypoint: string;
    env?: { [key: string]: string };
    focus?: boolean;
    height?: RequestTypes.PopupSize | null;
    placement?: RequestTypes.PluginPanePlacement | null;
    plugin_id: string;
    target_pane_id?: string | null;
    width?: RequestTypes.PopupSize | null;
    workspace_id?: string | null;
  };
  export type PluginPanePlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed';
  export type PluginSetEnabledParams = { plugin_id: string };
  export type PluginSourceInfo = {
    installed_unix_ms?: number | null;
    kind?: RequestTypes.PluginSourceKind;
    managed_path?: string | null;
    owner?: string | null;
    repo?: string | null;
    requested_ref?: string | null;
    resolved_commit?: string | null;
    subdir?: string | null;
  };
  export type PluginSourceKind = 'local' | 'github';
  export type PluginUnlinkParams = { plugin_id: string };
  export type PopupSize = number | string;
  export type ProductAnnouncementDismissParams = { id: string; version: string };
  export type ReadFormat = 'text' | 'ansi';
  export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
  export type ReleaseNotesDismissParams = { version: string };
  export type ServerLiveHandoffParams = {
    expected_protocol?: number | null;
    expected_version?: string | null;
    import_exe?: string | null;
  };
  export type SplitDirection = 'right' | 'down';
  export type Subscription =
    | { type: 'workspace.created' }
    | { type: 'workspace.updated' }
    | { type: 'workspace.metadata_updated' }
    | { type: 'workspace.renamed' }
    | { type: 'workspace.moved' }
    | { type: 'workspace.reordered' }
    | { type: 'workspace.closed' }
    | { type: 'workspace.focused' }
    | { type: 'worktree.created' }
    | { type: 'worktree.opened' }
    | { type: 'worktree.removed' }
    | { type: 'tab.created' }
    | { type: 'tab.closed' }
    | { type: 'tab.focused' }
    | { type: 'tab.renamed' }
    | { type: 'tab.moved' }
    | { type: 'pane.created' }
    | { type: 'pane.closed' }
    | { type: 'pane.updated' }
    | { type: 'pane.focused' }
    | { type: 'pane.moved' }
    | { type: 'pane.exited' }
    | { type: 'pane.agent_detected' }
    | {
        lines?: number | null;
        match: RequestTypes.OutputMatch;
        pane_id: string;
        source: RequestTypes.ReadSource;
        strip_ansi?: boolean;
        type: 'pane.output_matched';
      }
    | {
        agent_status?: RequestTypes.AgentStatus | null;
        pane_id: string;
        type: 'pane.agent_status_changed';
      }
    | { pane_id: string; type: 'pane.scroll_changed' }
    | { type: 'layout.updated' };
  export type TabCreateParams = {
    cwd?: string | null;
    env?: { [key: string]: string };
    focus?: boolean;
    label?: string | null;
    workspace_id?: string | null;
  };
  export type TabListParams = { workspace_id?: string | null };
  export type TabMoveParams = { insert_index: number; tab_id: string };
  export type TabRenameParams = { label: string; tab_id: string };
  export type TabTarget = { tab_id: string };
  export type ToastHerdrPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  export type WorkspaceCloseParams = { close_group?: boolean; workspace_id: string };
  export type WorkspaceCreateParams = {
    cwd?: string | null;
    env?: { [key: string]: string };
    focus?: boolean;
    label?: string | null;
    /** Workspace whose focused pane supplies the `follow` cwd policy. */
    source_workspace_id?: string | null;
  };
  export type WorkspaceMoveBlockParams = {
    before_workspace_id?: string | null;
    workspace_ids: Array<string>;
  };
  export type WorkspaceMoveParams = { insert_index: number; workspace_id: string };
  export type WorkspaceRenameParams = { label: string; workspace_id: string };
  export type WorkspaceReportMetadataParams = {
    seq?: number | null;
    source: string;
    tokens: { [key: string]: string | null };
    ttl_ms?: number | null;
    workspace_id: string;
  };
  export type WorkspaceTarget = { workspace_id: string };
  export type WorkspaceWorktreeInfo = {
    checkout_path: string;
    is_linked_worktree: boolean;
    repo_key: string;
    repo_name: string;
    repo_root: string;
  };
  export type WorktreeCreateParams = {
    base?: string | null;
    branch?: string | null;
    cwd?: string | null;
    focus?: boolean;
    label?: string | null;
    path?: string | null;
    trust_repository?: boolean;
    workspace_id?: string | null;
  };
  export type WorktreeListParams = {
    cwd?: string | null;
    trust_repository?: boolean;
    workspace_id?: string | null;
  };
  export type WorktreeOpenParams = {
    branch?: string | null;
    cwd?: string | null;
    focus?: boolean;
    label?: string | null;
    path?: string | null;
    trust_repository?: boolean;
    workspace_id?: string | null;
  };
  export type WorktreeRemoveParams = {
    force?: boolean;
    trust_repository?: boolean;
    workspace_id: string;
  };
}
export namespace ResponseTypes {
  export type AgentInfo = {
    agent?: string | null;
    agent_session?: ResponseTypes.AgentSessionInfo | null;
    agent_status: ResponseTypes.AgentStatus;
    cwd?: string | null;
    display_agent?: string | null;
    focused: boolean;
    foreground_cwd?: string | null;
    interactive_ready?: boolean;
    launch_pending?: boolean;
    name?: string | null;
    pane_id: string;
    revision: number;
    screen_detection_skipped?: boolean;
    state_change_seq?: number;
    state_labels?: { [key: string]: string };
    tab_id: string;
    terminal_id: string;
    terminal_title?: string | null;
    terminal_title_stripped?: string | null;
    title?: string | null;
    tokens?: { [key: string]: string };
    workspace_id: string;
  };
  export type AgentManifestInfo = {
    active_version?: string | null;
    agent: string;
    cached_remote_version?: string | null;
    local_override_shadowing_remote: boolean;
    remote_last_checked_unix?: number | null;
    remote_update_error?: string | null;
    remote_update_result?: string | null;
    source: string;
    source_kind: string;
    warning?: string | null;
  };
  export type AgentSessionInfo = {
    agent: string;
    kind: ResponseTypes.AgentSessionRefKind;
    source: string;
    value: string;
  };
  export type AgentSessionRefKind = 'id' | 'path';
  export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  export type ClientWindowTitleReason = 'set' | 'cleared' | 'no_foreground_client';
  export type ConfigReloadStatus = 'applied' | 'partial' | 'failed';
  export type EventData =
    | { type: 'workspace_created'; workspace: ResponseTypes.WorkspaceInfo }
    | { type: 'workspace_updated'; workspace: ResponseTypes.WorkspaceInfo }
    | { type: 'workspace_metadata_updated'; workspace: ResponseTypes.WorkspaceInfo }
    | {
        type: 'workspace_closed';
        workspace?: ResponseTypes.WorkspaceInfo | null;
        workspace_id: string;
      }
    | { label: string; type: 'workspace_renamed'; workspace_id: string }
    | {
        insert_index: number;
        type: 'workspace_moved';
        workspace_id: string;
        workspaces: Array<ResponseTypes.WorkspaceInfo>;
      }
    | {
        before_workspace_id?: string | null;
        type: 'workspace_reordered';
        workspace_ids: Array<string>;
        workspaces: Array<ResponseTypes.WorkspaceInfo>;
      }
    | { type: 'workspace_focused'; workspace_id: string }
    | {
        type: 'worktree_created';
        workspace: ResponseTypes.WorkspaceInfo;
        worktree: ResponseTypes.WorktreeInfo;
      }
    | {
        already_open: boolean;
        type: 'worktree_opened';
        workspace: ResponseTypes.WorkspaceInfo;
        worktree: ResponseTypes.WorktreeInfo;
      }
    | {
        forced: boolean;
        type: 'worktree_removed';
        workspace?: ResponseTypes.WorkspaceInfo | null;
        workspace_id: string;
        worktree: ResponseTypes.WorktreeInfo;
      }
    | { tab: ResponseTypes.TabInfo; type: 'tab_created' }
    | { tab_id: string; type: 'tab_closed'; workspace_id: string }
    | { label: string; tab_id: string; type: 'tab_renamed'; workspace_id: string }
    | {
        insert_index: number;
        tab_id: string;
        tabs: Array<ResponseTypes.TabInfo>;
        type: 'tab_moved';
        workspace_id: string;
      }
    | { tab_id: string; type: 'tab_focused'; workspace_id: string }
    | { pane: ResponseTypes.PaneInfo; type: 'pane_created' }
    | { pane_id: string; type: 'pane_closed'; workspace_id: string }
    | { pane: ResponseTypes.PaneInfo; type: 'pane_updated' }
    | { pane_id: string; type: 'pane_focused'; workspace_id: string }
    | {
        closed_tab_id?: string | null;
        closed_workspace_id?: string | null;
        created_tab?: ResponseTypes.TabInfo | null;
        created_workspace?: ResponseTypes.WorkspaceInfo | null;
        pane: ResponseTypes.PaneInfo;
        previous_pane_id: string;
        previous_tab_id: string;
        previous_workspace_id: string;
        type: 'pane_moved';
      }
    | { pane_id: string; revision: number; type: 'pane_output_changed'; workspace_id: string }
    | { pane_id: string; type: 'pane_exited'; workspace_id: string }
    | {
        agent?: string | null;
        final_status?: ResponseTypes.AgentStatus | null;
        pane_id: string;
        released?: boolean;
        type: 'pane_agent_detected';
        workspace_id: string;
      }
    | {
        agent?: string | null;
        agent_status: ResponseTypes.AgentStatus;
        display_agent?: string | null;
        pane_id: string;
        state_labels?: { [key: string]: string };
        title?: string | null;
        type: 'pane_agent_status_changed';
        workspace_id: string;
      }
    | { layout: ResponseTypes.PaneLayoutSnapshot; type: 'layout_updated' };
  export type EventEnvelope = { data: ResponseTypes.EventData; event: ResponseTypes.EventKind };
  export type EventKind =
    | 'workspace_created'
    | 'workspace_updated'
    | 'workspace_metadata_updated'
    | 'workspace_closed'
    | 'workspace_renamed'
    | 'workspace_moved'
    | 'workspace_reordered'
    | 'workspace_focused'
    | 'worktree_created'
    | 'worktree_opened'
    | 'worktree_removed'
    | 'tab_created'
    | 'tab_closed'
    | 'tab_renamed'
    | 'tab_moved'
    | 'tab_focused'
    | 'pane_created'
    | 'pane_closed'
    | 'pane_updated'
    | 'pane_focused'
    | 'pane_moved'
    | 'pane_output_changed'
    | 'pane_exited'
    | 'pane_agent_detected'
    | 'pane_agent_status_changed'
    | 'layout_updated';
  export type InstalledPluginInfo = {
    actions?: Array<ResponseTypes.PluginManifestAction>;
    build?: Array<ResponseTypes.PluginManifestBuild>;
    description?: string | null;
    enabled: boolean;
    events?: Array<ResponseTypes.PluginManifestEventHook>;
    link_handlers?: Array<ResponseTypes.PluginManifestLinkHandler>;
    manifest_path: string;
    min_herdr_version?: string;
    name: string;
    panes?: Array<ResponseTypes.PluginManifestPane>;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
    plugin_id: string;
    plugin_root: string;
    source?: ResponseTypes.PluginSourceInfo;
    startup?: Array<ResponseTypes.PluginManifestStartup>;
    version: string;
    /** Warnings collected at link time or on registry load (e.g. unknown event names,
missing manifest file). Non-fatal — the entry is kept and surfaced by plugin.list. */
    warnings?: Array<string>;
  };
  export type IntegrationInfo = {
    available: boolean;
    command: string;
    label: string;
    state: ResponseTypes.IntegrationState;
    target: ResponseTypes.IntegrationTarget;
  };
  export type IntegrationInstallResult = { messages: Array<string> };
  export type IntegrationState = 'not_installed' | 'current' | 'outdated';
  export type IntegrationTarget =
    | 'pi'
    | 'omp'
    | 'claude'
    | 'codex'
    | 'copilot'
    | 'devin'
    | 'droid'
    | 'kimi'
    | 'opencode'
    | 'kilo'
    | 'hermes'
    | 'qodercli'
    | 'qwen'
    | 'cursor'
    | 'mastracode'
    | 'antigravity_cli'
    | 'grok';
  export type IntegrationUninstallResult = { messages: Array<string> };
  export type LayoutDescription = {
    focused_pane_id: string;
    root: ResponseTypes.LayoutNode;
    tab_id: string;
    workspace_id: string;
    zoomed: boolean;
  };
  export type LayoutNode =
    | {
        command?: Array<string> | null;
        cwd?: string | null;
        env?: { [key: string]: string };
        label?: string | null;
        pane_id?: string | null;
        type: 'pane';
      }
    | {
        direction: ResponseTypes.SplitDirection;
        first: ResponseTypes.LayoutNode;
        ratio: number;
        second: ResponseTypes.LayoutNode;
        type: 'split';
      };
  export type NotificationShowReason =
    'shown' | 'disabled' | 'rate_limited' | 'no_foreground_client' | 'busy';
  export type PaneDirection = 'left' | 'right' | 'up' | 'down';
  export type PaneEdgesResult = {
    down: boolean;
    layout: ResponseTypes.PaneLayoutSnapshot;
    left: boolean;
    pane_id: string;
    right: boolean;
    up: boolean;
  };
  export type PaneFocusDirectionReason = 'no_neighbor';
  export type PaneFocusDirectionResult = {
    changed: boolean;
    focused_pane_id?: string | null;
    layout: ResponseTypes.PaneLayoutSnapshot;
    reason?: ResponseTypes.PaneFocusDirectionReason | null;
    source_pane_id: string;
  };
  export type PaneInfo = {
    agent?: string | null;
    agent_session?: ResponseTypes.AgentSessionInfo | null;
    agent_status: ResponseTypes.AgentStatus;
    cwd?: string | null;
    display_agent?: string | null;
    focused: boolean;
    foreground_cwd?: string | null;
    label?: string | null;
    pane_id: string;
    revision: number;
    scroll?: ResponseTypes.PaneScrollInfo | null;
    state_labels?: { [key: string]: string };
    tab_id: string;
    terminal_id: string;
    terminal_title?: string | null;
    terminal_title_stripped?: string | null;
    title?: string | null;
    tokens?: { [key: string]: string };
    workspace_id: string;
  };
  export type PaneLayoutPane = {
    focused: boolean;
    pane_id: string;
    rect: ResponseTypes.PaneLayoutRect;
  };
  export type PaneLayoutRect = { height: number; width: number; x: number; y: number };
  export type PaneLayoutSnapshot = {
    area: ResponseTypes.PaneLayoutRect;
    focused_pane_id: string;
    panes: Array<ResponseTypes.PaneLayoutPane>;
    splits: Array<ResponseTypes.PaneLayoutSplit>;
    tab_id: string;
    workspace_id: string;
    zoomed: boolean;
  };
  export type PaneLayoutSplit = {
    direction: ResponseTypes.SplitDirection;
    id: string;
    ratio: number;
    rect: ResponseTypes.PaneLayoutRect;
  };
  export type PaneMoveReason = 'same_tab' | 'zoomed_tab';
  export type PaneMoveResult = {
    changed: boolean;
    closed_tab_id?: string | null;
    closed_workspace_id?: string | null;
    created_tab?: ResponseTypes.TabInfo | null;
    created_workspace?: ResponseTypes.WorkspaceInfo | null;
    focused_pane_id: string;
    pane: ResponseTypes.PaneInfo;
    previous_pane_id: string;
    previous_tab_id: string;
    previous_workspace_id: string;
    reason?: ResponseTypes.PaneMoveReason | null;
    source_layout?: ResponseTypes.PaneLayoutSnapshot | null;
    target_layout: ResponseTypes.PaneLayoutSnapshot;
  };
  export type PaneNeighborResult = {
    direction: ResponseTypes.PaneDirection;
    layout: ResponseTypes.PaneLayoutSnapshot;
    neighbor_pane_id?: string | null;
    pane_id: string;
  };
  export type PaneProcessInfo = {
    foreground_process_group_id?: number | null;
    foreground_processes?: Array<ResponseTypes.PaneProcessInfoProcess>;
    pane_id: string;
    shell_pid?: number | null;
    tty?: string | null;
  };
  export type PaneProcessInfoProcess = {
    argv?: Array<string> | null;
    argv0?: string | null;
    cmdline?: string | null;
    cwd?: string | null;
    name: string;
    pid: number;
  };
  export type PaneReadResult = {
    format: ResponseTypes.ReadFormat;
    pane_id: string;
    revision: number;
    source: ResponseTypes.ReadSource;
    tab_id: string;
    text: string;
    truncated: boolean;
    workspace_id: string;
  };
  export type PaneResizeReason = 'unchanged';
  export type PaneResizeResult = {
    changed: boolean;
    focused_pane_id: string;
    layout: ResponseTypes.PaneLayoutSnapshot;
    pane_id: string;
    reason?: ResponseTypes.PaneResizeReason | null;
  };
  export type PaneScrollInfo = {
    max_offset_from_bottom: number;
    offset_from_bottom: number;
    viewport_rows: number;
  };
  export type PaneSwapReason = 'no_neighbor' | 'same_pane' | 'not_found' | 'cross_tab';
  export type PaneSwapResult = {
    changed: boolean;
    focused_pane_id: string;
    layout: ResponseTypes.PaneLayoutSnapshot;
    reason?: ResponseTypes.PaneSwapReason | null;
    source_pane_id: string;
    target_pane_id?: string | null;
  };
  export type PaneTextPoint = { col: number; row: number };
  export type PaneTextRange = {
    end: ResponseTypes.PaneTextPoint;
    start: ResponseTypes.PaneTextPoint;
  };
  export type PaneZoomReason = 'single_pane' | 'already_zoomed' | 'already_unzoomed';
  export type PaneZoomResult = {
    changed: boolean;
    focus_changed: boolean;
    focused_pane_id: string;
    layout: ResponseTypes.PaneLayoutSnapshot;
    pane_id: string;
    reason?: ResponseTypes.PaneZoomReason | null;
    zoom_changed: boolean;
    zoomed: boolean;
  };
  export type PluginActionContext = 'global' | 'workspace' | 'tab' | 'pane' | 'selection';
  export type PluginActionInfo = {
    action_id: string;
    command: Array<string>;
    contexts?: Array<ResponseTypes.PluginActionContext>;
    description?: string | null;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
    plugin_id: string;
    title: string;
  };
  export type PluginCommandLogInfo = {
    action_id?: string | null;
    command: Array<string>;
    error?: string | null;
    event?: string | null;
    exit_code?: number | null;
    finished_unix_ms?: number | null;
    log_id: string;
    plugin_id: string;
    started_unix_ms: number;
    status: ResponseTypes.PluginCommandStatus;
    stderr?: string | null;
    stdout?: string | null;
  };
  export type PluginCommandStatus = 'running' | 'succeeded' | 'failed';
  export type PluginInvocationContext = {
    clicked_url?: string | null;
    correlation_id?: string | null;
    focused_pane_agent?: string | null;
    focused_pane_cwd?: string | null;
    focused_pane_id?: string | null;
    focused_pane_status?: ResponseTypes.AgentStatus | null;
    invocation_source?: string | null;
    link_handler_id?: string | null;
    selected_text?: string | null;
    tab_id?: string | null;
    tab_label?: string | null;
    workspace_cwd?: string | null;
    workspace_id?: string | null;
    workspace_label?: string | null;
    worktree?: ResponseTypes.WorkspaceWorktreeInfo | null;
  };
  export type PluginManifestAction = {
    command: Array<string>;
    contexts?: Array<ResponseTypes.PluginActionContext>;
    description?: string | null;
    id: string;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
    title: string;
  };
  export type PluginManifestBuild = {
    command: Array<string>;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
  };
  export type PluginManifestEventHook = {
    command: Array<string>;
    on: string;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
  };
  export type PluginManifestLinkHandler = {
    action: string;
    id: string;
    pattern: string;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
    title: string;
  };
  export type PluginManifestPane = {
    command: Array<string>;
    description?: string | null;
    height?: ResponseTypes.PopupSize | null;
    id: string;
    placement?: ResponseTypes.PluginPanePlacement;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
    title: string;
    width?: ResponseTypes.PopupSize | null;
  };
  export type PluginManifestStartup = {
    command: Array<string>;
    platforms?: Array<ResponseTypes.PluginPlatform> | null;
  };
  export type PluginPaneInfo = {
    entrypoint: string;
    pane: ResponseTypes.PaneInfo;
    plugin_id: string;
  };
  export type PluginPanePlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed';
  export type PluginPlatform = 'linux' | 'macos' | 'windows';
  export type PluginSourceInfo = {
    installed_unix_ms?: number | null;
    kind?: ResponseTypes.PluginSourceKind;
    managed_path?: string | null;
    owner?: string | null;
    repo?: string | null;
    requested_ref?: string | null;
    resolved_commit?: string | null;
    subdir?: string | null;
  };
  export type PluginSourceKind = 'local' | 'github';
  export type PopupSize = number | string;
  export type ReadFormat = 'text' | 'ansi';
  export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
  export type ResponseResult =
    | {
        capabilities?: ResponseTypes.ServerCapabilities | null;
        protocol: number;
        type: 'pong';
        version: string;
      }
    | { snapshot: ResponseTypes.SessionSnapshot; type: 'session_snapshot' }
    | { type: 'workspace_info'; workspace: ResponseTypes.WorkspaceInfo }
    | {
        root_pane: ResponseTypes.PaneInfo;
        tab: ResponseTypes.TabInfo;
        type: 'workspace_created';
        workspace: ResponseTypes.WorkspaceInfo;
      }
    | { type: 'workspace_list'; workspaces: Array<ResponseTypes.WorkspaceInfo> }
    | {
        source: ResponseTypes.WorktreeSourceInfo;
        type: 'worktree_list';
        worktrees: Array<ResponseTypes.WorktreeInfo>;
      }
    | {
        root_pane: ResponseTypes.PaneInfo;
        tab: ResponseTypes.TabInfo;
        type: 'worktree_created';
        workspace: ResponseTypes.WorkspaceInfo;
        worktree: ResponseTypes.WorktreeInfo;
      }
    | {
        already_open: boolean;
        root_pane: ResponseTypes.PaneInfo;
        tab: ResponseTypes.TabInfo;
        type: 'worktree_opened';
        workspace: ResponseTypes.WorkspaceInfo;
        worktree: ResponseTypes.WorktreeInfo;
      }
    | { forced: boolean; path: string; type: 'worktree_removed'; workspace_id: string }
    | { tab: ResponseTypes.TabInfo; type: 'tab_info' }
    | { root_pane: ResponseTypes.PaneInfo; tab: ResponseTypes.TabInfo; type: 'tab_created' }
    | { tabs: Array<ResponseTypes.TabInfo>; type: 'tab_list' }
    | { agent: ResponseTypes.AgentInfo; type: 'agent_info' }
    | { agent: ResponseTypes.AgentInfo; argv: Array<string>; type: 'agent_started' }
    | { agent: ResponseTypes.AgentInfo; type: 'agent_prompted' }
    | { agents: Array<ResponseTypes.AgentInfo>; type: 'agent_list' }
    | { active: boolean; label?: string | null; source?: string | null; type: 'agent_view' }
    | { pane: ResponseTypes.PaneInfo; type: 'pane_info' }
    | { panes: Array<ResponseTypes.PaneInfo>; type: 'pane_list' }
    | { pane: ResponseTypes.PaneInfo; type: 'pane_current' }
    | { swap: ResponseTypes.PaneSwapResult; type: 'pane_swap' }
    | { move_result: ResponseTypes.PaneMoveResult; type: 'pane_move' }
    | { type: 'pane_zoom'; zoom: ResponseTypes.PaneZoomResult }
    | { layout: ResponseTypes.PaneLayoutSnapshot; type: 'pane_layout' }
    | { process_info: ResponseTypes.PaneProcessInfo; type: 'pane_process_info' }
    | { layout: ResponseTypes.LayoutDescription; type: 'layout_export' }
    | { layout: ResponseTypes.LayoutDescription; type: 'layout_apply' }
    | { layout: ResponseTypes.LayoutDescription; type: 'layout_split_ratio_set' }
    | { neighbor: ResponseTypes.PaneNeighborResult; type: 'pane_neighbor' }
    | { edges: ResponseTypes.PaneEdgesResult; type: 'pane_edges' }
    | { focus: ResponseTypes.PaneFocusDirectionResult; type: 'pane_focus_direction' }
    | { resize: ResponseTypes.PaneResizeResult; type: 'pane_resize' }
    | { read: ResponseTypes.PaneReadResult; type: 'pane_read' }
    | { pane_id: string; text: string; type: 'pane_selection' }
    | {
        content_revision: number;
        cursor: ResponseTypes.PaneTextPoint;
        pane_id: string;
        type: 'pane_copy_motion';
      }
    | {
        content_revision: number;
        current?: number | null;
        current_global?: number | null;
        matches: Array<ResponseTypes.PaneTextRange>;
        pane_id: string;
        total: number;
        type: 'pane_copy_search';
      }
    | { revision: number; sequence: number; type: 'pane_graphics_frame_ack' }
    | {
        cell_height_px: number;
        cell_width_px: number;
        /** Accepts damage metadata while still consuming a complete canonical file. */
        file_frame_damage?: boolean;
        file_frame_direct_max_bytes?: number | null;
        file_frame_directory?: string | null;
        file_frame_formats?: Array<string>;
        file_frame_max_bytes?: number | null;
        file_frame_transport?: string | null;
        max_layers_per_pane?: number;
        /** True only when this pane is on the currently rendered terminal surface. */
        pane_visible: boolean;
        pixel_mouse?: boolean;
        type: 'pane_graphics_info';
      }
    | { explain: unknown; type: 'agent_explain' }
    | { type: 'subscription_started' }
    | { event: ResponseTypes.EventEnvelope; type: 'wait_matched' }
    | {
        matched_line?: string | null;
        pane_id: string;
        read: ResponseTypes.PaneReadResult;
        revision: number;
        type: 'output_matched';
      }
    | { reason: ResponseTypes.NotificationShowReason; shown: boolean; type: 'notification_show' }
    | {
        changed: boolean;
        reason: ResponseTypes.ClientWindowTitleReason;
        type: 'client_window_title';
      }
    | { integrations: Array<ResponseTypes.IntegrationInfo>; type: 'integration_list' }
    | {
        details: ResponseTypes.IntegrationInstallResult;
        target: ResponseTypes.IntegrationTarget;
        type: 'integration_install';
      }
    | {
        details: ResponseTypes.IntegrationUninstallResult;
        target: ResponseTypes.IntegrationTarget;
        type: 'integration_uninstall';
      }
    | { manifests: Array<ResponseTypes.AgentManifestInfo>; type: 'agent_manifest_reload' }
    | {
        last_check_unix?: number | null;
        last_result?: string | null;
        manifests: Array<ResponseTypes.AgentManifestInfo>;
        type: 'agent_manifest_status';
      }
    | { plugin: ResponseTypes.InstalledPluginInfo; type: 'plugin_linked' }
    | { plugins: Array<ResponseTypes.InstalledPluginInfo>; type: 'plugin_list' }
    | { plugin_id: string; removed: boolean; type: 'plugin_unlinked' }
    | { plugin: ResponseTypes.InstalledPluginInfo; type: 'plugin_enabled' }
    | { plugin: ResponseTypes.InstalledPluginInfo; type: 'plugin_disabled' }
    | { actions: Array<ResponseTypes.PluginActionInfo>; type: 'plugin_action_list' }
    | {
        action: ResponseTypes.PluginActionInfo;
        context: ResponseTypes.PluginInvocationContext;
        log: ResponseTypes.PluginCommandLogInfo;
        type: 'plugin_action_invoked';
      }
    | { handled: boolean; type: 'pane_link_activated'; url?: string | null }
    | { logs: Array<ResponseTypes.PluginCommandLogInfo>; type: 'plugin_log_list' }
    | { plugin_pane: ResponseTypes.PluginPaneInfo; type: 'plugin_pane_opened' }
    | { plugin_pane: ResponseTypes.PluginPaneInfo; type: 'plugin_pane_focused' }
    | { pane_id: string; type: 'plugin_pane_closed' }
    | {
        diagnostics: Array<string>;
        status: ResponseTypes.ConfigReloadStatus;
        type: 'config_reload';
      }
    | { active: boolean; projection_revision: number; type: 'client_shell_surface_set' }
    | { type: 'ok' };
  export type ServerCapabilities = {
    detached_server_daemon?: boolean;
    /** Stable client-owned endpoint generation supported by this server. */
    endpoint_protocol_generation?: number | null;
    /** Whether this server supports endpoint health probes. */
    health_check?: boolean;
    live_handoff: boolean;
    /** Whether this server supports explicit client-shell surface interest. */
    surface_interest?: boolean;
  };
  export type SessionSnapshot = {
    agents: Array<ResponseTypes.AgentInfo>;
    focused_pane_id?: string | null;
    focused_tab_id?: string | null;
    focused_workspace_id?: string | null;
    layouts: Array<ResponseTypes.PaneLayoutSnapshot>;
    panes: Array<ResponseTypes.PaneInfo>;
    protocol: number;
    tabs: Array<ResponseTypes.TabInfo>;
    version: string;
    workspaces: Array<ResponseTypes.WorkspaceInfo>;
  };
  export type SplitDirection = 'right' | 'down';
  export type TabInfo = {
    agent_status: ResponseTypes.AgentStatus;
    focused: boolean;
    label: string;
    number: number;
    pane_count: number;
    tab_id: string;
    workspace_id: string;
  };
  export type WorkspaceInfo = {
    active_tab_id: string;
    agent_status: ResponseTypes.AgentStatus;
    focused: boolean;
    label: string;
    number: number;
    pane_count: number;
    tab_count: number;
    tokens?: { [key: string]: string };
    workspace_id: string;
    worktree?: ResponseTypes.WorkspaceWorktreeInfo | null;
  };
  export type WorkspaceWorktreeInfo = {
    checkout_path: string;
    is_linked_worktree: boolean;
    repo_key: string;
    repo_name: string;
    repo_root: string;
  };
  export type WorktreeInfo = {
    branch?: string | null;
    is_bare: boolean;
    is_detached: boolean;
    is_linked_worktree: boolean;
    is_prunable: boolean;
    label: string;
    open_workspace_id?: string | null;
    path: string;
  };
  export type WorktreeSourceInfo = {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    source_checkout_path: string;
    source_workspace_id?: string | null;
  };
}
export namespace ErrorTypes {
  export type ErrorBody = { code: string; message: string };
}
export namespace EventTypes {
  export type AgentSessionInfo = {
    agent: string;
    kind: EventTypes.AgentSessionRefKind;
    source: string;
    value: string;
  };
  export type AgentSessionRefKind = 'id' | 'path';
  export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  export type EventData =
    | { type: 'workspace_created'; workspace: EventTypes.WorkspaceInfo }
    | { type: 'workspace_updated'; workspace: EventTypes.WorkspaceInfo }
    | { type: 'workspace_metadata_updated'; workspace: EventTypes.WorkspaceInfo }
    | {
        type: 'workspace_closed';
        workspace?: EventTypes.WorkspaceInfo | null;
        workspace_id: string;
      }
    | { label: string; type: 'workspace_renamed'; workspace_id: string }
    | {
        insert_index: number;
        type: 'workspace_moved';
        workspace_id: string;
        workspaces: Array<EventTypes.WorkspaceInfo>;
      }
    | {
        before_workspace_id?: string | null;
        type: 'workspace_reordered';
        workspace_ids: Array<string>;
        workspaces: Array<EventTypes.WorkspaceInfo>;
      }
    | { type: 'workspace_focused'; workspace_id: string }
    | {
        type: 'worktree_created';
        workspace: EventTypes.WorkspaceInfo;
        worktree: EventTypes.WorktreeInfo;
      }
    | {
        already_open: boolean;
        type: 'worktree_opened';
        workspace: EventTypes.WorkspaceInfo;
        worktree: EventTypes.WorktreeInfo;
      }
    | {
        forced: boolean;
        type: 'worktree_removed';
        workspace?: EventTypes.WorkspaceInfo | null;
        workspace_id: string;
        worktree: EventTypes.WorktreeInfo;
      }
    | { tab: EventTypes.TabInfo; type: 'tab_created' }
    | { tab_id: string; type: 'tab_closed'; workspace_id: string }
    | { label: string; tab_id: string; type: 'tab_renamed'; workspace_id: string }
    | {
        insert_index: number;
        tab_id: string;
        tabs: Array<EventTypes.TabInfo>;
        type: 'tab_moved';
        workspace_id: string;
      }
    | { tab_id: string; type: 'tab_focused'; workspace_id: string }
    | { pane: EventTypes.PaneInfo; type: 'pane_created' }
    | { pane_id: string; type: 'pane_closed'; workspace_id: string }
    | { pane: EventTypes.PaneInfo; type: 'pane_updated' }
    | { pane_id: string; type: 'pane_focused'; workspace_id: string }
    | {
        closed_tab_id?: string | null;
        closed_workspace_id?: string | null;
        created_tab?: EventTypes.TabInfo | null;
        created_workspace?: EventTypes.WorkspaceInfo | null;
        pane: EventTypes.PaneInfo;
        previous_pane_id: string;
        previous_tab_id: string;
        previous_workspace_id: string;
        type: 'pane_moved';
      }
    | { pane_id: string; revision: number; type: 'pane_output_changed'; workspace_id: string }
    | { pane_id: string; type: 'pane_exited'; workspace_id: string }
    | {
        agent?: string | null;
        final_status?: EventTypes.AgentStatus | null;
        pane_id: string;
        released?: boolean;
        type: 'pane_agent_detected';
        workspace_id: string;
      }
    | {
        agent?: string | null;
        agent_status: EventTypes.AgentStatus;
        display_agent?: string | null;
        pane_id: string;
        state_labels?: { [key: string]: string };
        title?: string | null;
        type: 'pane_agent_status_changed';
        workspace_id: string;
      }
    | { layout: EventTypes.PaneLayoutSnapshot; type: 'layout_updated' };
  export type EventKind =
    | 'workspace_created'
    | 'workspace_updated'
    | 'workspace_metadata_updated'
    | 'workspace_closed'
    | 'workspace_renamed'
    | 'workspace_moved'
    | 'workspace_reordered'
    | 'workspace_focused'
    | 'worktree_created'
    | 'worktree_opened'
    | 'worktree_removed'
    | 'tab_created'
    | 'tab_closed'
    | 'tab_renamed'
    | 'tab_moved'
    | 'tab_focused'
    | 'pane_created'
    | 'pane_closed'
    | 'pane_updated'
    | 'pane_focused'
    | 'pane_moved'
    | 'pane_output_changed'
    | 'pane_exited'
    | 'pane_agent_detected'
    | 'pane_agent_status_changed'
    | 'layout_updated';
  export type PaneInfo = {
    agent?: string | null;
    agent_session?: EventTypes.AgentSessionInfo | null;
    agent_status: EventTypes.AgentStatus;
    cwd?: string | null;
    display_agent?: string | null;
    focused: boolean;
    foreground_cwd?: string | null;
    label?: string | null;
    pane_id: string;
    revision: number;
    scroll?: EventTypes.PaneScrollInfo | null;
    state_labels?: { [key: string]: string };
    tab_id: string;
    terminal_id: string;
    terminal_title?: string | null;
    terminal_title_stripped?: string | null;
    title?: string | null;
    tokens?: { [key: string]: string };
    workspace_id: string;
  };
  export type PaneLayoutPane = {
    focused: boolean;
    pane_id: string;
    rect: EventTypes.PaneLayoutRect;
  };
  export type PaneLayoutRect = { height: number; width: number; x: number; y: number };
  export type PaneLayoutSnapshot = {
    area: EventTypes.PaneLayoutRect;
    focused_pane_id: string;
    panes: Array<EventTypes.PaneLayoutPane>;
    splits: Array<EventTypes.PaneLayoutSplit>;
    tab_id: string;
    workspace_id: string;
    zoomed: boolean;
  };
  export type PaneLayoutSplit = {
    direction: EventTypes.SplitDirection;
    id: string;
    ratio: number;
    rect: EventTypes.PaneLayoutRect;
  };
  export type PaneScrollInfo = {
    max_offset_from_bottom: number;
    offset_from_bottom: number;
    viewport_rows: number;
  };
  export type SplitDirection = 'right' | 'down';
  export type TabInfo = {
    agent_status: EventTypes.AgentStatus;
    focused: boolean;
    label: string;
    number: number;
    pane_count: number;
    tab_id: string;
    workspace_id: string;
  };
  export type WorkspaceInfo = {
    active_tab_id: string;
    agent_status: EventTypes.AgentStatus;
    focused: boolean;
    label: string;
    number: number;
    pane_count: number;
    tab_count: number;
    tokens?: { [key: string]: string };
    workspace_id: string;
    worktree?: EventTypes.WorkspaceWorktreeInfo | null;
  };
  export type WorkspaceWorktreeInfo = {
    checkout_path: string;
    is_linked_worktree: boolean;
    repo_key: string;
    repo_name: string;
    repo_root: string;
  };
  export type WorktreeInfo = {
    branch?: string | null;
    is_bare: boolean;
    is_detached: boolean;
    is_linked_worktree: boolean;
    is_prunable: boolean;
    label: string;
    open_workspace_id?: string | null;
    path: string;
  };
}
export namespace SubscriptionTypes {
  export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  export type PaneAgentStatusChangedEvent = {
    agent?: string | null;
    agent_status: SubscriptionTypes.AgentStatus;
    display_agent?: string | null;
    pane_id: string;
    state_labels?: { [key: string]: string };
    title?: string | null;
    workspace_id: string;
  };
  export type PaneOutputMatchedEvent = {
    matched_line: string;
    pane_id: string;
    read: SubscriptionTypes.PaneReadResult;
  };
  export type PaneReadResult = {
    format: SubscriptionTypes.ReadFormat;
    pane_id: string;
    revision: number;
    source: SubscriptionTypes.ReadSource;
    tab_id: string;
    text: string;
    truncated: boolean;
    workspace_id: string;
  };
  export type PaneScrollChangedEvent = {
    pane_id: string;
    scroll: SubscriptionTypes.PaneScrollInfo;
    workspace_id: string;
  };
  export type PaneScrollInfo = {
    max_offset_from_bottom: number;
    offset_from_bottom: number;
    viewport_rows: number;
  };
  export type ReadFormat = 'text' | 'ansi';
  export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
  export type SubscriptionEventData =
    | SubscriptionTypes.PaneOutputMatchedEvent
    | SubscriptionTypes.PaneAgentStatusChangedEvent
    | SubscriptionTypes.PaneScrollChangedEvent;
  export type SubscriptionEventKind =
    'pane.output_matched' | 'pane.agent_status_changed' | 'pane.scroll_changed';
}
export interface HerdrParams {
  ping: RequestTypes.PingParams;
  'server.stop': RequestTypes.EmptyParams;
  'server.live_handoff': RequestTypes.ServerLiveHandoffParams;
  'server.reload_config': RequestTypes.EmptyParams;
  'server.agent_manifests': RequestTypes.EmptyParams;
  'server.reload_agent_manifests': RequestTypes.EmptyParams;
  'notification.show': RequestTypes.NotificationShowParams;
  'product_announcement.dismiss': RequestTypes.ProductAnnouncementDismissParams;
  'release_notes.dismiss': RequestTypes.ReleaseNotesDismissParams;
  'command.invoke': RequestTypes.CommandInvokeParams;
  'client.window_title.set': RequestTypes.ClientWindowTitleSetParams;
  'client.window_title.clear': RequestTypes.EmptyParams;
  'client_shell.surface.set': RequestTypes.ClientShellSurfaceSetParams;
  'session.snapshot': RequestTypes.EmptyParams;
  'workspace.create': RequestTypes.WorkspaceCreateParams;
  'workspace.list': RequestTypes.EmptyParams;
  'workspace.get': RequestTypes.WorkspaceTarget;
  'workspace.focus': RequestTypes.WorkspaceTarget;
  'workspace.rename': RequestTypes.WorkspaceRenameParams;
  'workspace.move': RequestTypes.WorkspaceMoveParams;
  'workspace.move_block': RequestTypes.WorkspaceMoveBlockParams;
  'workspace.report_metadata': RequestTypes.WorkspaceReportMetadataParams;
  'workspace.close': RequestTypes.WorkspaceCloseParams;
  'worktree.list': RequestTypes.WorktreeListParams;
  'worktree.create': RequestTypes.WorktreeCreateParams;
  'worktree.open': RequestTypes.WorktreeOpenParams;
  'worktree.remove': RequestTypes.WorktreeRemoveParams;
  'tab.create': RequestTypes.TabCreateParams;
  'tab.list': RequestTypes.TabListParams;
  'tab.get': RequestTypes.TabTarget;
  'tab.focus': RequestTypes.TabTarget;
  'tab.rename': RequestTypes.TabRenameParams;
  'tab.move': RequestTypes.TabMoveParams;
  'tab.close': RequestTypes.TabTarget;
  'agent.list': RequestTypes.EmptyParams;
  'agent.get': RequestTypes.AgentTarget;
  'agent.read': RequestTypes.AgentReadParams;
  'agent.explain': RequestTypes.AgentTarget;
  'agent.send_keys': RequestTypes.AgentSendKeysParams;
  'agent.rename': RequestTypes.AgentRenameParams;
  'agent.view.set': RequestTypes.AgentViewSetParams;
  'agent.view.clear': RequestTypes.AgentViewClearParams;
  'agent.focus': RequestTypes.AgentTarget;
  'agent.start': RequestTypes.AgentStartParams;
  'agent.prompt': RequestTypes.AgentPromptParams;
  'agent.wait': RequestTypes.AgentWaitParams;
  'pane.split': RequestTypes.PaneSplitParams;
  'pane.swap': RequestTypes.PaneSwapParams;
  'pane.move': RequestTypes.PaneMoveParams;
  'pane.zoom': RequestTypes.PaneZoomParams;
  'pane.layout': RequestTypes.PaneLayoutParams;
  'pane.process_info': RequestTypes.PaneProcessInfoParams;
  'layout.export': RequestTypes.LayoutExportParams;
  'layout.apply': RequestTypes.LayoutApplyParams;
  'layout.set_split_ratio': RequestTypes.LayoutSetSplitRatioParams;
  'pane.neighbor': RequestTypes.PaneNeighborParams;
  'pane.edges': RequestTypes.PaneEdgesParams;
  'pane.focus_direction': RequestTypes.PaneFocusDirectionParams;
  'pane.resize': RequestTypes.PaneResizeParams;
  'pane.scroll': RequestTypes.PaneScrollParams;
  'pane.edit_scrollback': RequestTypes.PaneTarget;
  'pane.selection.read': RequestTypes.PaneSelectionReadParams;
  'pane.copy_motion': RequestTypes.PaneCopyMotionParams;
  'pane.copy_search': RequestTypes.PaneCopySearchParams;
  'pane.list': RequestTypes.PaneListParams;
  'pane.current': RequestTypes.PaneCurrentParams;
  'pane.get': RequestTypes.PaneTarget;
  'pane.focus': RequestTypes.PaneTarget;
  'pane.input.set': RequestTypes.PaneInputSetParams;
  'pane.link.activate': RequestTypes.PaneLinkActivateParams;
  'pane.rename': RequestTypes.PaneRenameParams;
  'pane.send_text': RequestTypes.PaneSendTextParams;
  'pane.send_keys': RequestTypes.PaneSendKeysParams;
  'pane.send_input': RequestTypes.PaneSendInputParams;
  'pane.read': RequestTypes.PaneReadParams;
  'pane.graphics.set': RequestTypes.PaneGraphicsSetParams;
  'pane.graphics.clear': RequestTypes.PaneGraphicsClearParams;
  'pane.graphics.info': RequestTypes.PaneTarget;
  'pane.report_agent': RequestTypes.PaneReportAgentParams;
  'pane.report_agent_session': RequestTypes.PaneReportAgentSessionParams;
  'pane.report_metadata': RequestTypes.PaneReportMetadataParams;
  'pane.clear_agent_authority': RequestTypes.PaneClearAgentAuthorityParams;
  'pane.release_agent': RequestTypes.PaneReleaseAgentParams;
  'pane.close': RequestTypes.PaneTarget;
  'popup.close': RequestTypes.EmptyParams;
  'events.subscribe': RequestTypes.EventsSubscribeParams;
  'events.wait': RequestTypes.EventsWaitParams;
  'pane.wait_for_output': RequestTypes.PaneWaitForOutputParams;
  'integration.list': RequestTypes.EmptyParams;
  'integration.install': RequestTypes.IntegrationInstallParams;
  'integration.uninstall': RequestTypes.IntegrationUninstallParams;
  'plugin.link': RequestTypes.PluginLinkParams;
  'plugin.list': RequestTypes.PluginListParams;
  'plugin.unlink': RequestTypes.PluginUnlinkParams;
  'plugin.enable': RequestTypes.PluginSetEnabledParams;
  'plugin.disable': RequestTypes.PluginSetEnabledParams;
  'plugin.action.list': RequestTypes.PluginActionListParams;
  'plugin.action.invoke': RequestTypes.PluginActionInvokeParams;
  'plugin.log.list': RequestTypes.PluginLogListParams;
  'plugin.pane.open': RequestTypes.PluginPaneOpenParams;
  'plugin.pane.focus': RequestTypes.PluginPaneFocusParams;
  'plugin.pane.close': RequestTypes.PluginPaneCloseParams;
}
export const HERDR_METHODS = [
  'ping',
  'server.stop',
  'server.live_handoff',
  'server.reload_config',
  'server.agent_manifests',
  'server.reload_agent_manifests',
  'notification.show',
  'product_announcement.dismiss',
  'release_notes.dismiss',
  'command.invoke',
  'client.window_title.set',
  'client.window_title.clear',
  'client_shell.surface.set',
  'session.snapshot',
  'workspace.create',
  'workspace.list',
  'workspace.get',
  'workspace.focus',
  'workspace.rename',
  'workspace.move',
  'workspace.move_block',
  'workspace.report_metadata',
  'workspace.close',
  'worktree.list',
  'worktree.create',
  'worktree.open',
  'worktree.remove',
  'tab.create',
  'tab.list',
  'tab.get',
  'tab.focus',
  'tab.rename',
  'tab.move',
  'tab.close',
  'agent.list',
  'agent.get',
  'agent.read',
  'agent.explain',
  'agent.send_keys',
  'agent.rename',
  'agent.view.set',
  'agent.view.clear',
  'agent.focus',
  'agent.start',
  'agent.prompt',
  'agent.wait',
  'pane.split',
  'pane.swap',
  'pane.move',
  'pane.zoom',
  'pane.layout',
  'pane.process_info',
  'layout.export',
  'layout.apply',
  'layout.set_split_ratio',
  'pane.neighbor',
  'pane.edges',
  'pane.focus_direction',
  'pane.resize',
  'pane.scroll',
  'pane.edit_scrollback',
  'pane.selection.read',
  'pane.copy_motion',
  'pane.copy_search',
  'pane.list',
  'pane.current',
  'pane.get',
  'pane.focus',
  'pane.input.set',
  'pane.link.activate',
  'pane.rename',
  'pane.send_text',
  'pane.send_keys',
  'pane.send_input',
  'pane.read',
  'pane.graphics.set',
  'pane.graphics.clear',
  'pane.graphics.info',
  'pane.report_agent',
  'pane.report_agent_session',
  'pane.report_metadata',
  'pane.clear_agent_authority',
  'pane.release_agent',
  'pane.close',
  'popup.close',
  'events.subscribe',
  'events.wait',
  'pane.wait_for_output',
  'integration.list',
  'integration.install',
  'integration.uninstall',
  'plugin.link',
  'plugin.list',
  'plugin.unlink',
  'plugin.enable',
  'plugin.disable',
  'plugin.action.list',
  'plugin.action.invoke',
  'plugin.log.list',
  'plugin.pane.open',
  'plugin.pane.focus',
  'plugin.pane.close',
] as const;
export type HerdrMethod = keyof HerdrParams;
export type HerdrResult = ResponseTypes.ResponseResult;
export type HerdrEvent =
  | { data: EventTypes.EventData; event: EventTypes.EventKind }
  | {
      data: SubscriptionTypes.SubscriptionEventData;
      event: SubscriptionTypes.SubscriptionEventKind;
    };
