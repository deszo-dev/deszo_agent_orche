// Engine side of ADR-0006: runs, supervision grants and provider invocations admitted under a Local Control Host permit.
//
// The host decides outer authority (policy, scope, expiry, revocation, budgets); the engine still applies its own
// workflow validation and can refuse. An admission is an object created here after the host admitted the permit; it
// cannot be supplied as request JSON, so no HTTP, MCP or Tauri caller can forge one. Without a configured host these
// paths refuse, and the existing manual confirmation and first-party grant paths are unchanged.
//
// Provider invocations of a host-bound runtime are charged at the invocation boundary: each agent CLI launch, including
// retries and context continuation, is its own host decision, admission and settlement. A run's creation charges an
// attempt only.
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../core/canonical.mjs';
import { derivedUuid } from './supervision.mjs';

export function installHostAutonomy(Engine, { ApiError }) {
  const P = Engine.prototype;

  // Host refusals keep their status and code; an unreachable host is a 503, never a silent approval.
  const viaHost = async call => {
    try { return await call(); }
    catch (error) { throw new ApiError(error.status && error.status < 600 ? error.status : 503, error.code || 'host_unavailable', `Local Control Host: ${error.message}`); }
  };

  P.requireHostAuthority = function requireHostAuthority() {
    if (!this.hostAuthority) throw new ApiError(409, 'autonomy_unavailable', 'This runtime is not registered with a Local Control Host, so it cannot act on autonomous permits.');
    return this.hostAuthority;
  };

  // A host-bound runtime creates a run only under a host permit. Direct, chat and approval routes would otherwise run work
  // that no host decision admitted; pending confirmation requests create no run and stay available.
  P.refuseUnpermittedRun = function refuseUnpermittedRun(route) {
    if (this.hostAuthority) throw new ApiError(403, 'host_permit_required', `${route} needs a Local Control Host permit in this host-bound runtime, so the request is refused.`);
  };

  P.refuseHostMutation = function refuseHostMutation(route) {
    if (this.hostAuthority) throw new ApiError(403, 'trusted_authority_required', `${route} cannot be changed by a candidate runtime. Use the independent trusted session/installation procedure.`);
  };

  // Asks the host to admit a permit for exactly this request. The host's own decision is compared field by field;
  // the engine never widens it (another workflow revision, workspace or operation is refused).
  P.admitHostPermit = async function admitHostPermit(permitId, expected) {
    const host = this.requireHostAuthority();
    const permit = await viaHost(() => host.permitRequest(permitId));
    const mismatch = Object.entries(expected).find(([key, value]) => permit.request[key] !== value);
    if (permit.operation !== expected.operation || mismatch) {
      throw new ApiError(403, 'host_permit_mismatch', `The host permit was decided for a different request${mismatch ? ` (${mismatch[0]})` : ''}.`);
    }
    if (this.hostRuntimeGeneration && permit.request.runtimeGeneration !== this.hostRuntimeGeneration) {
      throw new ApiError(403, 'host_permit_mismatch', 'The host permit names another runtime generation.');
    }
    const result = await viaHost(() => host.admit(permitId));
    if (!result.admitted) throw new ApiError(403, 'host_refused', `The Local Control Host refused admission: ${result.reason}.`);
    const admission = { permitId, policyId: permit.policyId, operation: permit.operation, enforcementDeadlineMs: result.enforcementDeadlineMs };
    this.hostAdmissions.add(admission);
    return admission;
  };

  P.isHostAdmission = function isHostAdmission(admission, permitId, operation) {
    return Boolean(admission) && this.hostAdmissions.has(admission) && admission.permitId === permitId && admission.operation === operation;
  };

  // Records what happened to an admitted effect; a consumed effect that created a run also records the run as owned work.
  P.settleHostPermit = async function settleHostPermit(permitId, effect, evidence, workRef = null) {
    const host = this.requireHostAuthority();
    return viaHost(() => host.settle(permitId, { effect, evidence, workRef }));
  };

  // An exact retry of a create-run request returns its committed receipt without admission or charge. A different payload
  // or caller scope (another command) is still refused by the same rule the engine's idempotent path applies.
  P.replayHostRunRequest = function replayHostRunRequest(command, body) {
    const receipt = this.store.get('SELECT * FROM command_receipts WHERE request_id = ?', body.requestId);
    if (!receipt) return null;
    if (receipt.command !== command || receipt.payload_sha256 !== canonicalHash({ command, payload: body })) {
      throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
    }
    return this.store.readJson(receipt.response_artifact_id);
  };

  // A run requested under a host permit: replay check, admit, create through the ordinary validated path, settle with ownership.
  P.createRunUnderHostPermit = async function createRunUnderHostPermit(body, options) {
    const command = options.role === 'external' ? 'POST /runs/external' : 'POST /runs/direct';
    const replay = this.replayHostRunRequest(command, body);
    if (replay) return replay;
    const admission = await this.admitHostPermit(body.hostPermitId, {
      operation: 'run.approve', workflowId: body.workflowId, workflowSnapshotSha256: body.workflowSnapshotSha256, workspaceId: body.workspaceId,
    });
    let result;
    try {
      // Host policy bindings pin definition bytes by their immutable snapshot hash. The caller still
      // selects the exact Published Version; createRun verifies that version's digest and snapshot
      // against both the request and the admitted Host scope before it captures the Run.
      result = this.createRun(body, { ...options, hostAdmission: admission });
    }
    catch (error) {
      await this.settleHostPermit(admission.permitId, 'not_executed', `engine refused the run: ${error.code || 'error'}: ${error.message}`);
      throw error;
    }
    const runId = result.body.run?.runId;
    if (!runId) {
      await this.settleHostPermit(admission.permitId, 'not_executed', `the run was not created: ${result.body.outcome}`);
      return result;
    }
    this.hostPermitRuns.set(admission.permitId, runId);
    this.hostRuns.set(runId, { permitId: admission.permitId });
    await this.settleHostPermit(admission.permitId, 'consumed', `run ${runId} created`, runId);
    this.armHostDeadline(runId, admission);
    return result;
  };

  // The runtime's own clock enforces the authorized lifetime for the run it owns, independently of the host's delivery.
  P.armHostDeadline = function armHostDeadline(runId, admission) {
    if (!Number.isFinite(admission.enforcementDeadlineMs)) return;
    const timer = setTimeout(() => this.stopHostPermits([admission.permitId], [runId]), admission.enforcementDeadlineMs);
    timer.unref?.();
    this.hostDeadlines.set(runId, timer);
  };

  // Native Stop scope delivered by the host after a committed revocation or expiry: admitted permits and owned work,
  // whether or not their permit has already been settled for accounting.
  P.stopHostPermits = function stopHostPermits(permitIds = [], workRefs = []) {
    const runIds = new Set(workRefs);
    for (const permitId of permitIds) {
      const runId = this.hostPermitRuns.get(permitId);
      if (runId) runIds.add(runId);
    }
    const stopped = [];
    for (const runId of runIds) {
      try { this.stopRun(runId, { requestId: derivedUuid(runId, 'host-stop') }); stopped.push(runId); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    return stopped;
  };

  // The engine reports an owned run terminal; the host then stops tracking it as owned work.
  P.releaseHostRun = function releaseHostRun(runId, terminalState) {
    const entry = this.hostRuns.get(runId);
    if (!entry) return;
    this.hostRuns.delete(runId);
    clearTimeout(this.hostDeadlines.get(runId));
    this.hostDeadlines.delete(runId);
    viaHost(() => this.requireHostAuthority().releaseWork(entry.permitId, runId, { terminalState })).catch(error => {
      this.hostReleaseFailures.push({ runId, reason: error.message });
    });
  };

  // The host binding of a run: its workflow revision and workspace, as the host's decisions name them.
  P.hostRunBinding = function hostRunBinding(runId) {
    const row = this.store.get('SELECT r.workflow_id, r.workspace_id, r.workflow_snapshot_artifact_id, w.cwd_identity FROM runs r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = ?', runId);
    if (!row) throw new ApiError(404, 'not_found', `Run ${runId} does not exist.`);
    return { workflowId: row.workflow_id, workspaceId: row.workspace_id, workspaceCwdIdentity: row.cwd_identity, workflowSnapshotSha256: this.store.artifactRow(row.workflow_snapshot_artifact_id).sha256 };
  };

  // Charges one provider invocation before its CLI is launched. Refusal is returned, never thrown past the attempt.
  P.reserveHostProviderInvocation = async function reserveHostProviderInvocation(runId, attemptId) {
    if (!this.hostAuthority) return null;
    try {
      const host = this.requireHostAuthority();
      // The managed task records an actual repair cycle before it schedules its next role. Several role calls,
      // context expansions and transport retries in that cycle share one durable host decision. A context-only
      // retry with repairs=0 never consumes a repair. Provider calls still have their separate invocation charge.
      const work = this.store.get('SELECT t.id,t.state_artifact_id FROM task_work w JOIN managed_tasks t ON t.id=w.task_execution_id WHERE w.attempt_id=?', attemptId);
      const repairs = work ? this.store.readJson(work.state_artifact_id).repairs : 0;
      if (repairs > 0) {
        const repair = await viaHost(() => host.decide({ requestId: derivedUuid(runId, `managed-repair:${work.id}:${repairs}`), policyId: this.hostPolicyId,
          operation: 'repair.run', ...this.hostRunBinding(runId), runtimeGeneration: this.hostRuntimeGeneration, cost: {}, justification: `managed task ${work.id}, repair cycle ${repairs}` }));
        if (repair.outcome !== 'approved') return { refused: true, reason: repair.reason };
        const previous = await viaHost(() => host.permitRequest(repair.permitId));
        if (previous.state !== 'settled' || previous.effect !== 'consumed') {
          const admission = await viaHost(() => host.admit(repair.permitId));
          if (!admission.admitted) {
            await viaHost(() => host.settle(repair.permitId, { effect: 'not_executed', evidence: `repair admission refused: ${admission.reason}` }));
            return { refused: true, reason: `repair admission: ${admission.reason}` };
          }
          // Scheduling the repair cycle is the effect, rather than each subsequent CLI's success.
          await viaHost(() => host.settle(repair.permitId, { effect: 'consumed', evidence: `admitted managed repair cycle ${repairs} of ${work.id}` }));
        }
      }
      const receipt = await viaHost(() => host.decide({ requestId: randomUUID(), policyId: this.hostPolicyId, operation: 'provider.invoke', ...this.hostRunBinding(runId),
        runtimeGeneration: this.hostRuntimeGeneration, cost: {}, justification: `provider invocation ${attemptId}` }));
      if (receipt.outcome !== 'approved') return { refused: true, reason: receipt.reason };
      const admitted = await viaHost(() => host.admit(receipt.permitId));
      if (!admitted.admitted) {
        await viaHost(() => host.settle(receipt.permitId, { effect: 'not_executed', evidence: `admission refused: ${admitted.reason}` }));
        return { refused: true, reason: admitted.reason };
      }
      return { permitId: receipt.permitId };
    } catch (error) {
      return { refused: true, reason: error.message };
    }
  };

  // The effect of one invocation is recorded: consumed when its CLI was launched, otherwise returned with evidence.
  P.settleHostProviderInvocation = async function settleHostProviderInvocation(permit, { launched, evidence }) {
    if (!permit?.permitId) return;
    try {
      await this.settleHostPermit(permit.permitId, launched ? 'consumed' : 'not_executed', evidence);
    } catch (error) {
      this.hostReleaseFailures.push({ permitId: permit.permitId, reason: `settlement: ${error.message}` });
    }
  };

  // A pending supervision grant approved by host authority instead of a first-party click. The grant keeps every
  // ADR-0002 check: its client matrix, controller credential, exact snapshot and arm-before-launch binding.
  P.approveControlGrantUnderHostPermit = async function approveControlGrantUnderHostPermit(grantId, body) {
    const grant = this.grantRow(grantId);
    if (grant.state !== 'pending') throw new ApiError(409, 'conflict', `The grant is ${grant.state}; only a pending grant can be approved.`);
    const admission = await this.admitHostPermit(body.hostPermitId, {
      operation: 'supervision.approve', workflowId: grant.workflow_id, workflowSnapshotSha256: grant.workflow_snapshot_sha256, workspaceId: grant.workspace_id,
    });
    let result;
    try { result = this.decideControlGrant(grantId, { requestId: body.requestId ?? randomUUID(), decision: 'approve' }, { hostAdmission: admission }); }
    catch (error) {
      await this.settleHostPermit(admission.permitId, 'not_executed', `engine refused the approval: ${error.message}`);
      throw error;
    }
    await this.settleHostPermit(admission.permitId, 'consumed', `grant ${grantId} approved`);
    return { status: result.status, body: { ...result.body, hostPermitId: admission.permitId } };
  };
}
