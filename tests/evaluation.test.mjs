import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assess, runTrial, scenarios, compareTrials } from '../scripts/evaluate-swarm.mjs';

const solutions = {
  'total.mjs':
    'export const total = items => Math.round(items.reduce((n,i) => n+i.price*i.quantity,0)*100)/100;',
  'navigation.mjs': "export const navigation = () => ['Home','Projects','Settings'];",
  'invoice.mjs': 'export const invoice = net => Math.round(net*1.1*100)/100;',
  'events.mjs':
    'export const latest = events => [...events].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).at(-1) ?? null;',
  'normalize.mjs': 'export const normalize = name => name.trim().toLowerCase();',
  'slug.mjs':
    "import { normalize } from './normalize.mjs'; export const slug = name => normalize(name).replace(/\\s+/g,'-');",
  'search.mjs':
    "import { normalize } from './normalize.mjs'; export const matches = (names,query) => names.filter(n=>normalize(n).includes(normalize(query)));",
  'counter.mjs': 'export const apply = (count,event) => Math.max(0,count+event.delta);',
  'answer.json': JSON.stringify({
    retentionDays: 14,
    sources: ['sources/policy.txt', 'sources/release.txt'],
  }),
};
for (const scenario of scenarios)
  test(`evaluation ${scenario.id} rejects initial defects and accepts reference behavior`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'marionette-eval-check-'));
    try {
      for (const [path, text] of Object.entries(scenario.files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      assert.equal(
        (await assess(scenario, root)).every((c) => c.passed),
        false,
      );
      for (const path of Object.keys(scenario.files))
        if (solutions[path]) writeFileSync(join(root, path), solutions[path]);
      for (const artifact of scenario.artifacts ?? [])
        writeFileSync(
          join(root, artifact),
          'Evaluator fixture only. This checks artifact presence, not research quality or actual recovery.',
        );
      assert.deepEqual(
        (await assess(scenario, root)).filter((c) => !c.passed),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('evaluation adapter receives late steering and unavailable usage remains null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-eval-adapter-'));
  let root;
  try {
    const adapter = join(dir, 'adapter.mjs');
    writeFileSync(
      adapter,
      `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
writeFileSync('.evaluation/progress.json',JSON.stringify({phase:'initial'}));
while(!existsSync('.evaluation/steering.json')) await new Promise(r=>setTimeout(r,10));
const steering=JSON.parse(readFileSync('.evaluation/steering.json','utf8'));
if(steering.objective!=='navigation') throw new Error('wrong objective');
writeFileSync('navigation.mjs',${JSON.stringify(solutions['navigation.mjs'])});
writeFileSync('invoice.mjs',${JSON.stringify(solutions['invoice.mjs'])});
writeFileSync(process.argv[3], JSON.stringify({turns:2, runtimeVersion:'fixture-only', model:request.model}));`,
    );
    const result = await runTrial({
      scenarioId: 'multiple-objectives',
      strategy: 'single-agent',
      adapter: [process.execPath, adapter],
      output: join(dir, 'result.json'),
      allowance: { timeoutMs: 5000, maxTurns: 3 },
    });
    root = result.root;
    assert.equal(result.acceptancePassed, true);
    assert.equal(result.budgetVerified, true);
    assert.equal(result.usage, null);
    assert.equal(result.interventions, null);
    assert.ok(result.steeringAt);
    assert.ok(result.reviewRequired.length);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('comparison keeps unavailable cost and intervention measurements out of averages', () => {
  const row = {
    scenario: 'simple',
    strategy: 'single-agent',
    model: 'fixture',
    acceptancePassed: true,
    elapsedMs: 20,
    turns: 1,
    usage: null,
    interventions: null,
    budgetVerified: true,
    allowance: { timeoutMs: 1000, maxTurns: 2 },
  };
  const report = compareTrials([
    row,
    {
      ...row,
      acceptancePassed: false,
      elapsedMs: 40,
      turns: 2,
      interventions: 1,
      usage: { costUsd: 0.5, source: 'fixture-receipt' },
    },
  ]);
  assert.equal(report.equalRequestedAllowances, true);
  assert.equal(report.groups[0].acceptanceRate, 0.5);
  assert.deepEqual(report.groups[0].costUsd, { measuredTrials: 1, totalTrials: 2, mean: 0.5 });
  assert.deepEqual(report.groups[0].interventions, { measuredTrials: 1, totalTrials: 2, mean: 1 });
  assert.equal(report.groups[0].elapsedMs.mean, 30);
});
