import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { automaticStage, boardStages, stageMarker } from './lifecycle.mjs';

const directory = import.meta.dir;
const repositoryRoot = process.env.MARIONETTE_REPOSITORY ?? join(directory, '../..');
const projectPath =
  process.env.MARIONETTE_PROJECT ?? join(repositoryRoot, '.marionette-v1', 'project.json');
const cli =
  process.env.MARIONETTE_CLI ?? Bun.which('marionette') ?? join(repositoryRoot, 'dist/v1/cli.js');
const port = Number(process.env.MARIONETTE_DASHBOARD_PORT ?? 4179);
const refreshMs = Number(process.env.MARIONETTE_DASHBOARD_REFRESH_MS ?? 2000);
const enrichmentModel = process.env.MARIONETTE_ENRICH_MODEL ?? 'gpt-5-nano';
const openAIKey = process.env.OPENAI_API_KEY ?? '';
const clients = new Set();
let refreshing = false;
const writableStages = new Set([...boardStages, automaticStage]);

async function run(args) {
  if (!existsSync(cli)) throw new Error(`CLI executable not found at ${cli}`);
  if (!existsSync(projectPath)) throw new Error(`project binding not found at ${projectPath}`);
  const child = Bun.spawn([cli, ...args, '--project', projectPath, '--output', 'json'], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${args.join(' ')} exited with ${exitCode}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${args.join(' ')} returned invalid JSON`);
  }
}

async function read(label, args, fallback) {
  try {
    return { label, value: await run(args), error: null };
  } catch (error) {
    return {
      label,
      value: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readUsing(label, action, fallback) {
  try {
    return { label, value: await action(), error: null };
  } catch (error) {
    return {
      label,
      value: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function allBoardThreads() {
  const entries = [];
  let cursor;
  do {
    const page = await run([
      'board',
      'list',
      '--limit',
      '100',
      ...(cursor ? ['--cursor', cursor] : []),
    ]);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { entries, nextCursor: null };
}

async function allBoardMessages(threads) {
  const groups = await Promise.all(
    threads.map(async (thread) => {
      const entries = [];
      let cursor;
      do {
        const page = await run([
          'board',
          'read',
          '--thread-id',
          thread.id,
          '--limit',
          '100',
          ...(cursor ? ['--cursor', cursor] : []),
        ]);
        entries.push(
          ...page.entries.map((post) => ({
            ...post,
            threadTitle: thread.title,
            jobId: thread.jobId,
          })),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return entries;
    }),
  );
  return groups.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function jsonResponse(value, status = 200) {
  return Response.json(value, { status, headers: assetHeaders });
}

function stringValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value.trim();
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : [];
}

function safeSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || `human-request-${Date.now()}`;
}

function normalizedIntake(value, sourceMessage, context) {
  const objective = stringValue(value.objective ?? sourceMessage, 'objective');
  const availableWorkspaces = context.availableWorkspaces;
  const proposedWorkspace = String(value.workspaceId ?? '').trim();
  const workspaceId = proposedWorkspace || availableWorkspaces[0] || 'project';
  const delivery = ['report', 'patch', 'commit'].includes(value.delivery) ? value.delivery : 'report';
  const argumentsValue = {
    stableKey: safeSlug(value.stableKey ?? objective),
    workspaceId,
    delivery,
    prompt: stringValue(value.prompt ?? objective, 'prompt'),
    scope: stringList(value.scope),
    ownership: stringList(value.ownership),
    constraints: stringList(value.constraints),
    standingOrders: stringList(value.standingOrders),
    dependencies: stringList(value.dependencies),
  };
  return {
    summary: String(value.summary ?? objective).trim().slice(0, 500),
    clarificationQuestions: stringList(value.clarificationQuestions).slice(0, 5),
    assumptions: stringList(value.assumptions).slice(0, 8),
    marionette: {
      operation: 'job.create',
      endpoint: '/api/jobs',
      arguments: argumentsValue,
    },
  };
}

async function intakeContext() {
  const [context, jobs, workflows, profiles] = await Promise.all([
    run(['context']),
    run(['job', 'list']),
    run(['workflow', 'list']),
    run(['profile', 'list']),
  ]);
  const recentJobs = jobs.slice(-20).map((job) => ({
    key: job.key,
    workspaceId: job.workspaceId,
    delivery: job.delivery,
    state: job.state,
  }));
  return {
    project: {
      id: context.project?.id,
      repositoryRoot: context.project?.repositoryRoot,
    },
    availableWorkspaces: [...new Set(recentJobs.map((job) => job.workspaceId).filter(Boolean))],
    recentJobs,
    activeWorkflows: workflows.slice(-10).map((workflow) => ({
      id: workflow.id,
      name: workflow.package?.name,
      phase: workflow.phase,
    })),
    availableProfiles: profiles.map((profile) => ({ name: profile.name, kind: profile.kind, model: profile.model })),
  };
}

function localIntake(message, context) {
  const delivery = /\bcommit\b/i.test(message)
    ? 'commit'
    : /\b(add|build|change|create|fix|implement|patch|refactor|remove|update)\b/i.test(message)
      ? 'patch'
      : 'report';
  return normalizedIntake({
    objective: message,
    summary: message,
    stableKey: message,
    workspaceId: context.availableWorkspaces[0] ?? 'project',
    delivery,
    prompt: [
      `Objective: ${message}`,
      'Acceptance criteria: Deliver the requested outcome and verify it proportionally to risk.',
      'Constraints: Preserve unrelated work, report blockers honestly, and do not expand authority.',
      'Evidence: Record the checks and concrete artifacts that establish completion.',
    ].join('\n\n'),
    scope: [message],
    ownership: ['Work only in the bound Marionette project and the selected workspace.'],
    constraints: ['Preserve unrelated work.', 'Do not infer authority for deployment, publication, or destructive cleanup.'],
    standingOrders: ['Verify the requested outcome before recording completion.', 'Distinguish implemented, verified, blocked, and proposed work.'],
    dependencies: [],
    clarificationQuestions: [],
    assumptions: ['Workspace and delivery were inferred locally because model enrichment is not configured.'],
  }, message, context);
}

async function modelIntake(message, context) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'objective', 'stableKey', 'workspaceId', 'delivery', 'prompt', 'scope', 'ownership', 'constraints', 'standingOrders', 'dependencies', 'clarificationQuestions', 'assumptions'],
    properties: {
      summary: { type: 'string' },
      objective: { type: 'string' },
      stableKey: { type: 'string' },
      workspaceId: { type: 'string' },
      delivery: { type: 'string', enum: ['report', 'patch', 'commit'] },
      prompt: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      ownership: { type: 'array', items: { type: 'string' } },
      constraints: { type: 'array', items: { type: 'string' } },
      standingOrders: { type: 'array', items: { type: 'string' } },
      dependencies: { type: 'array', items: { type: 'string' } },
      clarificationQuestions: { type: 'array', items: { type: 'string' } },
      assumptions: { type: 'array', items: { type: 'string' } },
    },
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAIKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: enrichmentModel,
      input: [
        {
          role: 'system',
          content: 'Turn one informal human request into a precise Marionette job. Use only supplied project context. Do not invent files, IDs, requirements, or authority. Ask at most five targeted clarification questions only when the missing answer materially changes the work. Produce a concise executable prompt with objective, acceptance criteria, constraints, and evidence expectations.',
        },
        { role: 'user', content: JSON.stringify({ message, context }) },
      ],
      max_output_tokens: 1400,
      text: { format: { type: 'json_schema', name: 'marionette_human_intake', strict: true, schema } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `OpenAI enrichment failed (${response.status})`);
  const outputText = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
  if (!outputText) throw new Error('OpenAI enrichment returned no structured output');
  let parsed;
  try { parsed = JSON.parse(outputText); } catch { throw new Error('OpenAI enrichment returned invalid JSON'); }
  return normalizedIntake(parsed, message, context);
}

async function enrichIntake(value) {
  const message = stringValue(value.message, 'message');
  if (message.length > 12_000) throw new Error('message must be 12,000 characters or fewer');
  const context = await intakeContext();
  const result = openAIKey ? await modelIntake(message, context) : localIntake(message, context);
  return {
    ...result,
    sourceMessage: message,
    context: {
      projectId: context.project.id,
      repositoryRoot: context.project.repositoryRoot,
      availableWorkspaces: context.availableWorkspaces,
      recentJobCount: context.recentJobs.length,
      activeWorkflowCount: context.activeWorkflows.length,
    },
    enrichment: openAIKey
      ? { kind: 'model', model: enrichmentModel, enriched: true }
      : { kind: 'local-structure', model: null, enriched: false, reason: 'OPENAI_API_KEY is not configured for the dashboard process.' },
  };
}

function intakeContract() {
  return {
    endpoint: '/api/intake/enrich',
    method: 'POST',
    request: { message: 'string (required, maximum 12,000 characters)' },
    response: {
      enrichment: '{ kind, model, enriched, reason? }',
      clarificationQuestions: 'string[]',
      assumptions: 'string[]',
      marionette: { operation: 'job.create', endpoint: '/api/jobs', arguments: '{ stableKey, workspaceId, delivery, prompt, scope, ownership, constraints, standingOrders, dependencies }' },
    },
  };
}

async function input(request) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 256_000) throw new Error('Request body is too large');
  const value = await request.json();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected one JSON object');
  return value;
}

async function write(operation, value, options = []) {
  const [group, action] = operation.split('.');
  const watcherOptions = operation === 'board.post' ? ['--no-watch'] : [];
  return run([group, action, '--json', JSON.stringify(value), ...watcherOptions, ...options]);
}

async function jobThread(job) {
  const threads = await allBoardThreads();
  const existing = threads.entries.find((thread) => thread.jobId === job.id);
  if (existing) return existing;
  return write('board.create', {
    title: `Job · ${job.key}`,
    jobId: job.id,
    idempotencyKey: `dashboard-thread-${job.id}`,
  });
}

async function postToJob(job, { body, kind, references = [] }) {
  const thread = await jobThread(job);
  const post = await write('board.post', {
    threadId: thread.id,
    body,
    kind,
    references,
    idempotencyKey: `dashboard-post-${randomUUID()}`,
  });
  return { thread, post };
}

async function createJob(value) {
  const stableKey = stringValue(value.stableKey, 'stableKey');
  const prompt = stringValue(value.prompt, 'prompt');
  const workspaceId = stringValue(value.workspaceId, 'workspaceId');
  const delivery = stringValue(value.delivery, 'delivery');
  if (!['report', 'patch', 'commit'].includes(delivery)) throw new Error('delivery is invalid');
  const job = await write('job.create', {
    stableKey,
    request: {
      text: prompt,
      digest: createHash('sha256').update(prompt).digest('hex'),
      inputSnapshots: [],
    },
    brief: {
      objective: prompt,
      scope: stringList(value.scope),
      ownership: stringList(value.ownership),
      constraints: stringList(value.constraints),
      standingOrders: stringList(value.standingOrders),
      inputSnapshots: [],
    },
    workspaceId,
    delivery,
    dependencies: stringList(value.dependencies),
    idempotencyKey: `dashboard-job-${randomUUID()}`,
  });
  return { job, warnings: [] };
}

async function jobDetails(jobId) {
  const [job, brief, threads] = await Promise.all([
    run(['job', 'get', '--id', jobId]),
    run(['job', 'brief', '--id', jobId]),
    allBoardThreads(),
  ]);
  const thread = threads.entries.find((entry) => entry.jobId === jobId) ?? null;
  const messages = thread ? await allBoardMessages([thread]) : [];
  return {
    job,
    brief,
    thread,
    posts: messages.map((post) => ({
      id: post.id,
      thread_id: post.threadId,
      sequence: post.sequence,
      source_author_kind: post.author?.kind,
      source_author_id: post.author?.id,
      kind: post.kind,
      body: post.body,
      created_at: post.createdAt,
    })),
  };
}

async function snapshot() {
  const [context, jobs, workflows, board, profiles, results, recordedResultJobs, sessions] = await Promise.all([
    read('context', ['context'], null),
    read('jobs', ['job', 'list'], []),
    read('workflows', ['workflow', 'list'], []),
    readUsing('board', allBoardThreads, { entries: [], nextCursor: null }),
    read('profiles', ['profile', 'list'], []),
    read(
      'results',
      [
        'sql',
        'read',
        '--sql',
        'SELECT * FROM public_results ORDER BY created_at DESC',
        '--max-rows',
        '1000',
      ],
      { rows: [], truncated: false },
    ),
    read(
      'recordedResultJobs',
      ['sql', 'read', '--sql', 'SELECT job_id FROM public_results GROUP BY job_id ORDER BY job_id', '--max-rows', '1000'],
      { rows: [], truncated: false },
    ),
    read(
      'sessions',
      [
        'sql',
        'read',
        '--sql',
        'SELECT id,generation,host_id,workspace_id,role,execution_role,native_kind,native_locator,state,created_at,settled_at FROM public_agent_sessions ORDER BY created_at DESC',
        '--max-rows',
        '100',
      ],
      { rows: [], truncated: false },
    ),
  ]);
  const boardMessages = board.error
    ? { label: 'boardMessages', value: [], error: board.error }
    : await readUsing('boardMessages', () => allBoardMessages(board.value.entries), []);

  const currentAttemptId = context.value?.session?.attemptId ?? null;
  const currentAttempt = currentAttemptId
    ? await read('currentAttempt', ['attempt', 'get', '--id', currentAttemptId], null)
    : { label: 'currentAttempt', value: null, error: null };
  const reads = [
    context,
    jobs,
    workflows,
    board,
    boardMessages,
    profiles,
    results,
    recordedResultJobs,
    sessions,
    currentAttempt,
  ];

  return {
    capturedAt: new Date().toISOString(),
    source: {
      repositoryRoot,
      projectPath,
      cli,
      readOnly: false,
      refreshMs,
      enrichment: {
        available: Boolean(openAIKey),
        model: openAIKey ? enrichmentModel : null,
        fallback: 'local-structure',
      },
    },
    context: context.value,
    jobs: jobs.value,
    workflows: workflows.value,
    board: board.value,
    boardMessages: boardMessages.value,
    profiles: profiles.value,
    results: results.value,
    sessions: sessions.value,
    attempts: {
      current: currentAttempt.value,
      scope: currentAttemptId ? 'current-session' : 'unavailable',
      limitation:
        'The Marionette CLI has no attempt.list operation and public_agent_sessions does not expose attempt IDs.',
    },
    lifecycle: {
      resultAcceptance: {
        available: false,
        reason:
          'Marionette v1 alpha exposes recorded results but no public result-acceptance inventory.',
      },
      recordedResults: {
        available: recordedResultJobs.error === null,
        truncated: recordedResultJobs.value.truncated === true,
      },
      recordedResultJobIds: recordedResultJobs.value.rows.map((row) => row.job_id),
      acceptedResultJobIds: [],
    },
    reads: Object.fromEntries(
      reads.map((entry) => [entry.label, { ok: entry.error === null, error: entry.error }]),
    ),
    errors: reads
      .filter((entry) => entry.error)
      .map((entry) => ({ source: entry.label, message: entry.error })),
  };
}

async function writeEvent(writer, event, value) {
  await writer.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
}

async function publish(value) {
  await Promise.allSettled(
    [...clients].map(async (writer) => {
      try {
        await writeEvent(writer, 'snapshot', value);
      } catch {
        clients.delete(writer);
      }
    }),
  );
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await publish(await snapshot());
  } finally {
    refreshing = false;
  }
}

const assetHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const jobRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    const commentRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/comments$/);
    const stageRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stage$/);
    try {
      if (request.method === 'GET' && url.pathname === '/api/intake/schema')
        return jsonResponse(intakeContract());
      if (request.method === 'POST' && url.pathname === '/api/intake/enrich')
        return jsonResponse(await enrichIntake(await input(request)));
      if (request.method === 'GET' && jobRoute)
        return jsonResponse(await jobDetails(decodeURIComponent(jobRoute[1])));
      if (request.method === 'POST' && url.pathname === '/api/jobs')
        return jsonResponse(await createJob(await input(request)), 201);
      if (request.method === 'POST' && commentRoute) {
        const value = await input(request);
        const job = await run(['job', 'get', '--id', decodeURIComponent(commentRoute[1])]);
        const body = stringValue(value.body, 'body');
        if (body.startsWith(stageMarker.trimEnd())) throw new Error('comments cannot use the reserved Project Board stage marker');
        const kind = value.kind === 'question' ? 'question' : 'progress';
        return jsonResponse(
          await postToJob(job, {
            body,
            kind,
            references: [{ kind: 'job-id', value: job.id }],
          }),
          201,
        );
      }
      if (request.method === 'POST' && stageRoute) {
        const value = await input(request);
        const stage = stringValue(value.stage, 'stage');
        if (!writableStages.has(stage)) throw new Error('stage is invalid');
        const job = await run(['job', 'get', '--id', decodeURIComponent(stageRoute[1])]);
        return jsonResponse(
          await postToJob(job, {
            body: `${stageMarker}${stage}`,
            kind: 'progress',
            references: [
              { kind: 'project-board-stage', value: stage },
              { kind: 'job-id', value: job.id },
            ],
          }),
          201,
        );
      }
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    if (url.pathname === '/api/snapshot')
      return jsonResponse(await snapshot());
    if (url.pathname === '/api/events') {
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      clients.add(writer);
      writeEvent(writer, 'connected', { refreshMs }).catch(() => clients.delete(writer));
      request.signal.addEventListener('abort', () => {
        clients.delete(writer);
        writer.close().catch(() => {});
      });
      return new Response(stream.readable, {
        headers: {
          ...assetHeaders,
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
        },
      });
    }
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(Bun.file(join(directory, 'index.html')), {
        headers: { ...assetHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    if (url.pathname === '/client.js')
      return new Response(Bun.file(join(directory, 'client.js')), {
        headers: { ...assetHeaders, 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    if (url.pathname === '/lifecycle.mjs')
      return new Response(Bun.file(join(directory, 'lifecycle.mjs')), {
        headers: { ...assetHeaders, 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    if (url.pathname === '/style.css')
      return new Response(Bun.file(join(directory, 'style.css')), {
        headers: { ...assetHeaders, 'Content-Type': 'text/css; charset=utf-8' },
      });
    return new Response('Not found', { status: 404, headers: assetHeaders });
  },
});

console.log(
  JSON.stringify({
    url: `http://${server.hostname}:${server.port}/`,
    projectPath,
    cli,
    readOnly: false,
    refreshMs,
  }),
);
await refresh();
setInterval(refresh, refreshMs);
