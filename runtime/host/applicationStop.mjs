// Planned close of an idle, host-launched application. Emergency Stop/revocation is a separate path.
// The caller names a generation, never a PID, image or domain. All targets come from the host's receipts.
import { check } from '../core/schemas.mjs';
import { HostError } from './authority.mjs';

const refuse = (value, message) => {
  if (!value) throw new HostError(409, 'application_stop_refused', message);
};
const pause = ms => new Promise(done => setTimeout(done, ms));

export class ApplicationStop {
  constructor({ host, native, phaseTimeoutMs = 30_000, pollMs = 25 }) {
    Object.assign(this, { host, native, phaseTimeoutMs, pollMs });
  }

  async bounded(call) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HostError(504, 'phase_timeout', 'Application termination is unconfirmed.')), this.phaseTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async stop(request, connectionId, { itemId = null } = {}) {
    const { host } = this;
    const issues = check('autonomy-policy.schema.json', 'applicationStopRequest', request);
    if (issues.length) throw new HostError(400, 'invalid_request', 'Stop requires only policyId, requestId and runtimeGeneration.');
    const { policyId, requestId, runtimeGeneration } = request;
    host.requireController(connectionId, policyId);

    // Reconcile a lost reply before inspecting the current generation: it may already have been retired/replaced.
    const prior = host.get('SELECT * FROM decisions WHERE policy_id=? AND request_id=?', policyId, requestId);
    if (prior) {
      const captured = JSON.parse(prior.request_json);
      refuse(prior.operation === 'app.stop' && captured.runtimeGeneration === runtimeGeneration, 'The request ID belongs to a different target or operation.');
      const operation = host.get('SELECT * FROM operations WHERE permit_id=?', JSON.parse(prior.receipt_json).permitId);
      return operation ? { outcome: operation.outcome === 'in_progress' ? 'reconciling' : operation.outcome, reason: operation.reason,
        operationId: operation.operation_id, runtimeGeneration, receiptOnly: true, replayed: true }
        : { outcome: prior.outcome === 'approved' ? 'reconciling' : 'blocked', reason: prior.outcome === 'approved' ? 'admission_requires_reconciliation' : JSON.parse(prior.receipt_json).reason,
          operationId: null, runtimeGeneration, receiptOnly: true, replayed: true };
    }

    const registration = host.runtimeRegistrations.get(runtimeGeneration);
    refuse(registration?.policyId === policyId && registration.hostInstance === host.hostInstance && registration.operationId, 'Stop requires the exact live generation of a host-launched application.');
    const launch = host.operationRow(registration.operationId), intent = JSON.parse(launch.intent_json), evidence = JSON.parse(launch.evidence_json);
    refuse(launch.policy_id === policyId && ['app.restart', 'app.rollback', 'app.verify'].includes(launch.kind) && launch.outcome === 'verified' && evidence.launch,
      'The application has no verified host launch receipt. Use emergency Stop for incomplete work.');
    const policy = JSON.parse(host.policyRow(policyId).decision_json), scope = policy.scope;
    if (itemId !== null) {
      // Only the private worker dispatch supplies this argument, after authenticating its OS peer and lease.
      const item = host.get('SELECT * FROM controller_queue WHERE item_id=?', itemId);
      const step = item && JSON.parse(item.plan_json).steps[item.step_index];
      refuse(item?.policy_id === policyId && item.state === 'running' && item.step_request_id === requestId
        && step?.type === 'lifecycle.stop' && step.args.buildId === intent.buildId, 'The queue item does not own this exact Stop.');
    }
    refuse(!host.get("SELECT work_id FROM active_work WHERE policy_id=? AND state='active'", policyId)
      && !host.get("SELECT operation_id FROM operations WHERE policy_id=? AND outcome IN ('in_progress','reconciling')", policyId)
      && !host.get("SELECT permit_id FROM permits WHERE policy_id=? AND state='admitted'", policyId)
      && !host.get("SELECT item_id FROM controller_queue WHERE policy_id=? AND state IN ('queued','running','waiting','reconciling') AND item_id!=?", policyId, itemId ?? ''),
    'Planned close requires idle owned work and queue. Use emergency Stop for active or unresolved work.');

    const process = evidence.launch;
    const receipt = host.decide({ requestId, policyId, runtimeGeneration, operation: 'app.stop', cost: {},
      justification: 'Close the exact idle application; preserve the original policy, expiry and consumed budgets.',
      target: { profile: intent.profile, applicationMode: intent.applicationMode, desktop: scope.desktop, buildRoot: scope.buildRoot,
        buildDir: intent.buildDir, buildId: intent.buildId, currentProcess: { pid: process.pid, creationTime: process.creationTime } } }, { connectionId });
    if (receipt.outcome !== 'approved') return { outcome: 'blocked', reason: receipt.reason, operationId: null, runtimeGeneration };
    const admission = host.admit(receipt.permitId);
    if (!admission.admitted) {
      host.settle(receipt.permitId, { effect: 'not_executed', evidence: admission.reason });
      return { outcome: 'blocked', reason: admission.reason, operationId: null, runtimeGeneration };
    }
    let operationId;
    try {
      ({ operationId } = host.beginOperation({ permitId: receipt.permitId, kind: 'app.stop', intent: {
        runtimeGeneration, launchOperationId: registration.operationId, expectedCurrent: process, runtime: registration.processEvidence,
        profile: intent.profile, buildId: intent.buildId, applicationMode: intent.applicationMode } }));
    } catch (error) {
      host.settle(receipt.permitId, { effect: 'not_executed', evidence: `Stop intent refused: ${error.message}` });
      throw error;
    }
    // No await above: record the durable dispatch fence, invalidate unadmitted permits and retire the generation
    // before an external effect can interleave with another request. An unknown Stop never restores that generation.
    let termination = null;
    try {
      host.transaction(() => host.releaseIssuedPermits(policyId, new Date(host.time.wallNow()).toISOString()));
      host.retireRuntime(runtimeGeneration, 'planned_application_stop');
      termination = await this.bounded(() => this.native('stopProcess', { domain: policyId, process, graceful: true }));
      refuse(termination?.terminationConfirmed === true && termination.domainEmpty === true, 'Native owned-domain termination is unconfirmed.');
      const processes = [...new Map([process, registration.processEvidence].map(p => [`${p.pid}:${p.creationTime}`, p])).values()];
      const observations = await this.bounded(async () => {
        const end = Date.now() + Math.min(5000, this.phaseTimeoutMs);
        do {
          const observed = await Promise.all(processes.map(async p => ({ process: p, ...await this.native('isRunning', { process: p }) })));
          if (observed.every(p => p.running === false)) return observed;
          await pause(this.pollMs);
        } while (Date.now() < end);
        throw new HostError(409, 'termination_unconfirmed', 'An observed application/runtime process is still alive or unconfirmed.');
      });
      host.finishOperation(operationId, { outcome: 'verified', evidence: { termination, processes: observations,
        verification: { complete: true, chain: ['host_launch', 'exact_generation', 'native_domain_empty', 'os_process_termination'] } } });
      host.settle(receipt.permitId, { effect: 'consumed', evidence: 'Planned application Stop verified; authority lifetime and restart usage unchanged.' });
      return { outcome: 'verified', reason: null, operationId, runtimeGeneration };
    } catch (error) {
      const reason = `application_stop: ${error.code || 'error'}: ${error.message}`;
      host.finishOperation(operationId, { outcome: 'reconciling', reason, evidence: { termination, ambiguous: true } });
      host.settle(receipt.permitId, { effect: 'unknown', evidence: reason });
      return { outcome: 'reconciling', reason, operationId, runtimeGeneration };
    }
  }
}
