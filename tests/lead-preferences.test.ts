import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordUserRequest } from '../src/authority.js';
import { getLeadPreferences, setLeadPreferences } from '../src/lead-preferences.js';
import { scopeLeadInput } from '../src/lead-capabilities.js';
import { fixture } from './swarm-fixture.js';

test('conversation authority is lease fenced, scoped, revision checked and audited', async () => {
  const f = await fixture();
  try {
    f.store.put('project', f.p.id, { ...f.p, authorityMode: 'conversation' });
    const input = {
      projectId: f.p.id,
      lease: f.lease,
      outcomeId: f.outcome.id,
      expectedRevision: f.outcome.revision,
      activities: ['implementation', 'execute'],
      scope: ['src'],
      source: 'Implement the requested change in src and run verification.',
    };
    assert.throws(
      () => recordUserRequest(f.service, { ...input, lease: { ...f.lease, epoch: 99 } }),
      /Control belongs/,
    );
    assert.throws(
      () => recordUserRequest(f.service, { ...input, projectId: 'other' }),
      /another project/,
    );
    assert.throws(
      () => recordUserRequest(f.service, { ...input, expectedRevision: 99 }),
      /task tree changed/,
    );
    assert.throws(
      () => recordUserRequest(f.service, { ...input, scope: ['../escape'] }),
      /within the task/,
    );
    assert.throws(() => recordUserRequest(f.service, { ...input, origin: 'user-cli' }), /origin/);
    f.store.put('project', f.p.id, f.p);
    assert.throws(() => recordUserRequest(f.service, input), /requires external authority/);
    f.store.put('project', f.p.id, { ...f.p, authorityMode: 'conversation' });
    f.store.put('outcome', f.outcome.id, { ...f.outcome, scope: ['src'] });
    assert.throws(
      () => recordUserRequest(f.service, { ...input, scope: ['documentation'] }),
      /exceed the current outcome/,
    );
    const grant = await f.service.invoke('authority.record-user-request', input);
    assert.equal(grant.origin, 'lead-conversation');
    assert.equal(grant.recordedBy, f.lease.owner);
    assert.equal(f.store.get<{ id: string }>('authority-history', grant.id)?.id, grant.id);
    const scoped = scopeLeadInput(f.service, f.lease, 'authority.record-user-request', input);
    assert.ok('projectId' in scoped);
    assert.equal(scoped.projectId, f.p.id);
  } finally {
    await f.close();
  }
});

test('lead preferences persist bounded project skills and reject stale or administrative writes', async () => {
  const f = await fixture();
  try {
    const skill = '.agents/skills/local/SKILL.md';
    mkdirSync(join(f.root, '.agents/skills/local'), { recursive: true });
    writeFileSync(join(f.root, skill), '# Local instructions');
    const input = {
      projectId: f.p.id,
      lease: f.lease,
      expectedRevision: 0,
      preferences: { instructions: 'Use concise reports.', skills: [skill] },
    };
    const saved = setLeadPreferences(f.service, input);
    assert.equal(saved.revision, 1);
    assert.equal(saved.skillContents[0]?.content, '# Local instructions');
    assert.equal(getLeadPreferences(f.service, input).instructions, 'Use concise reports.');
    assert.throws(() => setLeadPreferences(f.service, input), /Preferences changed/);
    const next = { ...input, expectedRevision: 1 };
    assert.throws(
      () => setLeadPreferences(f.service, { ...next, lease: { ...f.lease, epoch: 99 } }),
      /Control belongs/,
    );
    assert.throws(
      () => setLeadPreferences(f.service, { ...next, projectId: 'other' }),
      /another project/,
    );
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...input.preferences, coordinatorOnly: false },
        }),
      /coordinatorOnly/,
    );
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...input.preferences, skills: ['../private'] },
        }),
      /RegExp/,
    );
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...input.preferences, reasoning: 'high' },
        }),
      /exact profile/,
    );
    mkdirSync(join(f.root, '.claude/skills'), { recursive: true });
    symlinkSync(join(f.root, '.agents/skills/local'), join(f.root, '.claude/skills/local'));
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...input.preferences, skills: ['.claude/skills/local/SKILL.md'] },
        }),
      /symlinks/,
    );
    assert.equal(getLeadPreferences(f.service, input).revision, 1);
  } finally {
    await f.close();
  }
});

test('saved lead profiles require the configured adapter and compatible validated reasoning', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.marionette'));
    writeFileSync(
      join(f.root, '.marionette/project.json'),
      JSON.stringify({
        version: 1,
        home: f.root,
        instanceId: 'fixture',
        projectId: f.p.id,
        root: f.root,
        session: 'default',
        socket: join(f.root, 'herdr.sock'),
        workspace: 'w1',
        lead: 'codex',
        leadName: 'lead',
        leasePath: join(f.root, 'lease.json'),
        runtime: f.root,
        mcp: 'skip',
      }),
    );
    const profile = {
      id: 'exact',
      name: 'Exact',
      kind: 'codex',
      model: 'test-exact-1',
      supportedReasoning: ['high'],
      categories: ['orchestration'],
      capabilities: [],
      strengths: 'Fixture',
      canDelegate: true,
      maxConcurrency: 1,
      availability: 'available',
      availabilityEvidence: 'Fixture',
    };
    f.store.put('profiles', f.p.id, [profile]);
    const input = {
      lease: f.lease,
      projectId: f.p.id,
      expectedRevision: 0,
      preferences: { profileId: 'exact', reasoning: 'high', instructions: '', skills: [] },
    };
    assert.equal(setLeadPreferences(f.service, input).profileId, 'exact');
    const next = { ...input, expectedRevision: 1 };
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...next.preferences, reasoning: 'unsupported' },
        }),
      /Reasoning is not supported/,
    );
    assert.throws(
      () =>
        setLeadPreferences(f.service, {
          ...next,
          preferences: { ...next.preferences, profileId: 'unknown' },
        }),
      /available exact profile/,
    );
    f.store.put('profiles', f.p.id, [{ ...profile, availability: 'unverified' }]);
    assert.throws(() => setLeadPreferences(f.service, next), /available exact profile/);
    f.store.put('profiles', f.p.id, [{ ...profile, kind: 'claude' }]);
    assert.throws(() => setLeadPreferences(f.service, next), /available exact profile/);
  } finally {
    await f.close();
  }
});
