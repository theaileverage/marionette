/** Opt-in exercise against the real, isolated marionette-validation Herdr session. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { call } from '../dist/config.js';
const root = resolve(import.meta.dirname, '..'),
  home = resolve(root, '.marionette'),
  statePath = resolve(root, '.runtime/live-state.json'),
  leasePath = resolve(root, '.runtime/live-lease.json');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const state = existsSync(statePath) ? read(statePath) : {};
const stage = process.argv[2] ?? 'status';
const project = (await call(home, 'project.list')).find(
  (p) => p.session === 'marionette-validation',
);
if (!project) throw new Error('Register the isolated marionette-validation workspace first');
const cwd = resolve(root, '.runtime/workflow');
if (stage === 'start') {
  if (state.tasks)
    throw new Error(
      'This exercise already exists; inspect its status instead of duplicating workers',
    );
  const client = new Client({ name: 'marionette-live-desktop-client', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', resolve(root, 'dist/mcp.js'), '--home', home],
      stderr: 'pipe',
    }),
  );
  async function tool(name, input) {
    const response = await client.callTool({ name, arguments: input });
    if (response.isError) throw new Error(JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  }
  try {
    state.mcpTools = (await client.listTools()).tools.map((t) => t.name);
    const briefing = await tool('project_briefing', { projectId: project.id });
    const lead = await tool('lead_acquire', {
      projectId: project.id,
      owner: 'desktop-validation',
      expectedEpoch: briefing.lead?.epoch ?? 0,
      takeover: !!briefing.lead,
      reason: 'Isolated live acceptance exercise',
    });
    save(leasePath, lead.lease);
    const assignments = [
      {
        key: 'live-ledger-v1',
        title: 'Build a verified billing ledger',
        workstream: 'Backend',
        kind: 'codex',
        ownership: ['backend'],
        prompt:
          'Implement backend/ledger.mjs exporting createLedger(currency). It returns currency, balance(), deposit(amount), withdraw(amount). Reject negative/nonfinite amounts and overdrafts without changing the balance. Before implementing, submit a blocked worker report asking which currency to use, then stop and wait for the lead answer. Put the question report inside backend/. After receiving the currency, implement the ledger and run node acceptance/ledger.mjs. Never edit the acceptance tests.',
        checks: [
          { type: 'file', path: 'backend/ledger.mjs' },
          {
            type: 'command',
            command: process.execPath,
            args: ['acceptance/ledger.mjs'],
            timeoutMs: 30000,
          },
        ],
      },
      {
        key: 'live-invoice-v1',
        title: 'Design an invoice summary panel',
        workstream: 'Design',
        kind: 'claude',
        ownership: ['design'],
        prompt:
          'Build design/index.html, design/style.css and design/layout.json for an accessible responsive invoice summary panel. Use native HTML and CSS with no external dependencies. The initial density is compact, with explicit layout.json property "density": "compact". Include balance, currency, invoice history, and a usable payment details disclosure. Check the HTML and write design/notes.md explaining accessibility and responsive choices. The lead may redirect the density while you work. Put report files inside design/.',
        checks: [
          { type: 'file', path: 'design/index.html', contains: 'invoice' },
          { type: 'file', path: 'design/layout.json', contains: 'compact' },
        ],
      },
      {
        key: 'live-recovery-v1',
        title: 'Review the recovery contract',
        workstream: 'Reliability',
        kind: 'agy',
        ownership: ['review'],
        prompt:
          'Read the Marionette source files ../../src/supervisor.ts and ../../src/service.ts without editing them. Create review/checklist.md containing a focused review of restart recovery, duplicate dispatch protection, blocked worker handling, and ownership. Include concrete limitations you find and the exact sentence "Do not replay ambiguous dispatches." Make no changes outside review/. Put your report file inside review/.',
        checks: [
          {
            type: 'file',
            path: 'review/checklist.md',
            contains: 'Do not replay ambiguous dispatches.',
          },
        ],
      },
    ];
    state.tasks = [];
    state.submissionMs = [];
    for (const assignment of assignments) {
      const start = performance.now();
      const t = await tool('task_submit', {
        lease: lead.lease,
        assignment: { ...assignment, projectId: project.id, cwd, maxAttempts: 2 },
      });
      state.tasks.push({ id: t.id, title: t.title, kind: t.kind });
      state.submissionMs.push(performance.now() - start);
      save(statePath, state);
    }
    state.createdAt = new Date().toISOString();
    save(statePath, state);
    console.log(
      JSON.stringify(
        { tasks: state.tasks, submissionMs: state.submissionMs, mcpTools: state.mcpTools.length },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
} else if (stage === 'status') {
  const details = [];
  for (const t of state.tasks ?? []) {
    const v = await call(home, 'task.get', { taskId: t.id });
    details.push({
      id: t.id,
      kind: t.kind,
      status: v.task.status,
      revision: v.task.revision,
      phase: v.run?.phase,
      pane: v.run?.paneId,
      agentStatus: v.run?.lastStatus,
      error: v.task.error,
      questions: v.questions.filter((q) => !q.answeredAt),
      output: v.task.output.slice(-5000),
      receipt: v.task.receipt,
      verification: v.task.verification,
    });
  }
  console.log(JSON.stringify(details, null, 2));
} else if (stage === 'redirect') {
  const t = state.tasks.find((t) => t.kind === 'claude');
  const value = await call(home, 'task.get', { taskId: t.id });
  const result = await call(home, 'task.control', {
    lease: read(leasePath),
    taskId: t.id,
    key: 'live-density-redirect',
    type: 'redirect',
    text: 'Revise the invoice summary panel to comfortable density with generous spacing and clear typographic hierarchy. Keep the invoice history, balance and payment details disclosure responsive and accessible. Set design/layout.json to include "density": "comfortable". Include the lowercase word invoice in design/index.html. Update design/notes.md and verify the files. Only modify design/. Put reports inside design/.',
    checks: [
      { type: 'file', path: 'design/index.html', contains: 'invoice' },
      { type: 'file', path: 'design/layout.json', contains: 'comfortable' },
    ],
  });
  state.redirectFromStatus = value.task.status;
  state.redirect = result;
  save(statePath, state);
  console.log(JSON.stringify(result, null, 2));
} else if (stage === 'answer') {
  const t = state.tasks.find((t) => t.kind === 'codex');
  console.log(
    JSON.stringify(
      await call(home, 'task.control', {
        lease: read(leasePath),
        taskId: t.id,
        key: 'live-currency-answer',
        type: 'reply',
        text: 'Use INR. Implement the ledger as specified and run node acceptance/ledger.mjs. Put all reports inside backend/.',
      }),
      null,
      2,
    ),
  );
} else if (stage === 'handover') {
  const old = read(leasePath);
  const result = await call(home, 'lead.handover', {
    lease: old,
    toOwner: 'terminal-validation',
    reason: 'Taking over the same work from the terminal',
  });
  save(resolve(root, '.runtime/old-desktop-lease.json'), old);
  save(leasePath, result.lease);
  state.handover = {
    from: old.owner,
    to: result.lease.owner,
    epoch: result.lease.epoch,
    taskCount: result.briefing.tasks.length,
  };
  try {
    await call(home, 'decision.record', { lease: old, text: 'This stale mutation must fail' });
    throw new Error('Stale lease was incorrectly accepted');
  } catch (e) {
    if (!String(e).includes('stale_lead')) throw e;
    state.staleLeadRejected = true;
  }
  await call(home, 'decision.record', {
    lease: result.lease,
    text: 'Invoice density is comfortable; ledger currency is INR.',
    rationale: 'Recorded during handover while workers execute.',
  });
  save(statePath, state);
  console.log(JSON.stringify(state.handover));
} else if (stage === 'checkpoint') {
  state.beforeRestart = [];
  for (const t of state.tasks) {
    const v = await call(home, 'task.get', { taskId: t.id });
    state.beforeRestart.push({
      id: t.id,
      runId: v.run?.id,
      pane: v.run?.paneId,
      attempt: v.task.attempt,
      status: v.task.status,
    });
  }
  save(statePath, state);
  console.log(JSON.stringify(state.beforeRestart, null, 2));
} else if (stage === 'verify-restart') {
  state.afterRestart = [];
  for (const before of state.beforeRestart) {
    const v = await call(home, 'task.get', { taskId: before.id });
    if (
      v.run?.id !== before.runId ||
      v.run?.paneId !== before.pane ||
      v.task.attempt !== before.attempt
    )
      throw new Error('Restart changed worker identity or dispatched again');
    state.afterRestart.push({
      id: before.id,
      status: v.task.status,
      pane: v.run.paneId,
      attempt: v.task.attempt,
    });
  }
  state.restartIdentityPreserved = true;
  save(statePath, state);
  console.log(JSON.stringify(state.afterRestart, null, 2));
} else if (stage === 'verify') {
  const details = [];
  for (const t of state.tasks) {
    const v = await call(home, 'task.get', { taskId: t.id });
    details.push({
      kind: t.kind,
      id: t.id,
      status: v.task.status,
      revision: v.task.revision,
      verification: v.task.verification,
    });
  }
  state.final = details;
  state.finishedAt = new Date().toISOString();
  save(statePath, state);
  console.log(
    JSON.stringify(
      {
        submissionMs: state.submissionMs,
        handover: state.handover,
        staleLeadRejected: state.staleLeadRejected,
        restartIdentityPreserved: state.restartIdentityPreserved,
        results: details,
      },
      null,
      2,
    ),
  );
  if (details.some((t) => t.status !== 'completed')) process.exitCode = 1;
} else throw new Error('Unknown stage');
