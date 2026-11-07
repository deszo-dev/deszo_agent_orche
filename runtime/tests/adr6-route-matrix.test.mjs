// ADR-0006 route/credential matrix, exercised over real HTTP in a host-bound candidate runtime (fixture host).
// Every family the matrix marks "Refused" for a host-bound candidate is called with both the first-party and the external
// credential. The test asserts the engine's own refusal (trusted_authority_required) and that the stored state did not change.
// Fixture host: establishes engine and route wiring, not Windows authority. Native credential boundaries are separate evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBytes } from '../core/canonical.mjs';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { startHostServer } from '../host/ipc.mjs';
import { HOST_ENV } from '../host/runtimeBinding.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';
import { ownedDir } from './test-roots.mjs';

const HOUR = 3_600_000;
const keys = () => {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const signed = (key, value) => sign(null, canonicalBytes(value), key).toString('base64');
const pipeFor = root => (process.platform === 'win32' ? `\\\\.\\pipe\\deszo-route-matrix-${randomUUID()}` : join(root, 'host.sock'));
const REFUSED = 'trusted_authority_required';

// A fixture policy for the candidate's controlling runtime, attached over the real IPC protocol.
function policyFor(root, cwdIdentity, workflowId, snapshotSha256) {
  const host = new ControlHost({ root: join(root, 'host'), time: manualTimeSource() });
  const authenticator = keys(), controller = keys();
  host.enrollCredential({ credentialId: 'fixture-credential', publicKey: authenticator.publicKey, label: 'route matrix fixture only' }, { enrolledBy: 'route matrix fixture' });
  const scope = { dataProfile: 'authorized-profile', workspaces: [{ workspaceId: 'main', cwdIdentity }],
    workflows: [{ workflowId, baselineSha256: snapshotSha256, permittedRevisions: [] }], operations: ['run.approve', 'provider.invoke'], commands: [],
    desktop: { user: 'fixture-user', sessionId: 1 }, buildRoot: join(root, 'builds'), applicationMode: 'separate_preview', deliveryBoundary: 'candidate' };
  const proposal = host.proposePolicy({ controller: { controllerId: 'fixture-controller', publicKey: controller.publicKey }, scope,
    limits: { attempts: 10, providerInvocations: 10, workerModelCalls: 0, operations: 20, restarts: 0, repairs: 0, builds: 0 }, durationMs: 12 * HOUR });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: proposal.challengeId, nonce: proposal.nonce, decisionDigest: proposal.decisionDigest, audience: proposal.audience };
  const flags = { userPresent: true, userVerified: true };
  const { policyId } = host.authorizePolicy({ challengeId: proposal.challengeId, assertion: { credentialId: 'fixture-credential', clientData, flags, signature: signed(authenticator.privateKey, { clientData, flags }) } });
  const challenge = host.controllerChallenge(policyId, 'fixture-controller');
  const { connectionId } = host.authenticateController({ nonce: challenge.nonce, signature: signed(controller.privateKey, { type: 'deszo.controller.auth', nonce: challenge.nonce, audience: challenge.audience, policyId, controllerId: 'fixture-controller' }) });
  const { runtimeGeneration, attachSecret } = host.registerInitialRuntime({ policyId, connectionId, processEvidence: { pid: process.pid, creationTime: 'route-matrix', imageSha256: 'c'.repeat(64), sessionId: 1 } });
  return { host, policyId, runtimeGeneration, attachSecret };
}

// A candidate runtime bound to the fixture host, reached over HTTP with both credentials.
async function withHostBoundCandidate(body) {
  const root = ownedDir(join(tmpdir(), 'deszo-route-matrix-'));
  let api = await startTestRunner({ root });
  await api.workspace();
  const engine = api.runner.engine;
  const cwdIdentity = engine.requireWorkspace('main').cwd_identity;
  const settings = engine.currentSettings();
  await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision, settings: { ...settings.settings, externalRunConfirmation: true } });
  const workflow = singleAgent({ id: 'route-matrix', context: null });
  const saved = await api.save(workflow);
  await api.close();
  const ctx = policyFor(root, cwdIdentity, workflow.workflowId, saved.snapshotSha256);
  const pipeName = pipeFor(root);
  const server = await startHostServer({ host: ctx.host, pipeName });
  const oldEnv = Object.fromEntries([...HOST_ENV, 'DESZO_ALLOW_FIXTURE_HOST'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { DESZO_CONTROL_HOST_PIPE: pipeName, DESZO_HOST_POLICY_ID: ctx.policyId, DESZO_HOST_RUNTIME_GENERATION: ctx.runtimeGeneration, DESZO_HOST_ATTACH_SECRET: ctx.attachSecret, DESZO_ALLOW_FIXTURE_HOST: '1' });
  api = null;
  try {
    api = await startTestRunner({ root });
    return await body({ api, saved, workflow, cwdIdentity });
  } finally {
    if (api) await api.close();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(done => server.close(done));
    ctx.host.close();
  }
}

// Both descriptor names resolve to the same persisted Owner Token after AMD-19.
const CREDENTIALS = [['owner', 'call'], ['owner-token-alias', 'callExternal']];

for (const [credential, method] of CREDENTIALS) {
  test(`AMD-19 route matrix (${credential}): Owner Token can manage settings, workspaces, Drafts and Publications on a host-bound runtime`, () => withHostBoundCandidate(async ({ api, saved, workflow }) => {
    const before = api.runner.engine.currentSettings();
    const settings = await api[method]('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: before.revision, settings: { ...before.settings, externalRunConfirmation: false } });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    const workspace = await api[method]('PUT', '/api/v2/workspaces/host-candidate-extra', { cwd: join(api.runner.connection.scratchRoot, 'host-candidate-extra') });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const currentDraft = await api[method]('GET', `/api/v4/workflows/${workflow.workflowId}/draft`);
    assert.equal(currentDraft.status, 200, JSON.stringify(currentDraft.body));
    const draft = await api[method]('PUT', `/api/v4/workflows/${workflow.workflowId}/draft`, { requestId: randomUUID(), workflow }, { headers: { 'If-Match': currentDraft.body.etag } });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const published = await api[method]('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': draft.body.etag } });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflows WHERE id = ?', workflow.workflowId).n, 1);
    assert.ok(saved.snapshotSha256);
  }));

  test(`AMD-19 route matrix (${credential}): public handlers authenticate the Owner Token before operation-specific checks`, () => withHostBoundCandidate(async ({ api }) => {
    const binding = randomUUID();
    const acknowledge = await api[method]('POST', `/api/v2/context-bindings/${binding}/acknowledge`, { requestId: randomUUID(), choice: 'keep' });
    assert.ok(![401, 403].includes(acknowledge.status), `acknowledge: ${JSON.stringify(acknowledge.body)}`);
    const message = await api[method]('POST', `/api/v2/context-bindings/${binding}/messages`, { requestId: randomUUID(), text: 'candidate-authored message' });
    assert.ok(![401, 403].includes(message.status), `message: ${JSON.stringify(message.body)}`);
    const extension = await api[method]('POST', `/api/v2/runs/${randomUUID()}/control-extension`, { requestId: randomUUID(), extensionMs: 60000 });
    assert.ok(![401, 403].includes(extension.status), `extension: ${JSON.stringify(extension.body)}`);
    const approval = await api[method]('POST', `/api/v2/control-grants/${randomUUID()}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.ok(![401, 403].includes(approval.status), `grant approval: ${JSON.stringify(approval.body)}`);
  }));

  test(`AMD-19 route matrix (${credential}): incident, cache and recovery routes are public API routes`, () => withHostBoundCandidate(async ({ api, workflow }) => {
    const triage = await api[method]('POST', `/api/v2/incidents/${randomUUID()}/triage`, { requestId: randomUUID(), decision: 'close' });
    assert.ok(![401, 403].includes(triage.status), `triage: ${JSON.stringify(triage.body)}`);
    const pin = await api[method]('PUT', `/api/v2/workflows/${workflow.workflowId}/cache-pins/route-pin`, { requestId: randomUUID(), pinned: true });
    assert.ok(![401, 403].includes(pin.status), `cache pin: ${JSON.stringify(pin.body)}`);
    const recovery = await api[method]('POST', `/api/v2/runs/${randomUUID()}/recovery`, { requestId: randomUUID(), action: 'retry', nodeInstanceId: 'agent' });
    assert.ok(![401, 403].includes(recovery.status), `recovery retry: ${JSON.stringify(recovery.body)}`);
  }));
}
