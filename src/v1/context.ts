import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const absolutePath = z.string().refine(isAbsolute, 'Expected an absolute path');
export const bindingSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().uuid(),
    hostId: z.string().uuid(),
    repositoryRoot: absolutePath,
    stateDirectory: absolutePath,
    databasePath: absolutePath,
  })
  .strict();
export type ProjectBinding = z.infer<typeof bindingSchema>;

export const contextSchema = z
  .object({
    version: z.literal(1),
    bindingPath: absolutePath,
    projectId: z.string().uuid(),
    hostId: z.string().uuid(),
    sessionId: z.string().min(1),
    generation: z.number().int().positive(),
    token: z.string().min(32),
    parentWorkflowId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
  })
  .strict();
export type SessionContext = z.infer<typeof contextSchema>;
export type ResolvedContext = {
  binding: ProjectBinding;
  bindingPath: string;
  session: SessionContext | null;
};

const hostSchema = z.object({ version: z.literal(1), hostId: z.string().uuid() }).strict();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function createJson(path: string, value: object): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.MARIONETTE_STATE_HOME ??
      join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'marionette', 'v1'),
  );
}

export function localHostId(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'host.json');
  try {
    return hostSchema.parse(readJson(path)).hostId;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const host = { version: 1, hostId: randomUUID() };
  try {
    createJson(path, host);
    return host.hostId;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    return hostSchema.parse(readJson(path)).hostId;
  }
}

export function createBinding(options: {
  repositoryRoot: string;
  stateRoot: string;
}): ResolvedContext {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const bindingPath = join(repositoryRoot, '.marionette-v1', 'project.json');
  const hostId = localHostId(options.stateRoot);
  try {
    const binding = bindingSchema.parse(readJson(bindingPath));
    if (binding.hostId !== hostId) throw new Error('Project belongs to another execution host');
    return { binding, bindingPath, session: null };
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const projectId = randomUUID();
  const stateDirectory = join(resolve(options.stateRoot), 'projects', projectId);
  const binding: ProjectBinding = {
    version: 1,
    projectId,
    hostId,
    repositoryRoot,
    stateDirectory,
    databasePath: join(stateDirectory, 'project.sqlite'),
  };
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(bindingPath), { recursive: true });
  createJson(bindingPath, binding);
  return { binding, bindingPath, session: null };
}

export function resolveContext(
  options: { cwd?: string; bindingPath?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedContext {
  const env = options.env ?? process.env;
  const session = env.MARIONETTE_CONTEXT
    ? contextSchema.parse(readJson(env.MARIONETTE_CONTEXT))
    : null;
  let bindingPath = session?.bindingPath ?? options.bindingPath;
  if (!bindingPath) {
    let directory = realpathSync(options.cwd ?? process.cwd());
    for (;;) {
      const candidate = join(directory, '.marionette-v1', 'project.json');
      try {
        readFileSync(candidate);
        bindingPath = candidate;
        break;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error('No Marionette v1 project found. Run marionette init in the repository.');
      directory = parent;
    }
  }
  const binding = bindingSchema.parse(readJson(bindingPath));
  if (binding.hostId !== localHostId(stateRoot(env)))
    throw new Error('Project belongs to another execution host');
  if (session && (session.hostId !== binding.hostId || session.projectId !== binding.projectId)) {
    throw new Error('Session context does not match its project binding');
  }
  if (
    session &&
    options.bindingPath &&
    realpathSync(options.bindingPath) !== realpathSync(bindingPath)
  ) {
    throw new Error('Managed sessions cannot switch project bindings');
  }
  return { binding, bindingPath: resolve(bindingPath), session };
}

export function writeSessionContext(options: {
  stateDirectory: string;
  context: SessionContext;
}): string {
  const context = contextSchema.parse(options.context);
  const directory = join(options.stateDirectory, 'contexts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  createJson(path, context);
  return path;
}
