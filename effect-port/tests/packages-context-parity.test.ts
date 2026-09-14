import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Result, Schema } from "effect";

import * as BaselineContext from "../../src/v1/context.js";
import * as BaselinePackages from "../../src/v1/packages.js";
import * as PortContext from "../src/v1/context.js";
import * as PortPackages from "../src/v1/packages.js";

type BaselineSchema = {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
};

function compareStrict(
  baseline: BaselineSchema,
  port: Schema.ConstraintDecoder<unknown>,
  input: unknown,
): void {
  const expected = baseline.safeParse(input);
  const actual = Schema.decodeUnknownResult(port, { onExcessProperty: "error" })(input);
  assert.equal(Result.isSuccess(actual), expected.success);
  if (expected.success && Result.isSuccess(actual)) assert.deepEqual(actual.success, expected.data);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const manifest = (text = "source text") => ({
  name: "feature",
  version: "1.0.0",
  source: {
    kind: "local-snapshot",
    root: "/fixture/skills",
    entry: "feature.md",
    upstream: {
      name: "pstack",
      license: { status: "verified", spdx: "MIT", resource: "pstack/LICENSE" },
    },
  },
  entryStep: "ground",
  resources: {
    "feature.md": { sourcePath: "feature.md", sourceDigest: digest(text), text },
  },
  steps: [
    {
      name: "ground",
      resources: ["feature.md"],
      outputContract: "grounded",
      permittedMethods: ["inspect"],
      requiredEvidence: ["trace"],
    },
    {
      name: "review",
      resources: ["feature.md"],
      outputContract: "reviewed",
      permittedMethods: [],
      requiredEvidence: ["independent-review"],
      requiresDistinctRole: true,
    },
  ],
  transitions: [
    { from: "ground", kind: "advance", to: "review" },
    { from: "review", kind: "route", routes: ["inspect"] },
    { from: "review", kind: "finish" },
  ],
  limits: {
    maxAttempts: 2,
    maxRepeats: 1,
    deadlineMs: 1000,
    parallelism: 1,
    innerLoopDeadlineMs: 500,
  },
  stopBoundaries: ["review"],
  constraints: { successRequires: "review", enabled: true, score: 1 },
  unresolvedReferences: [
    {
      reference: "optional.md",
      classification: "optional-unsupported",
      reason: "not bundled",
    },
  ],
  dependencyStatus: {
    status: "classified-incomplete",
    parameterizedReferences: [{ pattern: "*.md", directory: "references" }],
  },
});

test("package manifest schema preserves strictness, defaults, license, and graph refinements", () => {
  const valid = manifest();
  const invalid = [
    { ...valid, extra: true },
    { ...valid, source: { ...valid.source, extra: true } },
    { ...valid, source: { ...valid.source, upstream: { ...valid.source.upstream, license: { status: "verified", spdx: "Apache-2.0", resource: "LICENSE" } } } },
    { ...valid, entryStep: "missing" },
    { ...valid, steps: [valid.steps[0], valid.steps[0]] },
    { ...valid, steps: [{ ...valid.steps[0], resources: ["missing.md"] }] },
    { ...valid, steps: [{ ...valid.steps[1], requiresDistinctRole: false }] },
    { ...valid, transitions: [{ from: "missing", kind: "finish" }] },
    { ...valid, transitions: [{ from: "ground", kind: "advance" }] },
    { ...valid, transitions: [{ from: "ground", kind: "route", routes: [] }] },
    { ...valid, transitions: [{ from: "ground", kind: "finish", to: "review" }] },
    { ...valid, limits: { ...valid.limits, maxAttempts: 0 } },
    { ...valid, steps: [{ ...valid.steps[0], requiredEvidence: [] }] },
  ];
  compareStrict(BaselinePackages.packageManifestSchema, PortPackages.packageManifestSchema, valid);
  compareStrict(BaselinePackages.packageManifestSchema, PortPackages.packageManifestSchema, {
    ...valid,
    steps: valid.steps.map((step) => ({
      ...step,
      requiresDistinctRole: step.name === "ground" ? undefined : step.requiresDistinctRole,
      stopBoundary: undefined,
    })),
    transitions: valid.transitions.map((transition) => ({
      ...transition,
      to: "to" in transition ? transition.to : undefined,
      routes: "routes" in transition ? transition.routes : undefined,
    })),
    unresolvedReferences: valid.unresolvedReferences.map((reference) => ({
      ...reference,
      sourcePath: undefined,
    })),
  });
  compareStrict(BaselinePackages.packageManifestSchema, PortPackages.packageManifestSchema, {
    ...valid,
    constraints: { score: Number.POSITIVE_INFINITY },
  });
  compareStrict(BaselinePackages.packageManifestSchema, PortPackages.packageManifestSchema, {
    ...valid,
    constraints: { score: Number.NaN },
  });
  for (const input of invalid) {
    compareStrict(BaselinePackages.packageManifestSchema, PortPackages.packageManifestSchema, input);
  }
});

test("package snapshot, routing, and model config behavior matches the baseline", () => {
  const input = manifest("pinned source");
  const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
  const baselineManifest = BaselinePackages.packageManifestSchema.parse(input);
  const portManifest = Schema.decodeUnknownSync(PortPackages.packageManifestSchema, {
    onExcessProperty: "error",
  })(input);
  const requiredDistinctRole: boolean = portManifest.steps[0].requiresDistinctRole;
  assert.equal(requiredDistinctRole, false);
  const baseline = BaselinePackages.snapshotPackage(baselineManifest, bytes);
  const port = PortPackages.snapshotPackage(portManifest, bytes);
  assert.equal(port.digest, baseline.digest);
  assert.deepEqual(port.sourceDigests, baseline.sourceDigests);
  assert.deepEqual(port.steps, baseline.steps);
  assert.deepEqual(port.transitions, baseline.transitions);
  assert.equal(new TextDecoder().decode(port.resources[0]?.bytes), "pinned source");

  for (const request of [
    { request: "format generated JSON" },
    { request: "fix the regression" },
    { request: "anything", package: "refactoring" },
    { request: "anything", package: "pstack/direct" },
    { request: "anything", package: "team/custom" },
  ]) {
    assert.deepEqual(PortPackages.route(request), BaselinePackages.route(request));
  }

  const config = "---\nname: pstack\n---\nfeature: model-a\nfeature: model-b\ninvalid";
  const options = { sourcePath: "/fixture/models.mdc", availableModels: new Set(["model-a"]) };
  assert.deepEqual(
    PortPackages.importModelConfig(config, options),
    BaselinePackages.importModelConfig(config, options),
  );
});

test("context schemas preserve UUID, absolute-path, token, generation, and strictness", () => {
  const projectId = randomUUID();
  const hostId = randomUUID();
  const binding = {
    version: 1,
    projectId,
    hostId,
    repositoryRoot: "/repo",
    stateDirectory: "/state",
    databasePath: "/state/project.sqlite",
  };
  const context = {
    version: 1,
    bindingPath: "/repo/.marionette-v1/project.json",
    projectId,
    hostId,
    sessionId: "session",
    generation: 1,
    token: "a".repeat(32),
    parentWorkflowId: "workflow",
  };
  for (const input of [binding, { ...binding, extra: true }, { ...binding, projectId: "bad" }, { ...binding, repositoryRoot: "relative" }]) {
    compareStrict(BaselineContext.bindingSchema, PortContext.bindingSchema, input);
  }
  for (const input of [context, { ...context, extra: true }, { ...context, token: "short" }, { ...context, generation: 0 }]) {
    compareStrict(BaselineContext.contextSchema, PortContext.contextSchema, input);
  }
  compareStrict(BaselineContext.contextSchema, PortContext.contextSchema, {
    ...context,
    parentWorkflowId: undefined,
    attemptId: undefined,
  });
});

test("context resolution preserves inherited MARIONETTE_CONTEXT binding and file permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "marionette-effect-context-"));
  try {
    const state = join(root, "state");
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const a = PortContext.createBinding({ repositoryRoot: first, stateRoot: state });
    const b = PortContext.createBinding({ repositoryRoot: second, stateRoot: state });
    const path = PortContext.writeSessionContext({
      stateDirectory: a.binding.stateDirectory,
      context: PortContext.contextSchema.make({
        version: 1,
        bindingPath: a.bindingPath,
        projectId: a.binding.projectId,
        hostId: a.binding.hostId,
        sessionId: "worker",
        generation: 1,
        token: "b".repeat(32),
        attemptId: "attempt-1",
      }),
    });
    const resolved = PortContext.resolveContext({
      cwd: second,
      env: { MARIONETTE_STATE_HOME: state, MARIONETTE_CONTEXT: path },
    });
    assert.equal(resolved.binding.projectId, a.binding.projectId);
    assert.equal(resolved.session?.attemptId, "attempt-1");
    assert.throws(
      () => PortContext.resolveContext({ bindingPath: b.bindingPath, env: { MARIONETTE_STATE_HOME: state, MARIONETTE_CONTEXT: path } }),
      /cannot switch/,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
