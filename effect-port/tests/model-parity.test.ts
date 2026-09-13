import assert from "node:assert/strict";
import test from "node:test";

import { Result, Schema } from "effect";
import * as Baseline from "../../src/v1/model.js";

import * as Port from "../src/v1/model.js";

type BaselineSchema = {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
};

function compare(
  baseline: BaselineSchema,
  port: Schema.ConstraintDecoder<unknown>,
  input: unknown,
): void {
  const expected = baseline.safeParse(input);
  const actual = Schema.decodeUnknownResult(port)(input);
  assert.equal(Result.isSuccess(actual), expected.success);
  if (expected.success && Result.isSuccess(actual)) {
    assert.deepEqual(actual.success, expected.data);
  }
}

function compareCases(
  baseline: BaselineSchema,
  port: Schema.ConstraintDecoder<unknown>,
  inputs: ReadonlyArray<unknown>,
): void {
  for (const input of inputs) compare(baseline, port, input);
}

const digest = "a".repeat(64);

const workflowStep = {
  name: "implement",
  phase: "implementation",
  resources: ["repository"],
  outputContract: "patch",
  permittedMethods: ["edit"],
  requiredEvidence: ["tests"],
};

const workflowPackage = {
  name: "default",
  version: "1.0.0",
  digest,
  sourceDigests: [digest],
  entryStep: "implement",
  steps: [workflowStep],
  transitions: [{ kind: "finish", from: "implement" }],
  limits: {
    maxAttempts: 2,
    maxRepeats: 1,
    deadlineMs: 60_000,
    parallelism: 1,
    innerLoopDeadlineMs: 30_000,
  },
};

const transitionEnvelope = {
  workflowId: "workflow-1",
  sourceStepRunId: "step-run-1",
  reason: "verified",
  evidenceResultIds: ["result-1"],
  expectedWorkflowRevision: 1,
  expectedBriefRevision: 1,
  expectedControlRevision: 1,
  idempotencyKey: "transition-1",
};

test("identifier and digest schemas preserve bounds and brands erase at runtime", () => {
  compareCases(Baseline.ProjectIdSchema, Port.ProjectIdSchema, [
    "p",
    "x".repeat(255),
    "",
    "x".repeat(256),
    1,
    null,
  ]);
  compareCases(Baseline.DigestSchema, Port.DigestSchema, [
    digest,
    "f".repeat(64),
    "A".repeat(64),
    "a".repeat(63),
    "g".repeat(64),
  ]);
});

test("timestamp schema exactly preserves the Zod UTC ISO acceptance boundary", () => {
  compareCases(Baseline.TimestampSchema, Port.TimestampSchema, [
    "1970-01-01T00:00Z",
    "2024-02-29T23:59:59.123456Z",
    "2023-02-29T00:00:00Z",
    "2024-04-31T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:00:60Z",
    "2024-01-01T00:00:00+00:00",
    "2024-01-01",
  ]);
});

test("positive integer schemas reject zero, fractions, and non-finite values", () => {
  for (const pair of [
    [Baseline.RevisionSchema, Port.RevisionSchema],
    [Baseline.SessionGenerationSchema, Port.SessionGenerationSchema],
  ] satisfies ReadonlyArray<readonly [BaselineSchema, Schema.ConstraintDecoder<unknown>]>) {
    compareCases(pair[0], pair[1], [1, Number.MAX_SAFE_INTEGER + 1, 0, -1, 1.5, NaN, Infinity]);
  }
});

test("workflow package applies nested defaults, strips unknown keys, and validates steps", () => {
  compareCases(Baseline.WorkflowPackageSnapshotSchema, Port.WorkflowPackageSnapshotSchema, [
    workflowPackage,
    {
      ...workflowPackage,
      steps: [{ ...workflowStep, requiresDistinctRole: undefined }],
    },
    {
      ...workflowPackage,
      ignored: true,
      steps: [{ ...workflowStep, ignored: "nested" }],
    },
    {
      ...workflowPackage,
      steps: [workflowStep, { ...workflowStep }],
    },
    { ...workflowPackage, entryStep: "missing" },
    { ...workflowPackage, steps: [] },
    {
      ...workflowPackage,
      transitions: [{ kind: "route", from: "implement", targets: [] }],
    },
    {
      ...workflowPackage,
      limits: { ...workflowPackage.limits, maxAttempts: 0 },
    },
  ]);
  const decoded = Schema.decodeUnknownSync(Port.WorkflowStepSchema)({
    ...workflowStep,
    requiresDistinctRole: undefined,
  });
  const requiredDistinctRole: boolean = decoded.requiresDistinctRole;
  assert.equal(requiredDistinctRole, false);
});

test("workflow transition variants preserve discriminants and payload constraints", () => {
  compareCases(Baseline.WorkflowTransitionRuleSchema, Port.WorkflowTransitionRuleSchema, [
    { kind: "advance", from: "a", to: "b" },
    { kind: "repeat", from: "a", to: "a", ignored: true },
    { kind: "route", from: "a", targets: [{ kind: "method", method: "review" }] },
    { kind: "route", from: "a", targets: [] },
    { kind: "finish", from: "" },
    { kind: "unknown", from: "a" },
  ]);

  compareCases(Baseline.TransitionRequestSchema, Port.TransitionRequestSchema, [
    { ...transitionEnvelope, kind: "advance", targetStep: "review" },
    {
      ...transitionEnvelope,
      kind: "route",
      target: { kind: "child-workflow", packageName: "child" },
      ignored: true,
    },
    {
      ...transitionEnvelope,
      kind: "finish",
      result: { outcome: "succeeded", resultIds: ["result-1"] },
    },
    {
      ...transitionEnvelope,
      kind: "finish",
      result: { outcome: "failed", failureReason: "failed", retainedResultIds: [] },
    },
    { ...transitionEnvelope, kind: "advance", targetStep: "", expectedWorkflowRevision: 0 },
    {
      ...transitionEnvelope,
      kind: "finish",
      result: { outcome: "failed", failureReason: "", retainedResultIds: [] },
    },
  ]);
});

test("evidence, verification, and result content preserve tuple and nested constraints", () => {
  compareCases(Baseline.EvidenceSchema, Port.EvidenceSchema, [
    { kind: "file", path: "src/index.ts", digest },
    { kind: "git-commit", commit: "abc", parent: "def", paths: ["src/index.ts"] },
    { kind: "command", argv: ["npm", "test", ""], exitCode: 0, log: digest },
    { kind: "command", argv: [], exitCode: 0, log: digest },
    { kind: "command", argv: [""], exitCode: 0, log: digest },
    { kind: "command", argv: ["npm"], exitCode: 0.5, log: digest },
  ]);

  compareCases(Baseline.VerificationSchema, Port.VerificationSchema, [
    { kind: "not-requested", ignored: true },
    { kind: "passed", checks: [{ kind: "file", path: "src/index.ts", digest }] },
    { kind: "failed", checks: [{ kind: "command", argv: [], exitCode: 1, log: digest }] },
  ]);

  compareCases(Baseline.ResultContentSchema, Port.ResultContentSchema, [
    { kind: "report", body: "done", artifactDigests: [digest], ignored: true },
    { kind: "report", body: "", artifactDigests: [] },
    {
      kind: "patch",
      sourceRepository: "repo",
      baseCommit: "base",
      resultingTree: "tree",
      changedPaths: ["src/index.ts"],
      artifactDigests: [],
    },
    {
      kind: "commit",
      sourceRepository: "repo",
      baseCommit: "base",
      resultingTree: "tree",
      resultingCommit: "commit",
      changedPaths: [""],
      artifactDigests: [],
    },
  ]);
});
