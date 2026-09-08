import React, { useState } from 'react';
import type { Archive, CleanupPolicy, Delivery } from '../src/cleanup';
import type { Run } from '../src/types';

type Preview = {
  policy: CleanupPolicy;
  runs: {
    runId: string;
    tabId?: string;
    paneId?: string;
    cleanup?: Run['cleanup'];
    reasons: string[];
  }[];
  collectionReasons: string[];
  delivery?: Delivery;
  archive?: Archive;
};
export function CleanupPanel({
  taskId,
  canEdit,
  pending,
  onAction,
}: {
  taskId: string;
  canEdit: boolean;
  pending: boolean;
  onAction: (action: string, input: Record<string, unknown>) => Promise<any>;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState('merged');
  const [targetRef, setTargetRef] = useState('refs/heads/main');
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [hours, setHours] = useState('');
  const [autoRelease, setAutoRelease] = useState(true);
  const [autoDelete, setAutoDelete] = useState(false);
  const run = async (action: string, input: Record<string, unknown> = {}) => {
    setError('');
    try {
      const result = await onAction(action, { taskId, reason, ...input });
      const next =
        action === 'cleanup.preview' ? result : await onAction('cleanup.preview', { taskId });
      setPreview(next);
      setAutoRelease(next.policy.autoRelease);
      setHours(next.policy.collectAfterHours === null ? '' : String(next.policy.collectAfterHours));
      setAutoDelete(next.policy.deleteMergedBranches);
    } catch (e) {
      setError(String(e));
    }
  };
  const disabled = !canEdit || pending || !reason.trim();
  return (
    <section>
      <h3>Delivery and cleanup</h3>
      <p>
        Completion keeps branches and worktrees. Release terminals after consuming results, then
        record delivery and preserve evidence before collection.
      </p>
      <button disabled={pending} onClick={() => void run('cleanup.preview')}>
        Inspect cleanup eligibility
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <>
          <label>
            Reason for cleanup or policy change
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {preview.runs.map((r) => (
            <div key={r.runId}>
              <p>
                Worker {r.paneId ?? r.tabId ?? r.runId}: {r.cleanup?.state ?? 'retained'}
              </p>
              {r.reasons.map((text, n) => (
                <p className="muted" key={n}>
                  {text}
                </p>
              ))}
              {r.cleanup?.error ? <p>{r.cleanup.error}</p> : null}
              {r.cleanup?.state === 'uncertain' ? (
                <>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run('cleanup.reconcile', { runId: r.runId, resolution: 'closed' })
                    }
                  >
                    Confirm original worker terminal is absent
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run('cleanup.reconcile', { runId: r.runId, resolution: 'not-closed' })
                    }
                  >
                    Confirm original worker remains
                  </button>
                </>
              ) : r.cleanup?.state !== 'closed' ? (
                <button
                  disabled={disabled}
                  onClick={() => void run('cleanup.release', { runId: r.runId })}
                >
                  Result inspected · release worker terminal
                </button>
              ) : null}
            </div>
          ))}
          {preview.collectionReasons.map((text, n) => (
            <p className="muted" key={n}>
              {text}
            </p>
          ))}
          {preview.delivery ? (
            <p>
              Delivery: {preview.delivery.disposition} · {preview.delivery.head}
            </p>
          ) : null}
          {preview.archive ? (
            <>
              <p>
                Archive: {preview.archive.phase} · {preview.archive.id}
              </p>
              {preview.archive.error ? <p role="alert">{preview.archive.error}</p> : null}
              {preview.archive.phase !== 'collected' || !preview.archive.branchDeleted ? (
                <>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={deleteBranch}
                      onChange={(e) => setDeleteBranch(e.target.checked)}
                    />{' '}
                    Also delete the merged or explicitly abandoned local branch
                  </label>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run('cleanup.collect', { archiveId: preview.archive!.id, deleteBranch })
                    }
                  >
                    {preview.archive.phase === 'collected'
                      ? 'Collect retained branch'
                      : 'Remove archived worktree'}
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          {!preview.archive?.branchDeleted ? (
            <>
              <label>
                Delivery decision
                <select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                  <option value="merged">Merged into target</option>
                  <option value="published">Published for review</option>
                  <option value="abandoned">Explicitly abandoned</option>
                </select>
              </label>
              {disposition !== 'abandoned' ? (
                <label>
                  Verified target ref
                  <input
                    value={targetRef}
                    onChange={(e) => setTargetRef(e.target.value)}
                    placeholder="refs/remotes/origin/main"
                  />
                </label>
              ) : null}
              <button
                disabled={disabled}
                onClick={() =>
                  void run('cleanup.deliver', {
                    disposition,
                    ...(disposition !== 'abandoned' ? { targetRef } : {}),
                  })
                }
              >
                Record delivery decision
              </button>
              {!preview.archive ? (
                <button
                  disabled={disabled || !preview.delivery}
                  onClick={() => void run('cleanup.archive')}
                >
                  Preserve evidence and seal finished tasks
                </button>
              ) : null}
            </>
          ) : null}
          <details>
            <summary>Project retention policy</summary>
            <p>
              Only enable collection when the user has authorized this retention policy. Blank
              retention keeps worktrees until an explicit collection request. Failed or abandoned
              work is never collected automatically.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autoRelease}
                onChange={(e) => setAutoRelease(e.target.checked)}
              />{' '}
              Automatically release workers after integrated outcome completion
            </label>
            <label>
              Hours after recorded delivery before automatic collection
              <input
                type="number"
                min="0"
                max="87600"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="Keep until explicitly collected"
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autoDelete}
                onChange={(e) => setAutoDelete(e.target.checked)}
              />{' '}
              Also delete safely merged local branches
            </label>
            <button
              disabled={disabled}
              onClick={() =>
                void run('cleanup.configure', {
                  policy: {
                    autoRelease,
                    collectAfterHours: hours === '' ? null : Number(hours),
                    deleteMergedBranches: autoDelete,
                  },
                })
              }
            >
              Save authorized policy
            </button>
          </details>
        </>
      ) : null}
    </section>
  );
}
