import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { ORIGIN, WebAuthnConsent, verifyAssertion, parseAuthenticatorData } from '../host/webauthn.mjs';
import { authenticator } from './webauthn-fixture.mjs';
import { ownedDir } from './test-roots.mjs';

test('ADR6 native consent verifier refuses forged signatures, substituted client context, absent UV, wrong RP and credential replay counters', () => {
  const a = authenticator(), client = JSON.stringify({ type: 'webauthn.get', challenge: randomUUID(), origin: ORIGIN, crossOrigin: false });
  const expected = { credentialId: a.id, jwk: a.jwk, expectedClientDataJSON: client };
  assert.equal(verifyAssertion(a.assertion(client), expected).flags, 5);
  assert.throws(() => verifyAssertion(a.assertion(client, { flags: 1 }), expected), /presence and verification/);
  assert.throws(() => verifyAssertion(a.assertion(client.replace(ORIGIN, 'https://attacker.invalid')), expected), /Wrong challenge/);
  assert.throws(() => verifyAssertion(a.assertion(client), { ...expected, jwk: authenticator().jwk }), /signature/);
  assert.throws(() => verifyAssertion(a.assertion(client, { count: 3 }), { ...expected, previousCounter: 3 }), /counter/);
  const wrongRp = a.assertion(client); const auth = Buffer.from(wrongRp.authenticatorData, 'base64'); auth[0] ^= 1; wrongRp.authenticatorData = auth.toString('base64');
  assert.throws(() => verifyAssertion(wrongRp, expected), /relying party/);
  assert.throws(() => parseAuthenticatorData(a.assertion(client, { flags: 0x0d }).authenticatorData), /Backup-eligible/);
});

test('ADR6 installed consent is enrolled only after proof-of-possession, binds the displayed policy, and never trusts a fixture assertion', () => {
  const host = new ControlHost({ root: ownedDir(join(tmpdir(), 'deszo-webauthn-')), time: manualTimeSource(), assurance: 'bootstrap' });
  const peer = { pid: 123, creationTime: 'fixture-process', userSid: 'fixture-user', protectedBroker: true };
  const consent = new WebAuthnConsent({ host, requireBroker: p => { assert.equal(p.protectedBroker, true); } }), a = authenticator();
  try {
    const start = consent.enrollmentBegin(peer), proofRequest = consent.enrollmentPrepare({ challengeId: start.challengeId, attestation: a.attestation(start) }, peer);
    assert.equal(consent.credential(), undefined, 'Creation alone must not pin an unproved key.');
    const bad = a.assertion(proofRequest.clientDataJSON); bad.signature = randomBytes(72).toString('base64');
    assert.throws(() => consent.enrollmentFinish({ challengeId: proofRequest.challengeId, assertion: bad }, peer), /signature/);
    consent.enrollmentFinish({ challengeId: proofRequest.challengeId, assertion: a.assertion(proofRequest.clientDataJSON) }, peer);
    assert.equal(consent.credential().credential_id, a.id);
    assert.throws(() => consent.enrollmentBegin(peer), /already enrolled/);
    const controller = generateKeyPairSync('ed25519');
    const proposal = host.proposePolicy({ controller: { controllerId: 'controller', publicKey: controller.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
      scope: { dataProfile: 'pilot', workspaces: [{ workspaceId: 'main', cwdIdentity: 'a'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'b'.repeat(64), permittedRevisions: [] }], operations: ['run.approve'], commands: [], desktop: { user: peer.userSid, sessionId: 1 }, buildRoot: 'C:/builds', applicationMode: 'separate_preview', deliveryBoundary: 'candidate' },
      limits: { attempts: 2, providerInvocations: 3, workerModelCalls: 0, operations: 10, restarts: 1, repairs: 0, builds: 1 }, durationMs: 43200000 });
    const request = consent.policyChallenge({ challengeId: proposal.challengeId }, peer), assertion = a.assertion(request.clientDataJSON);
    assert.throws(() => consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: 'f'.repeat(64), assertion }, peer), /displayed decision/);
    assert.equal(host.all('SELECT * FROM policies').length, 0);
    const receipt = consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion }, peer);
    assert.equal(receipt.policyId, proposal.decision.policyId);
    assert.equal(receipt.expiresAt, proposal.decision.expiresAt);
    assert.throws(() => host.authorizePolicy({ challengeId: proposal.challengeId, assertion: {} }), /protected WebAuthn broker/);
    assert.equal(host.status(receipt.policyId).used.attempts, 0);
  } finally { host.close(); }
});
