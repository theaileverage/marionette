import { Schema } from 'effect';
import type { Store, SessionIdentity } from './store.js';

const integer = Schema.Number.check(
  Schema.makeFilter(Number.isInteger, { expected: 'an integer' }),
);

const positiveInteger = integer.check(Schema.isGreaterThan(0));

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

type ConstraintDecoder<A> = Schema.ConstraintDecoder<A, never>;

function decode<S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

export const profileSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)),
  kind: nonEmptyString,
  model: nonEmptyString,
  args: Schema.mutable(Schema.Array(Schema.String)),
})
  .annotate({ parseOptions: { onExcessProperty: 'error' } })
  .check(
    Schema.makeFilter(
      (profile) =>
        profile.args.some(
          (argument) => argument === profile.model || argument.endsWith(`=${profile.model}`),
        ),
      { expected: 'Native arguments must explicitly select the declared model' },
    ),
  );

export type AgentProfile = typeof profileSchema.Type;

export class Settings {
  constructor(
    private readonly store: Store,
    private readonly actor: SessionIdentity,
  ) {}

  get<T>(key: string, schema: ConstraintDecoder<T>): { revision: number; value: T } | null {
    return this.store.read((db) => {
      const raw = db
        .prepare(
          'SELECT revision, value_json FROM project_settings WHERE project_id = ? AND key = ?',
        )
        .get(this.store.project.id, key);

      if (!raw) return null;

      const row = decode(
        Schema.Struct({ revision: positiveInteger, value_json: Schema.String }),
        raw,
      );

      return { revision: row.revision, value: decode(schema, JSON.parse(row.value_json)) };
    });
  }

  set<T>(input: {
    key: string;
    expectedRevision: number;
    value: T;
    schema: ConstraintDecoder<T>;
    idempotencyKey: string;
  }) {
    const value = decode(input.schema, input.value);

    const stored = this.store.idempotent(
      'settings.set',
      input.idempotencyKey,
      { key: input.key, expectedRevision: input.expectedRevision, value },
      Schema.Struct({ revision: Schema.Finite, value: Schema.Unknown }),
      (db) => {
        const raw = db
          .prepare(
            'SELECT role, state FROM agent_sessions WHERE project_id = ? AND id = ? AND generation = ?',
          )
          .get(this.store.project.id, this.actor.id, this.actor.generation);

        const actor = decode(Schema.Struct({ role: Schema.String, state: Schema.String }), raw);

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

    return { revision: stored.revision, value: decode(input.schema, stored.value) };
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
          const row = decode(Schema.Struct({ value_json: Schema.String }), raw);

          return decode(profileSchema, JSON.parse(row.value_json));
        }),
    );
  }
}
