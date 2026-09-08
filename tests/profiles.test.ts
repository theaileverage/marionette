import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { catalogSnapshot } from '../src/model-catalog-snapshot.js';
import { catalogProfiles, parseCatalog } from '../src/model-catalog.js';
import { builtinProfiles, profileArgs } from '../src/profiles.js';

test('extracted catalogs retain exact IDs, context variants and supported effort settings', () => {
  assert.equal(parseCatalog('codex', catalogSnapshot.codex).length, 7);
  assert.equal(parseCatalog('claude', catalogSnapshot.claude).length, 5);
  assert.equal(parseCatalog('agy', catalogSnapshot.agy).length, 14);
  assert.equal(builtinProfiles.length, 27);
  assert.equal(new Set(builtinProfiles.map((p) => p.id)).size, 27);
  assert.ok(builtinProfiles.every((p) => p.availability === 'unverified'));
  const astra = builtinProfiles.find((p) => p.model === 'gpt-6-astra')!;
  assert.ok(astra.supportedReasoning.includes('ultra'));
  assert.ok(builtinProfiles.some((p) => p.model === 'claude-fable-5-1[1m]'));
  assert.ok(builtinProfiles.some((p) => p.model === 'claude-opus-5[1m]'));
  const haiku = builtinProfiles.find((p) => p.kind === 'claude' && p.model.includes('haiku'))!;
  assert.deepEqual(haiku.supportedReasoning, []);
  assert.equal(haiku.reasoning, undefined);
  assert.deepEqual(profileArgs(haiku), ['--model', haiku.model]);
  const flash = builtinProfiles.find((p) => p.model === 'gemini-3.8-flash-high')!;
  assert.equal(flash.reasoning, 'high');
  assert.deepEqual(profileArgs(flash), ['--model', flash.model]);
});

test('catalog parsing rejects aliases and hidden models without silently manufacturing capabilities', () => {
  const models = parseCatalog('codex', [
    { model: 'hidden', hidden: true },
    { model: 'default' },
    {
      model: 'actual',
      displayName: 'Actual',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      defaultReasoningEffort: 'low',
      inputModalities: ['text'],
    },
  ]);
  assert.deepEqual(
    models.map((m) => m.model),
    ['actual'],
  );
  const profiles = catalogProfiles({
    kind: 'codex',
    models,
    source: 'fixture metadata',
    fetchedAt: '2026-09-08',
  });
  assert.deepEqual(profiles[0].supportedReasoning, ['low']);
  assert.equal(profiles[0].availability, 'unverified');
  assert.match(profiles[0].availabilityEvidence, /not launch-tested/);
  assert.deepEqual(
    parseCatalog(
      'agy',
      'Fetching available models...\nnot an ID\ngemini-3.8-flash-low\tGemini Low\n',
    ).map((m) => m.model),
    ['gemini-3.8-flash-low'],
  );
});
