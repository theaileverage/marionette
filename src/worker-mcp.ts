import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Effect } from 'effect';
import { z } from 'zod';
import { mcpResult } from './mcp-result.js';
import { serveMcpEffect } from './mcp-transport.js';
import { workerRequestEffect } from './server-control.js';
import { VERSION } from './version.js';

/** The worker token authorizes only this task and its permitted descendants, never lead actions. */
export function workerMcpServer() {
  const server = new McpServer(
    { name: 'marionette-worker', version: VERSION },
    {
      instructions:
        'Use worker_inspect before editing, worker_files for scoped file inspection without a shell, and worker_report to report progress, blockers, or completion. Check isError before using any result. These tools use your existing scoped worker identity; never read or supply credentials. Delegation requires explicit assignment authority.',
    },
  );
  server.registerTool(
    'worker_files',
    {
      description:
        'Inspect files inside this assignment without a shell. Use list for a directory or read with line bounds. Private runtime and Git metadata are excluded.',
      inputSchema: {
        action: z.enum(['read', 'list']),
        revision: z.number().int().min(1),
        path: z.string(),
        startLine: z.number().int().min(1).default(1),
        maxLines: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input) => mcpResult(workerRequestEffect('worker-call', input)),
  );
  server.registerTool(
    'worker_inspect',
    {
      description:
        'Read the current assignment, outcome criteria and revisions. Omit taskId for the full current contract; taskId may select this task or a descendant. Safe to retry.',
      inputSchema: { taskId: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      mcpResult(
        workerRequestEffect(
          'worker-call',
          input.taskId ? { action: 'inspect', taskId: input.taskId } : { action: 'inspect' },
        ),
      ),
  );
  server.registerTool(
    'worker_report',
    {
      description:
        'Report against the revision returned by worker_inspect. Completion triggers independent verification. On a transport failure, inspect the receipt before retrying: the report may already have arrived.',
      inputSchema: {
        revision: z.number().int().min(1),
        type: z.enum(['progress', 'blocked', 'complete', 'failure', 'yield']),
        summary: z.string().min(1).max(20000),
        artifacts: z.array(z.string()).default([]),
        evidence: z.array(z.string()).default([]),
        children: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => {
      const { children, ...report } = input;
      return mcpResult(
        workerRequestEffect('worker-report', children ? { ...report, children } : report),
      );
    },
  );
  server.registerTool(
    'worker_call',
    {
      description:
        'Use current revision from worker_inspect. message.ack needs messageId; message.send needs key, taskId, text and optional references (parent or authorized descendants only); activity needs state (busy, idle, external-wait), detail and optional until (Unix ms); decision.open needs key, text, options and optional blocking. finding needs summary and evidence. delegate/revise/control require explicit delegation authority.',
      inputSchema: {
        request: z
          .object({
            action: z.enum([
              'finding',
              'delegate',
              'revise',
              'control',
              'message.send',
              'message.ack',
              'activity',
              'decision.open',
            ]),
            revision: z.number().int().min(1),
          })
          .catchall(z.any()),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => mcpResult(workerRequestEffect('worker-call', input.request)),
  );
  return server;
}

export const workerMcpEffect = Effect.fn('Worker.mcp')(function* () {
  // A required MCP server must prove the scoped reporting path works before agent startup succeeds.
  yield* workerRequestEffect('worker-call', { action: 'inspect' });
  yield* serveMcpEffect(workerMcpServer());
});

/** Only configuration and environment variable names enter argv; credentials remain in the environment. */
export function workerMcpArgs(executable: string, cliPath: string) {
  return Object.entries({
    command: executable,
    args: [cliPath, 'worker-mcp'],
    env_vars: ['MARIONETTE_URL', 'MARIONETTE_TASK_ID', 'MARIONETTE_WORKER_TOKEN'],
    enabled: true,
    required: true,
    startup_timeout_sec: 20,
    tool_timeout_sec: 20,
  }).flatMap(([key, value]) => [
    '-c',
    `mcp_servers.marionette_worker.${key}=${JSON.stringify(value)}`,
  ]);
}
