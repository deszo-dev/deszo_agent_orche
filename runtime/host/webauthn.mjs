// Win32 WebAuthn verification at the protected service boundary. The broker never asserts its own UV boolean.
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { canonicalHash, canonicalize } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';

export const RP_ID = 'deszo.local';
export const ORIGIN = 'https://deszo.local';
const sha = value => createHash('sha256').update(value).digest();
const encoded = value => Buffer.from(value).toString('base64url');
const fail = message => { throw new HostError(403, 'webauthn_refused', message); };
function bytes(value) {
  if (typeof value !== 'string' || value.length > 256_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('Invalid authenticator encoding.');
  return Buffer.from(value, 'base64');
}
// Only bounded definite-length CBOR is accepted. Duplicate map keys and indefinite encodings are refused.
export function decodeCbor(buffer, offset = 0, depth = 0) {
  if (depth > 12 || offset >= buffer.length) fail('Invalid credential CBOR.');
  const first = buffer[offset++], major = first >> 5, info = first & 31;
  let count = info;
  if (info === 24) { if (offset + 1 > buffer.length) fail('Truncated CBOR.'); count = buffer[offset++]; }
  else if (info === 25) { if (offset + 2 > buffer.length) fail('Truncated CBOR.'); count = buffer.readUInt16BE(offset); offset += 2; }
  else if (info === 26) { if (offset + 4 > buffer.length) fail('Truncated CBOR.'); count = buffer.readUInt32BE(offset); offset += 4; }
  else if (info >= 27) fail('Unsupported credential CBOR.');
  if (count > 65536) fail('CBOR exceeds the credential bound.');
  if (major === 0 || major === 1) return { value: major === 0 ? count : -1 - count, offset };
  if (major === 2 || major === 3) {
    if (offset + count > buffer.length) fail('Truncated CBOR bytes.');
    const value = buffer.subarray(offset, offset + count);
    return { value: major === 2 ? value : value.toString('utf8'), offset: offset + count };
  }
  if (major === 5) {
    if (count > 32) fail('Credential map is too large.');
    const map = new Map();
    for (let i = 0; i < count; i++) {
      const key = decodeCbor(buffer, offset, depth + 1); offset = key.offset;
      if (!['string', 'number'].includes(typeof key.value) || map.has(key.value)) fail('Invalid or duplicate credential key.');
      const item = decodeCbor(buffer, offset, depth + 1); offset = item.offset; map.set(key.value, item.value);
    }
    return { value: map, offset };
  }
  fail('Unsupported credential structure.');
}
export function parseAuthenticatorData(authenticatorData, { attested = false } = {}) {
  const data = bytes(authenticatorData);
  if (data.length < 37 || !timingSafeEqual(data.subarray(0, 32), sha(RP_ID))) fail('Wrong relying party.');
  const flags = data[32];
  if ((flags & 5) !== 5) fail('User presence and verification are required.');
  // The initial profile uses a local platform credential. Synced/backup credentials need a separate trust decision.
  if (flags & 0x18) fail('Backup-eligible credentials are outside the initial trust profile.');
  const signCount = data.readUInt32BE(33);
  if (!attested) return { raw: data, signCount, flags };
  if (!(flags & 0x40) || data.length < 55) fail('Attested credential data is missing.');
  const length = data.readUInt16BE(53), start = 55;
  if (!length || start + length >= data.length) fail('Invalid attested credential ID.');
  const credentialId = data.subarray(start, start + length).toString('base64');
  const cose = decodeCbor(data, start + length);
  const key = cose.value;
  if (!(key instanceof Map) || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1 || !Buffer.isBuffer(key.get(-2)) || key.get(-2).length !== 32 || !Buffer.isBuffer(key.get(-3)) || key.get(-3).length !== 32) fail('Only ES256/P-256 platform credentials are supported.');
  const jwk = { kty: 'EC', crv: 'P-256', x: encoded(key.get(-2)), y: encoded(key.get(-3)) };
  createPublicKey({ key: jwk, format: 'jwk' });
  return { credentialId, jwk, signCount, flags, aaguid: data.subarray(37, 53).toString('hex') };
}
export function verifyAssertion(assertion, { credentialId, jwk, expectedClientDataJSON, previousCounter = 0 }) {
  if (assertion?.credentialId !== credentialId) fail('The assertion uses an unenrolled credential.');
  const client = bytes(assertion.clientDataJSON), expected = Buffer.from(expectedClientDataJSON);
  if (client.length !== expected.length || !timingSafeEqual(client, expected)) fail('Wrong challenge, origin, purpose or decision.');
  const parsedClient = JSON.parse(client.toString('utf8'));
  if (parsedClient.type !== 'webauthn.get' || parsedClient.origin !== ORIGIN || parsedClient.crossOrigin !== false) fail('Wrong WebAuthn client context.');
  const auth = parseAuthenticatorData(assertion.authenticatorData);
  if (previousCounter > 0 && auth.signCount <= previousCounter) fail('The authenticator counter did not advance.');
  if (!verify('sha256', Buffer.concat([auth.raw, sha(client)]), createPublicKey({ key: jwk, format: 'jwk' }), bytes(assertion.signature))) fail('Authenticator signature does not verify.');
  return { signCount: auth.signCount, flags: auth.flags, assertionSha256: canonicalHash(assertion) };
}

export class WebAuthnConsent {
  constructor({ host, requireBroker }) { Object.assign(this, { host, requireBroker }); }
  broker(peer) { this.requireBroker(peer); return peer; }
  credential() { return this.host.get('SELECT * FROM webauthn_credentials WHERE retired_at IS NULL ORDER BY enrolled_at DESC LIMIT 1'); }
  issue(purpose, peer, { policyChallengeId = null, decisionDigest = null, pendingCredential = null, type = 'webauthn.get' } = {}) {
    const challengeId = randomUUID();
    const binding = { challengeId, nonce: randomBytes(32).toString('hex'), audience: this.host.audience, purpose, policyChallengeId, decisionDigest };
    const clientDataJSON = JSON.stringify({ type, challenge: encoded(sha(canonicalize(binding))), origin: ORIGIN, crossOrigin: false });
    this.host.run('INSERT INTO native_consent_challenges(challenge_id,purpose,policy_challenge_id,client_data_json,decision_digest,pending_credential_json,broker_identity_json,boot_id,uptime_deadline_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      challengeId, purpose, policyChallengeId, clientDataJSON, decisionDigest, pendingCredential ? canonicalize(pendingCredential) : null, canonicalize(peer), this.host.time.bootId(), this.host.time.uptimeMs() + 300_000, new Date(this.host.time.wallNow()).toISOString());
    return { challengeId, clientDataJSON, decisionDigest };
  }
  pending(challengeId, purpose, peer, { allowConsumed = false } = {}) {
    this.broker(peer);
    const row = this.host.get('SELECT * FROM native_consent_challenges WHERE challenge_id = ? AND purpose = ?', challengeId, purpose);
    if (!row || (row.consumed_at && !allowConsumed) || row.boot_id !== this.host.time.bootId() || (!row.consumed_at && row.uptime_deadline_ms <= this.host.time.uptimeMs())) fail('Missing, consumed or expired consent challenge.');
    const original = JSON.parse(row.broker_identity_json);
    if (original.userSid !== peer.userSid || original.pid !== peer.pid || original.creationTime !== peer.creationTime) fail('The challenge belongs to another broker process.');
    return row;
  }
  enrollmentBegin(peer) {
    this.broker(peer);
    if (this.credential()) fail('A credential is already enrolled. Replacement requires an explicit verified retirement procedure.');
    const challenge = this.issue('enroll', peer, { type: 'webauthn.create' });
    return { ...challenge, userIdBase64: sha(peer.userSid).toString('base64'), userName: peer.userSid, purpose: 'Enroll the initial Windows Hello credential for Deszo Local Control Host', rpId: RP_ID };
  }
  enrollmentPrepare({ challengeId, attestation }, peer) {
    const row = this.pending(challengeId, 'enroll', peer);
    if (bytes(attestation.clientDataJSON).toString('utf8') !== row.client_data_json) fail('Enrollment client data was substituted.');
    const credential = parseAuthenticatorData(attestation.authenticatorData, { attested: true });
    if (credential.credentialId !== attestation.credentialId) fail('Enrollment credential ID differs from authenticator data.');
    // An untrusted attestation format never establishes authority: a fresh assertion with this key is mandatory.
    return this.host.transaction(() => {
      this.host.run('UPDATE native_consent_challenges SET consumed_at = ? WHERE challenge_id = ?', new Date(this.host.time.wallNow()).toISOString(), challengeId);
      return { ...this.issue('enroll_proof', peer, { pendingCredential: credential }), credentialId: credential.credentialId };
    });
  }
  enrollmentFinish({ challengeId, assertion }, peer) {
    const row = this.pending(challengeId, 'enroll_proof', peer), credential = JSON.parse(row.pending_credential_json);
    const proof = verifyAssertion(assertion, { credentialId: credential.credentialId, jwk: credential.jwk, expectedClientDataJSON: row.client_data_json });
    return this.host.transaction(() => {
      if (this.credential()) fail('Enrollment was completed concurrently.');
      const at = new Date(this.host.time.wallNow()).toISOString();
      this.host.run('INSERT INTO webauthn_credentials(credential_id,public_key_jwk_json,user_sid,rp_id,sign_count,enrollment_evidence_json,enrolled_at) VALUES(?,?,?,?,?,?,?)', credential.credentialId, canonicalize(credential.jwk), peer.userSid, RP_ID, proof.signCount, canonicalize({ broker: peer, proof, aaguid: credential.aaguid }), at);
      this.host.run('UPDATE native_consent_challenges SET consumed_at = ?, receipt_json = ? WHERE challenge_id = ?', at, canonicalize({ enrolled: true, credentialId: credential.credentialId }), challengeId);
      this.host.audit('consent.webauthn_enrolled', { credentialId: credential.credentialId, userSid: peer.userSid, proof });
      return { enrolled: true, credentialId: credential.credentialId };
    });
  }
  policyChallenge({ challengeId }, peer) {
    this.broker(peer); const credential = this.credential(); if (!credential || credential.user_sid !== peer.userSid) fail('Enroll the authorized user first.');
    const policy = this.host.get('SELECT * FROM consent_challenges WHERE challenge_id = ? AND consumed_at IS NULL', challengeId);
    if (!policy || Date.parse(policy.expires_at) <= this.host.time.wallNow()) fail('The policy proposal expired.');
    return { ...this.issue('policy', peer, { policyChallengeId: challengeId, decisionDigest: policy.decision_digest }), credentialId: credential.credential_id, decision: JSON.parse(policy.decision_json) };
  }
  authorizePolicy({ challengeId, displayedDecisionDigest, assertion }, peer) {
    const row = this.pending(challengeId, 'policy', peer, { allowConsumed: true }), credential = this.credential();
    if (!row.policy_challenge_id) fail('This challenge is not a policy decision.');
    if (row.consumed_at) {
      const saved = JSON.parse(row.pending_credential_json || '{}');
      if (saved.assertionSha256 !== canonicalHash(assertion) || displayedDecisionDigest !== row.decision_digest) fail('A consumed decision cannot be substituted.');
      return { ...JSON.parse(row.receipt_json), replayed: true };
    }
    if (!credential || displayedDecisionDigest !== row.decision_digest) fail('The displayed decision differs from the signed decision.');
    const proof = verifyAssertion(assertion, { credentialId: credential.credential_id, jwk: JSON.parse(credential.public_key_jwk_json), expectedClientDataJSON: row.client_data_json, previousCounter: credential.sign_count });
    return this.host.transaction(() => {
      const receipt = this.host.commitVerifiedConsent(row.policy_challenge_id, { mechanism: 'win32-webauthn', credentialId: credential.credential_id, userSid: peer.userSid, broker: peer, displayedDecisionDigest, proof });
      this.host.run('UPDATE webauthn_credentials SET sign_count = ? WHERE credential_id = ?', proof.signCount, credential.credential_id);
      this.host.run('UPDATE native_consent_challenges SET consumed_at = ?, receipt_json = ?, pending_credential_json = ? WHERE challenge_id = ?', new Date(this.host.time.wallNow()).toISOString(), canonicalize(receipt), canonicalize({ assertionSha256: proof.assertionSha256 }), challengeId);
      return receipt;
    });
  }
  receipt({ policyChallengeId, decisionDigest }, peer) {
    this.broker(peer);
    const row = this.host.get('SELECT receipt_json, decision_digest FROM native_consent_challenges WHERE policy_challenge_id = ? AND consumed_at IS NOT NULL AND receipt_json IS NOT NULL', policyChallengeId);
    if (!row || row.decision_digest !== decisionDigest) fail('No matching committed consent receipt exists.');
    // Observation of a previously committed receipt cannot extend expiry or create fresh authority.
    return { ...JSON.parse(row.receipt_json), reconciled: true };
  }
  retirementBegin(peer) {
    this.broker(peer); const credential = this.credential(); if (!credential || credential.user_sid !== peer.userSid) fail('No active credential belongs to this user.');
    const decision = { action: 'retire_credential_and_revoke_all_policies', credentialId: credential.credential_id, userSid: peer.userSid, audience: this.host.audience };
    return { ...this.issue('policy', peer, { decisionDigest: canonicalHash(decision), pendingCredential: decision }), credentialId: credential.credential_id, decision };
  }
  retirementFinish({ challengeId, displayedDecisionDigest, assertion }, peer) {
    const row = this.pending(challengeId, 'policy', peer), decision = JSON.parse(row.pending_credential_json || '{}'), credential = this.credential();
    if (row.policy_challenge_id || decision.action !== 'retire_credential_and_revoke_all_policies' || !credential || decision.credentialId !== credential.credential_id || displayedDecisionDigest !== row.decision_digest) fail('Wrong credential-retirement decision.');
    const proof = verifyAssertion(assertion, { credentialId: credential.credential_id, jwk: JSON.parse(credential.public_key_jwk_json), expectedClientDataJSON: row.client_data_json, previousCounter: credential.sign_count });
    const result = this.host.transaction(() => {
      const at = new Date(this.host.time.wallNow()).toISOString(), ids = this.host.all("SELECT policy_id FROM policies WHERE state = 'active'").map(p => p.policy_id);
      for (const id of ids) { this.host.closedBarriers.add(id); this.host.run("UPDATE policies SET state='revoked', revocation_generation=revocation_generation+1, revoked_at=?, revoked_by=? WHERE policy_id=?", at, `credential retirement ${credential.credential_id}`, id); }
      const scope = this.host.closePolicies(ids, at);
      this.host.run('UPDATE webauthn_credentials SET retired_at=?, sign_count=? WHERE credential_id=?', at, proof.signCount, credential.credential_id);
      const receipt = { retired: true, credentialId: credential.credential_id, revokedPolicies: ids };
      this.host.run('UPDATE native_consent_challenges SET consumed_at=?, receipt_json=? WHERE challenge_id=?', at, canonicalize(receipt), challengeId);
      this.host.audit('consent.credential_retired', { ...receipt, proof, scope }); return { receipt, scope, ids };
    });
    for (const [id, connection] of this.host.controllerConnections) if (result.ids.includes(connection.policyId)) this.host.controllerConnections.delete(id);
    this.host.onStop?.(result.scope.permits, result.scope.works, { policyIds: result.ids });
    return result.receipt;
  }
}
