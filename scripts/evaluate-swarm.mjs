import { Schema } from 'effect';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const scenarios = JSON.parse(
  readFileSync(new URL('../evaluations/scenarios.json', import.meta.url), 'utf8'),
);
export const strategies = ['single-agent', 'current-marionette', 'revised-marionette'];

// The evaluator stays outside the trial checkout. Each invocation gets a fresh process/module cache.
export async function assess(scenario, root) {
  const results = [];
  for (const check of scenario.checks ?? []) {
    try {
      const script = `const m = await import(${JSON.stringify(pathToFileURL(join(root, check.module)).href)}); const c = ${JSON.stringify(check.cases)}; console.log(JSON.stringify(await Promise.all(c.map(x => m[${JSON.stringify(check.export)}](...x.args)))));`;
      const r = await execute(process.execPath, ['-e', script], root, 10000);
      const actual = JSON.parse(r.stdout.trim());
      results.push({
        check: check.module,
        passed:
          r.code === 0 &&
          isDeepStrictEqual(
            actual,
            check.cases.map((c) => c.expected),
          ),
        actual,
      });
    } catch (error) {
      results.push({ check: check.module, passed: false, detail: String(error) });
    }
  }
  for (const check of scenario.jsonChecks ?? []) {
    try {
      results.push({
        check: check.file,
        passed: isDeepStrictEqual(
          JSON.parse(readFileSync(join(root, check.file), 'utf8')),
          check.expected,
        ),
      });
    } catch (error) {
      results.push({ check: check.file, passed: false, detail: String(error) });
    }
  }
  for (const artifact of scenario.artifacts ?? []) {
    const path = join(root, artifact);
    results.push({
      check: artifact,
      passed: existsSync(path) && statSync(path).isFile() && statSync(path).size > 40,
      boundary: 'Presence only; quality and procedural claims require independent review.',
    });
  }
  return results;
}

function execute(command, args, cwd, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      stdout = (stdout + b).slice(-1000000);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-1000000);
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr, timedOut });
    });
  });
}

export async function runTrial({
  scenarioId,
  strategy,
  adapter,
  output,
  allowance = { timeoutMs: 1200000, maxTurns: 60 },
  model,
}) {
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario || !strategies.includes(strategy))
    throw new Error('Select a known scenario and strategy');
  if (
    !Array.isArray(adapter) ||
    !adapter.length ||
    !Schema.is(Schema.Array(Schema.String))(adapter)
  )
    throw new Error('adapter must be an executable and argument array');
  if (
    !Number.isFinite(allowance.timeoutMs) ||
    allowance.timeoutMs < 1000 ||
    allowance.timeoutMs > 86400000 ||
    !Number.isInteger(allowance.maxTurns) ||
    allowance.maxTurns < 1
  )
    throw new Error('Invalid time or turn allowance');
  const root = mkdtempSync(join(tmpdir(), 'marionette-trial-'));
  for (const [path, contents] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  mkdirSync(join(root, '.evaluation'), { recursive: true });
  const request = {
    schemaVersion: 1,
    scenario: scenario.id,
    objective: scenario.objective,
    strategy,
    model: model ?? null,
    allowance,
    root,
    adapterContract:
      'Use the requested strategy and model. Record runtimeVersion (exact commit for Marionette), models, actual usage, interventions and turns in response.json. Missing measurements stay null. Honor maxTurns across all agents. Preserve logs and state for audit. Human review verifies strategy fidelity and procedural claims.',
  };
  const requestPath = join(root, '.evaluation/request.json'),
    responsePath = join(root, '.evaluation/response.json');
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  let steeringAt = null;
  const inject = () => {
    if (!scenario.steering || steeringAt || !existsSync(join(root, '.evaluation/progress.json')))
      return;
    try {
      if (
        JSON.parse(readFileSync(join(root, '.evaluation/progress.json'), 'utf8')).phase !==
        'initial'
      )
        return;
    } catch {
      return;
    }
    steeringAt = Date.now();
    writeFileSync(
      join(root, '.evaluation/steering.json'),
      JSON.stringify(scenario.steering, null, 2),
    );
  };
  const timer = setInterval(inject, 100),
    startedAt = Date.now();
  let execution;
  try {
    execution = await execute(
      adapter[0],
      [...adapter.slice(1), requestPath, responsePath],
      root,
      allowance.timeoutMs,
    );
  } finally {
    clearInterval(timer);
  }
  let reported = null;
  try {
    reported = JSON.parse(readFileSync(responsePath, 'utf8'));
  } catch {
    /* Missing data is explicitly unavailable. */
  }
  const checks = await assess(scenario, root);
  if (scenario.steering) checks.push({ check: 'mid-task injection', passed: steeringAt !== null });
  const result = {
    schemaVersion: 1,
    scenario: scenario.id,
    strategy,
    model: model ?? null,
    allowance,
    root,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    acceptancePassed: execution.code === 0 && !execution.timedOut && checks.every((c) => c.passed),
    checks,
    steeringAt,
    turns: reported?.turns ?? null,
    usage: reported?.usage ?? null,
    interventions: reported?.interventions ?? null,
    adapterReport: reported,
    budgetVerified:
      Number.isInteger(reported?.turns) &&
      reported.turns >= 0 &&
      reported.turns <= allowance.maxTurns,
    reviewRequired: [
      'Strategy and model fidelity',
      'Source quality and causal explanations',
      'Recovery procedure and preserved identities',
      'Usage and turn accounting',
    ],
    execution,
  };
  const destination = resolve(output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function compareTrials(input) {
  const count = Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0));
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        scenario: Schema.String,
        strategy: Schema.String,
        model: Schema.NullOr(Schema.String),
        acceptancePassed: Schema.Boolean,
        elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        turns: Schema.NullOr(count),
        interventions: Schema.NullOr(count),
        usage: Schema.Unknown,
        budgetVerified: Schema.Boolean,
        allowance: Schema.Struct({ timeoutMs: count, maxTurns: count }),
      }),
    ),
  )(input);
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.scenario, row.strategy, row.model]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const measured = (values) => {
    const known = values.filter((v) => v !== null);
    return {
      measuredTrials: known.length,
      totalTrials: values.length,
      mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
    };
  };
  const cost = Schema.Struct({
    costUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    source: Schema.String.check(Schema.isMinLength(1)),
  });
  return {
    schemaVersion: 1,
    trials: rows.length,
    equalRequestedAllowances:
      rows.length > 0 && new Set(rows.map((r) => JSON.stringify(r.allowance))).size === 1,
    groups: [...groups.values()].map((group) => ({
      scenario: group[0].scenario,
      strategy: group[0].strategy,
      model: group[0].model,
      trials: group.length,
      acceptancePassed: group.filter((r) => r.acceptancePassed).length,
      acceptanceRate: group.filter((r) => r.acceptancePassed).length / group.length,
      elapsedMs: measured(group.map((r) => r.elapsedMs)),
      turns: measured(group.map((r) => r.turns)),
      interventions: measured(group.map((r) => r.interventions)),
      costUsd: measured(group.map((r) => (Schema.is(cost)(r.usage) ? r.usage.costUsd : null))),
      reportedWithinBudget: group.filter((r) => r.budgetVerified).length,
    })),
    boundary:
      'Acceptance checks and reported metrics only. Independent review is still required for overall success, strategy fidelity, usage accounting and causal conclusions. Unknown measurements are excluded from means and counted explicitly.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--list')
    console.log(
      JSON.stringify(
        { strategies, scenarios: scenarios.map(({ id, objective }) => ({ id, objective })) },
        null,
        2,
      ),
    );
  else if (process.argv[2] === '--compare' && process.argv.length > 3)
    console.log(
      JSON.stringify(
        compareTrials(process.argv.slice(3).map((path) => JSON.parse(readFileSync(path, 'utf8')))),
        null,
        2,
      ),
    );
  else if (process.argv[2] === '--config' && process.argv[3]) {
    const result = await runTrial(JSON.parse(readFileSync(process.argv[3], 'utf8')));
    console.log(
      JSON.stringify({
        acceptancePassed: result.acceptancePassed,
        root: result.root,
        elapsedMs: result.elapsedMs,
        budgetVerified: result.budgetVerified,
      }),
    );
    if (!result.acceptancePassed) process.exitCode = 1;
  } else
    throw new Error(
      'Usage: bun scripts/evaluate-swarm.mjs --list | --config /absolute/trial.json | --compare /absolute/result1.json /absolute/result2.json',
    );
}
