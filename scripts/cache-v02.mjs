/** Opt-in synthetic acceptance probes and local provider-metric extraction. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { call } from '../dist/config.js';
const root = resolve('.runtime/v02-live'),
  state = JSON.parse(readFileSync(resolve(root, 'exercise.json'), 'utf8'));
const project = resolve(root, 'project'),
  home = resolve(root, 'state'),
  metrics = resolve(project, 'metrics');
mkdirSync(metrics, { recursive: true });
const invoke = (action, input = {}) =>
  call(home, action, { ...input, lease: JSON.parse(readFileSync(state.leasePath, 'utf8')) });
if (process.argv[2] === 'cold') {
  const output = resolve(metrics, 'cold-checkpoint.json');
  if (existsSync(output)) throw new Error('Cold probe already recorded');
  // This entire transmitted payload is synthetic test content; no project files or transcripts are sent.
  const prompt =
    'Synthetic checkpoint recovery acceptance. Do not use tools. Reply with the recovery phrase and remaining action from this test checkpoint: recovery phrase violet giraffe 29; objective verify an example invoice summarizer; decision preserve disagreement about fixed versus adaptive concurrency; remaining action confirm fractional cents with independent verification.';
  const child = spawn(
    'claude',
    [
      '--print',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--model',
      'claude-fable-5',
      '--effort',
      'high',
      prompt,
    ],
    { cwd: metrics, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '',
    err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  const code = await new Promise((r) => child.once('close', r));
  clearTimeout(timer);
  if (code !== 0) throw new Error(err.slice(-1000));
  const result = JSON.parse(out);
  if (result.is_error || !result.result.includes('violet giraffe 29'))
    throw new Error('Checkpoint recovery failed');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      session: result.session_id,
      usage: result.usage,
      cost: result.total_cost_usd,
      result: result.result,
    }),
  );
  await invoke('usage.import', {
    outcomeId: state.outcomeId,
    path: 'metrics/cold-checkpoint.json',
  });
} else {
  const folder = project.replace(/[^a-zA-Z0-9-]/g, '-'),
    session = state.leadAdapter.nativeSession;
  const rows = readFileSync(
    resolve(homedir(), '.claude/projects', folder, session + '.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const usage = rows
    .filter((x) => x.type === 'assistant' && x.message?.usage)
    .map((x) => ({
      type: x.type,
      sessionId: x.sessionId,
      timestamp: x.timestamp,
      message: { id: x.message.id, model: x.message.model, usage: x.message.usage },
    }));
  writeFileSync(
    resolve(metrics, 'lead-native.jsonl'),
    usage.map((x) => JSON.stringify(x)).join('\n') + '\n',
    { mode: 0o600 },
  );
  const imported = await invoke('usage.import', {
    outcomeId: state.outcomeId,
    path: 'metrics/lead-native.jsonl',
    waitId: state.waitId,
  });
  const unique = [...new Map(usage.map((x) => [x.message.id, x])).values()];
  const board = await invoke('project.briefing', { projectId: state.projectId });
  const report = {
    nativeSession: session,
    waits: board.waits.map((w) => ({
      id: w.id,
      state: w.state,
      createdAt: w.createdAt,
      deliveredAt: w.deliveredAt,
      elapsedSeconds: w.deliveredAt
        ? (Date.parse(w.deliveredAt) - Date.parse(w.createdAt)) / 1000
        : null,
    })),
    compactions: rows
      .filter((x) => x.type === 'system' && x.subtype === 'compact_boundary')
      .map((x) => ({ timestamp: x.timestamp, metadata: x.compactMetadata })),
    requests: unique,
    importedRecords: imported.length,
  };
  writeFileSync(resolve(metrics, 'lead-summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
