// The worker runs a bounded sequence of host/engine requests, never workflow roles or commands from model output.
// Queue checkpoints are intent, not proof of an OS effect. Unknown outcomes require independent reconciliation.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';

const FIELDS = Object.freeze({
  'lifecycle.stop': ['buildId'],
  'lifecycle.restart': ['buildId', 'requireUi'],
  'lifecycle.rollback': ['buildId', 'requireUi'],
  'lifecycle.verify': ['buildId', 'requireUi'],
  'command.check': ['commandId', 'workspaceId'],
  'command.build': ['commandId', 'workspaceId'],
  'workflow.run': ['workflowId', 'workflowSnapshotSha256', 'workspaceId'],
  'evidence.audit': ['runId'],
  'judge.review': ['judgeSessionId','attentionId','runId','workflowId','workflowSnapshotSha256','workspaceId'],
});
const OPERATIONS = { 'lifecycle.stop': 'app.stop', 'lifecycle.restart': 'app.restart', 'lifecycle.rollback': 'app.rollback', 'lifecycle.verify':'app.verify', 'command.check': 'check.run', 'command.build': 'build.run', 'workflow.run': 'run.approve' };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const refuse = message => { throw new HostError(400, 'invalid_controller_plan', message); };
function exactKeys(value, allowed, required = allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) refuse('Unknown or missing controller-plan field.');
}
export function validateControllerPlan(plan, decision) {
  exactKeys(plan, ['schemaVersion', 'kind', 'mode', 'steps']);
  if (plan.schemaVersion !== 1 || plan.kind !== 'ControllerPlan' || plan.mode !== 'deterministic' || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 64) refuse('A bounded deterministic controller plan is required. Model adapters need a separate explicit configuration.');
  for (const step of plan.steps) {
    exactKeys(step, ['type', 'args']); const fields = FIELDS[step.type]; if (!fields) refuse('Unsupported operation; shell, file writes, credentials and policy changes are not worker tools.');
    if(decision.scope.verificationOnly&&(!['lifecycle.verify','lifecycle.stop'].includes(step.type)||(step.type==='lifecycle.verify'&&step.args?.requireUi===false)))refuse('Native verification plans can only verify a contained application with required UI evidence or explicitly stop that application.');
    exactKeys(step.args, fields, fields.filter(f => !['requireUi', 'entryInputs'].includes(f)));
    const operation = OPERATIONS[step.type]; if (operation && !decision.scope.operations.includes(operation)) refuse(`Policy does not cover ${operation}.`);
    if(step.type==='judge.review'){
      if(!decision.scope.judgeProfile||step.args.judgeSessionId!==decision.scope.judgeProfile.judgeSessionId||!decision.scope.operations.includes('provider.invoke')||!decision.scope.operations.includes('worker.model_call')||decision.limits.workerModelCalls<1||decision.limits.providerInvocations<1)refuse('Judge delivery needs its exact consent-bound profile and positive shared provider/controller budgets.');
      const rule=decision.scope.workflows.find(w=>w.workflowId===step.args.workflowId);
      if(!rule||![rule.baselineSha256,...rule.permittedRevisions].includes(step.args.workflowSnapshotSha256))refuse('Judge workflow content is outside consent.');
    }
    for (const [key, value] of Object.entries(step.args)) {
      if (key === 'entryInputs') { if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(canonicalize(value)) > 65536) refuse('Entry inputs exceed their data-only contract.'); }
      else if (key === 'requireUi') { if (typeof value !== 'boolean') refuse('UI verification must be a boolean.'); }
      else if (!id(value)) refuse(`Invalid ${key}.`);
    }
    if (step.args.workspaceId && !decision.scope.workspaces.some(w => w.workspaceId === step.args.workspaceId)) refuse('Workspace is outside consent.');
    if (step.args.commandId && !decision.scope.commands.some(c => c.commandId === step.args.commandId)) refuse('Command is outside consent.');
    if (step.type === 'workflow.run') {
      const rule = decision.scope.workflows.find(w => w.workflowId === step.args.workflowId);
      if (!rule || ![rule.baselineSha256, ...rule.permittedRevisions].includes(step.args.workflowSnapshotSha256)) refuse('Workflow content is outside consent.');
    }
  }
  return plan;
}
export const stepRequestId = (itemId, index) => {
  const h = canonicalHash({ itemId, index }); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export class ControllerQueue {
  constructor({ host }) { this.host = host; }
  policy(policyId) {
    const status = this.host.status(policyId);
    const decision=JSON.parse(this.host.policyRow(policyId).decision_json);
    if ((this.host.assurance === 'bootstrap'&&!decision.scope.verificationOnly) || !status.remainingMs || status.state !== 'active' || this.host.closedBarriers.has(policyId) || this.host.dispatchBlocked || this.host.applicationStopping(policyId)) throw new HostError(403, 'worker_authority_unavailable', 'The worker needs active, enabled, reconciled authority and no application Stop in progress.');
    return decision;
  }
  enqueue({ itemId, policyId, plan }, connectionId) {
    this.host.requireController(connectionId, policyId); if (!id(itemId)) refuse('A stable item ID is required.');
    const digest = canonicalHash({ policyId, plan }), old = this.host.get('SELECT * FROM controller_queue WHERE item_id=?', itemId);
    if (old) { if (old.request_digest !== digest) throw new HostError(409, 'conflict', 'The item ID belongs to different content.'); return this.view(old); }
    const decision = this.policy(policyId); validateControllerPlan(plan, decision);
    return this.host.transaction(() => {
      const at = new Date(this.host.time.wallNow()).toISOString();
      this.host.run("INSERT INTO controller_queue(item_id,policy_id,request_digest,plan_json,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)", itemId, policyId, digest, canonicalize(plan), at, at);
      this.host.audit('worker.plan_enqueued', { itemId, digest, mode: plan.mode, steps: plan.steps.length }, { policyId }); return this.status(itemId);
    });
  }
  view(row) { return { itemId: row.item_id, policyId: row.policy_id, state: row.state, index: row.step_index, receipts: JSON.parse(row.receipts_json), reason: row.reason, requestDigest: row.request_digest }; }
  status(itemId) { const row = this.host.get('SELECT * FROM controller_queue WHERE item_id=?', itemId); if (!row) throw new HostError(404, 'not_found', 'Controller item does not exist.'); return this.view(row); }
  claim(policyId, workerId, connectionId) {
    this.host.requireController(connectionId, policyId); if (this.host.dispatchBlocked) return null; this.policy(policyId);
    return this.host.transaction(() => {
      if (this.host.get("SELECT item_id FROM controller_queue WHERE policy_id=? AND state IN ('running','waiting','reconciling')", policyId)) return null;
      const row = this.host.get("SELECT * FROM controller_queue WHERE policy_id=? AND state='queued' ORDER BY created_at,item_id LIMIT 1", policyId); if (!row) return null;
      const lease = randomBytes(32).toString('hex'), requestId = stepRequestId(row.item_id, row.step_index);
      const step = JSON.parse(row.plan_json).steps[row.step_index];
      this.host.run("UPDATE controller_queue SET state='running',lease_owner=?,lease_sha256=?,step_request_id=?,updated_at=? WHERE item_id=?", workerId, sha256(lease), requestId, new Date(this.host.time.wallNow()).toISOString(), row.item_id);
      this.host.audit('worker.step_claimed', { itemId: row.item_id, index: row.step_index, requestId, type: step.type, workerId }, { policyId });
      return { itemId: row.item_id, policyId, index: row.step_index, requestId, lease, step };
    });
  }
  held(itemId, lease, workerId) {
    const row = this.host.get('SELECT * FROM controller_queue WHERE item_id=?', itemId);
    if (!row || !['running','waiting'].includes(row.state) || row.lease_owner !== workerId || typeof lease !== 'string' || !/^[a-f0-9]{64}$/.test(lease) || !timingSafeEqual(Buffer.from(sha256(lease)), Buffer.from(row.lease_sha256))) throw new HostError(403, 'stale_worker_lease', 'This process no longer owns the step.');
    return row;
  }
  finish({ itemId, lease, result }, workerId) {
    const value = this.host.transaction(() => {
      const row = this.held(itemId, lease, workerId), plan = JSON.parse(row.plan_json);
      if (!['succeeded', 'failed', 'reconciling', 'stopped'].includes(result?.outcome)) refuse('A verified typed step result is required.');
      const receipts = [...JSON.parse(row.receipts_json), { index: row.step_index, requestId: row.step_request_id, result }];
      const next = row.step_index + (result.outcome === 'succeeded' ? 1 : 0), state = result.outcome === 'succeeded' ? next === plan.steps.length ? 'succeeded' : 'queued' : result.outcome;
      this.host.run('UPDATE controller_queue SET state=?,step_index=?,receipts_json=?,reason=?,lease_owner=NULL,lease_sha256=NULL,updated_at=? WHERE item_id=?', state, next, canonicalize(receipts), result.reason ?? null, new Date(this.host.time.wallNow()).toISOString(), itemId);
      this.host.audit('worker.step_finished', { itemId, index: row.step_index, state, receiptDigest: canonicalHash(result) }, { policyId: row.policy_id }); return this.status(itemId);
    });
    this.host.refreshBlock(); return value;
  }
  wait({ itemId, lease, receipt }, workerId) {
    return this.host.transaction(() => {
      const row = this.held(itemId, lease, workerId), receipts = [...JSON.parse(row.receipts_json), { index: row.step_index, requestId: row.step_request_id, intermediate: receipt }];
      this.host.run("UPDATE controller_queue SET state='waiting',receipts_json=?,updated_at=? WHERE item_id=?", canonicalize(receipts), new Date(this.host.time.wallNow()).toISOString(), itemId);
      this.host.audit('worker.waiting_for_observation', { itemId, receipt }, { policyId: row.policy_id }); return this.status(itemId);
    });
  }
  recover(reason = 'worker/service connection lost; effect must be reconciled') {
    // Do not infer non-execution from a missing process, receipt, queue cursor or a restarted service.
    const count = this.host.transaction(() => {
      const rows = this.host.all("SELECT item_id,policy_id,step_index,step_request_id FROM controller_queue WHERE state IN ('running','waiting')");
      for (const row of rows) { this.host.run("UPDATE controller_queue SET state='reconciling',reason=?,lease_owner=NULL,lease_sha256=NULL WHERE item_id=?", reason, row.item_id); this.host.audit('worker.reconciliation_required', row, { policyId: row.policy_id }); }
      return rows.length;
    });
    this.host.refreshBlock(); return count;
  }
  reconcileStopped(itemId, nativeEvidence) {
    if (nativeEvidence?.nativeObservation?.termination?.terminationConfirmed !== true || nativeEvidence.outcome !== 'interrupted') throw new HostError(409,'native_reconciliation_required','The fixed native reconciliation procedure must establish interruption.');
    const result = this.host.transaction(() => {
      const row = this.host.get('SELECT * FROM controller_queue WHERE item_id=?',itemId);
      if (!row) throw new HostError(404,'not_found','Controller item does not exist.');
      if (row.state === 'stopped') return this.view(row);
      if (row.state !== 'reconciling') throw new HostError(409,'conflict','Only a reconciling item can be resolved.');
      const receipts = [...JSON.parse(row.receipts_json),{ index:row.step_index,requestId:row.step_request_id,reconciliation:{ outcome:'stopped',evidence:nativeEvidence } }];
      this.host.run("UPDATE controller_queue SET state='stopped',receipts_json=?,reason='Native interruption established; continuation requires a new explicit plan.',lease_owner=NULL,lease_sha256=NULL,updated_at=? WHERE item_id=?",canonicalize(receipts),new Date(this.host.time.wallNow()).toISOString(),itemId);
      this.host.audit('worker.step_reconciled',{ itemId,index:row.step_index,outcome:'stopped',evidenceDigest:canonicalHash(nativeEvidence) },{ policyId:row.policy_id });
      return this.status(itemId);
    });
    this.host.refreshBlock(); return result;
  }
}
