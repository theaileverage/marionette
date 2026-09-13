# Marionette 1.0.0-alpha.1 to an always-on Chief of Staff

Architecture review and phased implementation plan. Source inspected at detached commit
`068ef7ef94a76f71a603430211f8497e39755a08` on 2026-09-13. This document proposes no
source changes.

## Executive verdict

Marionette 1.0.0-alpha.1 is a credible durable execution substrate, but it is not yet a
credible always-on Chief of Staff framework.

The alpha already has the difficult low-level primitives worth preserving: project/host/session
identity, immutable requests and briefs, result evidence, idempotency records, resource
reservations, exact native identity, native effect claims, board notification intents, watcher
ownership fencing, workflow package snapshots, and explicit handoff state. It correctly separates
native execution, result acceptance, integration, and notification.

The missing layer is the durable control loop. A production controller cannot be created or
recovered through the public API; the watcher is an on-demand detached polling child which exits
after an idle period; a board delivery is acknowledged when a prompt is submitted, not when the
controller has durably processed it; the workflow-control methods are explicit stubs; profiles are
manually configured; native approvals cannot be forwarded; and project hierarchy does not exist.

The recommended shape is:

```text
launchd/systemd --user
        |
        v
ProjectService (one fenced generation per project/host)
  |-- recovery scanner
  |-- durable event projector + controller inbox
  |-- workflow reducer/scheduler
  |-- harness catalog/router
  |-- native effect and approval reconciler
  `-- sub-project relay/roll-up
        |
        +---- SQLite/WAL + artifacts (authority and state)
        |
        +---- logical ChiefOfStaff controller
        |       `-- replaceable native session incarnation
        |
        `---- worker attempts through exact-version harness adapters
```

“Always on” should mean that the local service and its durable control state survive idle time,
process crashes, application closure, and host restart. It should not mean that a model session is
continuously consuming tokens. The Chief of Staff wakes for a bounded decision cycle when durable
events require judgment.

## Current-state classification

| Requirement | Current alpha | Classification | Required movement |
| --- | --- | --- | --- |
| Managed/recoverable controller | `agent_sessions.role` includes `controller`, and controller authority checks exist. Production code only creates a local `user` and attempt-scoped `worker`; controller records are created directly in tests. | Partial scaffolding | Add a logical controller, replaceable incarnations, public lifecycle operations, exact native rebind/recovery, and token rotation. |
| Reliable event wakeup | Board posts transactionally create notification events/deliveries. A singleton watcher claims deliveries with an owner generation and refuses takeover without confirmed process absence. | Partial | Replace the idle child with an OS-supervised project service. Add a durable event log plus best-effort wake signal and mandatory startup/periodic scans. |
| Durable controller inbox | Board threads/posts are immutable and sequenced; read cursors and notification claims exist. Delivery becomes `acknowledged` after native prompt submission. | New control-plane scope built on existing board primitives | Add controller-specific inbox items, claim revisions, decision cycles, processing acknowledgement tied to durable effects, retry/dead-letter policy, and replay-safe keys. |
| Automatic transitions and repair loops | Packages define steps/transitions/limits; workflow, step, transition, control, approval, and limit tables exist; admission enforces current revisions, boundary, ancestor deadline, attempt count, and parallelism. Five Store methods are explicit `not-implemented` stubs. | Partially modeled, not executable | Implement reducer, scheduler, transition decisions, repair cycles, brief impact closure, controls, resume, and actual repeat/inner-loop enforcement. |
| Harness discovery/profile routing | Composable exact-version Adapter API and a robust Herdr adapter exist. Runtime scheduling is hard-wired to Herdr. Profiles are manual project settings; workflow routing is keyword classification. | Partial | Add an allow-listed harness provider catalog, capability probes, durable endpoint health, role requirements, versioned routing policy, and persisted selection explanations. |
| Human decisions/native approvals | Workflow vocabulary contains `await-decision`; `native_approvals` exists; Herdr observation detects approval text and returns `manual-required`. | Partial model only | Add separate human-decision and native-approval services/operations. Forward only through an explicit supported native action; otherwise retain manual-required state. |
| Service lifetime/crash recovery | WAL/FULL sync, checksummed migrations, exact process/native identities, reservations, effect claims, and conservative `unconfirmed` states exist. | Strong substrate, incomplete lifecycle | Install a launchd/systemd user service, record service incarnations/heartbeats, and implement recovery plans for claimed inbox work, launch/prompt/control/approval effects, and controller rebind. |
| Hierarchical projects | `parent_workflow_id` and descendant limit checks model workflows inside one project. Each database has a singleton binding to one project/host. | New scope | Add explicit project links and cross-database outbox/inbox relay. Child projects keep ownership of their own execution state; parent owns portfolio coordination and roll-up projections. |

## Evidence from the alpha

1. The public architecture explicitly uses shared CLI/SDK operations, SQLite, a local watcher, and
   registered native agents, with no required MCP or HTTP server (`DESIGN.md:3-17`). This is a good
   boundary to preserve.
2. The current design explicitly says workflow progression and correction/control are unavailable
   (`DESIGN.md:19-23`, `README.md:116-120`).
3. The public operation union contains workflow creation and attempt operations, but no transition,
   revise, pause, cancel, resume, limit, controller lifecycle, inbox, or approval operation
   (`src/v1/operations.ts:32-231`).
4. `Store` defines the intended inputs for revisions, transitions, controls, resume, and limits but
   every implementation throws `not-implemented` (`src/v1/store.ts:272-313`,
   `src/v1/store.ts:1766-1784`).
5. Controller authorization exists (`src/v1/runtime.ts:65-78`), but runtime admission creates only
   a worker session (`src/v1/runtime.ts:108-200`); the normal client creates only a local user
   session (`src/v1/client.ts:61-105`).
6. The watcher safely fences ownership and makes old claimed deliveries unconfirmed on takeover
   (`src/v1/watcher.ts:122-179`), but the background child is merely detached
   (`src/v1/background.ts:33-80`) and the polling loop exits after 30 seconds idle by default
   (`src/v1/client.ts:408-474`).
7. Board mutation atomically creates notification events and pending deliveries
   (`src/v1/board.ts:338-480`). The watcher calls a transport and marks those records acknowledged
   when submission succeeds (`src/v1/watcher.ts:271-311`). That is transport acknowledgement, not
   evidence that a controller read the event or committed a decision.
8. Native effects are claimed before mutation and never blindly repeated
   (`src/v1/runtime.ts:203-245`, `src/v1/native.ts:631-735`, `src/v1/native.ts:788-845`). Exact Herdr
   endpoint/session/process identity is well modeled (`src/v1/native.ts:8-80`). However, a hard
   crash after a native mutation but before `native_attempts.identity_json` or launch result is
   persisted leaves the runtime without a complete recovery locator.
9. The adapter layer is a useful seam: exact versions, validated inputs/outputs, capability
   composition, cooperative cancellation, and no automatic retry after invocation
   (`src/v1/adapters.ts:124-299`). The CLI does not load third-party adapters or route scheduler work
   through them (`documentation/v1/adapters.md:97-101`).
10. The current workflow schema is directionally strong: child workflows, immutable transition and
    control intent, attempt controls, limit revisions, and native approval records already exist
    (`src/v1/migrations/002_workflows.ts:12-193`). These should be completed, not replaced.
11. Result/handoff separation and conservative uncertainty are already credible and should remain
    downstream gates (`README.md:108-114`, `src/v1/migrations/003_collaboration_handoff.ts:106-178`).

## Non-negotiable invariants

1. SQLite and durable artifacts are authoritative. Model conversation history, terminal text, and
   in-memory queues are caches or evidence, never state ownership.
2. A service generation, logical controller identity, controller incarnation, harness endpoint
   generation, and native session identity are different identifiers.
3. No external mutation occurs until its intent and exact authority/revision snapshot are durable.
4. Ambiguous post-invocation outcomes are reconciled, never retried by fallback or timeout alone.
5. Transport submission is not controller processing acknowledgement.
6. An inbox item is complete only when its resulting durable decision/effect receipts exist in the
   same project state, or it is explicitly dismissed by an authorized decision.
7. Brief/control/authority/budget revisions are checked again in the transaction immediately before
   managed admission or approval forwarding.
8. Late results remain inspectable but cannot advance stale, paused, cancelling, or cancelled work.
9. A parent project never writes a child project's runtime tables directly. Cross-project commands
   and events use authenticated, idempotent messages.
10. A child result summary is not proof of integration, deployment, publication, or parent outcome
    closure. Roll-up preserves the underlying result/evidence identity.

## Alternatives and selected decisions

### Controller execution model

- **Permanent live model loop:** fastest conversational continuity, but expensive, hard to recover,
  and makes terminal state too important.
- **Stateless model invocation per event:** easy to restart, but loses conversational continuity and
  makes repeated context assembly expensive.
- **Selected — persistent logical controller with replaceable episodic incarnations:** the durable
  controller identity, inbox, memory references, authority, and decision log persist in SQLite. A
  native Herdr/Codex session may be reused when positively matched; otherwise a new incarnation is
  launched with a generated state digest and unprocessed inbox. Correctness never depends on the old
  conversation surviving.

### Wake mechanism

- **Polling only:** simple and durable but wastes cycles or adds latency.
- **Filesystem/socket notification only:** low latency but loses wakeups during process downtime.
- **Selected — durable outbox plus best-effort Unix-socket nudge plus scan:** producers append the
  domain event and due inbox item transactionally. After commit they nudge the project service. The
  service also scans at startup and on a low-frequency watchdog, so a lost nudge cannot lose work.

### Workflow decisions

- **Deterministic state machine only:** predictable but cannot interpret review findings or novel
  blockers.
- **Controller chooses everything:** flexible but adds model calls to mechanical progress.
- **Selected — hybrid:** the runner owns safety gates and explicit package auto-policies; the Chief
  of Staff supplies structured transition requests for judgment calls and repair loops. A package
  may declare an unambiguous automatic edge, but it cannot waive evidence, authority, boundary, or
  budget checks.

### Harness discovery

- **Scan PATH and dynamically import anything found:** convenient but non-reproducible and unsafe.
- **Require all endpoints/profiles to be entered manually:** safe but poor operations.
- **Selected — allow-listed provider manifests plus read-only probes:** installed providers are
  registered explicitly; discovery probes named sockets/binaries and records capability evidence,
  version, host, health, and observation time. No discovered provider receives execution authority
  until separately enabled.

### Project hierarchy

- **Put parent and child projects in one database:** gives atomic updates, but breaks v1's singleton
  project binding, expands failure/authority blast radius, and couples lifecycles.
- **Selected — one database per project plus a same-host durable relay:** each child remains
  authoritative for its own jobs/workflows/results. The parent stores links, grants, allocations,
  cross-project dependencies, and roll-up projections. At-least-once messages are deduplicated by
  link and source sequence. Cross-host transport is deferred until authenticated transport and
  artifact transfer are explicitly designed.

### Native approval

- **Simulate keystrokes/Enter:** broad and unverifiable; reject.
- **Selected — typed native approval capability or manual action:** forwarding is permitted only
  when the adapter identifies the exact approval and provides an explicit action API. Unsupported
  adapters remain `manual-required`; Marionette later observes/reconciles the result.

## Concrete domain types

These are design contracts, not proposed code committed to the alpha.

```ts
type ServiceGeneration = string & { readonly __brand: 'ServiceGeneration' }
type ControllerId = string & { readonly __brand: 'ControllerId' }
type ControllerGeneration = number & { readonly __brand: 'ControllerGeneration' }
type DomainEventId = string & { readonly __brand: 'DomainEventId' }
type InboxItemId = string & { readonly __brand: 'InboxItemId' }
type DecisionCycleId = string & { readonly __brand: 'DecisionCycleId' }
type ProjectLinkId = string & { readonly __brand: 'ProjectLinkId' }
type AuthorityRevision = number & { readonly __brand: 'AuthorityRevision' }
type BudgetRevision = number & { readonly __brand: 'BudgetRevision' }

type ServiceInstance = {
  projectId: ProjectId
  hostId: HostId
  generation: ServiceGeneration
  processIdentity: { pid: number; startToken: string }
  state: 'starting' | 'recovering' | 'ready' | 'draining' | 'stopped' | 'unconfirmed'
  startedAt: Timestamp
  heartbeatAt: Timestamp
}

type ChiefOfStaff = {
  id: ControllerId
  projectId: ProjectId
  profilePolicyId: string
  authorityRevision: AuthorityRevision
  state: 'unconfigured' | 'starting' | 'idle' | 'working' | 'blocked' | 'recovering' | 'paused'
  currentGeneration: ControllerGeneration | null
  stateRevision: Revision
}

type ControllerIncarnation = {
  controllerId: ControllerId
  generation: ControllerGeneration
  session: SessionIdentity
  adapter: AdapterReference
  endpointGeneration: string
  nativeIdentity: NativeIdentity | null
  stateDigest: Digest
  state: 'launching' | 'active' | 'settled' | 'unconfirmed' | 'superseded'
}

type DomainEvent = {
  id: DomainEventId
  projectId: ProjectId
  sequence: number
  kind: string
  aggregate: { kind: string; id: string; revision: number }
  cause: { eventId?: DomainEventId; operationId?: string; inboxItemId?: InboxItemId }
  payload: unknown
  createdAt: Timestamp
}

type ControllerInboxItem = {
  id: InboxItemId
  controllerId: ControllerId
  eventId: DomainEventId
  priority: 'urgent' | 'normal' | 'background'
  dedupeKey: string
  notBefore: Timestamp
  state: 'pending' | 'claimed' | 'submitted' | 'acknowledged' | 'superseded' | 'dead-letter'
  claimRevision: Revision
  claimedBy: { service: ServiceGeneration; controller: ControllerGeneration } | null
  attemptCount: number
  lastError: string | null
}

type InboxAcknowledgement = {
  itemId: InboxItemId
  claimRevision: Revision
  decisionCycleId: DecisionCycleId
  disposition: 'processed' | 'dismissed' | 'superseded'
  receiptIds: string[]
  acknowledgedBy: SessionIdentity
  acknowledgedAt: Timestamp
}

type HarnessInstallation = {
  id: string
  provider: AdapterReference
  source: { kind: 'builtin' } | { kind: 'allow-listed-manifest'; path: string; digest: Digest }
  enabled: boolean
  authorityRevision: AuthorityRevision
}

type HarnessEndpoint = {
  id: string
  installationId: string
  hostId: HostId
  locator: unknown
  nativeVersion: string
  contract: AdapterReference
  capabilities: string[]
  generationEvidence: unknown
  health: 'available' | 'busy' | 'degraded' | 'unavailable' | 'unconfirmed'
  observedAt: Timestamp
}

type RoleRequirement = {
  role: string
  methods: string[]
  requiredCapabilities: string[]
  workspaceAccess: 'inspect' | 'write'
  modelPreferences: string[]
  costClass?: 'low' | 'standard' | 'premium'
  requiresDistinctFrom?: string[]
}

type RouteDecision = {
  id: string
  requirement: RoleRequirement
  policyRevision: Revision
  selected: { endpointId: string; profileId: string } | null
  candidates: Array<{ endpointId: string; eligible: boolean; reasons: string[] }>
  state: 'selected' | 'blocked' | 'awaiting-decision'
}

type HumanDecisionRequest = {
  id: string
  workflowId: WorkflowId
  artifactResultId: ResultId
  question: string
  options: Array<{ id: string; label: string; effects: unknown }>
  expected: { workflow: Revision; brief: Revision; control: Revision; authority: AuthorityRevision }
  state: 'pending' | 'resolved' | 'obsolete' | 'cancelled'
}

type NativeApprovalRequest = {
  id: string
  attemptId: AttemptId
  session: SessionIdentity
  operationFingerprint: Digest
  display: { tool: string; summary: string; risk?: string }
  expected: {
    brief: Revision
    control: Revision
    authority: AuthorityRevision
    nativeServerGeneration: string
  }
  state: 'pending' | 'forwarding' | 'forwarded' | 'resolved' | 'rejected' |
         'obsolete' | 'unconfirmed' | 'manual-required'
}

type BudgetEnvelope = {
  id: string
  owner: { kind: 'project' | 'workflow'; id: string }
  revision: BudgetRevision
  limits: {
    attempts: number
    repeats: number
    parallelism: number
    wallTimeMs: number
    modelTokens?: number
    costMicrounits?: number
  }
  allocated: Record<string, number>
  consumed: Record<string, number>
  reserved: Record<string, number>
}

type ProjectLink = {
  id: ProjectLinkId
  rootProjectId: ProjectId
  parentProjectId: ProjectId
  childProjectId: ProjectId
  parentHostId: HostId
  childHostId: HostId
  mode: 'delegated-controller' | 'local-controller'
  authorityRevision: AuthorityRevision
  budgetRevision: BudgetRevision
  state: 'proposed' | 'active' | 'paused' | 'revoked' | 'unconfirmed'
}

type AuthorityGrant = {
  linkId: ProjectLinkId
  revision: AuthorityRevision
  principal: { controllerId: ControllerId; projectId: ProjectId }
  verbs: string[]
  resources: string[]
  constraints: string[]
  expiresAt: Timestamp | null
  grantedBy: SessionIdentity
}

type ChildResultRollup = {
  linkId: ProjectLinkId
  childProjectId: ProjectId
  childWorkflowId: WorkflowId
  childResultId: ResultId
  childStateRevision: Revision
  resultDigest: Digest
  evidenceDigests: Digest[]
  status: 'reported' | 'verified' | 'accepted' | 'rejected' | 'obsolete'
}
```

The controller's structured response should be a closed union such as:

```ts
type ControllerDecision =
  | { kind: 'workflow-transition'; request: TransitionRequest }
  | { kind: 'brief-revision'; request: ReviseBriefInput }
  | { kind: 'workflow-control'; request: ControlWorkflowInput }
  | { kind: 'workflow-resume'; request: ResumeWorkflowInput }
  | { kind: 'extend-limits'; request: ExtendLimitsInput }
  | { kind: 'request-human-decision'; request: HumanDecisionRequest }
  | { kind: 'resolve-native-approval'; approvalId: string; action: 'approve' | 'reject' }
  | { kind: 'subproject-command'; linkId: ProjectLinkId; command: unknown }
  | { kind: 'acknowledge-only'; reason: string }
```

Every decision includes the inbox item IDs it consumes and deterministic idempotency keys derived
from `(controllerId, itemId, decision kind)`. The service executes the decision and acknowledgement
in one local transaction where possible. If a native or cross-project effect follows, the local
transaction records its outbox/claim first.

## Module boundaries

Preserve `database.ts`, `store.ts`, `artifacts.ts`, `handoff.ts`, the Adapter API, and the existing
Herdr identity/effect logic. Split the new behavior into bounded modules rather than making
`store.ts` or `client.ts` a larger coordinator.

```text
src/v1/
  events/
    event-store.ts          append/query project event sequence
    projectors.ts           transactional inbox/status projections
  inbox/
    controller-inbox.ts     claim/read/ack/release/dead-letter
    decision-cycle.ts       batch assembly and receipt linkage
  service/
    project-service.ts      main loop and bounded work queues
    ownership.ts            generation, process identity, heartbeat, takeover
    wake-port.ts            Unix-socket nudge; correctness-independent
    recovery.ts             startup classification and reconciliation plans
    installers/             launchd and systemd-user definitions
  controllers/
    controller-store.ts     logical identity and incarnation state
    controller-runtime.ts   ensure, launch, rebind, replace, settle
    context-builder.ts      state digest + bounded inbox prompt
  workflows/
    reducer.ts              pure transition/control/revision validation
    workflow-service.ts     transactional application and emitted events
    scheduler.ts            runnable-intent selection and admission
    repair.ts               issue-bound finite repair cycles
    budgets.ts              reservations/debits/allocations
  harnesses/
    provider.ts             discovery/probe capability contracts
    catalog.ts              installations/endpoints/health
    profiles.ts             role requirements and concrete bindings
    router.ts               deterministic eligible candidate ranking
  decisions/
    human-decisions.ts      await/resolve/obsolete
    native-approvals.ts     exact approval state and forwarding/reconcile
  projects/
    links.ts                parent/child identity and grant lifecycle
    relay.ts                cross-database outbox/inbox transport
    authority.ts            grant/revision enforcement
    rollup.ts               child result/status projection
```

`operations.ts` and `client.ts` remain thin public façades. `ProjectService` calls domain services;
it must not contain SQL policy. Harness modules never decide authority. Workflow modules never call
native adapters directly: they create admitted execution/control/approval intents consumed by the
service.

## Lifecycle sequences

### 1. Service startup and controller recovery

```text
OS supervisor -> ProjectService: start(binding)
ProjectService -> SQLite: claim service generation after old process absence check
ProjectService -> Recovery: scan nonterminal claims/intents/inbox/controllers
Recovery -> HarnessCatalog: read-only probe registered endpoint generations
Recovery -> ControllerRuntime: match exact native identity or stable native conversation evidence
alt positive match
  ControllerRuntime -> SQLite: new incarnation/binding revision, rotate token, supersede old claims
else no positive match
  ControllerRuntime -> SQLite: mark old incarnation unconfirmed
  ControllerRuntime -> Harness: durably claim a replacement launch
  ControllerRuntime -> SQLite: persist new exact identity or keep launch unconfirmed
ProjectService -> SQLite: mark ready, project pending inbox
```

Rebinding across a Herdr restart must require the stable native `agent_session` plus project,
workspace, agent kind/name, cwd, and ownership evidence. Pane/terminal IDs may change. If the
conversation cannot be positively matched, do not rewrite the old receipt or pretend continuity;
start a replacement incarnation from durable state only after the old native effect is classified.

### 2. Event wake, controller decision, and acknowledgement

```text
Producer -> SQLite transaction: mutation + DomainEvent + ControllerInboxItem
Producer -> wake socket: best-effort nudge
ProjectService -> SQLite: claim due batch with service/controller generation + claim revision
ProjectService -> ControllerRuntime: submit compact wake summary
Controller -> inbox.read: fetch claimed canonical payloads
Controller -> domain operation: structured decision with expected revisions + idempotency key
Domain operation -> SQLite transaction: decision/effect intent + domain events + inbox ack receipt
ProjectService -> native/cross-project adapter: execute separately from its durable claim
```

If the prompt submission is ambiguous, inbox items remain submitted/unconfirmed and are not
re-prompted until native session state is reconciled. If the controller mutation committed but its
response was lost, replay returns the same idempotency receipt and acknowledgement succeeds once.

### 3. Result-driven transition and repair

```text
Worker -> result.record: immutable result + evidence
Worker/native observation -> attempt settlement
Controller/user -> result.decide: accept or reject
Result service -> event: result.accepted | result.rejected
ProjectService -> controller inbox: wake decision cycle
Controller -> workflow.transition:
  accepted => advance/finish/route as allowed
  rejected => finite repeat to named repair step with issue/result dependencies
Workflow reducer -> transaction:
  validate package edge, evidence, distinct role, brief/control/limits/budget revisions
  close prior step, create next step/job/schedule intent, increment revisions
Scheduler -> attempt admission -> native effect claim -> launch
```

No model call is needed for an explicitly package-declared automatic edge with a single outcome and
no policy choice. Review interpretation, route selection, blocker resolution, and repair target
selection remain controller decisions.

### 4. Pause/cancel/resume race

1. `workflow.control` locks the selected workflow and descendant closure, checks expected revisions,
   increments the control revision, records immutable control intent, closes pending schedule
   admission, and creates attempt control intents in one transaction.
2. Already-admitted launch/native/approval effects remain visible and are reconciled. New effects
   fail their revision check.
3. `drain` waits for current attempts. `safe` uses a typed checkpoint capability; if absent it
   becomes manual/unconfirmed, never a fabricated checkpoint. `now` and `cancel` use typed interrupt.
4. The public workflow becomes `paused`/`cancelled` only after every affected attempt has confirmed
   settlement; otherwise it remains `pausing`/`cancelling` with reasons.
5. `resume` is valid only for `paused`, uses the exact current control/brief/authority/limit revisions,
   and never repeats an uncertain effect. Cancelled work requires a new workflow.

### 5. Crash recovery

Startup groups records into:

- **safe to continue:** durable local intent with no external claim;
- **safe to observe:** external claim has enough exact locator/operation identity;
- **manual reconciliation:** effect may have occurred but cannot be positively observed;
- **terminal:** durable acknowledgement/settlement exists.

The scanner must cover controller turn submission, worker create-tab/start-agent/prompt, controls,
approvals, notification deliveries, handoffs, retirement, cross-project sends, and budget
reservations. It emits a recovery event for each classification and never silently releases an
unconfirmed reservation.

### 6. Nested sub-project command and result roll-up

```text
Root user -> parent DB: create link + authority grant + child budget allocation
Parent relay -> child DB inbox: link.activate (idempotent, expected revisions)
Child service -> child DB: validate parent identity/grant/budget; accept or reject
Child relay -> parent DB: activation acknowledgement
Root ChiefOfStaff -> parent DB outbox: child workflow command + reserved allocation
Relay -> child DB: dedupe(linkId, sourceSequence), admit local work
Child project owns: briefs, jobs, attempts, native effects, approvals, results, handoffs
Child outbox -> parent inbox: progress/blocker/decision/result references
Parent roll-up -> parent DB: immutable projection + evidence/result digests
Root ChiefOfStaff -> parent workflow: accept, request repair, await human, or finish
```

The first implementation should require parent and child to share an execution host. A logical
sub-project can point at a nested repository path, a sibling repository, or the same repository with
a different scope, but it always has a separate project ID, binding, state directory, authority
grant, and budget. No hierarchy is inferred from filesystem paths.

Default `delegated-controller` mode uses one root Chief of Staff and child deterministic project
services; child projects do not burn a second controller model. A later `local-controller` mode may
add subordinate controllers, but their identities, grants, budgets, and roll-up obligations are
explicit and revocable.

## Migration plan

Do not edit migrations 001-005: their checksums are part of the database contract.

### 006_service_events_controller

- Add `service_instances`, `domain_events`, `controller_definitions`,
  `controller_incarnations`, `controller_inbox_items`, `controller_decision_cycles`, and
  `controller_inbox_acknowledgements`.
- Add unique `(project_id, sequence)` events and `(controller_id, dedupe_key)` inbox keys.
- Backfill one explicit `recovery.snapshot` event per current nonterminal aggregate; do not invent a
  historical event stream from old timestamps.
- Retain `watcher_owners` and notification tables for compatibility; the new service adopts their
  processing and records old claimed rows as reconciliation-required on generation change.

### 007_harness_catalog_profiles

- Add installations, manifests/digests, endpoints, endpoint observations, profile definitions,
  role requirements, routing policies, and route decisions.
- Backfill `project_settings` keys `native/*` and `profile/*` into versioned catalog records while
  retaining the original settings as migration evidence.
- Mark backfilled endpoint health `unconfirmed` until a read-only probe succeeds.
- Runtime attempts store adapter ID/version, endpoint ID/generation, profile revision, and route
  decision ID—not only serialized settings JSON.

### 008_workflow_control_plane

- Reuse workflow tables from migration 002.
- Add immutable transition decisions, schedule intents, repair cycles, brief-revision causes,
  control execution receipts, attempt deadlines, and budget ledger/reservations.
- Add indexes for due schedule/control/deadline work.
- Add constraints/triggers preventing acknowledgement without a valid decision receipt and preventing
  active admission when workflow/control/authority/budget revisions differ.
- Preserve existing workflows as records. They do not automatically begin progressing after upgrade
  until explicitly activated at their current revisions.

### 009_decisions_approvals

- Add human decision requests/options/resolutions.
- Extend or companion the existing `native_approvals` table with operation fingerprint, display
  artifact, authority revision, forwarding claim, adapter receipt, resolution evidence, and reason.
- Existing pending approval rows become `manual-required` unless exact operation evidence is present;
  do not infer approval identity from terminal text.

### 010_project_hierarchy

- Add each database's local half of project links, authority grant revisions, budget allocations,
  cross-project outbox/inbox, relay acknowledgements, child status projections, cross-project
  dependencies, and result roll-ups.
- Enforce unique `(link_id, source_sequence)` consumption and acyclic ancestry during link activation.
- Do not infer or auto-link existing projects.
- Same-host only at first; reject cross-host activation before any state mutation.

### Migration operational rules

- All schema/data changes remain numbered, transactional, and checksummed.
- Database migration must not install services, launch agents, probe harnesses, or send messages.
- Service installation/start is a separate reversible command after database migration.
- Before release, verify v5-to-latest upgrades, current-schema reopen, newer-schema rejection, edited
  migration rejection, interrupted migration rollback, and concurrent startup.
- The previous pre-v1 runtime remains a separate explicit import project; the alpha currently states
  that older databases/sessions are not imported, and this plan does not silently change that.

## Public operations

Keep CLI and SDK parity. Suggested operations:

```text
service.install | service.start | service.status | service.stop | service.uninstall
controller.configure | controller.ensure | controller.status | controller.reconcile | controller.replace
event.list
inbox.read | inbox.ack | inbox.release
harness.discover | harness.probe | harness.enable | harness.list
profile.define | profile.route-preview | profile.bind
workflow.transition | workflow.revise | workflow.pause | workflow.cancel
workflow.resume | workflow.extend-limits | workflow.status
decision.list | decision.resolve
approval.list | approval.resolve | approval.reconcile
project.link-propose | project.link-activate | project.link-pause | project.link-revoke
project.authority-grant | project.budget-allocate | project.rollup-read
```

Mutating requests carry expected revisions and idempotency keys. Dry-run/preview is appropriate for
harness enablement, route selection, controller replacement, limit changes, project links, authority
grants, budget allocation, and service uninstall. A preview remains a snapshot, not authorization.

## Phased implementation plan

### Phase 0 — Contract freeze and failure matrix

**Depends on:** nothing.

- Turn this proposal and the existing execution contracts into versioned API/state invariants.
- Decide exact controller replacement authority, supported user-session provenance, budget units, and
  whether any workflow edges are package-auto.
- Define kill points for every external effect.
- Add schema-only tests for proposed types and transition tables before wiring behavior.

**Done when:** every state has legal predecessors/successors, every external effect has a durable
claim/reconciliation rule, and every authority/budget mutation names its expected revisions. No open
question changes table identity or cross-project ownership.

### Phase 1 — Durable event and inbox core

**Depends on:** Phase 0.

- Migration 006 event/inbox/controller records.
- Transactional event append/projectors.
- Claim/read/ack/release with claim revisions and linked receipts.
- Convert board notifications into one producer of domain events without changing board semantics.

**Done when:** crash/restart at every point from producer commit through controller acknowledgement
produces neither lost items nor duplicate durable decisions; transport submission alone never marks
an item processed.

### Phase 2 — Supervised project service and recovery kernel

**Depends on:** Phase 1.

- One fenced service generation per project/host.
- Unix-socket wake nudge plus startup/watchdog scans.
- launchd and systemd-user lifecycle with status/diagnostics.
- Recovery classifier and per-effect reconciliation registry.
- Adopt watcher execution/delivery under the service without changing native authority semantics.

**Done when:** closing the CLI/app, 24 hours idle, service SIGKILL, and host reboot all result in the
same pending inbox/attempt state being resumed or explicitly `unconfirmed`; only one service owns
claims, and no effect is blindly repeated.

### Phase 3 — Harness catalog, routing, and managed Chief of Staff

**Depends on:** Phase 2; Adapter API already exists.

- Migration 007 catalog/profile/router.
- Allow-listed discovery providers and read-only capability probes.
- Persist route decisions and no-fallback-after-claim rule.
- Logical controller plus incarnation launch/rebind/replace/token rotation.
- Bounded context builder using durable state digest and claimed inbox IDs.

**Done when:** a controller survives service restart and Herdr restart with either a positively
verified rebind or a clearly new incarnation; an unavailable profile yields a durable blocked route,
not silent model substitution; no test-only direct `registerSession(role: controller)` setup is needed
for the live lifecycle.

### Phase 4 — Workflow engine, revisions, controls, limits, repair

**Depends on:** Phases 1-3.

- Implement the five Store stubs behind a pure reducer and transactional services.
- Schedule admitted work from durable intents.
- Complete descendant revision/control fencing.
- Enforce attempts, repeats, parallelism, workflow deadline, inner-loop deadline, and budget
  reservations in both scheduler and pre-effect checks.
- Add finite issue-bound repair cycles and stop-boundary enforcement.

**Done when:** rejected review -> repair -> independent re-review -> verification -> handoff can finish
without human bookkeeping; brief/control races retain stale/late evidence without advancement;
limits cannot be escaped via child workflows; pause/cancel/resume predicates from the existing
execution contract pass under process kills and native ambiguity.

### Phase 5 — Human decisions and native approvals

**Depends on:** Phase 4 and harness capability catalog.

- Migration 009 decision/approval evidence.
- Human decision notification/resolution and obsolete-revision handling.
- Typed adapter approval capability where genuinely supported.
- Manual-required flow and post-manual reconciliation elsewhere.

**Done when:** a human choice applies exactly once to the expected workflow revision; a stale choice
cannot resume newer stopped work; an approval racing with pause is either rejected before forwarding
or retained as an in-flight effect; no adapter simulates generic keystrokes as approval.

### Phase 6 — Hierarchical project coordination

**Depends on:** Phases 1-5 because hierarchy reuses their events, authority, budgets, decisions, and
recovery semantics.

- Migration 010 links/grants/budgets/relay/roll-up.
- Same-host relay with ordered, idempotent outbox/inbox.
- Root portfolio workflow and child status/result projections.
- Delegated-controller mode first; optional subordinate controller mode later.
- Cycle prevention, revocation, pause propagation, allocation settlement, and cross-project repair.

**Done when:** one root Chief of Staff can create authorized child work, receive blockers/decisions,
allocate bounded capacity, pause/revoke descendants, and close a parent outcome only from verified
child result references; duplicated/lost relay attempts do not duplicate child work or budget debit;
child service outage cannot make the parent claim success.

### Phase 7 — Full acceptance and alpha/stable gate

**Depends on:** all prior phases.

- Current static/build/package tests.
- Real temporary SQLite/Git fixtures and deterministic crash injection.
- Real Herdr sessions for controller plus workers, including restart and native approval/manual paths.
- Browser-controlled Herdr verification with `HERDR_ENV=1` inside the real pane for relevant E2E
  behavior; pair UI evidence with database/native identity assertions.
- Soak test service ownership, event latency, memory/file descriptors, idle/reboot recovery, and
  multi-project relay.

**Done when:** every scenario below passes on the packaged artifact, live-native claims are clearly
distinguished from fixtures, and there are no nonterminal records whose recovery class is unknown.

## Verification scenarios

### Inbox and wake

1. Kill producer after event commit but before nudge; watchdog processes it once.
2. Kill service after claim but before prompt; takeover reclaims only after old process absence.
3. Kill after prompt may have been accepted; item becomes unconfirmed until exact native observation.
4. Kill controller after durable transition but before ack; replay returns the same transition receipt
   and acknowledges once.
5. Flood low-priority progress plus one urgent blocker; fairness and priority bounds hold without
   starving background items.
6. Poison item exhausts its finite attempts and dead-letters with an operator-visible reason.

### Controller/session recovery

7. Service restart with the same exact Herdr session reuses the logical controller.
8. Herdr restart changes pane/terminal IDs but preserves a positively matched native conversation;
   rebind records new binding evidence.
9. Reused pane/name with a different native session is rejected.
10. Old controller token and old inbox claim revisions fail after replacement.
11. Controller conversation is lost; new incarnation reconstructs state from durable digest and does
    not repeat acknowledged decisions.

### Workflow and controls

12. Review reject -> implementation repair -> distinct reviewer -> pass -> handoff.
13. Brief revision commits immediately before result; result remains retained/stale.
14. Pause/cancel race with admission, launch, approval, result, and handoff.
15. `safe` pause on a harness without checkpoint support reports manual/unconfirmed.
16. Old resume cannot override a newer pause/cancel.
17. Child workflow attempts/repeats/deadline/parallelism debit every ancestor.
18. Inner-loop deadline triggers a durable control intent; timeout alone never proves settlement.

### Harness routing and approvals

19. Malformed/untrusted discovery manifest is rejected before probing/execution.
20. Preferred model unavailable: route blocks or asks for a decision; no silent fallback.
21. Adapter throws after invocation: effect is unconfirmed and another provider is not tried.
22. Native approval exact operation changes before user decision: approval becomes obsolete.
23. Forwarded approval loses response: reconcile before any second forwarding.

### Project hierarchy

24. Replayed parent command produces one child workflow and one budget debit.
25. Parent or child crashes between outbox commit and acknowledgement; relay converges.
26. Grant revocation races child admission; revision winner determines admission, and in-flight effects
    remain explicit.
27. Child outage/blocked/uncertain status rolls up without parent success.
28. Circular parent-child link is rejected.
29. Child accepted report, integrated commit, and deployed outcome remain three distinct roll-up facts.
30. Parent cancellation stops new descendant admission and tracks each child's confirmed/unconfirmed
    settlement separately.

### Service/package acceptance

31. launchd/systemd restarts after SIGKILL and host reboot without duplicate effects.
32. Database migration v5 -> latest preserves existing records and never auto-activates old workflows.
33. Installed tarball, not the source checkout, passes CLI/SDK/service/discovery/workflow/hierarchy
    acceptance.
34. Live Herdr controller/worker lifecycle passes end to end; fixture tests are labeled separately.

## Scope boundaries and release recommendation

- Do not reintroduce the pre-v1 MCP/HTTP supervisor merely to obtain longevity. The OS-supervised
  project service can remain local and use the existing CLI/SDK/SQLite boundary; a local wake socket
  is not a public control API.
- Do not make a controller session a privileged bypass. It receives a revisioned authority grant and
  is subject to the same pre-effect fences as users/workers.
- Do not use board read cursors as the controller inbox. Board collaboration and control-plane event
  consumption have different acknowledgement and replay semantics.
- Do not infer native approvals from screen text beyond raising `manual-required`; exact forwarding
  needs a typed adapter capability.
- Do not start project hierarchy before the single-project inbox, service, workflow, authority,
  budget, and recovery semantics are proven. Federation multiplies any ambiguity below it.
- Keep multi-host hierarchy out of the first hierarchical milestone. The current v1 contract assigns
  one execution host per project, and secure cross-host relay/artifact transport is a separate design.

The credible next release after alpha.1 should therefore be an **always-on single-project control
plane alpha**, not “Chief of Staff complete.” Hierarchical coordination should land only after that
release survives real controller/worker restart and crash scenarios.

## Current verification note

The checked-in review records a prior 107-test integration pass and one live Herdr/AGY prompt smoke,
while explicitly saying that the full lifecycle was not proven. In this inspected worktree, `npm test`
did not begin the suite because dependencies are absent: Node could not resolve `esbuild`. That is an
environment/precondition failure, not current proof of either a passing or failing suite. The source
worktree remained untouched.
