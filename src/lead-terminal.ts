import { Effect, Schedule } from 'effect';
import { createHash } from 'node:crypto';
import { herdrCall, sync } from './effect-runtime.js';
import { validateTerminalArguments } from './terminal-arguments.js';
import { AppError, type HerdrPort } from './types.js';
import type { ResponseTypes } from './herdr-protocol.js';

interface TerminalLead {
  projectId: string;
  root: string;
  workspace: string;
  epoch: number;
  kind: string;
  owner: string;
  args: string[];
  guard?: {
    launchHash: string;
    receipt?: { launchHash: string; pane_id: string; terminal_id: string };
  };
}

/** Keep the shell launch short: Herdr types argv into a PTY, not an exec call. */
export function terminalLeadArgs(
  kind: string,
  modelArgs: string[],
  promptPath: string,
  guarded = false,
) {
  return [
    ...modelArgs,
    ...(kind === 'agy' ? ['--prompt-interactive'] : []),
    guarded
      ? 'The session guard supplied your full Marionette lead prompt. Read project_briefing and inbox_read.'
      : `Read the local file ${JSON.stringify(promptPath)} and follow its lead startup instructions.`,
  ];
}

/** Reuse a surviving tab only after verifying that its sole foreground process is its shell. */
export const openLeadTerminalEffect = Effect.fn('Lead.openTerminal')(function* (
  h: HerdrPort,
  lead: TerminalLead,
) {
  yield* sync('Lead.validateArguments', () => validateTerminalArguments(lead.kind, lead.args));
  const name = `lead-${createHash('sha256').update(lead.projectId).digest('hex').slice(0, 12)}-${lead.epoch}`;
  const label = `${lead.owner} [${name}]`;
  const { agents }: { agents: ResponseTypes.AgentInfo[] } = yield* herdrCall(h, 'agent.list');
  const existing = agents.find((agent) => agent.name === name);
  if (existing) {
    if (
      existing.workspace_id !== lead.workspace ||
      existing.agent !== lead.kind ||
      existing.cwd !== lead.root ||
      (lead.guard !== undefined &&
        (lead.guard.receipt?.launchHash !== lead.guard.launchHash ||
          lead.guard.receipt?.pane_id !== existing.pane_id ||
          lead.guard.receipt?.terminal_id !== existing.terminal_id))
    )
      return yield* new AppError({
        code: 'lead_identity',
        message: `Herdr agent ${name} does not match this project’s lead. Inspect it before retrying. If its launch configuration changed, exit the existing lead and relaunch it.`,
        status: 409,
      });
    yield* herdrCall(h, 'tab.focus', { tab_id: existing.tab_id });
    return { status: 'ready' as const, agent: existing };
  }
  const { tabs }: { tabs: ResponseTypes.TabInfo[] } = yield* herdrCall(h, 'tab.list', {
    workspace_id: lead.workspace,
  });
  const previous = tabs.filter((tab) => tab.label === label);
  if (previous.length > 1)
    return yield* new AppError({
      code: 'lead_identity',
      message: `Multiple tabs match ${label}. Inspect them before retrying.`,
      status: 409,
    });
  const inspect = Effect.fn('Lead.inspectPrevious')(function* () {
    yield* herdrCall(h, 'tab.focus', { tab_id: previous[0].tab_id });
    return {
      status: 'inspect' as const,
      message: `Opening the existing lead tab (${label}). Its process state could not be verified as an idle shell, so no launch command was sent. Exit the process if appropriate, then rerun marionette lead.`,
    };
  });
  let paneId: string;
  if (previous.length) {
    const tab = previous[0];
    const { panes }: { panes: ResponseTypes.PaneInfo[] } = yield* herdrCall(h, 'pane.list', {
      workspace_id: lead.workspace,
    });
    const candidates = panes.filter((pane) => pane.tab_id === tab.tab_id);
    const pane = candidates[0];
    if (
      tab.workspace_id !== lead.workspace ||
      tab.pane_count !== 1 ||
      candidates.length !== 1 ||
      pane.workspace_id !== lead.workspace ||
      pane.cwd !== lead.root ||
      pane.agent ||
      pane.display_agent
    )
      return yield* inspect();
    const info: { process_info: ResponseTypes.PaneProcessInfo } | undefined = yield* herdrCall(
      h,
      'pane.process_info',
      { pane_id: pane.pane_id },
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const process = info?.process_info;
    if (
      !process ||
      process.pane_id !== pane.pane_id ||
      !process.shell_pid ||
      process.foreground_process_group_id !== process.shell_pid ||
      !process.foreground_processes?.length ||
      !process.foreground_processes.every((item) => item.pid === process.shell_pid)
    )
      return yield* inspect();
    const current: { agents: ResponseTypes.AgentInfo[] } = yield* herdrCall(h, 'agent.list');
    if (current.agents.some((agent) => agent.pane_id === pane.pane_id || agent.name === name))
      return yield* inspect();
    paneId = pane.pane_id;
    yield* herdrCall(h, 'tab.focus', { tab_id: tab.tab_id });
  } else {
    const created: { root_pane: ResponseTypes.PaneInfo } = yield* herdrCall(h, 'tab.create', {
      workspace_id: lead.workspace,
      cwd: lead.root,
      label,
      focus: true,
    });
    paneId = created.root_pane.pane_id;
  }
  const started: { agent: ResponseTypes.AgentInfo } = yield* herdrCall(
    h,
    'agent.start',
    {
      pane_id: paneId,
      name,
      kind: lead.kind,
      args: lead.args,
      timeout_ms: 60000,
    },
    65000,
  ).pipe(
    // Herdr refuses this request before launch while the new shell is still initializing.
    Effect.retry({
      schedule: Schedule.spaced(250).pipe(Schedule.upTo({ times: 20 })),
      while: (error) => error instanceof AppError && /not an available shell/.test(error.message),
    }),
  );
  return { status: 'ready' as const, agent: started.agent };
});
