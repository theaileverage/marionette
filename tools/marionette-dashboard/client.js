import { automaticStage, boardStages, deriveBoardPlacement, resolveManualStages, stageMarker } from './lifecycle.mjs';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const text = (value) => (value == null || value === '' ? '—' : String(value));
const escape = (value) => text(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
const date = (value) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const countLabel = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const humanKey = (value) => String(value ?? '').replaceAll('-', ' ');
const stages = [
  { id: 'backlog', label: 'Backlog', hint: 'Captured' },
  { id: 'ready', label: 'Ready', hint: 'Clarified' },
  { id: 'in-progress', label: 'In progress', hint: 'Active work' },
  { id: 'review', label: 'Review', hint: 'Needs review' },
  { id: 'done', label: 'Done', hint: 'Board complete' },
];
if (stages.some((stage, index) => stage.id !== boardStages[index]))
  throw new Error('Project Board stage definitions are out of sync');
let latestSnapshot = null;
let activeJobId = null;
let activeMessageId = null;
let draggedJobId = null;
let detailCloseTimer = null;
let toastTimer = null;
let jobPage = 1;
let jobFilter = '';
const jobsPerPage = 15;
let resultPage = 1;
const resultsPerPage = 10;
const expandedResults = new Set();
let currentIntake = null;
let speechRecognition = null;
let speechBaseText = '';

const cssStatus = (value) => {
  const normalized = String(value ?? 'unknown').toLowerCase();
  if (['active', 'open', 'running', 'succeeded', 'finished', 'healthy'].includes(normalized)) return 'ok';
  if (['failed', 'cancelled', 'closed', 'unconfirmed', 'error'].includes(normalized)) return 'bad';
  return 'warn';
};
const statusChip = (value) => `<span class="chip chip-${cssStatus(value)}">${escape(value)}</span>`;
const lines = (value) => String(value ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean);

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function readOk(snapshot, key) { return snapshot.reads?.[key]?.ok !== false; }
function showToast(message, tone = 'ok') {
  clearTimeout(toastTimer);
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.dataset.visible = 'true';
  toastTimer = setTimeout(() => { toast.dataset.visible = 'false'; }, 3200);
}
async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function renderHealth(snapshot) {
  const context = snapshot.context;
  const errors = snapshot.errors ?? [];
  const healthy = Boolean(context) && errors.length === 0;
  $('#overall-health').className = `chip chip-${healthy ? 'ok' : errors.length ? 'warn' : 'bad'}`;
  $('#overall-health').textContent = healthy ? 'healthy' : errors.length ? 'partial read' : 'unavailable';
  $('#project-health').innerHTML = [['project', context?.project?.id], ['host', context?.project?.hostId], ['repository', context?.project?.repositoryRoot]].map(([key, value]) => `<div><dt>${key}</dt><dd><code>${escape(value)}</code></dd></div>`).join('');
  $('#session-health').innerHTML = [['session', context?.session?.id], ['role', context?.session?.role], ['state', context?.session?.state]].map(([key, value]) => `<div><dt>${key}</dt><dd>${key === 'state' && value ? statusChip(value) : `<code>${escape(value)}</code>`}</dd></div>`).join('');
}

function renderExecution(snapshot) {
  const jobsAvailable = readOk(snapshot, 'jobs');
  const sessionsAvailable = readOk(snapshot, 'sessions');
  const workflowsAvailable = readOk(snapshot, 'workflows');
  const jobs = snapshot.jobs ?? [];
  const sessions = snapshot.sessions?.rows ?? [];
  const workflows = snapshot.workflows ?? [];
  const normalizedFilter = jobFilter.trim().toLowerCase();
  const filteredJobs = normalizedFilter ? jobs.filter((job) => [job.key, job.id, job.requestId, job.state, job.workspaceId, job.delivery, job.origin?.kind].some((value) => String(value ?? '').toLowerCase().includes(normalizedFilter))) : jobs;
  const jobPageCount = Math.max(1, Math.ceil(filteredJobs.length / jobsPerPage));
  jobPage = Math.min(jobPage, jobPageCount);
  const pageJobs = filteredJobs.slice((jobPage - 1) * jobsPerPage, jobPage * jobsPerPage);
  const openJobs = jobs.filter((job) => job.state === 'open');
  const activeWorkers = sessions.filter((session) => session.role === 'worker' && session.state === 'active');
  const activeWorkflows = workflows.filter((workflow) => ['running', 'pausing', 'cancelling'].includes(workflow.phase));
  const currentAttempt = snapshot.attempts?.current;
  $('#jobs-count').textContent = jobsAvailable ? openJobs.length : '—';
  $('#jobs-detail').textContent = jobsAvailable ? `${jobs.length} total ledger record${jobs.length === 1 ? '' : 's'}` : 'job read failed';
  $('#workers-count').textContent = sessionsAvailable ? activeWorkers.length : '—';
  $('#workflows-count').textContent = workflowsAvailable ? activeWorkflows.length : '—';
  $('#attempts-count').textContent = currentAttempt ? '1' : '—';
  $('#attempts-detail').textContent = currentAttempt ? `${currentAttempt.phase} · current session only` : 'inventory unavailable in CLI';
  $('#jobs-state').textContent = jobsAvailable ? `${openJobs.length} open · ${countLabel(filteredJobs.length, 'matching job')} · page ${jobPage} of ${jobPageCount}` : 'read unavailable';
  $('#job-filter').value = jobFilter;
  $('#jobs').innerHTML = jobsAvailable ? jobs.length ? pageJobs.length ? `<table><thead><tr><th>JOB / REQUEST</th><th>STATE</th><th>WORKSPACE</th><th>DELIVERY</th><th>ORIGIN</th><th>CREATED</th></tr></thead><tbody>${pageJobs.map((job) => `<tr><td><button class="job-link" type="button" data-open-job="${escape(job.id)}"><code>${escape(job.key)}</code></button><small>${escape(job.id)}</small><small>${escape(job.requestId)}</small></td><td>${statusChip(job.state)}</td><td><code>${escape(job.workspaceId)}</code></td><td>${escape(job.delivery)}</td><td>${escape(job.origin?.kind)}</td><td class="time">${date(job.createdAt)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No jobs match this filter.</div>' : '<div class="empty">No jobs recorded by the CLI.</div>' : '<div class="empty empty-error">Job ledger unavailable. See diagnostics above.</div>';
  const jobPagination = $('#job-pagination');
  jobPagination.classList.toggle('hidden', !jobsAvailable || jobs.length === 0);
  jobPagination.innerHTML = jobs.length ? `<button class="button" type="button" data-jobs-page="${jobPage - 1}"${jobPage === 1 ? ' disabled' : ''}>← Previous</button><span>${filteredJobs.length ? `${(jobPage - 1) * jobsPerPage + 1}–${Math.min(jobPage * jobsPerPage, filteredJobs.length)} of ${filteredJobs.length}` : '0 matches'}</span><button class="button" type="button" data-jobs-page="${jobPage + 1}"${jobPage === jobPageCount || filteredJobs.length === 0 ? ' disabled' : ''}>Next →</button>` : '';
  const limitation = snapshot.attempts?.limitation ?? 'Attempt inventory is not available.';
  $('#attempt-visibility').innerHTML = currentAttempt ? `<strong>Current attempt</strong><code>${escape(currentAttempt.id)}</code><span>${escape(currentAttempt.phase)} · ${escape(currentAttempt.workspaceId)} · ${date(currentAttempt.createdAt)}</span><small>${escape(limitation)}</small>` : `<strong>Attempt visibility is partial</strong><span>${escape(limitation)}</span><small>${activeWorkers.length ? `${countLabel(activeWorkers.length, 'active worker session')} shown separately; no attempt record is inferred.` : 'No attempt total is claimed.'}</small>`;
}

function renderResults(snapshot) {
  const available = readOk(snapshot, 'results');
  const response = snapshot.results ?? { rows: [], truncated: false };
  const results = response.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(results.length / resultsPerPage));
  resultPage = Math.min(resultPage, pageCount);
  const pageResults = results.slice((resultPage - 1) * resultsPerPage, resultPage * resultsPerPage);
  $('#result-state').textContent = available ? `${countLabel(results.length, 'result')} · page ${resultPage} of ${pageCount}${response.truncated ? ' · source truncated' : ''}` : 'read unavailable';
  $('#results').innerHTML = available ? results.length ? pageResults.map((result) => {
    const evidence = jsonArray(result.evidence_json); const claims = jsonArray(result.evidence_claims_json); const changedPaths = jsonArray(result.changed_paths_json); const artifacts = jsonArray(result.artifact_digests_json); const expanded = expandedResults.has(result.id); const regionId = `result-body-${result.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const structured = (title, value) => `<section class="result-data"><h4>${title}</h4>${value.length ? `<pre tabindex="0">${escape(JSON.stringify(value, null, 2))}</pre>` : '<p>None recorded.</p>'}</section>`;
    return `<article class="result-card t-resize" data-expanded="${expanded}"><button class="result-summary" type="button" data-result-toggle="${escape(result.id)}" aria-expanded="${expanded}" aria-controls="${regionId}"><span class="result-chevron" aria-hidden="true">›</span><span class="result-summary-main"><span><span class="result-kind">${escape(result.result_kind)}</span><code>${escape(result.id)}</code></span><strong>${escape(result.report_text?.split('\n')[0] ?? 'Durable result')}</strong><span class="result-meta"><span>job <code>${escape(result.job_id)}</code></span><span>workspace <code>${escape(result.workspace_id)}</code></span><time>${date(result.created_at)}</time></span></span><span class="result-counts"><span>${claims.length} claims</span><span>${evidence.length} evidence</span><span>${changedPaths.length} paths</span></span></button><div id="${regionId}" class="result-expand" role="region" aria-label="Result details" aria-hidden="${!expanded}"${expanded ? '' : ' inert'}><div><div class="result-body"><section class="result-report"><h3>Report</h3><p>${escape(result.report_text ?? 'No report text recorded.')}</p></section><div class="result-structured">${structured('Evidence claims', claims)}${structured('Evidence', evidence)}${structured('Changed paths', changedPaths)}${structured('Artifact digests', artifacts)}</div><dl class="result-properties"><div><dt>Attempt</dt><dd><code>${escape(result.attempt_id)}</code></dd></div><div><dt>Workspace</dt><dd><code>${escape(result.workspace_id)}</code></dd></div><div><dt>Brief revision</dt><dd>${escape(result.brief_revision)}</dd></div><div><dt>Created</dt><dd>${date(result.created_at)}</dd></div></dl></div></div></div></article>`;
  }).join('') : '<div class="empty panel">No durable results returned by <code>public_results</code>.</div>' : '<div class="empty empty-error panel">Durable results unavailable.</div>';
  const pagination = $('#result-pagination');
  pagination.classList.toggle('hidden', !available || results.length === 0);
  pagination.innerHTML = results.length ? `<button class="button" type="button" data-results-page="${resultPage - 1}"${resultPage === 1 ? ' disabled' : ''}>← Previous</button><span>Page <strong>${resultPage}</strong> of ${pageCount}</span><button class="button" type="button" data-results-page="${resultPage + 1}"${resultPage === pageCount ? ' disabled' : ''}>Next →</button>` : '';
}

function renderDetails(snapshot) {
  const board = snapshot.board?.entries ?? []; const workflows = snapshot.workflows ?? []; const profiles = snapshot.profiles ?? [];
  const messages = snapshot.boardMessages ?? [];
  const boardAvailable = readOk(snapshot, 'board') && readOk(snapshot, 'boardMessages');
  $('#board-state').textContent = boardAvailable ? `${countLabel(messages.length, 'message')} · ${countLabel(board.length, 'thread')}` : 'unavailable';
  $('#workflow-state').textContent = readOk(snapshot, 'workflows') ? countLabel(workflows.length, 'workflow') : 'unavailable';
  $('#profile-state').textContent = readOk(snapshot, 'profiles') ? countLabel(profiles.length, 'profile') : 'unavailable';
  $('#board').innerHTML = boardAvailable ? messages.length ? `<table class="message-table"><caption class="sr-only">All durable messages, newest first. Select a row for context.</caption><thead><tr><th>FROM / TO</th><th>MESSAGE</th></tr></thead><tbody>${[...messages].reverse().map((post) => {
    const from = messageAuthor(post, snapshot);
    const to = messageRecipient(post);
    return `<tr class="message-row" tabindex="0" role="button" data-open-message="${escape(post.id)}" aria-label="Open message ${escape(post.sequence)} from ${escape(from.name)}"><td class="message-route-cell"><div class="message-route-stack"><div class="message-party" title="${escape(from.title)}"><span>FROM</span><strong>${escape(from.name)}</strong></div><div class="message-party" title="${escape(to.title)}"><span>TO</span><strong>${escape(to.name)}</strong></div></div></td><td class="message-body"><div><p>${escape(post.body)}</p><span>${escape(post.kind)} · ${date(post.createdAt)}</span></div><span class="message-row-arrow" aria-hidden="true">›</span></td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">No durable board messages returned.</div>' : '<div class="empty empty-error">Message board read failed.</div>';
  $('#workflows').innerHTML = readOk(snapshot, 'workflows') ? workflows.length ? workflows.map((workflow) => `<article class="stack-item"><div><strong>${escape(workflow.package?.name ?? workflow.id)}</strong><code>${escape(workflow.id)}</code><span>${escape(workflow.phase)} · rev ${escape(workflow.revision)} · ${date(workflow.createdAt)}</span></div>${statusChip(workflow.outcome ?? workflow.phase)}</article>`).join('') : '<div class="empty">No workflow records returned.</div>' : '<div class="empty empty-error">Workflow read failed.</div>';
  $('#profiles').innerHTML = readOk(snapshot, 'profiles') ? profiles.length ? profiles.map((profile) => `<article class="stack-item"><div><strong>${escape(profile.name)}</strong><code>${escape(profile.kind)} / ${escape(profile.model)}</code><span>${escape((profile.args ?? []).join(' '))}</span></div><span class="chip chip-neutral">configured</span></article>`).join('') : '<div class="empty">No execution profiles returned.</div>' : '<div class="empty empty-error">Profile read failed.</div>';
}

const characterTokens = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['sol', 'Sol'], ['luna', 'Luna'], ['terra', 'Terra'], ['astra', 'Astra'], ['fable', 'Fable']];
const fallbackCharacters = ['Mara', 'Atlas', 'Nova', 'Orion', 'Sage', 'Iris', 'Ember', 'Lyra'];
function stableIndex(value, length) {
  let hash = 0;
  for (const character of String(value ?? '')) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % length;
}
function messageAuthor(post, snapshot) {
  const kind = post.author?.kind ?? 'unknown';
  const id = post.author?.id ?? 'unknown';
  if (kind === 'user') return { name: 'Project Lead', title: `User ID: ${id}` };
  if (kind === 'system') return { name: 'Marionette', title: `System ID: ${id}` };
  const session = (snapshot.sessions?.rows ?? []).find((entry) => entry.id === id);
  const source = `${id} ${session?.workspace_id ?? ''} ${session?.native_kind ?? ''}`.toLowerCase();
  const token = characterTokens.find(([key]) => source.includes(key));
  const base = token?.[1] ?? fallbackCharacters[stableIndex(id, fallbackCharacters.length)];
  return { name: base, title: `Worker ID: ${id}${session?.native_kind ? ` · ${session.native_kind}` : ''}` };
}
function messageRecipient(post) {
  const fromUser = post.author?.kind === 'user';
  return {
    name: fromUser ? 'Project Team' : 'Project Lead',
    title: `Recipient IDs are not exposed · routed through thread: ${post.threadTitle ?? post.threadId ?? 'unknown'}`,
  };
}
function messageDetailMarkup(post, snapshot) {
  const from = messageAuthor(post, snapshot);
  const to = messageRecipient(post);
  const context = [
    ['Thread', post.threadTitle],
    ['Thread ID', post.threadId],
    ['Job ID', post.jobId],
    ...(post.references ?? []).map((reference) => [`Reference · ${reference.kind}`, reference.value]),
  ].filter(([, value]) => value != null && value !== '');
  const metadata = [['Kind', post.kind], ['Sent', date(post.createdAt)], ['Sequence', post.sequence], ['Post ID', post.id], ['Reply to', post.replyToPostId], ['Replaces', post.replacesPostId]];
  return `<div class="message-detail-title"><span class="detail-key">MESSAGE ${escape(post.sequence)}</span><h2>${escape(from.name)} <span aria-hidden="true">→</span> ${escape(to.name)}</h2><p>${date(post.createdAt)}</p></div><div class="message-detail-route"><div title="${escape(from.title)}"><span>FROM</span><strong>${escape(from.name)}</strong></div><div title="${escape(to.title)}"><span>TO</span><strong>${escape(to.name)}</strong></div></div><section class="detail-section-block"><h3>Message</h3><p class="message-detail-body">${escape(post.body)}</p></section><section class="detail-section-block"><h3>Context</h3><dl class="message-detail-list">${context.length ? context.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd><code>${escape(value)}</code></dd></div>`).join('') : '<div><dt>Context</dt><dd>None recorded.</dd></div>'}</dl></section><section class="detail-section-block"><h3>Message metadata</h3><dl class="message-detail-list">${metadata.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${value == null || value === '' ? '—' : `<code>${escape(value)}</code>`}</dd></div>`).join('')}</dl></section>`;
}

function openMessage(messageId) {
  const post = latestSnapshot?.boardMessages?.find((entry) => entry.id === messageId);
  if (!post) return;
  if (activeJobId) closeJob();
  activeMessageId = messageId;
  $('#message-detail-content').innerHTML = messageDetailMarkup(post, latestSnapshot);
  $('#message-detail').dataset.open = 'true'; $('#message-detail').setAttribute('aria-hidden', 'false'); $('#message-detail').removeAttribute('inert');
  $('#message-detail-backdrop').dataset.open = 'true'; document.body.classList.add('drawer-open');
  $('#close-message-detail').focus();
}
function closeMessage() {
  activeMessageId = null;
  $('#message-detail').dataset.open = 'false'; $('#message-detail').setAttribute('aria-hidden', 'true'); $('#message-detail').setAttribute('inert', '');
  $('#message-detail-backdrop').dataset.open = 'false'; document.body.classList.remove('drawer-open');
}

function manualStageMap(snapshot) {
  const threadJobs = new Map((snapshot.board?.entries ?? []).filter((thread) => thread.jobId).map((thread) => [thread.id, thread.jobId]));
  return resolveManualStages(snapshot.boardMessages ?? [], threadJobs);
}

function boardPlacements(snapshot) {
  const manual = manualStageMap(snapshot);
  const recordedResultJobs = new Set(snapshot.lifecycle?.recordedResultJobIds ?? []);
  const acceptedResultJobs = new Set(snapshot.lifecycle?.acceptedResultJobIds ?? []);
  return new Map((snapshot.jobs ?? []).map((job) => [job.id, deriveBoardPlacement({
    job,
    manualStage: manual.get(job.id),
    hasRecordedResult: recordedResultJobs.has(job.id),
    hasAcceptedResult: snapshot.lifecycle?.resultAcceptance?.available === true && acceptedResultJobs.has(job.id),
  })]));
}

function renderBoard(snapshot) {
  const jobs = snapshot.jobs ?? [];
  const placements = boardPlacements(snapshot);
  const byStage = new Map(stages.map((stage) => [stage.id, []]));
  for (const job of jobs) {
    const placement = placements.get(job.id);
    byStage.get(placement.stage).push({ job, placement });
  }
  $('#board-summary').textContent = `${countLabel(jobs.length, 'job')} · ${jobs.filter((job) => job.state === 'open').length} open`;
  $('#kanban').innerHTML = stages.map((stage) => `<section class="kanban-column" data-stage="${stage.id}" aria-labelledby="column-${stage.id}"><div class="column-head"><div><h2 id="column-${stage.id}">${stage.label}</h2><span>${stage.hint}</span></div><span class="column-count">${byStage.get(stage.id).length}</span></div><div class="card-list" data-drop-stage="${stage.id}">${byStage.get(stage.id).map(({ job, placement }) => `<article class="job-card" draggable="true" data-job-id="${escape(job.id)}"><button type="button" class="job-card-main" data-open-job="${escape(job.id)}"><span class="job-key">${escape(job.key)}</span><strong>${escape(humanKey(job.key))}</strong><span class="job-card-meta">${statusChip(job.state)} ${escape(job.delivery)} · ${date(job.createdAt)}</span><span class="stage-source" data-source="${escape(placement.source)}">${placement.automatic ? 'auto' : 'manual'} · ${escape(placement.label)}</span></button><label class="stage-control"><span>Stage override</span><select data-stage-job="${escape(job.id)}" aria-label="Manual stage override for ${escape(job.key)}"><option value="${automaticStage}"${placement.automatic ? ' selected' : ''}>Automatic</option>${stages.map((option) => `<option value="${option.id}"${!placement.automatic && option.id === stage.id ? ' selected' : ''}>${option.label}</option>`).join('')}</select></label></article>`).join('') || '<p class="column-empty">Drop a job here</p>'}</div></section>`).join('');
  const errors = [...(snapshot.errors ?? [])];
  if (snapshot.lifecycle?.recordedResults?.truncated)
    errors.push({ source: 'lifecycle', message: 'Recorded-result job inventory is truncated; some automatic placements may be incomplete.' });
  $('#board-errors').classList.toggle('hidden', errors.length === 0);
  $('#board-errors').innerHTML = errors.length ? `<strong>Partial read</strong><p>${errors.map((error) => `${escape(error.source)}: ${escape(error.message)}`).join('<br>')}</p>` : '';
}

function updateWorkspaceOptions(snapshot) {
  const ids = new Set();
  for (const job of snapshot.jobs ?? []) if (job.workspaceId) ids.add(job.workspaceId);
  for (const session of snapshot.sessions?.rows ?? []) if (session.workspace_id) ids.add(session.workspace_id);
  $('#workspace-options').innerHTML = [...ids].sort().map((id) => `<option value="${escape(id)}"></option>`).join('');
}

function render(snapshot) {
  latestSnapshot = snapshot;
  renderHealth(snapshot); renderExecution(snapshot); renderResults(snapshot); renderDetails(snapshot); renderBoard(snapshot); updateWorkspaceOptions(snapshot);
  renderHumanContext(snapshot);
  $('#project-path').textContent = snapshot.source?.projectPath ?? '—';
  $('#refresh-rate').textContent = `SSE · refresh ${snapshot.source?.refreshMs ?? '—'} ms · explicit board/job writes enabled`;
  $('#captured').textContent = `updated ${date(snapshot.capturedAt)}`;
  $('#connection').className = 'signal signal-ok'; $('#connection').textContent = '● live';
  $('#footer-status').textContent = `Snapshot ${date(snapshot.capturedAt)}`;
  const errors = snapshot.errors ?? [];
  $('#errors').classList.toggle('hidden', errors.length === 0);
  $('#errors').innerHTML = errors.length ? `<strong>Partial read</strong><ul>${errors.map((error) => `<li><code>${escape(error.source)}</code> ${escape(error.message)}</li>`).join('')}</ul>` : '';
}

function renderHumanContext(snapshot) {
  const project = snapshot.context?.project;
  const jobs = snapshot.jobs ?? [];
  const enrichment = snapshot.source?.enrichment;
  $('#human-context-summary').textContent = project ? `${project.repositoryRoot} · ${countLabel(jobs.length, 'job')} in context` : 'Project context unavailable.';
  const state = $('#human-model-state');
  state.className = `chip chip-${enrichment?.available ? 'ok' : 'warn'}`;
  state.textContent = enrichment?.available ? `${enrichment.model} ready` : 'local structure only';
}

function humanList(element, values, empty) {
  element.innerHTML = values?.length ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>` : `<p class="subtle">${escape(empty)}</p>`;
}

function renderHumanIntake(value) {
  currentIntake = value;
  $('#human-result').classList.remove('hidden');
  $('#human-result-summary').textContent = value.summary;
  const source = $('#human-result-source');
  source.className = `chip chip-${value.enrichment.enriched ? 'ok' : 'warn'}`;
  source.textContent = value.enrichment.enriched ? `AI · ${value.enrichment.model}` : 'local structure · no model';
  $('#human-enriched-prompt').value = value.marionette.arguments.prompt;
  humanList($('#human-questions'), value.clarificationQuestions, 'No blocking clarification questions.');
  humanList($('#human-assumptions'), value.assumptions, 'No assumptions recorded.');
  $('#human-payload').textContent = JSON.stringify(value.marionette, null, 2);
  $('#human-result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function switchView(view, updateHash = true) {
  const valid = ['board', 'human'].includes(view) ? view : 'overview';
  $$('.app-view').forEach((element) => { element.dataset.active = String(element.id === `${valid}-view`); });
  $$('.view-tab').forEach((tab) => { const selected = tab.dataset.view === valid; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
  if (updateHash) history.replaceState(null, '', valid === 'overview' ? location.pathname : `#${valid}`);
}
function viewFromHash() { return location.hash === '#board' ? 'board' : location.hash === '#human' ? 'human' : 'overview'; }
function openNewJob() {
  $('#new-job-error').classList.add('hidden');
  $('#new-job-dialog').showModal();
  $('#new-job-form [name="stableKey"]').focus();
}
function closeNewJob() { $('#new-job-dialog').close(); }

function listBlock(title, values) {
  const items = Array.isArray(values) ? values : [];
  return `<section class="brief-block"><h3>${title}</h3>${items.length ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p class="subtle">None specified.</p>'}</section>`;
}
function detailMarkup(value) {
  const { job, brief, posts } = value;
  const content = brief?.content ?? {};
  const comments = (posts ?? []).filter((post) => !String(post.body).startsWith(stageMarker));
  return `<div class="detail-title"><div>${statusChip(job.state)}<span class="detail-key">${escape(job.key)}</span></div><h2>${escape(content.objective ?? job.key)}</h2><p>${escape(job.id)}</p></div><div class="detail-properties"><div><span>Status</span><strong>${escape(job.state)}</strong></div><div><span>Delivery</span><strong>${escape(job.delivery)}</strong></div><div><span>Workspace</span><code>${escape(job.workspaceId)}</code></div><div><span>Created</span><strong>${date(job.createdAt)}</strong></div></div><section class="detail-section-block"><h3>Description</h3><p class="job-description">${escape(content.objective ?? 'No objective returned.')}</p></section><div class="brief-grid">${listBlock('Scope', content.scope)}${listBlock('Ownership', content.ownership)}${listBlock('Constraints', content.constraints)}${listBlock('Standing orders', content.standingOrders)}</div><section class="detail-section-block clarify-block"><div class="comment-heading"><div><h3>Clarify the work</h3><p>Add a durable question to the job thread. This does not revise the immutable brief.</p></div><button id="clarify-job" class="button" type="button">Clarify</button></div><form id="clarify-form" class="clarify-form" hidden><div class="prompt-labels" role="group" aria-label="Prompt templates"><button type="button" data-template="Goal">Goal</button><button type="button" data-template="Acceptance criteria">Acceptance criteria</button><button type="button" data-template="Constraints">Constraints</button><button type="button" data-template="Evidence">Evidence</button><button type="button" data-template="Deliverable">Deliverable</button></div><label>Clarification<textarea name="body" rows="4" required placeholder="Ask a focused question or add labeled context…"></textarea></label><div class="form-actions"><button class="button button-primary" type="submit">Post clarification</button></div></form></section><section class="detail-section-block comments"><div class="comment-heading"><div><h3>Comments</h3><p>${countLabel(comments.length, 'thread post')}</p></div></div><div class="comment-list">${comments.length ? comments.map((post) => `<article class="comment"><div><strong>${escape(post.source_author_id ?? post.source_author_kind)}</strong><span class="chip chip-neutral">${escape(post.kind)}</span><time>${date(post.created_at)}</time></div><p>${escape(post.body)}</p></article>`).join('') : '<p class="subtle">No comments yet.</p>'}</div><form id="comment-form" class="comment-form"><label>Add a comment<textarea name="body" rows="3" required placeholder="Share progress, context, or a handoff note…"></textarea></label><div class="form-actions"><button class="button button-primary" type="submit">Add comment</button></div></form></section>`;
}

async function openJob(jobId) {
  if (activeMessageId) closeMessage();
  clearTimeout(detailCloseTimer); activeJobId = jobId;
  $('#job-detail-content').innerHTML = '<div class="empty">Loading job details…</div>';
  $('#job-detail').dataset.open = 'true'; $('#job-detail').setAttribute('aria-hidden', 'false'); $('#job-detail').removeAttribute('inert'); $('#detail-backdrop').dataset.open = 'true'; document.body.classList.add('drawer-open');
  try {
    const value = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (activeJobId !== jobId) return;
    $('#job-detail-content').innerHTML = detailMarkup(value);
    $('#close-detail').focus();
  } catch (error) { $('#job-detail-content').innerHTML = `<div class="empty empty-error">${escape(error.message)}</div>`; }
}
function closeJob() {
  activeJobId = null; $('#job-detail').dataset.open = 'false'; $('#job-detail').setAttribute('aria-hidden', 'true'); $('#job-detail').setAttribute('inert', ''); $('#detail-backdrop').dataset.open = 'false'; document.body.classList.remove('drawer-open');
}
async function moveJob(jobId, stage) {
  const job = latestSnapshot?.jobs?.find((entry) => entry.id === jobId);
  if (!job) return;
  const previous = boardPlacements(latestSnapshot).get(jobId);
  if ((stage === automaticStage && previous?.automatic) || (stage !== automaticStage && !previous?.automatic && previous?.stage === stage)) return;
  const posts = latestSnapshot.boardMessages ?? [];
  const thread = latestSnapshot.board?.entries?.find((entry) => entry.jobId === jobId);
  const optimistic = { threadId: thread?.id, jobId, body: `${stageMarker}${stage}`, createdAt: new Date().toISOString(), sequence: Number.MAX_SAFE_INTEGER };
  posts.push(optimistic);
  renderBoard(latestSnapshot);
  try { await api(`/api/jobs/${encodeURIComponent(jobId)}/stage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage }) }); showToast(stage === automaticStage ? `${job.key} returned to automatic tracking` : `${job.key} moved to ${stages.find((entry) => entry.id === stage)?.label}`); }
  catch (error) { const index = posts.indexOf(optimistic); if (index >= 0) posts.splice(index, 1); renderBoard(latestSnapshot); showToast(error.message, 'bad'); }
}

async function postComment(kind, body, form) {
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try { await api(`/api/jobs/${encodeURIComponent(activeJobId)}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, body }) }); showToast(kind === 'question' ? 'Clarification posted' : 'Comment added'); await openJob(activeJobId); }
  catch (error) { showToast(error.message, 'bad'); button.disabled = false; }
}

$('#job-detail').setAttribute('inert', '');
$('#message-detail').setAttribute('inert', '');
document.addEventListener('click', (event) => {
  const resultToggle = event.target.closest('[data-result-toggle]');
  if (resultToggle) { const id = resultToggle.dataset.resultToggle; if (expandedResults.has(id)) expandedResults.delete(id); else expandedResults.add(id); renderResults(latestSnapshot); }
  const resultPageButton = event.target.closest('[data-results-page]');
  if (resultPageButton && !resultPageButton.disabled) { resultPage = Number(resultPageButton.dataset.resultsPage); renderResults(latestSnapshot); $('#results-title').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  const jobPageButton = event.target.closest('[data-jobs-page]');
  if (jobPageButton && !jobPageButton.disabled) { jobPage = Number(jobPageButton.dataset.jobsPage); renderExecution(latestSnapshot); $('#execution-title').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  const tab = event.target.closest('[data-view]'); if (tab) switchView(tab.dataset.view);
  const open = event.target.closest('[data-open-job]'); if (open) openJob(open.dataset.openJob);
  const message = event.target.closest('[data-open-message]'); if (message) openMessage(message.dataset.openMessage);
  if (event.target.closest('#add-job')) openNewJob();
  if (event.target.closest('#human-mic')) toggleSpeechInput();
  if (event.target.closest('#copy-human-payload') && currentIntake) {
    if (!navigator.clipboard?.writeText) showToast('Clipboard API is unavailable in this browser', 'bad');
    else navigator.clipboard.writeText($('#human-payload').textContent).then(() => showToast('Marionette JSON copied')).catch(() => showToast('Clipboard permission was denied', 'bad'));
  }
  if (event.target.closest('#send-human-job') && currentIntake) sendHumanJob();
  if (event.target.closest('[data-close-dialog]')) closeNewJob();
  if (event.target.closest('#close-detail') || event.target === $('#detail-backdrop')) closeJob();
  if (event.target.closest('#close-message-detail') || event.target === $('#message-detail-backdrop')) closeMessage();
  if (event.target.closest('#clarify-job')) { const form = $('#clarify-form'); form.hidden = !form.hidden; if (!form.hidden) form.querySelector('textarea').focus(); }
  const template = event.target.closest('[data-template]');
  if (template) { const area = $('#clarify-form textarea'); const prefix = `${template.dataset.template}: `; area.value = area.value ? `${area.value.trimEnd()}\n${prefix}` : prefix; area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'human-enriched-prompt' && currentIntake) {
    currentIntake.marionette.arguments.prompt = event.target.value;
    $('#human-payload').textContent = JSON.stringify(currentIntake.marionette, null, 2);
  }
  if (event.target.id === 'job-filter') {
    jobFilter = event.target.value;
    jobPage = 1;
    renderExecution(latestSnapshot);
    $('#job-filter').focus();
  }
});
document.addEventListener('change', (event) => { if (event.target.matches('[data-stage-job]')) moveJob(event.target.dataset.stageJob, event.target.value); });
document.addEventListener('dragstart', (event) => { const card = event.target.closest('.job-card'); if (!card) return; draggedJobId = card.dataset.jobId; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
document.addEventListener('dragend', (event) => { event.target.closest('.job-card')?.classList.remove('dragging'); $$('.card-list').forEach((list) => list.classList.remove('drag-over')); draggedJobId = null; });
document.addEventListener('dragover', (event) => { const list = event.target.closest('[data-drop-stage]'); if (!list) return; event.preventDefault(); list.classList.add('drag-over'); });
document.addEventListener('dragleave', (event) => { const list = event.target.closest('[data-drop-stage]'); if (list && !list.contains(event.relatedTarget)) list.classList.remove('drag-over'); });
document.addEventListener('drop', (event) => { const list = event.target.closest('[data-drop-stage]'); if (!list || !draggedJobId) return; event.preventDefault(); moveJob(draggedJobId, list.dataset.dropStage); });
document.addEventListener('submit', async (event) => {
  if (event.target.id === 'human-prompt-form') {
    event.preventDefault();
    const form = event.target; const button = form.querySelector('button[type="submit"]'); const message = new FormData(form).get('message');
    button.disabled = true; $('#human-intake-error').classList.add('hidden');
    try { renderHumanIntake(await api('/api/intake/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })); }
    catch (error) { $('#human-intake-error').textContent = error.message; $('#human-intake-error').classList.remove('hidden'); }
    finally { button.disabled = false; }
  }
  if (event.target.id === 'new-job-form') {
    event.preventDefault(); const form = event.target; const submit = form.querySelector('button[type="submit"]'); const data = new FormData(form); submit.disabled = true; $('#new-job-error').classList.add('hidden');
    const value = { stableKey: data.get('stableKey'), workspaceId: data.get('workspaceId'), delivery: data.get('delivery'), prompt: data.get('prompt'), scope: lines(data.get('scope')), ownership: lines(data.get('ownership')), constraints: lines(data.get('constraints')), standingOrders: lines(data.get('standingOrders')) };
    try { const created = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); closeNewJob(); form.reset(); showToast(created.warnings?.[0] ?? 'Job created', created.warnings?.length ? 'warn' : 'ok'); const snapshot = await api('/api/snapshot'); render(snapshot); switchView('board'); await openJob(created.job.id); }
    catch (error) { $('#new-job-error').textContent = error.message; $('#new-job-error').classList.remove('hidden'); }
    finally { submit.disabled = false; }
  }
  if (event.target.id === 'clarify-form') { event.preventDefault(); const body = new FormData(event.target).get('body'); await postComment('question', body, event.target); }
  if (event.target.id === 'comment-form') { event.preventDefault(); const body = new FormData(event.target).get('body'); await postComment('progress', body, event.target); }
});
document.addEventListener('keydown', (event) => {
  const row = event.target.closest?.('[data-open-message]');
  if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openMessage(row.dataset.openMessage); return; }
  if (event.key === 'Escape' && activeMessageId) closeMessage();
  else if (event.key === 'Escape' && activeJobId) closeJob();
});

async function sendHumanJob() {
  const button = $('#send-human-job'); button.disabled = true;
  const argumentsValue = { ...currentIntake.marionette.arguments, prompt: $('#human-enriched-prompt').value };
  try {
    const created = await api(currentIntake.marionette.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argumentsValue) });
    showToast(created.warnings?.[0] ?? 'Job sent to Marionette', created.warnings?.length ? 'warn' : 'ok');
    render(await api('/api/snapshot')); switchView('board'); await openJob(created.job.id);
  } catch (error) { showToast(error.message, 'bad'); }
  finally { button.disabled = false; }
}

function setSpeechState(listening, message) {
  const button = $('#human-mic');
  button.setAttribute('aria-pressed', String(listening));
  button.classList.toggle('listening', listening);
  $('#human-mic-state').textContent = message;
}

function toggleSpeechInput() {
  if (!speechRecognition) return;
  if ($('#human-mic').getAttribute('aria-pressed') === 'true') { speechRecognition.stop(); return; }
  speechBaseText = $('#human-message').value.trim();
  try { speechRecognition.start(); setSpeechState(true, 'Listening… speak naturally.'); }
  catch (error) { setSpeechState(false, error.message); }
}

function initializeSpeechInput() {
  const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SpeechRecognition) { $('#human-mic').disabled = true; setSpeechState(false, 'Voice input is unavailable in this browser.'); return; }
  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = navigator.language || 'en-US';
  speechRecognition.onresult = (event) => {
    const transcript = [...event.results].map((result) => result[0].transcript).join(' ').trim();
    $('#human-message').value = [speechBaseText, transcript].filter(Boolean).join(speechBaseText ? '\n' : '');
  };
  speechRecognition.onerror = (event) => setSpeechState(false, `Voice input: ${event.error}`);
  speechRecognition.onend = () => setSpeechState(false, 'Voice input is idle.');
}

initializeSpeechInput();

function renderFileLaunchState() {
  $('#connection').className = 'signal signal-bad'; $('#connection').textContent = '● server required'; $('#captured').textContent = 'file:// cannot read project data';
  $('#overall-health').className = 'chip chip-warn'; $('#overall-health').textContent = 'not connected';
  $('#project-health').innerHTML = '<div><dt>project</dt><dd><code>not connected</code></dd></div>'; $('#session-health').innerHTML = '<div><dt>session</dt><dd><code>not connected</code></dd></div>';
  $('#project-path').textContent = 'HTTP server required'; $('#refresh-rate').textContent = 'Static files cannot invoke the Marionette CLI or receive SSE.';
  $('#errors').classList.remove('hidden'); $('#errors').innerHTML = '<strong>Start the local dashboard server</strong><p>Opening index.html directly cannot reach the project API.</p><code class="launch-command">cd tools/marionette-dashboard && bun start</code><p>Then open <code>http://127.0.0.1:4179/</code>.</p>';
  $('#kanban').innerHTML = '<div class="empty">Unavailable until served over HTTP.</div>'; $('#footer-status').textContent = 'Serve this directory to connect';
}

switchView(viewFromHash(), false);
if (window.location.protocol === 'file:') renderFileLaunchState();
else {
  const source = new EventSource('/api/events');
  source.addEventListener('snapshot', (event) => { try { render(JSON.parse(event.data)); } catch { $('#connection').className = 'signal signal-bad'; $('#connection').textContent = '● invalid snapshot'; } });
  source.onerror = () => { $('#connection').className = 'signal signal-warn'; $('#connection').textContent = '● reconnecting'; };
}
