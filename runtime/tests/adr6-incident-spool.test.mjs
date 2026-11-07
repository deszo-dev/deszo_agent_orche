// ADR-0006 incident filing: an externally observed incident is filed in the protected outbox under its policy, and the
// profile comes from that policy, never from the caller. Filing is evidence only. Delivery still needs a ready runtime of the
// policy's own profile, so filing starts nothing, charges nothing and grants no authority. Fixture scope: the installed service
// route is a thin gate over installedActions.spoolIncident, and the gate itself runs only inside the installed service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { canonicalBytes } from '../core/canonical.mjs';
import { installedActions } from '../host/serviceActions.mjs';
import { ownedDir } from './test-roots.mjs';

const keyText = key => key.export({ type: 'spki', format: 'der' }).toString('base64');
const incidentObservation = () => ({ schemaVersion: 1, kind: 'IncidentObservation', title: 'Foreground handoff missing', component: 'control-host', category: 'native_foreground_handoff_missing', severity: 'high', confidence: 'high', causeStatus: 'suspected', expected: 'Bounded foreground evidence.', actual: 'Foreground eligibility was lost.', reproduction: ['Relaunch twice.'], versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId: null, nodeInstanceId: null, attemptId: null, eventRange: null, artifacts: [], captureGaps: ['The second launch produced no foreground evidence.'], controllerCommandId: null, reporter: { authority: 'external', sessionId: null } });

// An authorized policy for a profile of its own, created through the real proposal and authorization path with a fixture key.
function authorizedPolicy() {
  const root = ownedDir(join(tmpdir(), 'deszo-incident-spool-')), time = manualTimeSource();
  const host = new ControlHost({ root: join(root, 'host'), time });
  const authenticator = generateKeyPairSync('ed25519'), controller = generateKeyPairSync('ed25519');
  host.enrollCredential({ credentialId: 'fixture-only', label: 'test', publicKey: keyText(authenticator.publicKey) }, { enrolledBy: 'test fixture' });
  const proposal = host.proposePolicy({ controller: { controllerId: 'worker', publicKey: keyText(controller.publicKey) }, durationMs: 43200000,
    scope: { dataProfile: 'spool-profile', desktop: { user: 'fixture-user', sessionId: 1 }, applicationMode: 'controlling_switch', buildRoot: join(root, 'builds'), deliveryBoundary: 'verified_branch',
      workspaces: [{ workspaceId: 'main', cwdIdentity: 'a'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'b'.repeat(64), permittedRevisions: [] }], operations: ['check.run'], commands: [] },
    limits: { attempts: 1, providerInvocations: 0, workerModelCalls: 0, operations: 1, restarts: 0, repairs: 0, builds: 0 } });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: proposal.challengeId, nonce: proposal.nonce, decisionDigest: proposal.decisionDigest, audience: proposal.audience }, flags = { userPresent: true, userVerified: true };
  const policy = host.authorizePolicy({ challengeId: proposal.challengeId, assertion: { credentialId: 'fixture-only', clientData, flags, signature: sign(null, canonicalBytes({ clientData, flags }), authenticator.privateKey).toString('base64') } });
  return { root, host, policyId: policy.policyId };
}

function actionsFor(c) {
  return installedActions({ host: c.host, installation: { userSid: 'fixture-user', buildRoot: join(c.root, 'builds') }, native: {}, queue: {}, installRoot: join(c.root, 'install') });
}

test('ADR6 incident spool: filing records the observation under its policy, is idempotent, and waits for a ready runtime without charging anything', async () => {
  const c = authorizedPolicy(), actions = actionsFor(c), requestId = randomUUID(), observation = incidentObservation();
  try {
    const filed = actions.spoolIncident({ policyId: c.policyId, requestId, observation });
    assert.equal(filed.requestId, requestId);
    assert.equal(filed.policyId, c.policyId);
    assert.equal(filed.state, 'pending');
    assert.equal(filed.runId, null);
    assert.deepEqual(actions.spoolIncident({ policyId: c.policyId, requestId, observation }), filed, 'Filing the same request again is idempotent.');
    assert.equal(c.host.get('SELECT COUNT(*) AS n FROM incident_outbox').n, 1, 'A repeat creates no second incident.');
    assert.throws(() => actions.spoolIncident({ policyId: c.policyId, requestId, observation: { ...observation, actual: 'different evidence' } }), error => error.code === 'conflict');
    assert.deepEqual(await actions.flushIncidents(c.policyId), { pending: true, reason: 'no_registered_runtime' }, 'Filing never delivers: with no ready runtime the incident waits.');
    assert.equal(actions.incidents.get(requestId).state, 'pending');
    assert.equal(c.host.status(c.policyId).used.attempts, 0, 'Filing charges no attempt or operation.');
    assert.equal(c.host.verifyAudit().intact, true);
  } finally { c.host.close(); }
});

test('ADR6 incident spool: an unknown policy, a missing request identity or a schema-invalid observation is refused and nothing is filed', () => {
  const c = authorizedPolicy(), actions = actionsFor(c);
  try {
    assert.throws(() => actions.spoolIncident({ policyId: randomUUID(), requestId: randomUUID(), observation: incidentObservation() }));
    assert.throws(() => actions.spoolIncident({ policyId: c.policyId, requestId: null, observation: incidentObservation() }), error => error.code === 'scoped_action_refused');
    assert.throws(() => actions.spoolIncident({ policyId: c.policyId, requestId: randomUUID(), observation: { title: 'incomplete' } }), error => error.code === 'invalid_incident');
    assert.equal(c.host.get('SELECT COUNT(*) AS n FROM incident_outbox').n, 0);
  } finally { c.host.close(); }
});
