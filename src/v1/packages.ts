import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import {
  WorkflowPackageSnapshotSchema,
  type WorkflowPackageSnapshot as StoredWorkflowPackageSnapshot,
  type WorkflowStepPhase,
} from "./model.js";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

const mutableStringArray = Schema.mutable(Schema.Array(nonEmptyString));

const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, { expected: "an integer" }),
);

const positiveInteger = integer.check(Schema.isGreaterThan(0));

const digestSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const zodNumber = Schema.Number.check(
  Schema.makeFilter((value) => !Number.isNaN(value), { expected: "a number other than NaN" }),
);

const resourceSchema = Schema.Struct({
  sourceDigest: Schema.mutableKey(digestSchema),
  sourcePath: Schema.mutableKey(nonEmptyString),
  text: Schema.mutableKey(Schema.String),
});

const transitionKindSchema = Schema.Literals([
  "advance",
  "repeat",
  "route",
  "await-decision",
  "block",
  "finish",
]);

const methodSchema = nonEmptyString;

const transitionSchema = Schema.Struct({
  from: nonEmptyString,
  kind: transitionKindSchema,
  to: Schema.optional(nonEmptyString),
  routes: Schema.optional(mutableStringArray),
}).check(
  Schema.makeFilter((value) => {
    const issues: Array<Schema.FilterIssue> = [];

    if ((value.kind === "advance" || value.kind === "repeat") && !value.to) {
      issues.push({
        path: ["to"],
        issue: `${value.kind} transitions require a target step`,
      });
    }

    if (value.kind === "route" && (!value.routes || value.routes.length === 0)) {
      issues.push({ path: ["routes"], issue: "route transitions require at least one route" });
    }

    if (
      (value.kind === "await-decision" || value.kind === "block" || value.kind === "finish") &&
      (value.to || value.routes)
    ) {
      issues.push(`${value.kind} transitions are terminal or control boundaries`);
    }

    return issues;
  }),
);

const stepSchema = Schema.Struct({
  name: nonEmptyString,
  resources: mutableStringArray,
  outputContract: nonEmptyString,
  permittedMethods: Schema.mutable(Schema.Array(methodSchema)),
  requiredEvidence: Schema.mutable(
    Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
  ),
  requiresDistinctRole: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  stopBoundary: Schema.optional(nonEmptyString),
});

const limitsSchema = Schema.Struct({
  maxAttempts: positiveInteger,
  maxRepeats: positiveInteger,
  deadlineMs: positiveInteger,
  parallelism: positiveInteger,
  innerLoopDeadlineMs: positiveInteger,
});

const sourceSchema = Schema.Struct({
  kind: Schema.Literal("local-snapshot"),
  root: nonEmptyString,
  entry: nonEmptyString,
  upstream: Schema.Struct({
    name: nonEmptyString,
    license: Schema.Struct({
      status: Schema.Literal("verified"),
      spdx: Schema.Literal("MIT"),
      resource: nonEmptyString,
    }),
  }),
});

const unresolvedReferenceSchema = Schema.Struct({
  reference: nonEmptyString,
  classification: Schema.Literal("optional-unsupported"),
  sourcePath: Schema.optional(nonEmptyString),
  reason: nonEmptyString,
});

const dependencyStatusSchema = Schema.Struct({
  status: Schema.Literals(["complete", "classified-incomplete"]),
  parameterizedReferences: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        pattern: nonEmptyString,
        directory: nonEmptyString,
      }),
    ),
  ),
});

export const packageManifestSchema = Schema.Struct({
  name: nonEmptyString,
  version: nonEmptyString,
  source: sourceSchema,
  entryStep: nonEmptyString,
  resources: Schema.Record(Schema.String, resourceSchema),
  steps: Schema.mutable(Schema.Array(stepSchema).check(Schema.isMinLength(1))),
  transitions: Schema.mutable(
    Schema.Array(transitionSchema).check(Schema.isMinLength(1)),
  ),
  limits: limitsSchema,
  stopBoundaries: mutableStringArray,
  constraints: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Boolean, Schema.String, zodNumber]),
  ),
  unresolvedReferences: Schema.mutable(Schema.Array(unresolvedReferenceSchema)),
  dependencyStatus: dependencyStatusSchema,
}).check(
  Schema.makeFilter((manifest) => {
    const issues: Array<Schema.FilterIssue> = [];
    const names = new Set<string>();

    for (const [index, step] of manifest.steps.entries()) {
      if (names.has(step.name)) {
        issues.push({
          path: ["steps", index, "name"],
          issue: `duplicate step ${step.name}`,
        });
      }

      names.add(step.name);

      if (step.name === "review" && !step.requiresDistinctRole) {
        issues.push({
          path: ["steps", index, "requiresDistinctRole"],
          issue: "review steps require an independent role",
        });
      }
    }

    if (!names.has(manifest.entryStep)) {
      issues.push({ path: ["entryStep"], issue: `unknown entry step ${manifest.entryStep}` });
    }

    const resources = new Set(Object.keys(manifest.resources));

    for (const [index, step] of manifest.steps.entries()) {
      for (const resource of step.resources) {
        if (!resources.has(resource)) {
          issues.push({
            path: ["steps", index, "resources"],
            issue: `unknown resource ${resource}`,
          });
        }
      }
    }

    for (const [index, transition] of manifest.transitions.entries()) {
      if (!names.has(transition.from)) {
        issues.push({
          path: ["transitions", index, "from"],
          issue: `unknown source step ${transition.from}`,
        });
      }

      if (transition.to && !names.has(transition.to)) {
        issues.push({
          path: ["transitions", index, "to"],
          issue: `unknown target step ${transition.to}`,
        });
      }
    }

    return issues;
  }),
);

export type PackageManifest = typeof packageManifestSchema.Type;

export type PackageName = string;

export type TransitionKind = typeof transitionKindSchema.Type;

export type WorkflowMethod = typeof methodSchema.Type;

export interface PinnedResource {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly sourcePath: string;
  readonly bytes: Readonly<Uint8Array>;
}

export type WorkflowPackageSnapshot = StoredWorkflowPackageSnapshot & {
  readonly manifest: Readonly<PackageManifest>;
  readonly resources: readonly PinnedResource[];
};

export interface RouteRequest {
  readonly request: string;
  readonly package?: PackageName;
}

export type RouteResult =
  | {
      readonly kind: "direct";
      readonly method: "direct";
      readonly precedence: "pstack";
      readonly packageName: "pstack/direct";
      readonly reason: "routine engineering work";
    }
  | {
      readonly kind: "workflow";
      readonly method: "pstack";
      readonly precedence: "pstack";
      readonly packageName: PackageName;
      readonly reason: "explicit package" | "deterministic request classification";
    };

type BundledPackageName = "direct" | "bug-fix" | "refactoring" | "architect" | "feature";

const bundledPackageNames: readonly BundledPackageName[] = [
  "direct",
  "bug-fix",
  "refactoring",
  "architect",
  "feature",
];

const bundledPackageName = (value: string): BundledPackageName | undefined => {
  const name = value.startsWith("pstack/") ? value.slice("pstack/".length) : value;

  return bundledPackageNames.find((candidate) => candidate === name);
};

const bundledPackageRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

const packageRoot = existsSync(bundledPackageRoot)
  ? bundledPackageRoot
  : resolve(process.cwd(), "workflows");

const decodeManifest = <Input>(input: Input): PackageManifest =>
  Schema.decodeUnknownSync(packageManifestSchema, { onExcessProperty: "error" })(input);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const immutable = <Value>(value: Value): Value => {
  Object.freeze(value);

  return value;
};

const mapNonEmpty = <Input, Output>(
  values: readonly [Input, ...Input[]],
  f: (value: Input) => Output,
): [Output, ...Output[]] => {
  const [first, ...rest] = values;

  return [f(first), ...rest.map(f)];
};

const stableDigest = (manifestBytes: Uint8Array, resources: readonly PinnedResource[]) => {
  const hash = createHash("sha256");
  hash.update("manifest\0");
  hash.update(manifestBytes);

  for (const resource of [...resources].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update("\0resource\0");
    hash.update(resource.path);
    hash.update("\0");
    hash.update(resource.bytes);
  }

  return hash.digest("hex");
};

const cloneBytes = (bytes: Uint8Array): Readonly<Uint8Array> => new Uint8Array(bytes);

const phaseFor = (name: string): WorkflowStepPhase => {
  switch (name) {
    case "design":
      return "design";
    case "direct":
    case "implement":
      return "implementation";
    case "review":
      return "review";
    case "verify":
      return "verification";
    case "handoff":
      return "coordination";
    default:
      return "analysis";
  }
};

const freezeManifest = (manifest: PackageManifest): PackageManifest =>
  immutable({
    ...manifest,
    resources: immutable(
      Object.fromEntries(
        Object.entries(manifest.resources).map(([path, resource]) => [
          path,
          immutable({ ...resource }),
        ]),
      ),
    ),
    steps: immutable(
      manifest.steps.map((step) =>
        immutable({
          ...step,
          resources: immutable([...step.resources]),
          permittedMethods: immutable([...step.permittedMethods]),
        }),
      ),
    ),
    transitions: immutable(
      manifest.transitions.map((transition) =>
        immutable({
          ...transition,
          routes: transition.routes && immutable([...transition.routes]),
        }),
      ),
    ),
    limits: immutable({ ...manifest.limits }),
  });

export function snapshotPackage(
  manifest: PackageManifest,
  manifestBytes: Uint8Array,
): WorkflowPackageSnapshot {
  const parsed = decodeManifest(manifest);

  const resources = Object.entries(parsed.resources).map(([path, resource]) => {
    const bytes = Buffer.from(resource.text, "utf8");
    const actual = sha256(bytes);

    if (actual !== resource.sourceDigest) {
      throw new Error(`package resource ${path} digest does not match manifest`);
    }

    return immutable({
      id: path,
      path,
      sha256: resource.sourceDigest,
      sourcePath: resource.sourcePath,
      get bytes(): Readonly<Uint8Array> {
        return cloneBytes(bytes);
      },
    });
  });

  const immutableManifest = freezeManifest(parsed);
  const immutableResources = immutable(resources);

  const transitions = immutableManifest.transitions.map((transition) => {
    if (transition.kind === "route") {
      if (!transition.routes) throw new Error("route transitions require at least one route");

      return {
        kind: "route",
        from: transition.from,
        targets: transition.routes.map((method) => ({ kind: "method", method })),
      };
    }

    if (transition.kind === "advance" || transition.kind === "repeat") {
      if (!transition.to) throw new Error(`${transition.kind} transitions require a target step`);

      return { kind: transition.kind, from: transition.from, to: transition.to };
    }

    return { kind: transition.kind, from: transition.from };
  });

  const parsedSnapshot = Schema.decodeUnknownSync(WorkflowPackageSnapshotSchema)({
    name: immutableManifest.name,
    version: immutableManifest.version,
    entryStep: immutableManifest.entryStep,
    digest: stableDigest(manifestBytes, immutableResources),
    sourceDigests: immutableResources.map((resource) => resource.sha256),
    steps: immutableManifest.steps.map(
      ({ name, resources, outputContract, permittedMethods, requiredEvidence, requiresDistinctRole }) => ({
        name,
        phase: phaseFor(name),
        resources,
        outputContract,
        permittedMethods,
        requiredEvidence,
        requiresDistinctRole,
      }),
    ),
    transitions,
    limits: immutableManifest.limits,
  });

  return immutable({
    ...parsedSnapshot,
    sourceDigests: immutable([...parsedSnapshot.sourceDigests]),
    steps: immutable(
      mapNonEmpty(parsedSnapshot.steps, (step) =>
        immutable({
          ...step,
          resources: immutable([...step.resources]),
          permittedMethods: immutable([...step.permittedMethods]),
          requiredEvidence: immutable([...step.requiredEvidence]),
        }),
      ),
    ),
    transitions: immutable(
      parsedSnapshot.transitions.map((transition) => immutable({ ...transition })),
    ),
    limits: immutable({ ...parsedSnapshot.limits }),
    manifest: immutableManifest,
    resources: immutableResources,
  });
}

const manifestPathFor = (nameOrPath: string): string => {
  const requested = isAbsolute(nameOrPath) ? nameOrPath : resolve(process.cwd(), nameOrPath);

  try {
    return statSync(requested).isDirectory() ? join(requested, "manifest.json") : requested;
  } catch {
    const bundledName = bundledPackageName(nameOrPath);

    if (bundledName) return join(packageRoot, `${bundledName}.json`);
    throw new Error(`workflow package ${nameOrPath} does not exist`);
  }
};

export function loadPackage(nameOrPath: string): WorkflowPackageSnapshot {
  const manifestPath = manifestPathFor(nameOrPath);
  const manifestBytes = readFileSync(manifestPath);
  let raw: unknown;

  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`invalid package manifest ${manifestPath}: ${String(error)}`);
  }

  return snapshotPackage(decodeManifest(raw), manifestBytes);
}

const classify = (request: string): Exclude<BundledPackageName, "direct"> | undefined => {
  const normalized = request.toLowerCase();

  if (/\b(bug|fix|broken|regression|defect|crash)\b/.test(normalized)) return "bug-fix";

  if (/\b(refactor|rename|extract|inline|dedup(?:licate)?|restructure)\b/.test(normalized)) {
    return "refactoring";
  }

  if (/\b(architect|architecture|module boundary|interface design|design a module)\b/.test(normalized)) {
    return "architect";
  }

  if (/\b(feature|implement|build|add)\b/.test(normalized)) return "feature";

  return undefined;
};

export function route(request: RouteRequest): RouteResult {
  if (request.package && bundledPackageName(request.package) === "direct") {
    return immutable({
      kind: "direct",
      method: "direct",
      precedence: "pstack",
      packageName: "pstack/direct",
      reason: "routine engineering work",
    });
  }

  if (request.package) {
    const bundled = bundledPackageName(request.package);

    return immutable({
      kind: "workflow",
      method: "pstack",
      precedence: "pstack",
      packageName: bundled ? `pstack/${bundled}` : request.package,
      reason: "explicit package",
    });
  }

  const packageName = classify(request.request);

  if (packageName) {
    return immutable({
      kind: "workflow",
      method: "pstack",
      precedence: "pstack",
      packageName: `pstack/${packageName}`,
      reason: "deterministic request classification",
    });
  }

  return immutable({
    kind: "direct",
    method: "direct",
    precedence: "pstack",
    packageName: "pstack/direct",
    reason: "routine engineering work",
  });
}

export interface ModelConfigDiagnostic {
  readonly code: "duplicate_role" | "model_unavailable" | "malformed_entry";
  readonly sourcePath: string;
  readonly line: number;
  readonly message: string;
}

export interface ModelConfigImport {
  readonly roles: Readonly<Record<string, readonly string[]>>;
  readonly diagnostics: readonly ModelConfigDiagnostic[];
}

export interface ModelConfigImportOptions {
  readonly sourcePath: string;
  readonly availableModels: ReadonlySet<string>;
}

export function importModelConfig(text: string, options: ModelConfigImportOptions): ModelConfigImport {
  const roles: Record<string, readonly string[]> = {};
  const diagnostics: ModelConfigDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  let frontmatterDelimiters = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "---") {
      frontmatterDelimiters += 1;
      continue;
    }

    if (frontmatterDelimiters < 2 || line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const match = /^([^:]+):\s*(.+)$/.exec(line);

    if (!match) {
      diagnostics.push({
        code: "malformed_entry",
        sourcePath: options.sourcePath,
        line: index + 1,
        message: "Expected a role followed by a colon and one or more model IDs",
      });
      continue;
    }

    const role = match[1];
    const modelsText = match[2];

    if (role === undefined || modelsText === undefined) continue;
    const normalizedRole = role.trim();
    const models = modelsText.split(",").map((model) => model.trim()).filter(Boolean);
    const duplicate = normalizedRole in roles;

    if (duplicate) {
      diagnostics.push({
        code: "duplicate_role",
        sourcePath: options.sourcePath,
        line: index + 1,
        message: `Role ${normalizedRole} was already declared`,
      });
    }

    if (!duplicate) roles[normalizedRole] = immutable(models);

    for (const model of models) {
      if (!options.availableModels.has(model)) {
        diagnostics.push({
          code: "model_unavailable",
          sourcePath: options.sourcePath,
          line: index + 1,
          message: `Model ${model} is not available`,
        });
      }
    }
  }

  return immutable({ roles: immutable(roles), diagnostics: immutable(diagnostics) });
}
