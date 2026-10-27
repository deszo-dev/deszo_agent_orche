// ADR-0008 linked self-repair continuation, installed on the Engine prototype like judgeAttention.mjs.
//
// Parent/Repair coordination extends the original ADR-0008 linked lifecycle path with a logical-policy contract. A P2
// Parent suspension is recorded on run_links while the original workflow and accepted checkpoint remain immutable. The
// Repair is an ordinary captured workflow in a physically separate workspace. Lifecycle links keep their Judge/Host gate;
// logical-policy links accept only the explicitly authorized result digest and never grant lifecycle authority. Every
// continuation step is a compare-and-set on durable state, so repeated reconciliation cannot repeat it.
//
// Host-bound receipts arrive only through the authenticated local Lifecycle Host channel. The first-party route is retained
// for the unbound development/test runtime and is refused whenever a Lifecycle Host bootstrap is present.
import { randomUUID } from 'node:crypto';
import { parseStrictJson } from './canonical.mjs';
import { custodyFaultPoint } from './custody.mjs';
import { allNodesDeep } from './planning.mjs';
import { resolveWorkspaceRoot, workspaceRootsOverlap } from './workspaceIsolation.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const PROPOSAL = /^REQUEST_LIFECYCLE_ACTION (\{.*\})\s*$/gm;
const ACTIVE_ATTEMPT_STATES = ['running', 'draining'];

export function installLinkedRepair(Engine, { ApiError }) {
  const P = Engine.prototype;
  const fail = (status, code, message) => { throw new ApiError(status, code, message); };
  const now = () => new Date().toISOString();
  // origin records who caused the transition: the Engine itself, or the Host's receipt delivered through the first-party route.
  const event = (type, payload, origin = 'ENGINE') => ({ type, payload: { origin, ...payload }, nodeInstanceId: null, attemptId: null });

  // Lookups ---------------------------------------------------------------------------------------------------------------
  P.linkByParent = function (parentRunId, states = ['open', 'repair_completed']) {
    return this.store.get(`SELECT * FROM run_links WHERE parent_run_id = ? AND state IN (${states.map(() => '?').join(',')})`, parentRunId, ...states);
  };
  P.openLinkOfRepair = function (repairRunId) {
    return this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND state = 'open'", repairRunId);
  };
  P.lifecycleOfRun = function (runId) {
    return this.store.get('SELECT * FROM lifecycle_operations WHERE run_id = ?', runId);
  };
  P.lifecycleBody = function (row) {
    return { operationId: row.id, runId: row.run_id, nodeInstanceId: row.node_instance_id, action: row.action, candidateDigest: row.candidate_digest,
      targetVersion: row.target_version, candidateId: row.target_version, continuationCheckpointId: row.continuation_checkpoint_id, state: row.state, receiptArtifactId: row.receipt_artifact_id,
      installationId: row.installation_id, profileRoot: row.profile_root, expectedGeneration: row.expected_generation };
  };

  P.logicalRepairLinkForRun = function (runId) {
    return this.store.get(`SELECT * FROM run_links WHERE continuation_contract = 'logical_policy'
      AND (parent_run_id = ? OR repair_run_id = ?) ORDER BY created_at DESC LIMIT 1`, runId, runId);
  };
  P.logicalRepairLinkForIncident = function (incidentId) {
    return this.store.get("SELECT * FROM run_links WHERE continuation_contract = 'logical_policy' AND incident_id = ?", incidentId);
  };
  P.repairCoordinationBody = function (link) {
    const parent = this.store.get('SELECT state FROM runs WHERE id = ?', link.parent_run_id);
    const repair = this.store.get('SELECT state FROM runs WHERE id = ?', link.repair_run_id);
    return { linkId: link.id, incidentId: link.incident_id, parentRunId: link.parent_run_id, repairRunId: link.repair_run_id,
      state: link.state, parentState: link.parent_suspension_state, repairState: repair?.state ?? 'missing',
      repairOutcome: link.repair_outcome, continuationDecision: link.decision_status,
      resumeNodeInstanceId: link.resume_node_instance_id, repairWorkspaceId: link.repair_workspace_id,
      parentRunState: parent?.state ?? 'missing', createdAt: link.created_at, updatedAt: link.updated_at };
  };
  P.parentRepairAuthorization = function (link) {
    if (!link?.authorization_artifact_id) return null;
    try { return this.store.readJson(link.authorization_artifact_id); } catch { return null; }
  };
  P.logicalRepairWaitingForDecision = function (repairRunId) {
    const link = this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND continuation_contract = 'logical_policy' AND state = 'open'", repairRunId);
    return Boolean(link && this.latestAttempts(repairRunId).some(attempt => ['failed', 'canceled', 'blocked', 'interrupted'].includes(attempt.state)));
  };
  P.logicalRepairLinkIntact = function (link, run = null) {
    if (!link || link.continuation_contract !== 'logical_policy' || !link.incident_id || !link.authorization_artifact_id) return false;
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    const repair = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
    const authorization = this.parentRepairAuthorization(link);
    let checkpoint = null;
    try { checkpoint = link.checkpoint_artifact_id ? this.store.readJson(link.checkpoint_artifact_id) : null; } catch { /* A missing checkpoint is an ineligible link. */ }
    if (!parent || !repair || !authorization || parent.kind !== 'workflow' || repair.kind !== 'workflow'
      || parent.journal_version !== 2 || repair.journal_version !== 2
      || parent.workspace_id !== link.parent_workspace_id || repair.workspace_id !== link.repair_workspace_id
      || authorization.incidentId !== link.incident_id || authorization.parentRunId !== link.parent_run_id
      || authorization.repairRunId !== link.repair_run_id || authorization.repairPublishedVersionId !== repair.published_version_id
      || authorization.parentPublishedVersionId !== parent.published_version_id
      || authorization.parentSnapshotSha256 !== this.store.artifactRow(parent.workflow_snapshot_artifact_id)?.sha256
      || authorization.repairSnapshotSha256 !== this.store.artifactRow(repair.workflow_snapshot_artifact_id)?.sha256
      || authorization.repairWorkspaceId !== link.repair_workspace_id || authorization.failedNodeInstanceId !== link.resume_node_instance_id
      || authorization.repairResultNodeInstanceId !== link.repair_result_node_instance_id
      || authorization.expectedRepairResultSha256 !== link.expected_repair_result_sha256
      || authorization.failedNodeRetry !== link.failed_node_retry
      || checkpoint?.incidentId !== link.incident_id || checkpoint?.parentRunId !== link.parent_run_id
      || checkpoint?.repairRunId !== link.repair_run_id || checkpoint?.parentPublishedVersionId !== parent.published_version_id
      || checkpoint?.resumeNodeInstanceId !== link.resume_node_instance_id
      || (link.parent_suspension_state !== 'resumed' && checkpoint?.targetAttemptId !== this.latestAttempt(parent.id, link.resume_node_instance_id)?.id)
      || !this.publishedDefinitionIntact(parent) || !this.publishedDefinitionIntact(repair)) return false;
    if (run && run.id !== parent.id && run.id !== repair.id) return false;
    return !this.linkedRepairWorkspaceIssueForLink(link);
  };

  // A workspace id is only a database binding. Linked Repair also requires disjoint effective filesystem roots.
  P.linkedRepairWorkspaceIssue = function (parentWorkspace, repairWorkspace) {
    let parentRoot, repairRoot;
    try {
      parentRoot = resolveWorkspaceRoot(parentWorkspace.cwd);
      repairRoot = resolveWorkspaceRoot(repairWorkspace.cwd);
    } catch {
      const workspaceId = !parentRoot ? parentWorkspace.id : repairWorkspace.id;
      return { code: 'workspace_unavailable', message: `Linked repair isolation cannot be established because workspace "${workspaceId}" is missing or cannot be resolved to a directory.` };
    }
    if (workspaceRootsOverlap(parentRoot, repairRoot)) return {
      code: 'workspace_overlap',
      message: `The linked repair workspace "${repairWorkspace.id}" physically overlaps parent workspace "${parentWorkspace.id}".`,
    };
    return null;
  };

  P.linkedRepairWorkspaceIssueForLink = function (link) {
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    const repair = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
    if (!parent || !repair) return { code: 'workspace_binding_mismatch', message: 'The linked repair does not have both persisted runs.' };
    if (parent.workspace_id !== link.parent_workspace_id || repair.workspace_id !== link.repair_workspace_id)
      return { code: 'workspace_binding_mismatch', message: 'The persisted linked repair workspace bindings no longer match its Parent and Repair Runs.' };
    const parentWorkspace = this.store.get('SELECT * FROM workspaces WHERE id = ?', parent.workspace_id);
    const repairWorkspace = this.store.get('SELECT * FROM workspaces WHERE id = ?', repair.workspace_id);
    if (!parentWorkspace || !repairWorkspace) return { code: 'workspace_unavailable', message: 'Linked repair isolation cannot be established because a workspace binding is missing.' };
    return this.linkedRepairWorkspaceIssue(parentWorkspace, repairWorkspace);
  };

  P.linkedRepairWorkspaceIssueForRun = function (repairRunId) {
    const link = this.openLinkOfRepair(repairRunId);
    return link ? this.linkedRepairWorkspaceIssueForLink(link) : null;
  };

  // The synchronous PDE-R10 check every Engine-owned process launch passes through. Process Custody calls it too, so a
  // Host-owned CLI has no path around the isolation contract. It throws when the Repair's roots overlap its Parent's.
  P.assertLinkedRepairLaunch = function (runId) {
    if (this.parentRepairDispatchPaused?.(runId))
      throw Object.assign(new Error('The Parent was suspended before this provider process could be launched.'), { code: 'parent_suspension_requested' });
    const isolationIssue = this.linkedRepairWorkspaceIssueForRun(runId);
    if (isolationIssue) {
      const state = this.runs.get(runId);
      if (state) this.refuseLinkedRepairExecution(state, isolationIssue);
      throw Object.assign(new Error(isolationIssue.message), { code: isolationIssue.code });
    }
  };

  // Last synchronous check before any Engine-owned process launch. This also covers managed-task and Map check processes.
  const launchContained = P.launchContained;
  P.launchContained = function (runId, options) {
    this.assertLinkedRepairLaunch(runId);
    return launchContained.call(this, runId, options);
  };

  // Unsafe persisted links are failed closed. A live process is allowed to reach its existing completion/Stop boundary,
  // while the Engine moves the run to draining and prevents any further dispatch.
  P.refuseLinkedRepairExecution = function (state, issue) {
    if (!state || state.linkedRepairIsolationFailure) return false;
    const link = this.openLinkOfRepair(state.id);
    if (!link) return false;
    const run = this.requireRun(state.id);
    if (run.state === 'stopping') return false;
    state.linkedRepairIsolationFailure = issue;
    const message = issue.message;
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.state)) {
      this.refuseLinkedRepairContinuation(link, issue);
      return true;
    }
    this.store.transaction(() => {
      const events = [event('continuation.workspace_isolation_refused', { linkId: link.id, parentRunId: link.parent_run_id, repairRunId: state.id,
        code: issue.code, message })];
      for (const attempt of this.latestAttempts(state.id).filter(item => ['scheduled', 'waiting'].includes(item.state))) {
        events.push({ type: 'attempt.error', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { code: issue.code, message, evidence: null } });
        events.push(...this.attemptTransition(attempt, 'blocked', message));
      }
      const current = this.requireRun(state.id);
      if (current.state !== 'draining') events.push(this.runEvent(current, 'draining', 'Linked repair workspace isolation could not be established; dispatch is blocked.'));
      this.store.appendEvents(state.id, events);
      this.store.appendEvents(link.parent_run_id, [event('continuation.workspace_isolation_refused', { linkId: link.id, repairRunId: state.id, code: issue.code, message })]);
    });
    this.finishRunIfDone(state);
    return true;
  };

  P.refuseLinkedRepairContinuation = function (link, issue) {
    const repair = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
    if (link.state === 'open' && repair && !['succeeded', 'failed', 'canceled', 'interrupted'].includes(repair.state)) {
      const state = this.ensureRunState(repair.id);
      this.refuseLinkedRepairExecution(state, issue);
      return true;
    }
    const at = now();
    this.store.transaction(() => {
      const logical = link.continuation_contract === 'logical_policy';
      const changed = this.store.run(`UPDATE run_links SET state = 'repair_failed', updated_at = ?${logical ? ", parent_suspension_state = 'blocked', decision_status = 'rejected'" : ''}
        WHERE id = ? AND state IN ('open','repair_completed','repair_accepted')`, at, link.id).changes;
      if (!changed) return;
      const payload = { linkId: link.id, parentRunId: link.parent_run_id, repairRunId: link.repair_run_id, code: issue.code, message: issue.message };
      this.store.appendEvents(link.repair_run_id, [event('continuation.workspace_isolation_refused', payload)]);
      this.store.appendEvents(link.parent_run_id, [event('continuation.workspace_isolation_refused', payload),
        event('continuation.repair_failed', { linkId: link.id, repairRunId: link.repair_run_id, repairState: repair?.state || 'missing' })]);
    });
    return true;
  };

  // A logical-policy Parent has a distinct durable suspension reason on run_links. Its base Run state may
  // still be waiting_for_user because the incident node failed, but Repair suspension is never inferred
  // from that state alone. Work already entering dispatch remains eligible for ordinary Custody recovery.
  P.parentRepairWorkInFlight = function (parentRunId) {
    if ([...(this.processes?.values() || [])].some(record => record.runId === parentRunId)) return true;
    if (this.store.get(`SELECT id FROM attempts WHERE run_id = ? AND state IN (${ACTIVE_ATTEMPT_STATES.map(() => '?').join(',')})`, parentRunId, ...ACTIVE_ATTEMPT_STATES)) return true;
    return Boolean(this.store.get("SELECT custody_id FROM custody_workspace_holds WHERE run_id = ? AND state = 'held'", parentRunId));
  };

  P.parentRepairDispatchPaused = function (parentRunId) {
    const link = this.store.get(`SELECT state, parent_suspension_state FROM run_links WHERE continuation_contract = 'logical_policy'
      AND parent_run_id = ? ORDER BY created_at DESC LIMIT 1`, parentRunId);
    return Boolean(link && link.state !== 'resumed' && link.parent_suspension_state !== 'resumed' && this.runState(parentRunId) !== 'stopping');
  };

  P.recordParentRepairLaunchWithdrawn = function (runId, attemptId, custodyId = null, binding = null) {
    if (!this.parentRepairDispatchPaused(runId)) return false;
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ? AND run_id = ?', attemptId, runId);
    if (!attempt || !['scheduled', 'waiting'].includes(attempt.state)) return false;
    this.store.transaction(() => {
      const events = [];
      const existing = this.store.get("SELECT 1 FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.launch_withdrawn'", runId, attemptId);
      if (!existing) events.push({ type: 'attempt.launch_withdrawn', nodeInstanceId: attempt.node_instance_id,
        attemptId, payload: { custodyId, reason: 'parent_suspension', launchRequestSent: false } });
      // A Context binding enters `writing` with the durable invocation manifest. Record its prelaunch restoration in
      // the same transaction as the never-launched marker, so a crash cannot strand it in a false active-write state.
      if (binding) {
        const currentBinding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', binding.id);
        if (currentBinding?.state === 'writing') {
          const to = this.bindingRecord(currentBinding).nativeSessionId ? 'ready' : 'unbound';
          events.push(this.bindingTransition(currentBinding, to, 'No process was launched; the native conversation did not change.')[0]);
        }
      }
      if (events.length) this.store.appendEvents(runId, events);
    });
    return true;
  };

  P.isContinuationHeld = function (run) {
    if (run.state === 'stopping') return false;
    const logical = this.store.get(`SELECT * FROM run_links WHERE continuation_contract = 'logical_policy'
      AND parent_run_id = ? AND parent_suspension_state IN ('suspension_requested','suspended_for_repair','resumable','blocked')
      ORDER BY created_at DESC LIMIT 1`, run.id);
    if (logical) {
      if (this.parentRepairWorkInFlight(run.id)) return false;
      // A committed invocation or Host admission with no running state is an unknown launch boundary.
      // Let P1 recovery interrupt it and block the Parent instead of treating it as an idle suspension.
      if (this.store.get(`SELECT id FROM attempts WHERE run_id = ? AND state IN ('scheduled','waiting')
        AND (invocation_artifact_id IS NOT NULL OR id IN (SELECT attempt_id FROM attempt_custody))
        AND NOT EXISTS (SELECT 1 FROM journal_events j WHERE j.run_id = attempts.run_id AND j.attempt_id = attempts.id AND j.event_type = 'attempt.launch_withdrawn')`, run.id)) return false;
      return true;
    }
    if (run.state !== 'waiting_for_user') return false;
    if (this.store.get(`SELECT id FROM attempts WHERE run_id = ? AND state IN (${ACTIVE_ATTEMPT_STATES.map(() => '?').join(',')})`, run.id, ...ACTIVE_ATTEMPT_STATES)) return false;
    return Boolean(this.linkByParent(run.id) || this.store.get("SELECT id FROM lifecycle_operations WHERE run_id = ? AND state = 'intent'", run.id));
  };

  // Scheduler state for a held run is rebuilt from durable records, as startRun does for queued runs.
  P.ensureRunState = function (runId) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const state = this.loadRunState(this.requireRun(runId));
    this.runs.set(runId, state);
    return state;
  };

  P.parentRepairRequestMatches = function (authorization, parentRunId, body) {
    return authorization?.contract === 'logical_policy' && authorization.parentRunId === parentRunId
      && authorization.incidentId === body.incidentId && authorization.failedNodeInstanceId === body.failedNodeInstanceId
      && authorization.repairWorkflowId === body.repairWorkflowId
      && authorization.repairSnapshotSha256 === body.repairWorkflowSnapshotSha256
      && authorization.repairWorkspaceId === body.repairWorkspaceId
      && authorization.repairResultNodeInstanceId === body.repairResultNodeInstanceId
      && authorization.expectedRepairResultSha256 === body.expectedRepairResultSha256
      && authorization.failedNodeRetry === body.failedNodeRetry;
  };

  P.logicalRepairCanStart = function (repairRunId) {
    const link = this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND continuation_contract = 'logical_policy'", repairRunId);
    if (!link) return true;
    if (link.state !== 'open' || link.parent_suspension_state !== 'suspended_for_repair') return false;
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    if (!parent || !['running', 'waiting_for_user'].includes(parent.state) || this.parentRepairWorkInFlight(parent.id)) return false;
    if (!this.logicalRepairLinkIntact(link)) {
      this.refuseLinkedRepairContinuation(link, { code: 'coordination_invalid', message: 'The persisted Parent/Repair contract or pinned published definition failed validation.' });
      return false;
    }
    return true;
  };

  P.blockLogicalRepair = function (link, code, message) {
    const at = now();
    return this.store.transaction(() => {
      const changed = this.store.run(`UPDATE run_links SET state = 'blocked', parent_suspension_state = 'blocked', updated_at = ?
        WHERE id = ? AND continuation_contract = 'logical_policy' AND state IN ('open','repair_completed','repair_accepted')`, at, link.id).changes;
      if (!changed) return false;
      const payload = { linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id, code, message };
      this.store.appendEvents(link.parent_run_id, [event('continuation.parent_resumption_blocked', payload)]);
      this.store.appendEvents(link.repair_run_id, [event('continuation.parent_resumption_blocked', payload)]);
      return true;
    });
  };

  P.blockLogicalRepairForTerminalParent = function (link, parent) {
    const stopped = ['stopping', 'canceled'].includes(parent.state);
    const next = stopped ? 'parent_stopped' : 'blocked';
    const parentState = stopped ? 'stopped' : 'blocked';
    const changed = this.store.transaction(() => {
      const updated = this.store.run(`UPDATE run_links SET state = ?, parent_suspension_state = ?, updated_at = ?
        WHERE id = ? AND continuation_contract = 'logical_policy' AND state IN ('open','repair_failed','repair_completed','repair_accepted')`,
        next, parentState, now(), link.id).changes;
      if (updated) {
        const payload = { linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id,
          code: stopped ? 'parent_stopped' : 'parent_not_resumable', message: `The Parent is ${parent.state}.` };
        this.store.appendEvents(link.parent_run_id, [event('continuation.parent_resumption_blocked', payload)]);
        this.store.appendEvents(link.repair_run_id, [event('continuation.parent_resumption_blocked', payload)]);
      }
      return Boolean(updated);
    });
    if (changed) this.stopLogicalRepairRun(link);
    return false;
  };

  P.settleParentRepairSuspension = function (linkId) {
    const link = this.store.get('SELECT * FROM run_links WHERE id = ? AND continuation_contract = \'logical_policy\'', linkId);
    if (!link || link.state !== 'open') return false;
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    if (!parent) return this.blockLogicalRepair(link, 'parent_missing', 'The original Parent Run is missing.');
    if (['stopping', 'succeeded', 'failed', 'canceled', 'interrupted'].includes(parent.state)) return this.blockLogicalRepairForTerminalParent(link, parent);
    if (this.parentRepairWorkInFlight(parent.id)) return false;
    const target = this.latestAttempt(parent.id, link.resume_node_instance_id);
    if (!target) return this.blockLogicalRepair(link, 'checkpoint_missing', 'The incident checkpoint no longer has its Parent node attempt.');
    if (['interrupted', 'blocked'].includes(target.state)) {
      return this.blockLogicalRepair(link, 'parent_effect_uncertain', `The Parent node is ${target.state}; the coordinator will not replay it automatically.`);
    }
    if (parent.state === 'draining') {
      const state = this.ensureRunState(parent.id);
      this.finishRunIfDone(state);
    }
    const current = this.store.get('SELECT * FROM runs WHERE id = ?', parent.id);
    if (!current || !['running', 'waiting_for_user'].includes(current.state)) return false;
    if (link.parent_suspension_state === 'suspension_requested') {
      this.store.transaction(() => {
        const changed = this.store.run(`UPDATE run_links SET parent_suspension_state = 'suspended_for_repair', updated_at = ?
          WHERE id = ? AND continuation_contract = 'logical_policy' AND state = 'open' AND parent_suspension_state = 'suspension_requested'`, now(), link.id).changes;
        if (changed) this.store.appendEvents(parent.id, [event('continuation.parent_suspended_for_repair', {
          linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id, resumeNodeInstanceId: link.resume_node_instance_id,
          checkpoint: link.checkpoint_artifact_id })]);
      });
    }
    if (this.store.get('SELECT state FROM runs WHERE id = ?', link.repair_run_id)?.state === 'queued'
      && this.logicalRepairCanStart(link.repair_run_id)) queueMicrotask(() => this.startRun());
    return true;
  };

  P.recordLogicalRepairOutcome = function (link, to) {
    if (link.state !== 'open' || link.continuation_contract !== 'logical_policy') return null;
    const at = now();
    if (to === 'succeeded') {
      if (!this.logicalRepairLinkIntact(link)) {
        this.blockLogicalRepair(link, 'coordination_invalid', 'Repair outcome acceptance failed the persisted identity, publication or workspace checks.');
        return null;
      }
      let actualDigest = null;
      try {
        const attempt = this.latestAttempt(link.repair_run_id, link.repair_result_node_instance_id);
        const outputs = attempt?.state === 'succeeded' && attempt.outputs_artifact_id ? this.store.readJson(attempt.outputs_artifact_id).values : null;
        if (outputs?.text?.artifact) actualDigest = this.store.verifyRef(outputs.text.artifact).sha256;
      } catch { actualDigest = null; }
      if (actualDigest === link.expected_repair_result_sha256) {
        const changed = this.store.run(`UPDATE run_links SET state = 'repair_accepted', repair_outcome = 'succeeded', decision_status = 'accepted',
          parent_suspension_state = 'resumable', updated_at = ? WHERE id = ? AND state = 'open'`, at, link.id).changes;
        if (!changed) return null;
        const payload = { linkId: link.id, incidentId: link.incident_id, parentRunId: link.parent_run_id, repairRunId: link.repair_run_id,
          resultNodeInstanceId: link.repair_result_node_instance_id, resultSha256: actualDigest };
        this.store.appendEvents(link.repair_run_id, [event('continuation.repair_completed', payload), event('continuation.repair_result_accepted', payload)]);
        this.store.appendEvents(link.parent_run_id, [event('continuation.repair_result_accepted', payload)]);
        return this.store.get('SELECT * FROM run_links WHERE id = ?', link.id);
      }
      const changed = this.store.run(`UPDATE run_links SET state = 'repair_failed', repair_outcome = 'succeeded', decision_status = 'rejected',
        parent_suspension_state = 'suspended_for_repair', updated_at = ? WHERE id = ? AND state = 'open'`, at, link.id).changes;
      if (changed) {
        const payload = { linkId: link.id, incidentId: link.incident_id, code: 'repair_result_mismatch', expectedSha256: link.expected_repair_result_sha256, actualSha256: actualDigest };
        this.store.appendEvents(link.repair_run_id, [event('continuation.repair_result_rejected', payload)]);
        this.store.appendEvents(link.parent_run_id, [event('continuation.repair_result_rejected', payload), event('continuation.repair_failed', { ...payload, repairRunId: link.repair_run_id, repairState: 'succeeded' })]);
      }
      return null;
    }
    const changed = this.store.run(`UPDATE run_links SET state = 'repair_failed', repair_outcome = ?, decision_status = 'rejected',
      parent_suspension_state = 'suspended_for_repair', updated_at = ? WHERE id = ? AND state = 'open'`, to, at, link.id).changes;
    if (changed) this.store.appendEvents(link.parent_run_id, [event('continuation.repair_failed', {
      linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id, repairState: to })]);
    return null;
  };

  P.resumeLogicalRepairParent = function (link) {
    if (!link || link.continuation_contract !== 'logical_policy' || link.state !== 'repair_accepted') return false;
    if (!this.logicalRepairLinkIntact(link)) return this.blockLogicalRepair(link, 'coordination_invalid', 'Parent continuation failed the persisted identity, publication or workspace checks.');
    if (this.parentRepairWorkInFlight(link.parent_run_id)) return false;
    let resumed = false;
    try {
      resumed = this.store.transaction(() => {
        const parent = this.requireRun(link.parent_run_id);
        if (['stopping', 'succeeded', 'failed', 'canceled', 'interrupted'].includes(parent.state)) {
          const stopped = ['stopping', 'canceled'].includes(parent.state);
          this.store.run("UPDATE run_links SET state = ?, parent_suspension_state = ?, updated_at = ? WHERE id = ? AND state = 'repair_accepted'",
            stopped ? 'parent_stopped' : 'blocked', stopped ? 'stopped' : 'blocked', now(), link.id);
          this.store.appendEvents(parent.id, [event('continuation.parent_resumption_blocked', { linkId: link.id, incidentId: link.incident_id,
            code: stopped ? 'parent_stopped' : 'parent_not_resumable', message: `The Parent is ${parent.state}.` })]);
          return false;
        }
        if (!['running', 'waiting_for_user'].includes(parent.state)) return false;
        if (!this.store.run(`UPDATE run_links SET state = 'resumed', parent_suspension_state = 'resumed', updated_at = ?
          WHERE id = ? AND continuation_contract = 'logical_policy' AND state = 'repair_accepted' AND decision_status = 'accepted'`, now(), link.id).changes) return false;
        const state = this.ensureRunState(parent.id);
        const events = [];
        const attempt = this.latestAttempt(parent.id, link.resume_node_instance_id);
        const launchWithdrawal = attempt && this.store.get(`SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ?
          AND event_type = 'attempt.launch_withdrawn' ORDER BY sequence DESC LIMIT 1`, parent.id, attempt.id);
        const withdrawnBeforeLaunch = ['scheduled', 'waiting'].includes(attempt?.state) && launchWithdrawal
          && (() => { const payload = JSON.parse(launchWithdrawal.envelope_json).payload;
            return payload.reason === 'parent_suspension' && payload.launchRequestSent === false; })();
        if (withdrawnBeforeLaunch) {
          // A Host admission is single-use per Attempt ID, even when the launch request was never sent. Preserve that
          // no-effect Attempt as canceled and plan a new one atomically; this is not a retry of an operation that ran.
          const located = this.locate(state, link.resume_node_instance_id);
          events.push(...this.attemptTransition(attempt, 'canceled', 'Parent suspension withdrew this attempt before provider launch; no operation ran.'));
          this.planAttempt(state, link.resume_node_instance_id, located.node.id, located.node.type, null, events,
            'Continue after Parent suspension withdrew the prior attempt before provider launch.');
        } else if (['failed', 'canceled'].includes(attempt?.state)) {
          if (link.failed_node_retry !== 'explicit_safe') {
            throw new ApiError(409, 'retry_not_authorized', 'The failed Parent node was not explicitly authorized for safe retry.');
          }
          this.retry(state, { nodeInstanceId: link.resume_node_instance_id, reason: 'Resumed after the trusted Repair result matched its authorized digest.' }, events);
        } else if (['interrupted', 'blocked'].includes(attempt?.state)) {
          throw new ApiError(409, 'parent_effect_uncertain', `The Parent node is ${attempt.state}; an uncertain operation cannot be replayed.`);
        }
        events.push(event('continuation.parent_resumed', { linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id,
          resumeNodeInstanceId: link.resume_node_instance_id }));
        if (parent.state === 'waiting_for_user') events.push(this.runEvent(parent, 'running', 'Resumed after the authorized linked Repair result was accepted.'));
        this.store.appendEvents(parent.id, events);
        return true;
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.store.transaction(() => {
        const changed = this.store.run(`UPDATE run_links SET state = 'blocked', parent_suspension_state = 'blocked', updated_at = ? WHERE id = ? AND state = 'repair_accepted'`, now(), link.id).changes;
        if (changed) this.store.appendEvents(link.parent_run_id, [event('continuation.parent_resumption_blocked', { linkId: link.id, incidentId: link.incident_id, code: error.code, message: error.message })]);
      });
      return false;
    }
    if (resumed) queueMicrotask(() => this.pump());
    return resumed;
  };

  P.stopLogicalRepairRun = function (link) {
    const repair = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
    if (!repair || !['queued', 'running', 'draining', 'waiting_for_user'].includes(repair.state)) return false;
    queueMicrotask(() => {
      const current = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
      if (!current || !['queued', 'running', 'draining', 'waiting_for_user'].includes(current.state)) return;
      // A queued Repair has not yet been loaded into the scheduler after Engine recovery. Rebuild it before Stop
      // so the ordinary Stop settlement can durably cancel it without ever dispatching provider work.
      if (current.state === 'queued') this.ensureRunState(current.id);
      this.stopRun(current.id, { requestId: randomUUID() });
    });
    return true;
  };

  P.afterLogicalParentStop = function (parentRunId) {
    const link = this.store.get(`SELECT * FROM run_links WHERE parent_run_id = ? AND continuation_contract = 'logical_policy'
      AND state IN ('open','repair_failed','repair_completed','repair_accepted') ORDER BY created_at DESC LIMIT 1`, parentRunId);
    if (!link) return false;
    this.store.transaction(() => {
      this.store.run(`UPDATE run_links SET state = 'parent_stopped', parent_suspension_state = 'stopped', updated_at = ?
        WHERE id = ? AND state IN ('open','repair_failed','repair_completed','repair_accepted')`, now(), link.id);
      this.store.appendEvents(parentRunId, [event('continuation.parent_resumption_blocked', { linkId: link.id, incidentId: link.incident_id,
        code: 'parent_stopped', message: 'The Parent was explicitly stopped during Repair.' })]);
    });
    this.stopLogicalRepairRun(link);
    return true;
  };

  P.afterLogicalParentClose = function (parentRunId) {
    const link = this.store.get(`SELECT * FROM run_links WHERE parent_run_id = ? AND continuation_contract = 'logical_policy'
      AND state IN ('open','repair_failed','repair_completed','repair_accepted') ORDER BY created_at DESC LIMIT 1`, parentRunId);
    if (!link) return false;
    const at = now();
    const changed = this.store.transaction(() => {
      const updated = this.store.run(`UPDATE run_links SET state = 'blocked', parent_suspension_state = 'blocked', updated_at = ?
        WHERE id = ? AND state IN ('open','repair_failed','repair_completed','repair_accepted')`, at, link.id).changes;
      if (updated) {
        const payload = { linkId: link.id, incidentId: link.incident_id, repairRunId: link.repair_run_id,
          code: 'parent_closed', message: 'The Parent was closed while linked Repair was active.' };
        this.store.appendEvents(parentRunId, [event('continuation.parent_resumption_blocked', payload)]);
        this.store.appendEvents(link.repair_run_id, [event('continuation.parent_resumption_blocked', payload)]);
      }
      return Boolean(updated);
    });
    if (!changed) return false;
    this.stopLogicalRepairRun(link);
    return true;
  };

  P.startLogicalParentRepair = function (parentRunId, body) {
    this.validateBody('parentRepairCoordinationRequest', body);
    let linkId = null;
    return this.idempotent(`POST /runs/${parentRunId}/linked-repair`, body.requestId, body, () => {
      const existing = this.logicalRepairLinkForIncident(body.incidentId);
      if (existing) {
        const authorization = this.parentRepairAuthorization(existing);
        if (!this.parentRepairRequestMatches(authorization, parentRunId, body))
          fail(409, 'conflict', 'This incident is already associated with a different Parent/Repair request.');
        linkId = existing.id;
        return { status: 200, body: { ...this.repairCoordinationBody(existing), outcome: 'existing', requestId: body.requestId } };
      }

      const parent = this.requireRun(parentRunId);
      if (!['running', 'draining', 'waiting_for_user'].includes(parent.state)) fail(409, 'conflict', `The Parent cannot be suspended for Repair from state ${parent.state}.`);
      if (parent.kind !== 'workflow' || parent.journal_version !== 2 || !parent.published_version_id || !this.publishedDefinitionIntact(parent))
        fail(409, 'parent_ineligible', 'P2 requires an intact, published workflow Parent using journal version 2.');
      if (this.store.get("SELECT id FROM control_grants WHERE run_id = ? AND state = 'active'", parentRunId))
        fail(409, 'supervised_parent_ineligible', 'P2 cannot suspend a Parent with an active supervision grant because its controller cannot be restored after Engine replacement.');
      const parentWorkflow = this.store.readJson(parent.workflow_snapshot_artifact_id);
      if (allNodesDeep(parentWorkflow.nodes).some(node => ['loop', 'map', 'task'].includes(node.type)))
        fail(409, 'unsupported_execution_class', 'P2 continuation supports sequential workflows without Loop, Map or Task nodes.');

      const target = this.latestAttempt(parentRunId, body.failedNodeInstanceId);
      if (!target) fail(404, 'not_found', `Parent node "${body.failedNodeInstanceId}" has no attempt to checkpoint.`);
      if (!['scheduled', 'waiting', 'running', 'failed', 'canceled'].includes(target.state))
        fail(409, 'parent_checkpoint_unsafe', `Parent node "${body.failedNodeInstanceId}" is ${target.state}; P2 cannot retry an uncertain or already accepted result.`);
      if (this.store.get("SELECT id FROM run_links WHERE parent_run_id = ? AND state IN ('open','repair_completed','repair_accepted')", parentRunId))
        fail(409, 'conflict', 'The Parent already has an active linked Repair.');

      const repairWorkspace = this.requireWorkspace(body.repairWorkspaceId);
      const parentWorkspace = this.requireWorkspace(parent.workspace_id);
      const isolationIssue = this.linkedRepairWorkspaceIssue(parentWorkspace, repairWorkspace);
      if (isolationIssue) fail(422, isolationIssue.code, isolationIssue.message);
      const publication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id
        WHERE p.workflow_id = ? AND a.sha256 = ? AND p.runnable = 1 ORDER BY p.version DESC LIMIT 1`,
        body.repairWorkflowId, body.repairWorkflowSnapshotSha256);
      if (!publication || publication.snapshot_sha256 !== body.repairWorkflowSnapshotSha256)
        fail(409, 'published_version_not_runnable', 'P2 Repair requires the exact requested Runnable Published Version.');
      const repairSnapshot = this.store.artifactRow(publication.snapshot_artifact_id);
      const repairWorkflow = this.store.readJson(repairSnapshot.id);
      if (allNodesDeep(repairWorkflow.nodes).some(node => ['loop', 'map', 'task'].includes(node.type)))
        fail(409, 'unsupported_execution_class', 'P2 Repair supports sequential workflows without Loop, Map or Task nodes.');
      const resultNode = allNodesDeep(repairWorkflow.nodes).find(node => node.id === body.repairResultNodeInstanceId);
      if (!resultNode || !['agent', 'text'].includes(resultNode.type))
        fail(422, 'validation_failed', 'The accepted Repair result must name a published Agent or Text node with a text output.');

      const captured = this.captureRun({ workflow: repairWorkflow, snapshot: repairSnapshot, workspace: repairWorkspace, kind: 'workflow', publication,
        options: { mode: 'workflow', targets: [], refreshCaches: [] }, requestId: body.requestId });
      const repairRunId = captured.body.run.runId;
      const link = { id: randomUUID(), incidentId: body.incidentId, parentRunId, repairRunId, failedNodeInstanceId: body.failedNodeInstanceId,
        repairWorkflowId: body.repairWorkflowId, repairSnapshotSha256: body.repairWorkflowSnapshotSha256, repairWorkspaceId: body.repairWorkspaceId,
        repairResultNodeInstanceId: body.repairResultNodeInstanceId, expectedRepairResultSha256: body.expectedRepairResultSha256,
        failedNodeRetry: body.failedNodeRetry };
      const at = now();
      const activeParentWork = this.parentRepairWorkInFlight(parentRunId);
      const authorization = this.store.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy',
        authorizedBy: 'owner-token-control-surface', requestId: body.requestId, incidentId: body.incidentId, parentRunId, repairRunId,
        parentPublishedVersionId: parent.published_version_id, parentSnapshotSha256: this.store.artifactRow(parent.workflow_snapshot_artifact_id).sha256,
        repairWorkflowId: body.repairWorkflowId, repairPublishedVersionId: publication.id, repairSnapshotSha256: body.repairWorkflowSnapshotSha256,
        repairWorkspaceId: body.repairWorkspaceId, failedNodeInstanceId: body.failedNodeInstanceId,
        repairResultNodeInstanceId: body.repairResultNodeInstanceId, expectedRepairResultSha256: body.expectedRepairResultSha256,
        failedNodeRetry: body.failedNodeRetry, logicalAcceptance: 'exact_text_artifact_sha256' });
      const checkpoint = this.store.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', contract: 'logical_policy', incidentId: body.incidentId,
        parentRunId, parentPublishedVersionId: parent.published_version_id, parentSnapshotSha256: this.store.artifactRow(parent.workflow_snapshot_artifact_id).sha256,
        resumeNodeInstanceId: body.failedNodeInstanceId, targetAttemptId: target.id, targetAttemptState: target.state,
        acceptedParentAttempts: this.latestAttempts(parentRunId).filter(item => ['succeeded', 'reused', 'skipped'].includes(item.state))
          .map(item => ({ attemptId: item.id, nodeInstanceId: item.node_instance_id, state: item.state, outputsArtifactId: item.outputs_artifact_id })),
        repairRunId, repairPublishedVersionId: publication.id, repairWorkspaceId: body.repairWorkspaceId,
        failedNodeRetry: body.failedNodeRetry, authorizedAt: at });
      this.store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
        resume_node_instance_id, candidate_digest, checkpoint_artifact_id, state, continuation_contract, incident_id,
        parent_suspension_state, repair_outcome, decision_status, authorization_artifact_id, repair_result_node_instance_id,
        expected_repair_result_sha256, failed_node_retry, created_at, updated_at)
        VALUES (?, 'linked_repair', ?, ?, ?, ?, ?, NULL, ?, 'open', 'logical_policy', ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?)`,
        link.id, parentRunId, repairRunId, parent.workspace_id, repairWorkspace.id, body.failedNodeInstanceId, checkpoint.artifactId,
        body.incidentId, activeParentWork ? 'suspension_requested' : 'suspended_for_repair', authorization.artifactId,
        body.repairResultNodeInstanceId, body.expectedRepairResultSha256, body.failedNodeRetry, at, at);
      linkId = link.id;
      this.store.appendEvents(parentRunId, [event('continuation.linked_repair_opened', { linkId: link.id, incidentId: body.incidentId,
        repairRunId, resumeNodeInstanceId: body.failedNodeInstanceId, checkpoint: checkpoint.artifactId, contract: 'logical_policy' }),
        event('continuation.parent_suspension_requested', { linkId: link.id, incidentId: body.incidentId, repairRunId,
          activeParentWork: activeParentWork, checkpoint: checkpoint.artifactId })]);
      this.store.appendEvents(repairRunId, [event('continuation.linked_repair_started', { linkId: link.id, incidentId: body.incidentId,
        parentRunId, contract: 'logical_policy' })]);
      return { status: 202, body: { ...this.repairCoordinationBody(this.store.get('SELECT * FROM run_links WHERE id = ?', link.id)),
        outcome: 'created', requestId: body.requestId } };
    }, () => queueMicrotask(() => {
      if (linkId) this.settleParentRepairSuspension(linkId);
      this.startRun();
    }));
  };

  // Suspend a Parent and create its linked Repair through the existing Owner-authenticated control route.
  P.linkRepair = function (parentRunId, body) {
    if (body?.incidentId) return this.startLogicalParentRepair(parentRunId, body);
    this.validateBody('linkRepairRequest', body);
    return this.idempotent(`POST /runs/${parentRunId}/linked-repair`, body.requestId, body, () => {
      const parent = this.requireRun(parentRunId);
      if (parent.state !== 'waiting_for_user') fail(409, 'conflict', `Only a run waiting for the user can be suspended for repair (state is ${parent.state}).`);
      if (this.linkByParent(parentRunId, ['open', 'repair_completed', 'resumed', 'repair_failed'])) fail(409, 'conflict', 'This run already has a linked repair.');
      const failed = this.latestAttempt(parentRunId, body.failedNodeInstanceId);
      if (!failed || !['failed', 'canceled'].includes(failed.state)) fail(409, 'conflict', `Node "${body.failedNodeInstanceId}" has no failed attempt to resume.`);
      const repairWorkspace = this.requireWorkspace(body.repairWorkspaceId);
      const parentWorkspace = this.requireWorkspace(parent.workspace_id);
      const isolationIssue = this.linkedRepairWorkspaceIssue(parentWorkspace, repairWorkspace);
      if (isolationIssue) fail(422, isolationIssue.code, isolationIssue.message);
      const publication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id
        WHERE p.workflow_id = ? AND p.definition_digest = ? AND p.runnable = 1 ORDER BY p.version DESC LIMIT 1`, body.repairWorkflowId, body.repairWorkflowSnapshotSha256);
      if (!publication) fail(409, 'published_version_not_runnable', 'Linked Repair requires an exact Runnable Published Version with the requested definition digest.');
      const snapshot = this.store.artifactRow(publication.snapshot_artifact_id);
      if (snapshot.sha256 !== body.repairWorkflowSnapshotSha256 || publication.snapshot_sha256 !== body.repairWorkflowSnapshotSha256) fail(409, 'conflict', 'The repair workflow changed; reload it before linking.');
      const workflow = this.store.readJson(snapshot.id);
      const judges = allNodesDeep(workflow.nodes).filter(node => node.type === 'agent' && node.config.role === 'judge');
      if (judges.length !== 1) fail(422, 'validation_failed', 'A repair workflow must declare exactly one designated Judge.');
      const captured = this.captureRun({ workflow, snapshot, workspace: repairWorkspace, kind: 'workflow', publication,
        options: { mode: 'workflow', targets: [], refreshCaches: [] }, requestId: body.requestId });
      const repairRunId = captured.body.run.runId;
      const createdAt = now();
      const checkpoint = this.store.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', parentRunId, parentWorkflowId: parent.workflow_id,
        parentSnapshotSha256: this.store.artifactRow(parent.workflow_snapshot_artifact_id).sha256, resumeNodeInstanceId: body.failedNodeInstanceId,
        reason: 'linked_repair', repairRunId, candidateDigest: body.candidateDigest, continuationCheckpointId: body.continuationCheckpointId, suspendedAt: createdAt });
      const linkId = randomUUID();
      this.store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id, candidate_digest, checkpoint_artifact_id, state, created_at, updated_at)
        VALUES (?, 'linked_repair', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`, linkId, parentRunId, repairRunId, parent.workspace_id, repairWorkspace.id, body.failedNodeInstanceId, body.candidateDigest, checkpoint.artifactId, createdAt, createdAt);
      this.store.appendEvents(parentRunId, [event('continuation.linked_repair_opened', { linkId, repairRunId, resumeNodeInstanceId: body.failedNodeInstanceId, candidateDigest: body.candidateDigest, checkpoint: checkpoint.artifactId })]);
      this.store.appendEvents(repairRunId, [event('continuation.linked_repair_started', { linkId, parentRunId })]);
      return { status: 202, body: { linkId, state: 'open', parentRunId, repairRunId, resumeNodeInstanceId: body.failedNodeInstanceId, candidateDigest: body.candidateDigest, continuationCheckpointId: body.continuationCheckpointId } };
    }, () => queueMicrotask(() => this.startRun()));
  };

  // Judge proposal (ADR-0008 Step C, ADR-0009 section 6). Called on the success path of an agent, before its outputs commit.
  // Returns none (not a repair run, or no marker), refuse (fail the attempt with a named code) or intent (record and gate).
  P.lifecycleProposalFor = function (state, node, text) {
    const link = this.openLinkOfRepair(state.id);
    if (!link) return { kind: 'none' };
    const isolationIssue = this.linkedRepairWorkspaceIssueForLink(link);
    if (isolationIssue) {
      this.refuseLinkedRepairExecution(state, isolationIssue);
      return { kind: 'refuse', code: isolationIssue.code, message: isolationIssue.message };
    }
    const markers = [...text.matchAll(PROPOSAL)];
    if (link.continuation_contract === 'logical_policy') {
      return markers.length ? { kind: 'refuse', code: 'lifecycle_unauthorized', message: 'A logical-policy Repair cannot request a protected lifecycle action.' } : { kind: 'none' };
    }
    if (node.config.role !== 'judge') {
      return markers.length ? { kind: 'refuse', code: 'lifecycle_unauthorized', message: 'Only the designated Judge may propose a lifecycle action for a linked repair.' } : { kind: 'none' };
    }
    if (markers.length !== 1) return { kind: 'refuse', code: 'lifecycle_contract', message: 'The designated Judge of a linked repair must state exactly one lifecycle proposal.' };
    let proposal;
    try { proposal = parseStrictJson(markers[0][1]); }
    catch { return { kind: 'refuse', code: 'lifecycle_contract', message: 'The lifecycle proposal is not valid JSON.' }; }
    const wellFormed = proposal && proposal.action === 'application.activate_candidate' && typeof proposal.target_version === 'string'
      && proposal.target_version.length >= 1 && proposal.target_version.length <= 64 && typeof proposal.candidate_digest === 'string' && SHA256.test(proposal.candidate_digest)
      && typeof proposal.continuation_checkpoint_id === 'string';
    if (!wellFormed) return { kind: 'refuse', code: 'lifecycle_contract', message: 'The lifecycle proposal does not match application.activate_candidate.' };
    if (proposal.candidate_digest !== link.candidate_digest) return { kind: 'refuse', code: 'lifecycle_candidate_mismatch', message: 'The proposal names a candidate other than the linked repair candidate.' };
    const checkpoint = this.store.readJson(link.checkpoint_artifact_id);
    if (proposal.continuation_checkpoint_id !== checkpoint.continuationCheckpointId) return { kind: 'refuse', code: 'lifecycle_checkpoint_mismatch', message: 'The proposal names a continuation checkpoint other than the linked one.' };
    if (this.lifecycleHost && (!this.lifecycleHost.installationId || !this.lifecycleHost.profileRoot || !this.lifecycleHost.generation || !this.lifecycleHost.buildId))
      return { kind: 'refuse', code: 'lifecycle_host_unavailable', message: 'The authenticated Lifecycle Host bootstrap is incomplete.' };
    return { kind: 'intent', link, proposal: { action: proposal.action, targetVersion: proposal.target_version, candidateDigest: proposal.candidate_digest, continuationCheckpointId: proposal.continuation_checkpoint_id } };
  };

  // Records the accepted proposal as a lifecycle intent and holds the repair at its gate. Runs inside the attempt's commit.
  P.openLifecycleIntent = function (state, attempt, nodeInstanceId, intent) {
    const at = now(), operationId = randomUUID();
    const host = this.lifecycleHost;
    const proposalArtifact = this.store.putJson({ schemaVersion: 1, kind: 'LifecycleProposal', operationId, runId: state.id, nodeInstanceId, attemptId: attempt.id,
      workflowId: this.requireRun(state.id).workflow_id, engineValidatedRole: 'judge', ...intent });
    this.store.run(`INSERT INTO lifecycle_operations(id, run_id, node_instance_id, action, candidate_digest, target_version, continuation_checkpoint_id, proposal_artifact_id,
      installation_id, profile_root, expected_generation, state, created_at, updated_at)
      VALUES (?, ?, ?, 'application.activate_candidate', ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`, operationId, state.id, nodeInstanceId, intent.candidateDigest, intent.targetVersion,
      intent.continuationCheckpointId, proposalArtifact.artifactId, host?.installationId ?? null, host?.profileRoot ?? null, host?.generation ?? null, at, at);
    const row = { id: state.id };
    return [
      event('continuation.lifecycle_intent', { operationId, action: intent.action, candidateDigest: intent.candidateDigest, targetVersion: intent.targetVersion, proposal: proposalArtifact.artifactId }),
      this.runEvent(row, 'waiting_for_user', 'Lifecycle proposal accepted; the repair waits for a verified lifecycle receipt.'),
    ];
  };

  P.lifecycleHostRequest = function (runId) {
    if (!this.lifecycleHost) return null;
    const link = this.openLinkOfRepair(runId);
    if (!link) return null;
    const isolationIssue = this.linkedRepairWorkspaceIssueForLink(link);
    if (isolationIssue) {
      this.refuseLinkedRepairContinuation(link, isolationIssue);
      return null;
    }
    const operation = this.lifecycleOfRun(runId);
    if (!operation || operation.state !== 'intent') return null;
    const proposal = this.store.readJson(operation.proposal_artifact_id);
    return {
      operationId: operation.id, action: operation.action, installationId: operation.installation_id, profileRoot: operation.profile_root,
      runId: operation.run_id, nodeInstanceId: operation.node_instance_id, candidateId: operation.target_version, candidateDigest: operation.candidate_digest,
      expectedGeneration: operation.expected_generation,
      judgeEvidence: { kind: 'engine_validated_designated_judge_decision', workflowId: proposal.workflowId, judgeNodeInstanceId: proposal.nodeInstanceId,
        attemptId: proposal.attemptId, checkpointId: proposal.continuationCheckpointId },
      readiness: { applicationResponsive: true, engineReady: true, sameProfile: true, sameStore: true },
    };
  };

  P.recordLifecycleHostDeliveryFailure = function (request, error) {
    const runId = request?.runId;
    if (!runId || !this.store.get('SELECT id FROM runs WHERE id = ?', runId)) return;
    this.store.appendEvents(runId, [event('continuation.lifecycle_host_delivery_failed', { operationId: request.operationId, message: String(error?.message || error).slice(0, 1000) })]);
  };

  // Lifecycle receipt (ADR-0008 Step D). Accepted only for the operation's own candidate, while the repair is at its gate.
  // Only the authenticated Lifecycle Host channel (applyHostLifecycleReceipt) may verify a receipt, in every runtime state.
  // An Owner Token, a candidate runtime or an unbound runtime has no path here.
  P.applyLifecycleReceipt = function (runId, body, { hostAuthenticated = false, receiptEvidence = null } = {}) {
    if (!hostAuthenticated) fail(403, 'trusted_host_channel_required', 'Lifecycle receipts must arrive through the authenticated Lifecycle Host channel.');
    this.validateBody('lifecycleReceiptRequest', body);
    const pendingOperation = this.lifecycleOfRun(runId);
    const pendingLink = this.openLinkOfRepair(runId);
    if (pendingOperation?.id === body.operationId && pendingOperation.state === 'intent' && pendingLink) {
      const isolationIssue = this.linkedRepairWorkspaceIssueForLink(pendingLink);
      if (isolationIssue) {
        this.refuseLinkedRepairContinuation(pendingLink, isolationIssue);
        fail(409, isolationIssue.code, isolationIssue.message);
      }
    }
    return this.idempotent(`POST /runs/${runId}/lifecycle-receipt`, body.requestId, body, () => {
      const run = this.requireRun(runId);
      const operation = this.lifecycleOfRun(runId);
      if (!operation || operation.id !== body.operationId) fail(404, 'not_found', 'No lifecycle operation with that identity belongs to this run.');
      if (operation.state === 'verified') {
        if (this.store.readJson(operation.receipt_artifact_id).receiptId !== body.receiptId) fail(409, 'conflict', 'The lifecycle operation already has a different verified receipt.');
        return { status: 200, body: this.lifecycleBody(operation) };
      }
      if (operation.candidate_digest !== body.candidateDigest) fail(409, 'lifecycle_candidate_mismatch', 'The receipt does not name the proposed candidate.');
      if (run.state !== 'waiting_for_user' || !this.openLinkOfRepair(runId)) fail(409, 'conflict', `The repair is not waiting for a lifecycle receipt (state is ${run.state}).`);
      const at = now();
      this.store.transaction(() => {
        const receipt = this.store.putJson({ schemaVersion: 1, kind: 'LifecycleReceipt', operationId: operation.id, receiptId: body.receiptId, candidateDigest: body.candidateDigest,
          outcome: 'verified', receivedAt: at, ...(receiptEvidence ? { hostReceipt: receiptEvidence } : {}) });
        this.store.run("UPDATE lifecycle_operations SET state = 'verified', receipt_artifact_id = ?, updated_at = ? WHERE id = ? AND state = 'intent'", receipt.artifactId, at, operation.id);
        this.ensureRunState(runId);
        this.store.appendEvents(runId, [event('continuation.lifecycle_verified', { operationId: operation.id, receiptId: body.receiptId }, 'HOST_RECEIPT'),
          this.runEvent({ id: runId }, 'running', 'Verified lifecycle receipt; the repair resumes its remaining work.')]);
      });
      return { status: 200, body: this.lifecycleBody(this.lifecycleOfRun(runId)) };
    }, () => queueMicrotask(() => this.pump()));
  };

  P.applyHostLifecycleReceipt = function (receipt) {
    const operation = this.lifecycleOfRun(receipt?.runId || this.store.get('SELECT run_id FROM lifecycle_operations WHERE id = ?', receipt?.operationId)?.run_id);
    if (!operation || operation.id !== receipt.operationId) fail(404, 'not_found', 'No matching lifecycle operation exists for the Host receipt.');
    if (operation.state === 'verified') {
      const saved = this.store.readJson(operation.receipt_artifact_id);
      if (saved.receiptId === receipt.receiptId && saved.hostReceipt?.receiptId === receipt.receiptId) return { status: 200, body: this.lifecycleBody(operation), duplicate: true };
      fail(409, 'conflict', 'The operation already has a different verified Host receipt.');
    }
    const host = this.lifecycleHost;
    const identity = this.runtimeIdentity();
    const valid = host && receipt.operationId === operation.id && receipt.installationId === operation.installation_id
      && receipt.profileRoot === operation.profile_root && receipt.candidateId === operation.target_version
      && receipt.candidateDigest === operation.candidate_digest && receipt.previousGeneration === operation.expected_generation
      && receipt.activatedGeneration === host.generation && receipt.enginePid === process.pid
      && receipt.applicationPid === host.applicationPid && receipt.applicationBuildId === host.buildId
      && receipt.runtimeInstanceId === identity.runtimeInstanceId
      && receipt.storeId === identity.storeId && receipt.actualActivation === true
      && receipt.applicationResponsive === true && receipt.engineReady === true;
    if (!valid) fail(409, 'lifecycle_receipt_mismatch', 'The Host receipt does not match the authorized operation, candidate, generation, profile, or ready Engine.');
    return this.applyLifecycleReceipt(operation.run_id, { requestId: receipt.receiptId, operationId: receipt.operationId, candidateDigest: receipt.candidateDigest,
      outcome: 'verified', receiptId: receipt.receiptId }, { hostAuthenticated: true, receiptEvidence: receipt });
  };

  // Terminal transition of a repair run (called inside the run's own terminal transaction).
  P.recordRepairOutcome = function (repairRunId, to) {
    const link = this.openLinkOfRepair(repairRunId);
    if (!link) return null;
    if (link.continuation_contract === 'logical_policy') return this.recordLogicalRepairOutcome(link, to);
    const at = now();
    if (to === 'succeeded') {
      this.store.run("UPDATE run_links SET state = 'repair_completed', updated_at = ? WHERE id = ? AND state = 'open'", at, link.id);
      this.store.appendEvents(repairRunId, [event('continuation.repair_completed', { linkId: link.id, parentRunId: link.parent_run_id })]);
      return link;
    }
    // A failed, canceled or interrupted repair never resumes its parent; the parent stays suspended for an explicit decision.
    this.store.run("UPDATE run_links SET state = 'repair_failed', updated_at = ? WHERE id = ? AND state = 'open'", at, link.id);
    this.store.appendEvents(link.parent_run_id, [event('continuation.repair_failed', { linkId: link.id, repairRunId, repairState: to })]);
    return null;
  };

  // Resumes a suspended parent in place at its suspended node (ADR-0008 Step D). The compare-and-set on the link is the claim:
  // a second pass finds the link already resumed and does nothing.
  P.resumeLinkedParent = function (link) {
    const isolationIssue = this.linkedRepairWorkspaceIssueForLink(link);
    if (isolationIssue) {
      this.refuseLinkedRepairContinuation(link, isolationIssue);
      return false;
    }
    let claimed;
    try {
      claimed = this.store.transaction(() => {
        const at = now();
        if (!this.store.run("UPDATE run_links SET state = 'resumed', updated_at = ? WHERE id = ? AND state = 'repair_completed'", at, link.id).changes) return false;
        const parent = this.requireRun(link.parent_run_id);
        const state = this.ensureRunState(parent.id);
        const events = [];
        this.retry(state, { nodeInstanceId: link.resume_node_instance_id, reason: 'Resumed in place after the linked repair completed.' }, events);
        events.push(event('continuation.parent_resumed', { linkId: link.id, repairRunId: link.repair_run_id, resumeNodeInstanceId: link.resume_node_instance_id }));
        events.push(this.runEvent(parent, 'running', 'Resumed after the linked repair completed.'));
        this.store.appendEvents(parent.id, events);
        return true;
      });
    } catch (error) {
      // A parent that cannot legally resume stays suspended and visible; the repair's success is kept, nothing is retried blindly.
      if (!(error instanceof ApiError)) throw error;
      this.store.appendEvents(link.parent_run_id, [event('continuation.parent_resume_refused', { linkId: link.id, code: error.code, message: error.message })]);
      return false;
    }
    if (claimed) queueMicrotask(() => this.pump());
    return claimed;
  };

  // Finds the lifecycle gate of a repair whose receipt is verified and releases it. Idempotent.
  P.releaseVerifiedLifecycle = function (runId) {
    const operation = this.lifecycleOfRun(runId);
    if (!operation || operation.state !== 'verified') return false;
    const link = this.openLinkOfRepair(runId);
    if (!link) return false;
    const isolationIssue = this.linkedRepairWorkspaceIssueForLink(link);
    if (isolationIssue) {
      this.refuseLinkedRepairContinuation(link, isolationIssue);
      return false;
    }
    return this.store.transaction(() => {
      if (!this.store.run("UPDATE runs SET state = 'running' WHERE id = ? AND state = 'waiting_for_user'", runId).changes) return false;
      this.ensureRunState(runId);
      this.store.appendEvents(runId, [event('continuation.lifecycle_released', { operationId: operation.id }),
        { type: 'run.state_changed', payload: { from: 'waiting_for_user', to: 'running', reason: 'Verified lifecycle receipt released the gate.' } }]);
      queueMicrotask(() => this.pump());
      return true;
    });
  };

  // Startup reconciliation (ADR-0008 Step D). Runs after recover(). It rebuilds scheduler state for held runs, then completes
  // every transition whose durable precondition holds. Each step is a compare-and-set, so repeated passes change nothing.
  P.reconcileContinuations = function () {
    const report = { rebuilt: [], parentsResumed: [], repairsFailed: [], lifecycleReleased: [] };
    const safeLinks = [];
    for (const link of this.store.all("SELECT * FROM run_links WHERE state IN ('open','repair_completed')")) {
      const isolationIssue = this.linkedRepairWorkspaceIssueForLink(link);
      if (!isolationIssue) { safeLinks.push(link); continue; }
      this.refuseLinkedRepairContinuation(link, isolationIssue);
      report.repairsFailed.push(link.id);
    }
    this.store.transaction(() => {
      for (const link of safeLinks) {
        const repair = this.requireRun(link.repair_run_id);
        if (repair.state === 'succeeded' && link.state === 'open') this.recordRepairOutcome(repair.id, 'succeeded');
        else if (['failed', 'canceled', 'interrupted'].includes(repair.state) && link.state === 'open') { this.recordRepairOutcome(repair.id, repair.state); report.repairsFailed.push(link.id); }
      }
    });
    for (const operation of this.store.all("SELECT * FROM lifecycle_operations WHERE state = 'verified'")) if (this.releaseVerifiedLifecycle(operation.run_id)) report.lifecycleReleased.push(operation.id);
    for (const link of this.store.all("SELECT * FROM run_links WHERE state = 'repair_completed'")) if (this.resumeLinkedParent(link)) report.parentsResumed.push(link.id);
    for (const link of this.store.all("SELECT * FROM run_links WHERE continuation_contract = 'logical_policy' AND state = 'open'")) {
      if (this.logicalRepairWaitingForDecision(link.repair_run_id)) {
        this.store.transaction(() => this.recordLogicalRepairOutcome(link, 'failed'));
        report.repairsFailed.push(link.id);
        continue;
      }
      if (this.settleParentRepairSuspension(link.id)) report.rebuilt.push(link.parent_run_id);
    }
    for (const link of this.store.all("SELECT * FROM run_links WHERE continuation_contract = 'logical_policy' AND state = 'repair_accepted'"))
      if (this.resumeLogicalRepairParent(link)) report.parentsResumed.push(link.id);
    // Parent Stop/close and the child Stop are separate Host-facing effects. Reconcile either crash boundary:
    // the Parent may already be terminal while the link is still repair_failed, or the link may be terminal
    // while its child has not yet received Stop.
    for (const link of this.store.all(`SELECT l.*, p.state AS parent_state FROM run_links l JOIN runs p ON p.id = l.parent_run_id
      WHERE l.continuation_contract = 'logical_policy' AND l.state IN ('repair_failed','parent_stopped','blocked')
        AND p.state IN ('stopping','succeeded','failed','canceled','interrupted')`)) {
      if (link.state === 'repair_failed') this.blockLogicalRepairForTerminalParent(link, { state: link.parent_state });
      else this.stopLogicalRepairRun(link);
    }
    for (const run of this.store.all("SELECT * FROM runs WHERE state = 'waiting_for_user'")) {
      if (!this.isContinuationHeld(run)) continue;
      this.ensureRunState(run.id);
      this.store.transaction(() => this.store.appendEvents(run.id, [event('continuation.reconciled', { pass: 'startup', scheduler: 'rebuilt' })]));
      report.rebuilt.push(run.id);
    }
    queueMicrotask(() => this.pump());
    return report;
  };

  // Called from finishRunIfDone for every terminal transition of a run that may be a repair child.
  P.afterRepairRunTerminal = function (repairRunId, to) {
    if (to === 'succeeded') {
      const logical = this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND continuation_contract = 'logical_policy' AND state = 'repair_accepted'", repairRunId);
      if (logical) {
        custodyFaultPoint('after_p2_repair_acceptance');
        this.resumeLogicalRepairParent(logical);
      }
    }
    if (to !== 'succeeded') return;
    const link = this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND state = 'repair_completed'", repairRunId);
    if (link) this.resumeLinkedParent(link);
  };
}
