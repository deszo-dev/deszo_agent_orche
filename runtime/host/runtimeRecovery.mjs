// A replacement Node process authenticates through the installed native pipe. No old nonce or caller-supplied
// process identity authorizes it. Service recovery invalidates this path: a fresh application launch is then needed.
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from '../core/canonical.mjs';
import { HostError, sameProcess } from './authority.mjs';

const requireIdentity = (value, message) => { if (!value) throw new HostError(403, 'runtime_recovery_refused', message); };

export async function reregisterInstalledRuntime({ host, installation, native, lifecycle, peer, policyId }) {
  const actual = peer?.parent;
  requireIdentity(peer?.verifiedByService && peer.nativeMode === 'client' && actual?.imageSha256 === installation.files['node.exe'], 'Only the independently observed pinned Node peer may recover a runtime.');
  const status = host.status(policyId), policy = JSON.parse(host.policyRow(policyId).decision_json);
  requireIdentity((host.assurance !== 'bootstrap'||policy.scope.verificationOnly===true) && status.valid && !host.closedBarriers.has(policyId) && !host.dispatchBlocked, 'Runtime recovery needs live, enabled, reconciled original authority.');
  requireIdentity(!actual.administratorMember && actual.integritySid === 'S-1-16-8192' && actual.userSid === policy.scope.desktop.user && actual.sessionId === policy.scope.desktop.sessionId, 'The runtime token or desktop differs from consent.');
  const entries = [...host.runtimeRegistrations].filter(([, r]) => r.policyId === policyId && r.hostInstance === host.hostInstance && r.operationId);
  requireIdentity(entries.length === 1, 'No unique current application registration exists; request a fresh host application launch.');
  const [previousGeneration, previous] = entries[0], operation = host.operationRow(previous.operationId);
  requireIdentity(host.assurance!=='bootstrap'||previous.verificationOnly===true,'A bootstrap host cannot recover an execution-enabled generation.');
  requireIdentity(operation.policy_id === policyId && operation.outcome === 'verified', 'The application launch has not been verified.');
  const intent = JSON.parse(operation.intent_json), root = JSON.parse(operation.evidence_json).launch;
  requireIdentity(root && actual.parentPid === root.pid, 'The runtime must be a direct child of the original application.');
  const observedRoot = await native('inspect', { pid: root.pid });
  requireIdentity(sameProcess(root, observedRoot) && BigInt(observedRoot.creationTime) <= BigInt(actual.creationTime), 'The original application process no longer matches.');
  requireIdentity((await native('contains', { domain: policyId, pid: actual.pid })).contained && (await native('isRunning', { process: root })).running, 'The application/runtime lacks its native ownership.');
  await lifecycle.validateRuntimeSource(operation, peer);
  // Reconnection after a lost registration reply is scoped to this exact live OS process, not to its generation ID.
  if (sameProcess(previous.processEvidence, actual)) {
    requireIdentity(host.status(policyId).valid && !host.dispatchBlocked, 'Authority changed during native verification.');
    return { runtimeGeneration: previousGeneration, assurance: host.assurance, verificationOnly:previous.verificationOnly===true,replayed: true };
  }
  const previousState = await native('isRunning', { process: previous.processEvidence });
  requireIdentity(previousState.running === false && BigInt(actual.creationTime) > BigInt(previous.processEvidence.creationTime), 'The previous runtime is still alive or the replacement predates it.');
  requireIdentity(!host.get("SELECT work_id FROM active_work WHERE policy_id=? AND state='active'", policyId), 'Owned work must be stopped and reconciled before runtime replacement.');
  requireIdentity(!host.get("SELECT permit_id FROM permits WHERE policy_id=? AND state='admitted'", policyId) && !host.get("SELECT entry_id FROM budget_ledger WHERE policy_id=? AND state='unresolved'", policyId), 'An admitted or unknown effect needs reconciliation before runtime replacement.');
  requireIdentity(!host.get("SELECT operation_id FROM operations WHERE policy_id=? AND outcome IN ('in_progress','reconciling')", policyId), 'An application operation is unresolved.');
  // No await follows this point: native verification, the policy fence, charge, generation change and socket binding
  // cannot interleave with another service connection. A crash remains fail-stop and is reconciled on service startup.
  requireIdentity(host.runtimeRegistrations.get(previousGeneration) === previous, 'The runtime generation changed during verification.');
  const receipt = host.decide({ requestId: randomUUID(), policyId, runtimeGeneration: previousGeneration, operation: 'runtime.reregister', cost: {},
    target: { profile: intent.profile, applicationMode: intent.applicationMode, desktop: policy.scope.desktop, buildRoot: policy.scope.buildRoot, buildDir: intent.buildDir, buildId: intent.buildId, currentProcess: { pid: root.pid, creationTime: root.creationTime } },
    justification: 'Native-verified replacement of a terminated Node runtime under the original application and limits.' }, { runtime: { policyId, runtimeGeneration: previousGeneration } });
  requireIdentity(receipt.outcome === 'approved', `Original authority refused runtime recovery: ${receipt.reason}.`);
  const admission = host.admit(receipt.permitId);
  if (!admission.admitted) { host.settle(receipt.permitId, { effect: 'not_executed', evidence: `runtime recovery refused: ${admission.reason}` }); throw new HostError(403, 'runtime_recovery_refused', admission.reason); }
  const runtimeGeneration = randomUUID(), attachSecret = randomBytes(32).toString('hex');
  let recoveryOperation;
  try {
    recoveryOperation = host.beginOperation({ permitId: receipt.permitId, kind: 'runtime.reregister', intent: { applicationOperationId: previous.operationId, previousGeneration, process: actual } }).operationId;
    host.transaction(() => {
      host.releaseIssuedPermits(policyId, new Date(host.time.wallNow()).toISOString());
      host.audit('runtime.reregistered', { recoveryOperation, applicationOperationId: previous.operationId, previousGeneration, runtimeGeneration, processEvidence: actual,
        nativeEvidence: { root: observedRoot, previousRuntime: previous.processEvidence, previousRunning: false, contained: true } }, { policyId });
    });
    host.finishOperation(recoveryOperation, { outcome: 'verified', evidence: { verification: { complete: true, chain: ['native_pipe_peer', 'sealed_application_parent', 'native_ownership', 'exact_runtime_arguments', 'previous_process_terminated', 'no_unresolved_work', 'original_policy_and_shared_budget'] } } });
    host.settle(receipt.permitId, { effect: 'consumed', evidence: `registered replacement generation ${runtimeGeneration}` });
    host.runtimeRegistrations.delete(previousGeneration);
    host.runtimeRegistrations.set(runtimeGeneration, { policyId, operationId: previous.operationId, verificationOnly:previous.verificationOnly===true,recoveryOperationId: recoveryOperation, processEvidence: actual, hostInstance: host.hostInstance, attachSecretSha256: sha256(attachSecret) });
    return { runtimeGeneration, attachSecret, assurance: host.assurance, verificationOnly:previous.verificationOnly===true,replayed: false };
  } catch (error) {
    if (recoveryOperation && host.operationRow(recoveryOperation).outcome === 'in_progress') host.finishOperation(recoveryOperation, { outcome: 'reconciling', reason: error.message, evidence: { nativePeer: actual } });
    if (host.permitView(receipt.permitId).state === 'admitted') host.settle(receipt.permitId, { effect: 'unknown', evidence: `runtime registration interrupted: ${error.message}` });
    throw error;
  }
}
