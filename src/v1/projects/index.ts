import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, payloadDigest } from '../database.js';
import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  BriefContentSchema,
  ControlOperationSchema,
  DeliveryKindSchema,
  OriginalRequestSchema,
  ProjectIdSchema,
  ResultIdSchema,
  WorkflowIdSchema,
  WorkflowPackageSnapshotSchema,
  WorkspaceIdSchema,
} from '../model.js';
import type { Store, SessionIdentity } from '../store.js';
const text = z.string().min(1),
  revision = z.number().int().positive();
const sessionSchema = z.object({ id: AgentSessionIdSchema, generation: revision }).strict();
export const projectPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-session'), session: sessionSchema }).strict(),
  z
    .object({
      kind: z.literal('controller'),
      controllerId: text,
      projectId: ProjectIdSchema,
    })
    .strict(),
]);
export type ProjectPrincipal = z.infer<typeof projectPrincipalSchema>;
export const projectGrantSchema = z
  .object({
    verbs: z
      .array(
        z.enum([
          'workflow.create',
          'workflow.control',
          'workflow.activate',
          'workflow.status',
          'result.read',
        ]),
      )
      .min(1),
    workspaceIds: z.array(WorkspaceIdSchema).min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const projectCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workflow.create'),
      stableKey: text,
      package: WorkflowPackageSnapshotSchema,
      request: OriginalRequestSchema,
      brief: BriefContentSchema,
      workspaceId: WorkspaceIdSchema,
      delivery: DeliveryKindSchema,
      boundary: z.enum(['all', 'design-only']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow.control'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: revision,
      expectedControlRevision: revision,
      operation: ControlOperationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow.activate'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: revision,
      expectedBriefRevision: revision,
      expectedControlRevision: revision,
    })
    .strict(),
  z.object({ kind: z.literal('workflow.status'), workflowId: WorkflowIdSchema }).strict(),
  z
    .object({
      kind: z.literal('result.read'),
      workflowId: WorkflowIdSchema,
      resultId: ResultIdSchema,
    })
    .strict(),
]);
export type ProjectCommand = z.infer<typeof projectCommandSchema>;
export const projectEventRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow.status'), workflowId: WorkflowIdSchema }).strict(),
  z
    .object({
      kind: z.literal('result.report'),
      workflowId: WorkflowIdSchema,
      resultId: ResultIdSchema,
    })
    .strict(),
]);
export type ProjectEventRequest = z.infer<typeof projectEventRequestSchema>;
export const projectEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workflow.status'),
      childProjectId: ProjectIdSchema,
      childWorkflowId: WorkflowIdSchema,
      childStateRevision: revision,
      statusDigest: z.string().length(64),
      status: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('result.report'),
      childProjectId: ProjectIdSchema,
      childWorkflowId: WorkflowIdSchema,
      childResultId: ResultIdSchema,
      childStateRevision: revision,
      resultDigest: z.string().length(64),
      evidenceDigests: z.array(z.string().length(64)),
      result: z.unknown(),
      accepted: z.boolean(),
      integrated: z.null(),
      deployed: z.null(),
      projection: z.literal('reported'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('allocation.settled'),
      childProjectId: ProjectIdSchema,
      childWorkflowId: WorkflowIdSchema,
      childStateRevision: revision,
      reservedAttempts: z.number().int().positive(),
      budgetRevision: revision,
    })
    .strict(),
]);
export type ProjectEvent = z.infer<typeof projectEventSchema>;
const linkRow = z.object({
  id: text,
  side: z.enum(['parent', 'child']),
  parent_project_id: ProjectIdSchema,
  child_project_id: ProjectIdSchema,
  host_id: text,
  root_project_id: ProjectIdSchema,
  ancestry_json: text,
  principal_json: text,
  child_actor_json: text,
  secret: text,
  state: z.enum(['proposed', 'active', 'paused', 'revoked', 'unconfirmed']),
  authority_revision: revision,
  budget_revision: revision,
  budget_attempts: z.number(),
  grant_json: text,
  next_sequence: revision,
  received_sequence: z.number(),
});
const receiptSchema = z.object({
  kind: z.enum(['applied', 'rejected']),
  value: z.unknown(),
  reason: z.string().optional(),
});
const envelopeSchema = z
  .object({
    linkId: text,
    sourceProjectId: ProjectIdSchema,
    targetProjectId: ProjectIdSchema,
    hostId: text,
    sequence: revision,
    authorityRevision: revision,
    budgetRevision: revision,
    principal: projectPrincipalSchema,
    command: projectCommandSchema,
  })
  .strict();
const eventEnvelopeSchema = z
  .object({
    linkId: text,
    sourceProjectId: ProjectIdSchema,
    targetProjectId: ProjectIdSchema,
    hostId: text,
    sequence: revision,
    authorityRevision: revision,
    budgetRevision: revision,
    principal: sessionSchema,
    event: projectEventSchema,
  })
  .strict();
type Link = z.infer<typeof linkRow>;
const proposalInputSchema = z
  .object({
    linkId: text.optional(),
    grant: projectGrantSchema,
    budgetAttempts: z.number().int().positive(),
    expectedBudgetRevision: revision,
    principal: projectPrincipalSchema.optional(),
    idempotencyKey: text,
  })
  .strict();

/** All cross-database mutations dispatch through this local child's own methods. */
export class ProjectHierarchy {
  constructor(
    readonly store: Store,
    readonly actor: SessionIdentity,
  ) {
    this.actor = { id: actor.id, generation: actor.generation };
  }
  private authorize(userOnly = false) {
    this.authorizeSession(this.actor, userOnly ? ['user'] : ['user', 'controller']);
  }
  private authorizeSession(identity: SessionIdentity, roles: readonly string[]) {
    const actor = this.store.read((db) =>
      z
        .object({ role: text, state: text })
        .parse(
          db
            .prepare(
              'SELECT role,state FROM agent_sessions WHERE project_id=? AND id=? AND generation=?',
            )
            .get(this.store.project.id, identity.id, identity.generation),
        ),
    );
    if (actor.state !== 'active' || !roles.includes(actor.role))
      throw new Error('Project hierarchy authority requires an active local principal');
  }
  private authorizePrincipal(principal: ProjectPrincipal) {
    if (principal.kind === 'user-session') {
      if (canonicalJson(principal.session) !== canonicalJson(this.actor))
        throw new Error('User project principal does not match the calling session');
      return this.authorizeSession(principal.session, ['user']);
    }
    if (principal.projectId !== this.store.project.id)
      throw new Error('Controller principal belongs to another project');
    const active = this.store.read((db) =>
      db
        .prepare(
          `SELECT 1 FROM controller_definitions c JOIN controller_incarnations i
           ON i.controller_id=c.id AND i.generation=c.current_generation
           WHERE c.project_id=? AND c.id=? AND c.state IN ('idle','working') AND i.state='active'
           AND i.session_id=? AND i.session_generation=?`,
        )
        .get(this.store.project.id, principal.controllerId, this.actor.id, this.actor.generation),
    );
    if (!active)
      throw new Error('Calling session is not the active logical controller incarnation');
  }
  private validateGrantPrincipal(principal: ProjectPrincipal) {
    if (principal.kind === 'user-session') {
      if (canonicalJson(principal.session) !== canonicalJson(this.actor))
        throw new Error('A user may only grant its own project principal');
      return this.authorizeSession(principal.session, ['user']);
    }
    if (principal.projectId !== this.store.project.id)
      throw new Error('Controller principal belongs to another project');
    const active = this.store.read((db) =>
      db
        .prepare(
          `SELECT 1 FROM controller_definitions c JOIN controller_incarnations i
           ON i.controller_id=c.id AND i.generation=c.current_generation
           WHERE c.project_id=? AND c.id=? AND c.state IN ('idle','working') AND i.state='active'`,
        )
        .get(this.store.project.id, principal.controllerId),
    );
    if (!active) throw new Error('Logical controller principal has no active incarnation');
  }
  private link(id: string) {
    return this.store.read((db) =>
      linkRow.parse(db.prepare('SELECT * FROM project_links WHERE id=?').get(id)),
    );
  }
  list() {
    this.authorize();
    return this.store.read((db) =>
      db
        .prepare(
          'SELECT id,side,parent_project_id,child_project_id,host_id,root_project_id,state,authority_revision,budget_revision,budget_attempts FROM project_links ORDER BY id',
        )
        .all(),
    );
  }
  configureBudget(input: { capacity: number; expectedRevision: number; idempotencyKey: string }) {
    z.number().int().nonnegative().parse(input.capacity);
    return this.store.idempotent(
      'project.budget',
      input.idempotencyKey,
      input,
      z.object({ revision }),
      (db) => {
        this.authorize(true);
        if (db.prepare("SELECT id FROM project_links WHERE side='child'").get())
          throw new Error('Child capacity is owned by its parent allocation');
        const old = db.prepare('SELECT * FROM project_hierarchy_budget WHERE singleton=1').get();
        if ((old?.revision ?? 0) !== input.expectedRevision)
          throw new Error('Project budget revision stale');
        db.prepare(
          'INSERT INTO project_hierarchy_budget(singleton,revision,capacity) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,capacity=excluded.capacity',
        ).run(input.expectedRevision + 1, input.capacity);
        return { revision: input.expectedRevision + 1 };
      },
    ).value;
  }
  private sameHost(child: ProjectHierarchy) {
    if (this.store.project.hostId !== child.store.project.hostId)
      throw new Error('Cross-host project hierarchy is unsupported');
    if (
      this.store.project.id === child.store.project.id ||
      this.store.databasePath === child.store.databasePath
    )
      throw new Error('Projects require distinct identities and databases');
  }
  proposeLink(child: ProjectHierarchy, input: z.infer<typeof proposalInputSchema>) {
    this.sameHost(child);
    const parsed = proposalInputSchema.parse(input);
    child.authorize(true);
    return this.store.idempotent(
      'project.link-propose',
      input.idempotencyKey,
      { ...parsed, childProjectId: child.store.project.id, childActor: child.actor },
      z.object({ linkId: text }),
      (db) => {
        this.authorize(true);
        const parent = db.prepare("SELECT * FROM project_links WHERE side='child'").get();
        const inbound = parent ? linkRow.parse(parent) : null;
        if (inbound && inbound.state !== 'active') throw new Error('Parent ancestry is inactive');
        const ancestry = inbound
          ? z.array(ProjectIdSchema).parse(JSON.parse(inbound.ancestry_json))
          : [];
        ancestry.push(this.store.project.id);
        if (ancestry.includes(child.store.project.id))
          throw new Error('Project hierarchy cycle rejected');
        // Immutable single-parent leaf attachment keeps every persisted ancestry verifiable.
        if (child.store.read((cdb) => cdb.prepare('SELECT id FROM project_links LIMIT 1').get()))
          throw new Error(
            'Child must be an unattached leaf; reparenting portfolios is unsupported',
          );
        const budget = z
          .object({
            revision,
            capacity: z.number(),
            allocated: z.number(),
            reserved: z.number(),
            consumed: z.number(),
          })
          .parse(db.prepare('SELECT * FROM project_hierarchy_budget WHERE singleton=1').get());
        if (budget.revision !== input.expectedBudgetRevision)
          throw new Error('Project budget revision stale');
        const id = input.linkId ?? randomUUID();
        const principal =
          parsed.principal ?? ({ kind: 'user-session', session: this.actor } as const);
        this.validateGrantPrincipal(principal);
        db.prepare(
          'UPDATE project_hierarchy_budget SET allocated=allocated+?,revision=revision+1 WHERE singleton=1',
        ).run(input.budgetAttempts);
        const grant = projectGrantSchema.parse(input.grant);
        if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Grant has expired');
        db.prepare(
          `INSERT INTO project_links(id,side,parent_project_id,child_project_id,host_id,root_project_id,ancestry_json,principal_json,child_actor_json,secret,state,authority_revision,budget_revision,budget_attempts,grant_json) VALUES (?,'parent',?,?,?,?,?,?,?,?,'proposed',1,1,?,?)`,
        ).run(
          id,
          this.store.project.id,
          child.store.project.id,
          this.store.project.hostId,
          ancestry[0]!,
          canonicalJson(ancestry),
          canonicalJson(principal),
          canonicalJson(child.actor),
          randomBytes(32).toString('hex'),
          input.budgetAttempts,
          canonicalJson(grant),
        );
        db.prepare('INSERT INTO project_link_grants VALUES (?,?,?,?,?)').run(
          id,
          1,
          canonicalJson(principal),
          canonicalJson(grant),
          new Date().toISOString(),
        );
        db.prepare(
          "INSERT INTO project_link_allocations(link_id,revision,attempts,state,created_at) VALUES (?,?,?,'active',?)",
        ).run(id, 1, input.budgetAttempts, new Date().toISOString());
        return { linkId: id };
      },
    ).value;
  }
  activateLink(
    child: ProjectHierarchy,
    input: { linkId: string; expectedAuthorityRevision: number; idempotencyKey: string },
  ) {
    this.sameHost(child);
    return this.store.idempotent(
      'project.link-activate',
      input.idempotencyKey,
      input,
      z.object({ linkId: text, state: z.literal('active') }),
      (db) => {
        this.authorize(true);
        const link = this.link(input.linkId);
        if (
          link.side !== 'parent' ||
          link.child_project_id !== child.store.project.id ||
          link.authority_revision !== input.expectedAuthorityRevision ||
          !['proposed', 'active'].includes(link.state)
        )
          throw new Error('Link activation identity, state or revision mismatch');
        child.acceptLink(link);
        db.prepare("UPDATE project_links SET state='active' WHERE id=?").run(link.id);
        return { linkId: link.id, state: 'active' as const };
      },
    ).value;
  }
  private acceptLink(link: Link) {
    this.store.transaction((db) => {
      this.authorize(true);
      if (
        link.host_id !== this.store.project.hostId ||
        link.child_project_id !== this.store.project.id ||
        canonicalJson(this.actor) !== link.child_actor_json
      )
        throw new Error('Child activation principal mismatch');
      const old = db.prepare('SELECT * FROM project_links WHERE id=?').get(link.id);
      if (old) {
        const prior = linkRow.parse(old);
        if (prior.secret !== link.secret || prior.parent_project_id !== link.parent_project_id)
          throw new Error('Conflicting link activation');
        return;
      }
      if (db.prepare('SELECT id FROM project_links LIMIT 1').get())
        throw new Error('Child is already linked');
      const ancestry = z.array(ProjectIdSchema).parse(JSON.parse(link.ancestry_json));
      if (
        ancestry.includes(this.store.project.id) ||
        new Set(ancestry).size !== ancestry.length ||
        ancestry.at(-1) !== link.parent_project_id
      )
        throw new Error('Invalid cyclic ancestry');
      if (
        db
          .prepare(
            'SELECT 1 FROM project_hierarchy_budget WHERE allocated>0 OR reserved>0 OR consumed>0',
          )
          .get()
      )
        throw new Error('Child has existing hierarchy budget obligations');
      db.prepare('INSERT INTO project_links SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?').run(
        link.id,
        'child',
        link.parent_project_id,
        link.child_project_id,
        link.host_id,
        link.root_project_id,
        link.ancestry_json,
        link.principal_json,
        link.child_actor_json,
        link.secret,
        'active',
        link.authority_revision,
        link.budget_revision,
        link.budget_attempts,
        link.grant_json,
        1,
        0,
      );
      db.prepare(
        'INSERT INTO project_hierarchy_budget(singleton,revision,capacity) VALUES (1,1,?) ON CONFLICT(singleton) DO UPDATE SET capacity=excluded.capacity,revision=revision+1',
      ).run(link.budget_attempts);
      db.prepare('INSERT INTO project_link_grants VALUES (?,?,?,?,?)').run(
        link.id,
        link.authority_revision,
        link.principal_json,
        link.grant_json,
        new Date().toISOString(),
      );
      db.prepare(
        "INSERT INTO project_link_allocations(link_id,revision,attempts,state,created_at) VALUES (?,?,?,'active',?)",
      ).run(link.id, link.budget_revision, link.budget_attempts, new Date().toISOString());
    });
  }
  updateGrant(
    child: ProjectHierarchy,
    input: {
      linkId: string;
      expectedAuthorityRevision: number;
      grant: z.infer<typeof projectGrantSchema>;
      principal?: ProjectPrincipal;
      idempotencyKey: string;
    },
  ) {
    this.sameHost(child);
    const grant = projectGrantSchema.parse(input.grant);
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Grant has expired');
    return this.store.idempotent(
      'project.authority-grant',
      input.idempotencyKey,
      { ...input, grant },
      z.object({ revision, state: z.literal('active') }),
      (db) => {
        this.authorize(true);
        const link = this.link(input.linkId);
        if (
          link.side !== 'parent' ||
          link.child_project_id !== child.store.project.id ||
          link.state !== 'active' ||
          link.authority_revision !== input.expectedAuthorityRevision
        )
          throw new Error('Authority grant revision stale or link inactive');
        const principal =
          input.principal ?? projectPrincipalSchema.parse(JSON.parse(link.principal_json));
        if (input.principal) this.validateGrantPrincipal(principal);
        const next = link.authority_revision + 1;
        child.acceptGrant(link, grant, principal, next);
        const encoded = canonicalJson(grant);
        db.prepare(
          'UPDATE project_links SET authority_revision=?,grant_json=?,principal_json=? WHERE id=?',
        ).run(next, encoded, canonicalJson(principal), link.id);
        db.prepare('INSERT INTO project_link_grants VALUES (?,?,?,?,?)').run(
          link.id,
          next,
          canonicalJson(principal),
          encoded,
          new Date().toISOString(),
        );
        return { revision: next, state: 'active' as const };
      },
    ).value;
  }
  private acceptGrant(
    parent: Link,
    grant: z.infer<typeof projectGrantSchema>,
    principal: ProjectPrincipal,
    next: number,
  ) {
    return this.store.transaction((db) => {
      this.authorize(true);
      const link = this.link(parent.id);
      const encoded = canonicalJson(grant);
      if (
        link.side !== 'child' ||
        link.secret !== parent.secret ||
        link.parent_project_id !== parent.parent_project_id
      )
        throw new Error('Child authority grant authentication mismatch');
      if (
        link.authority_revision === next &&
        link.grant_json === encoded &&
        link.principal_json === canonicalJson(principal)
      )
        return;
      if (link.authority_revision !== parent.authority_revision || link.state !== 'active')
        throw new Error('Child authority grant authentication or revision mismatch');
      db.prepare(
        'UPDATE project_links SET authority_revision=?,grant_json=?,principal_json=? WHERE id=?',
      ).run(next, encoded, canonicalJson(principal), link.id);
      db.prepare('INSERT INTO project_link_grants VALUES (?,?,?,?,?)').run(
        link.id,
        next,
        canonicalJson(principal),
        encoded,
        new Date().toISOString(),
      );
    });
  }
  allocateBudget(
    child: ProjectHierarchy,
    input: {
      linkId: string;
      expectedBudgetRevision: number;
      expectedProjectBudgetRevision: number;
      budgetAttempts: number;
      idempotencyKey: string;
    },
  ) {
    this.sameHost(child);
    z.number().int().nonnegative().parse(input.budgetAttempts);
    return this.store.idempotent(
      'project.budget-allocate',
      input.idempotencyKey,
      input,
      z.object({ revision, budgetAttempts: z.number().int().nonnegative() }),
      (db) => {
        this.authorize(true);
        const link = this.link(input.linkId);
        if (
          link.side !== 'parent' ||
          link.child_project_id !== child.store.project.id ||
          link.state !== 'active' ||
          link.budget_revision !== input.expectedBudgetRevision
        )
          throw new Error('Budget allocation revision stale or link inactive');
        const parentBudget = z
          .object({
            capacity: z.number(),
            allocated: z.number(),
            reserved: z.number(),
            consumed: z.number(),
            revision,
          })
          .parse(
            db
              .prepare(
                'SELECT revision,capacity,allocated,reserved,consumed FROM project_hierarchy_budget WHERE singleton=1',
              )
              .get(),
          );
        const delta = input.budgetAttempts - link.budget_attempts;
        if (parentBudget.revision !== input.expectedProjectBudgetRevision)
          throw new Error('Parent project budget revision stale');
        if (
          parentBudget.allocated + parentBudget.reserved + parentBudget.consumed + delta >
            parentBudget.capacity ||
          parentBudget.allocated + delta < 0
        )
          throw new Error('Parent project budget cannot satisfy allocation');
        const next = link.budget_revision + 1;
        child.acceptAllocation(link, input.budgetAttempts, next);
        db.prepare(
          'UPDATE project_hierarchy_budget SET allocated=allocated+?,revision=revision+1 WHERE singleton=1',
        ).run(delta);
        db.prepare('UPDATE project_links SET budget_revision=?,budget_attempts=? WHERE id=?').run(
          next,
          input.budgetAttempts,
          link.id,
        );
        db.prepare(
          "INSERT INTO project_link_allocations(link_id,revision,attempts,state,created_at) VALUES (?,?,?,'active',?)",
        ).run(link.id, next, input.budgetAttempts, new Date().toISOString());
        return { revision: next, budgetAttempts: input.budgetAttempts };
      },
    ).value;
  }
  private acceptAllocation(parent: Link, attempts: number, next: number) {
    return this.store.transaction((db) => {
      this.authorize(true);
      const link = this.link(parent.id);
      if (
        link.side !== 'child' ||
        link.secret !== parent.secret ||
        link.parent_project_id !== parent.parent_project_id
      )
        throw new Error('Child allocation authentication mismatch');
      if (link.budget_revision === next && link.budget_attempts === attempts) return;
      if (link.budget_revision !== parent.budget_revision || link.state !== 'active')
        throw new Error('Child allocation authentication or revision mismatch');
      const budget = z
        .object({ allocated: z.number(), reserved: z.number(), consumed: z.number() })
        .parse(
          db
            .prepare(
              'SELECT allocated,reserved,consumed FROM project_hierarchy_budget WHERE singleton=1',
            )
            .get(),
        );
      if (budget.allocated + budget.reserved + budget.consumed > attempts)
        throw new Error('Allocation cannot fall below child obligations');
      db.prepare(
        'UPDATE project_hierarchy_budget SET capacity=?,revision=revision+1 WHERE singleton=1',
      ).run(attempts);
      db.prepare('UPDATE project_links SET budget_revision=?,budget_attempts=? WHERE id=?').run(
        next,
        attempts,
        link.id,
      );
      db.prepare(
        "INSERT INTO project_link_allocations(link_id,revision,attempts,state,created_at) VALUES (?,?,?,'active',?)",
      ).run(link.id, next, attempts, new Date().toISOString());
    });
  }
  enqueue(input: {
    linkId: string;
    expectedAuthorityRevision: number;
    expectedBudgetRevision: number;
    command: ProjectCommand;
    idempotencyKey: string;
  }) {
    const command = projectCommandSchema.parse(input.command);
    return this.store.idempotent(
      'project.command',
      input.idempotencyKey,
      { ...input, command },
      z.object({ sequence: revision }),
      (db) => {
        this.authorize();
        const link = this.link(input.linkId);
        this.requireActive(link, input.expectedAuthorityRevision, input.expectedBudgetRevision);
        const principal = projectPrincipalSchema.parse(JSON.parse(link.principal_json));
        this.authorizePrincipal(principal);
        if (link.side !== 'parent') throw new Error('Command principal is not the granted parent');
        const grant = projectGrantSchema.parse(JSON.parse(link.grant_json));
        if (!grant.verbs.includes(command.kind))
          throw new Error('Command is outside delegated grant');
        const envelope = envelopeSchema.parse({
          linkId: link.id,
          sourceProjectId: link.parent_project_id,
          targetProjectId: link.child_project_id,
          hostId: link.host_id,
          sequence: link.next_sequence,
          authorityRevision: link.authority_revision,
          budgetRevision: link.budget_revision,
          principal,
          command,
        });
        const encoded = canonicalJson(envelope),
          signature = createHmac('sha256', link.secret).update(encoded).digest('hex');
        db.prepare("INSERT INTO project_message_outbox VALUES (?,?,?,?,'pending',NULL)").run(
          link.id,
          link.next_sequence,
          encoded,
          signature,
        );
        db.prepare('UPDATE project_links SET next_sequence=next_sequence+1 WHERE id=?').run(
          link.id,
        );
        return { sequence: link.next_sequence };
      },
    ).value;
  }
  enqueueEvent(input: {
    linkId: string;
    expectedAuthorityRevision: number;
    expectedBudgetRevision: number;
    event: ProjectEventRequest;
    idempotencyKey: string;
  }) {
    const request = projectEventRequestSchema.parse(input.event);
    return this.store.idempotent(
      'project.event',
      input.idempotencyKey,
      { ...input, event: request },
      z.object({ sequence: revision }),
      (db) => {
        this.authorize();
        const link = this.link(input.linkId);
        this.requireCurrent(link, input.expectedAuthorityRevision, input.expectedBudgetRevision);
        if (link.side !== 'child' || canonicalJson(this.actor) !== link.child_actor_json)
          throw new Error('Event principal is not the linked child');
        const event = this.projectEvent(link, request);
        return this.insertEventOutbox(db, link, event);
      },
    ).value;
  }
  private projectEvent(link: Link, request: ProjectEventRequest): ProjectEvent {
    const workflow = this.owned(link, request.workflowId);
    if (request.kind === 'workflow.status') {
      const status = this.store.workflowStatus(workflow.id);
      return projectEventSchema.parse({
        kind: 'workflow.status',
        childProjectId: this.store.project.id,
        childWorkflowId: workflow.id,
        childStateRevision: workflow.revision,
        statusDigest: payloadDigest(status),
        status,
      });
    }
    const report = this.resultProjection(workflow.id, request.resultId);
    return projectEventSchema.parse({ kind: 'result.report', ...report });
  }
  private resultProjection(
    workflowId: z.infer<typeof WorkflowIdSchema>,
    resultId: z.infer<typeof ResultIdSchema>,
  ) {
    const workflow = this.store.getWorkflow(workflowId);
    const result = this.store.getResult(resultId);
    const attempt = this.store.getAttempt(result.attemptId);
    if (attempt.workflowId !== workflow.id)
      throw new Error('Result does not belong to delegated workflow');
    const accepted = this.store.read((db) =>
      db
        .prepare(
          "SELECT id FROM result_acceptances WHERE result_id=? AND decision='accepted' ORDER BY created_at DESC LIMIT 1",
        )
        .get(result.id),
    );
    return {
      childProjectId: this.store.project.id,
      childWorkflowId: workflow.id,
      childResultId: result.id,
      childStateRevision: workflow.revision,
      resultDigest: payloadDigest(result),
      evidenceDigests: result.evidence.map(payloadDigest),
      result,
      accepted: !!accepted,
      integrated: null,
      deployed: null,
      projection: 'reported' as const,
    };
  }
  private insertEventOutbox(
    db: Parameters<Parameters<Store['transaction']>[0]>[0],
    link: Link,
    event: ProjectEvent,
  ) {
    const envelope = eventEnvelopeSchema.parse({
      linkId: link.id,
      sourceProjectId: link.child_project_id,
      targetProjectId: link.parent_project_id,
      hostId: link.host_id,
      sequence: link.next_sequence,
      authorityRevision: link.authority_revision,
      budgetRevision: link.budget_revision,
      principal: this.actor,
      event,
    });
    const encoded = canonicalJson(envelope);
    const signature = createHmac('sha256', link.secret).update(encoded).digest('hex');
    db.prepare("INSERT INTO project_message_outbox VALUES (?,?,?,?,'pending',NULL)").run(
      link.id,
      link.next_sequence,
      encoded,
      signature,
    );
    db.prepare('UPDATE project_links SET next_sequence=next_sequence+1 WHERE id=?').run(link.id);
    return { sequence: link.next_sequence };
  }
  private requireActive(link: Link, authority: number, budget: number) {
    if (
      link.state !== 'active' ||
      link.authority_revision !== authority ||
      link.budget_revision !== budget
    )
      throw new Error('Project link authority or budget is stale or inactive');
    if (Date.parse(projectGrantSchema.parse(JSON.parse(link.grant_json)).expiresAt) <= Date.now())
      throw new Error('Project grant expired');
  }
  private requireCurrent(link: Link, authority: number, budget: number) {
    if (link.authority_revision !== authority || link.budget_revision !== budget)
      throw new Error('Project link authority or budget is stale');
  }
  /** Parent write lock spans child commit. Retrying after child commit only reads the durable receipt. */
  relay(child: ProjectHierarchy, linkId: string) {
    this.sameHost(child);
    return this.store.transaction((db) => {
      this.authorize();
      const link = this.link(linkId);
      if (link.side !== 'parent' || link.child_project_id !== child.store.project.id)
        throw new Error('Relay child mismatch');
      const rows = db
        .prepare(
          "SELECT * FROM project_message_outbox WHERE link_id=? AND state='pending' ORDER BY sequence",
        )
        .all(linkId);
      const receipts = [];
      for (const raw of rows) {
        const row = z
          .object({ sequence: revision, envelope_json: text, signature: text })
          .parse(raw);
        const envelope = envelopeSchema.parse(JSON.parse(row.envelope_json));
        let allowed = true;
        try {
          this.requireActive(link, envelope.authorityRevision, envelope.budgetRevision);
        } catch {
          allowed = false;
        }
        const receipt = child.receive(link, row.envelope_json, row.signature, allowed);
        db.prepare(
          "UPDATE project_message_outbox SET state='acknowledged',receipt_json=? WHERE link_id=? AND sequence=?",
        ).run(canonicalJson(receipt), link.id, row.sequence);
        receipts.push(receipt);
      }
      return receipts;
    });
  }
  private receive(parent: Link, encoded: string, signature: string, allowed: boolean) {
    return this.store.transaction((db) => {
      const link = this.link(parent.id);
      const envelope = envelopeSchema.parse(JSON.parse(encoded));
      const expected = createHmac('sha256', link.secret).update(encoded).digest();
      const actual = Buffer.from(signature, 'hex');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        link.side !== 'child' ||
        envelope.sourceProjectId !== link.parent_project_id ||
        envelope.targetProjectId !== this.store.project.id ||
        envelope.hostId !== this.store.project.hostId ||
        canonicalJson(envelope.principal) !== link.principal_json
      )
        throw new Error('Unauthenticated cross-project message');
      const previous = db
        .prepare('SELECT * FROM project_message_inbox WHERE link_id=? AND sequence=?')
        .get(link.id, envelope.sequence);
      if (previous) {
        const row = z.object({ digest: text, receipt_json: text }).parse(previous);
        if (row.digest !== payloadDigest(envelope)) throw new Error('Conflicting replay');
        return receiptSchema.parse(JSON.parse(row.receipt_json));
      }
      if (envelope.sequence !== link.received_sequence + 1)
        throw new Error('Cross-project message sequence gap');
      let receipt: z.infer<typeof receiptSchema>;
      try {
        receipt = this.store.transaction(() => {
          if (!allowed) throw new Error('Parent authority changed before child admission');
          this.requireActive(link, envelope.authorityRevision, envelope.budgetRevision);
          this.authorize();
          if (canonicalJson(this.actor) !== link.child_actor_json)
            throw new Error('Child command receiver identity mismatch');
          const grant = projectGrantSchema.parse(JSON.parse(link.grant_json));
          if (!grant.verbs.includes(envelope.command.kind))
            throw new Error('Command is outside delegated grant');
          return {
            kind: 'applied' as const,
            value: this.dispatch(link, envelope.command, `relay/${link.id}/${envelope.sequence}`),
          };
        });
      } catch (error) {
        receipt = {
          kind: 'rejected',
          value: null,
          reason: error instanceof Error ? error.message : 'Child command rejected',
        };
      }
      db.prepare('INSERT INTO project_message_inbox VALUES (?,?,?,?)').run(
        link.id,
        envelope.sequence,
        payloadDigest(envelope),
        canonicalJson(receipt),
      );
      db.prepare('UPDATE project_links SET received_sequence=? WHERE id=?').run(
        envelope.sequence,
        link.id,
      );
      return receipt;
    });
  }
  /** Child-to-parent delivery is independently sequenced and deduplicated in the parent database. */
  relayEvents(parent: ProjectHierarchy, linkId: string) {
    parent.sameHost(this);
    return this.store.transaction((db) => {
      this.authorize();
      const link = this.link(linkId);
      if (
        link.side !== 'child' ||
        link.parent_project_id !== parent.store.project.id ||
        canonicalJson(this.actor) !== link.child_actor_json
      )
        throw new Error('Event relay parent or child principal mismatch');
      const rows = db
        .prepare(
          "SELECT sequence,envelope_json,signature FROM project_message_outbox WHERE link_id=? AND state='pending' ORDER BY sequence",
        )
        .all(linkId);
      const receipts = [];
      for (const raw of rows) {
        const row = z
          .object({ sequence: revision, envelope_json: text, signature: text })
          .parse(raw);
        const receipt = parent.receiveEvent(link, row.envelope_json, row.signature);
        db.prepare(
          "UPDATE project_message_outbox SET state='acknowledged',receipt_json=? WHERE link_id=? AND sequence=?",
        ).run(canonicalJson(receipt), link.id, row.sequence);
        receipts.push(receipt);
      }
      return receipts;
    });
  }
  private receiveEvent(child: Link, encoded: string, signature: string) {
    return this.store.transaction((db) => {
      this.authorize();
      const link = this.link(child.id);
      const envelope = eventEnvelopeSchema.parse(JSON.parse(encoded));
      const expected = createHmac('sha256', link.secret).update(encoded).digest();
      const actual = Buffer.from(signature, 'hex');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        link.side !== 'parent' ||
        envelope.sourceProjectId !== link.child_project_id ||
        envelope.targetProjectId !== this.store.project.id ||
        envelope.hostId !== this.store.project.hostId ||
        canonicalJson(envelope.principal) !== link.child_actor_json
      )
        throw new Error('Unauthenticated child project event');
      const prior = db
        .prepare(
          'SELECT digest,receipt_json FROM project_message_inbox WHERE link_id=? AND sequence=?',
        )
        .get(link.id, envelope.sequence);
      if (prior) {
        const row = z.object({ digest: text, receipt_json: text }).parse(prior);
        if (row.digest !== payloadDigest(envelope))
          throw new Error('Conflicting child event replay');
        return receiptSchema.parse(JSON.parse(row.receipt_json));
      }
      if (envelope.sequence !== link.received_sequence + 1)
        throw new Error('Child project event sequence gap');
      let receipt: z.infer<typeof receiptSchema>;
      if (
        envelope.authorityRevision !== link.authority_revision ||
        envelope.budgetRevision !== link.budget_revision
      ) {
        receipt = { kind: 'rejected', value: null, reason: 'Child event revision is stale' };
      } else {
        if (
          envelope.event.kind === 'workflow.status' &&
          payloadDigest(envelope.event.status) !== envelope.event.statusDigest
        )
          throw new Error('Child workflow status digest mismatch');
        if (envelope.event.kind === 'result.report') {
          const result = z
            .object({ id: ResultIdSchema, evidence: z.array(z.unknown()) })
            .passthrough()
            .parse(envelope.event.result);
          if (
            result.id !== envelope.event.childResultId ||
            payloadDigest(result) !== envelope.event.resultDigest ||
            canonicalJson(result.evidence.map(payloadDigest)) !==
              canonicalJson(envelope.event.evidenceDigests)
          )
            throw new Error('Child result or evidence digest mismatch');
        }
        db.prepare(
          'INSERT INTO project_child_rollups(link_id,source_sequence,event_kind,projection_json,received_at) VALUES (?,?,?,?,?)',
        ).run(
          link.id,
          envelope.sequence,
          envelope.event.kind,
          canonicalJson(envelope.event),
          new Date().toISOString(),
        );
        receipt = { kind: 'applied', value: { sequence: envelope.sequence } };
      }
      db.prepare('INSERT INTO project_message_inbox VALUES (?,?,?,?)').run(
        link.id,
        envelope.sequence,
        payloadDigest(envelope),
        canonicalJson(receipt),
      );
      db.prepare('UPDATE project_links SET received_sequence=? WHERE id=?').run(
        envelope.sequence,
        link.id,
      );
      return receipt;
    });
  }
  private owned(link: Link, workflowId: z.infer<typeof WorkflowIdSchema>) {
    const owner = this.workflowOwner(workflowId);
    if (owner?.link_id !== link.id) throw new Error('Workflow is outside this delegated link');
    return this.store.getWorkflow(workflowId);
  }
  private workflowOwner(workflowId: z.infer<typeof WorkflowIdSchema>) {
    return this.store.read((db) =>
      db
        .prepare(
          `WITH RECURSIVE ancestors(id,parent_workflow_id,depth) AS (
             SELECT id,parent_workflow_id,0 FROM workflow_runs WHERE id=? AND project_id=?
             UNION ALL
             SELECT w.id,w.parent_workflow_id,a.depth+1 FROM workflow_runs w
             JOIN ancestors a ON a.parent_workflow_id=w.id WHERE w.project_id=?
           )
           SELECT o.*,a.id AS owned_workflow_id FROM ancestors a
           JOIN project_workflow_owners o ON o.workflow_id=a.id ORDER BY a.depth LIMIT 1`,
        )
        .get(workflowId, this.store.project.id, this.store.project.id),
    );
  }
  private dispatch(link: Link, command: ProjectCommand, key: string) {
    if (command.kind === 'workflow.create') {
      const grant = projectGrantSchema.parse(JSON.parse(link.grant_json));
      if (!grant.workspaceIds.includes(command.workspaceId))
        throw new Error('Workspace is outside delegated grant');
      this.store.transaction((db) =>
        db
          .prepare(
            'UPDATE project_hierarchy_budget SET reserved=reserved+?,revision=revision+1 WHERE singleton=1',
          )
          .run(command.package.limits.maxAttempts),
      );
      const { kind: _, ...input } = command;
      const workflow = this.store.createWorkflow({
        ...input,
        actor: this.actor,
        idempotencyKey: key,
      });
      this.store.transaction((db) =>
        db
          .prepare(
            'INSERT INTO project_workflow_owners(workflow_id,link_id,reserved_attempts,authority_revision,budget_revision) VALUES (?,?,?,?,?)',
          )
          .run(
            workflow.id,
            link.id,
            command.package.limits.maxAttempts,
            link.authority_revision,
            link.budget_revision,
          ),
      );
      return {
        workflowId: workflow.id,
        revision: workflow.revision,
        status: 'created',
        activated: false,
      };
    }
    const workflow = this.owned(link, command.workflowId);
    if (command.kind === 'workflow.control') {
      return this.store.controlWorkflow({
        actor: this.actor,
        workflowId: workflow.id,
        expectedWorkflowRevision: command.expectedWorkflowRevision,
        expectedControlRevision: command.expectedControlRevision,
        operation: command.operation,
        idempotencyKey: key,
      });
    }
    if (command.kind === 'workflow.activate')
      return this.store.activateWorkflow({
        actor: this.actor,
        workflowId: workflow.id,
        expectedWorkflowRevision: command.expectedWorkflowRevision,
        expectedBriefRevision: command.expectedBriefRevision,
        expectedControlRevision: command.expectedControlRevision,
        idempotencyKey: key,
      });
    if (command.kind === 'workflow.status') return this.store.workflowStatus(workflow.id);
    return this.resultProjection(workflow.id, command.resultId);
  }
  rollups(linkId: string) {
    this.authorize();
    return this.store.read((db) =>
      db
        .prepare(
          'SELECT source_sequence AS sequence,event_kind,projection_json FROM project_child_rollups WHERE link_id=? ORDER BY source_sequence',
        )
        .all(linkId)
        .map((row) => ({
          sequence: row.sequence,
          projection: JSON.parse(z.string().parse(row.projection_json)),
        })),
    );
  }
  settleWorkflowAllocation(input: {
    workflowId: z.infer<typeof WorkflowIdSchema>;
    expectedBudgetRevision: number;
    idempotencyKey: string;
  }) {
    return this.store.idempotent(
      'project.workflow-allocation-settle',
      input.idempotencyKey,
      input,
      z.object({
        releasedAttempts: z.number().int().nonnegative(),
        consumedAttempts: z.number().int().nonnegative(),
        projectBudgetRevision: revision,
        sequence: revision,
      }),
      (db) => {
        this.authorize();
        const owner = z
          .object({
            link_id: text,
            owned_workflow_id: WorkflowIdSchema,
            reserved_attempts: z.number().int().positive(),
            consumed_attempts: z.number().int().nonnegative(),
            allocation_state: z.enum(['reserved', 'settled']),
          })
          .parse(this.workflowOwner(input.workflowId));
        const link = this.link(owner.link_id);
        this.requireCurrent(link, link.authority_revision, input.expectedBudgetRevision);
        if (link.side !== 'child' || canonicalJson(this.actor) !== link.child_actor_json)
          throw new Error('Workflow allocation settlement requires the linked child principal');
        if (owner.allocation_state !== 'reserved')
          throw new Error('Workflow allocation is already settled');
        const unsettled = db
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM workflow_runs WHERE id=? AND project_id=?
               UNION ALL SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id=d.id
               WHERE w.project_id=?
             )
             SELECT
               (SELECT count(*) FROM workflow_runs w JOIN descendants d ON d.id=w.id
                WHERE w.phase NOT IN ('finished','cancelled')) AS workflows,
               (SELECT count(*) FROM attempts a JOIN descendants d ON d.id=a.workflow_id
                WHERE a.phase NOT IN ('settled','closed')) AS attempts,
               (SELECT count(*) FROM execution_reservations r JOIN attempts a ON a.id=r.attempt_id
                JOIN descendants d ON d.id=a.workflow_id WHERE r.state<>'released') AS reservations,
               (SELECT count(*) FROM native_attempts n JOIN attempts a ON a.id=n.attempt_id
                JOIN descendants d ON d.id=a.workflow_id WHERE n.phase<>'settled') AS native_attempts,
               (SELECT count(*) FROM attempt_control_intents c JOIN attempts a ON a.id=c.attempt_id
                JOIN descendants d ON d.id=a.workflow_id WHERE c.state<>'confirmed') AS controls`,
          )
          .get(owner.owned_workflow_id, this.store.project.id, this.store.project.id);
        const pending = z
          .object({
            workflows: z.number().int(),
            attempts: z.number().int(),
            reservations: z.number().int(),
            native_attempts: z.number().int(),
            controls: z.number().int(),
          })
          .parse(unsettled);
        if (Object.values(pending).some((count) => count !== 0))
          throw new Error('Workflow allocation cannot settle before every effect is confirmed');
        const released = owner.reserved_attempts - owner.consumed_attempts;
        db.prepare(
          "UPDATE project_workflow_owners SET allocation_state='settled',settled_at=? WHERE workflow_id=?",
        ).run(new Date().toISOString(), owner.owned_workflow_id);
        db.prepare(
          'UPDATE project_hierarchy_budget SET reserved=reserved-?,revision=revision+1 WHERE singleton=1',
        ).run(released);
        const budget = z
          .object({ revision })
          .parse(
            db.prepare('SELECT revision FROM project_hierarchy_budget WHERE singleton=1').get(),
          );
        const workflow = this.store.getWorkflow(owner.owned_workflow_id);
        const event = projectEventSchema.parse({
          kind: 'allocation.settled',
          childProjectId: this.store.project.id,
          childWorkflowId: workflow.id,
          childStateRevision: workflow.revision,
          reservedAttempts: owner.reserved_attempts,
          budgetRevision: budget.revision,
        });
        const outbox = this.insertEventOutbox(db, link, event);
        return {
          releasedAttempts: released,
          consumedAttempts: owner.consumed_attempts,
          projectBudgetRevision: budget.revision,
          sequence: outbox.sequence,
        };
      },
    ).value;
  }
  settleLinkAllocation(
    child: ProjectHierarchy,
    input: {
      linkId: string;
      expectedAuthorityRevision: number;
      expectedBudgetRevision: number;
      expectedProjectBudgetRevision: number;
      idempotencyKey: string;
    },
  ) {
    this.sameHost(child);
    return this.store.idempotent(
      'project.link-allocation-settle',
      input.idempotencyKey,
      input,
      z.object({
        revision,
        releasedAttempts: z.number().int().nonnegative(),
        consumedAttempts: z.number().int().nonnegative(),
      }),
      (db) => {
        this.authorize(true);
        const link = this.link(input.linkId);
        if (
          link.side !== 'parent' ||
          link.child_project_id !== child.store.project.id ||
          link.state !== 'revoked' ||
          link.authority_revision !== input.expectedAuthorityRevision ||
          link.budget_revision !== input.expectedBudgetRevision
        )
          throw new Error('Link allocation settlement revision stale or link not revoked');
        const projectBudget = z
          .object({ revision })
          .parse(
            db.prepare('SELECT revision FROM project_hierarchy_budget WHERE singleton=1').get(),
          );
        if (projectBudget.revision !== input.expectedProjectBudgetRevision)
          throw new Error('Parent project budget revision stale');
        const next = link.budget_revision + 1;
        const consumed = child.acceptLinkSettlement(link, next);
        db.prepare(
          'UPDATE project_hierarchy_budget SET allocated=allocated-?,consumed=consumed+?,revision=revision+1 WHERE singleton=1',
        ).run(link.budget_attempts, consumed);
        db.prepare('UPDATE project_links SET budget_revision=?,budget_attempts=0 WHERE id=?').run(
          next,
          link.id,
        );
        db.prepare(
          "INSERT INTO project_link_allocations(link_id,revision,attempts,consumed_attempts,state,created_at,settled_at) VALUES (?,?,?,?, 'settled',?,?)",
        ).run(
          link.id,
          next,
          link.budget_attempts,
          consumed,
          new Date().toISOString(),
          new Date().toISOString(),
        );
        return {
          revision: next,
          releasedAttempts: link.budget_attempts - consumed,
          consumedAttempts: consumed,
        };
      },
    ).value;
  }
  private acceptLinkSettlement(parent: Link, next: number) {
    return this.store.transaction((db) => {
      this.authorize(true);
      const link = this.link(parent.id);
      if (
        link.side !== 'child' ||
        link.secret !== parent.secret ||
        link.parent_project_id !== parent.parent_project_id
      )
        throw new Error('Child allocation settlement authentication mismatch');
      if (link.budget_revision === next && link.budget_attempts === 0) {
        const prior = z
          .object({ consumed_attempts: z.number().int().nonnegative() })
          .parse(
            db
              .prepare(
                "SELECT consumed_attempts FROM project_link_allocations WHERE link_id=? AND revision=? AND state='settled'",
              )
              .get(link.id, next),
          );
        return prior.consumed_attempts;
      }
      if (
        link.state !== 'revoked' ||
        link.authority_revision !== parent.authority_revision ||
        link.budget_revision !== parent.budget_revision
      )
        throw new Error('Child allocation settlement authentication or revision mismatch');
      const budget = z
        .object({ allocated: z.number(), reserved: z.number(), consumed: z.number() })
        .parse(
          db
            .prepare(
              'SELECT allocated,reserved,consumed FROM project_hierarchy_budget WHERE singleton=1',
            )
            .get(),
        );
      const pending = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          db
            .prepare(
              "SELECT count(*) AS count FROM project_workflow_owners WHERE allocation_state<>'settled'",
            )
            .get(),
        ).count;
      if (budget.allocated !== 0 || budget.reserved !== 0 || pending !== 0)
        throw new Error('Child allocation has unsettled obligations');
      if (budget.consumed > link.budget_attempts)
        throw new Error('Child consumption exceeds its allocation');
      db.prepare(
        'UPDATE project_hierarchy_budget SET capacity=0,consumed=0,revision=revision+1 WHERE singleton=1',
      ).run();
      db.prepare('UPDATE project_links SET budget_revision=?,budget_attempts=0 WHERE id=?').run(
        next,
        link.id,
      );
      db.prepare(
        "INSERT INTO project_link_allocations(link_id,revision,attempts,consumed_attempts,state,created_at,settled_at) VALUES (?,?,?,?, 'settled',?,?)",
      ).run(
        link.id,
        next,
        link.budget_attempts,
        budget.consumed,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      return budget.consumed;
    });
  }
  /** A root-to-leaf lock chain is required for every delegated admission/native claim. */
  withWorkflowAuthority<T>(
    workflowId: z.infer<typeof WorkflowIdSchema>,
    ancestors: readonly ProjectHierarchy[],
    fn: () => T,
  ): T {
    const owner = this.workflowOwner(workflowId);
    if (!owner) return fn();
    const link = this.link(z.string().parse(owner.link_id));
    const parent = ancestors.at(-1);
    if (!parent || parent.store.project.id !== link.parent_project_id)
      throw new Error('Exact parent project service is required for delegated admission');
    const debits: Array<{ attemptId: string; workflowId: string }> = [];
    const lock = (index: number): T => {
      if (index === ancestors.length)
        return this.store.transaction((db) => {
          this.authorize();
          const current = this.link(link.id);
          const authoritative = parent.link(link.id);
          this.requireActive(
            current,
            authoritative.authority_revision,
            authoritative.budget_revision,
          );
          parent.requireActive(authoritative, current.authority_revision, current.budget_revision);
          db.prepare('INSERT INTO project_authority_scopes VALUES (?,?,?)').run(
            link.id,
            current.authority_revision,
            current.budget_revision,
          );
          try {
            const result = fn();
            if (result instanceof Promise)
              throw new Error('Hierarchy authority scopes must be synchronous');
            const rows = db
              .prepare(
                `WITH RECURSIVE descendants(id) AS (
                   SELECT id FROM workflow_runs WHERE id=? AND project_id=?
                   UNION ALL SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id=d.id
                   WHERE w.project_id=?
                 )
                 SELECT a.id AS attempt_id,a.workflow_id FROM attempts a JOIN descendants d ON d.id=a.workflow_id
                 LEFT JOIN project_attempt_debits p ON p.attempt_id=a.id WHERE p.attempt_id IS NULL`,
              )
              .all(workflowId, this.store.project.id, this.store.project.id)
              .map((row) => z.object({ attempt_id: text, workflow_id: text }).parse(row));
            const ownership = z
              .object({
                reserved_attempts: z.number().int().positive(),
                consumed_attempts: z.number().int().nonnegative(),
                allocation_state: z.enum(['reserved', 'settled']),
              })
              .parse(this.workflowOwner(workflowId));
            if (
              ownership.allocation_state !== 'reserved' ||
              ownership.consumed_attempts + rows.length > ownership.reserved_attempts
            )
              throw new Error('Delegated workflow attempt allocation exhausted');
            for (const row of rows) {
              db.prepare('INSERT INTO project_attempt_debits VALUES (?,?,?,?,1,?)').run(
                row.attempt_id,
                row.workflow_id,
                link.id,
                current.budget_revision,
                new Date().toISOString(),
              );
            }
            if (rows.length > 0) {
              db.prepare(
                'UPDATE project_workflow_owners SET consumed_attempts=consumed_attempts+? WHERE workflow_id=?',
              ).run(rows.length, z.string().parse(owner.owned_workflow_id));
              db.prepare(
                'UPDATE project_hierarchy_budget SET reserved=reserved-?,consumed=consumed+?,revision=revision+1 WHERE singleton=1',
              ).run(rows.length, rows.length);
            }
            const durableDebits = db
              .prepare(
                `WITH RECURSIVE descendants(id) AS (
                   SELECT id FROM workflow_runs WHERE id=? AND project_id=?
                   UNION ALL SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id=d.id
                   WHERE w.project_id=?
                 ) SELECT p.attempt_id,p.workflow_id FROM project_attempt_debits p
                   JOIN descendants d ON d.id=p.workflow_id`,
              )
              .all(workflowId, this.store.project.id, this.store.project.id)
              .map((row) => z.object({ attempt_id: text, workflow_id: text }).parse(row));
            for (const row of durableDebits)
              debits.push({ attemptId: row.attempt_id, workflowId: row.workflow_id });
            return result;
          } finally {
            db.prepare('DELETE FROM project_authority_scopes WHERE link_id=?').run(link.id);
          }
        });
      const ancestor = ancestors[index]!;
      return ancestor.store.transaction((db) => {
        ancestor.authorize();
        const inbound = ancestor.store.read((db) =>
          db.prepare("SELECT * FROM project_links WHERE side='child'").get(),
        );
        if (inbound) {
          const mirror = linkRow.parse(inbound),
            previous = ancestors[index - 1];
          if (!previous || previous.store.project.id !== mirror.parent_project_id)
            throw new Error('Complete root-to-leaf authority chain required');
          const authoritative = previous.link(mirror.id);
          ancestor.requireActive(
            mirror,
            authoritative.authority_revision,
            authoritative.budget_revision,
          );
          previous.requireActive(authoritative, mirror.authority_revision, mirror.budget_revision);
        }
        const result = lock(index + 1);
        const nextProject = ancestors[index + 1] ?? this;
        const outboundRaw = nextProject.store.read((nextDb) =>
          nextDb.prepare("SELECT * FROM project_links WHERE side='child'").get(),
        );
        const outbound = linkRow.parse(outboundRaw);
        const parentHalf = ancestor.link(outbound.id);
        if (
          parentHalf.side !== 'parent' ||
          parentHalf.child_project_id !== nextProject.store.project.id
        )
          throw new Error('Complete root-to-leaf allocation chain required');
        const existing = z
          .object({ count: z.number().int().nonnegative() })
          .parse(
            db
              .prepare('SELECT count(*) AS count FROM project_link_attempt_debits WHERE link_id=?')
              .get(parentHalf.id),
          ).count;
        const missing = debits.filter(
          (debit) =>
            !db
              .prepare(
                'SELECT 1 FROM project_link_attempt_debits WHERE link_id=? AND child_attempt_id=?',
              )
              .get(parentHalf.id, debit.attemptId),
        );
        if (existing + missing.length > parentHalf.budget_attempts)
          throw new Error('Ancestor project allocation exhausted');
        for (const debit of missing)
          db.prepare('INSERT INTO project_link_attempt_debits VALUES (?,?,?,?,1,?)').run(
            parentHalf.id,
            debit.attemptId,
            debit.workflowId,
            parentHalf.budget_revision,
            new Date().toISOString(),
          );
        return result;
      });
    };
    return lock(0);
  }
  /**
   * Authorizes only a previously persisted control interrupt. Paused and revoked links may
   * finish stopping existing work, but this scope cannot admit attempts or claim other effects.
   */
  withWorkflowControlAuthority<T>(
    workflowId: z.infer<typeof WorkflowIdSchema>,
    ancestors: readonly ProjectHierarchy[],
    input: {
      attemptId: z.infer<typeof AttemptIdSchema>;
      controlIntentId: string;
    },
    fn: () => T,
  ): T {
    const owner = this.workflowOwner(workflowId);
    if (!owner) return fn();
    const link = this.link(z.string().parse(owner.link_id));
    const parent = ancestors.at(-1);
    if (!parent || parent.store.project.id !== link.parent_project_id)
      throw new Error('Exact parent project service is required for delegated control');
    const checkMirrors = (childSide: Link, parentSide: Link) => {
      if (
        childSide.state !== parentSide.state ||
        childSide.authority_revision !== parentSide.authority_revision ||
        childSide.budget_revision !== parentSide.budget_revision ||
        !['active', 'paused', 'revoked'].includes(childSide.state)
      )
        throw new Error('Delegated control authority revisions or state do not match');
    };
    const lock = (index: number): T => {
      if (index === ancestors.length)
        return this.store.transaction((db) => {
          this.authorize();
          const current = this.link(link.id);
          const authoritative = parent.link(link.id);
          checkMirrors(current, authoritative);
          const control = z
            .object({
              attempt_id: AttemptIdSchema,
              state: z.enum(['requested', 'unconfirmed', 'confirmed']),
            })
            .parse(
              db
                .prepare('SELECT attempt_id,state FROM attempt_control_intents WHERE id=?')
                .get(input.controlIntentId),
            );
          if (
            control.attempt_id !== input.attemptId ||
            !['requested', 'unconfirmed'].includes(control.state)
          )
            throw new Error(
              'Delegated control intent is absent, settled, or belongs to another attempt',
            );
          const attempt = this.store.getAttempt(input.attemptId);
          if (attempt.workflowId !== workflowId)
            throw new Error('Delegated control attempt belongs to another workflow');
          db.prepare('INSERT INTO project_control_authority_scopes VALUES (?,?,?,?,?)').run(
            link.id,
            input.attemptId,
            input.controlIntentId,
            current.authority_revision,
            current.budget_revision,
          );
          try {
            const result = fn();
            if (result instanceof Promise)
              throw new Error('Hierarchy control authority scopes must be synchronous');
            return result;
          } finally {
            db.prepare(
              'DELETE FROM project_control_authority_scopes WHERE link_id=? AND attempt_id=? AND control_intent_id=?',
            ).run(link.id, input.attemptId, input.controlIntentId);
          }
        });
      const ancestor = ancestors[index]!;
      return ancestor.store.transaction(() => {
        ancestor.authorize();
        const inbound = ancestor.store.read((db) =>
          db.prepare("SELECT * FROM project_links WHERE side='child'").get(),
        );
        if (inbound) {
          const mirror = linkRow.parse(inbound);
          const previous = ancestors[index - 1];
          if (!previous || previous.store.project.id !== mirror.parent_project_id)
            throw new Error('Complete root-to-leaf control authority chain required');
          checkMirrors(mirror, previous.link(mirror.id));
        }
        return lock(index + 1);
      });
    };
    return lock(0);
  }
  setLinkState(
    child: ProjectHierarchy,
    input: {
      linkId: string;
      expectedAuthorityRevision: number;
      state: 'paused' | 'revoked';
      idempotencyKey: string;
    },
  ) {
    this.sameHost(child);
    return this.store.idempotent(
      'project.link-state',
      input.idempotencyKey,
      input,
      z.object({
        revision,
        state: z.enum(['paused', 'revoked']),
        settlement: z.enum(['confirmed', 'unconfirmed']),
      }),
      (db) => {
        this.authorize(true);
        const link = this.link(input.linkId);
        if (
          link.side !== 'parent' ||
          link.child_project_id !== child.store.project.id ||
          link.authority_revision !== input.expectedAuthorityRevision ||
          link.state === 'revoked'
        )
          throw new Error('Link control revision stale');
        const next = link.authority_revision + 1;
        const settlement = child.applyLinkState(link, input.state, next);
        db.prepare('UPDATE project_links SET state=?,authority_revision=? WHERE id=?').run(
          input.state,
          next,
          link.id,
        );
        return { revision: next, state: input.state, settlement };
      },
    ).value;
  }
  private applyLinkState(parent: Link, state: 'paused' | 'revoked', next: number) {
    return this.store.transaction((db) => {
      const link = this.link(parent.id);
      if (link.secret !== parent.secret || link.parent_project_id !== parent.parent_project_id)
        throw new Error('Link control authentication failed');
      if (link.authority_revision === next && link.state === state) return 'unconfirmed' as const;
      if (link.authority_revision !== parent.authority_revision)
        throw new Error('Child link revision stale');
      db.prepare('UPDATE project_links SET state=?,authority_revision=? WHERE id=?').run(
        state,
        next,
        link.id,
      );
      const workflows = db
        .prepare('SELECT workflow_id FROM project_workflow_owners WHERE link_id=?')
        .all(link.id);
      let settled = true;
      for (const row of workflows) {
        const workflow = this.store.getWorkflow(WorkflowIdSchema.parse(row.workflow_id));
        if (['finished', 'cancelled'].includes(workflow.phase)) continue;
        if (workflow.phase === 'running')
          this.store.controlWorkflow({
            actor: this.actor,
            workflowId: workflow.id,
            expectedWorkflowRevision: workflow.revision,
            expectedControlRevision: workflow.controlRevision,
            operation: state === 'revoked' ? { kind: 'cancel' } : { kind: 'pause', mode: 'drain' },
            idempotencyKey: `link-control/${link.id}/${next}/${workflow.id}`,
          });
        const current = this.store.getWorkflow(workflow.id);
        if (!['paused', 'cancelled', 'finished'].includes(current.phase)) settled = false;
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM project_links WHERE side='parent' AND state IN ('active','paused','unconfirmed') LIMIT 1",
          )
          .get()
      )
        settled = false;
      // Descendant admissions also require this revoked ancestor in the parent lock chain.
      return settled ? ('confirmed' as const) : ('unconfirmed' as const);
    });
  }
}
