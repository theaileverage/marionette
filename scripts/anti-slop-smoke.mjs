#!/usr/bin/env node
// Proves the vendored anti-slop Effect plugin is wired into the root Oxlint
// config: a deliberate `no-manual-tag-comparison` violation must be rejected, and
// the same logic rewritten with `Predicate.isTagged` must pass cleanly.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureDir = join(packageRoot, ".test-output", "anti-slop-smoke");

const oxlintBin = join(packageRoot, "node_modules", "oxlint", "bin", "oxlint");

const violationSource = `import { Predicate } from "effect";

type ReadinessState = { readonly _tag: "Ready" | "Pending" };

declare const state: ReadinessState;

export const isReady = state._tag === "Ready";

void Predicate.isString;
`;

const correctedSource = `import { Predicate } from "effect";

type ReadinessState = { readonly _tag: "Ready" | "Pending" };

declare const state: ReadinessState;

export const isReady = Predicate.isTagged("Ready")(state);
`;

const cases = [
  {
    name: "violation",
    source: violationSource,
    expectExitCode: 1,
    expectRuleId: "anti-slop-effect(no-manual-tag-comparison)",
  },
  {
    name: "corrected",
    source: correctedSource,
    expectExitCode: 0,
    expectRuleId: null,
  },
];

function runOxlint(fixturePath) {
  const result = spawnSync(process.execPath, [oxlintBin, fixturePath], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  return result;
}

rmSync(fixtureDir, { recursive: true, force: true });

mkdirSync(fixtureDir, { recursive: true });

let failures = 0;

const report = [];

for (const testCase of cases) {
  const fixturePath = join(fixtureDir, `${testCase.name}.ts`);
  writeFileSync(fixturePath, testCase.source);

  const relativeFixturePath = join(".test-output", "anti-slop-smoke", `${testCase.name}.ts`);
  const result = runOxlint(relativeFixturePath);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const exitCodeMatches = result.status === testCase.expectExitCode;

  const ruleMatches =
    testCase.expectRuleId === null
      ? !output.includes("anti-slop-effect(")
      : output.includes(testCase.expectRuleId);

  const passed = exitCodeMatches && ruleMatches;

  if (!passed) failures += 1;

  report.push({
    case: testCase.name,
    fixture: relativeFixturePath,
    expectExitCode: testCase.expectExitCode,
    actualExitCode: result.status,
    expectRuleId: testCase.expectRuleId,
    ruleMatches,
    passed,
    output: output.trim(),
  });
}

for (const entry of report) {
  const status = entry.passed ? "PASS" : "FAIL";

  console.log(`[${status}] ${entry.case} (${entry.fixture})`);
  console.log(`  expected exit code ${entry.expectExitCode}, got ${entry.actualExitCode}`);
  console.log(`  expected rule ${entry.expectRuleId ?? "<none>"}, matched: ${entry.ruleMatches}`);

  if (entry.output.length > 0) {
    for (const line of entry.output.split("\n")) console.log(`    ${line}`);
  }
}

if (failures > 0) {
  console.error(`\nanti-slop Effect smoke test failed: ${failures} of ${report.length} cases did not match expectations.`);
  process.exit(1);
}

console.log(`\nanti-slop Effect smoke test passed: ${report.length} of ${report.length} cases matched expectations.`);
