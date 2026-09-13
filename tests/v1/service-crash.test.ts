import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Store } from '../../src/v1/store.js';
import { ProjectBindingSchema } from '../../src/v1/model.js';
import { ServiceOwnership } from '../../src/v1/service/ownership.js';
import { EventStore } from '../../src/v1/events/event-store.js';

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error('Child ready timeout: ' + errors)), 10_000);
    child.stderr?.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!output.includes('READY')) reject(new Error(`Child exited ${code}: ${errors}`));
    });
  });
}

test('actual SIGKILL service takeover recovers pre-submit claim and preserves submitted uncertainty', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-kill-'));
  const childPath = resolve('.v1-test', 'service-crash-child-' + randomUUID() + '.mjs');
  const project = ProjectBindingSchema.parse({
    id: 'crash-project',
    hostId: 'crash-host',
    repositoryRoot: root,
    stateDirectory: root,
  });
  const databasePath = join(root, 'project.sqlite');
  const store = Store.open({ databasePath, project });
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(childPath, { force: true });
  });
  store.transaction((db) =>
    db
      .prepare(
        "INSERT INTO controller_definitions(id,project_id,profile_policy_id,state,created_at) VALUES('controller',?,'fixture','unconfigured',?)",
      )
      .run(project.id, new Date().toISOString()),
  );
  const events = new EventStore(store);
  for (const id of ['before-submit', 'after-submit'])
    events.append({
      kind: 'test.crash',
      aggregate: { kind: 'fixture', id, revision: 1 },
      payload: {},
      dedupeKey: id,
    });
  const source = `
 import {Store} from './src/v1/store.ts';
 import {runProjectService} from './src/v1/service/project-service.ts';
 const project=JSON.parse(process.argv[2]);const store=Store.open({databasePath:process.argv[3],project});
 const processIdentity=JSON.stringify({pid:process.pid,startToken:'fixture-'+process.pid});
 const livenessPort={async confirmAbsent(input){const pid=JSON.parse(input.processIdentity).pid;try{process.kill(pid,0);return false;}catch(error){return error?.code==='ESRCH';}}};
 const signal=new AbortController();process.once('SIGTERM',()=>signal.abort());let first=true;
 try { await runProjectService({store,processIdentity,livenessPort,signal:signal.signal,watchdogMs:100,async recover(){},async scan(owner){if(!first)return;first=false;if(process.argv[4]==='claim')store.transaction(db=>{for(const [key,state] of [['before-submit','claimed'],['after-submit','submitted']])db.prepare('UPDATE controller_inbox_items SET state=?,service_generation=?,controller_generation=1,claim_revision=1,attempt_count=1 WHERE event_id=(SELECT id FROM domain_events WHERE dedupe_key=?)').run(state,owner.generation,key);});process.stdout.write('READY\\n');}}); } finally {store.close();}
 `;
  await build({
    stdin: {
      contents: source,
      resolveDir: process.cwd(),
      sourcefile: 'service-crash-fixture.ts',
      loader: 'ts',
    },
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const launch = (mode: string) => {
    const child = spawn(
      process.execPath,
      [childPath, JSON.stringify(project), databasePath, mode],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    return child;
  };
  const first = launch('claim');
  await ready(first);
  const generation = ServiceOwnership.status(store)?.generation;
  assert.ok(generation);
  const competing = launch('recover');
  let rejected = '';
  competing.stderr?.on('data', (chunk) => {
    rejected += String(chunk);
  });
  const [code] = await once(competing, 'exit');
  assert.notEqual(code, 0);
  assert.match(rejected, /confirmed former process absence/);
  const firstExit = once(first, 'exit');
  first.kill('SIGKILL');
  await firstExit;
  const second = launch('recover');
  await ready(second);
  assert.notEqual(ServiceOwnership.status(store)?.generation, generation);
  const rows = store.read((db) =>
    db
      .prepare(
        'SELECT e.dedupe_key,i.state,i.claim_revision,i.service_generation FROM controller_inbox_items i JOIN domain_events e ON e.id=i.event_id ORDER BY e.dedupe_key',
      )
      .all(),
  );
  assert.equal(rows.find((row) => row.dedupe_key === 'before-submit')?.state, 'pending');
  assert.equal(rows.find((row) => row.dedupe_key === 'before-submit')?.claim_revision, 2);
  assert.equal(rows.find((row) => row.dedupe_key === 'after-submit')?.state, 'submitted');
  assert.equal(
    rows.find((row) => row.dedupe_key === 'after-submit')?.service_generation,
    generation,
  );
  const secondExit = once(second, 'exit');
  second.kill('SIGTERM');
  await secondExit;
  assert.equal(ServiceOwnership.status(store)?.state, 'stopped');
});
