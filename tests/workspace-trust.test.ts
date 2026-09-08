import assert from 'node:assert/strict';
import { Schema } from 'effect';
import { test, onTestFinished } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  removeWorkspaceTrust,
  trustWorkspace,
  workspaceTrustEnabled,
} from '../src/workspace-trust.js';

function fixture() {
  const home = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-trust-')));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const root = resolve(home, 'project with spaces');
  mkdirSync(root);
  return { home, root, config: resolve(home, 'agent-settings') };
}
test('Codex trust preserves comments, project options and permissions and restores only its own field', () => {
  const f = fixture();
  const before = `# personal settings\nmodel = "chosen"\n[projects.${JSON.stringify(f.root)}]\ntrust_level = "untrusted" # keep comment\nother = true\n[features]\nhooks = true\n`;
  writeFileSync(f.config, before, { mode: 0o640 });
  assert.equal(trustWorkspace(f.root, 'codex', f.home, 'one', f.config).changed, true);
  assert.equal(statSync(f.config).mode & 0o777, 0o640);
  assert.equal(readFileSync(f.config, 'utf8'), before.replace('"untrusted"', '"trusted"'));
  trustWorkspace(f.root, 'codex', f.home, 'two', f.config);
  removeWorkspaceTrust(f.home, 'one');
  assert.match(readFileSync(f.config, 'utf8'), /trust_level = "trusted"/);
  removeWorkspaceTrust(f.home, 'two');
  assert.equal(readFileSync(f.config, 'utf8'), before);
});
test('new Codex trust section round-trips paths containing quotes and preserves unrelated config', () => {
  const f = fixture();
  const root = resolve(f.home, 'project "quotes"');
  mkdirSync(root);
  writeFileSync(f.config, '# comment\nmodel = "chosen"\n');
  trustWorkspace(root, 'codex', f.home, 'one', f.config);
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({
      projects: Schema.Record(Schema.String, Schema.Struct({ trust_level: Schema.String })),
    }),
  )(Bun.TOML.parse(readFileSync(f.config, 'utf8')));
  assert.equal(parsed.projects[root].trust_level, 'trusted');
  removeWorkspaceTrust(f.home, 'one');
  assert.equal(readFileSync(f.config, 'utf8').trim(), '# comment\nmodel = "chosen"');
});
test('Claude trust changes only workspace acceptance and preserves later native edits on removal', () => {
  const f = fixture();
  const before = {
    projects: { [f.root]: { allowedTools: ['Read'], hasTrustDialogAccepted: false } },
    theme: 'dark',
  };
  writeFileSync(f.config, JSON.stringify(before));
  trustWorkspace(f.root, 'claude', f.home, 'one', f.config);
  const after = JSON.parse(readFileSync(f.config, 'utf8'));
  assert.deepEqual(after.projects[f.root], {
    allowedTools: ['Read'],
    hasTrustDialogAccepted: true,
  });
  after.projects[f.root].newSetting = 'preserve';
  writeFileSync(f.config, JSON.stringify(after));
  removeWorkspaceTrust(f.home, 'one');
  assert.deepEqual(JSON.parse(readFileSync(f.config, 'utf8')).projects[f.root], {
    allowedTools: ['Read'],
    hasTrustDialogAccepted: false,
    newSetting: 'preserve',
  });
});
test('AGY trust shares the general lifecycle and never removes preexisting trust', () => {
  const f = fixture();
  writeFileSync(
    f.config,
    JSON.stringify({ trustedWorkspaces: ['/existing'], permissions: { mode: 'ask' } }),
  );
  trustWorkspace(f.root, 'agy', f.home, 'one', f.config);
  removeWorkspaceTrust(f.home, 'one');
  assert.deepEqual(JSON.parse(readFileSync(f.config, 'utf8')), {
    trustedWorkspaces: ['/existing'],
    permissions: { mode: 'ask' },
  });
  writeFileSync(f.config, JSON.stringify({ trustedWorkspaces: [f.root] }));
  assert.equal(trustWorkspace(f.root, 'agy', f.home, 'one', f.config).changed, false);
  removeWorkspaceTrust(f.home, 'one');
  assert.deepEqual(JSON.parse(readFileSync(f.config, 'utf8')).trustedWorkspaces, [f.root]);
});
test('malformed settings fail closed and legacy AGY trust never expands to another agent', () => {
  const f = fixture();
  writeFileSync(f.config, '{bad json');
  assert.throws(() => trustWorkspace(f.root, 'claude', f.home, 'one', f.config));
  assert.equal(readFileSync(f.config, 'utf8'), '{bad json');
  assert.equal(workspaceTrustEnabled({ trustAgyWorkspaces: true }, 'codex'), false);
  assert.equal(workspaceTrustEnabled({ trustAgyWorkspaces: true }, 'agy'), true);
  assert.equal(
    workspaceTrustEnabled({ trustWorkspaces: false, trustAgyWorkspaces: true }, 'agy'),
    false,
  );
});
