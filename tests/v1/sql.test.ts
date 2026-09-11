import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Board } from '../../src/v1/board.js';
import { ProjectBindingSchema } from '../../src/v1/model.js';
import { SqlQueryService } from '../../src/v1/sql.js';
import { executeContributionRequest, executeSqlRequest } from '../../src/v1/sql-worker.js';
import { Store } from '../../src/v1/store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-sql-'));
  const databasePath = join(root, 'project.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE board_posts(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL);
    INSERT INTO board_posts VALUES ('project-a','a1','visible'),('project-b','b1','private');
    CREATE TABLE notification_deliveries(project_id TEXT NOT NULL,state TEXT NOT NULL);
    INSERT INTO notification_deliveries VALUES ('project-a','pending');
    CREATE VIEW public_board_posts AS
      SELECT id,body FROM board_posts WHERE project_id=marionette_project_id();
  `);
  db.close();
  return { root, databasePath };
}

test('SQL reads are constrained to public project-scoped views', () => {
  const f = fixture();
  try {
    assert.deepEqual(
      executeSqlRequest({
        databasePath: f.databasePath,
        projectId: 'project-a',
        sql: 'SELECT id,body FROM public_board_posts',
        parameters: {},
        maxRows: 10,
        maxBytes: 1000,
      }).rows,
      [{ id: 'a1', body: 'visible' }],
    );
    assert.throws(
      () =>
        executeSqlRequest({
          databasePath: f.databasePath,
          projectId: 'project-a',
          sql: 'SELECT * FROM board_posts',
          parameters: {},
          maxRows: 10,
          maxBytes: 1000,
        }),
      /prohibited/,
    );
    assert.throws(
      () =>
        executeSqlRequest({
          databasePath: f.databasePath,
          projectId: 'project-a',
          sql: 'SELECT * FROM notification_deliveries',
          parameters: {},
          maxRows: 10,
          maxBytes: 1000,
        }),
      /prohibited/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SQL authorizer rejects mutations, pragma, attach and extension loading', () => {
  const f = fixture();
  try {
    for (const sql of [
      "INSERT INTO board_posts VALUES ('project-a','a2','attack')",
      'PRAGMA writable_schema=ON',
      "ATTACH DATABASE ':memory:' AS attack",
      "SELECT load_extension('evil')",
    ]) {
      assert.throws(
        () =>
          executeSqlRequest({
            databasePath: f.databasePath,
            projectId: 'project-a',
            sql,
            parameters: {},
            maxRows: 10,
            maxBytes: 1000,
          }),
        /not authorized|prohibited/,
      );
    }
    const reopened = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        reopened
          .prepare('SELECT id,body FROM board_posts ORDER BY id')
          .all()
          .map((row) => ({ id: row.id, body: row.body })),
        [
          { id: 'a1', body: 'visible' },
          { id: 'b1', body: 'private' },
        ],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('board contribution SQL can insert one validated in-memory contribution only', () => {
  assert.deepEqual(
    executeContributionRequest({
      sql: 'INSERT INTO board_contributions(body,kind,references_json) VALUES (\'A durable finding\',\'finding\',\'[{"kind":"file","value":"evidence.md"}]\')',
      parameters: {},
    }),
    {
      body: 'A durable finding',
      kind: 'finding',
      references: [{ kind: 'file', value: 'evidence.md' }],
      replyToPostId: null,
      replacesPostId: null,
    },
  );
  for (const sql of [
    "INSERT INTO board_contributions(body,kind) VALUES ('one','finding'); INSERT INTO board_contributions(body,kind) VALUES ('two','finding')",
    "INSERT INTO board_contributions(body,kind) VALUES ('one','finding'),('two','finding')",
    "INSERT INTO board_contributions(body,kind) SELECT body,'finding' FROM board_contributions",
    "UPDATE board_contributions SET body='tampered'",
    "ATTACH DATABASE ':memory:' AS attack",
    "INSERT INTO board_posts VALUES ('runtime write')",
  ]) {
    assert.throws(
      () => executeContributionRequest({ sql, parameters: {} }),
      /authorized|exactly one|statement|no such table/,
    );
  }
});

test('SQL row and byte bounds stop iteration with truncation', () => {
  const f = fixture();
  try {
    const byRows = executeSqlRequest({
      databasePath: f.databasePath,
      projectId: 'project-a',
      sql: 'SELECT id,body FROM public_board_posts',
      parameters: {},
      maxRows: 1,
      maxBytes: 1000,
    });
    assert.equal(byRows.rows.length, 1);
    assert.equal(byRows.truncated, false);
    const byBytes = executeSqlRequest({
      databasePath: f.databasePath,
      projectId: 'project-a',
      sql: "SELECT '0123456789abcdef' AS body FROM public_board_posts",
      parameters: {},
      maxRows: 10,
      maxBytes: 5,
    });
    assert.equal(byBytes.rows.length, 0);
    assert.equal(byBytes.truncated, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SQL query timeout kills the isolated Node worker', async () => {
  const f = fixture();
  const store = Store.open({
    databasePath: join(f.root, 'board.sqlite'),
    project: ProjectBindingSchema.parse({
      id: 'project-a',
      hostId: 'host-a',
      repositoryRoot: f.root,
      stateDirectory: f.root,
    }),
  });
  try {
    const board = Board.create({ store });
    const thread = board.createThread({
      title: 'SQL visible post',
      author: { kind: 'system', id: 'controller' },
      idempotencyKey: 'sql-thread',
    });
    board.post({
      threadId: thread.id,
      author: { kind: 'system', id: 'controller' },
      body: 'visible',
      kind: 'finding',
      idempotencyKey: 'sql-post',
    });
    const service = new SqlQueryService({
      board,
      workerPath: join(process.cwd(), 'src/v1/sql-worker.ts'),
    });
    const complete = await service.read({
      sql: 'SELECT body FROM public_board_posts',
      timeoutMs: 2_000,
      maxRows: 10,
      maxBytes: 1000,
    });
    assert.deepEqual(complete.rows, [{ body: 'visible' }]);
    const contribution = await service.contribute({
      threadId: thread.id,
      author: { kind: 'system', id: 'controller' },
      kind: 'finding',
      idempotencyKey: 'contribution-1',
      sql: "INSERT INTO board_contributions(body,kind,references_json) VALUES ('from contribution','finding','[]')",
    });
    assert.equal(contribution.body, 'from contribution');
    assert.equal(
      (
        await service.contribute({
          threadId: thread.id,
          author: { kind: 'system', id: 'controller' },
          kind: 'finding',
          idempotencyKey: 'contribution-1',
          sql: "INSERT INTO board_contributions(body,kind,references_json) VALUES ('from contribution','finding','[]')",
        })
      ).id,
      contribution.id,
    );
    await assert.rejects(
      service.contribute({
        threadId: thread.id,
        author: { kind: 'system', id: 'controller' },
        kind: 'finding',
        idempotencyKey: 'contribution-1',
        sql: "INSERT INTO board_contributions(body,kind,references_json) VALUES ('different body','finding','[]')",
      }),
      /idempotency key/,
    );
    await assert.rejects(
      service.read({
        sql: 'SELECT id,body FROM public_board_posts',
        timeoutMs: 1,
        maxRows: 10,
        maxBytes: 1000,
      }),
      /exceeded 1ms/,
    );
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
