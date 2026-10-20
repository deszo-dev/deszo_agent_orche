// ADR-0006 regression tests for the independent implementation review (ADR6-I01 to ADR6-I08). Each test replays the
// original counterexample (N01-N09 in docs/reviews/evidence) and asserts the corrected behavior. The review's own probe
// runner and its recorded evidence are not modified by this suite. Fixtures use temporary stores, injected native
// components and fixture-assurance hosts; they establish host logic, not Windows enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from '../core/canonical.mjs';
import { ControlHost, HostError } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { connectHost, startHostServer } from '../host/ipc.mjs';
import { HOST_ENV, hostFromEnvironment } from '../host/runtimeBinding.mjs';
import { ApplicationLifecycle, createBuildManifest } from '../host/lifecycle.mjs';
import { missingProductionCapabilities } from '../host/capabilities.mjs';
import { contextChain, singleAgent, startTestRunner } from './helpers.mjs';

const HOUR = 3_600_000;
const SNAPSHOT = 'a'.repeat(64);
const repo = resolve(import.meta.dirname, '../..');
const keys = () => {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const signed = (key, value) => sign(null, canonicalBytes(value), key).toString('base64');
const pause = ms => new Promise(done => setTimeout(done, ms));
const pipeFor = root => (process.platform === 'win32' ? `\\\\.\\pipe\\deszo-adr6-reg-${randomUUID()}` : join(root, 'host.sock'));

// A writable fixture host with an enrolled authenticator, an authenticated controller and one controlling runtime.
function setup({ scope: scopeOverrides = {}, limits: limitOverrides = {}, durationMs = HOUR, root = mkdtempSync(join(tmpdir(), 'deszo-adr6-reg-')) } = {}) {
  const time = manualTimeSource();
  const host = new ControlHost({ root, time });
  const authenticator = keys();
  const controller = keys();
  host.enrollCredential({ credentialId: 'fixture-credential', publicKey: authenticator.publicKey, label: 'regression fixture only' }, { enrolledBy: 'regression fixture' });
  const scope = {
    dataProfile: 'authorized-profile', workspaces: [{ workspaceId: 'main', cwdIdentity: 'b'.repeat(64) }],
    workflows: [{ workflowId: 'regression-workflow', baselineSha256: SNAPSHOT, permittedRevisions: [] }],
    operations: ['run.approve', 'app.restart', 'build.run', 'worker.model_call', 'run.stop_and_report', 'provider.invoke'],
    commands: [{ commandId: 'checks', command: 'node', args: ['--version'], cwdRelative: '.', timeoutMs: 1000 }],
    desktop: { user: 'fixture-user', sessionId: 1 }, buildRoot: join(root, 'authorized-builds'),
    applicationMode: 'separate_preview', deliveryBoundary: 'candidate', ...scopeOverrides,
  };
  const limits = { attempts: 10, providerInvocations: 10, workerModelCalls: 10, operations: 100, restarts: 10, repairs: 10, builds: 10, ...limitOverrides };
  const proposal = host.proposePolicy({ controller: { controllerId: 'fixture-controller', publicKey: controller.publicKey }, scope, limits, durationMs });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: proposal.challengeId, nonce: proposal.nonce, decisionDigest: proposal.decisionDigest, audience: proposal.audience };
  const flags = { userPresent: true, userVerified: true };
  const { policyId } = host.authorizePolicy({ challengeId: proposal.challengeId, assertion: { credentialId: 'fixture-credential', clientData, flags, signature: signed(authenticator.privateKey, { clientData, flags }) } });
  const challenge = host.controllerChallenge(policyId, 'fixture-controller');
  const { connectionId } = host.authenticateController({ nonce: challenge.nonce, signature: signed(controller.privateKey, { type: 'deszo.controller.auth', nonce: challenge.nonce, audience: challenge.audience, policyId, controllerId: 'fixture-controller' }) });
  const { runtimeGeneration, attachSecret } = host.registerInitialRuntime({ policyId, connectionId, processEvidence: { pid: process.pid, creationTime: 'fixture-start', imageSha256: 'c'.repeat(64), sessionId: 1 } });
  const decide = (overrides = {}) => host.decide({ requestId: randomUUID(), policyId, operation: 'run.approve', workspaceId: 'main', workflowId: scope.workflows[0].workflowId,
    workflowSnapshotSha256: scope.workflows[0].baselineSha256, runtimeGeneration, cost: {}, ...overrides }, { connectionId });
  return { root, time, host, scope, limits, policyId, connectionId, runtimeGeneration, attachSecret, decide };
}

// A host-bound runtime in this process, reached over the real IPC protocol, as the runner binds it.
async function withRuntime(workflow, options, body) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-adr6-runtime-'));
  let api = await startTestRunner({ root });
  await api.workspace();
  const cwdIdentity = api.runner.engine.requireWorkspace('main').cwd_identity;
  const settings = api.runner.engine.currentSettings();
  await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision, settings: { ...settings.settings, externalRunConfirmation: true } });
  const saved = await api.save(workflow);
  await api.close();
  const ctx = setup({ ...options, root, scope: { workspaces: [{ workspaceId: 'main', cwdIdentity }], workflows: [{ workflowId: workflow.workflowId, baselineSha256: saved.snapshotSha256, permittedRevisions: [] }], ...(options?.scope ?? {}) } });
  const pipeName = pipeFor(root);
  const server = await startHostServer({ host: ctx.host, pipeName });
  const oldEnv = Object.fromEntries([...HOST_ENV, 'DESZO_ALLOW_FIXTURE_HOST'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { DESZO_CONTROL_HOST_PIPE: pipeName, DESZO_HOST_POLICY_ID: ctx.policyId, DESZO_HOST_RUNTIME_GENERATION: ctx.runtimeGeneration, DESZO_HOST_ATTACH_SECRET: ctx.attachSecret, DESZO_ALLOW_FIXTURE_HOST: '1' });
  api = null;
  try {
    api = await startTestRunner({ root });
    const runBody = permitId => ({ workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID(), hostPermitId: permitId });
    return await body({ ...ctx, api, saved, runBody });
  } finally {
    if (api) await api.close();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(done => server.close(done));
    ctx.host.close();
  }
}

// Native fixture: a launcher that records every effect, an inspector the host reads, and a runtime that registers itself.
function buildFixture(ctx, name = 'build-2') {
  const buildDir = join(ctx.scope.buildRoot, name);
  mkdirSync(join(buildDir, 'runtime'), { recursive: true });
  writeFileSync(join(buildDir, 'deszo.exe'), `NEW BUILD ${name}`);
  writeFileSync(join(buildDir, 'runtime', 'runner.mjs'), 'runner');
  const manifest = createBuildManifest({ buildDir, buildId: name, sourceCommit: 'd'.repeat(40), inputsDigest: 'e'.repeat(64), protocolVersion: 2, storeSchemaVersion: 11, launchEntry: 'deszo.exe', createdAt: new Date().toISOString() });
  return { buildDir, manifest };
}

function nativeFixture(ctx, { stopThrows = false, stopHangs = false, registers = true } = {}) {
  const processes = new Map([[100, { pid: 100, creationTime: 'controller-100', imagePath: join(ctx.root, 'old.exe'), sessionId: 1 }]]);
  const calls = { stop: [], start: [], nonces: [], registrationErrors: [] };
  let nextPid = 200;
  const inspector = { describe: async pid => processes.get(pid) ?? null, isRunning: async proc => processes.has(proc.pid) };
  const launcher = {
    stop: async proc => {
      if (stopHangs) return new Promise(() => {});
      if (stopThrows) throw new Error('fixture: the stop reply was lost');
      calls.stop.push(proc.pid);
      processes.delete(proc.pid);
    },
    start: async ({ operationId, launchPath, registrationNonce }) => {
      calls.start.push(launchPath);
      calls.nonces.push(registrationNonce);
      const pid = nextPid++;
      const { createHash } = await import('node:crypto');
      const proc = { pid, creationTime: `launch-${pid}`, imagePath: launchPath, sessionId: 1, imageSha256: createHash('sha256').update(readFileSync(launchPath)).digest('hex') };
      processes.set(pid, proc);
      if (registers) setTimeout(() => {
        try { ctx.host.registerRuntime({ policyId: ctx.policyId, operationId, processEvidence: proc, registrationNonce }); }
        catch (error) { calls.registrationErrors.push(error.code); }
      }, 5);
      return { pid };
    },
  };
  const lifecycle = new ApplicationLifecycle({ host: ctx.host, launcher, inspector, pollMs: 5, phaseTimeoutMs: 2000,
    healthCheck: async () => ({ ok: true, buildId: 'build-2', protocolVersion: 2, storeSchemaVersion: 11 }) });
  return { processes, calls, lifecycle };
}

const restartInput = (ctx, build, overrides = {}) => ({ connectionId: ctx.connectionId, policyId: ctx.policyId, requestId: randomUUID(), buildRoot: ctx.scope.buildRoot,
  buildDir: build.buildDir, manifest: build.manifest, profile: ctx.scope.dataProfile, applicationMode: ctx.scope.applicationMode, desktop: ctx.scope.desktop,
  currentProcess: null, rationale: 'regression fixture', startupDeadlineMs: 1000, ...overrides });

// ---------- ADR6-I01: settlement is not ownership ----------

test('ADR6-I01 (N02): revoking a policy stops a running run whose permit was already settled for accounting', () => withRuntime(singleAgent({ id: 'reg-revoke', context: null, model: 'fixture-slow-2' }), {}, async ctx => {
  const permit = ctx.decide();
  assert.equal(permit.outcome, 'approved');
  const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
  assert.equal(created.body.outcome, 'created', JSON.stringify(created));
  const runId = created.body.run.runId;
  await ctx.api.waitFor(runId, (_, snapshot) => snapshot.instances.some(i => i.nodeId === 'agent' && i.state === 'running'));
  assert.equal(ctx.host.permitView(permit.permitId).state, 'settled', 'The permit is settled for accounting while its run is active.');
  const revocation = ctx.host.revoke(ctx.policyId, { actor: 'regression test', connectionId: ctx.connectionId });
  assert.ok(revocation.stopWorks.some(work => work.workRef === runId), 'The owned run is in the Stop scope.');
  const after = await ctx.api.waitFor(runId);
  assert.notEqual(after.run.state, 'succeeded', 'A revoked run must not complete successfully.');
  assert.ok(['canceled', 'stopping', 'failed', 'interrupted'].includes(after.run.state), `unexpected terminal state ${after.run.state}`);
}));

test('ADR6-I01 (N08): host-side expiry closes the policy and stops its owned run, which does not succeed afterwards', () => withRuntime(singleAgent({ id: 'reg-expiry', context: null, model: 'fixture-slow-2' }), { durationMs: 60000 }, async ctx => {
  const permit = ctx.decide();
  const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
  assert.equal(created.body.outcome, 'created', JSON.stringify(created));
  const runId = created.body.run.runId;
  await ctx.api.waitFor(runId, (_, snapshot) => snapshot.instances.some(i => i.nodeId === 'agent' && i.state === 'running'));
  ctx.time.advance(60001);
  const closed = ctx.host.enforceExpiry();
  assert.deepEqual(closed.closed.map(c => c.policyId), [ctx.policyId]);
  assert.equal(ctx.host.status(ctx.policyId).valid, false);
  await pause(50);
  const after = await ctx.api.waitFor(runId);
  assert.notEqual(after.run.state, 'succeeded');
  // Expiry is closed once: a second enforcement pass reports nothing new.
  assert.deepEqual(ctx.host.enforceExpiry().closed, []);
}));

test('ADR6-I01: owned work survives a host restart as active and blocks dispatch until native reconciliation', () => {
  const ctx = setup();
  const permit = ctx.decide();
  const admitted = ctx.host.admit(permit.permitId);
  assert.equal(admitted.admitted, true);
  ctx.host.settle(permit.permitId, { effect: 'consumed', evidence: 'run created', workRef: 'run-owned-1' });
  ctx.host.close();
  const restarted = new ControlHost({ root: ctx.root, time: ctx.time });
  try {
    assert.match(restarted.dispatchBlocked, /owned work item\(s\) from a previous host instance/);
    const revoked = restarted.revoke(ctx.policyId, { actor: 'after restart' });
    assert.ok(revoked.stopWorks.some(work => work.workRef === 'run-owned-1'), 'Owned work from the previous instance stays in Stop scope.');
    assert.throws(() => restarted.releaseWork(permit.permitId, 'run-owned-1', { evidence: { terminalState: 'canceled' } }), /previous host instance|orphaned/);
    restarted.reconcileOrphanedWork('run-owned-1', { evidence: { nativeObservation: 'fixture: process tree ended' } });
    assert.equal(restarted.dispatchBlocked, null);
  } finally { restarted.close(); }
});

// ---------- ADR6-I02: connections are authenticated, not identified ----------

test('ADR6-I02 (N01): an unauthenticated peer with the policy and generation IDs cannot attach, admit or settle', async () => {
  const ctx = setup();
  const permit = ctx.decide();
  assert.equal(permit.outcome, 'approved');
  const pipeName = pipeFor(ctx.root);
  const server = await startHostServer({ host: ctx.host, pipeName });
  const stranger = connectHost(pipeName);
  try {
    await assert.rejects(stranger.call('runtime.attach', { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration }), err => err.code === 'registration_refused');
    await assert.rejects(stranger.call('runtime.attach', { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration, attachSecret: 'f'.repeat(64) }), err => err.code === 'registration_refused');
    await assert.rejects(stranger.call('admit', { permitId: permit.permitId }), err => err.code === 'not_a_party');
    assert.equal(ctx.host.permitView(permit.permitId).state, 'issued', 'Nothing was admitted for the stranger.');
  } finally { stranger.close(); await new Promise(done => server.close(done)); ctx.host.close(); }
});

test('ADR6-I02: the attach secret, not the generation, re-binds a runtime, and only for a live policy', async () => {
  const ctx = setup();
  const pipeName = pipeFor(ctx.root);
  const server = await startHostServer({ host: ctx.host, pipeName });
  const runtime = connectHost(pipeName);
  try {
    const attached = await runtime.call('runtime.attach', { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration, attachSecret: ctx.attachSecret });
    assert.equal(attached.attached, true);
    const permit = ctx.decide();
    assert.equal((await runtime.call('admit', { permitId: permit.permitId })).admitted, true, 'The live generation may admit its own permit.');
    ctx.host.revoke(ctx.policyId, { actor: 'regression test', connectionId: ctx.connectionId });
    await assert.rejects(runtime.call('runtime.attach', { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration, attachSecret: ctx.attachSecret }), err => err.code === 'policy_not_active');
  } finally { runtime.close(); await new Promise(done => server.close(done)); ctx.host.close(); }
});

test('ADR6-I02: a runtime connection may request provider charges only for its own live generation', () => {
  const ctx = setup();
  const request = { requestId: randomUUID(), policyId: ctx.policyId, operation: 'provider.invoke', workspaceId: 'main', workflowId: ctx.scope.workflows[0].workflowId,
    workflowSnapshotSha256: SNAPSHOT, runtimeGeneration: ctx.runtimeGeneration, cost: {} };
  try {
    // A generation the host never registered, named by a connection that owns another generation, is refused.
    assert.throws(() => ctx.host.decide({ ...request, runtimeGeneration: randomUUID() }, { runtime: { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration } }),
      err => err.code === 'not_a_party');
    // A connection with no runtime binding cannot request a provider charge at all.
    assert.throws(() => ctx.host.decide(request, { connectionId: null, runtime: null }), err => err.code === 'controller_not_authenticated');
  } finally { ctx.host.close(); }
});

// ---------- ADR6-I03: status observes; one owner recovers ----------

test('ADR6-I03 (N03): the status CLI does not recover or change a store another host owns', () => {
  const ctx = setup();
  const issued = ctx.decide();
  const admitted = ctx.decide({ operation: 'build.run', commandId: 'checks' });
  assert.equal(ctx.host.admit(admitted.permitId).admitted, true);
  const { operationId } = ctx.host.beginOperation({ permitId: admitted.permitId, kind: 'build.run', intent: { fixture: 'still active in the original host' } });
  try {
    const before = { issued: ctx.host.permitView(issued.permitId).state, admitted: ctx.host.permitView(admitted.permitId).state, operation: ctx.host.operationRow(operationId).outcome, blocked: ctx.host.dispatchBlocked };
    const command = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'runtime/host/main.mjs'), 'status', '--state', ctx.root, '--policy', ctx.policyId, '--pipe', pipeFor(join(ctx.root, 'none'))],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(command.status, 0, command.stderr);
    const reported = JSON.parse(command.stdout);
    assert.equal(reported.source, 'offline_snapshot');
    assert.equal(ctx.host.permitView(issued.permitId).state, before.issued, 'The issued permit is unchanged by status.');
    assert.equal(ctx.host.permitView(admitted.permitId).state, before.admitted, 'The admitted permit is unchanged by status.');
    assert.equal(ctx.host.operationRow(operationId).outcome, before.operation, 'The in-progress operation is unchanged by status.');
    assert.equal(ctx.host.dispatchBlocked, before.blocked);
  } finally { ctx.host.close(); }
});

test('ADR6-I03: a second authority owner for the same state is refused; a read-only view cannot write', () => {
  const ctx = setup();
  const owner = new ControlHost({ root: ctx.root, time: ctx.time, recover: false });
  try {
    owner.acquireOwnership();
    const rival = new ControlHost({ root: ctx.root, time: ctx.time, recover: false });
    try {
      assert.throws(() => rival.acquireOwnership(), err => err instanceof HostError && err.code === 'owner_running');
    } finally { rival.close(); }
    const view = new ControlHost({ root: ctx.root, readOnly: true });
    try {
      assert.throws(() => view.decide({ requestId: randomUUID(), policyId: ctx.policyId, operation: 'worker.model_call', cost: {} }, { connectionId: ctx.connectionId }), err => err.code === 'read_only_host');
    } finally { view.close(); }
  } finally { owner.close(); ctx.host.close(); }
});

test('ADR6-I03: revoke from the command line refuses when no live owner can stop work', () => {
  const ctx = setup();
  ctx.host.issueUserSurfaceToken();
  ctx.host.close();
  const command = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'runtime/host/main.mjs'), 'revoke', '--state', ctx.root, '--policy', ctx.policyId, '--pipe', pipeFor(join(ctx.root, 'none'))],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /No live Local Control Host owns this state/);
  const reopened = new ControlHost({ root: ctx.root, readOnly: true });
  try { assert.equal(reopened.status(ctx.policyId).state, 'active', 'A refused revoke changes nothing.'); }
  finally { reopened.close(); }
});

// ---------- ADR6-I04: lifecycle authority binds the exact target ----------

test('ADR6-I04 (N04): a restart for an unauthorized profile, build root, mode, desktop or unowned process is refused before any stop or launch', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    const outsideRoot = join(ctx.root, 'outside-root');
    const relocated = join(outsideRoot, 'build-3');
    mkdirSync(relocated, { recursive: true });
    writeFileSync(join(relocated, 'deszo.exe'), 'elsewhere');
    const relocatedManifest = createBuildManifest({ buildDir: relocated, buildId: 'build-3', sourceCommit: 'd'.repeat(40), inputsDigest: 'e'.repeat(64), protocolVersion: 2, storeSchemaVersion: 11, launchEntry: 'deszo.exe', createdAt: new Date().toISOString() });
    const cases = [
      ['unauthorized profile', { profile: 'UNAUTHORIZED-PROFILE' }, 'profile_not_authorized'],
      ['build outside the authorized root', { buildDir: relocated, manifest: relocatedManifest }, 'build_root_not_authorized'],
      ['another application mode', { applicationMode: 'controlling_switch' }, 'application_mode_not_authorized'],
      ['another desktop session', { desktop: { user: 'fixture-user', sessionId: 2 } }, 'desktop_not_authorized'],
      ['a process the host never owned', { currentProcess: { pid: 100, creationTime: 'controller-100' } }, 'stop_target_not_owned'],
    ];
    for (const [label, change, reason] of cases) {
      const native = nativeFixture(ctx);
      const result = await native.lifecycle.restart(restartInput(ctx, build, change));
      assert.equal(result.outcome, 'blocked', label);
      assert.equal(result.reason, `authority: ${reason}`, label);
      assert.equal(native.calls.stop.length + native.calls.start.length, 0, `${label}: nothing was stopped or launched`);
      assert.equal(native.processes.has(100), true, `${label}: the controlling process survives`);
    }
  } finally { ctx.host.close(); }
});

// ---------- ADR6-I05: budgets are charged at provider invocations ----------

test('ADR6-I05 (N06): a run under a one-invocation budget cannot complete three provider invocations', () => contextChain().then(async workflow => {
  workflow.workflowId = 'reg-provider-budget';
  return withRuntime(workflow, { limits: { providerInvocations: 1 } }, async ctx => {
    const permit = ctx.decide();
    assert.equal(permit.outcome, 'approved');
    const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
    assert.equal(created.body.outcome, 'created', JSON.stringify(created));
    const after = await ctx.api.waitFor(created.body.run.runId);
    const agentIds = workflow.nodes.filter(n => n.type === 'agent').map(n => n.id);
    const completed = after.instances.filter(i => agentIds.includes(i.nodeId) && i.state === 'succeeded');
    const charged = ctx.host.status(ctx.policyId).used.providerInvocations;
    assert.ok(completed.length <= 1, `completed ${completed.length} provider invocations under a limit of one`);
    assert.ok(charged <= 1, `charged ${charged} provider invocations under a limit of one`);
    assert.notEqual(after.run.state, 'succeeded');
  });
}));

// ---------- ADR6-I06: ambiguous lifecycle effects reconcile; nothing is replayed ----------

test('ADR6-I06 (N09): a launch whose reply is lost is reconciling, and a second restart cannot launch again', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    const native = nativeFixture(ctx, { registers: false });
    let effects = 0;
    native.lifecycle.launcher = { ...native.lifecycle.launcher, start: async () => { effects++; throw new Error('fixture: process created, launch reply lost'); } };
    const first = await native.lifecycle.restart(restartInput(ctx, build));
    assert.equal(first.outcome, 'reconciling', JSON.stringify(first));
    const second = await native.lifecycle.restart(restartInput(ctx, build));
    assert.equal(second.outcome, 'blocked');
    assert.match(second.reason, /host_reconciling/);
    assert.equal(effects, 1, 'The ambiguous launch was not repeated.');
    assert.match(ctx.host.dispatchBlocked, /need reconciliation/);
    assert.equal(ctx.host.all(`SELECT outcome FROM operations WHERE outcome = 'reconciling'`).length, 1);
  } finally { ctx.host.close(); }
});

test('ADR6-I06: a stop call that never answers is bounded and leaves the operation reconciling', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    // A stop call that never answers is bounded by the phase timeout and is ambiguous, not a clean refusal.
    const native = nativeFixture(ctx, { stopHangs: true });
    native.lifecycle.phaseTimeoutMs = 50;
    const current = { pid: 100, creationTime: 'controller-100' };
    ctx.host.registerInitialRuntime({ policyId: ctx.policyId, connectionId: ctx.connectionId, processEvidence: { pid: 100, creationTime: 'controller-100', imagePath: join(ctx.root, 'old.exe'), sessionId: 1 } });
    const result = await native.lifecycle.restart(restartInput(ctx, build, { currentProcess: current }));
    assert.equal(result.outcome, 'reconciling');
    assert.equal(native.calls.start.length, 0, 'Nothing was launched after an ambiguous stop.');
  } finally { ctx.host.close(); }
});

// ---------- ADR6-I07: a registration proof is consumed once ----------

test('ADR6-I07 (N05): replaying a consumed launch proof is refused and leaves the live generation intact', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    const native = nativeFixture(ctx);
    const result = await native.lifecycle.restart(restartInput(ctx, build));
    assert.equal(result.outcome, 'verified', JSON.stringify(result));
    const registrationsBefore = [...ctx.host.runtimeRegistrations.keys()];
    const proc = native.processes.get(200);
    assert.throws(() => ctx.host.registerRuntime({ policyId: ctx.policyId, operationId: result.operationId, processEvidence: proc, registrationNonce: native.calls.nonces[0] }),
      err => err.code === 'proof_consumed');
    assert.deepEqual([...ctx.host.runtimeRegistrations.keys()], registrationsBefore, 'The replay allocated no generation and removed none.');
    assert.ok(ctx.host.runtimeRegistrations.has(result.runtimeGeneration));
  } finally { ctx.host.close(); }
});

test('ADR6-I07: a peer that is not the observed process is refused and leaves the proof unconsumed', () => {
  const ctx = setup();
  const build = buildFixture(ctx);
  try {
    const target = { profile: ctx.scope.dataProfile, applicationMode: ctx.scope.applicationMode, desktop: ctx.scope.desktop, buildRoot: ctx.scope.buildRoot,
      buildDir: build.buildDir, buildId: build.manifest.buildId, currentProcess: null };
    const permit = ctx.host.decide({ requestId: randomUUID(), policyId: ctx.policyId, operation: 'app.restart', cost: {}, target }, { connectionId: ctx.connectionId });
    assert.equal(permit.outcome, 'approved', permit.reason);
    assert.equal(ctx.host.admit(permit.permitId).admitted, true);
    const { operationId } = ctx.host.beginOperation({ permitId: permit.permitId, kind: 'app.restart', intent: { fixture: 'peer check' } });
    ctx.host.recordPhase(operationId, 'build_verified', { buildCheck: { verified: true } });
    const { registrationNonce } = ctx.host.issueLaunchProof(operationId);
    const observed = { pid: 200, creationTime: 'launch-200', imagePath: join(build.buildDir, 'deszo.exe'), sessionId: 1,
      imageSha256: build.manifest.artifacts.find(a => a.path === 'deszo.exe').sha256 };
    ctx.host.bindLaunch(operationId, observed);
    assert.throws(() => ctx.host.registerRuntime({ policyId: ctx.policyId, operationId, processEvidence: observed, registrationNonce, peerEvidence: { ...observed, pid: 999 } }),
      err => err.code === 'registration_refused');
    const registered = ctx.host.registerRuntime({ policyId: ctx.policyId, operationId, processEvidence: observed, registrationNonce, peerEvidence: observed });
    assert.ok(registered.runtimeGeneration && registered.attachSecret, 'The genuine peer still registers once.');
    assert.throws(() => ctx.host.registerRuntime({ policyId: ctx.policyId, operationId, processEvidence: observed, registrationNonce, peerEvidence: observed }), err => err.code === 'proof_consumed');
  } finally { ctx.host.close(); }
});

// ---------- ADR6-I08: an exact create-run retry returns its committed receipt ----------

test('ADR6-I08 (N07): an exact retry of a committed create-run request returns the same run without admission or charge', () => withRuntime(singleAgent({ id: 'reg-retry', context: null }), {}, async ctx => {
  const permit = ctx.decide();
  const body = ctx.runBody(permit.permitId);
  const first = await ctx.api.callExternal('POST', '/api/v2/runs', body);
  assert.equal(first.body.outcome, 'created', JSON.stringify(first));
  await ctx.api.waitFor(first.body.run.runId);
  const usedBefore = ctx.host.status(ctx.policyId).used;
  const retry = await ctx.api.callExternal('POST', '/api/v2/runs', body);
  assert.equal(retry.status, first.status);
  assert.equal(retry.body.run.runId, first.body.run.runId, 'The retry names the committed run.');
  assert.deepEqual(ctx.host.status(ctx.policyId).used, usedBefore, 'The retry charged nothing.');
  const changed = await ctx.api.callExternal('POST', '/api/v2/runs', { ...body, workflowSnapshotSha256: 'f'.repeat(64) });
  assert.equal(changed.status, 409, 'A different payload with the same request ID is refused.');
  // The same request through another caller scope is a different command: refused, and nothing is admitted for it.
  const otherScope = await ctx.api.call('POST', '/api/v2/runs', body);
  assert.equal(otherScope.status, 409, 'A retry through another caller scope is refused.');
  assert.equal(otherScope.body.code, 'conflict');
}));

// ---------- Enablement gates (ADR6 section 7) ----------

test('Enablement: a production host refuses to start while capabilities are unverified', () => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-adr6-gate-'));
  assert.ok(missingProductionCapabilities().length >= 10, 'No capability is verified by documentation or fixtures.');
  assert.throws(() => new ControlHost({ root, time: manualTimeSource(), assurance: 'production' }), err => err.code === 'autonomy_disabled' && /Production autonomy is disabled/.test(err.message));
  const served = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'runtime/host/main.mjs'), 'serve', '--state', root, '--pipe', pipeFor(root)],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(served.status, 1, served.stdout);
  assert.match(served.stderr, /Production autonomy is disabled/);
});

test('Enablement: a store records its assurance level and refuses to be opened at another level', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-adr6-store-'));
  new ControlHost({ root, time: manualTimeSource() }).close();
  // Re-marking the store as production (as a tampered or copied store would appear) must still stop a fixture open.
  const raw = new DatabaseSync(join(root, 'host.sqlite'));
  raw.prepare(`UPDATE host_meta SET value = 'production' WHERE key = 'assurance'`).run();
  raw.close();
  assert.throws(() => new ControlHost({ root, time: manualTimeSource(), assurance: 'fixture' }), err => err.code === 'assurance_mismatch');
  assert.throws(() => new ControlHost({ root, time: manualTimeSource(), assurance: 'production' }), err => err.code === 'autonomy_disabled');
  const ctx = setup();
  const pipeName = pipeFor(ctx.root);
  const server = await startHostServer({ host: ctx.host, pipeName });
  const env = { DESZO_CONTROL_HOST_PIPE: pipeName, DESZO_HOST_POLICY_ID: ctx.policyId, DESZO_HOST_RUNTIME_GENERATION: ctx.runtimeGeneration, DESZO_HOST_ATTACH_SECRET: ctx.attachSecret };
  try {
    await assert.rejects(hostFromEnvironment({ ...env }, { packaged: false }), /refuses a fixture Local Control Host/);
    const binding = await hostFromEnvironment({ ...env, DESZO_ALLOW_FIXTURE_HOST: '1' }, { packaged: false });
    assert.equal(binding.assurance, 'fixture');
    binding.client.close();
    await assert.rejects(hostFromEnvironment({ ...env, DESZO_ALLOW_FIXTURE_HOST: '1' }, { packaged: true }), /refuses a fixture Local Control Host/);
  } finally { await new Promise(done => server.close(done)); ctx.host.close(); }
});
