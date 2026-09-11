import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  WorkflowPackageSnapshotSchema,
  type WorkflowPackageSnapshot as StoredWorkflowPackageSnapshot,
  type WorkflowStepPhase,
} from './model.js';

const positiveInteger = z.number().int().positive();

const resourceSchema = z
  .object({
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePath: z.string().min(1),
    text: z.string(),
  })
  .strict();

const transitionKindSchema = z.enum([
  'advance',
  'repeat',
  'route',
  'await-decision',
  'block',
  'finish',
]);

const methodSchema = z.string().min(1);

const transitionSchema = z
  .object({
    from: z.string().min(1),
    kind: transitionKindSchema,
    to: z.string().min(1).optional(),
    routes: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === 'advance' || value.kind === 'repeat') && !value.to)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.kind} transitions require a target step`,
        path: ['to'],
      });
    if (value.kind === 'route' && (!value.routes || value.routes.length === 0))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'route transitions require at least one route',
        path: ['routes'],
      });
    if (
      (value.kind === 'await-decision' || value.kind === 'block' || value.kind === 'finish') &&
      (value.to || value.routes)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.kind} transitions are terminal or control boundaries`,
      });
  });

const stepSchema = z
  .object({
    name: z.string().min(1),
    resources: z.array(z.string().min(1)),
    outputContract: z.string().min(1),
    permittedMethods: z.array(methodSchema),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    requiresDistinctRole: z.boolean().default(false),
    stopBoundary: z.string().min(1).optional(),
  })
  .strict();

const limitsSchema = z
  .object({
    maxAttempts: positiveInteger,
    maxRepeats: positiveInteger,
    deadlineMs: positiveInteger,
    parallelism: positiveInteger,
    innerLoopDeadlineMs: positiveInteger,
  })
  .strict();

export const packageManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    source: z
      .object({
        kind: z.literal('local-snapshot'),
        root: z.string().min(1),
        entry: z.string().min(1),
        upstream: z
          .object({
            name: z.string().min(1),
            license: z
              .object({
                status: z.literal('verified'),
                spdx: z.literal('MIT'),
                resource: z.string().min(1),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    entryStep: z.string().min(1),
    resources: z.record(resourceSchema),
    steps: z.array(stepSchema).min(1),
    transitions: z.array(transitionSchema).min(1),
    limits: limitsSchema,
    stopBoundaries: z.array(z.string().min(1)),
    constraints: z.record(z.boolean().or(z.string()).or(z.number())),
    unresolvedReferences: z.array(
      z
        .object({
          reference: z.string().min(1),
          classification: z.literal('optional-unsupported'),
          sourcePath: z.string().min(1).optional(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    dependencyStatus: z
      .object({
        status: z.enum(['complete', 'classified-incomplete']),
        parameterizedReferences: z.array(
          z.object({ pattern: z.string().min(1), directory: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const names = new Set<string>();
    for (const [index, step] of manifest.steps.entries()) {
      if (names.has(step.name))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step ${step.name}`,
          path: ['steps', index, 'name'],
        });
      names.add(step.name);
      if (step.name === 'review' && !step.requiresDistinctRole)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'review steps require an independent role',
          path: ['steps', index, 'requiresDistinctRole'],
        });
    }
    if (!names.has(manifest.entryStep))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown entry step ${manifest.entryStep}`,
        path: ['entryStep'],
      });
    const resources = new Set(Object.keys(manifest.resources));
    for (const [index, step] of manifest.steps.entries())
      for (const resource of step.resources)
        if (!resources.has(resource))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown resource ${resource}`,
            path: ['steps', index, 'resources'],
          });
    for (const [index, transition] of manifest.transitions.entries()) {
      if (!names.has(transition.from))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown source step ${transition.from}`,
          path: ['transitions', index, 'from'],
        });
      if (transition.to && !names.has(transition.to))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown target step ${transition.to}`,
          path: ['transitions', index, 'to'],
        });
    }
  });

export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageName = string;
export type TransitionKind = z.infer<typeof transitionKindSchema>;
export type WorkflowMethod = z.infer<typeof methodSchema>;

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
      readonly kind: 'direct';
      readonly method: 'direct';
      readonly precedence: 'pstack';
      readonly packageName: 'pstack/direct';
      readonly reason: 'routine engineering work';
    }
  | {
      readonly kind: 'workflow';
      readonly method: 'pstack';
      readonly precedence: 'pstack';
      readonly packageName: PackageName;
      readonly reason: 'explicit package' | 'deterministic request classification';
    };

const bundledPackageNames = ['direct', 'bug-fix', 'refactoring', 'architect', 'feature'] as const;

type BundledPackageName = (typeof bundledPackageNames)[number];

const bundledPackageName = (value: string): BundledPackageName | undefined => {
  const name = value.startsWith('pstack/') ? value.slice('pstack/'.length) : value;
  return bundledPackageNames.find((candidate) => candidate === name);
};

const bundledPackageRoot = fileURLToPath(new URL('../../workflows/', import.meta.url));
const packageRoot = existsSync(bundledPackageRoot)
  ? bundledPackageRoot
  : resolve(process.cwd(), 'workflows');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const immutable = <Value>(value: Value): Value => {
  Object.freeze(value);
  return value;
};

const stableDigest = (manifestBytes: Uint8Array, resources: readonly PinnedResource[]) => {
  const hash = createHash('sha256');
  hash.update('manifest\0');
  hash.update(manifestBytes);
  for (const resource of [...resources].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update('\0resource\0');
    hash.update(resource.path);
    hash.update('\0');
    hash.update(resource.bytes);
  }
  return hash.digest('hex');
};

const cloneBytes = (bytes: Uint8Array): Readonly<Uint8Array> => new Uint8Array(bytes);

const phaseFor = (name: string): WorkflowStepPhase => {
  switch (name) {
    case 'design':
      return 'design';
    case 'direct':
    case 'implement':
      return 'implementation';
    case 'review':
      return 'review';
    case 'verify':
      return 'verification';
    case 'handoff':
      return 'coordination';
    default:
      return 'analysis';
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
  const parsed = packageManifestSchema.parse(manifest);
  const resources = Object.entries(parsed.resources).map(([path, resource]) => {
    const bytes = Buffer.from(resource.text, 'utf8');
    const actual = sha256(bytes);
    if (actual !== resource.sourceDigest)
      throw new Error(`package resource ${path} digest does not match manifest`);
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
  const parsedSnapshot = WorkflowPackageSnapshotSchema.parse({
    name: immutableManifest.name,
    version: immutableManifest.version,
    entryStep: immutableManifest.entryStep,
    digest: stableDigest(manifestBytes, immutableResources),
    sourceDigests: immutableResources.map((resource) => resource.sha256),
    steps: immutableManifest.steps.map(
      ({
        name,
        resources,
        outputContract,
        permittedMethods,
        requiredEvidence,
        requiresDistinctRole,
      }) => ({
        name,
        phase: phaseFor(name),
        resources,
        outputContract,
        permittedMethods,
        requiredEvidence,
        requiresDistinctRole,
      }),
    ),
    transitions: immutableManifest.transitions.map((transition) =>
      transition.kind === 'route'
        ? {
            kind: 'route' as const,
            from: transition.from,
            targets: transition.routes!.map((method) => ({ kind: 'method' as const, method })),
          }
        : transition.kind === 'advance' || transition.kind === 'repeat'
          ? { kind: transition.kind, from: transition.from, to: transition.to! }
          : { kind: transition.kind, from: transition.from },
    ),
    limits: immutableManifest.limits,
  });
  return immutable({
    ...parsedSnapshot,
    sourceDigests: immutable([...parsedSnapshot.sourceDigests]),
    steps: immutable(
      parsedSnapshot.steps.map((step) =>
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
    return statSync(requested).isDirectory() ? join(requested, 'manifest.json') : requested;
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
    raw = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid package manifest ${manifestPath}: ${String(error)}`);
  }
  const manifest = packageManifestSchema.parse(raw);
  return snapshotPackage(manifest, manifestBytes);
}

const classify = (request: string): Exclude<BundledPackageName, 'direct'> | undefined => {
  const normalized = request.toLowerCase();
  if (/\b(bug|fix|broken|regression|defect|crash)\b/.test(normalized)) return 'bug-fix';
  if (/\b(refactor|rename|extract|inline|dedup(?:licate)?|restructure)\b/.test(normalized))
    return 'refactoring';
  if (
    /\b(architect|architecture|module boundary|interface design|design a module)\b/.test(normalized)
  )
    return 'architect';
  if (/\b(feature|implement|build|add)\b/.test(normalized)) return 'feature';
  return undefined;
};

export function route(request: RouteRequest): RouteResult {
  if (request.package && bundledPackageName(request.package) === 'direct')
    return immutable({
      kind: 'direct',
      method: 'direct',
      precedence: 'pstack',
      packageName: 'pstack/direct',
      reason: 'routine engineering work',
    });
  if (request.package)
    return immutable({
      kind: 'workflow',
      method: 'pstack',
      precedence: 'pstack',
      packageName: bundledPackageName(request.package)
        ? `pstack/${bundledPackageName(request.package)}`
        : request.package,
      reason: 'explicit package',
    });
  const packageName = classify(request.request);
  if (packageName)
    return immutable({
      kind: 'workflow',
      method: 'pstack',
      precedence: 'pstack',
      packageName: `pstack/${packageName}`,
      reason: 'deterministic request classification',
    });
  return immutable({
    kind: 'direct',
    method: 'direct',
    precedence: 'pstack',
    packageName: 'pstack/direct',
    reason: 'routine engineering work',
  });
}

export interface ModelConfigDiagnostic {
  readonly code: 'duplicate_role' | 'model_unavailable' | 'malformed_entry';
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

export function importModelConfig(
  text: string,
  options: ModelConfigImportOptions,
): ModelConfigImport {
  const roles: Record<string, readonly string[]> = {};
  const diagnostics: ModelConfigDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  let frontmatterDelimiters = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '---') {
      frontmatterDelimiters += 1;
      continue;
    }
    if (frontmatterDelimiters < 2 || line.trim() === '' || line.trimStart().startsWith('#'))
      continue;
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    if (!match) {
      diagnostics.push({
        code: 'malformed_entry',
        sourcePath: options.sourcePath,
        line: index + 1,
        message: 'Expected a role followed by a colon and one or more model IDs',
      });
      continue;
    }
    const role = match[1].trim();
    const models = match[2]
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    const duplicate = role in roles;
    if (duplicate) {
      diagnostics.push({
        code: 'duplicate_role',
        sourcePath: options.sourcePath,
        line: index + 1,
        message: `Role ${role} was already declared`,
      });
    }
    if (!duplicate) roles[role] = immutable(models);
    for (const model of models)
      if (!options.availableModels.has(model))
        diagnostics.push({
          code: 'model_unavailable',
          sourcePath: options.sourcePath,
          line: index + 1,
          message: `Model ${model} is not available`,
        });
  }
  return immutable({ roles: immutable(roles), diagnostics: immutable(diagnostics) });
}
