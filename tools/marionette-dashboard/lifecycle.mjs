export const boardStages = ['backlog', 'ready', 'in-progress', 'review', 'done'];
export const automaticStage = 'automatic';
export const stageMarker = '[project-board:stage] ';

const validStages = new Set(boardStages);

export function resolveManualStages(posts, threadJobs = new Map()) {
  const resolved = new Map();
  const seen = new Set();
  const newestFirst = [...posts].sort((left, right) => {
    const time = String(right.createdAt ?? right.created_at ?? '').localeCompare(
      String(left.createdAt ?? left.created_at ?? ''),
    );
    return time || Number(right.sequence ?? 0) - Number(left.sequence ?? 0);
  });

  for (const post of newestFirst) {
    const jobId = post.jobId ?? threadJobs.get(post.threadId ?? post.thread_id);
    const body = String(post.body ?? '');
    if (!jobId || !body.startsWith(stageMarker) || seen.has(jobId)) continue;
    const stage = body.slice(stageMarker.length).trim();
    if (stage !== automaticStage && !validStages.has(stage)) continue;
    seen.add(jobId);
    if (stage !== automaticStage) resolved.set(jobId, stage);
  }

  return resolved;
}

export function deriveBoardPlacement({
  job,
  manualStage,
  hasRecordedResult = false,
  hasAcceptedResult = false,
}) {
  if (validStages.has(manualStage)) {
    return {
      stage: manualStage,
      source: 'manual',
      label: 'manual override',
      automatic: false,
    };
  }

  if (job?.state === 'finished') {
    return {
      stage: 'done',
      source: 'job-finished',
      label: 'ledger finished',
      automatic: true,
    };
  }

  if (hasAcceptedResult) {
    return {
      stage: 'done',
      source: 'result-accepted',
      label: 'result accepted',
      automatic: true,
    };
  }

  if (hasRecordedResult) {
    return {
      stage: 'review',
      source: 'result-recorded',
      label: 'result recorded',
      automatic: true,
    };
  }

  return {
    stage: 'backlog',
    source: job?.state === 'cancelled' ? 'job-cancelled' : 'default',
    label: job?.state === 'cancelled' ? 'ledger cancelled' : 'no lifecycle outcome',
    automatic: true,
  };
}
