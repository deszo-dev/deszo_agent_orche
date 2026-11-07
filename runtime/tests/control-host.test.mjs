import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBytes, canonicalHash } from '../core/canonical.mjs';
import { ControlHost, HostError } from '../host/authority.mjs';
import { manualTimeSource, remainingAuthority } from '../host/timeSource.mjs';
import { ApplicationLifecycle, createBuildManifest } from '../host/lifecycle.mjs';
import { ownedDir } from './test-roots.mjs';

const HOUR = 3_600_000;
const SNAPSHOT = 'a'.repeat(64);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}
const signValue = (privateKey, value) => sign(null, canonicalBytes(value), privateKey).toString('base64');

function scope(overrides = {}) {
  return {
    dataProfile: 'pilot', workspaces: [{ workspaceId: 'ws-1', cwdIdentity: 'b'.repeat(64) }],
    workflows: [{ workflowId: 'wf-1', baselineSha256: SNAPSHOT, permittedRevisions: [] }],
    operations: ['run.approve', 'supervision.approve', 'run.stop_and_report', 'check.run', 'build.run', 'app.restart', 'worker.model_call'],
    commands: [{ commandId: 'tests', command: 'npm', args: ['test'], cwdRelative: '.', timeoutMs: 600000 }],
    desktop: { user: 'pilot-user', sessionId: 1 }, buildRoot: tmpdir(), applicationMode: 'controlling_switch', deliveryBoundary: 'verified_branch',
    ...overrides,
  };
}
const LIMITS = { attempts: 3, providerInvocations: 3, workerModelCalls: 5, operations: 20, restarts: 2, repairs: 1, builds: 2 };

function setup({ time = manualTimeSource(), root = ownedDir(join(tmpdir(), 'deszo-host-')), limits = LIMITS, onStop = null } = {}) {
  const host = new ControlHost({ root, time, onStop });
  const authenticator = keyPair();
  const controllerKeys = keyPair();
  host.enrollCredential({ credentialId: 'hello-1', publicKey: authenticator.publicKey, label: 'test authenticator' }, { enrolledBy: 'test installation' });
  const controller = { controllerId: 'worker-1', publicKey: controllerKeys.publicKey };
  return { host, time, root, authenticator, controllerKeys, controller, limits };
}

function assertionFor(ctx, challenge, { flags = { userPresent: true, userVerified: true }, digest = challenge.decisionDigest, key = ctx.authenticator.privateKey, credentialId = 'hello-1' } = {}) {
  const clientData = { type: 'deszo.autonomy.consent', challengeId: challenge.challengeId, nonce: challenge.nonce, decisionDigest: digest, audience: challenge.audience };
  return { credentialId, clientData, flags, signature: signValue(key, { clientData, flags }) };
}

function authorize(ctx, input = {}) {
  const challenge = ctx.host.proposePolicy({ controller: ctx.controller, scope: scope(), limits: ctx.limits, durationMs: 12 * HOUR, ...input });
  return { challenge, receipt: ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge) }) };
}

function connect(ctx, policyId) {
  const challenge = ctx.host.controllerChallenge(policyId, 'worker-1');
  const signed = { type: 'deszo.controller.auth', nonce: challenge.nonce, audience: challenge.audience, policyId, controllerId: 'worker-1' };
  return ctx.host.authenticateController({ nonce: challenge.nonce, signature: signValue(ctx.controllerKeys.privateKey, signed) }).connectionId;
}

function initialRuntime(ctx, policyId, connectionId) {
  return ctx.host.registerInitialRuntime({ policyId, connectionId, processEvidence: { pid: 100, creationTime: '2026-10-20T09:00:00.000Z', imageSha256: 'c'.repeat(64) } }).runtimeGeneration;
}

const runRequest = (policyId, runtimeGeneration, overrides = {}) => ({ requestId: randomUUID(), policyId, operation: 'run.approve', workspaceId: 'ws-1', workflowId: 'wf-1',
  workflowSnapshotSha256: SNAPSHOT, runtimeGeneration, cost: { attempts: 1, providerInvocations: 1 }, ...overrides });

test('ADR6-01: policy creation needs a decision-bound, user-verified assertion from an enrolled credential', () => {
  const ctx = setup();
  const challenge = ctx.host.proposePolicy({ controller: ctx.controller, scope: scope(), limits: LIMITS, durationMs: 12 * HOUR });
  const refused = code => error => error instanceof HostError && error.code === code;
  // A self-generated key is not an enrolled credential.
  const intruder = keyPair();
  assert.throws(() => ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge, { key: intruder.privateKey, credentialId: 'self-made' }) }), refused('untrusted_credential'));
  // Right credential, wrong key (forged signature).
  assert.throws(() => ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge, { key: intruder.privateKey }) }), refused('bad_signature'));
  // No user verification: an ordinary click or synthetic presence is not enough.
  assert.throws(() => ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge, { flags: { userPresent: true, userVerified: false } }) }), refused('user_not_verified'));
  // A signature over a substituted decision (wider scope, longer expiry) is refused.
  const substituted = canonicalHash({ ...challenge.decision, durationMs: 24 * HOUR });
  assert.throws(() => ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge, { digest: substituted }) }), refused('decision_substituted'));
  assert.equal(ctx.host.all('SELECT * FROM policies').length, 0, 'A refused assertion created a policy.');

  const good = assertionFor(ctx, challenge);
  const receipt = ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: good });
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.expiresAt, challenge.decision.expiresAt);
  // A lost reply is reconciled to the same receipt; it never creates a second policy.
  const replay = ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: good });
  assert.equal(replay.replayed, true);
  assert.equal(replay.policyId, receipt.policyId);
  assert.equal(ctx.host.all('SELECT * FROM policies').length, 1);
  ctx.host.close();
});

test('ADR6-01: an expired challenge and an untrusted enrollment cannot authorize a policy', () => {
  const ctx = setup();
  const challenge = ctx.host.proposePolicy({ controller: ctx.controller, scope: scope(), limits: LIMITS, durationMs: 12 * HOUR });
  ctx.time.advance(6 * 60 * 1000);
  assert.throws(() => ctx.host.authorizePolicy({ challengeId: challenge.challengeId, assertion: assertionFor(ctx, challenge) }), /expired/);
  assert.throws(() => ctx.host.enrollCredential({ credentialId: 'x', publicKey: keyPair().publicKey, label: 'x' }, {}), /installation/);
  ctx.host.close();
});

test('ADR6-01: an eligible run approval needs no repeated consent, while out-of-scope requests are refused or wait', () => {
  const ctx = setup();
  const { receipt } = authorize(ctx);
  const connectionId = connect(ctx, receipt.policyId);
  const generation = initialRuntime(ctx, receipt.policyId, connectionId);
  const approved = ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId });
  assert.equal(approved.outcome, 'approved');
  assert.ok(approved.permitId);
  assert.equal(ctx.host.decide(runRequest(receipt.policyId, generation, { workspaceId: 'ws-other' }), { connectionId }).reason, 'workspace_not_authorized');
  assert.equal(ctx.host.decide(runRequest(receipt.policyId, generation, { operation: 'app.rollback' }), { connectionId }).reason, 'operation_not_authorized');
  const revision = ctx.host.decide(runRequest(receipt.policyId, generation, { workflowSnapshotSha256: 'f'.repeat(64) }), { connectionId });
  assert.equal(revision.outcome, 'pending');
  assert.match(revision.reason, /workflow_revision_not_authorized/);
  assert.equal(ctx.host.decide(runRequest(receipt.policyId, 'stale-generation'), { connectionId }).reason, 'runtime_not_registered');
  assert.throws(() => ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId: 'forged' }), /controller_not_authenticated|authenticated controller/);
  ctx.host.close();
});

test('ADR6-13: shared limits bound every linked operation; a declared cost below the minimum is raised', () => {
  const ctx = setup();
  const { receipt } = authorize(ctx);
  const connectionId = connect(ctx, receipt.policyId);
  const generation = initialRuntime(ctx, receipt.policyId, connectionId);
  for (let i = 0; i < 3; i++) assert.equal(ctx.host.decide(runRequest(receipt.policyId, generation, { cost: {} }), { connectionId }).outcome, 'approved');
  const fourth = ctx.host.decide(runRequest(receipt.policyId, generation, { cost: {} }), { connectionId });
  assert.equal(fourth.outcome, 'denied');
  assert.match(fourth.reason, /budget_exhausted: attempts/);
  for (let i = 0; i < 5; i++) ctx.host.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'worker.model_call', cost: {} }, { connectionId });
  assert.match(ctx.host.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'worker.model_call', cost: {} }, { connectionId }).reason, /workerModelCalls/);
  ctx.host.close();
});

test('ADR6-02/03: same-boot host restart keeps expiry and counters, invalidates live connections, and needs fresh authentication', () => {
  const time = manualTimeSource();
  const ctx = setup({ time });
  const { receipt } = authorize(ctx);
  let connectionId = connect(ctx, receipt.policyId);
  const generation = initialRuntime(ctx, receipt.policyId, connectionId);
  const first = ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId });
  ctx.host.admit(first.permitId);
  const pending = ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId });
  time.advance(3 * HOUR);
  ctx.host.close();

  const restarted = new ControlHost({ root: ctx.root, time });
  const status = restarted.status(receipt.policyId);
  assert.equal(status.valid, true);
  assert.equal(status.expiresAt, receipt.expiresAt, 'A restart reset the original expiry.');
  assert.ok(Math.abs(status.remainingMs - 9 * HOUR) < 1000);
  // The admitted permit's effect is unknown: still charged. The never-admitted permit is invalidated and released.
  assert.equal(status.used.attempts, 1);
  assert.equal(restarted.admit(pending.permitId).admitted, false);
  // Old connection and runtime generation are gone.
  assert.throws(() => restarted.decide(runRequest(receipt.policyId, generation), { connectionId }), /authenticated controller/);
  connectionId = connect({ ...ctx, host: restarted }, receipt.policyId);
  assert.equal(restarted.decide(runRequest(receipt.policyId, generation), { connectionId }).reason, 'runtime_not_registered');
  restarted.close();
});

test('ADR6-04: sleep consumes lifetime, a clock rollback cannot extend it, and a reboot blocks the old policy', () => {
  const time = manualTimeSource();
  const ctx = setup({ time });
  const { receipt } = authorize(ctx);
  const policy = () => ctx.host.policyRow(receipt.policyId);
  time.sleep(5 * HOUR);
  assert.ok(Math.abs(remainingAuthority(policy(), time).remainingMs - 7 * HOUR) < 1000, 'Sleep did not consume lifetime.');
  time.setWall(time.state.wallMs - 10 * HOUR);
  assert.ok(remainingAuthority(policy(), time).remainingMs <= 7 * HOUR, 'A clock rollback extended authority.');
  time.advance(7 * HOUR + 1);
  assert.equal(remainingAuthority(policy(), time).reason, 'expired');

  const ctx2 = setup({ time: manualTimeSource() });
  const second = authorize(ctx2).receipt;
  ctx2.time.reboot('test-boot:2');
  assert.equal(ctx2.host.status(second.policyId).reason, 'reboot_requires_fresh_consent');
  const connectionId = connect(ctx2, second.policyId);
  assert.equal(ctx2.host.decide({ requestId: randomUUID(), policyId: second.policyId, operation: 'worker.model_call', cost: {} }, { connectionId }).reason, 'reboot_requires_fresh_consent');
  ctx.host.close();
  ctx2.host.close();
});

test('ADR6-04: post-reboot authorization is a new linked decision that carries consumed budgets forward', () => {
  const time = manualTimeSource();
  const ctx = setup({ time });
  const { receipt } = authorize(ctx);
  const connectionId = connect(ctx, receipt.policyId);
  for (let i = 0; i < 2; i++) {
    const r = ctx.host.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'worker.model_call', cost: {} }, { connectionId });
    ctx.host.admit(r.permitId);
    ctx.host.settle(r.permitId, { effect: 'consumed' });
  }
  time.reboot('test-boot:2');
  const next = ctx.host.proposePolicy({ decisionType: 'post_reboot', supersedesPolicyId: receipt.policyId, controller: ctx.controller, scope: scope(), limits: LIMITS, durationMs: 4 * HOUR });
  assert.equal(next.decision.carriedUsage.workerModelCalls, 2, 'The new decision does not display consumed budgets.');
  assert.equal(next.decision.sessionId, receipt.sessionId);
  const linked = ctx.host.authorizePolicy({ challengeId: next.challengeId, assertion: assertionFor(ctx, next) });
  assert.equal(linked.revision, 2);
  assert.equal(ctx.host.policyRow(receipt.policyId).expires_at, receipt.expiresAt, 'The original period was rewritten.');
  assert.equal(ctx.host.status(linked.policyId).used.workerModelCalls, 2, 'Fresh consent reset consumed budgets.');
  ctx.host.close();
});

test('ADR6-04: revocation fences admission, returns unadmitted reservations and reports admitted work for Stop', () => {
  const stopped = [];
  const ctx = setup({ onStop: permits => stopped.push(...permits) });
  const { receipt } = authorize(ctx);
  const connectionId = connect(ctx, receipt.policyId);
  const generation = initialRuntime(ctx, receipt.policyId, connectionId);
  const running = ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId });
  assert.equal(ctx.host.admit(running.permitId).admitted, true);
  const waiting = ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId });
  const result = ctx.host.revoke(receipt.policyId, { actor: 'user via host status surface' });
  assert.equal(result.committed, true);
  assert.deepEqual(result.stopScope, [running.permitId]);
  assert.deepEqual(stopped, [running.permitId]);
  assert.equal(ctx.host.admit(waiting.permitId).admitted, false);
  assert.equal(ctx.host.status(receipt.policyId).used.attempts, 1, 'The unadmitted reservation was not returned.');
  assert.throws(() => ctx.host.decide(runRequest(receipt.policyId, generation), { connectionId }), /authenticated controller/);
  // Revocation is durable across a restart.
  ctx.host.close();
  const restarted = new ControlHost({ root: ctx.root, time: ctx.time });
  assert.equal(restarted.status(receipt.policyId).state, 'revoked');
  assert.throws(() => restarted.proposePolicy({ decisionType: 'extend', supersedesPolicyId: receipt.policyId, controller: ctx.controller, scope: scope(), limits: LIMITS, durationMs: HOUR }), /revoked/);
  restarted.close();
});

test('ADR6-10: a host restart during an operation leaves it reconciling and blocks new dispatch until resolved with evidence', () => {
  const ctx = setup();
  const { receipt } = authorize(ctx);
  const connectionId = connect(ctx, receipt.policyId);
  const build = ctx.host.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'build.run', commandId: 'tests', cost: {} }, { connectionId });
  ctx.host.admit(build.permitId);
  const { operationId } = ctx.host.beginOperation({ permitId: build.permitId, kind: 'build.run', intent: { commandId: 'tests' } });
  ctx.host.close();
  const restarted = new ControlHost({ root: ctx.root, time: ctx.time });
  assert.equal(restarted.operationRow(operationId).outcome, 'reconciling');
  const freshConnection = connect({ ...ctx, host: restarted }, receipt.policyId);
  const blocked = restarted.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'worker.model_call', cost: {} }, { connectionId: freshConnection });
  assert.equal(blocked.outcome, 'pending');
  assert.match(blocked.reason, /host_reconciling/);
  // Stop-and-report stays available while dispatch is blocked.
  assert.equal(restarted.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'run.stop_and_report', cost: {} }, { connectionId: freshConnection }).outcome, 'approved');
  assert.equal(restarted.status(receipt.policyId).used.builds, 1, 'An unknown effect became a free retry.');
  restarted.reconcileOperation(operationId, { outcome: 'interrupted', reason: 'build process not found after restart', evidence: { processes: [] } });
  assert.equal(restarted.decide({ requestId: randomUUID(), policyId: receipt.policyId, operation: 'worker.model_call', cost: {} }, { connectionId: freshConnection }).outcome, 'approved');
  assert.equal(restarted.verifyAudit().intact, true);
  restarted.close();
});

test('ADR6-14: the host audit chain detects altered history', () => {
  const ctx = setup();
  authorize(ctx);
  ctx.host.run(`UPDATE audit_events SET payload_json = '{"tampered":true}' WHERE sequence = 2`);
  assert.deepEqual(ctx.host.verifyAudit(), { intact: false, brokenAt: 2 });
  ctx.host.close();
  const restarted = new ControlHost({ root: ctx.root, time: ctx.time });
  assert.match(restarted.dispatchBlocked, /audit chain broken/);
  restarted.close();
});

function buildFixture() {
  const dir = ownedDir(join(tmpdir(), 'deszo-build-'));
  mkdirSync(join(dir, 'runtime'));
  writeFileSync(join(dir, 'deszo.exe'), 'NEW BUILD');
  writeFileSync(join(dir, 'runtime', 'runner.mjs'), 'runner');
  const manifest = createBuildManifest({ buildDir: dir, buildId: 'build-2', sourceCommit: 'd'.repeat(40), inputsDigest: 'e'.repeat(64), protocolVersion: 2, storeSchemaVersion: 11, launchEntry: 'deszo.exe', createdAt: '2026-10-20T10:00:00.000Z' });
  return { dir, manifest };
}

function fakeNative(ctx, { reportedImage = null, stopFails = false, register = true } = {}) {
  const processes = new Map([[100, { pid: 100, creationTime: 'old', imagePath: 'C:/old/deszo.exe', imageSha256: 'old', sessionId: 1 }]]);
  let nextPid = 200;
  const inspector = {
    isRunning: async proc => processes.has(proc.pid),
    describe: async pid => processes.get(pid) ?? null,
  };
  const launcher = {
    stop: async proc => { if (!stopFails) processes.delete(proc.pid); },
    start: async ({ operationId, launchPath, registrationNonce }) => {
      const pid = nextPid++;
      const { createHash } = await import('node:crypto');
      const { readFileSync } = await import('node:fs');
      const proc = { pid, creationTime: `t-${pid}`, imagePath: launchPath, sessionId: 1, imageSha256: reportedImage ?? createHash('sha256').update(readFileSync(launchPath)).digest('hex') };
      processes.set(pid, proc);
      // The new runtime registers itself against the operation, as the real runtime would over IPC.
      if (register) setTimeout(() => { try { ctx.host.registerRuntime({ policyId: ctx.policyId, operationId, processEvidence: proc, registrationNonce }); } catch { /* refused registrations are asserted by the caller */ } }, 10);
      return { pid };
    },
  };
  return { inspector, launcher, processes };
}

// The controlling runtime at session start is the process the host already governs; a switch may stop only that process.
function adoptControllingRuntime(ctx, policyId, connectionId) {
  return ctx.host.registerInitialRuntime({ policyId, connectionId, processEvidence: { pid: 100, creationTime: 'old', imagePath: 'C:/old/deszo.exe', imageSha256: 'old', sessionId: 1 } });
}

test('ADR6-08: an authorized restart launches the exact build and binds a new runtime generation to the observed process', async () => {
  const ctx = setup();
  const { receipt } = authorize(ctx);
  ctx.policyId = receipt.policyId;
  const connectionId = connect(ctx, receipt.policyId);
  adoptControllingRuntime(ctx, receipt.policyId, connectionId);
  const { dir, manifest } = buildFixture();
  const native = fakeNative(ctx);
  const lifecycle = new ApplicationLifecycle({ host: ctx.host, ...native, healthCheck: async () => ({ ok: true, buildId: 'build-2', protocolVersion: 2, storeSchemaVersion: 11 }), uiCheck: async ({ runtimeGeneration, process }) => ({ available: true, pid: process.pid, runtimeGeneration }) });
  const result = await lifecycle.restart({ connectionId, policyId: receipt.policyId, requestId: randomUUID(), buildDir: dir, manifest, profile: 'pilot', applicationMode: 'controlling_switch', desktop: { user: 'pilot-user', sessionId: 1 }, buildRoot: tmpdir(), currentProcess: { pid: 100, creationTime: 'old' }, rationale: 'controlling switch for the pilot task', requireUi: true, startupDeadlineMs: 2000 });
  assert.equal(result.outcome, 'verified', result.reason);
  assert.equal(native.processes.has(100), false);
  assert.ok(ctx.host.runtimeRegistrations.has(result.runtimeGeneration));
  assert.equal(ctx.host.status(receipt.policyId).used.restarts, 1);
  ctx.host.close();
});

test('ADR6-08/11: unconfirmed termination, a changed build and a mismatched process image all block the switch', async () => {
  for (const [label, options, mutate, reason] of [
    ['unconfirmed termination', { stopFails: true }, null, 'unconfirmed_termination'],
    ['changed build file', {}, dir => writeFileSync(join(dir, 'runtime', 'runner.mjs'), 'tampered'), 'unverified_build_identity'],
    ['different process image', { reportedImage: '0'.repeat(64) }, null, 'unverified_build_identity'],
    ['runtime never authenticates', { register: false }, null, 'runtime_not_authenticated'],
  ]) {
    const ctx = setup();
    const { receipt } = authorize(ctx);
    ctx.policyId = receipt.policyId;
    const connectionId = connect(ctx, receipt.policyId);
  adoptControllingRuntime(ctx, receipt.policyId, connectionId);
    const { dir, manifest } = buildFixture();
    if (mutate) mutate(dir);
    const native = fakeNative(ctx, options);
    const lifecycle = new ApplicationLifecycle({ host: ctx.host, ...native, healthCheck: async () => ({ ok: true, buildId: 'build-2', protocolVersion: 2, storeSchemaVersion: 11 }) });
    const result = await lifecycle.restart({ connectionId, policyId: receipt.policyId, requestId: randomUUID(), buildDir: dir, manifest, profile: 'pilot', applicationMode: 'controlling_switch', desktop: { user: 'pilot-user', sessionId: 1 }, buildRoot: tmpdir(), currentProcess: { pid: 100, creationTime: 'old' }, rationale: 'switch', startupDeadlineMs: 200 });
    assert.equal(result.outcome, 'blocked', label);
    assert.equal(result.reason, reason, label);
    ctx.host.close();
  }
});

test('ADR6-03: a runtime that is not the process the host launched cannot register', async () => {
  const ctx = setup();
  const { receipt } = authorize(ctx);
  ctx.policyId = receipt.policyId;
  const connectionId = connect(ctx, receipt.policyId);
  adoptControllingRuntime(ctx, receipt.policyId, connectionId);
  const { dir, manifest } = buildFixture();
  const native = fakeNative(ctx, { register: false });
  const lifecycle = new ApplicationLifecycle({ host: ctx.host, ...native, healthCheck: async () => ({ ok: true }) });
  const pending = lifecycle.restart({ connectionId, policyId: receipt.policyId, requestId: randomUUID(), buildDir: dir, manifest, profile: 'pilot', applicationMode: 'controlling_switch', desktop: { user: 'pilot-user', sessionId: 1 }, buildRoot: tmpdir(), currentProcess: null, rationale: 'switch', startupDeadlineMs: 300 });
  await new Promise(done => setTimeout(done, 50));
  const operation = ctx.host.all(`SELECT operation_id FROM operations`)[0];
  assert.throws(() => ctx.host.registerRuntime({ policyId: receipt.policyId, operationId: operation.operation_id, processEvidence: { pid: 999, creationTime: 'reused-pid', imageSha256: manifest.artifacts[0].sha256 }, registrationNonce: 'guess' }), /registration_refused|not the process/);
  // The real process identity without the launch nonce is refused as well.
  const launched = JSON.parse(ctx.host.operationRow(operation.operation_id).evidence_json).launch;
  assert.throws(() => ctx.host.registerRuntime({ policyId: receipt.policyId, operationId: operation.operation_id, processEvidence: launched, registrationNonce: 'f'.repeat(64) }), /not the process/);
  assert.equal((await pending).reason, 'runtime_not_authenticated');
  ctx.host.close();
});
