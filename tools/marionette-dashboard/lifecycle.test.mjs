import { describe, expect, test } from 'bun:test';
import { deriveBoardPlacement, resolveManualStages, stageMarker } from './lifecycle.mjs';

describe('Project Board lifecycle precedence', () => {
  test('manual metadata wins over every automatic signal', () => {
    expect(deriveBoardPlacement({
      job: { state: 'finished' },
      manualStage: 'ready',
      hasRecordedResult: true,
      hasAcceptedResult: true,
    })).toEqual({ stage: 'ready', source: 'manual', label: 'manual override', automatic: false });
  });

  test('authoritative finished state derives Done', () => {
    expect(deriveBoardPlacement({ job: { state: 'finished' }, hasRecordedResult: true }).stage).toBe('done');
  });

  test('accepted result derives Done when that fact is supplied', () => {
    expect(deriveBoardPlacement({ job: { state: 'open' }, hasRecordedResult: true, hasAcceptedResult: true }).stage).toBe('done');
  });

  test('recorded but unaccepted result derives Review', () => {
    expect(deriveBoardPlacement({ job: { state: 'open' }, hasRecordedResult: true })).toEqual({
      stage: 'review', source: 'result-recorded', label: 'result recorded', automatic: true,
    });
  });

  test('cancelled and open jobs are never inferred as Done', () => {
    expect(deriveBoardPlacement({ job: { state: 'cancelled' } }).stage).toBe('backlog');
    expect(deriveBoardPlacement({ job: { state: 'open' } }).stage).toBe('backlog');
  });

  test('invalid manual metadata is ignored', () => {
    expect(deriveBoardPlacement({ job: { state: 'open' }, manualStage: 'shipped', hasRecordedResult: true }).stage).toBe('review');
  });
});

describe('manual Project Board stage history', () => {
  const threads = new Map([['thread-1', 'job-1']]);

  test('newest marker wins even when rows arrive oldest first', () => {
    const stages = resolveManualStages([
      { thread_id: 'thread-1', body: `${stageMarker}ready`, created_at: '2026-01-01T00:00:00Z', sequence: 1 },
      { thread_id: 'thread-1', body: `${stageMarker}review`, created_at: '2026-01-02T00:00:00Z', sequence: 2 },
    ], threads);
    expect(stages.get('job-1')).toBe('review');
  });

  test('Automatic clears an older manual override', () => {
    const stages = resolveManualStages([
      { jobId: 'job-1', body: `${stageMarker}ready`, createdAt: '2026-01-01T00:00:00Z', sequence: 1 },
      { jobId: 'job-1', body: `${stageMarker}automatic`, createdAt: '2026-01-02T00:00:00Z', sequence: 2 },
    ]);
    expect(stages.has('job-1')).toBe(false);
  });

  test('invalid marker does not shadow an older valid marker', () => {
    const stages = resolveManualStages([
      { jobId: 'job-1', body: `${stageMarker}ready`, createdAt: '2026-01-01T00:00:00Z' },
      { jobId: 'job-1', body: `${stageMarker}shipped`, createdAt: '2026-01-02T00:00:00Z' },
    ]);
    expect(stages.get('job-1')).toBe('ready');
  });
});
