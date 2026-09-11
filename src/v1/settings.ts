import { z } from 'zod';
import type { Store, SessionIdentity } from './store.js';

export const profileSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    kind: z.string().min(1),
    model: z.string().min(1),
    args: z.array(z.string()),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      !profile.args.some(
        (argument) => argument === profile.model || argument.endsWith(`=${profile.model}`),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['args'],
        message: 'Native arguments must explicitly select the declared model',
      });
    }
  });
export type AgentProfile = z.infer<typeof profileSchema>;

export class Settings {
  constructor(
    private readonly store: Store,
    private readonly actor: SessionIdentity,
  ) {}

  get<T>(key: string, schema: z.ZodType<T>): { revision: number; value: T } | null {
    return this.store.read((db) => {
      const raw = db
        .prepare(
          'SELECT revision, value_json FROM project_settings WHERE project_id = ? AND key = ?',
        )
        .get(this.store.project.id, key);
      if (!raw) return null;
      const row = z
        .object({ revision: z.number().int().positive(), value_json: z.string() })
        .parse(raw);
      return { revision: row.revision, value: schema.parse(JSON.parse(row.value_json)) };
    });
  }

  set<T>(input: {
    key: string;
    expectedRevision: number;
    value: T;
    schema: z.ZodType<T>;
    idempotencyKey: string;
  }) {
    const value = input.schema.parse(input.value);
    const stored = this.store.idempotent(
      'settings.set',
      input.idempotencyKey,
      { key: input.key, expectedRevision: input.expectedRevision, value },
      z.object({ revision: z.number(), value: z.unknown() }),
      (db) => {
        const raw = db
          .prepare(
            'SELECT role, state FROM agent_sessions WHERE project_id = ? AND id = ? AND generation = ?',
          )
          .get(this.store.project.id, this.actor.id, this.actor.generation);
        const actor = z.object({ role: z.string(), state: z.string() }).parse(raw);
        if (actor.state !== 'active' || !['user', 'controller'].includes(actor.role))
          throw new Error('Only an active user or controller can change runtime settings');
        const current = this.get(input.key, input.schema);
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw new Error('Runtime settings revision is stale');
        const revision = input.expectedRevision + 1;
        db.prepare(
          `INSERT INTO project_settings(project_id, key, revision, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, key) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json, updated_at = excluded.updated_at`,
        ).run(
          this.store.project.id,
          input.key,
          revision,
          JSON.stringify(value),
          new Date().toISOString(),
        );
        return { revision, value };
      },
    ).value;
    return { revision: stored.revision, value: input.schema.parse(stored.value) };
  }

  profile(name: string): AgentProfile {
    const configured = this.get(`profile/${name}`, profileSchema);
    if (!configured)
      throw new Error(
        `Profile ${name} is not configured. Register its native kind, model and arguments first.`,
      );
    return configured.value;
  }

  profiles(): AgentProfile[] {
    return this.store.read((db) =>
      db
        .prepare(
          "SELECT value_json FROM project_settings WHERE project_id = ? AND key LIKE 'profile/%' ORDER BY key",
        )
        .all(this.store.project.id)
        .map((raw) => {
          const row = z.object({ value_json: z.string() }).parse(raw);
          return profileSchema.parse(JSON.parse(row.value_json));
        }),
    );
  }
}
