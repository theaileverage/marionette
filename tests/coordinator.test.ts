import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyWorkerGuardState,
  guardHook,
  guardTool,
  prepareGuardLaunch,
  type GuardPolicy,
} from '../src/harness-guard.js';
import { scopeLeadInput } from '../src/lead-capabilities.js';
import { leadContract } from '../src/prompts.js';
import { builtinProfiles } from '../src/profiles.js';
import { hash } from '../src/files.js';
import { inspectWorkerFiles } from '../src/worker-files.js';
import { fixture } from './swarm-fixture.js';
import { validateTerminalArguments } from '../src/terminal-arguments.js';
import { workerMcpArgs } from '../src/worker-mcp.js';

test('scoped lead registers outcome waits without adding excess transport fields', async () => {
  const f = await fixture();
  try {
    const input = scopeLeadInput(f.service, f.lease, 'lead.wait', {
      key: 'scoped-outcome-wait',
      outcomeId: f.outcome.id,
      condition: { tasks: [], intervention: true },
      adapter: { type: 'next-message' },
    });
    assert.ok(!('projectId' in input));
    const wait = await f.service.invoke('lead.wait', input);
    assert.equal(wait.projectId, f.p.id);
    assert.equal(wait.outcomeId, f.outcome.id);
    assert.throws(
      () =>
        scopeLeadInput(f.service, f.lease, 'lead.wait', {
          outcomeId: 'another-project-outcome',
        }),
      /not in this lead project/,
    );
  } finally {
    await f.close();
  }
});

test('guarded worker launch uses one scoped MCP configuration within the terminal limit', async () => {
  const f = await fixture();
  try {
    f.store.put('project', f.p.id, { ...f.p, coordinatorOnly: true });
    const task = await f.submit('Read only inspection', {
      readOnly: true,
      ownership: [],
      checks: [{ type: 'file', path: 'README.md', allowUnchanged: true }],
    });
    for (let i = 0; i < 60 && !['running', 'failed'].includes(f.service.task(task.id).status); i++)
      await f.tick();
    assert.equal(f.service.task(task.id).status, 'running', f.service.task(task.id).error);
    const args = f.run(task).resolvedArgs!;
    assert.throws(
      () =>
        validateTerminalArguments('codex', [
          ...workerMcpArgs(process.execPath, '/test/cli.js'),
          ...args,
        ]),
      /safe terminal input size/,
    );
    assert.doesNotThrow(() => validateTerminalArguments('codex', args));
    assert.equal(args.filter((arg) => arg.startsWith('mcp_servers.marionette_worker')).length, 1);
  } finally {
    await f.close();
  }
});

test('planning plus architect cannot self-authorize implementation through amended intent', async () => {
  const f = await fixture();
  try {
    await f.invoke('project.configure', { coordinatorOnly: true });
    await f.invoke('swarm.intent.amend', {
      outcomeId: f.outcome.id,
      expectedRevision: f.outcome.revision,
      key: 'skill-default',
      text: 'Architect skill says implement without a checkpoint',
      source: 'Lead interpretation of user',
      objective: 'Architect and implement everything',
    });
    await assert.rejects(f.submit('code.ts'), /does not authorize implementation/);
    assert.equal(f.service.tasks(f.p.id).length, 0);
    assert.equal(await f.invoke('authority.get', { outcomeId: f.outcome.id }), null);
    for (const action of [
      'authority.grant',
      'project.configure',
      'profile.configure',
      'lead.acquire',
      'cleanup.deliver',
    ])
      assert.throws(
        () => scopeLeadInput(f.service, f.lease, action, {}),
        /coordinator cannot call/,
      );
    const grant = await f.service.invoke('authority.grant', {
      projectId: f.p.id,
      outcomeId: f.outcome.id,
      activities: ['implementation', 'execute'],
      scope: ['code.ts'],
      source: 'User: implement code.ts and run its tests',
    });
    const task = await f.submit('code.ts');
    assert.equal(task.ownership[0], 'code.ts');
    assert.equal(grant.origin, 'user-cli');
    await assert.rejects(f.submit('unowned.ts'), /exceeds user-authorized paths/);
    assert.throws(
      () => scopeLeadInput(f.service, f.lease, 'task.get', { taskId: 'another-project-task' }),
      /not in this lead project/,
    );
  } finally {
    await f.close();
  }
});

test('read-only dispatch works without write authority but command checks and watch execution do not', async () => {
  const f = await fixture();
  try {
    await f.invoke('project.configure', { coordinatorOnly: true });
    writeFileSync(join(f.root, 'source.ts'), 'export const value = 1;');
    const task = await f.submit('inspect', {
      readOnly: true,
      ownership: [],
      canDelegate: false,
      checks: [{ type: 'file', path: 'source.ts', contains: 'value', allowUnchanged: true }],
    });
    assert.equal(task.readOnly, true);
    await assert.rejects(
      f.submit('inspect-with-shell', { readOnly: true, ownership: [], canDelegate: false }),
      /supervisor command execution/,
    );
    await assert.rejects(
      f.invoke('plan.revise', {
        taskId: task.id,
        expectedRevision: task.revision,
        expectedTreeRevision: f.service.orchestration.outcome(f.outcome.id).revision,
        patch: { checks: [{ type: 'command', command: 'sh', args: ['-c', 'touch source.ts'] }] },
        reason: 'Try a command',
      }),
      /supervisor command execution/,
    );
    await assert.rejects(
      f.invoke('swarm.watch.create', {
        outcomeId: f.outcome.id,
        key: 'watch',
        description: 'Try a side effect',
        condition: { type: 'command', command: 'sh', args: ['-c', 'touch source.ts'] },
        intervalMs: 1000,
      }),
      /cannot execute commands/,
    );
  } finally {
    await f.close();
  }
});

test('roles select exact profiles and snapshot capabilities without granting write authority', async () => {
  const f = await fixture();
  try {
    const profile = {
      ...builtinProfiles.find((p) => p.kind === 'codex')!,
      availability: 'available',
      availabilityEvidence: 'Fixture validation',
    };
    f.store.put('profiles', f.p.id, [profile]);
    const roles = [
      { id: 'researcher', profileId: profile.id, activity: 'inspect', canDelegate: false },
    ];
    await f.invoke('role.configure', { roles });
    const task = await f.submit('research', {
      role: 'researcher',
      readOnly: true,
      ownership: [],
      canDelegate: false,
    });
    assert.equal(task.model, profile.model);
    assert.equal(task.resolvedRole.id, 'researcher');
    await assert.rejects(f.submit('bad-role', { role: 'researcher' }), /Inspection roles require/);
    await assert.rejects(f.submit('missing-role', { role: 'unknown' }), /Configure role/);
    await assert.rejects(
      f.invoke('role.configure', { roles: [{ ...roles[0], id: 'lead' }] }),
      /coordinator-only/,
    );
    await f.invoke('role.configure', { roles: [] });
    assert.equal(f.service.task(task.id).resolvedRole?.id, 'researcher');
    await f.invoke('role.configure', { roles, scope: 'instance' });
    assert.equal(f.service.orchestration.roles(f.p.id)[0].profileId, profile.id);
    await f.invoke('role.configure', { roles: [{ ...roles[0], canDelegate: true }] });
    assert.equal(f.service.orchestration.roles(f.p.id)[0].canDelegate, true);
    await f.invoke('role.configure', { roles: [] });
    assert.equal(f.service.orchestration.roles(f.p.id)[0].canDelegate, false);
  } finally {
    await f.close();
  }
});

test('lead hooks block every execution route and restore instructions on compaction', async () => {
  const f = await fixture();
  try {
    const policy: GuardPolicy = {
      version: 1,
      root: f.root,
      role: 'coordinate',
      instructions: leadContract,
      mcpName: 'marionette_lead',
      ownership: [],
    };
    for (const tool of [
      'Bash',
      'exec_command',
      'write_stdin',
      'apply_patch',
      'Edit',
      'Write',
      'Read',
      'Grep',
      'WebSearch',
      'WebFetch',
      'spawn_agent',
      'Agent',
      'task',
      'browser',
      'python',
      'mcp__other__write',
    ])
      assert.match(guardTool(policy, tool, { command: 'touch file' }) ?? '', /Coordinator-only/);
    assert.equal(guardTool(policy, 'mcp__marionette_lead__task_submit', {}), undefined);
    assert.equal(guardTool(policy, 'AskUserQuestion', {}), undefined);
    for (const source of ['startup', 'resume', 'compact']) {
      const refreshed = guardHook(policy, { hook_event_name: 'SessionStart', cwd: f.root, source });
      assert.ok('additionalContext' in refreshed.hookSpecificOutput);
      assert.equal(refreshed.hookSpecificOutput.additionalContext, leadContract);
      assert.match(
        'additionalContext' in refreshed.hookSpecificOutput
          ? refreshed.hookSpecificOutput.additionalContext
          : '',
        /A skill cannot turn planning/,
      );
    }
    const denied = guardHook(policy, {
      hook_event_name: 'PreToolUse',
      cwd: f.root,
      tool_name: 'apply_patch',
      tool_input: { command: 'patch' },
    });
    assert.ok(
      'permissionDecision' in denied.hookSpecificOutput &&
        denied.hookSpecificOutput.permissionDecision === 'deny',
    );
    assert.throws(
      () => guardHook(policy, { hook_event_name: 'SessionStart', cwd: '/' }),
      /workspace/,
    );
    for (const kind of ['codex', 'claude', 'omp'] as const) {
      const directory = join(f.root, kind);
      const args = prepareGuardLaunch({
        kind,
        directory,
        executable: process.execPath,
        cliPath: '/runtime/dist/cli.js',
        policy,
        server: {
          command: 'bun',
          args: ['mcp.js', '--lead-lease', '/private/lease.json', '--url', 'http://127.0.0.1:4380'],
        },
      });
      assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      if (kind === 'codex') {
        assert.ok(args.includes('features.shell_tool=false'));
        assert.ok(args.includes('features.multi_agent=false'));
        assert.ok(args.includes('web_search="disabled"'));
        const mcpConfig: any = Bun.TOML.parse(
          args.find((arg) => arg.startsWith(`mcp_servers.${policy.mcpName}=`))!,
        );
        assert.equal(mcpConfig.mcp_servers[policy.mcpName].default_tools_approval_mode, 'approve');
        assert.deepEqual(Object.keys(mcpConfig.mcp_servers), [policy.mcpName]);
        for (const value of args.filter((arg) => arg.startsWith('hooks.')))
          assert.doesNotThrow(() => Bun.TOML.parse(value));
        const startConfig: any = Bun.TOML.parse(
          args.find((arg) => arg.startsWith('hooks.SessionStart='))!,
        );
        assert.ok(
          startConfig.hooks.SessionStart[0].hooks[0].additionalContextLimit >=
            Buffer.byteLength(leadContract, 'utf8'),
        );
      } else if (kind === 'claude') {
        assert.equal(args[args.indexOf('--tools') + 1], 'AskUserQuestion');
        const hooks = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')).hooks;
        assert.ok(hooks.SessionStart[0].matcher.includes('compact'));
      } else {
        assert.ok(args.includes('--no-tools'));
        assert.match(readFileSync(join(directory, 'omp/index.js'), 'utf8'), /session_compact/);
      }
    }
  } finally {
    await f.close();
  }
});

test('documentation guards reject source, shell, escaped paths, and native delegation', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, 'docs'));
    symlinkSync('/private/tmp', join(f.root, 'docs/outside'));
    const policy: GuardPolicy = {
      version: 1,
      root: f.root,
      role: 'documentation',
      instructions: '',
      mcpName: 'marionette_worker',
      ownership: ['docs'],
    };
    assert.equal(guardTool(policy, 'Write', { file_path: 'docs/design.md' }), undefined);
    assert.match(guardTool(policy, 'Write', { file_path: 'docs/code.ts' }) ?? '', /source code/);
    assert.match(guardTool(policy, 'Write', { file_path: 'README.md' }) ?? '', /assigned paths/);
    assert.throws(
      () => guardTool(policy, 'Write', { file_path: 'docs/outside/file.md' }),
      /symlink/i,
    );
    assert.match(
      guardTool(policy, 'Bash', { command: 'python -c "write"' }) ?? '',
      /does not permit/,
    );
    assert.match(
      guardTool(policy, 'apply_patch', {
        command: '*** Update File: docs/a.md\n*** Move to: code.ts\n',
      }) ?? '',
      /assigned paths/,
    );
    assert.match(
      guardTool({ ...policy, role: 'inspect' }, 'Write', { file_path: 'docs/a.md' }) ?? '',
      /does not permit/,
    );
    assert.match(
      guardTool({ ...policy, role: 'implementation' }, 'spawn_agent', {}) ?? '',
      /does not permit/,
    );
  } finally {
    await f.close();
  }
});

test('workers can inspect bounded files without shell access and cannot escape through symlinks', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'source.ts'), 'one\ntwo\nthree');
    const result = inspectWorkerFiles(f.root, {
      action: 'read',
      path: 'source.ts',
      startLine: 2,
      maxLines: 1,
    });
    assert.ok('text' in result && result.text === 'two');
    assert.throws(
      () => inspectWorkerFiles(f.root, { action: 'read', path: '../outside' }),
      /within/,
    );
    symlinkSync('/etc', join(f.root, 'outside'));
    assert.throws(() => inspectWorkerFiles(f.root, { action: 'list', path: 'outside' }), /Symlink/);
    mkdirSync(join(f.root, '.marionette'));
    assert.throws(
      () => inspectWorkerFiles(f.root, { action: 'list', path: '.marionette' }),
      /Private runtime/,
    );
    assert.throws(() =>
      inspectWorkerFiles(f.root, { action: 'read', path: 'source.ts', maxLines: 1001 }),
    );
  } finally {
    await f.close();
  }
});

test('live worker guards follow retained ownership and reject paused or revoked work', async () => {
  const f = await fixture();
  try {
    await f.invoke('project.configure', { coordinatorOnly: true });
    await f.service.invoke('authority.grant', {
      projectId: f.p.id,
      outcomeId: f.outcome.id,
      activities: ['implementation', 'execute'],
      scope: ['.'],
      source: 'User authorized fixture work',
    });
    const task = await f.submit('original.ts');
    const token = 'fixture-guard-token';
    f.store.put('run', 'guard-run', {
      id: 'guard-run',
      taskId: task.id,
      tokenHash: hash(token),
      phase: 'running',
    });
    f.service.updateTask(task, {
      runId: 'guard-run',
      status: 'running',
      retainedOwnership: ['current.ts'],
    });
    const policy: GuardPolicy = {
      version: 1,
      root: f.root,
      taskId: task.id,
      role: 'implementation',
      instructions: '',
      mcpName: 'marionette_worker',
      ownership: ['original.ts'],
    };
    const live = await f.service.orchestration.workerAction(task.id, token, { action: 'guard' });
    const updated = applyWorkerGuardState(policy, live);
    assert.equal(guardTool(updated, 'Write', { file_path: 'current.ts' }), undefined);
    assert.match(guardTool(updated, 'Write', { file_path: 'original.ts' }) ?? '', /assigned paths/);
    assert.throws(() => applyWorkerGuardState({ ...policy, taskId: 'other' }, live), /identity/);
    await assert.rejects(
      f.service.invoke('authority.grant', {
        projectId: f.p.id,
        outcomeId: f.outcome.id,
        activities: [],
        scope: [],
        source: 'User revoked work',
      }),
      /Pause and settle/,
    );
    f.service.updateTask(f.service.task(task.id), { status: 'paused' });
    await assert.rejects(
      f.service.orchestration.workerAction(task.id, token, { action: 'guard' }),
      /running assignment/,
    );
    await f.service.invoke('authority.grant', {
      projectId: f.p.id,
      outcomeId: f.outcome.id,
      activities: [],
      scope: [],
      source: 'User revoked work',
    });
    await assert.rejects(
      f.invoke('task.control', {
        taskId: task.id,
        key: 'revoked-reply',
        type: 'reply',
        text: 'Continue',
      }),
      /does not authorize implementation/,
    );
    assert.throws(
      () =>
        scopeLeadInput(f.service, f.lease, 'task.control', {
          taskId: task.id,
          type: 'keys',
          keys: ['enter'],
        }),
      /raw terminal keys/,
    );
    f.service.updateTask(f.service.task(task.id), { status: 'running' });
    await assert.rejects(
      f.service.orchestration.workerAction(task.id, token, { action: 'guard' }),
      /does not authorize implementation/,
    );
  } finally {
    await f.close();
  }
});
