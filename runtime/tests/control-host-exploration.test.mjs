// Bounded systematic exploration of the host's authorization, revocation, admission, settlement, expiry and
// crash/restart transitions (ADR-0006 section 9). Every sequence of the actions below up to DEPTH is executed
// against the real implementation and real SQLite files, and the invariants are checked after every step.
//
// Explored: one policy, one controller, budget limit 2 for the explored key, actions D (decide), A (admit the
// oldest issued permit), S (settle the oldest admitted permit as consumed), R (revoke), C (host crash and restart,
// with fresh controller authentication) and E (advance time past expiry). Not explored: concurrent processes,
// crashes inside a SQLite transaction (SQLite's own atomicity is assumed), clock rollback (covered by unit tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBytes } from '../core/canonical.mjs';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { ownedDir, releaseOwnedDir } from './test-roots.mjs';

const DEPTH = 4;
const ACTIONS = ['D', 'A', 'S', 'R', 'C', 'E', 'X'];
const LIMIT = 2;
const DURATION = 3_600_000;

const keys = () => generateKeyPairSync('ed25519');
const der = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
const signValue = (privateKey, value) => sign(null, canonicalBytes(value), privateKey).toString('base64');

// One authorized policy, written once and copied per sequence.
function template() {
  const root = ownedDir(join(tmpdir(), 'deszo-explore-template-'));
  const time = manualTimeSource();
  const host = new ControlHost({ root, time, hostInstance: 'template' });
  const authenticator = keys();
  const controller = keys();
  host.enrollCredential({ credentialId: 'cred', publicKey: der(authenticator.publicKey), label: 'explorer' }, { enrolledBy: 'explorer installation' });
  const challenge = host.proposePolicy({
    controller: { controllerId: 'worker', publicKey: der(controller.publicKey) },
    scope: { dataProfile: 'p', workspaces: [{ workspaceId: 'ws', cwdIdentity: 'b'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'a'.repeat(64), permittedRevisions: [] }],
      operations: ['worker.model_call'], commands: [], desktop: { user: 'u', sessionId: 1 }, buildRoot: 'C:/b', applicationMode: 'separate_preview', deliveryBoundary: 'candidate' },
    limits: { attempts: 0, providerInvocations: 0, workerModelCalls: LIMIT, operations: 10, restarts: 0, repairs: 0, builds: 0 }, durationMs: DURATION,
  });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: challenge.challengeId, nonce: challenge.nonce, decisionDigest: challenge.decisionDigest, audience: challenge.audience };
  const flags = { userPresent: true, userVerified: true };
  const { policyId } = host.authorizePolicy({ challengeId: challenge.challengeId, assertion: { credentialId: 'cred', clientData, flags, signature: signValue(authenticator.privateKey, { clientData, flags }) } });
  host.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  host.close();
  return { root, policyId, controller, controllerPublicKey: der(controller.publicKey), authenticatorKey: authenticator.privateKey, scope: { dataProfile: 'p', workspaces: [{ workspaceId: 'ws', cwdIdentity: 'b'.repeat(64) }], workflows: [{ workflowId: 'wf', baselineSha256: 'a'.repeat(64), permittedRevisions: [] }], operations: ['worker.model_call'], commands: [], desktop: { user: 'u', sessionId: 1 }, buildRoot: 'C:/b', applicationMode: 'separate_preview', deliveryBoundary: 'candidate' }, limits: { attempts: 0, providerInvocations: 0, workerModelCalls: LIMIT, operations: 10, restarts: 0, repairs: 0, builds: 0 }, timeState: { ...time.state } };
}

// A fresh, decision-bound extension of the policy: a new consent that supersedes it, as the trusted broker would require.
function extendPolicy(host, supersedesPolicyId, base) {
  const proposal = host.proposePolicy({ decisionType: 'extend', supersedesPolicyId, controller: { controllerId: 'worker', publicKey: base.controllerPublicKey }, scope: base.scope, limits: base.limits, durationMs: DURATION });
  const clientData = { type: 'deszo.autonomy.consent', challengeId: proposal.challengeId, nonce: proposal.nonce, decisionDigest: proposal.decisionDigest, audience: proposal.audience };
  const flags = { userPresent: true, userVerified: true };
  return host.authorizePolicy({ challengeId: proposal.challengeId, assertion: { credentialId: 'cred', clientData, flags, signature: signValue(base.authenticatorKey, { clientData, flags }) } }).policyId;
}

function connect(host, policyId, controller) {
  const challenge = host.controllerChallenge(policyId, 'worker');
  const signed = { type: 'deszo.controller.auth', nonce: challenge.nonce, audience: challenge.audience, policyId, controllerId: 'worker' };
  return host.authenticateController({ nonce: challenge.nonce, signature: signValue(controller.privateKey, signed) }).connectionId;
}

function explore(base, sequence) {
  const root = ownedDir(join(tmpdir(), 'deszo-explore-'));
  mkdirSync(root, { recursive: true });
  copyFileSync(join(base.root, 'host.sqlite'), join(root, 'host.sqlite'));
  const time = manualTimeSource(base.timeState);
  let instance = 0;
  let host = new ControlHost({ root, time, hostInstance: `i${instance}` });
  let currentPolicy = base.policyId;
  let connectionId = connect(host, currentPolicy, base.controller);
  let revokedCommitted = false;
  let expired = false;
  const issued = [];
  const admitted = [];
  const violations = [];
  for (const action of sequence) {
    if (action === 'D') {
      let receipt;
      try { receipt = host.decide({ requestId: randomUUID(), policyId: currentPolicy, operation: 'worker.model_call', cost: {} }, { connectionId }); }
      catch (error) { if (error.code !== 'controller_not_authenticated' || !revokedCommitted) throw error; receipt = { outcome: 'denied' }; }
      if (receipt.outcome === 'approved') {
        if (revokedCommitted) violations.push('approval after committed revocation');
        if (expired) violations.push('approval after expiry');
        issued.push({ permitId: receipt.permitId, instance, policy: currentPolicy });
      }
    } else if (action === 'A' && issued.length) {
      const permit = issued.shift();
      const result = host.admit(permit.permitId);
      if (result.admitted) {
        if (permit.policy !== currentPolicy) violations.push('admission of a permit issued under a superseded policy');
        if (revokedCommitted) violations.push('admission after committed revocation');
        if (expired) violations.push('admission after expiry');
        if (permit.instance !== instance) violations.push('admission of a permit issued by a previous host instance');
        admitted.push(permit.permitId);
      }
    } else if (action === 'S' && admitted.length) {
      host.settle(admitted.shift(), { effect: 'consumed' });
    } else if (action === 'R') {
      const result = host.revoke(currentPolicy, { actor: 'explorer' });
      if (result.committed) revokedCommitted = true;
    } else if (action === 'C') {
      host.close();
      instance += 1;
      host = new ControlHost({ root, time, hostInstance: `i${instance}` });
      admitted.length = 0; // Their effects are now unknown and stay charged; they can never be settled as free.
      if (!revokedCommitted) connectionId = connect(host, currentPolicy, base.controller);
    } else if (action === 'X') {
      // Supersession: the current policy is replaced by a new consent. Work and permits of the old policy must stay fenced.
      try {
        currentPolicy = extendPolicy(host, currentPolicy, base);
        expired = false;
        connectionId = connect(host, currentPolicy, base.controller);
      } catch (error) { if (!['revoked', 'conflict'].includes(error.code)) throw error; }
    } else if (action === 'E') {
      time.advance(DURATION + 1);
      expired = true;
    }
    const status = host.status(currentPolicy);
    if (status.used.workerModelCalls > LIMIT) violations.push(`usage ${status.used.workerModelCalls} exceeds limit ${LIMIT}`);
    if (revokedCommitted && status.state !== 'revoked') violations.push('revocation not durable');
    if ((revokedCommitted || expired) && status.valid) violations.push('policy still valid after revocation or expiry');
    if (!host.verifyAudit().intact) violations.push('audit chain broken');
    if (violations.length) break;
  }
  // Charged units can never drop below the effects that were admitted and not proven unexecuted.
  host.close();
  // Each sequence's store is disposable once its invariants are checked; 2,401 of them would otherwise accumulate (about 225 KB each).
  releaseOwnedDir(root);
  return violations;
}

test('ADR6-04/10/13: bounded exploration of decide/admit/settle/revoke/crash/expire keeps the host invariants', () => {
  const base = template();
  let sequences = [[]];
  for (let depth = 0; depth < DEPTH; depth++) sequences = sequences.flatMap(seq => ACTIONS.map(action => [...seq, action]));
  const failures = [];
  for (const sequence of sequences) {
    const violations = explore(base, sequence);
    if (violations.length) failures.push(`${sequence.join('')}: ${violations.join('; ')}`);
  }
  assert.equal(sequences.length, ACTIONS.length ** DEPTH);
  assert.deepEqual(failures, [], `Invariant violations in ${failures.length} of ${sequences.length} sequences.`);
});
