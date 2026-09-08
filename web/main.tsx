import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Command,
  Download,
  Inbox,
  LayoutDashboard,
  Link,
  ListTodo,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Terminal,
  X,
} from 'lucide-react';
import './style.css';
import { OutcomeBoard, type OutcomeBoardData } from './outcome-board';
import { CleanupPanel } from './cleanup-panel';

type Task = {
  id: string;
  title: string;
  kind: string;
  workstream: string;
  status: string;
  revision: number;
  attempt: number;
  maxAttempts: number;
  prompt: string;
  output: string;
  cwd: string;
  execution?: { mode: 'shared' | 'worktree'; baseRef?: string };
  parentId?: string;
  outcomeId?: string;
  model?: string;
  reasoning?: string;
  canDelegate?: boolean;
  required?: boolean;
  supersededBy?: string;
  worktree?: { state: string; path: string; branch: string; baseCommit: string };
  ownership: string[];
  dependencies: string[];
  error?: string;
  waitReason?: string;
  checks: any[];
  receipt?: { summary: string; artifacts: string[]; evidence: string[] };
  verification?: { passed: boolean; detail: string }[];
};
type Project = {
  id: string;
  name: string;
  root: string;
  session: string;
  socketPath: string;
  workspaceId: string;
};
type Lease = { projectId: string; owner: string; epoch: number; token: string };
type Question = {
  id: string;
  taskId: string;
  text: string;
  native: boolean;
  answer?: string;
  answeredAt?: string;
};
type Briefing = Omit<OutcomeBoardData, 'tasks'> & {
  project: Project;
  lead: { owner: string; agent?: string; epoch: number; reason: string } | null;
  tasks: Task[];
  questions: Question[];
  decisions: { id: string; text: string; rationale: string; owner: string; createdAt: string }[];
};
type Notice = { id: number; type: string; message: string; taskId?: string; createdAt: string };
const short = (id: string) => id.slice(0, 8);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const active = new Set(['preparing', 'running', 'redirecting', 'cancelling', 'verifying']);
const needsAttention = new Set(['blocked', 'uncertain', 'failed']);
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([pretty(value)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const [token, setToken] = useState(() => {
    const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
    if (supplied) {
      sessionStorage.setItem('marionette-token', supplied);
      history.replaceState(null, '', location.pathname);
    }
    return supplied ?? sessionStorage.getItem('marionette-token') ?? '';
  });
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(localStorage.getItem('marionette-project') ?? '');
  const [brief, setBrief] = useState<Briefing | null>(null),
    [page, setPage] = useState('Overview'),
    [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<string | null>(null),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false),
    [pending, setPending] = useState(false);
  const [lease, setLease] = useState<Lease | null>(null),
    [events, setEvents] = useState<Notice[]>([]),
    [toast, setToast] = useState(''),
    [search, setSearch] = useState('');
  const [consumer] = useState(() => {
    let v = localStorage.getItem('marionette-consumer');
    if (!v) {
      v = 'dashboard:' + crypto.randomUUID();
      localStorage.setItem('marionette-consumer', v);
    }
    return v;
  });
  async function api(action: string, input: unknown = {}) {
    const response = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, input }),
      signal: AbortSignal.timeout(
        action.startsWith('cleanup.')
          ? 300000
          : action === 'profile.validate'
            ? 135000
            : action === 'profile.discover'
              ? 45000
              : 15000,
      ),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'Request failed');
    return data.result;
  }
  async function refresh() {
    const ps = await api('project.list');
    setProjects(ps);
    if (!ps.some((p: Project) => p.id === projectId)) setProjectId(ps[0]?.id ?? '');
    if (projectId) {
      setBrief(await api('project.briefing', { projectId, compact: false }));
    }
  }
  useEffect(() => {
    setBrief(null);
    setSelected(null);
    setEvents([]);
    setLease(JSON.parse(sessionStorage.getItem('marionette-lease:' + projectId) ?? 'null'));
    localStorage.setItem('marionette-project', projectId);
  }, [projectId]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false,
      busy = false,
      first = true,
      last = 0;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const ps: Project[] = await api('project.list');
        if (cancelled) return;
        setProjects(ps);
        if (!ps.some((p) => p.id === projectId)) {
          setProjectId(ps[0]?.id ?? '');
          setConnected(true);
          return;
        }
        if (projectId) {
          const [b, inbox] = await Promise.all([
            api('project.briefing', { projectId, compact: false }),
            api('inbox.read', { projectId, consumer, limit: 200 }),
          ]);
          if (cancelled) return;
          setBrief(b);
          setEvents(inbox.events);
          const updates = first
            ? { events: [], cursor: b.eventCursor }
            : await api('inbox.read', { projectId, consumer, after: last, limit: 200 });
          if (cancelled) return;
          const fresh: Notice[] = updates.events.filter((e: Notice) =>
            [
              'task.completed',
              'task.failed',
              'question.opened',
              'worker.disconnected',
              'lead.handover',
            ].includes(e.type),
          );
          if (!first && fresh.length) {
            setToast(fresh.at(-1)!.message);
            if ('Notification' in window && Notification.permission === 'granted')
              new Notification('Marionette', { body: fresh.at(-1)!.message, tag: 'marionette' });
          }
          last = Math.max(last, updates.cursor);
          first = false;
        }
        setConnected(true);
      } catch {
        if (!cancelled) setConnected(false);
      } finally {
        busy = false;
      }
    }
    void poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, projectId, consumer]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!modal && !selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>(modal ? '.modal' : '.task-drawer');
    const items = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ) ?? [],
      );
    items()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        modal ? setModal(null) : setSelected(null);
        return;
      }
      if (e.key === 'Tab') {
        const list = items(),
          first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [modal, selected]);
  const mine = !!(
    lease &&
    brief?.lead?.owner === lease.owner &&
    brief?.lead?.epoch === lease.epoch
  );
  const task = brief?.tasks.find((t) => t.id === selected);
  const questions = brief?.questions.filter((q) => !q.answeredAt) ?? [];
  async function perform(action: string, input: unknown, success = 'Saved') {
    setPending(true);
    setError('');
    try {
      const r = await api(action, input);
      await refresh();
      setToast(success);
      return r;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setPending(false);
    }
  }
  function rememberLease(l: Lease) {
    sessionStorage.setItem('marionette-lease:' + projectId, pretty(l));
    setLease(l);
  }
  async function control(type: string, text?: string, keys?: string[]) {
    if (!task) return;
    await perform(
      'task.control',
      { lease, taskId: task.id, key: crypto.randomUUID(), type, text, keys },
      'Control request queued',
    );
    setModal(null);
  }
  async function formSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      value = (name: string) => String(f.get(name) ?? '');
    try {
      if (modal === 'connect') {
        const r = await perform(
          'project.register',
          {
            name: value('name'),
            root: value('root'),
            session: value('session'),
            socketPath: value('socket'),
            workspaceId: value('workspace'),
            maxConcurrency: Number(value('concurrency')),
          },
          'Project connected',
        );
        setProjectId(r.id);
      } else if (modal === 'lead') {
        const r = await perform(
          'lead.acquire',
          {
            projectId,
            owner: value('owner'),
            agent: value('leadAgent'),
            expectedEpoch: brief?.lead?.epoch ?? 0,
            takeover: !!brief?.lead,
            reason: value('reason'),
          },
          'You have control',
        );
        rememberLease(r.lease);
      } else if (modal === 'handover') {
        const r = await perform(
          'lead.handover',
          { lease, toOwner: value('owner'), agent: value('leadAgent'), reason: value('reason') },
          'Control transferred',
        );
        download(`marionette-${value('owner')}-lease.json`, r.lease);
        sessionStorage.removeItem('marionette-lease:' + projectId);
        setLease(null);
      } else if (modal === 'assignment') {
        await perform(
          'task.submit',
          {
            lease,
            assignment: {
              projectId,
              key: crypto.randomUUID(),
              title: value('title'),
              workstream: value('workstream'),
              kind: value('profileId')
                ? brief!.profiles.find((p) => p.id === value('profileId'))!.kind
                : value('kind'),
              ...(value('outcomeId')
                ? {
                    outcomeId: value('outcomeId'),
                    expectedTreeRevision: brief!.outcomes.find((o) => o.id === value('outcomeId'))!
                      .revision,
                  }
                : {}),
              ...(value('parentId') ? { parentId: value('parentId') } : {}),
              ...(value('profileId') ? { profileId: value('profileId') } : {}),
              canDelegate: f.get('canDelegate') === 'on',
              prompt: value('prompt'),
              execution:
                value('execution') === 'worktree'
                  ? {
                      mode: 'worktree',
                      ...(value('baseRef').trim() ? { baseRef: value('baseRef').trim() } : {}),
                    }
                  : { mode: 'shared' },
              ownership: value('ownership')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              dependencies: f.getAll('dependency').map(String),
              checks: JSON.parse(value('checks')),
              maxAttempts: 2,
            },
          },
          'Assignment queued',
        );
      } else if (modal === 'decision') {
        await perform(
          'decision.record',
          { lease, text: value('text'), rationale: value('reason') },
          'Decision recorded',
        );
      } else if (modal === 'redirect' || modal === 'reply') {
        await control(modal, value('text'));
      } else if (modal === 'keys') {
        await control('keys', undefined, value('keys').trim().split(/\s+/));
      } else if (modal === 'reconcile') {
        await perform(
          'task.reconcile',
          { lease, taskId: task?.id, resolution: value('resolution'), reason: value('reason') },
          'Run reconciled',
        );
      }
      setModal(null);
    } catch (e) {
      setError(String(e));
    }
  }
  if (!token)
    return (
      <main className="welcome">
        <div className="brand-mark">
          <Command size={26} />
        </div>
        <p className="eyebrow">MARIONETTE</p>
        <h1>
          Your project,
          <br />
          working together.
        </h1>
        <p>
          Open the local access link printed by <code>node dist/cli.js dashboard</code>, or enter
          your instance token below.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get('token') as string;
            sessionStorage.setItem('marionette-token', v);
            setToken(v);
          }}
        >
          <label>
            Instance token
            <input type="password" name="token" required autoComplete="off" />
          </label>
          <button className="primary">
            Connect <ArrowRight size={16} />
          </button>
        </form>
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark">
          <div className="brand-mark">
            <Command size={22} />
          </div>
          <span>
            marionette<span className="wordmark-dot">.</span>
          </span>
        </div>
        <label className="project-picker">
          <span>PROJECT</span>
          <select
            aria-label="Current project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {!projects.length && <option value="">No project connected</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Main navigation">
          {[
            { name: 'Overview', icon: LayoutDashboard },
            { name: 'Outcomes', icon: CheckCircle2 },
            { name: 'Workstreams', icon: ListTodo },
            { name: 'Inbox', icon: Inbox },
            { name: 'Decisions', icon: CircleDot },
            { name: 'Connection', icon: Settings2 },
          ].map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={page === name ? 'nav-item chosen' : 'nav-item'}
              onClick={() => setPage(name)}
            >
              <Icon size={18} />
              {name}
              {name === 'Inbox' && events.length > 0 && (
                <span className="count">{events.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="server-status">
            <span className={'live-dot ' + (!connected ? 'offline' : '')} />
            {connected ? 'Supervisor connected' : 'Reconnecting…'}
          </div>
          <p>
            Workers keep moving.
            <br />
            Your conversation stays open.
          </p>
          <button
            className="subtle"
            onClick={() => {
              setError('');
              setModal('connect');
            }}
          >
            <Plus size={16} /> Connect a project
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{brief?.project.name ?? 'Getting started'}</strong>
          </div>
          <button
            className="icon-button"
            title="Open inbox"
            aria-label="Open inbox"
            onClick={() => setPage('Inbox')}
          >
            <Bell size={19} />
            {questions.length > 0 && <span className="notification-dot" />}
          </button>
        </header>
        {!connected && (
          <div className="connection-warning" role="status">
            Cannot reach the supervisor. Retrying every two seconds. Check the instance token or run{' '}
            <code>node dist/cli.js start</code>. Your saved work is retained.
          </div>
        )}
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">PROJECT CONTROL</p>
              <h1>{page === 'Overview' ? 'Keep the whole project in view.' : page}</h1>
              <p className="muted">
                {page === 'Overview'
                  ? 'One lead. Independent workers. A shared direction.'
                  : page === 'Outcomes'
                    ? 'Observable outcomes, accountable delegation, and verified completion.'
                    : page === 'Workstreams'
                      ? 'Bounded assignments, clear ownership, visible progress.'
                      : page === 'Inbox'
                        ? 'Completion updates and questions, saved until you acknowledge them.'
                        : page === 'Decisions'
                          ? 'The choices that keep every agent working toward the same outcome.'
                          : 'Explicit connections. No reliance on the focused terminal.'}
              </p>
            </div>
            {brief && (
              <button
                className="primary"
                disabled={!mine}
                onClick={() => {
                  setError('');
                  setModal('assignment');
                }}
              >
                <Plus size={17} /> New assignment
              </button>
            )}
          </div>
          {error && !modal && (
            <div className="error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {!brief ? (
            <section className="empty-state">
              <Link size={32} />
              <h2>Connect your first workspace</h2>
              <p>
                Choose a project folder, Herdr session, and workspace. Marionette will operate only
                within that explicit connection.
              </p>
              <button className="primary" onClick={() => setModal('connect')}>
                Connect workspace <ArrowRight size={17} />
              </button>
            </section>
          ) : (
            <>
              <section className="lead-strip">
                <div className="lead-avatar">
                  <Command size={19} />
                </div>
                <div>
                  <strong>
                    {brief.lead?.owner ?? 'No lead has control yet'}
                    {brief.lead?.agent ? ` · ${brief.lead.agent}` : ''}
                  </strong>
                  <p>
                    {mine
                      ? 'This dashboard holds dispatch control.'
                      : brief.lead
                        ? `Control version ${brief.lead.epoch} · Workers continue during handover.`
                        : 'Acquire control before assigning work.'}
                  </p>
                </div>
                <div className="lead-actions">
                  {mine ? (
                    <>
                      <span className="pill green">You have control</span>
                      <button onClick={() => setModal('handover')}>
                        Hand over <ArrowRight size={15} />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setModal('lead')}>
                      {brief.lead ? 'Take control' : 'Acquire control'} <ArrowRight size={15} />
                    </button>
                  )}
                </div>
              </section>
              {page === 'Outcomes' && (
                <OutcomeBoard
                  data={brief}
                  projectId={projectId}
                  canEdit={mine}
                  pending={pending}
                  onTask={setSelected}
                  onAddTask={() => setModal('assignment')}
                  onAction={(action, input, success) =>
                    perform(action, { ...input, lease }, success)
                  }
                />
              )}
              {page === 'Overview' && (
                <>
                  <div className="metrics">
                    {[
                      {
                        label: 'In progress',
                        value: brief.tasks.filter((t) => active.has(t.status)).length,
                        icon: Activity,
                        color: 'blue',
                      },
                      {
                        label: 'Needs attention',
                        value: brief.tasks.filter((t) => needsAttention.has(t.status)).length,
                        icon: Bell,
                        color: 'amber',
                      },
                      {
                        label: 'Verified complete',
                        value: brief.tasks.filter((t) => t.status === 'completed').length,
                        icon: CheckCircle2,
                        color: 'green',
                      },
                      {
                        label: 'Workstreams',
                        value: new Set(brief.tasks.map((t) => t.workstream)).size,
                        icon: ListTodo,
                        color: 'purple',
                      },
                    ].map(({ label, value, icon: Icon, color }) => (
                      <div className="metric" key={label}>
                        <span>
                          {label}
                          <Icon size={17} className={color} />
                        </span>
                        <strong>{value.toString().padStart(2, '0')}</strong>
                      </div>
                    ))}
                  </div>
                  {questions.length > 0 && (
                    <section className="attention-card">
                      <div>
                        <Bell size={19} />
                        <strong>
                          {questions.length}{' '}
                          {questions.length === 1 ? 'question needs' : 'questions need'} your
                          attention
                        </strong>
                      </div>
                      <p>{questions[0].text}</p>
                      <button onClick={() => setSelected(questions[0].taskId)}>
                        Review question <ArrowRight size={16} />
                      </button>
                    </section>
                  )}
                </>
              )}
              {(page === 'Overview' || page === 'Workstreams') && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>{page === 'Overview' ? 'Work in motion' : 'All assignments'}</h2>
                      <p>{brief.tasks.length} assignments across your project</p>
                    </div>
                    <input
                      className="search"
                      aria-label="Filter assignments"
                      placeholder="Filter assignments…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {brief.tasks.length === 0 ? (
                    <div className="empty-inline">
                      <ListTodo size={28} />
                      <h3>Give your first worker a direction</h3>
                      <p>
                        Describe an outcome, assign ownership, and define how completion will be
                        checked.
                      </p>
                      <button disabled={!mine} onClick={() => setModal('assignment')}>
                        Create an assignment <Plus size={15} />
                      </button>
                    </div>
                  ) : (
                    <div className="task-table" role="group" aria-label="Assignments">
                      <div className="table-labels">
                        <span>ASSIGNMENT</span>
                        <span>AGENT</span>
                        <span>STATUS</span>
                        <span>ATTEMPT</span>
                      </div>
                      {brief.tasks
                        .filter((t) =>
                          (t.title + ' ' + t.workstream + ' ' + t.status)
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((t) => (
                          <button className="task-row" key={t.id} onClick={() => setSelected(t.id)}>
                            <span className="task-name">
                              <span className={'task-symbol ' + t.kind}>
                                <Terminal size={17} />
                              </span>
                              <span>
                                <strong>{t.title}</strong>
                                <small>
                                  {t.workstream} <span>·</span> {short(t.id)}
                                </small>
                              </span>
                            </span>
                            <span className="agent-label">
                              {t.kind === 'agy' ? 'AGY' : t.kind === 'codex' ? 'Codex' : 'Claude'}
                            </span>
                            <span>
                              <Status status={t.status} />
                            </span>
                            <span className="attempt">
                              {t.attempt} / {t.maxAttempts}
                              <ChevronRight size={16} />
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </section>
              )}
              {page === 'Overview' && (
                <div className="bottom-grid">
                  <section className="panel small-panel">
                    <div className="panel-heading">
                      <h2>Latest decisions</h2>
                      <button className="text-button" onClick={() => setPage('Decisions')}>
                        View all <ArrowRight size={15} />
                      </button>
                    </div>
                    {brief.decisions.length ? (
                      brief.decisions
                        .slice(-3)
                        .reverse()
                        .map((d) => (
                          <div className="decision-preview" key={d.id}>
                            <CircleDot size={16} />
                            <div>
                              <strong>{d.text}</strong>
                              <small>{d.owner}</small>
                            </div>
                          </div>
                        ))
                    ) : (
                      <p className="empty-copy">
                        Decisions made by the lead will appear here and travel with every handover.
                      </p>
                    )}
                  </section>
                  <section className="panel small-panel handoff-card">
                    <p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p>
                    <h2>
                      Desktop or terminal.
                      <br />
                      The same project state.
                    </h2>
                    <p>Take a current briefing into Codex desktop or a lead agent inside Herdr.</p>
                    <button onClick={() => download('marionette-briefing.json', brief)}>
                      <Download size={16} /> Export briefing
                    </button>
                  </section>
                </div>
              )}
              {page === 'Inbox' && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      Project inbox <span className="muted">({events.length})</span>
                    </h2>
                    <div className="button-group">
                      <button
                        onClick={async () => {
                          if ('Notification' in window) {
                            const p = await Notification.requestPermission();
                            setToast(
                              p === 'granted'
                                ? 'Desktop alerts enabled while the dashboard is open'
                                : 'Use the persistent inbox for all updates',
                            );
                          }
                        }}
                      >
                        <Bell size={16} /> Desktop alerts
                      </button>
                      <button
                        disabled={!events.length}
                        onClick={() =>
                          void perform(
                            'inbox.ack',
                            { projectId, consumer, cursor: events.at(-1)?.id },
                            'Events acknowledged',
                          )
                            .then(() => setEvents([]))
                            .catch(() => {})
                        }
                      >
                        <Check size={16} /> Mark read
                      </button>
                    </div>
                  </div>
                  <p className="inbox-note">
                    Events remain available to other consumers. Desktop alerts require this
                    dashboard to be open. MCP inbox updates do not wake an idle Codex conversation.
                  </p>
                  {events.length ? (
                    events
                      .slice()
                      .reverse()
                      .map((e) => (
                        <button
                          className="inbox-event"
                          key={e.id}
                          onClick={() => e.taskId && setSelected(e.taskId)}
                        >
                          <span
                            className={
                              'event-dot ' +
                              (e.type.includes('completed')
                                ? 'green-bg'
                                : e.type.includes('question')
                                  ? 'amber-bg'
                                  : '')
                            }
                          />
                          <span>
                            <strong>{e.message}</strong>
                            <small>
                              {e.type} · {new Date(e.createdAt).toLocaleString()}
                            </small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))
                  ) : (
                    <div className="empty-inline">
                      <CheckCircle2 size={28} />
                      <h3>You’re all caught up</h3>
                      <p>New updates will appear here as workers make progress.</p>
                    </div>
                  )}
                </section>
              )}
              {page === 'Decisions' && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Project decisions</h2>
                    <button disabled={!mine} onClick={() => setModal('decision')}>
                      <Plus size={16} /> Record decision
                    </button>
                  </div>
                  {brief.decisions.length ? (
                    brief.decisions
                      .slice()
                      .reverse()
                      .map((d) => (
                        <article className="decision" key={d.id}>
                          <p className="eyebrow">
                            {d.owner} · {new Date(d.createdAt).toLocaleDateString()}
                          </p>
                          <h3>{d.text}</h3>
                          <p>{d.rationale}</p>
                        </article>
                      ))
                  ) : (
                    <div className="empty-inline">
                      <CircleDot size={28} />
                      <h3>A shared source of direction</h3>
                      <p>
                        Record design choices, architecture decisions, and priorities for every
                        agent.
                      </p>
                    </div>
                  )}
                </section>
              )}
              {page === 'Connection' && (
                <section className="panel connection-panel">
                  <h2>Connected workspace</h2>
                  <dl>
                    {[
                      ['Project', brief.project.name],
                      ['Root directory', brief.project.root],
                      ['Herdr session', brief.project.session],
                      ['Workspace', brief.project.workspaceId],
                      ['Socket', brief.project.socketPath],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>
                          <code>{v}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    onClick={() =>
                      void perform(
                        'project.inspect',
                        { projectId },
                        'Herdr workspace connection verified',
                      ).catch(() => {})
                    }
                  >
                    <RefreshCw size={16} /> Check connection
                  </button>
                  <hr />
                  <h3>Continue in Herdr</h3>
                  <p>Attach to this named session:</p>
                  <pre>herdr --session {brief.project.session}</pre>
                  <p>
                    Configure the Marionette MCP server for your terminal lead, then acquire control
                    with a fresh briefing. A handover lease can also be supplied to the CLI.
                  </p>
                  <p className="muted">
                    Marionette never closes an existing session or uses the UI-focused pane as an
                    implicit target.
                  </p>
                </section>
              )}
            </>
          )}
          <footer>
            MARIONETTE <span>Local orchestration · Durable project state</span>
          </footer>
        </div>
      </main>
      {task && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <aside
            className="task-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Task details"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <p className="eyebrow">
                {task.workstream} / {short(task.id)}
              </p>
              <button
                className="icon-button"
                aria-label="Close task details"
                onClick={() => setSelected(null)}
              >
                <X size={21} />
              </button>
            </header>
            <h2>{task.title}</h2>
            <div className="detail-meta">
              <Status status={task.status} />
              <span>
                {task.kind}
                {task.model ? ` · ${task.model}` : ' · Runtime default (exact model unreported)'} ·
                Revision {task.revision} · Attempt {task.attempt}
              </span>
            </div>
            {task.error && <div className="error">{task.error}</div>}
            {task.waitReason && <p className="inbox-note">{task.waitReason}</p>}
            <div className="task-controls">
              <button
                disabled={
                  !mine || ['completed', 'cancelled', 'failed', 'uncertain'].includes(task.status)
                }
                onClick={() => setModal('redirect')}
              >
                <Send size={15} /> Redirect
              </button>
              <button
                disabled={!mine || !(active.has(task.status) || task.status === 'queued')}
                onClick={() => void control('pause').catch(() => {})}
              >
                <Pause size={15} /> Pause
              </button>
              <button
                disabled={!mine || !['blocked', 'paused'].includes(task.status)}
                onClick={() => setModal('reply')}
              >
                <Play size={15} /> Continue
              </button>
              <button
                disabled={
                  !mine || ['completed', 'cancelled', 'failed', 'uncertain'].includes(task.status)
                }
                onClick={() => void control('cancel').catch(() => {})}
              >
                <X size={15} /> Cancel
              </button>
              {['failed', 'cancelled'].includes(task.status) && (
                <button
                  disabled={!mine || task.attempt >= task.maxAttempts}
                  onClick={() =>
                    void perform(
                      'task.retry',
                      { lease, taskId: task.id, key: crypto.randomUUID() },
                      'Retry queued',
                    ).catch(() => {})
                  }
                >
                  <RefreshCw size={15} /> Retry
                </button>
              )}
              {task.status === 'uncertain' && (
                <button disabled={!mine} onClick={() => setModal('reconcile')}>
                  Reconcile delivery
                </button>
              )}
            </div>
            {questions
              .filter((q) => q.taskId === task.id)
              .map((q) => (
                <section className="question" key={q.id}>
                  <p className="eyebrow">
                    {q.native ? 'AGENT INPUT REQUIRED' : 'PENDING QUESTION'}
                  </p>
                  <p>{q.text}</p>
                  <button disabled={!mine} onClick={() => setModal(q.native ? 'keys' : 'reply')}>
                    {q.native ? 'Send explicit keys' : 'Answer question'} <ArrowRight size={15} />
                  </button>
                  {q.native && (
                    <button disabled={!mine} onClick={() => setModal('reply')}>
                      Continue after resolving in Herdr
                    </button>
                  )}
                </section>
              ))}
            <section>
              <h3>Assignment</h3>
              <p className="preserve">{task.prompt}</p>
              <h4>Execution</h4>
              <p>
                {task.execution?.mode === 'worktree'
                  ? 'Isolated Git worktree'
                  : 'Shared working directory'}
              </p>
              <p className="preserve">{task.cwd}</p>
              {task.worktree ? (
                <>
                  <p className="preserve">Branch: {task.worktree.branch}</p>
                  <p className="preserve">Base commit: {task.worktree.baseCommit}</p>
                  <p className="preserve">
                    Worktree ({task.worktree.state}): {task.worktree.path}
                  </p>
                  <p className="muted">
                    Available for your review, merge, or pull request workflow.
                  </p>
                </>
              ) : null}
              <h4>Ownership</h4>
              <div className="chips">
                {task.ownership.map((p) => (
                  <code key={p}>{p}</code>
                ))}
              </div>
              {task.dependencies.length > 0 && (
                <>
                  <h4>Dependencies</h4>
                  {task.dependencies.map((id) => (
                    <button key={id} className="text-button" onClick={() => setSelected(id)}>
                      {brief?.tasks.find((t) => t.id === id)?.title ?? short(id)}
                    </button>
                  ))}
                </>
              )}
            </section>
            <section>
              <h3>
                Worker output <span className="live-label">LIVE</span>
              </h3>
              <pre className="terminal-output">
                {task.output || 'Output will appear after the worker starts.'}
              </pre>
            </section>
            <CleanupPanel
              key={task.id}
              taskId={task.id}
              canEdit={mine}
              pending={pending}
              onAction={(action, input) =>
                perform(
                  action,
                  { ...input, lease },
                  action === 'cleanup.preview'
                    ? 'Cleanup eligibility refreshed'
                    : 'Cleanup state saved',
                )
              }
            />
            {task.receipt && (
              <section>
                <h3>Completion report</h3>
                <p>{task.receipt.summary}</p>
                <h4>Artifacts</h4>
                {task.receipt.artifacts.map((a) => (
                  <div className="artifact" key={a}>
                    <CheckCircle2 size={15} />
                    <code>{a}</code>
                  </div>
                ))}
                {task.receipt.evidence.map((e, i) => (
                  <p key={i} className="preserve">
                    {e}
                  </p>
                ))}
              </section>
            )}
            <section>
              <h3>Verification</h3>
              {task.verification?.length ? (
                task.verification.map((v, i) => (
                  <div className={'verification ' + (v.passed ? 'pass' : 'fail')} key={i}>
                    <strong>{v.passed ? 'Passed' : 'Failed'}</strong>
                    <pre>{v.detail}</pre>
                  </div>
                ))
              ) : (
                <>
                  <p className="muted">
                    Completion requires a current worker report and independent checks.
                  </p>
                  <pre>{pretty(task.checks)}</pre>
                </>
              )}
            </section>
          </aside>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <header>
              <h2 id="modal-title">
                {
                  {
                    connect: 'Connect a project',
                    lead: brief?.lead ? 'Take over control' : 'Acquire control',
                    handover: 'Hand over control',
                    assignment: 'New assignment',
                    decision: 'Record a decision',
                    redirect: 'Redirect this worker',
                    reply: 'Continue this assignment',
                    keys: 'Resolve agent input',
                    reconcile: 'Reconcile uncertain delivery',
                  }[modal]
                }
              </h2>
              <button
                className="icon-button"
                aria-label="Close dialog"
                onClick={() => {
                  setModal(null);
                  setError('');
                }}
              >
                <X size={21} />
              </button>
            </header>
            <form onSubmit={formSubmit}>
              {modal === 'connect' && (
                <>
                  <p>
                    Connect to an existing Herdr workspace. No sessions or agents will be closed.
                  </p>
                  <Field label="Project name" name="name" />
                  <Field
                    label="Absolute project directory"
                    name="root"
                    placeholder="/Users/you/Code/project"
                  />
                  <Field label="Herdr session name" name="session" placeholder="project-work" />
                  <Field
                    label="Absolute Herdr socket path"
                    name="socket"
                    placeholder="/Users/you/.config/herdr/sessions/project-work/herdr.sock"
                  />
                  <div className="form-grid">
                    <Field label="Workspace ID" name="workspace" placeholder="w1" />
                    <Field
                      label="Concurrent workers"
                      name="concurrency"
                      type="number"
                      defaultValue="3"
                    />
                  </div>
                </>
              )}
              {(modal === 'lead' || modal === 'handover') && (
                <>
                  <p>
                    {modal === 'handover'
                      ? 'The current lease will become invalid. A private lease file for the receiving lead will download with the handover.'
                      : brief?.lead
                        ? `This explicitly replaces ${brief.lead.owner}. Their existing lease will stop authorizing dispatch. Workers continue running.`
                        : 'Choose an identity for the lead controlling this project.'}
                  </p>
                  <Field
                    label={modal === 'handover' ? 'Receiving lead identity' : 'Your lead identity'}
                    name="owner"
                    defaultValue={modal === 'lead' ? 'dashboard' : ''}
                    placeholder="terminal-lead"
                  />
                  <label>
                    Lead agent
                    <select name="leadAgent" defaultValue={brief?.lead?.agent ?? 'codex-desktop'}>
                      <option value="codex-desktop">Codex desktop</option>
                      <option value="codex">Codex CLI</option>
                      <option value="claude">Claude Code</option>
                      <option value="agy">AGY</option>
                    </select>
                  </label>
                  <Field label="Reason for this change" name="reason" />
                </>
              )}
              {modal === 'assignment' && (
                <>
                  <Field label="Title" name="title" placeholder="Build the settings screen" />
                  <label>
                    Outcome
                    <select name="outcomeId">
                      <option value="">Create an outcome from this assignment's checks</option>
                      {brief!.outcomes.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.objective.slice(0, 120)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Responsible parent
                    <select name="parentId">
                      <option value="">Root lead</option>
                      {brief!.tasks
                        .filter((t) => t.canDelegate)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Exact model profile
                    <select name="profileId">
                      <option value="">Use selected runtime configuration</option>
                      {brief!.profiles.map((p) => (
                        <option key={p.id} value={p.id} disabled={p.availability !== 'available'}>
                          {p.name} · {p.model} ({p.availability})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" name="canDelegate" /> Allow this worker to coordinate
                    children within its scope and shared budget
                  </label>
                  <div className="form-grid">
                    <Field label="Workstream" name="workstream" defaultValue="Product" />
                    <label>
                      Specialist
                      <select name="kind">
                        <option value="codex">Codex</option>
                        <option value="claude">Claude</option>
                        <option value="agy">AGY</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Objective and acceptance criteria
                    <textarea
                      name="prompt"
                      required
                      rows={5}
                      placeholder="Describe the outcome and constraints…"
                    />
                  </label>
                  <Field
                    label="Owned paths (comma-separated files or directories)"
                    name="ownership"
                    placeholder="src/settings, tests/settings"
                  />
                  <ExecutionFields />
                  <label>
                    Verification checks (JSON)
                    <textarea
                      className="code-input"
                      name="checks"
                      rows={5}
                      required
                      defaultValue={pretty([
                        { type: 'file', path: 'src/settings.ts' },
                        { type: 'command', command: 'npm', args: ['test'], timeoutMs: 30000 },
                      ])}
                    />
                  </label>
                  {brief!.tasks.length > 0 && (
                    <fieldset>
                      <legend>Wait for these assignments</legend>
                      {brief!.tasks.map((t) => (
                        <label className="checkbox" key={t.id}>
                          <input type="checkbox" name="dependency" value={t.id} />
                          {t.title}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <p className="muted">
                    Submission returns immediately. Overlapping paths in a shared directory wait.
                    Separate worktrees can edit the same repository files concurrently. Dependencies
                    and the worker limit still apply.
                  </p>
                </>
              )}
              {modal === 'decision' && (
                <>
                  <label>
                    Decision
                    <textarea name="text" required rows={3} />
                  </label>
                  <Field label="Rationale" name="reason" />
                </>
              )}
              {(modal === 'redirect' || modal === 'reply') && (
                <>
                  <p>
                    {modal === 'redirect'
                      ? 'The worker will be interrupted. These instructions replace its objective and invalidate earlier completion reports. Existing verification checks are retained.'
                      : 'Your answer will be saved and sent with the current assignment. The worker must submit a fresh report.'}
                  </p>
                  <label>
                    {modal === 'redirect'
                      ? 'Replacement objective'
                      : 'Answer or continuation instructions'}
                    <textarea
                      name="text"
                      required
                      rows={6}
                      defaultValue={modal === 'redirect' ? task?.prompt : ''}
                    />
                  </label>
                </>
              )}
              {modal === 'keys' && (
                <>
                  <p>
                    Inspect the worker output first. Enter only the keys needed for the specific
                    visible prompt. This does not automatically approve future actions.
                  </p>
                  <Field label="Keys, separated by spaces" name="keys" placeholder="enter" />
                </>
              )}
              {modal === 'reconcile' && (
                <>
                  <p>
                    Use this only after inspecting the original worker. An uncertain request is
                    never automatically replayed.
                  </p>
                  <label>
                    Observed delivery
                    <select name="resolution">
                      <option value="delivered">The instructions were delivered</option>
                      <option value="not-delivered">Not delivered; worker is stopped</option>
                    </select>
                  </label>
                  <Field label="Evidence and reason" name="reason" />
                </>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button type="button" onClick={() => setModal(null)}>
                  Cancel
                </button>
                <button className="primary" disabled={pending}>
                  {pending
                    ? 'Saving…'
                    : modal === 'assignment'
                      ? 'Queue assignment'
                      : modal === 'handover'
                        ? 'Transfer and download lease'
                        : 'Confirm'}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function ExecutionFields() {
  const [mode, setMode] = useState('shared');
  return (
    <>
      <label>
        Working environment
        <select name="execution" value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="shared">Shared directory</option>
          <option value="worktree">Isolated Git worktree</option>
        </select>
      </label>
      {mode === 'worktree' ? (
        <>
          <label>
            Base branch or commit (optional)
            <input name="baseRef" placeholder="HEAD" />
          </label>
          <p className="muted">
            Marionette creates a branch and worktree from committed history. Uncommitted source
            changes are not copied. The result remains available for review, merge, or a pull
            request.
          </p>
        </>
      ) : null}
    </>
  );
}
function Field({
  label,
  ...props
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
}) {
  return (
    <label>
      {label}
      <input required {...props} />
    </label>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={'status status-' + status}>
      <span />
      {status.replaceAll('_', ' ')}
    </span>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
