import { randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Schema } from "effect";

const absolutePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, { expected: "an absolute path" }),
);

const uuid = Schema.String.check(Schema.isUUID());

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const bindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  projectId: uuid,
  hostId: uuid,
  repositoryRoot: absolutePath,
  stateDirectory: absolutePath,
  databasePath: absolutePath,
});

export type ProjectBinding = typeof bindingSchema.Type;

export const contextSchema = Schema.Struct({
  version: Schema.Literal(1),
  bindingPath: absolutePath,
  projectId: uuid,
  hostId: uuid,
  sessionId: nonEmptyString,
  generation: Schema.Finite.check(
    Schema.makeFilter(Number.isInteger, { expected: "an integer" }),
    Schema.isGreaterThan(0),
  ),
  token: Schema.String.check(Schema.isMinLength(32)),
  parentWorkflowId: Schema.optional(nonEmptyString),
  attemptId: Schema.optional(nonEmptyString),
});

export type SessionContext = typeof contextSchema.Type;

export type ResolvedContext = {
  binding: ProjectBinding;
  bindingPath: string;
  session: SessionContext | null;
};

const hostSchema = Schema.Struct({ version: Schema.Literal(1), hostId: uuid });

function decodeStrict<S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
}

function readJson<S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S): S["Type"] {
  return decodeStrict(schema, JSON.parse(readFileSync(path, "utf8")));
}

function missing<T>(error: T): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function createJson<T>(path: string, value: T): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.MARIONETTE_STATE_HOME ??
      join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "marionette", "v1"),
  );
}

export function localHostId(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "host.json");

  try {
    return readJson(path, hostSchema).hostId;
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const host = hostSchema.make({ version: 1, hostId: randomUUID() });

  try {
    createJson(path, host);

    return host.hostId;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;

    return readJson(path, hostSchema).hostId;
  }
}

export function createBinding(options: {
  repositoryRoot: string;
  stateRoot: string;
}): ResolvedContext {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const bindingPath = join(repositoryRoot, ".marionette", "project.json");
  const legacyBindingPath = join(repositoryRoot, ".marionette-v1", "project.json");
  const hostId = localHostId(options.stateRoot);

  try {
    const binding = readJson(bindingPath, bindingSchema);

    if (binding.hostId !== hostId) throw new Error("Project belongs to another execution host");

    return { binding, bindingPath, session: null };
  } catch (error) {
    if (!missing(error)) throw error;
  }

  // Retain the old file for managed sessions whose inherited context names it.
  // A fresh init reuses the same project identity under the current path.
  try {
    const legacy = readJson(legacyBindingPath, bindingSchema);

    if (legacy.hostId !== hostId) throw new Error("Project belongs to another execution host");
    mkdirSync(dirname(bindingPath), { recursive: true });

    try {
      createJson(bindingPath, legacy);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }

    const binding = readJson(bindingPath, bindingSchema);

    if (binding.projectId !== legacy.projectId || binding.hostId !== legacy.hostId)
      throw new Error("Current and legacy project bindings disagree");

    return { binding, bindingPath, session: null };
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const projectId = randomUUID();
  const stateDirectory = join(resolve(options.stateRoot), "projects", projectId);

  const binding = bindingSchema.make({
    version: 1,
    projectId,
    hostId,
    repositoryRoot,
    stateDirectory,
    databasePath: join(stateDirectory, "project.sqlite"),
  });

  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(bindingPath), { recursive: true });
  createJson(bindingPath, binding);

  return { binding, bindingPath, session: null };
}

export function resolveContext(
  options: { cwd?: string; bindingPath?: string; env?: NodeJS.ProcessEnv; readOnly?: boolean } = {},
): ResolvedContext {
  const env = options.env ?? process.env;
  const inheritedContext = process.env.MARIONETTE_CONTEXT || env.MARIONETTE_CONTEXT;
  const session = inheritedContext ? readJson(inheritedContext, contextSchema) : null;
  let bindingPath = session?.bindingPath ?? options.bindingPath;

  if (!bindingPath) {
    let directory = realpathSync(options.cwd ?? process.cwd());

    for (;;) {
      for (const name of [".marionette", ".marionette-v1"]) {
        const candidate = join(directory, name, "project.json");

        try {
          readFileSync(candidate);
          bindingPath = candidate;
          break;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }

      if (bindingPath) break;

      const parent = dirname(directory);

      if (parent === directory) {
        throw new Error("No Marionette v1 project found. Run marionette init in the repository.");
      }

      directory = parent;
    }
  }

  const binding = readJson(bindingPath, bindingSchema);

  const hostId = options.readOnly
    ? readJson(join(stateRoot(env), "host.json"), hostSchema).hostId
    : localHostId(stateRoot(env));

  if (binding.hostId !== hostId) throw new Error("Project belongs to another execution host");

  if (session && (session.hostId !== binding.hostId || session.projectId !== binding.projectId)) {
    throw new Error("Session context does not match its project binding");
  }

  if (
    session &&
    options.bindingPath &&
    realpathSync(options.bindingPath) !== realpathSync(bindingPath)
  ) {
    throw new Error("Managed sessions cannot switch project bindings");
  }

  return { binding, bindingPath: resolve(bindingPath), session };
}

export function writeSessionContext(options: {
  stateDirectory: string;
  context: SessionContext;
}): string {
  const session = decodeStrict(contextSchema, options.context);
  const directory = join(options.stateDirectory, "contexts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  createJson(path, session);

  return path;
}

export function localSessionContext(resolved: ResolvedContext, readOnly = false): SessionContext {
  if (resolved.session) return resolved.session;
  const path = join(resolved.binding.stateDirectory, "local-user.json");

  try {
    return readJson(path, contextSchema);
  } catch (error) {
    if (!missing(error)) throw error;
  }

  if (readOnly) throw new Error("A local session must already exist before previewing retirement.");

  const session = contextSchema.make({
    version: 1,
    bindingPath: resolved.bindingPath,
    projectId: resolved.binding.projectId,
    hostId: resolved.binding.hostId,
    sessionId: `user-${randomUUID()}`,
    generation: 1,
    token: randomBytes(32).toString("hex"),
  });

  try {
    createJson(path, session);

    return session;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;

    return readJson(path, contextSchema);
  }
}
