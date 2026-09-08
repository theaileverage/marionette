/** Isolated HTTP/browser fixture. Records are labeled examples, not live worker evidence. */
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
const base = resolve(import.meta.dirname, '../.runtime');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(resolve(base, 'v02-board-'));
const home = resolve(root, 'state'),
  projectRoot = resolve(root, 'project');
mkdirSync(projectRoot);
const port = 48000 + Math.floor(Math.random() * 10000);
const runtime = await serve(home, port);
await runtime.supervisor.stop(); // Browser-only illustrative records never dispatch workers.
const service = runtime.service;
const project = {
  id: 'board-validation',
  name: '0.2 Board verification fixture',
  root: projectRoot,
  session: 'isolated-board-fixture',
  socketPath: resolve(root, 'unused.sock'),
  workspaceId: 'w1',
  maxConcurrency: 3,
  agentArgs: {},
  createdAt: new Date().toISOString(),
};
service.store.put('project', project.id, project);
const { lease } = await service.invoke('lead.acquire', {
  projectId: project.id,
  owner: 'dashboard-validation',
  expectedEpoch: 0,
  reason: 'Isolated browser validation',
});
const outcome = await service.invoke('outcome.create', {
  lease,
  outcome: {
    projectId: project.id,
    key: 'fixture-outcome',
    objective: 'Deliver a traceable research recommendation',
    scope: ['.'],
    category: 'research',
    criteria: [
      {
        id: 'sources',
        description: 'Corroborate each recommendation with independent sources',
        requiredEvidence: 'Source notes and a reproducible evidence table',
      },
      {
        id: 'decision',
        description: 'Explain the chosen option and preserve material disagreements',
        requiredEvidence: 'A written synthesis with tradeoffs and unresolved questions',
      },
    ],
  },
});
async function task(title, fields = {}) {
  return service.invoke('task.submit', {
    lease,
    assignment: {
      projectId: project.id,
      outcomeId: outcome.id,
      expectedTreeRevision: service.orchestration.outcome(outcome.id).revision,
      key: title,
      title,
      kind: 'codex',
      prompt: 'Browser fixture only. No real agent execution.',
      ownership: [title.toLowerCase().replaceAll(' ', '-')],
      deferStart: true,
      checks: [{ type: 'file', path: 'evidence.md', allowUnchanged: true }],
      ...fields,
    },
  });
}
const parent = await task('Research coordinator', { ownership: ['.'], canDelegate: true });
const source = await task('Gather source evidence', { parentId: parent.id, kind: 'claude' });
const reviewer = await task('Independent critical review', {
  parentId: parent.id,
  dependencies: [source.id],
});
const repair = await task('Resolve the contradictory source', {
  parentId: parent.id,
  dependencies: [reviewer.id],
});
service.updateTask(source, {
  status: 'completed',
  receipt: {
    revision: 1,
    summary: 'Illustrative fixture: source table prepared',
    artifacts: ['evidence.md'],
    evidence: ['Browser fixture only'],
    receivedAt: new Date().toISOString(),
  },
  verification: [],
});
service.updateTask(reviewer, {
  status: 'blocked',
  waitReason: 'The sources disagree about the measurement window',
});
service.updateTask(repair, { waitReason: 'Waiting for review and an available execution slot' });
service.updateTask(parent, {
  status: 'waiting',
  waitReason: 'Waiting for children; capacity and ownership released',
});
writeFileSync(
  resolve(projectRoot, 'evidence.md'),
  'Browser fixture evidence: source table and integrated review. Not a real research claim.\n',
);
await service.invoke('lead.wait', {
  lease,
  key: 'wait-for-review',
  outcomeId: outcome.id,
  adapter: { type: 'next-message' },
  condition: { tasks: [reviewer.id], intervention: true },
});
const config = loadConfig(home);
const browserScript = `sessionStorage.setItem('marionette-token', ${JSON.stringify(config.token)}); sessionStorage.setItem('marionette-lease:${project.id}', ${JSON.stringify(JSON.stringify(lease))}); localStorage.setItem('marionette-project', ${JSON.stringify(project.id)}); location.reload();`;
writeFileSync(resolve(root, 'browser-auth.js'), browserScript, { mode: 0o600 });
writeFileSync(
  resolve(base, 'v02-board-current.json'),
  JSON.stringify({
    root,
    home,
    projectRoot,
    port,
    outcomeId: outcome.id,
    taskIds: [parent.id, source.id, reviewer.id, repair.id],
    url: `http://127.0.0.1:${port}`,
  }) + '\n',
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    root,
    url: `http://127.0.0.1:${port}`,
    authScript: resolve(root, 'browser-auth.js'),
  }),
);
