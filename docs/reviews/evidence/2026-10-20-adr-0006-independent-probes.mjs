// Independent ADR-0006 review probes. Fixture credentials/processes and temporary stores only.
// Run from the repository: node --disable-warning=ExperimentalWarning docs/reviews/evidence/2026-10-20-adr-0006-independent-probes.mjs
// Exit 1 means a stated safety invariant was violated; an unexpected harness error is reported separately.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from '../../../runtime/core/canonical.mjs';
import { ControlHost } from '../../../runtime/host/authority.mjs';
import { manualTimeSource } from '../../../runtime/host/timeSource.mjs';
import { connectHost, startHostServer } from '../../../runtime/host/ipc.mjs';
import { HOST_ENV } from '../../../runtime/host/runtimeBinding.mjs';
import { ApplicationLifecycle, createBuildManifest } from '../../../runtime/host/lifecycle.mjs';
import { singleAgent, contextChain, startTestRunner } from '../../../runtime/tests/helpers.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const output = fileURLToPath(new URL('./2026-10-20-adr-0006-independent-probes.json', import.meta.url));
const HOUR = 3_600_000;
const SNAPSHOT = 'a'.repeat(64);
const keys = () => {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const signed = (key, value) => sign(null, canonicalBytes(value), key).toString('base64');
const pause = ms => new Promise(done => setTimeout(done, ms));
const results = [];

async function probe(id, invariant, body) {
  try {
    const observation = await body();
    assert.equal(typeof observation.violated, 'boolean');
    results.push({ id, invariant, ...observation });
  } catch (error) {
    results.push({ id, invariant, violated: null, harnessError: { name: error.name, message: error.message, stack: error.stack } });
  }
  console.log(JSON.stringify(results.at(-1)));
}

function setup({ scope: scopeOverrides = {}, limits: limitOverrides = {}, durationMs = HOUR } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-adr6-independent-'));
  const time = manualTimeSource();
  const host = new ControlHost({ root, time });
  const authenticator = keys();
  const controller = keys();
  host.enrollCredential({ credentialId: 'fixture-credential', publicKey: authenticator.publicKey, label: 'review fixture only' }, { enrolledBy: 'review fixture' });
  const scope = {
    dataProfile: 'authorized-profile', workspaces: [{ workspaceId: 'main', cwdIdentity: 'b'.repeat(64) }],
    workflows: [{ workflowId: 'review-workflow', baselineSha256: SNAPSHOT, permittedRevisions: [] }],
    operations: ['run.approve', 'app.restart', 'build.run', 'worker.model_call', 'run.stop_and_report'],
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
  const { runtimeGeneration } = host.registerInitialRuntime({ policyId, connectionId, processEvidence: { pid: process.pid, creationTime: 'fixture-start', imageSha256: 'c'.repeat(64) } });
  const decide = (overrides = {}) => host.decide({ requestId: randomUUID(), policyId, operation: 'run.approve', workspaceId: 'main', workflowId: scope.workflows[0].workflowId,
    workflowSnapshotSha256: scope.workflows[0].baselineSha256, runtimeGeneration, cost: {}, ...overrides }, { connectionId });
  return { root, time, host, scope, policyId, connectionId, runtimeGeneration, decide };
}

async function withRuntime(workflow, options, body) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-adr6-engine-'));
  let api = await startTestRunner({ root });
  await api.workspace();
  const cwdIdentity = api.runner.engine.requireWorkspace('main').cwd_identity;
  const settings = api.runner.engine.currentSettings();
  await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision, settings: { ...settings.settings, externalRunConfirmation: true } });
  const saved = await api.save(workflow);
  await api.close();
  const ctx = setup({ ...options, scope: { workspaces: [{ workspaceId: 'main', cwdIdentity }], workflows: [{ workflowId: workflow.workflowId, baselineSha256: saved.snapshotSha256, permittedRevisions: [] }] } });
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\deszo-review-${randomUUID()}` : join(ctx.root, 'host.sock');
  const server = await startHostServer({ host: ctx.host, pipeName });
  const oldEnv = Object.fromEntries(HOST_ENV.map(key => [key, process.env[key]]));
  process.env.DESZO_CONTROL_HOST_PIPE = pipeName;
  process.env.DESZO_HOST_POLICY_ID = ctx.policyId;
  process.env.DESZO_HOST_RUNTIME_GENERATION = ctx.runtimeGeneration;
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

await probe('N01', 'Runtime identifiers alone must not authenticate a connection or authorize permit admission.', async () => {
  const ctx = setup();
  const permit = ctx.decide();
  assert.equal(permit.outcome, 'approved');
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\deszo-review-${randomUUID()}` : join(ctx.root, 'host.sock');
  const server = await startHostServer({ host: ctx.host, pipeName });
  const stranger = connectHost(pipeName);
  try {
    const attached = await stranger.call('runtime.attach', { policyId: ctx.policyId, runtimeGeneration: ctx.runtimeGeneration });
    const admission = await stranger.call('admit', { permitId: permit.permitId });
    return { violated: attached.attached === true && admission.admitted === true, expected: '403 without an independent runtime proof', observed: { attached, admission, controllerAuthenticated: false, processEvidenceSupplied: false } };
  } finally { stranger.close(); await new Promise(done => server.close(done)); ctx.host.close(); }
});

await probe('N02', 'Revoking a host policy must stop an active run admitted under it.', () => withRuntime(singleAgent({ id: 'review-revoke', context: null, model: 'fixture-slow-2' }), {}, async ctx => {
  const permit = ctx.decide();
  assert.equal(permit.outcome, 'approved');
  const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
  assert.equal(created.body.outcome, 'created', JSON.stringify(created));
  const runId = created.body.run.runId;
  const before = await ctx.api.waitFor(runId, (_, snapshot) => snapshot.instances.some(i => i.nodeId === 'agent' && i.state === 'running'));
  const permitStateAtRevoke = ctx.host.permitView(permit.permitId).state;
  const revocation = ctx.host.revoke(ctx.policyId, { actor: 'review fixture', connectionId: ctx.connectionId });
  const after = await ctx.api.waitFor(runId);
  return { violated: after.run.state === 'succeeded', expected: 'active run canceled, included in Stop scope', observed: { before: before.run.state, permitStateAtRevoke, stopScope: revocation.stopScope, after: after.run.state } };
}));

await probe('N03', 'The host status CLI must not recover or mutate an independently running host.', async () => {
  const ctx = setup();
  try {
    const issued = ctx.decide();
    const admitted = ctx.decide({ operation: 'build.run', commandId: 'checks' });
    assert.equal(ctx.host.admit(admitted.permitId).admitted, true);
    const { operationId } = ctx.host.beginOperation({ permitId: admitted.permitId, kind: 'build.run', intent: { fixture: 'still active in the original host' } });
    const command = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'runtime/host/main.mjs'), 'status', '--state', ctx.root, '--policy', ctx.policyId], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(command.status, 0, command.stderr);
    const observation = { issued: ctx.host.permitView(issued.permitId).state, admitted: ctx.host.permitView(admitted.permitId).state,
      effect: ctx.host.permitView(admitted.permitId).effect, operation: ctx.host.operationRow(operationId).outcome,
      originalHostBlocked: ctx.host.dispatchBlocked, nextDecision: ctx.decide({ operation: 'worker.model_call' }).outcome };
    return { violated: observation.issued !== 'issued' || observation.operation !== 'in_progress', expected: 'issued/admitted/in_progress unchanged by status', observed: observation };
  } finally { ctx.host.close(); }
});

function buildFixture(ctx) {
  const buildDir = join(ctx.root, 'outside-authorized-build-root');
  mkdirSync(buildDir);
  writeFileSync(join(buildDir, 'deszo.exe'), 'fixture executable bytes; never executed');
  const manifest = createBuildManifest({ buildDir, buildId: 'review-build', sourceCommit: 'd'.repeat(40), inputsDigest: 'e'.repeat(64), protocolVersion: 2, storeSchemaVersion: 11, launchEntry: 'deszo.exe', createdAt: new Date().toISOString() });
  return { buildDir, manifest };
}

function nativeFixture(ctx) {
  const processes = new Map([[100, { pid: 100, creationTime: 'old-controller', imagePath: join(ctx.root, 'old.exe') }]]);
  const launches = [];
  const stops = [];
  const registrations = [];
  const inspector = { describe: async pid => processes.get(pid) ?? null, isRunning: async proc => processes.has(proc.pid) };
  const launcher = {
    stop: async proc => { stops.push(proc); processes.delete(proc.pid); },
    start: async args => {
      launches.push(args);
      const proc = { pid: 200, creationTime: 'new-controller', imagePath: args.launchPath, imageSha256: createHash('sha256').update(readFileSync(args.launchPath)).digest('hex') };
      processes.set(proc.pid, proc);
      setTimeout(() => {
        try { registrations.push(ctx.host.registerRuntime({ policyId: ctx.policyId, operationId: args.operationId, processEvidence: proc, registrationNonce: args.registrationNonce })); }
        catch (error) { registrations.push({ error: error.message }); }
      }, 5);
      return { pid: proc.pid };
    },
  };
  const lifecycle = new ApplicationLifecycle({ host: ctx.host, launcher, inspector, healthCheck: async () => ({ ok: true, buildId: 'review-build', protocolVersion: 2, storeSchemaVersion: 11 }), pollMs: 5 });
  return { processes, launches, stops, registrations, lifecycle };
}

await probe('N04', 'Lifecycle must enforce the consented profile, build root and application mode before stopping or launching.', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    const native = nativeFixture(ctx);
    const result = await native.lifecycle.restart({ connectionId: ctx.connectionId, policyId: ctx.policyId, requestId: randomUUID(), ...build,
      profile: 'UNAUTHORIZED-PROFILE', currentProcess: { pid: 100, creationTime: 'old-controller' }, rationale: 'review fixture', startupDeadlineMs: 1000 });
    return { violated: result.outcome === 'verified', expected: 'blocked without stopping the controlling application or launching another profile', observed: { result, authorizedProfile: ctx.scope.dataProfile, requestedProfile: 'UNAUTHORIZED-PROFILE', authorizedBuildRoot: ctx.scope.buildRoot, requestedBuildRoot: build.buildDir, authorizedMode: ctx.scope.applicationMode, stoppedPids: native.stops.map(p => p.pid), launches: native.launches.length } };
  } finally { ctx.host.close(); }
});

await probe('N05', 'A launch registration nonce must be consumed once and cannot replace a verified runtime generation by replay.', async () => {
  const ctx = setup();
  try {
    const native = nativeFixture(ctx);
    const result = await native.lifecycle.restart({ connectionId: ctx.connectionId, policyId: ctx.policyId, requestId: randomUUID(), ...buildFixture(ctx), profile: ctx.scope.dataProfile,
      currentProcess: null, rationale: 'review fixture', startupDeadlineMs: 1000 });
    assert.equal(result.outcome, 'verified');
    const launch = native.launches[0];
    const replay = ctx.host.registerRuntime({ policyId: ctx.policyId, operationId: result.operationId, processEvidence: native.processes.get(200), registrationNonce: launch.registrationNonce });
    return { violated: replay.runtimeGeneration !== result.runtimeGeneration, expected: 'replay refused or reconciled to the original registration receipt', observed: { operationOutcome: ctx.host.operationRow(result.operationId).outcome, originalGeneration: result.runtimeGeneration, replayGeneration: replay.runtimeGeneration, originalStillRegistered: ctx.host.runtimeRegistrations.has(result.runtimeGeneration) } };
  } finally { ctx.host.close(); }
});

await probe('N06', 'The shared providerInvocations limit must bound actual role invocations, not only the number of runs.', async () => {
  const workflow = await contextChain();
  workflow.workflowId = 'review-provider-budget';
  return withRuntime(workflow, { limits: { providerInvocations: 1 } }, async ctx => {
    const permit = ctx.decide();
    assert.equal(permit.outcome, 'approved');
    const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
    assert.equal(created.body.outcome, 'created', JSON.stringify(created));
    const after = await ctx.api.waitFor(created.body.run.runId);
    const agentIds = workflow.nodes.filter(n => n.type === 'agent').map(n => n.id);
    const agentAttempts = after.instances.filter(i => agentIds.includes(i.nodeId) && i.state === 'succeeded');
    const charged = ctx.host.status(ctx.policyId).used.providerInvocations;
    assert.equal(after.run.state, 'succeeded');
    return { violated: agentAttempts.length > 1 && charged === 1, expected: 'at most one provider invocation under a limit of one', observed: { run: after.run.state, completedAgentInvocations: agentAttempts.length, chargedInvocations: charged, limit: 1 } };
  });
});

await probe('N07', 'An exact retry after a lost createRun reply must reconcile to the committed run receipt.', () => withRuntime(singleAgent({ id: 'review-retry', context: null }), {}, async ctx => {
  const permit = ctx.decide();
  const body = ctx.runBody(permit.permitId);
  const first = await ctx.api.callExternal('POST', '/api/v2/runs', body);
  assert.equal(first.body.outcome, 'created', JSON.stringify(first));
  await ctx.api.waitFor(first.body.run.runId);
  const retry = await ctx.api.callExternal('POST', '/api/v2/runs', body);
  return { violated: retry.status === 403, expected: 'the same committed run receipt without another admission or charge', observed: { firstStatus: first.status, firstRunId: first.body.run.runId, retryStatus: retry.status, retryCode: retry.body.code, retryMessage: retry.body.message } };
}));

await probe('N08', 'Policy expiry must stop active owned work and must not let its run complete successfully.', () => withRuntime(singleAgent({ id: 'review-expiry', context: null, model: 'fixture-slow-2' }), { durationMs: 60000 }, async ctx => {
  const permit = ctx.decide();
  const created = await ctx.api.callExternal('POST', '/api/v2/runs', ctx.runBody(permit.permitId));
  assert.equal(created.body.outcome, 'created', JSON.stringify(created));
  const runId = created.body.run.runId;
  await ctx.api.waitFor(runId, (_, snapshot) => snapshot.instances.some(i => i.nodeId === 'agent' && i.state === 'running'));
  ctx.time.advance(60001);
  const expired = ctx.host.status(ctx.policyId);
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'expired');
  await pause(50);
  const after = await ctx.api.waitFor(runId);
  return { violated: after.run.state === 'succeeded', expected: 'active run stopped at the host deadline', observed: { policyValid: expired.valid, policyReason: expired.reason, runAfterExpiry: after.run.state, chargedAttempts: expired.used.attempts } };
}));

await probe('N09', 'An ambiguous launcher failure must block another restart until the first launch is reconciled.', async () => {
  const ctx = setup();
  try {
    const build = buildFixture(ctx);
    const native = nativeFixture(ctx);
    let effects = 0;
    native.lifecycle.launcher = { ...native.lifecycle.launcher, start: async () => { effects++; throw new Error('fixture: process created, launch reply lost'); } };
    const failures = [];
    for (let i = 0; i < 2; i++) {
      try { await native.lifecycle.restart({ connectionId: ctx.connectionId, policyId: ctx.policyId, requestId: randomUUID(), ...build, profile: ctx.scope.dataProfile, currentProcess: null, rationale: 'review fixture', startupDeadlineMs: 100 }); }
      catch (error) { failures.push(error.message); }
    }
    const operations = ctx.host.all('SELECT phase, outcome FROM operations');
    return { violated: effects === 2 && operations.length === 2, expected: 'one ambiguous effect, a reconciling/blocked outcome and no second launch', observed: { simulatedLaunchEffects: effects, failures, operations, dispatchBlocked: ctx.host.dispatchBlocked } };
  } finally { ctx.host.close(); }
});

const sourcePaths = ['runtime/host/authority.mjs', 'runtime/host/ipc.mjs', 'runtime/host/main.mjs', 'runtime/host/lifecycle.mjs', 'runtime/host/runtimeBinding.mjs',
  'runtime/host/timeSource.mjs', 'runtime/core/hostAutonomy.mjs', 'runtime/core/engine.mjs', 'runtime/core/adapters.mjs', 'runtime/runner.mjs', 'docs/schemas/autonomy-policy.schema.json'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]));
const report = { date: new Date().toISOString(), purpose: 'Independent negative review probes; violations are defects, not passing safety tests.',
  scope: 'Temporary fixture stores and local fixture child processes only; no application, service, scheduled task, production store or real provider used.',
  head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim(), sourceSha256,
  node: process.version, platform: process.platform, total: results.length, violated: results.filter(r => r.violated === true).length,
  satisfied: results.filter(r => r.violated === false).length, harnessErrors: results.filter(r => r.violated === null).length, results };
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, total: report.total, violated: report.violated, satisfied: report.satisfied, harnessErrors: report.harnessErrors }));
process.exitCode = report.harnessErrors ? 2 : report.violated ? 1 : 0;
