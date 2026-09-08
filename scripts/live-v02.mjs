/** Opt-in real-agent acceptance. Uses a new named Herdr session and isolated project/state. */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { runSetup } from '../dist/setup.js';
import { call } from '../dist/config.js';
import { Herdr } from '../dist/herdr.js';
const root = resolve(import.meta.dirname, '../.runtime/v02-live');
const statePath = resolve(root, 'exercise.json');
const stage = process.argv[2] ?? 'status';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
};
const state = existsSync(statePath) ? read(statePath) : {};
const home = resolve(root, 'state'),
  projectRoot = resolve(root, 'project');
const file = (path, text) => {
  mkdirSync(dirname(resolve(projectRoot, path)), { recursive: true });
  writeFileSync(resolve(projectRoot, path), text);
};
async function invoke(action, input = {}) {
  return call(home, action, { ...input, lease: read(state.leasePath) });
}
async function current() {
  return invoke('outcome.get', { outcomeId: state.outcomeId });
}
async function submit(key, fields) {
  const outcome = await current();
  const task = await invoke('task.submit', {
    assignment: {
      projectId: state.projectId,
      outcomeId: state.outcomeId,
      expectedTreeRevision: outcome.revision,
      key,
      title: key,
      kind: 'codex',
      profileId: 'astra',
      prompt: 'Override required',
      ownership: [key],
      checks: [{ type: 'file', path: key + '/result.md' }],
      ...fields,
    },
  });
  state.tasks ??= {};
  state.tasks[key] = task.id;
  save(statePath, state);
  return task;
}
if (stage === 'init') {
  if (state.projectId)
    throw new Error('Exercise already initialized; inspect rather than duplicating work');
  mkdirSync(projectRoot, { recursive: true });
  file(
    'corpus/requirements.md',
    '# Local research corpus\nA batch service handles 120 jobs/minute. Jobs take 2 seconds on average. The provider permits at most 8 concurrent requests. Interactive customers require p95 queueing below 3 seconds. Batch customers tolerate 30 seconds. The budget limits retries to 2 per job. Source A is production-like; source B is a small synthetic sample. Compare fixed concurrency 4 vs adaptive concurrency between 2 and 8. Evidence is incomplete; preserve uncertainty.\n',
  );
  file(
    'corpus/source-a.md',
    '# Source A: controlled 500-job replay\nFixed 4: p95 queue 2.4s, zero overload failures, 500 completed. Adaptive 2-8: p95 queue 1.8s, 12 overload responses, all 500 completed after retries. The replay used production-like arrival bursts.\n',
  );
  file(
    'corpus/source-b.md',
    '# Source B: synthetic 30-job replay\nFixed 4: p95 queue 4.1s, zero overload failures. Adaptive 2-8: p95 queue 1.1s, zero overload failures. Small sample, uniform arrivals, no randomized repeated trials. This is not representative production evidence.\n',
  );
  file(
    'software/money.mjs',
    'export function toCents(value) { return Math.trunc(Number(value) * 100); }\n',
  );
  file(
    'acceptance/basic.mjs',
    "import assert from 'node:assert/strict'; import { summarize } from '../software/summary.mjs'; assert.deepEqual(summarize([{sku:'a',quantity:2,price:3},{sku:'a',quantity:1,price:4}]), {a:1000}); console.log('BASIC_PASS');\n",
  );
  file(
    'acceptance/decimal.mjs',
    "import assert from 'node:assert/strict'; import { summarize } from '../software/summary.mjs'; import { toCents } from '../software/money.mjs'; assert.equal(toCents(0.29),29); assert.equal(toCents(1.15),115); assert.throws(()=>toCents(null)); assert.throws(()=>toCents(NaN)); assert.throws(()=>toCents(-1)); assert.deepEqual(summarize([{sku:'a',quantity:3,price:0.29}]),{a:87}); console.log('DECIMAL_PASS');\n",
  );
  file(
    'acceptance/nested.mjs',
    "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const a=JSON.parse(readFileSync('nested/child/result.json','utf8')); const b=JSON.parse(readFileSync('nested/integrated.json','utf8')); assert.deepEqual(a.values,[2,3,5]); assert.equal(b.total,10); assert.equal(b.childVerified,true); console.log('NESTED_PASS');\n",
  );
  await runSetup({
    project: projectRoot,
    home,
    name: 'Marionette 0.2 real acceptance',
    session: 'marionette-v02-01a07e79',
    lead: 'claude',
    leadName: 'v02-validation-lead',
    trustAgy: true,
    mcp: 'skip',
  });
  const binding = read(resolve(projectRoot, '.marionette/project.json'));
  state.projectId = binding.projectId;
  state.leasePath = binding.leasePath;
  state.runtime = binding.runtime;
  state.startedAt = new Date().toISOString();
  save(statePath, state);
  const cli = resolve(binding.runtime, 'dist/cli.js');
  await invoke('project.configure', {
    agentArgs: {
      codex: ['--approve-for-me'],
      claude: [
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        `Bash(${process.execPath} --no-warnings ${cli} worker-report *)`,
        `Bash(${process.execPath} --no-warnings ${cli} worker-call *)`,
      ],
      agy: ['--mode', 'accept-edits', '--sandbox'],
    },
  });
  const profiles = [
    {
      id: 'astra',
      name: 'Codex Astra',
      kind: 'codex',
      model: 'gpt-6-astra',
      reasoning: 'high',
      supportedReasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      categories: ['implementation', 'orchestration', 'review'],
      capabilities: ['tools', 'managed-delegation'],
      strengths:
        'Configured implementation and coordination candidate; evaluated in this exercise.',
      canDelegate: true,
      maxConcurrency: 2,
    },
    {
      id: 'fable',
      name: 'Claude Fable',
      kind: 'claude',
      model: 'claude-fable-5',
      reasoning: 'high',
      supportedReasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
      categories: ['orchestration', 'research', 'review'],
      capabilities: ['tools', 'same-session-continuation'],
      strengths: 'Configured orchestration and synthesis candidate; evaluated in this exercise.',
      canDelegate: true,
      maxConcurrency: 2,
    },
    {
      id: 'gemini',
      name: 'AGY Gemini Pro',
      kind: 'agy',
      model: 'gemini-3.1-pro-high',
      supportedReasoning: [],
      categories: ['research', 'review'],
      capabilities: ['tools'],
      strengths:
        'Configured independent research and review candidate; evaluated in this exercise.',
      canDelegate: false,
      maxConcurrency: 2,
    },
  ];
  await invoke('profile.configure', {
    profiles,
    defaults: { implementation: 'astra', orchestration: 'fable', research: 'gemini' },
  });
  for (const profile of profiles) {
    const result = await invoke('profile.validate', { profileId: profile.id });
    state.profiles ??= {};
    state.profiles[profile.id] = result;
    save(statePath, state);
    console.log(
      JSON.stringify({
        profile: profile.id,
        model: result.model,
        availability: result.availability,
        evidence: result.availabilityEvidence,
      }),
    );
    if (result.availability !== 'available')
      throw new Error('Model validation failed; no fallback selected');
  }
  await invoke('limits.configure', {
    limits: { global: 4, project: 3, providers: { codex: 2, claude: 2, agy: 2 } },
    reason: 'Bounded real acceptance, including descendants and event-driven lead turns',
  });
  const outcome = await invoke('outcome.create', {
    outcome: {
      projectId: state.projectId,
      key: 'v02-complete-lifecycle',
      objective:
        'Evaluate source evidence independently, preserve disagreement, coordinate nested work, and deliver a correct invoice summarizer with review and repair evidence',
      scope: ['.'],
      category: 'software',
      criteria: [
        {
          id: 'research',
          description:
            'Independent research and synthesis distinguish strong evidence from small-sample uncertainty',
          requiredEvidence:
            'Two real-agent source assessments and a synthesis preserving material disagreements',
        },
        {
          id: 'nested',
          description:
            'A coordinator delegates through Marionette, yields, resumes the same session and integrates a child result',
          requiredEvidence:
            'Persistent delegation tree, native run identity and passing nested integration check',
        },
        {
          id: 'software',
          description: 'Invoice totals handle fractional prices and reject invalid money inputs',
          requiredEvidence:
            'Independent review, targeted repair and passing basic and decimal acceptance commands',
        },
        {
          id: 'debate',
          description: 'A bounded debate includes independent claims and fresh rebuttal evidence',
          requiredEvidence:
            'Two rounds of verified participant results and an explicit stop decision',
        },
      ],
      maxTurns: 60,
      maxDepth: 3,
    },
  });
  state.outcomeId = outcome.id;
  save(statePath, state);
  console.log(
    JSON.stringify({ projectId: state.projectId, outcomeId: outcome.id, home, projectRoot }),
  );
} else if (stage === 'council') {
  if (state.councilId) throw new Error('Council exists; inspect it');
  const prompt = (name) =>
    `This is a real acceptance exercise in an isolated project. Read corpus/requirements.md, corpus/source-a.md and corpus/source-b.md only. Independently compare fixed concurrency 4 and adaptive concurrency 2-8 against p95 queue latency, overload/retry costs and evidence quality. Write council/${name}/assessment.md with an explicit recommendation, numeric evidence, source references and uncertainties. Do not inspect the other participant or its output. Do not make changes outside council/${name}/. Use native file tools where possible. Then submit a complete worker report citing your artifact. Do not use unrelated MCP instances.`;
  const a = await submit('council-a', {
    kind: 'claude',
    profileId: 'fable',
    canDelegate: false,
    deferStart: true,
    ownership: ['council/a'],
    prompt: prompt('a'),
    checks: [{ type: 'file', path: 'council/a/assessment.md', contains: '2.4' }],
  });
  const b = await submit('council-b', {
    kind: 'agy',
    profileId: 'gemini',
    deferStart: true,
    ownership: ['council/b'],
    prompt: prompt('b'),
    checks: [{ type: 'file', path: 'council/b/assessment.md', contains: '2.4' }],
  });
  const strategy = await invoke('strategy.create', {
    expectedRevision: (await current()).revision,
    reason: 'Independent source-quality council',
    strategy: {
      outcomeId: state.outcomeId,
      kind: 'council',
      participants: [a.id, b.id],
      criteria: 'Production evidence quality, latency target, provider capacity and retry costs',
      stopCondition:
        'Synthesize both verified initial assessments and preserve material disagreement',
      maxRounds: 1,
    },
  });
  state.councilId = strategy.id;
  save(statePath, state);
  console.log(JSON.stringify({ council: strategy.id, tasks: [a.id, b.id] }));
} else if (stage === 'nested') {
  if (state.tasks?.['nested-coordinator']) throw new Error('Nested coordinator exists; inspect it');
  const prompt = `You are the bounded coordinator for a real Marionette acceptance exercise. You own only nested/. Use Marionette worker-call (not a native agent-spawning tool) to inspect your current task and outcome. Delegate exactly one child to Claude using kind claude, profileId fable, canDelegate false, parentId your task ID, outcomeId the current outcome, expectedTreeRevision from inspect, ownership ["nested/child"], checks [{"type":"file","path":"nested/child/result.json","contains":"values"}]. Child prompt: create nested/child/result.json with {"values":[2,3,5],"status":"validated"}; use native file tools; do not edit outside nested/child; submit a complete worker report. Use a unique stable child key. After successful delegation read parentRevision from its response, report type yield with that revision and end your turn. Do not keep checking children or edit while waiting. Marionette will resume this same conversation. After resumption inspect the child result, independently verify values, write nested/integrated.json with {"total":10,"childVerified":true}, and submit a complete report for your current revision with both owned artifacts. The supervisor will run acceptance/nested.mjs independently. Never claim completion before integrating. Do not use unrelated MCP instances.`;
  const t = await submit('nested-coordinator', {
    kind: 'codex',
    profileId: 'astra',
    canDelegate: true,
    ownership: ['nested'],
    prompt,
    checks: [
      { type: 'file', path: 'nested/integrated.json' },
      { type: 'command', command: process.execPath, args: ['acceptance/nested.mjs'] },
    ],
  });
  console.log(JSON.stringify({ task: t.id }));
} else if (stage === 'software') {
  if (state.tasks?.['software-implementation']) throw new Error('Implementation exists');
  const a = await submit('software-implementation', {
    ownership: ['software/summary.mjs'],
    prompt:
      'Implement software/summary.mjs exporting summarize(lines), where each line is {sku,quantity,price}. Return an object mapping each sku to the summed integer-cent total across its lines. Import and use the existing toCents function from ./money.mjs. You own only software/summary.mjs; do not modify the existing money helper or acceptance files. Handle repeated SKUs. Run or reason through acceptance/basic.mjs, write the implementation and submit a completion report. Independent review will assess the integrated behavior.',
    checks: [
      { type: 'file', path: 'software/summary.mjs' },
      { type: 'command', command: process.execPath, args: ['acceptance/basic.mjs'] },
    ],
  });
  const b = await submit('software-review', {
    kind: 'agy',
    profileId: 'gemini',
    ownership: ['review'],
    dependencies: [a.id],
    prompt:
      'Independently review software/summary.mjs together with software/money.mjs. The complete outcome requires correct fractional cents and rejection of null, NaN and negative money values. Investigate toCents(0.29) and toCents(1.15), the acceptance/decimal.mjs contract, and the current source. Write review/findings.md with concrete defects, numerical reproductions and a minimal targeted repair recommendation. Do not edit software or acceptance. You own only review/. Submit your reviewed artifact as completion evidence. Do not use unrelated MCP instances.',
    checks: [{ type: 'file', path: 'review/findings.md', contains: '0.29' }],
  });
  console.log(JSON.stringify({ implementation: a.id, review: b.id }));
} else if (stage === 'reconcile-review') {
  const { task } = await invoke('task.get', { taskId: state.tasks['software-review'] });
  if (task.status !== 'uncertain') throw new Error('Expected inspected uncertain review');
  await invoke('task.reconcile', {
    taskId: task.id,
    resolution: 'not-delivered',
    reason:
      'Inspected exact original AGY pane and terminal: settled at Interrupted with empty input; acknowledged guidance never appeared or began work. Preserve original session and findings.',
  });
  const fresh = (await invoke('task.get', { taskId: task.id })).task;
  const prompt =
    'Finish this leaf review now. Your review/findings.md already contains the actual required defect analysis. Do not inspect parentRevision or run more investigation. Write your own complete worker-report JSON for the current revision with summary, evidence and artifact review/findings.md into .marionette-reports/' +
    task.id +
    '/complete.json. Submit using your original provided worker-report CLI with normal command approval if required. Then end your turn. Do not edit software or acceptance files.';
  const updated = await invoke('plan.revise', {
    taskId: task.id,
    expectedRevision: fresh.revision,
    expectedTreeRevision: (await current()).revision,
    reason:
      'Recover definitively unobserved continuation after native interruption cleared; retain independent review and original session',
    evidence: ['review/findings.md'],
    patch: { prompt },
  });
  await invoke('task.control', {
    taskId: task.id,
    expectedRevision: updated.revision,
    key: 'review-reconciled-report-only',
    type: 'reply',
    text: prompt,
  });
} else if (stage === 'finish-review') {
  const { task } = await invoke('task.get', { taskId: state.tasks['software-review'] });
  await invoke('task.control', {
    taskId: task.id,
    expectedRevision: task.revision,
    key: 'review-report-guidance',
    type: 'reply',
    text:
      'Your review/findings.md already contains the required independent defect analysis. You are a leaf reviewer, not a delegated coordinator; do not look for parentRevision or spawn children. Use the current revision from this message. Write a complete worker report containing the actual findings, artifact review/findings.md and numeric reproductions you observed. Submit it using the provided worker-report CLI and normal permission escalation if needed, then end your turn. Do not run further inspection loops or change software. Report JSON belongs in .marionette-reports/' +
      task.id +
      '/.',
  });
} else if (stage === 'repair') {
  if (state.tasks?.['software-repair']) throw new Error('Repair exists');
  const review = await invoke('task.get', { taskId: state.tasks['software-review'] });
  if (review.task.status !== 'completed') throw new Error('Wait for independently verified review');
  const a = await submit('software-repair', {
    ownership: ['software/money.mjs'],
    dependencies: [review.task.id],
    planReason: 'Independent review found fractional-cent and invalid-input defects',
    prompt:
      'Read review/findings.md and acceptance/decimal.mjs. Repair software/money.mjs so toCents preserves two-decimal currency amounts such as 0.29 and 1.15 and rejects null, nonnumeric, nonfinite and negative values. Keep the named export toCents. You own only software/money.mjs; do not change summary.mjs, review or acceptance. Run the available checks if permitted, then report the actual change and artifact; the supervisor independently runs basic and decimal tests.',
    checks: [
      { type: 'file', path: 'software/money.mjs' },
      { type: 'command', command: process.execPath, args: ['acceptance/basic.mjs'] },
      { type: 'command', command: process.execPath, args: ['acceptance/decimal.mjs'] },
    ],
  });
  const b = await submit('software-reverification', {
    kind: 'claude',
    profileId: 'fable',
    canDelegate: false,
    ownership: ['verification'],
    dependencies: [a.id],
    prompt:
      'Independently re-review the repaired software/money.mjs and software/summary.mjs against acceptance/basic.mjs and acceptance/decimal.mjs. You own only verification/. Write verification/result.md describing whether the integrated result meets the integer and fractional cents contract, with concrete expected values and any unresolved defect. Do not edit software or tests. Submit a completion report with your evaluation. The supervisor independently reruns both acceptance commands.',
    checks: [
      { type: 'file', path: 'verification/result.md' },
      { type: 'command', command: process.execPath, args: ['acceptance/basic.mjs'] },
      { type: 'command', command: process.execPath, args: ['acceptance/decimal.mjs'] },
    ],
  });
  console.log(JSON.stringify({ repair: a.id, reverification: b.id }));
} else if (stage === 'complete-outcome') {
  const o = await current();
  if (o.status === 'completed') throw new Error('Outcome already completed');
  const assessments = [
    [
      'research',
      'Both independent source assessments and Fable synthesis were checked against the corpus. The lead decision explicitly corrects unsupported per-job retry and zero-retry claims while preserving policy disagreement.',
      [
        'corpus/requirements.md',
        'corpus/source-a.md',
        'corpus/source-b.md',
        'council/a/assessment.md',
        'council/b/assessment.md',
        'council/synthesis/result.md',
        'lead/decision.md',
      ],
    ],
    [
      'nested',
      'The Codex coordinator used scoped delegation, yielded its slot, resumed the original run/native session and integrated the verified child. Independent nested acceptance passed.',
      ['nested/child/result.json', 'nested/integrated.json', 'acceptance/nested.mjs'],
    ],
    [
      'software',
      'AGY independently found the fractional-cent and invalid-input defects. Codex repaired only the helper; independent Fable review and supervisor basic/decimal commands passed.',
      [
        'review/findings.md',
        'software/money.mjs',
        'software/summary.mjs',
        'verification/result.md',
        'acceptance/basic.mjs',
        'acceptance/decimal.mjs',
      ],
    ],
    [
      'debate',
      'Two independent initial assessments and fresh verified rebuttal revisions completed. The strategy stopped at round two with an explicit bounded decision and preserved disagreement.',
      [
        'debate/a/round1.md',
        'debate/a/round2.md',
        'debate/b/round1.md',
        'debate/b/round2.md',
        'lead/decision.md',
      ],
    ],
  ];
  for (const [criterionId, rationale, references] of assessments)
    await invoke('outcome.assess', {
      outcomeId: o.id,
      expectedRevision: o.revision,
      criterionId,
      rationale,
      references,
    });
  await invoke('outcome.integrate', {
    outcomeId: o.id,
    expectedRevision: o.revision,
    summary:
      'All required task-tree work is independently verified. Research preserves uncertainty and corrected inference limits; debate is bounded; nested work integrated in the original parent session; targeted software repair passes independent re-verification. The proposed concurrency experiment was not executed and is not certified production evidence.',
    references: ['lead/decision.md', 'nested/integrated.json', 'verification/result.md'],
  });
  const result = await invoke('outcome.complete', {
    outcomeId: o.id,
    expectedRevision: o.revision,
  });
  save(resolve(root, 'completed-outcome.json'), result);
  console.log(
    JSON.stringify({
      status: result.outcome.status,
      revision: result.outcome.revision,
      satisfied: result.satisfied.map((c) => c.id),
    }),
  );
} else if (stage === 'finish-strategies') {
  for (const [key, names, round] of [
    ['councilId', ['council-a', 'council-b'], 1],
    ['debateId', ['debate-a', 'debate-b'], 2],
  ]) {
    let strategy = (await invoke('board.get', { projectId: state.projectId })).strategies.find(
      (s) => s.id === state[key],
    );
    if (strategy.status === 'completed') continue;
    for (const name of names) {
      const id = state.tasks[name];
      if (strategy.entries.some((e) => e.taskId === id && e.round === round)) continue;
      const path =
        round === 1
          ? 'council/' + name.slice(-1) + '/assessment.md'
          : 'debate/' + name.slice(-1) + '/round2.md';
      const contribution = {
        strategyId: strategy.id,
        expectedRevision: strategy.revision,
        taskId: id,
        claim: readFileSync(resolve(projectRoot, path), 'utf8'),
        evidence: [path],
      };
      if (round === 2)
        contribution.rebuttal = 'Fresh final-round rebuttal and concessions recorded in ' + path;
      strategy = await invoke('strategy.contribute', contribution);
    }
    const synthesis =
      round === 1
        ? 'Both independent council results and the revised synthesis are verified. Preserve adaptive latency headroom versus fixed simplicity. The lead selects a bounded instrumented experiment before an unconditional shipping recommendation. Aggregate overloads establish neither per-job retries nor cohort latency. Zero overload failures does not prove zero retries from every cause. Council synthesis remains an input with these explicit lead qualifications.'
        : 'Stop after two verified rounds. Both participants now favor a bounded paired experiment, per-job attempt logging and class-separated latency. A distinguishes stress diagnostics from nominal-load acceptance; B would let stress failures veto shipping. B still overstates an affected-job range of 6–12 without established retry-cap enforcement; the corpus permits concentration on fewer jobs. No experiment was run and no production policy is certified by this exercise.';
    await invoke('strategy.finish', {
      strategyId: strategy.id,
      expectedRevision: strategy.revision,
      synthesis,
      disagreements:
        round === 1
          ? [
              'Adaptive headroom versus fixed operational simplicity; existing measurements do not resolve production safety.',
            ]
          : [
              'Whether above-nominal stress may veto nominal-load acceptance.',
              'B retains an unsupported affected-job bound; A supplies the valid concentration counterexample.',
            ],
    });
  }
  file(
    'lead/decision.md',
    '# Reviewed collaboration decision\n\n' +
      (await invoke('board.get', { projectId: state.projectId })).strategies
        .map((s) => s.synthesis + '\n\nRemaining disagreements: ' + s.disagreements.join('; '))
        .join('\n\n') +
      '\n',
  );
} else if (stage === 'lead-state') {
  const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
    h = new Herdr(p.socketPath);
  const a = (await h.call('agent.get', { target: state.leadAdapter.paneId })).agent;
  console.log(
    JSON.stringify({
      agent: a,
      screen: (await h.call('pane.read', { pane_id: a.pane_id, source: 'visible', format: 'text' }))
        .read.text,
    }),
  );
} else if (stage === 'compact-lead') {
  if (state.compactionRequested)
    throw new Error('Compaction already requested; inspect existing operation');
  const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
    h = new Herdr(p.socketPath);
  const a = (await h.call('agent.get', { target: state.leadAdapter.paneId })).agent;
  if (
    a.terminal_id !== state.leadAdapter.terminalId ||
    a.agent_session?.value !== state.leadAdapter.nativeSession ||
    !['done', 'idle'].includes(a.agent_status)
  )
    throw new Error('Original lead must be settled');
  const checkpoint = await invoke('checkpoint.save', {
    outcomeId: state.outcomeId,
    kind: 'compaction',
    summary:
      'Real long wait resumed in original Claude session; preserve recovery phrase violet giraffe 29 and reviewed decision. Remaining work: targeted repair/reverification and final acceptance evidence.',
    decisions: ['Bounded experiment before shipping; preserve council/debate disagreements'],
    evidence: ['lead/resumed.md', 'lead/decision.md'],
  });
  state.compactionRequested = new Date().toISOString();
  state.compactionCheckpoint = checkpoint.id;
  save(statePath, state);
  await h.call(
    'agent.prompt',
    {
      target: a.pane_id,
      text: '/compact Preserve the recovery phrase violet giraffe 29 and the instruction to write lead/resumed.md with the delivery ID on Marionette event delivery. Preserve the checkpoint and evidence references.',
    },
    12000,
  );
} else if (stage === 'wait-after-compaction') {
  if (!state.compactionCheckpoint || state.compactionWait)
    throw new Error('Missing checkpoint or existing wait');
  const wait = await invoke('lead.wait', {
    key: 'after-deliberate-compaction',
    outcomeId: state.outcomeId,
    adapter: state.leadAdapter,
    profileId: 'fable',
    checkpointId: state.compactionCheckpoint,
    condition: {
      tasks: [state.tasks['software-reverification']],
      mode: 'all',
      intervention: false,
    },
  });
  state.compactionWait = wait.id;
  save(statePath, state);
  console.log(JSON.stringify({ waitId: wait.id, state: wait.state }));
} else if (stage === 'profiles') {
  for (const kind of ['codex', 'claude', 'agy']) {
    const result = await invoke('profile.discover', { kind });
    console.log(
      JSON.stringify({ kind, extracted: result.catalog.models.length, added: result.added.length }),
    );
  }
  const board = await invoke('board.get', { projectId: state.projectId });
  for (const model of [
    'gpt-5.6-luna',
    'claude-fable-5-1[1m]',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'gemini-3.8-flash-high',
  ]) {
    const p = board.profiles.find((p) => p.model === model);
    const result = await invoke('profile.validate', { profileId: p.id });
    console.log(JSON.stringify({ profile: p.id, availability: result.availability }));
  }
} else if (stage === 'synthesis') {
  if (state.tasks?.['council-synthesis']) throw new Error('Synthesis exists');
  await invoke('project.configure', {
    agentArgs: {
      codex: ['--approve-for-me'],
      claude: ['--permission-mode', 'auto'],
      agy: ['--mode', 'accept-edits', '--sandbox'],
    },
  });
  const ids = [state.tasks['council-a'], state.tasks['council-b']];
  const t = await submit('council-synthesis', {
    kind: 'claude',
    profileId: 'fable',
    ownership: ['council/synthesis'],
    dependencies: ids,
    canDelegate: false,
    prompt:
      'You are the council synthesizer. Read the three corpus files and both independent assessments council/a/assessment.md and council/b/assessment.md. Evaluate both against the original requirements. Write council/synthesis/result.md preserving their material disagreement (adaptive vs fixed), the production-vs-synthetic evidence-quality distinction and an explicit bounded next-step decision. Check whether either participant inferred a per-job retry-budget guarantee from aggregate overload counts; do not silently adopt unsupported numeric claims. Identify what cannot yet be established and a concrete experiment to resolve it. You own only council/synthesis/. Report the artifact and actual reasoning. Do not dispatch agents or alter source data.',
    checks: [{ type: 'file', path: 'council/synthesis/result.md', contains: '2.4' }],
  });
  console.log(t.id);
} else if (stage === 'debate') {
  if (state.debateId) throw new Error('Debate exists');
  const participants = [];
  for (const [name, kind, profileId] of [
    ['a', 'codex', 'astra'],
    ['b', 'claude', 'fable'],
  ]) {
    const t = await submit('debate-' + name, {
      kind,
      profileId,
      canDelegate: false,
      deferStart: true,
      ownership: ['debate/' + name],
      prompt: `Bounded debate round 1: independently read corpus/requirements.md, source-a.md and source-b.md. Propose whether the batch service should ship fixed 4, adaptive 2-8, or first run an experiment. Write debate/${name}/round1.md with a clear claim, numeric evidence, strongest objection to your own proposal, and an explicit decision criterion. Do not read other participants or council artifacts in this independent initial round. Own only debate/${name}/. Submit a complete report; a later round may ask you to rebut the other proposal.`,
      checks: [{ type: 'file', path: 'debate/' + name + '/round1.md', contains: '2.4' }],
    });
    participants.push(t.id);
  }
  const strategy = await invoke('strategy.create', {
    expectedRevision: (await current()).revision,
    reason: 'Two-round evidence-based rollout debate',
    strategy: {
      outcomeId: state.outcomeId,
      kind: 'debate',
      participants,
      criteria: 'Interactive p95, retry-budget evidence and production representativeness',
      stopCondition:
        'Stop after two verified rounds and decide a bounded next experiment while preserving uncertainty',
      maxRounds: 2,
    },
  });
  state.debateId = strategy.id;
  save(statePath, state);
  console.log(strategy.id);
} else if (stage === 'debate-rebuttal') {
  const board = await invoke('board.get', { projectId: state.projectId });
  let strategy = board.strategies.find((s) => s.id === state.debateId);
  if (![1, 2].includes(strategy.round)) throw new Error('Unexpected round');
  if (strategy.round === 1) {
    for (const name of ['a', 'b']) {
      const id = state.tasks['debate-' + name],
        { task } = await invoke('task.get', { taskId: id });
      if (task.status !== 'completed') throw new Error('Round 1 not verified');
      const claim = readFileSync(resolve(projectRoot, 'debate/' + name + '/round1.md'), 'utf8');
      strategy = await invoke('strategy.contribute', {
        strategyId: strategy.id,
        expectedRevision: strategy.revision,
        taskId: id,
        claim,
        evidence: ['debate/' + name + '/round1.md'],
      });
    }
    strategy = await invoke('strategy.advance', {
      strategyId: strategy.id,
      expectedRevision: strategy.revision,
    });
  }
  for (const name of ['a', 'b']) {
    const { task } = await invoke('task.get', { taskId: state.tasks['debate-' + name] });
    if (task.checks.some((c) => c.path === 'debate/' + name + '/round2.md')) continue;
    const other = name === 'a' ? 'b' : 'a';
    const prompt = `Bounded debate round 2, final round. Read your preserved debate/${name}/round1.md and the other participant's debate/${other}/round1.md, then check both against the original corpus. Write debate/${name}/round2.md with a direct evidence-based rebuttal, any concession, remaining material disagreement, and a final bounded decision/stop condition. Explicitly assess whether aggregate overload counts can establish the per-job retry limit. Keep round1.md unchanged. Own only debate/${name}/. Submit a fresh completion report for your current revision.`;
    const updated = await invoke('plan.revise', {
      taskId: task.id,
      expectedRevision: task.revision,
      expectedTreeRevision: (await current()).revision,
      reason:
        'Second and final debate round evaluates the independently produced opposing proposal',
      evidence: ['debate/' + other + '/round1.md'],
      patch: {
        prompt,
        checks: [{ type: 'file', path: 'debate/' + name + '/round2.md', contains: '2.4' }],
      },
    });
    await invoke('task.control', {
      taskId: task.id,
      expectedRevision: updated.revision,
      key: 'debate-round2-' + name,
      type: 'reply',
      text: prompt,
    });
  }
} else if (stage === 'synthesis-refine') {
  const { task } = await invoke('task.get', { taskId: state.tasks['council-synthesis'] });
  const prompt =
    'Refine council/synthesis/result.md after lead review. Do not infer that no job exceeded two retries merely because all eventually completed: the corpus does not say the replay enforced the stated budget, and aggregate counts do not establish per-job retry compliance. Preserve this as unknown. Also distinguish the original p95 QUEUE latency target (<3s) from suggested end-to-end latency diagnostics; the proposed experiment must not silently replace the original target with an invented end-to-end acceptance rule. Keep both participant positions, numeric evidence, and bounded experiment. Submit fresh evidence for the current revision.';
  const updated = await invoke('plan.revise', {
    taskId: task.id,
    expectedRevision: task.revision,
    expectedTreeRevision: (await current()).revision,
    reason:
      'Lead review found a remaining inference about per-job retry compliance and a conflated latency target',
    evidence: ['corpus/requirements.md', 'corpus/source-a.md'],
    patch: { prompt },
  });
  await invoke('task.control', {
    taskId: task.id,
    expectedRevision: updated.revision,
    key: 'synthesis-evidence-refine',
    type: 'reply',
    text: prompt,
  });
} else if (stage === 'lead') {
  if (state.leadPane) throw new Error('Native lead exists; do not duplicate it');
  const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
    h = new Herdr(p.socketPath);
  const created = await h.call('tab.create', {
    workspace_id: p.workspaceId,
    cwd: projectRoot,
    label: 'v02-event-lead',
    focus: false,
  });
  state.leadPane = created.root_pane;
  state.leadPhase = 'created';
  save(statePath, state);
  await h.call(
    'agent.start',
    {
      name: 'v02-event-lead',
      kind: 'claude',
      pane_id: state.leadPane.pane_id,
      args: ['--model', 'claude-fable-5', '--effort', 'high', '--permission-mode', 'acceptEdits'],
      timeout_ms: 30000,
    },
    35000,
  );
  const agent = (await h.call('agent.get', { target: state.leadPane.pane_id })).agent;
  state.leadAdapter = {
    type: 'herdr',
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    name: agent.name,
    kind: agent.agent,
    nativeSession: agent.agent_session?.value,
  };
  state.leadPhase = 'prompting';
  save(statePath, state);
  await h.call(
    'agent.prompt',
    {
      target: state.leadPane.pane_id,
      text: 'You are an event-driven lead in an isolated Marionette acceptance project. Remember the recovery phrase "violet giraffe 29" in this conversation. First use native file tools to write lead/ready.md containing that phrase and "READY", then end your turn. Do not dispatch work or use other MCP servers. When a later message starts "Marionette event delivery", use native file tools to write lead/resumed.md containing the delivery ID from that message and the recovery phrase from this initial turn. This proves same-session continuation after a real wait. Then end your turn. You own only lead/; do not edit any other files. This test prompt explicitly authorizes these local writes.',
    },
    12000,
  );
  state.leadPhase = 'running';
  save(statePath, state);
  console.log(
    JSON.stringify({
      pane: state.leadPane.pane_id,
      nativeSession: state.leadAdapter.nativeSession,
    }),
  );
} else if (stage === 'recover-config') {
  await invoke('project.configure', {
    agentArgs: {
      codex: ['--approve-for-me'],
      claude: ['--permission-mode', 'acceptEdits'],
      agy: ['--mode', 'accept-edits', '--sandbox'],
    },
  });
  for (const key of ['council-b', 'nested-coordinator']) {
    const { task } = await invoke('task.get', { taskId: state.tasks[key] });
    if (task.status === 'blocked')
      await invoke('task.control', {
        taskId: task.id,
        expectedRevision: task.revision,
        type: 'cancel',
        key: 'empty-startup-cancel-' + task.id,
      });
  }
} else if (stage === 'retry-startup') {
  for (const key of ['council-b', 'nested-coordinator']) {
    const { task } = await invoke('task.get', { taskId: state.tasks[key] });
    if (task.status === 'cancelled')
      await invoke('task.retry', { taskId: state.tasks[key], key: 'fixed-startup-v02-' + key });
  }
} else if (stage === 'lead-continue') {
  if (!['created', 'prompting'].includes(state.leadPhase) || state.leadAdapter?.nativeSession)
    throw new Error('Initial lead prompt already attempted');
  const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
    h = new Herdr(p.socketPath);
  const a = (await h.call('agent.get', { target: state.leadPane.pane_id })).agent;
  if (
    a.terminal_id !== state.leadPane.terminal_id ||
    a.name !== 'v02-event-lead' ||
    a.agent !== 'claude' ||
    a.agent_status !== 'idle'
  )
    throw new Error('Lead identity/readiness differs');
  state.leadAdapter = {
    type: 'herdr',
    paneId: a.pane_id,
    terminalId: a.terminal_id,
    name: a.name,
    kind: a.agent,
    nativeSession: a.agent_session.value,
  };
  state.leadPhase = 'prompting';
  save(statePath, state);
  await h.call(
    'agent.prompt',
    {
      target: a.pane_id,
      text: 'You are an event-driven lead in an isolated Marionette acceptance project. Remember the recovery phrase "violet giraffe 29" in this conversation. First use native file tools to write lead/ready.md containing that phrase and "READY", then end your turn. Do not dispatch work or use other MCP servers. When a later message starts "Marionette event delivery", use native file tools to write lead/resumed.md containing the delivery ID from that message and the recovery phrase from this initial turn. Then end your turn. You own only lead/; these local writes are authorized.',
    },
    12000,
  );
  state.leadPhase = 'running';
  save(statePath, state);
} else if (stage === 'resume-workers') {
  for (const key of ['software-implementation', 'nested-coordinator']) {
    const { task } = await invoke('task.get', { taskId: state.tasks[key] });
    if (task.status === 'blocked')
      await invoke('task.control', {
        taskId: task.id,
        expectedRevision: task.revision,
        key: 'resume-fixed-' + key,
        type: 'reply',
        text: 'The isolated supervisor is healthy again and your startup input is resolved. Continue the original assignment, inspect the current revision and perform managed delegation if required. Use the existing conversation and current worker credentials.',
      });
  }
} else if (stage === 'wait') {
  if (!state.leadAdapter) throw new Error('Create lead first');
  const ids = Object.values(state.tasks ?? {});
  if (!ids.length) throw new Error('Create test tasks first');
  const wait = await invoke('lead.wait', {
    key: 'live-event-wait',
    outcomeId: state.outcomeId,
    adapter: state.leadAdapter,
    profileId: 'fable',
    expectedDurationMs: 180000,
    condition: { tasks: ids, mode: 'all', intervention: false },
  });
  state.waitId = wait.id;
  save(statePath, state);
  console.log(JSON.stringify({ waitId: wait.id, state: wait.state }));
} else if (stage === 'approve') {
  for (const id of process.argv.slice(3)) {
    const { task, run } = await invoke('task.get', { taskId: id });
    if (task.projectId !== state.projectId) throw new Error('Wrong project');
    const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
      h = new Herdr(p.socketPath);
    const a = (await h.call('agent.get', { target: run.paneId })).agent;
    const screen = (
      await h.call('pane.read', { pane_id: run.paneId, source: 'visible', format: 'text' })
    ).read.text;
    if (
      a.terminal_id !== run.terminalId ||
      a.name !== run.agentName ||
      !/(Do you want to proceed|Allow sandbox bypass)/.test(screen) ||
      !/[>❯] 1\. Yes/.test(screen)
    )
      throw new Error('Agent no longer at inspected approval');
    console.log(
      await invoke('task.control', {
        taskId: id,
        expectedRevision: task.revision,
        key: 'inspected-screen-' + id + '-' + createHash('sha256').update(screen).digest('hex'),
        type: 'keys',
        keys: ['enter'],
      }),
    );
  }
} else if (stage === 'screens') {
  const p = (await invoke('project.list')).find((p) => p.id === state.projectId),
    h = new Herdr(p.socketPath);
  const brief = await invoke('project.briefing', { projectId: state.projectId });
  for (const task of brief.tasks.filter(
    (t) => t.runId && !['completed', 'cancelled'].includes(t.status),
  )) {
    const detail = await invoke('task.get', { taskId: task.id });
    const r = detail.run;
    if (r?.paneId)
      console.log(
        JSON.stringify({
          taskId: task.id,
          title: task.title,
          status: task.status,
          pane: r.paneId,
          terminalId: r.terminalId,
          screen: (
            await h.call('pane.read', { pane_id: r.paneId, source: 'visible', format: 'text' })
          ).read.text.slice(-6500),
        }),
      );
  }
} else if (stage === 'status') {
  if (!state.projectId) throw new Error('Initialize first');
  const brief = await invoke('project.briefing', { projectId: state.projectId });
  console.log(
    JSON.stringify(
      {
        outcome: brief.outcomes.map((o) => ({
          id: o.id,
          revision: o.revision,
          status: o.status,
          turns: o.turnsUsed,
          unmet: o.unmet,
        })),
        tasks: brief.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          model: t.model,
          parentId: t.parentId,
          status: t.status,
          revision: t.revision,
          attempt: t.attempt,
          waitReason: t.waitReason,
          error: t.error,
          summary: t.receipt?.summary,
        })),
        operations: brief.operations,
        questions: brief.questions.filter((q) => !q.answeredAt),
        waits: brief.waits.map((w) => ({
          id: w.id,
          state: w.state,
          error: w.error,
          deliveredAt: w.deliveredAt,
        })),
      },
      null,
      2,
    ),
  );
} else throw new Error('Unknown stage: ' + stage);
