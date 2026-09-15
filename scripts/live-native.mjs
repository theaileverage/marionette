#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Predicate, Effect } from 'effect';

const EFFECT_PORT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIVE_ROOT = join(EFFECT_PORT_ROOT, '.test-output', 'live-native');

const FIXTURE_PROJECT = join(LIVE_ROOT, 'project');

const STATE_HOME = join(LIVE_ROOT, 'state');

const EVIDENCE_DIRECTORY = join(LIVE_ROOT, 'evidence');

const MANIFEST_PATH = join(EVIDENCE_DIRECTORY, 'live-native-session.json');

const TRUSTED_CHECKOUT = '/Users/ankeethsuvarna/.codex/worktrees/4c53/marionette';

const INPUT_PATH = join(TRUSTED_CHECKOUT, 'effect-port', 'docs', 'extensions.md');

const SOCKET_PATH = '/Users/ankeethsuvarna/.config/herdr/herdr.sock';

const NATIVE_WORKSPACE = 'wK';

const WORKSPACE_ID = 'live-native-inspect';

const PROFILE_NAME = 'verified';

const MODEL = 'claude-sonnet-5';

const CLI_PATH = join(EFFECT_PORT_ROOT, 'dist', 'v1', 'cli.js');

const DIST_FILES = [
  join(EFFECT_PORT_ROOT, 'dist', 'v1', 'client.js'),
  join(EFFECT_PORT_ROOT, 'dist', 'v1', 'operations.js'),
  CLI_PATH,
];

let loadedPort;

function portModules() {
  loadedPort ??= Promise.all([
    import('../dist/v1/client.js'),
    import('../dist/v1/operations.js'),
  ]).then(([client, operations]) => ({
    Marionette: client.Marionette,
    executeEffect: operations.executeEffect,
  }));

  return loadedPort;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileDigest(path) {
  return sha256(readFileSync(path));
}

function fail(message) {
  throw new Error(message);
}

function requireRecord(value, name) {
  if (!(Predicate.isObjectOrArray(value) || value === null) || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }

  return value;
}

function requireString(record, field) {
  const value = record[field];

  if (!Predicate.isString(value) || value.length === 0) fail(`Manifest ${field} is invalid`);

  return value;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`No live-native manifest exists at ${MANIFEST_PATH}; run start once`);
  }

  const manifest = requireRecord(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), 'Manifest');

  if (manifest.version !== 1) fail('Unsupported live-native manifest version');

  for (const field of [
    'createdAt',
    'fixtureProject',
    'stateHome',
    'stateDirectory',
    'projectId',
    'hostId',
    'workspaceId',
    'profileName',
    'jobId',
    'attemptId',
  ]) {
    requireString(manifest, field);
  }

  if (!Number.isInteger(manifest.briefRevision) || manifest.briefRevision < 1) {
    fail('Manifest briefRevision is invalid');
  }

  const input = requireRecord(manifest.input, 'Manifest input');

  for (const field of ['path', 'name', 'digest', 'artifactId', 'mediaType']) {
    requireString(input, field);
  }

  if (!Number.isInteger(input.byteLength) || input.byteLength < 0) {
    fail('Manifest input byteLength is invalid');
  }

  if (!/^[a-f0-9]{64}$/.test(input.digest)) fail('Manifest input digest is invalid');
  const verification = requireRecord(manifest.verification, 'Manifest verification');

  if (
    !Array.isArray(verification.argv) ||
    !verification.argv.every((item) => Predicate.isString(item))
  ) {
    fail('Manifest verification argv is invalid');
  }

  requireString(verification, 'marker');
  const expectedVerification = verificationContract(input.digest);

  if (
    verification.marker !== expectedVerification.marker ||
    JSON.stringify(verification.argv) !== JSON.stringify(expectedVerification.argv)
  ) {
    fail('Manifest verification contract changed');
  }

  if (
    manifest.fixtureProject !== resolve(FIXTURE_PROJECT) ||
    manifest.stateHome !== resolve(STATE_HOME) ||
    manifest.stateDirectory !== join(resolve(STATE_HOME), 'projects', manifest.projectId) ||
    manifest.workspaceId !== WORKSPACE_ID ||
    manifest.profileName !== PROFILE_NAME ||
    input.path !== INPUT_PATH ||
    input.name !== 'extensions.md' ||
    input.mediaType !== 'text/markdown'
  ) {
    fail('Manifest is not for this bounded live-native fixture');
  }

  const profile = requireRecord(manifest.profile, 'Manifest profile');

  if (
    profile.kind !== 'claude' ||
    profile.model !== MODEL ||
    JSON.stringify(profile.args) !== JSON.stringify(['--model', MODEL])
  ) {
    fail('Manifest profile does not match the verified profile');
  }

  const native = requireRecord(manifest.native, 'Manifest native registration');
  const binding = requireRecord(native.binding, 'Manifest native binding');
  const endpoint = requireRecord(binding.endpoint, 'Manifest native endpoint');

  if (
    native.socketPath !== SOCKET_PATH ||
    native.workspaceId !== NATIVE_WORKSPACE ||
    binding.hostId !== manifest.hostId ||
    binding.socketPath !== SOCKET_PATH ||
    binding.workspaceId !== NATIVE_WORKSPACE
  ) {
    fail('Manifest native binding does not match the observed target');
  }

  for (const field of ['device', 'inode', 'birthtimeMs', 'protocol']) {
    if (!Predicate.isNumber(endpoint[field]) || !Number.isFinite(endpoint[field])) {
      fail(`Manifest native endpoint ${field} is invalid`);
    }
  }

  requireString(endpoint, 'serverStartToken');
  const dist = requireRecord(manifest.dist, 'Manifest dist fingerprints');

  for (const path of DIST_FILES) {
    if (!existsSync(path) || dist[path] !== fileDigest(path)) {
      fail(`Port build output changed after start: ${path}`);
    }
  }

  return manifest;
}

function persistManifest(manifest) {
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 });
  const descriptor = openSync(MANIFEST_PATH, 'wx', 0o600);

  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  const directory = openSync(EVIDENCE_DIRECTORY, 'r');

  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function connectionOptions(manifest) {
  return {
    cwd: manifest.fixtureProject,
    env: { MARIONETTE_STATE_HOME: manifest.stateHome },
  };
}

async function execute(client, input) {
  const { executeEffect } = await portModules();

  return Effect.runPromise(executeEffect(client, input));
}

async function withClient(options, action) {
  const { Marionette } = await portModules();
  const client = Marionette.connect(options);

  try {
    return await action(client);
  } finally {
    client.close();
  }
}

function verificationContract(digest) {
  const marker = `LIVE_NATIVE_INPUT_SHA256=${digest}`;

  const program =
    'actual=$(/usr/bin/shasum -a 256 "$1" | /usr/bin/awk \'{print $1}\'); ' +
    'printf \'LIVE_NATIVE_INPUT_SHA256=%s\\n\' "$actual"; test "$actual" = "$2"';

  return {
    marker,
    argv: ['/bin/sh', '-c', program, 'marionette-live-native-check', INPUT_PATH, digest],
  };
}

function workerBrief(input, verification) {
  const logPath = `/tmp/marionette-live-native-${input.digest.slice(0, 12)}.log`;

  return {
    objective:
      `Read the pinned input ${INPUT_PATH} and submit a bounded read-only report through the port CLI. ` +
      `The report body must contain the exact marker ${verification.marker}.`,
    scope: [INPUT_PATH],
    ownership: [],
    constraints: [
      'Do not edit source code, the trusted checkout, Git state, or Marionette database files.',
      `Use only the port CLI at ${CLI_PATH} for Marionette operations.`,
      `Before reporting, run this exact argv and redirect its stdout to ${logPath}: ${JSON.stringify(verification.argv)}.`,
      `The verification command must exit 0 and print ${verification.marker}.`,
      `Snapshot both ${INPUT_PATH} and ${logPath} with the input.snapshot operation.`,
      `The input snapshot digest must equal ${input.digest}.`,
      `The report body must identify the exact pinned path ${INPUT_PATH}.`,
      'Record exactly one report result for this attempt with result.record.',
      `Set both inputDigest and workspaceDigest to ${input.digest}.`,
      `Include ${input.digest} and the verification-log digest in content.artifactDigests.`,
      `Include file evidence {kind:"file",path:${JSON.stringify(INPUT_PATH)},digest:${JSON.stringify(input.digest)}}.`,
      `Include command evidence whose argv is exactly ${JSON.stringify(verification.argv)}, exitCode is 0, and log is the verification-log snapshot digest.`,
      `Set verification to {kind:"passed",checks:[the same command evidence]}.`,
      `Use evidenceClaims ["pinned-input-sha256","read-only-report"].`,
      'Use no upstream result IDs and a stable idempotency key.',
    ],
    standingOrders: [
      'Acknowledge the current brief revision before doing the work.',
      'Treat native idle as transport state only; the durable result is the deliverable.',
      'If the observed digest differs, record no result and report the mismatch as a blocker.',
    ],
    inputSnapshots: [{ name: input.name, digest: input.digest }],
  };
}

async function start() {
  if (existsSync(MANIFEST_PATH)) {
    fail(`Refusing to replay start because ${MANIFEST_PATH} exists; use status`);
  }

  for (const path of DIST_FILES) {
    if (!existsSync(path)) fail(`Port build output is missing: ${path}`);
  }

  if (realpathSync(TRUSTED_CHECKOUT) !== TRUSTED_CHECKOUT) {
    fail(`Trusted checkout identity changed: ${TRUSTED_CHECKOUT}`);
  }

  const inputBytes = readFileSync(INPUT_PATH);
  const expectedDigest = sha256(inputBytes);
  const verification = verificationContract(expectedDigest);
  mkdirSync(FIXTURE_PROJECT, { recursive: true, mode: 0o700 });
  mkdirSync(STATE_HOME, { recursive: true, mode: 0o700 });

  const { Marionette } = await portModules();
  const client = Marionette.init({ repositoryRoot: FIXTURE_PROJECT, stateHome: STATE_HOME });

  try {
    const context = client.context();

    const workspace = await execute(client, {
      operation: 'workspace.register',
      id: WORKSPACE_ID,
      kind: 'existing',
      path: TRUSTED_CHECKOUT,
      repositoryRoot: TRUSTED_CHECKOUT,
      baseCommit: null,
      access: 'inspect',
      writes: [],
      idempotencyKey: 'live-native/register-inspect-workspace-v1',
    });

    await execute(client, {
      operation: 'profile.configure',
      profile: {
        name: PROFILE_NAME,
        kind: 'claude',
        model: MODEL,
        args: ['--model', MODEL],
      },
      expectedRevision: 0,
      idempotencyKey: 'live-native/configure-verified-profile-v1',
    });

    const nativeRegistration = await execute(client, {
      operation: 'native.register',
      socketPath: SOCKET_PATH,
      workspaceId: NATIVE_WORKSPACE,
      expectedRevision: 0,
      idempotencyKey: 'live-native/register-herdr-wK-v1',
    });

    const input = await execute(client, {
      operation: 'input.snapshot',
      path: INPUT_PATH,
      name: 'extensions.md',
      mediaType: 'text/markdown',
    });

    if (input.digest !== expectedDigest || input.byteLength !== inputBytes.byteLength) {
      fail('Pinned input snapshot does not match the source bytes');
    }

    const requestText = `Produce a read-only report about the pinned extensions design input. ${verification.marker}`;

    const job = await execute(client, {
      operation: 'job.create',
      stableKey: 'live-native-extensions-read-only-v1',
      request: {
        text: requestText,
        digest: sha256(Buffer.from(requestText)),
        inputSnapshots: [{ name: input.name, digest: input.digest }],
      },
      brief: workerBrief(input, verification),
      workspaceId: workspace.id,
      delivery: 'report',
      dependencies: [],
      idempotencyKey: 'live-native/create-job-v1',
    });

    const attemptId = await execute(client, {
      operation: 'attempt.admit',
      jobId: job.id,
      profile: PROFILE_NAME,
      nativeWorkspaceId: NATIVE_WORKSPACE,
      inputResultIds: [],
      expectedBriefRevision: job.currentBriefRevision,
      idempotencyKey: 'live-native/admit-v1',
    });

    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      fixtureProject: realpathSync(FIXTURE_PROJECT),
      stateHome: resolve(STATE_HOME),
      stateDirectory: context.project.stateDirectory,
      projectId: context.project.id,
      hostId: context.project.hostId,
      workspaceId: workspace.id,
      profileName: PROFILE_NAME,
      profile: { kind: 'claude', model: MODEL, args: ['--model', MODEL] },
      native: {
        socketPath: SOCKET_PATH,
        workspaceId: NATIVE_WORKSPACE,
        binding: nativeRegistration.value,
      },
      jobId: job.id,
      briefRevision: job.currentBriefRevision,
      attemptId,
      requestDigest: sha256(Buffer.from(requestText)),
      input: {
        path: INPUT_PATH,
        artifactId: input.id,
        name: input.name,
        digest: input.digest,
        byteLength: input.byteLength,
        mediaType: input.mediaType,
      },
      verification,
      dist: Object.fromEntries(DIST_FILES.map((path) => [path, fileDigest(path)])),
    };

    // This exclusive, fsynced manifest is the replay fence. Nothing starts before it exists.
    persistManifest(manifest);
    const started = await execute(client, { operation: 'attempt.start', id: attemptId });
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'start',
          manifestPath: MANIFEST_PATH,
          manifestDigest: fileDigest(MANIFEST_PATH),
          jobId: job.id,
          attemptId,
          attemptPhase: started.attempt.phase,
          nativeKind: started.native.kind,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    client.close();
  }
}

async function resultIds(client, attemptId) {
  const response = await execute(client, {
    operation: 'sql.read',
    sql: 'SELECT id FROM public_results WHERE attempt_id = :attemptId ORDER BY created_at, id',
    parameters: { attemptId },
    maxRows: 10,
    maxBytes: 16_384,
  });

  if (response.truncated) fail('Result lookup was unexpectedly truncated');

  return response.rows.map((row) => {
    if (!Predicate.isString(row.id) || row.id.length === 0)
      fail('Result lookup returned an invalid id');

    return row.id;
  });
}

async function observeIfBound(client, attempt) {
  const hasIdentity =
    Predicate.isString(attempt.nativeKind) &&
    Predicate.isString(attempt.nativeServerGeneration) &&
    Predicate.isString(attempt.nativeLocator);

  if (!hasIdentity || attempt.phase === 'settled' || attempt.phase === 'closed') {
    return { kind: hasIdentity ? 'already-settled' : 'identity-not-recorded' };
  }

  return execute(client, { operation: 'attempt.inspect', id: attempt.id });
}

async function status() {
  const manifest = loadManifest();
  await withClient(connectionOptions(manifest), async (client) => {
    const attempt = await execute(client, { operation: 'attempt.get', id: manifest.attemptId });
    const job = await execute(client, { operation: 'job.get', id: manifest.jobId });
    const ids = await resultIds(client, manifest.attemptId);
    const observation = await observeIfBound(client, attempt);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'status',
          manifestPath: MANIFEST_PATH,
          manifestDigest: fileDigest(MANIFEST_PATH),
          currentInputDigest: fileDigest(INPUT_PATH),
          job: { id: job.id, state: job.state, currentBriefRevision: job.currentBriefRevision },
          attempt,
          resultIds: ids,
          observation,
        },
        null,
        2,
      )}\n`,
    );
  });
}

function findCommandEvidence(items, argv) {
  return items.find(
    (item) =>
      item.kind === 'command' &&
      item.exitCode === 0 &&
      JSON.stringify(item.argv) === JSON.stringify(argv),
  );
}

function artifactBytes(manifest, digest) {
  if (!Predicate.isString(digest) || !/^[a-f0-9]{64}$/.test(digest)) {
    fail('Result contains an invalid artifact digest');
  }

  const path = join(
    manifest.stateDirectory,
    'artifacts',
    'sha256',
    digest.slice(0, 2),
    digest.slice(2),
  );

  const metadata = statSync(path);

  if (!metadata.isFile()) fail(`Reported artifact is not a regular file: ${digest}`);
  const bytes = readFileSync(path);

  if (sha256(bytes) !== digest) fail(`Reported artifact bytes changed: ${digest}`);

  return bytes;
}

function validateResult(manifest, job, result) {
  const currentDigest = fileDigest(manifest.input.path);

  if (currentDigest !== manifest.input.digest) fail('Pinned source bytes changed after start');

  if (result.jobId !== manifest.jobId || result.attemptId !== manifest.attemptId) {
    fail('Result identity does not match the manifest');
  }

  if (
    result.briefRevision !== manifest.briefRevision ||
    job.currentBriefRevision !== manifest.briefRevision
  ) {
    fail('Result does not match the current brief revision');
  }

  if (
    result.inputDigest !== manifest.input.digest ||
    result.workspaceDigest !== manifest.input.digest
  ) {
    fail('Result digest fields do not match the immutable input snapshot');
  }

  if (result.content.kind !== 'report') fail('Live-native result must be a report');

  if (!result.content.body.includes(manifest.verification.marker)) {
    fail('Report body does not contain the required digest marker');
  }

  if (!result.content.body.includes(manifest.input.path)) {
    fail('Report body does not identify the pinned input path');
  }

  if (!result.content.artifactDigests.includes(manifest.input.digest)) {
    fail('Report does not retain the immutable input snapshot artifact');
  }

  const inputArtifactBytes = artifactBytes(manifest, manifest.input.digest);

  if (inputArtifactBytes.byteLength !== manifest.input.byteLength) {
    fail('Immutable input snapshot byte length changed');
  }

  const fileEvidence = result.evidence.find(
    (item) =>
      item.kind === 'file' &&
      item.path === manifest.input.path &&
      item.digest === manifest.input.digest,
  );

  if (!fileEvidence) fail('Result lacks exact file evidence for the pinned input');
  const commandEvidence = findCommandEvidence(result.evidence, manifest.verification.argv);

  if (!commandEvidence) fail('Result lacks the exact successful file-check command evidence');

  if (!result.content.artifactDigests.includes(commandEvidence.log)) {
    fail('Report does not retain the verification log artifact');
  }

  if (result.verification.kind !== 'passed') fail('Result verification did not pass');

  const verificationEvidence = findCommandEvidence(
    result.verification.checks,
    manifest.verification.argv,
  );

  if (!verificationEvidence || verificationEvidence.log !== commandEvidence.log) {
    fail('Passed verification does not reference the exact command log');
  }

  const reportedDigests = new Set(result.content.artifactDigests);

  for (const item of result.evidence) {
    if (item.kind === 'file') reportedDigests.add(item.digest);

    if (item.kind === 'command') reportedDigests.add(item.log);
  }

  for (const item of result.verification.checks) {
    if (item.kind === 'file') reportedDigests.add(item.digest);

    if (item.kind === 'command') reportedDigests.add(item.log);
  }

  for (const digest of reportedDigests) artifactBytes(manifest, digest);

  if (
    !artifactBytes(manifest, commandEvidence.log)
      .toString('utf8')
      .includes(manifest.verification.marker)
  ) {
    fail('Verification log artifact does not contain the required digest marker');
  }

  if (
    !result.evidenceClaims.includes('pinned-input-sha256') ||
    !result.evidenceClaims.includes('read-only-report')
  ) {
    fail('Result lacks the required evidence claims');
  }

  const [command, ...args] = manifest.verification.argv;
  const checked = spawnSync(command, args, { encoding: 'utf8' });

  if (checked.status !== 0 || !checked.stdout.includes(manifest.verification.marker)) {
    fail(`Independent pinned-file check failed: ${checked.stderr || checked.stdout}`);
  }
}

async function accept() {
  const manifest = loadManifest();
  await withClient(connectionOptions(manifest), async (client) => {
    const job = await execute(client, { operation: 'job.get', id: manifest.jobId });
    const ids = await resultIds(client, manifest.attemptId);

    if (ids.length !== 1) fail(`Expected exactly one result for the attempt; found ${ids.length}`);
    const result = await execute(client, { operation: 'result.get', id: ids[0] });
    validateResult(manifest, job, result);

    let attempt = await execute(client, { operation: 'attempt.get', id: manifest.attemptId });

    if (
      attempt.nativeKind !== manifest.profile.kind ||
      attempt.nativeServerGeneration !== manifest.native.binding.endpoint.serverStartToken ||
      !Predicate.isString(attempt.nativeLocator)
    ) {
      fail('Attempt does not retain the exact observed native identity');
    }

    if (attempt.phase !== 'settled' && attempt.phase !== 'closed') {
      const inspected = await execute(client, { operation: 'attempt.inspect', id: attempt.id });

      if (inspected.native.kind !== 'settled') {
        fail(`Native identity is ${inspected.native.kind}; wait and use status before acceptance`);
      }

      const reconciled = await execute(client, { operation: 'attempt.reconcile', id: attempt.id });
      attempt = reconciled.attempt;
    }

    if (attempt.phase !== 'settled' && attempt.phase !== 'closed') {
      fail(`Attempt is ${attempt.phase} after reconciliation`);
    }

    const decision = await execute(client, {
      operation: 'result.decide',
      resultId: result.id,
      expectedBriefRevision: job.currentBriefRevision,
      decision: { kind: 'accepted' },
      idempotencyKey: 'live-native/accept-result-v1',
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'accept',
          verdict: 'VERIFIED',
          manifestPath: MANIFEST_PATH,
          manifestDigest: fileDigest(MANIFEST_PATH),
          resultId: result.id,
          attemptPhase: attempt.phase,
          decision,
          inputDigest: manifest.input.digest,
        },
        null,
        2,
      )}\n`,
    );
  });
}

async function main() {
  const mode = process.argv[2];

  if (process.argv.length !== 3 || !['start', 'status', 'accept'].includes(mode)) {
    process.stderr.write('Usage: node effect-port/scripts/live-native.mjs start|status|accept\n');
    process.exitCode = 2;

    return;
  }

  if (process.env.MARIONETTE_CONTEXT) {
    fail('Unset MARIONETTE_CONTEXT before using the isolated live-native fixture');
  }

  if (mode === 'start') await start();
  else if (mode === 'status') await status();
  else await accept();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
