import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Store } from './store.js';
import { ArtifactFiles, artifactSchema } from './artifacts.js';
import { assertGitState, captureGitState, gitStateSchema } from './git.js';

const handoffRow = z.object({
  id: z.string(),
  result_id: z.string(),
  target_workspace_id: z.string(),
  expected_target_state_json: z.string(),
  state: z.enum([
    'pending',
    'integrating',
    'integrated',
    'conflict',
    'unconfirmed',
    'retained',
    'abandoned',
  ]),
  claim_revision: z.number(),
  claimed_attempt_id: z.string().nullable(),
  current_claim_id: z.string().nullable(),
  actual_target_state_json: z.string().nullable(),
  checks_json: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Handoff = z.infer<typeof handoffRow>;
const key = z.string().min(1).max(255);

const createSchema = z
  .object({
    resultId: key,
    consumer: z.object({ kind: z.enum(['session', 'job', 'workflow', 'user']), id: key }),
    targetWorkspaceId: key,
    expectedTarget: gitStateSchema,
    idempotencyKey: key,
  })
  .strict();
const claimSchema = z
  .object({
    handoffId: key,
    attemptId: key,
    expectedClaimRevision: z.number().int().nonnegative(),
    idempotencyKey: key,
  })
  .strict();
const completeSchema = z
  .object({
    handoffId: key,
    attemptId: key,
    expectedClaimRevision: z.number().int().positive(),
    state: z.enum(['integrated', 'conflict', 'unconfirmed']),
    reason: z.string().min(1),
    idempotencyKey: key,
  })
  .strict();
const checkSchema = z
  .object({
    handoffId: key,
    attemptId: key,
    expectedClaimRevision: z.number().int().positive(),
    argv: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().max(600_000),
    idempotencyKey: key,
  })
  .strict();
const checkRecord = z.object({
  kind: z.enum(['running', 'passed', 'failed']),
  argv: z.array(z.string()),
  target: gitStateSchema,
  exitCode: z.number().int().nullable(),
  log: artifactSchema.nullable(),
});
const resolveSchema = z
  .object({
    handoffId: key,
    expectedClaimRevision: z.number().int().nonnegative(),
    state: z.enum(['retained', 'abandoned']),
    reason: z.string().min(1),
    idempotencyKey: key,
  })
  .strict();
const replanSchema = z
  .object({
    handoffId: key,
    expectedClaimRevision: z.number().int().nonnegative(),
    expectedTarget: gitStateSchema,
    reason: z.string().min(1),
    idempotencyKey: key,
  })
  .strict();

export const handoffSchemas = {
  create: createSchema,
  claim: claimSchema,
  check: checkSchema,
  complete: completeSchema,
  resolve: resolveSchema,
  replan: replanSchema,
};

export class Handoffs {
  constructor(
    private readonly store: Store,
    private readonly artifacts: ArtifactFiles,
  ) {}

  private getIn(db: DatabaseSync, id: string): Handoff {
    const row = db
      .prepare('SELECT * FROM handoffs WHERE project_id = ? AND id = ?')
      .get(this.store.project.id, id);
    if (!row) throw new Error('Handoff does not belong to this project');
    return handoffRow.parse(row);
  }

  get(id: string): Handoff {
    return this.store.read((db) => this.getIn(db, id));
  }

  private mutate<T extends object>(
    scope: string,
    idempotencyKey: string,
    payload: T,
    operation: (db: DatabaseSync) => Handoff,
  ): Handoff {
    return this.store.idempotent(scope, idempotencyKey, payload, handoffRow, operation).value;
  }

  private verifyArtifacts(db: DatabaseSync, resultId: string): void {
    const rows = db
      .prepare(
        'SELECT a.digest, a.byte_length FROM artifacts a JOIN result_artifacts r ON r.artifact_id = a.id WHERE a.project_id = ? AND r.result_id = ?',
      )
      .all(this.store.project.id, resultId);
    if (rows.length === 0) throw new Error('A handoff requires durable result artifacts');
    for (const row of rows) {
      const artifact = z.object({ digest: z.string(), byte_length: z.number() }).parse(row);
      this.artifacts.verify({
        digest: artifact.digest,
        byteLength: artifact.byte_length,
        mediaType: 'application/octet-stream',
      });
    }
  }

  create(raw: z.input<typeof createSchema>): Handoff {
    const input = createSchema.parse(raw);
    return this.mutate('handoff.create', input.idempotencyKey, input, (db) => {
      const result = db
        .prepare('SELECT result_kind FROM results WHERE project_id = ? AND id = ?')
        .get(this.store.project.id, input.resultId);
      if (!result || z.object({ result_kind: z.string() }).parse(result).result_kind === 'report')
        throw new Error('Handoff requires a patch or commit result');
      const workspace = db
        .prepare('SELECT path, host_id, retired_at FROM workspaces WHERE project_id = ? AND id = ?')
        .get(this.store.project.id, input.targetWorkspaceId);
      const target = z
        .object({ path: z.string(), host_id: z.string(), retired_at: z.string().nullable() })
        .parse(workspace);
      if (target.host_id !== this.store.project.hostId || target.retired_at)
        throw new Error('Target workspace is unavailable on this host');
      if (captureGitState(target.path).repositoryRoot !== input.expectedTarget.repositoryRoot)
        throw new Error('Git target does not match the registered workspace');
      this.verifyArtifacts(db, input.resultId);
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO handoffs(id, project_id, result_id, consumer_kind, consumer_id, target_host_id, target_workspace_id, expected_target_state_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        this.store.project.id,
        input.resultId,
        input.consumer.kind,
        input.consumer.id,
        this.store.project.hostId,
        input.targetWorkspaceId,
        JSON.stringify(input.expectedTarget),
        now,
        now,
      );
      return this.getIn(db, id);
    });
  }

  claim(raw: z.input<typeof claimSchema>): Handoff {
    const input = claimSchema.parse(raw);
    return this.mutate('handoff.claim', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (handoff.claim_revision !== input.expectedClaimRevision || handoff.state !== 'pending')
        throw new Error('Handoff claim is stale or needs reconciliation');
      this.assertIntegrator(db, input.attemptId, handoff.target_workspace_id);
      const accepted = db
        .prepare(
          `SELECT 1 FROM result_acceptances a JOIN result_validity v ON v.result_id = a.result_id
        JOIN results r ON r.id = a.result_id JOIN jobs j ON j.id = r.job_id
        WHERE a.project_id = ? AND a.result_id = ? AND a.decision = 'accepted' AND v.state = 'eligible' AND a.brief_id = j.current_brief_id`,
        )
        .get(this.store.project.id, handoff.result_id);
      if (!accepted)
        throw new Error('Source result must be accepted for the current brief before integration');
      this.verifyArtifacts(db, handoff.result_id);
      assertGitState(gitStateSchema.parse(JSON.parse(handoff.expected_target_state_json)));
      const revision = handoff.claim_revision + 1;
      const claimId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO handoff_claims(id, project_id, handoff_id, attempt_id, claim_revision, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).run(claimId, this.store.project.id, handoff.id, input.attemptId, revision, now);
      db.prepare(
        `INSERT INTO writer_reservations(id, project_id, target_workspace_id, handoff_id, claim_id, owner_attempt_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'held', ?)`,
      ).run(
        randomUUID(),
        this.store.project.id,
        handoff.target_workspace_id,
        handoff.id,
        claimId,
        input.attemptId,
        now,
      );
      db.prepare(
        `UPDATE handoffs SET state = 'integrating', claim_revision = ?, claimed_attempt_id = ?, current_claim_id = ?, updated_at = ? WHERE id = ?`,
      ).run(revision, input.attemptId, claimId, now, handoff.id);
      return this.getIn(db, handoff.id);
    });
  }

  private assertIntegrator(db: DatabaseSync, attemptId: string, targetWorkspaceId: string): void {
    const row = db
      .prepare(
        `SELECT a.phase, a.brief_id, a.workspace_id, ws.access, ws.retired_at, j.current_brief_id, w.phase AS workflow_phase
      FROM attempts a JOIN jobs j ON j.id = a.job_id JOIN workspaces ws ON ws.id = a.workspace_id LEFT JOIN workflow_runs w ON w.id = a.workflow_id
      WHERE a.project_id = ? AND a.id = ?`,
      )
      .get(this.store.project.id, attemptId);
    const attempt = z
      .object({
        phase: z.string(),
        workspace_id: z.string(),
        access: z.string(),
        retired_at: z.string().nullable(),
        brief_id: z.string(),
        current_brief_id: z.string(),
        workflow_phase: z.string().nullable(),
      })
      .parse(row);
    if (
      attempt.workspace_id !== targetWorkspaceId ||
      attempt.access !== 'write' ||
      attempt.retired_at !== null ||
      attempt.phase !== 'running' ||
      attempt.brief_id !== attempt.current_brief_id ||
      (attempt.workflow_phase !== null && attempt.workflow_phase !== 'running')
    ) {
      throw new Error(
        'Integrator must be current, running, and assigned to the target write workspace',
      );
    }
  }

  check(raw: z.input<typeof checkSchema>): Handoff {
    const input = checkSchema.parse(raw);
    let started = false;
    const prepared = this.mutate('handoff.check.start', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (
        handoff.state !== 'integrating' ||
        handoff.claim_revision !== input.expectedClaimRevision ||
        handoff.claimed_attempt_id !== input.attemptId
      )
        throw new Error('Integrator claim is stale');
      this.assertIntegrator(db, input.attemptId, handoff.target_workspace_id);
      if (
        handoff.checks_json &&
        checkRecord.parse(JSON.parse(handoff.checks_json)).kind === 'running'
      )
        throw new Error('A prior check is unconfirmed; reconcile before retrying');
      const expected = gitStateSchema.parse(JSON.parse(handoff.expected_target_state_json));
      const target = captureGitState(expected.repositoryRoot);
      db.prepare('UPDATE handoffs SET checks_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify({ kind: 'running', argv: input.argv, target, exitCode: null, log: null }),
        new Date().toISOString(),
        handoff.id,
      );
      started = true;
      return this.getIn(db, handoff.id);
    });
    if (!started) return this.get(input.handoffId);
    const check = checkRecord.parse(JSON.parse(prepared.checks_json ?? 'null'));
    const [command, ...args] = input.argv;
    if (!command) throw new Error('Check command is required');
    const result = spawnSync(command, args, {
      cwd: check.target.repositoryRoot,
      timeout: input.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const log = this.artifacts.put(
      Buffer.concat([
        result.stdout ?? Buffer.alloc(0),
        result.stderr ?? Buffer.alloc(0),
        Buffer.from(result.error?.message ?? ''),
      ]),
      'text/plain',
    );
    let unchanged = true;
    try {
      assertGitState(check.target);
    } catch {
      unchanged = false;
    }
    return this.mutate('handoff.check.finish', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (handoff.state !== 'integrating' || handoff.claim_revision !== input.expectedClaimRevision)
        throw new Error('Integrator claim changed during target checks');
      const record = {
        ...check,
        kind: result.status === 0 && unchanged && !result.error ? 'passed' : 'failed',
        exitCode: result.status,
        log,
      };
      db.prepare('UPDATE handoffs SET checks_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(record),
        new Date().toISOString(),
        handoff.id,
      );
      return this.getIn(db, handoff.id);
    });
  }

  complete(raw: z.input<typeof completeSchema>): Handoff {
    const input = completeSchema.parse(raw);
    return this.mutate('handoff.complete', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (
        handoff.claim_revision !== input.expectedClaimRevision ||
        handoff.claimed_attempt_id !== input.attemptId ||
        handoff.state !== 'integrating'
      )
        throw new Error('Integrator claim is stale');
      if (input.state === 'integrated')
        this.assertIntegrator(db, input.attemptId, handoff.target_workspace_id);
      if (input.state === 'integrated') {
        const check = checkRecord.parse(JSON.parse(handoff.checks_json ?? 'null'));
        if (check.kind !== 'passed' || check.exitCode !== 0 || !check.log)
          throw new Error('Integrated handoffs require successful target checks');
        this.artifacts.verify(check.log);
        assertGitState(check.target);
      }
      const expected = gitStateSchema.parse(JSON.parse(handoff.expected_target_state_json));
      const actual = captureGitState(expected.repositoryRoot);
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE handoffs SET state = ?, actual_target_state_json = ?, reason = ?, updated_at = ? WHERE id = ?',
      ).run(input.state, JSON.stringify(actual), input.reason, now, handoff.id);
      const uncertain = input.state !== 'integrated';
      db.prepare('UPDATE handoff_claims SET state = ?, settled_at = ? WHERE id = ?').run(
        uncertain ? 'unconfirmed' : 'settled',
        uncertain ? null : now,
        handoff.current_claim_id,
      );
      db.prepare(
        'UPDATE writer_reservations SET state = ?, released_at = ?, release_reason = ? WHERE claim_id = ?',
      ).run(
        uncertain ? 'unconfirmed' : 'released',
        uncertain ? null : now,
        input.reason,
        handoff.current_claim_id,
      );
      return this.getIn(db, handoff.id);
    });
  }

  resolve(raw: z.input<typeof resolveSchema>): Handoff {
    const input = resolveSchema.parse(raw);
    return this.mutate('handoff.resolve', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (handoff.claim_revision !== input.expectedClaimRevision)
        throw new Error('Handoff revision is stale');
      if (!['pending', 'conflict', 'unconfirmed'].includes(handoff.state))
        throw new Error('Handoff is already resolved or has an active integrator');
      if (handoff.claimed_attempt_id) {
        const prior = z
          .object({ phase: z.string() })
          .parse(
            db
              .prepare('SELECT phase FROM attempts WHERE project_id = ? AND id = ?')
              .get(this.store.project.id, handoff.claimed_attempt_id),
          );
        if (!['settled', 'closed'].includes(prior.phase))
          throw new Error('Prior integrator settlement is unconfirmed');
      }
      this.verifyArtifacts(db, handoff.result_id);
      const now = new Date().toISOString();
      db.prepare('UPDATE handoffs SET state = ?, reason = ?, updated_at = ? WHERE id = ?').run(
        input.state,
        input.reason,
        now,
        handoff.id,
      );
      db.prepare(
        `UPDATE writer_reservations SET state = 'released', released_at = ?, release_reason = ? WHERE handoff_id = ?`,
      ).run(now, input.reason, handoff.id);
      db.prepare(
        `UPDATE handoff_claims SET state = 'settled', settled_at = ? WHERE handoff_id = ?`,
      ).run(now, handoff.id);
      return this.getIn(db, handoff.id);
    });
  }

  replan(raw: z.input<typeof replanSchema>): Handoff {
    const input = replanSchema.parse(raw);
    return this.mutate('handoff.replan', input.idempotencyKey, input, (db) => {
      const handoff = this.getIn(db, input.handoffId);
      if (
        handoff.claim_revision !== input.expectedClaimRevision ||
        ['integrated', 'retained', 'abandoned'].includes(handoff.state)
      )
        throw new Error('Handoff revision is stale or already resolved');
      if (handoff.claimed_attempt_id) {
        const prior = z
          .object({ phase: z.string() })
          .parse(
            db
              .prepare('SELECT phase FROM attempts WHERE project_id = ? AND id = ?')
              .get(this.store.project.id, handoff.claimed_attempt_id),
          );
        if (!['settled', 'closed'].includes(prior.phase))
          throw new Error('Prior integrator settlement is unconfirmed');
      }
      const original = gitStateSchema.parse(JSON.parse(handoff.expected_target_state_json));
      if (original.repositoryRoot !== input.expectedTarget.repositoryRoot)
        throw new Error('Replanning cannot switch the target workspace');
      assertGitState(input.expectedTarget);
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE writer_reservations SET state = 'released', released_at = ?, release_reason = ? WHERE handoff_id = ?`,
      ).run(now, input.reason, handoff.id);
      db.prepare(
        `UPDATE handoff_claims SET state = 'settled', settled_at = ? WHERE handoff_id = ?`,
      ).run(now, handoff.id);
      db.prepare(
        `UPDATE handoffs SET state = 'pending', claim_revision = claim_revision + 1, claimed_attempt_id = NULL, current_claim_id = NULL,
        expected_target_state_json = ?, actual_target_state_json = ?, checks_json = NULL, reason = ?, updated_at = ? WHERE id = ?`,
      ).run(
        JSON.stringify(input.expectedTarget),
        JSON.stringify(input.expectedTarget),
        input.reason,
        now,
        handoff.id,
      );
      return this.getIn(db, handoff.id);
    });
  }
}
