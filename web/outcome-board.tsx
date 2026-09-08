import React, { useState } from 'react';
import type { Outcome, Revision, Profile, Limits, Strategy } from '../src/orchestration-types';
import type { LeadWait, Usage, Checkpoint } from '../src/continuation';

type BoardTask = {
  id: string;
  title: string;
  status: string;
  kind: string;
  revision: number;
  parentId?: string;
  outcomeId?: string;
  model?: string;
  reasoning?: string;
  canDelegate?: boolean;
  required?: boolean;
  supersededBy?: string;
  dependencies: string[];
  ownership: string[];
  waitReason?: string;
  error?: string;
  receipt?: { summary: string; evidence: string[]; artifacts: string[] };
  verification?: { passed: boolean; detail: string }[];
};
export interface OutcomeBoardData {
  tasks: BoardTask[];
  outcomes: (Outcome & { unmet: string[] })[];
  revisions: Omit<Revision, 'before' | 'after'>[];
  findings: {
    id: string;
    outcomeId: string;
    summary: string;
    evidence: string[];
    createdAt: string;
  }[];
  profiles: Profile[];
  limits: Limits;
  strategies: Strategy[];
  waits: LeadWait[];
  checkpoints: Omit<Checkpoint, 'summary'>[];
  coordination: { turns: number; usage: Usage[]; metricBoundary: string };
}
type Props = {
  data: OutcomeBoardData;
  projectId: string;
  canEdit: boolean;
  pending: boolean;
  onTask: (id: string) => void;
  onAddTask: () => void;
  onAction: (action: string, input: Record<string, unknown>, success?: string) => Promise<any>;
};
function RevisionDetail({ id, onAction }: { id: string; onAction: Props['onAction'] }) {
  const [value, setValue] = useState<Revision>();
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !value)
          void onAction('plan.get', { revisionId: id }).then(setValue);
      }}
    >
      <summary>Review what changed</summary>
      <pre>
        {value
          ? JSON.stringify({ before: value.before, after: value.after }, null, 2)
          : 'Loading revision…'}
      </pre>
    </details>
  );
}
const lines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const label = (value: string) => value.replaceAll('-', ' ');
function TaskCard({
  task,
  tasks,
  onTask,
}: {
  task: BoardTask;
  tasks: BoardTask[];
  onTask: Props['onTask'];
}) {
  const children = tasks.filter((t) => t.parentId === task.id);
  return (
    <button className="outcome-task" onClick={() => onTask(task.id)}>
      <span className={`status status-${task.status}`}>{label(task.status)}</span>
      <strong>{task.title}</strong>
      <span>
        {task.kind} · {task.model ?? 'Configured runtime default; exact model unreported'}
      </span>
      {task.reasoning && <span>Reasoning: {task.reasoning}</span>}
      <span>
        {children.length} direct children · {task.dependencies.length} dependencies
      </span>
      {task.required === false && <span>Explicitly removed from required work</span>}
      {task.supersededBy && (
        <span>
          Superseded by {tasks.find((t) => t.id === task.supersededBy)?.title ?? task.supersededBy}
        </span>
      )}
      {(task.waitReason || task.error) && (
        <span className="board-warning">{task.waitReason ?? task.error}</span>
      )}
      {task.receipt && <span>{task.receipt.summary}</span>}
    </button>
  );
}
function Tree({
  tasks,
  parentId,
  onTask,
  depth = 0,
}: {
  tasks: BoardTask[];
  parentId?: string;
  onTask: Props['onTask'];
  depth?: number;
}) {
  if (depth > 7) return <p>Invalid task tree: inspect the current records.</p>;
  return (
    <ul className="outcome-tree">
      {tasks
        .filter((t) => t.parentId === parentId)
        .map((task) => (
          <li key={task.id}>
            <TaskCard task={task} tasks={tasks} onTask={onTask} />
            {tasks.some((t) => t.parentId === task.id) && (
              <Tree tasks={tasks} parentId={task.id} onTask={onTask} depth={depth + 1} />
            )}
          </li>
        ))}
    </ul>
  );
}
export function OutcomeBoard({
  data,
  projectId,
  canEdit,
  pending,
  onTask,
  onAddTask,
  onAction,
}: Props) {
  const [view, setView] = useState('Board'),
    [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false),
    [criterionCount, setCriterionCount] = useState(1);
  const [profileKind, setProfileKind] = useState('all');
  const [profileQuery, setProfileQuery] = useState('');
  const visibleProfiles = data.profiles.filter(
    (p) =>
      (profileKind === 'all' || p.kind === profileKind) &&
      `${p.name} ${p.model}`.toLowerCase().includes(profileQuery.toLowerCase()),
  );
  const outcome = data.outcomes.find((o) => o.id === selected) ?? data.outcomes[0];
  const tasks = outcome ? data.tasks.filter((t) => t.outcomeId === outcome.id) : data.tasks;
  const revisions = outcome ? data.revisions.filter((r) => r.outcomeId === outcome.id) : [];
  const submit = (action: string, input: Record<string, unknown>, success: string) =>
    onAction(action, input, success).catch(() => undefined);
  const expected = outcome ? { outcomeId: outcome.id, expectedRevision: outcome.revision } : {};
  return (
    <div className="outcome-board">
      <section className="panel outcome-toolbar">
        <div>
          <h2>Outcomes and definitions of done</h2>
          <p>Understand what remains, who owns it, and the evidence required to finish.</p>
        </div>
        <div className="outcome-actions">
          <button disabled={!canEdit || pending} onClick={() => setCreating(!creating)}>
            {creating ? 'Close outcome form' : 'New outcome'}
          </button>
          <button disabled={!canEdit || pending} onClick={onAddTask}>
            Add task
          </button>
        </div>
        {data.outcomes.length > 0 && (
          <label>
            Outcome
            <select
              aria-label="Select outcome"
              value={outcome?.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {data.outcomes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.status === 'completed' ? '✓ ' : ''}
                  {o.objective.slice(0, 140)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="outcome-view-options" role="group" aria-label="Task board view">
          {['Board', 'Task tree', 'Dependencies'].map((name) => (
            <button key={name} aria-pressed={view === name} onClick={() => setView(name)}>
              {name}
            </button>
          ))}
        </div>
      </section>
      {creating && (
        <section className="panel outcome-section">
          <h3>Define an observable result</h3>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const criteria = Array.from({ length: criterionCount }, (_, i) => ({
                id: `criterion-${i + 1}`,
                description: String(f.get(`criterion-${i}`)),
                requiredEvidence: String(f.get(`evidence-${i}`)),
              }));
              const result = await submit(
                'outcome.create',
                {
                  outcome: {
                    projectId,
                    key: crypto.randomUUID(),
                    objective: String(f.get('objective')),
                    scope: lines(f.get('scope')),
                    category: String(f.get('category')),
                    criteria,
                    maxTurns: Number(f.get('maxTurns')),
                    maxDepth: Number(f.get('maxDepth')),
                  },
                },
                'Outcome and completion criteria saved',
              );
              if (result) {
                setSelected(result.id);
                setCreating(false);
              }
            }}
          >
            <label>
              Objective
              <textarea
                name="objective"
                required
                rows={3}
                placeholder="What must be true when this work is complete?"
              />
            </label>
            <div className="form-grid">
              <label>
                Work category
                <select name="category">
                  <option value="software">Software</option>
                  <option value="research">Research</option>
                  <option value="analysis">Analysis</option>
                  <option value="decision">Collaborative decision</option>
                </select>
              </label>
              <label>
                Owned paths, one per line
                <textarea name="scope" required defaultValue="." rows={2} />
              </label>
            </div>
            {Array.from({ length: criterionCount }, (_, i) => (
              <fieldset key={i}>
                <legend>Completion criterion {i + 1}</legend>
                <label>
                  Observable requirement
                  <input name={`criterion-${i}`} required />
                </label>
                <label>
                  Evidence needed
                  <input
                    name={`evidence-${i}`}
                    required
                    placeholder="Test results, corroborated sources, or a recorded decision"
                  />
                </label>
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() => setCriterionCount((count) => Math.min(20, count + 1))}
              disabled={criterionCount >= 20}
            >
              Add criterion
            </button>
            <div className="form-grid">
              <label>
                Shared execution turn budget
                <input
                  name="maxTurns"
                  type="number"
                  min="1"
                  max="1000"
                  defaultValue="60"
                  required
                />
              </label>
              <label>
                Maximum delegation depth
                <input name="maxDepth" type="number" min="0" max="6" defaultValue="3" required />
              </label>
            </div>
            <button disabled={pending || !canEdit}>Save outcome</button>
          </form>
        </section>
      )}
      {outcome ? (
        <>
          <section key={`${outcome.id}:${outcome.revision}`} className="panel outcome-section">
            <div className="outcome-title">
              <h3>{outcome.objective}</h3>
              <span className={`status status-${outcome.status}`}>{outcome.status}</span>
            </div>
            <p>
              Responsible lead: <strong>{outcome.leadOwner}</strong> · Revision {outcome.revision} ·{' '}
              {outcome.turnsUsed} / {outcome.maxTurns} shared turns
            </p>
            <p>
              Scope: {outcome.scope.join(', ')} · Delegation depth limit: {outcome.maxDepth}
            </p>
            <ul className="criteria-list">
              {outcome.criteria.map((criterion) => {
                const assessment = outcome.assessments.find(
                  (a) => a.criterionId === criterion.id && a.revision === outcome.revision,
                );
                return (
                  <li key={criterion.id}>
                    <strong>{criterion.description}</strong>
                    <p>Required evidence: {criterion.requiredEvidence}</p>
                    {assessment && (
                      <p>
                        Reviewed by {assessment.owner}: {assessment.rationale}
                        <br />
                        Evidence: {assessment.references.map((r) => r.path).join(', ')}
                      </p>
                    )}
                    <details>
                      <summary>Evaluate this criterion</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void submit(
                            'outcome.assess',
                            {
                              ...expected,
                              criterionId: criterion.id,
                              rationale: String(f.get('rationale')),
                              references: lines(f.get('references')),
                            },
                            'Criterion evidence recorded',
                          );
                        }}
                      >
                        <label>
                          Independent evaluation
                          <textarea name="rationale" required rows={2} />
                        </label>
                        <label>
                          Evidence files in this project, one per line
                          <textarea name="references" required rows={2} />
                        </label>
                        <button disabled={!canEdit || pending}>Record evaluation</button>
                      </form>
                    </details>
                  </li>
                );
              })}
            </ul>
            <details>
              <summary>Revise completion criteria</summary>
              <form
                key={outcome.revision}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const criteria = outcome.criteria.map((c, i) => ({
                    ...c,
                    description: String(f.get(`description-${i}`)),
                    requiredEvidence: String(f.get(`required-${i}`)),
                  }));
                  void submit(
                    'outcome.revise',
                    { ...expected, criteria, reason: String(f.get('reason')) },
                    'Criteria revised; previous evidence retained in history',
                  );
                }}
              >
                {outcome.criteria.map((c, i) => (
                  <fieldset key={c.id}>
                    <legend>{c.id}</legend>
                    <label>
                      Requirement
                      <input name={`description-${i}`} defaultValue={c.description} required />
                    </label>
                    <label>
                      Required evidence
                      <input name={`required-${i}`} defaultValue={c.requiredEvidence} required />
                    </label>
                  </fieldset>
                ))}
                <label>
                  Why did the completion contract change?
                  <textarea name="reason" required rows={2} />
                </label>
                <button disabled={!canEdit || pending}>Save criteria revision</button>
              </form>
            </details>
            <details>
              <summary>Review the integrated result</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void submit(
                    'outcome.integrate',
                    {
                      ...expected,
                      summary: String(f.get('summary')),
                      references: lines(f.get('references')),
                    },
                    'Integrated result reviewed',
                  );
                }}
              >
                <label>
                  Integrated evaluation
                  <textarea
                    name="summary"
                    required
                    rows={3}
                    defaultValue={outcome.integrated?.summary}
                  />
                </label>
                <label>
                  Integration evidence files, one per line
                  <textarea name="references" required rows={2} />
                </label>
                <button disabled={!canEdit || pending}>Record integrated review</button>
              </form>
            </details>
            {outcome.unmet.length > 0 ? (
              <div className="outcome-unmet">
                <strong>What remains before completion</strong>
                <ul>
                  {outcome.unmet.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="board-success">
                All required work and current acceptance evidence pass.
              </p>
            )}
            <button
              disabled={
                !canEdit || pending || outcome.status === 'completed' || outcome.unmet.length > 0
              }
              onClick={() => void submit('outcome.complete', expected, 'Outcome verified complete')}
            >
              Verify outcome complete
            </button>
          </section>
          {view === 'Board' && (
            <section className="outcome-columns" aria-label="Outcome task board">
              {[
                { name: 'Queued', statuses: ['queued', 'preparing'] },
                {
                  name: 'In progress',
                  statuses: ['running', 'verifying', 'redirecting', 'cancelling'],
                },
                { name: 'Waiting', statuses: ['waiting', 'yielding', 'paused'] },
                {
                  name: 'Needs attention',
                  statuses: ['failed', 'blocked', 'uncertain', 'cancelled'],
                },
                { name: 'Verified', statuses: ['completed'] },
              ].map((column) => (
                <div className="outcome-column" key={column.name}>
                  <h3>
                    {column.name}{' '}
                    <span>{tasks.filter((t) => column.statuses.includes(t.status)).length}</span>
                  </h3>
                  {tasks
                    .filter((t) => column.statuses.includes(t.status))
                    .map((task) => (
                      <TaskCard key={task.id} task={task} tasks={tasks} onTask={onTask} />
                    ))}
                </div>
              ))}
            </section>
          )}
          {view === 'Task tree' && (
            <section className="panel outcome-section" aria-label="Outcome task tree">
              <h3>Parent accountability and delegated work</h3>
              <Tree tasks={tasks} onTask={onTask} />
            </section>
          )}
          {view === 'Dependencies' && (
            <section className="panel outcome-section" aria-label="Outcome dependencies">
              <h3>Dependencies and verification order</h3>
              <ul className="dependency-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button onClick={() => onTask(task.id)}>{task.title}</button>
                    <span>{task.dependencies.length ? ' waits for ' : ' has no dependencies'}</span>
                    {task.dependencies.map((id) => (
                      <button key={id} onClick={() => onTask(id)}>
                        {data.tasks.find((t) => t.id === id)?.title ?? id} (
                        {data.tasks.find((t) => t.id === id)?.status ?? 'missing'})
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="panel outcome-section">
            <h3>Findings and plan revisions</h3>
            {data.findings
              ?.filter((f) => f.outcomeId === outcome.id)
              .map((f) => (
                <article key={f.id}>
                  <strong>{f.summary}</strong>
                  <p>{f.evidence.join(', ')}</p>
                </article>
              ))}
            {revisions.length ? (
              <ol className="revision-list">
                {[...revisions].reverse().map((r) => (
                  <li key={r.id}>
                    <strong>
                      Revision {r.revision} · {r.reason}
                    </strong>
                    <p>
                      {r.owner} · {new Date(r.createdAt).toLocaleString()}
                    </p>
                    {r.evidence.length > 0 && <p>Finding references: {r.evidence.join(', ')}</p>}
                    <RevisionDetail id={r.id} onAction={onAction} />
                  </li>
                ))}
              </ol>
            ) : (
              <p>No plan revisions yet.</p>
            )}
          </section>
          {data.strategies
            .filter((s) => s.outcomeId === outcome.id)
            .map((strategy) => (
              <section className="panel outcome-section" key={strategy.id}>
                <h3>
                  {label(strategy.kind)} · {strategy.status}
                </h3>
                <p>
                  Round {strategy.round} / {strategy.maxRounds} · Stop when:{' '}
                  {strategy.stopCondition}
                </p>
                <p>Evaluate against: {strategy.criteria}</p>
                <p>{strategy.synthesis}</p>
                {strategy.disagreements?.length ? (
                  <ul>
                    {strategy.disagreements.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
        </>
      ) : (
        <section className="panel outcome-section">
          <h3>No outcomes yet</h3>
          <p>
            Create an outcome with observable completion criteria, then assign bounded work to
            agents.
          </p>
        </section>
      )}
      <section className="panel outcome-section">
        <h3>Capacity and continuation</h3>
        <p>
          Global slots: {data.limits.global} · Project slots: {data.limits.project} · Coordination
          turns delivered: {data.coordination.turns}
        </p>
        {data.waits
          .filter((w) => !outcome || w.outcomeId === outcome.id)
          .map((wait) => (
            <div className="wait-card" key={wait.id}>
              <strong>
                {wait.owner}: {wait.state}
              </strong>
              <p>
                {wait.adapter.type === 'herdr'
                  ? 'Automatic continuation in the pinned Herdr session'
                  : 'Continuation on the next user message'}
              </p>
              {wait.error && <p className="board-warning">{wait.error}</p>}
              <p>
                {wait.condition.tasks.length} required results · {wait.eventIds?.length ?? 0}{' '}
                grouped events
              </p>
            </div>
          ))}
        <p className="muted">{data.coordination.metricBoundary}</p>
        {data.coordination.usage.map((u) => (
          <p key={u.id}>
            Cache read: {u.cacheReadTokens ?? 'unavailable'} · Cache write:{' '}
            {u.cacheWriteTokens ?? 'unavailable'} · Uncached input:{' '}
            {u.uncachedInputTokens ?? 'unavailable'} · Cost:{' '}
            {u.costUsd === null ? 'unavailable' : `$${u.costUsd.toFixed(4)}`}
            <br />
            Source: {u.source}
          </p>
        ))}
        <details>
          <summary>Configure shared execution limits</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void submit(
                'limits.configure',
                {
                  limits: {
                    ...data.limits,
                    global: Number(f.get('global')),
                    project: Number(f.get('project')),
                  },
                  reason: String(f.get('reason')),
                },
                'Shared limits updated',
              );
            }}
          >
            <div className="form-grid">
              <label>
                Global slots
                <input
                  name="global"
                  type="number"
                  min="1"
                  max="32"
                  defaultValue={data.limits.global}
                  required
                />
              </label>
              <label>
                Project slots
                <input
                  name="project"
                  type="number"
                  min="1"
                  max="8"
                  defaultValue={data.limits.project}
                  required
                />
              </label>
            </div>
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button disabled={!canEdit || pending}>Save limits</button>
          </form>
        </details>
      </section>
      <section className="panel outcome-section">
        <h3>Model and capability profiles</h3>
        <p>
          {data.profiles.length} profiles. Discovery reads native catalogs; validation tests the
          exact selection.
        </p>
        <div className="outcome-actions">
          <label>
            Runtime
            <select
              aria-label="Filter model runtime"
              value={profileKind}
              onChange={(e) => setProfileKind(e.target.value)}
            >
              <option value="all">All runtimes</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="agy">AGY</option>
            </select>
          </label>
          <label>
            Find a model
            <input
              aria-label="Find a model"
              value={profileQuery}
              onChange={(e) => setProfileQuery(e.target.value)}
            />
          </label>
          {['codex', 'claude', 'agy'].map((kind) => (
            <button
              key={kind}
              disabled={!canEdit || pending}
              onClick={() => void submit('profile.discover', { kind }, `${kind} catalog refreshed`)}
            >
              Discover {kind} models
            </button>
          ))}
        </div>
        {visibleProfiles.map((profile) => (
          <div className="profile-card" key={profile.id}>
            <strong>{profile.name}</strong>
            <p>
              {profile.kind} · {profile.model} · {profile.reasoning ?? 'Default effort'} ·{' '}
              {profile.availability}
            </p>
            <p>
              Supported effort:{' '}
              {profile.supportedReasoning.join(', ') || 'No separate effort control'} · Categories:{' '}
              {profile.categories.join(', ')}
            </p>
            <p>{profile.strengths}</p>
            <p>{profile.availabilityEvidence}</p>
            <button
              disabled={!canEdit || pending}
              onClick={() =>
                void submit(
                  'profile.validate',
                  { profileId: profile.id },
                  'Model availability probe finished',
                )
              }
            >
              Validate exact model
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
