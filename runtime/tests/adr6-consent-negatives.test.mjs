// ADR-0006 consent negatives on the installed-consent path: abandoned, expired and foreign enrollment challenges; replacement
// without retirement; counter rollback; consumed decisions and lost replies; proposal expiry; retirement with a displayed-digest
// mismatch or a foreign key. Fixture scope: a software authenticator with the real byte layout and a simulated protected broker.
// These tests do not produce Windows Hello evidence; that is a separate, human-assisted verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { WebAuthnConsent } from '../host/webauthn.mjs';
import { authenticator } from './webauthn-fixture.mjs';
import { ownedDir } from './test-roots.mjs';

const ENROLL_WINDOW_MS = 300_000;
const BROKER_USER = 'fixture-user';
const requireBroker = peer => { if (peer.protectedBroker !== true) throw new Error('Consent requires the protected WebAuthn broker.'); };
const broker = (overrides = {}) => ({ pid: 123, creationTime: 'fixture-process', userSid: BROKER_USER, protectedBroker: true, ...overrides });

function setup() {
  const time = manualTimeSource();
  const host = new ControlHost({ root: ownedDir(join(tmpdir(), 'deszo-consent-negatives-')), time, assurance: 'bootstrap' });
  return { time, host, consent: new WebAuthnConsent({ host, requireBroker }) };
}

// Enrolls one credential through the full two-step proof, with the given assertion counter.
function enroll(consent, auth, peer, count = 0) {
  const start = consent.enrollmentBegin(peer);
  const proofRequest = consent.enrollmentPrepare({ challengeId: start.challengeId, attestation: auth.attestation(start) }, peer);
  return consent.enrollmentFinish({ challengeId: proofRequest.challengeId, assertion: auth.assertion(proofRequest.clientDataJSON, { count }) }, peer);
}

// Proposes a policy for the fixture user. The controller key is generated per call; the scope matches the pilot shape.
function proposal(host) {
  const controller = generateKeyPairSync('ed25519');
  return host.proposePolicy({
    controller: { controllerId: 'controller', publicKey: controller.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
    scope: { dataProfile: 'pilot', workspaces: [{ workspaceId: 'main', cwdIdentity: 'a'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'b'.repeat(64), permittedRevisions: [] }], operations: ['run.approve'], commands: [], desktop: { user: BROKER_USER, sessionId: 1 }, buildRoot: 'C:/builds', applicationMode: 'separate_preview', deliveryBoundary: 'candidate' },
    limits: { attempts: 2, providerInvocations: 3, workerModelCalls: 0, operations: 10, restarts: 1, repairs: 0, builds: 1 },
    durationMs: 43_200_000,
  });
}

test('ADR6 consent negatives: an abandoned, foreign, expired or reused enrollment challenge pins nothing and completes nothing', () => {
  const { time, host, consent } = setup(), auth = authenticator(), peer = broker();
  try {
    assert.throws(() => consent.enrollmentBegin(broker({ protectedBroker: false })), /protected WebAuthn broker/, 'Enrollment needs the protected broker.');
    const abandoned = consent.enrollmentBegin(peer);
    assert.equal(consent.credential(), undefined, 'An abandoned enrollment pins nothing.');
    assert.throws(() => consent.enrollmentPrepare({ challengeId: abandoned.challengeId, attestation: auth.attestation(abandoned) }, broker({ pid: 456 })), /another broker process/, 'A challenge from another broker process is refused.');
    time.advance(ENROLL_WINDOW_MS + 1);
    assert.throws(() => consent.enrollmentPrepare({ challengeId: abandoned.challengeId, attestation: auth.attestation(abandoned) }, peer), /Missing, consumed or expired/, 'An expired challenge is refused.');
    assert.equal(consent.credential(), undefined);

    const start = consent.enrollmentBegin(peer);
    const proofRequest = consent.enrollmentPrepare({ challengeId: start.challengeId, attestation: auth.attestation(start) }, peer);
    assert.throws(() => consent.enrollmentPrepare({ challengeId: start.challengeId, attestation: auth.attestation(start) }, peer), /Missing, consumed or expired/, 'A consumed enrollment challenge cannot be prepared again.');
    assert.equal(consent.credential(), undefined, 'Preparing a proof still pins nothing.');
    consent.enrollmentFinish({ challengeId: proofRequest.challengeId, assertion: auth.assertion(proofRequest.clientDataJSON) }, peer);
    assert.equal(consent.credential().credential_id, auth.id);
  } finally { host.close(); }
});

test('ADR6 consent negatives: a second enrollment is refused, a counter that does not advance is refused, and a consumed decision cannot be substituted', () => {
  const { host, consent } = setup(), auth = authenticator(), peer = broker();
  try {
    enroll(consent, auth, peer, 4);
    assert.equal(consent.credential().sign_count, 4);
    assert.throws(() => consent.enrollmentBegin(peer), /already enrolled/, 'Replacement needs an explicit verified retirement.');

    const first = proposal(host);
    const request = consent.policyChallenge({ challengeId: first.challengeId }, peer);
    assert.throws(() => consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: auth.assertion(request.clientDataJSON, { count: 4 }) }, peer), /counter did not advance/, 'A stale counter is refused.');
    assert.equal(host.all('SELECT * FROM policies').length, 0, 'A refused assertion authorizes nothing.');
    assert.equal(consent.credential().sign_count, 4, 'A refused assertion does not move the counter.');

    const signed = auth.assertion(request.clientDataJSON, { count: 5 });
    const receipt = consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: signed }, peer);
    assert.equal(consent.credential().sign_count, 5);

    const replay = consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: signed }, peer);
    assert.equal(replay.replayed, true, 'A lost reply repeats the same signed assertion and gets the committed receipt.');
    assert.equal(replay.policyId, receipt.policyId);
    assert.equal(replay.expiresAt, receipt.expiresAt, 'A replay never extends expiry.');
    assert.equal(consent.credential().sign_count, 5, 'A replay does not move the counter.');
    assert.throws(() => consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: auth.assertion(request.clientDataJSON, { count: 6 }) }, peer), /cannot be substituted/, 'A different assertion for a consumed decision is refused.');
    assert.equal(host.status(receipt.policyId).used.attempts, 0);
  } finally { host.close(); }
});

test('ADR6 consent negatives: a receipt is reconciled only for a committed decision with the displayed digest, and never extends expiry', () => {
  const { host, consent } = setup(), auth = authenticator(), peer = broker();
  try {
    enroll(consent, auth, peer, 0);
    const first = proposal(host);
    assert.throws(() => consent.receipt({ policyChallengeId: first.challengeId, decisionDigest: 'f'.repeat(64) }, peer), /No matching committed consent receipt/, 'Nothing is reconciled before a decision is committed.');
    const request = consent.policyChallenge({ challengeId: first.challengeId }, peer);
    const receipt = consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: auth.assertion(request.clientDataJSON, { count: 1 }) }, peer);
    const reconciled = consent.receipt({ policyChallengeId: first.challengeId, decisionDigest: request.decisionDigest }, peer);
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.policyId, receipt.policyId);
    assert.equal(reconciled.expiresAt, receipt.expiresAt, 'Observing a committed receipt never extends expiry.');
    assert.throws(() => consent.receipt({ policyChallengeId: first.challengeId, decisionDigest: 'f'.repeat(64) }, peer), /No matching committed consent receipt/, 'A different displayed digest is not reconciled.');
  } finally { host.close(); }
});

test('ADR6 consent negatives: a proposal that expires before the user answers cannot be authorized', () => {
  const { time, host, consent } = setup(), auth = authenticator(), peer = broker();
  try {
    enroll(consent, auth, peer, 0);
    const first = proposal(host);
    const row = host.get('SELECT expires_at FROM consent_challenges WHERE challenge_id = ?', first.challengeId);
    time.advance(Date.parse(row.expires_at) - time.wallNow() + 1);
    assert.throws(() => consent.policyChallenge({ challengeId: first.challengeId }, peer), /proposal expired/, 'An expired proposal gets no signing challenge.');
    assert.equal(host.all('SELECT * FROM policies').length, 0);
  } finally { host.close(); }
});

test('ADR6 consent negatives: retirement needs the displayed digest and a fresh assertion from the enrolled key, revokes policies, and only then allows replacement', () => {
  const { host, consent } = setup(), auth = authenticator(), replacement = authenticator(), peer = broker();
  try {
    enroll(consent, auth, peer, 0);
    const first = proposal(host);
    const request = consent.policyChallenge({ challengeId: first.challengeId }, peer);
    const receipt = consent.authorizePolicy({ challengeId: request.challengeId, displayedDecisionDigest: request.decisionDigest, assertion: auth.assertion(request.clientDataJSON, { count: 1 }) }, peer);

    const retirement = consent.retirementBegin(peer);
    assert.throws(() => consent.retirementFinish({ challengeId: retirement.challengeId, displayedDecisionDigest: 'f'.repeat(64), assertion: auth.assertion(retirement.clientDataJSON, { count: 2 }) }, peer), /Wrong credential-retirement/, 'A displayed digest that differs from the retirement decision retires nothing.');
    assert.ok(consent.credential(), 'The credential is still active.');
    assert.equal(host.get('SELECT state FROM policies WHERE policy_id = ?', receipt.policyId).state, 'active');
    assert.throws(() => consent.retirementFinish({ challengeId: retirement.challengeId, displayedDecisionDigest: retirement.decisionDigest, assertion: replacement.assertion(retirement.clientDataJSON, { count: 2 }) }, peer), /signature|credential/i, 'A key other than the enrolled one cannot retire it.');
    assert.ok(consent.credential(), 'A foreign key leaves the credential active.');

    const done = consent.retirementFinish({ challengeId: retirement.challengeId, displayedDecisionDigest: retirement.decisionDigest, assertion: auth.assertion(retirement.clientDataJSON, { count: 2 }) }, peer);
    assert.equal(done.retired, true);
    assert.deepEqual(done.revokedPolicies, [receipt.policyId]);
    assert.equal(consent.credential(), undefined);
    assert.equal(host.get('SELECT state FROM policies WHERE policy_id = ?', receipt.policyId).state, 'revoked');
    assert.throws(() => consent.policyChallenge({ challengeId: first.challengeId }, peer), /Enroll the authorized user first/, 'A retired credential signs nothing.');
    assert.throws(() => consent.retirementBegin(peer), /No active credential/);

    enroll(consent, replacement, peer, 0);
    assert.equal(consent.credential().credential_id, replacement.id, 'Replacement is possible only after verified retirement.');
  } finally { host.close(); }
});
