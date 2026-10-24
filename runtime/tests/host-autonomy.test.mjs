// ADR-0006 end to end: a runtime bound to a Local Control Host over the IPC protocol admits a run under a host
// permit while external confirmation is on, and refuses forged, reused or mismatched permits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalBytes } from '../core/canonical.mjs';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { connectHost, startHostServer } from '../host/ipc.mjs';
import { HOST_ENV } from '../host/runtimeBinding.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');
const der = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
const signValue = (privateKey, value) => sign(null, canonicalBytes(value), privateKey).toString('base64');

test('ADR6-01/07: a host permit admits an external run without the confirmation pause, and only that exact run', async () => {
  await mkdir(testsRoot, { recursive: true });
  const root = await mkdtemp(join(testsRoot, 'host-autonomy-'));
  const workflow = singleAgent({ id: 'host-permitted', context: null });

  // A first runtime saves the workflow and workspace and turns confirmation on, as the user would.
  let api = await startTestRunner({ root });
  await api.workspace();
  // The policy names the directory this workspace really runs in; provider charges are refused in any other directory.
  const cwdIdentity = api.runner.engine.requireWorkspace('main').cwd_identity;
  const settings = api.runner.engine.currentSettings();
  await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision, settings: { ...settings.settings, externalRunConfirmation: true } });
  const saved = await api.save(workflow);
  await api.close();

  // The trusted host, its enrolled authenticator and a verified policy for exactly this workflow revision.
  const host = new ControlHost({ root: join(root, 'host-state'), time: manualTimeSource() });
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\deszo-host-test-${randomUUID()}` : join(root, 'host.sock');
  const server = await startHostServer({ host, pipeName });
  const authenticator = generateKeyPairSync('ed25519');
  const controllerKeys = generateKeyPairSync('ed25519');
  host.enrollCredential({ credentialId: 'hello', publicKey: der(authenticator.publicKey), label: 'test' }, { enrolledBy: 'test installation' });
  const controller = connectHost(pipeName);
  const proposal = await controller.call('policy.propose', {
    controller: { controllerId: 'worker', publicKey: der(controllerKeys.publicKey) },
    scope: { dataProfile: 'test', workspaces: [{ workspaceId: 'main', cwdIdentity }], workflows: [{ workflowId: workflow.workflowId, baselineSha256: saved.snapshotSha256, permittedRevisions: [] }],
      operations: ['run.approve', 'provider.invoke'], commands: [], desktop: { user: 'u', sessionId: 1 }, buildRoot: 'C:/builds', applicationMode: 'separate_preview', deliveryBoundary: 'candidate' },
    limits: { attempts: 5, providerInvocations: 5, workerModelCalls: 0, operations: 10, restarts: 0, repairs: 0, builds: 0 }, durationMs: 3_600_000,
  });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: proposal.challengeId, nonce: proposal.nonce, decisionDigest: proposal.decisionDigest, audience: proposal.audience };
  const flags = { userPresent: true, userVerified: true };
  const policy = await controller.call('policy.authorize', { challengeId: proposal.challengeId, assertion: { credentialId: 'hello', clientData, flags, signature: signValue(authenticator.privateKey, { clientData, flags }) } });
  const challenge = await controller.call('controller.challenge', { policyId: policy.policyId, controllerId: 'worker' });
  await controller.call('controller.authenticate', { nonce: challenge.nonce, signature: signValue(controllerKeys.privateKey, { type: 'deszo.controller.auth', nonce: challenge.nonce, audience: challenge.audience, policyId: policy.policyId, controllerId: 'worker' }) });
  const { runtimeGeneration, attachSecret } = await controller.call('runtime.register_initial', { policyId: policy.policyId, processEvidence: { pid: process.pid, creationTime: 'test', imageSha256: 'c'.repeat(64) } });

  // The runtime restarts bound to the host; the variables are consumed and not inherited by its children. A fixture host
  // is accepted only with the explicit test switch, which the runtime refuses when packaged.
  process.env.DESZO_CONTROL_HOST_PIPE = pipeName;
  process.env.DESZO_HOST_POLICY_ID = policy.policyId;
  process.env.DESZO_HOST_RUNTIME_GENERATION = runtimeGeneration;
  process.env.DESZO_HOST_ATTACH_SECRET = attachSecret;
  process.env.DESZO_ALLOW_FIXTURE_HOST = '1';
  api = await startTestRunner({ root });
  try {
    for (const key of HOST_ENV) assert.equal(process.env[key], undefined, `${key} leaked into the runtime environment.`);
    const decide = overrides => controller.call('decide', { request: { requestId: randomUUID(), policyId: policy.policyId, operation: 'run.approve', workspaceId: 'main', workflowId: workflow.workflowId,
      workflowSnapshotSha256: saved.snapshotSha256, runtimeGeneration, cost: {}, ...overrides } });
    const runBody = permitId => ({ workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID(), hostPermitId: permitId });

    // Without a permit the ordinary path still waits for the user.
    const ordinary = await api.callExternal('POST', '/api/v2/runs', { ...runBody(randomUUID()), hostPermitId: undefined });
    assert.equal(ordinary.body.outcome, 'confirmation_pending');

    const permitted = await decide({});
    assert.equal(permitted.outcome, 'approved');
    const created = await api.callExternal('POST', '/api/v2/runs', runBody(permitted.permitId));
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.outcome, 'created');
    const finished = await api.waitFor(created.body.run.runId);
    assert.equal(finished.run.state, 'succeeded');

    // The permit is single-use, a forged permit ID grants nothing, and a permit for another workspace is refused.
    const reused = await api.callExternal('POST', '/api/v2/runs', runBody(permitted.permitId));
    assert.equal(reused.status, 403);
    assert.equal(reused.body.code, 'host_refused');
    const forged = await api.callExternal('POST', '/api/v2/runs', runBody(randomUUID()));
    assert.equal(forged.status, 404);
    const other = await decide({});
    const mismatched = await api.callExternal('POST', '/api/v2/runs', { ...runBody(other.permitId), workflowSnapshotSha256: 'f'.repeat(64) });
    assert.equal(mismatched.status, 403);
    assert.equal(mismatched.body.code, 'host_permit_mismatch');

    const status = await controller.call('status', { policyId: policy.policyId });
    assert.equal(status.used.attempts, 2, 'Only the created run and the outstanding permit are charged.');

    // Revocation: the outstanding permit can no longer be admitted.
    await controller.call('revoke', { policyId: policy.policyId, actor: 'test controller' });
    const afterRevoke = await api.callExternal('POST', '/api/v2/runs', runBody(other.permitId));
    assert.equal(afterRevoke.status, 403);
  } finally {
    await api.close();
    controller.close();
    server.close();
    host.close();
  }
});
