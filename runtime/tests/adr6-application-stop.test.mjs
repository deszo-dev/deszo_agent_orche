// Domain/injected-native regression tests. These do not attest an installed service or Windows process termination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBytes, canonicalize } from '../core/canonical.mjs';
import { ControlHost } from '../host/authority.mjs';
import { ApplicationStop } from '../host/applicationStop.mjs';
import { ControllerQueue } from '../host/controllerQueue.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { ownedDir } from './test-roots.mjs';

const keyText = key => key.export({ type: 'spki', format: 'der' }).toString('base64');
const plan = { schemaVersion: 1, kind: 'ControllerPlan', mode: 'deterministic', steps: [{ type: 'command.check', args: { commandId: 'checks', workspaceId: 'main' } }] };
function fixture({ allowed = true, phaseTimeoutMs = 150, nativeHook = null } = {}) {
  const root = ownedDir(join(tmpdir(), 'deszo-application-stop-')), time = manualTimeSource();
  const host = new ControlHost({ root, time }), key = generateKeyPairSync('ed25519'), controller = generateKeyPairSync('ed25519');
  host.enrollCredential({ credentialId: 'fixture', label: 'test only', publicKey: keyText(key.publicKey) }, { enrolledBy: 'test' });
  const scope = { dataProfile: 'main', desktop: { user: 'test-user', sessionId: 1 }, applicationMode: 'separate_preview', buildRoot: join(root, 'builds'), deliveryBoundary: 'candidate',
    workspaces: [{ workspaceId: 'main', cwdIdentity: 'a'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'b'.repeat(64), permittedRevisions: [] }],
    operations: ['app.restart', 'check.run', ...(allowed ? ['app.stop'] : [])], commands: [{ commandId: 'checks', command: 'node', args: ['--version'], cwdRelative: '.', timeoutMs: 1000 }] };
  const limits = { attempts: 0, providerInvocations: 0, workerModelCalls: 0, operations: 10, restarts: 1, repairs: 0, builds: 0 };
  const p = host.proposePolicy({ controller: { controllerId: 'test', publicKey: keyText(controller.publicKey) }, scope, limits, durationMs: 3600000 });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: p.challengeId, nonce: p.nonce, decisionDigest: p.decisionDigest, audience: p.audience }, flags = { userPresent: true, userVerified: true };
  const { policyId } = host.authorizePolicy({ challengeId: p.challengeId, assertion: { credentialId: 'fixture', clientData, flags, signature: sign(null, canonicalBytes({ clientData, flags }), key.privateKey).toString('base64') } });
  const challenge = host.controllerChallenge(policyId, 'test');
  const { connectionId } = host.authenticateController({ nonce: challenge.nonce, signature: sign(null, canonicalBytes({ type: 'deszo.controller.auth', ...challenge }), controller.privateKey).toString('base64') });
  const app = { pid: 901, creationTime: '100', imageSha256: 'c'.repeat(64) }, node = { pid: 902, creationTime: '101', imageSha256: 'd'.repeat(64) };
  const buildDir = join(scope.buildRoot, 'test-build'), target = { profile: 'main', applicationMode: scope.applicationMode, desktop: scope.desktop, buildRoot: scope.buildRoot, buildDir, buildId: 'test-build', currentProcess: null };
  const receipt = host.decide({ requestId: randomUUID(), policyId, operation: 'app.restart', cost: {}, target }, { connectionId });
  assert.equal(host.admit(receipt.permitId).admitted, true);
  const { operationId } = host.beginOperation({ permitId: receipt.permitId, kind: 'app.restart', intent: { ...target } });
  host.recordPhase(operationId, 'build_verified');
  const { registrationNonce } = host.issueLaunchProof(operationId); host.bindLaunch(operationId, app);
  // Simulate the installed adapter's independently observed descendant binding, retaining the root launch receipt.
  host.run('UPDATE registration_proofs SET expected_json=? WHERE operation_id=?', canonicalize(node), operationId);
  const { runtimeGeneration } = host.registerRuntime({ policyId, operationId, registrationNonce, processEvidence: node, peerEvidence: node });
  host.finishOperation(operationId, { outcome: 'verified', evidence: { verification: { complete: true } } });
  host.settle(receipt.permitId, { effect: 'consumed', evidence: 'fixture native launch' });
  let calls = 0; const alive = new Set([app.pid, node.pid]);
  const native = async (method, params) => {
    if (nativeHook) { const result = await nativeHook(method, params); if (result !== undefined) return result; }
    if (method === 'stopProcess') { calls++; assert.deepEqual(params, { domain: policyId, process: app, graceful: true }); alive.clear(); return { domainEmpty: true, terminationConfirmed: true }; }
    if (method === 'isRunning') return { running: alive.has(params.process.pid) };
    throw new Error(`Unexpected native operation ${method}`);
  };
  const stopper = new ApplicationStop({ host, native, phaseTimeoutMs, pollMs: 1 }), request = { policyId, requestId: randomUUID(), runtimeGeneration };
  return { host, time, root, policyId, connectionId, scope, app, node, runtimeGeneration, stopper, request, alive, calls: () => calls,
    stop: (args = request, id = connectionId) => stopper.stop(args, id), check: () => host.decide({ policyId, requestId: randomUUID(), operation: 'check.run', commandId: 'checks', cost: {} }, { connectionId }) };
}

test('planned close verifies the application and Node death, preserving original authority and exhausted restart count; replay never closes a replacement', async () => {
  const c = fixture();
  try {
    const before = c.host.status(c.policyId), result = await c.stop(), after = c.host.status(c.policyId);
    assert.equal(result.outcome, 'verified'); assert.equal(c.calls(), 1); assert.equal(c.alive.size, 0);
    assert.equal(after.state, 'active'); assert.equal(after.expiresAt, before.expiresAt); assert.equal(after.used.restarts, 1); assert.equal(after.used.operations, before.used.operations + 1);
    assert.equal(c.host.runtimeRegistrations.has(c.runtimeGeneration), false);
    const row = c.host.operationRow(result.operationId), evidence = JSON.parse(row.evidence_json);
    assert.deepEqual(evidence.processes.map(p => [p.process.pid, p.running]), [[901, false], [902, false]]);
    const replacement = c.host.registerInitialRuntime({ policyId: c.policyId, connectionId: c.connectionId, processEvidence: { pid: 903, creationTime: '102' } });
    assert.equal((await c.stop()).receiptOnly, true); assert.equal(c.calls(), 1); assert.ok(c.host.runtimeRegistrations.has(replacement.runtimeGeneration));
    assert.equal(c.check().outcome, 'approved');
  } finally { c.host.close(); }
});

test('close refuses missing authority, wrong connection, wrong generation and supplied PID/outcome without touching the application', async () => {
  const c = fixture({ allowed: false });
  try {
    const before = c.host.status(c.policyId).used;
    assert.equal((await c.stop()).reason, 'operation_not_authorized');
    await assert.rejects(c.stop(c.request, 'untrusted'), { code: 'controller_not_authenticated' });
    await assert.rejects(c.stop({ ...c.request, requestId: randomUUID(), runtimeGeneration: randomUUID() }), { code: 'application_stop_refused' });
    for (const extra of [{ process: c.app }, { outcome: 'verified' }, { command: 'terminate' }]) await assert.rejects(c.stop({ ...c.request, ...extra }), { code: 'invalid_request' });
    assert.equal(c.calls(), 0); assert.equal(c.alive.size, 2); assert.ok(c.host.runtimeRegistrations.has(c.runtimeGeneration));
    assert.deepEqual(c.host.status(c.policyId).used, before);
  } finally { c.host.close(); }
});

test('close rejects active or queued work instead of silently cutting off a workflow; protected initial controller cannot be targeted', async () => {
  const c = fixture(), queue = new ControllerQueue({ host: c.host });
  try {
    queue.enqueue({ itemId: 'pending', policyId: c.policyId, plan }, c.connectionId);
    await assert.rejects(c.stop(), /idle owned work and queue/); assert.equal(c.calls(), 0);
    const initial = c.host.registerInitialRuntime({ policyId: c.policyId, connectionId: c.connectionId, processEvidence: { pid: 904, creationTime: '99' } });
    await assert.rejects(c.stop({ ...c.request, runtimeGeneration: initial.runtimeGeneration }), /host-launched application/);
  } finally { c.host.close(); }
});

test('Stop fences outstanding permits and new queue claims; concurrent identical requests return the pending receipt', async () => {
  let c, release, entered;
  const reached = new Promise(done => { entered = done; });
  const gate = new Promise(done => { release = done; });
  c = fixture({ phaseTimeoutMs: 2000, nativeHook: async method => { if (method === 'stopProcess') { entered(); await gate; } } });
  try {
    const issued = c.check(), queue = new ControllerQueue({ host: c.host }), pending = c.stop(); await reached;
    assert.equal(c.host.admit(issued.permitId).reason, 'permit_invalidated'); assert.equal(c.check().reason, 'application_stopping');
    assert.throws(() => queue.enqueue({ itemId: 'racing', policyId: c.policyId, plan }, c.connectionId), { code: 'worker_authority_unavailable' });
    const duplicate = await c.stop(); assert.equal(duplicate.outcome, 'reconciling'); assert.equal(duplicate.receiptOnly, true);
    release(); const final = await pending; assert.equal(final.outcome, 'verified'); assert.equal(c.calls(), 1);
    await assert.rejects(c.stop({ ...c.request, runtimeGeneration: randomUUID() }), /different target or operation/);
  } finally { release(); c.host.close(); }
});

test('lost Stop reply, timeout, and missing native termination proof retain charges, retire the generation and block dispatch without replay', async () => {
  for (const failure of ['lost', 'timeout', 'unconfirmed', 'child-still-live']) {
    let invoked = 0;
    const c = fixture({ phaseTimeoutMs: 25, nativeHook: async (method, params) => {
      if (method === 'stopProcess') {
        invoked++;
        if (failure === 'lost') throw new Error('Reply lost after effect');
        if (failure === 'timeout') return new Promise(() => {});
        if (failure === 'unconfirmed') return { domainEmpty: true, terminationConfirmed: false };
        return { domainEmpty: true, terminationConfirmed: true };
      }
      if (method === 'isRunning') return { running: params.process.pid === 902 };
    } });
    try {
      const before = c.host.status(c.policyId), result = await c.stop();
      assert.equal(result.outcome, 'reconciling', failure); assert.equal(c.host.runtimeRegistrations.has(c.runtimeGeneration), false);
      assert.ok(c.host.dispatchBlocked); assert.equal(c.host.status(c.policyId).used.operations, before.used.operations + 1);
      assert.equal(c.host.status(c.policyId).expiresAt, before.expiresAt); assert.equal(c.host.status(c.policyId).used.restarts, 1);
      assert.equal((await c.stop()).receiptOnly, true); assert.equal(invoked, 1); assert.equal(c.check().outcome, 'pending');
      assert.equal(c.host.revoke(c.policyId, { actor: 'test emergency Stop' }).committed, true);
    } finally { c.host.close(); }
  }
});
