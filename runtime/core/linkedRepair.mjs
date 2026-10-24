// ADR-0008 linked self-repair continuation, installed on the Engine prototype like judgeAttention.mjs.
//
// A parent run suspended for repair is held in waiting_for_user by an open run_links row. Its repair is an ordinary captured
// workflow in a different workspace, so the one-active-run-per-workspace index is never shared. When the Designated Judge
// proposes application.activate_candidate, the Engine validates the proposal against the linked candidate and records a
// lifecycle operation; the repair then waits at that gate. A verified lifecycle receipt releases the gate. When the repair
// succeeds, the Engine resumes the parent in place at its suspended node. Every continuation step is a compare-and-set on
// durable state, so repeated reconciliation cannot repeat it.
//
// Host-bound receipts arrive only through the authenticated local Lifecycle Host channel. The first-party route is retained
// for the unbound development/test runtime and is refused whenever a Lifecycle Host bootstrap is present.
import { randomUUID } from 'node:crypto';
import { parseStrictJson } from './canonical.mjs';
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

  // Last synchronous check before any Engine-owned process launch. This also covers managed-task and Map check processes.
  const launchContained = P.launchContained;
  P.launchContained = function (runId, options) {
    const isolationIssue = this.linkedRepairWorkspaceIssueForRun(runId);
    if (isolationIssue) {
      const state = this.runs.get(runId);
      if (state) this.refuseLinkedRepairExecution(state, isolationIssue);
      throw Object.assign(new Error(isolationIssue.message), { code: isolationIssue.code });
    }
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
      const changed = this.store.run("UPDATE run_links SET state = 'repair_failed', updated_at = ? WHERE id = ? AND state IN ('open','repair_completed')", at, link.id).changes;
      if (!changed) return;
      const payload = { linkId: link.id, parentRunId: link.parent_run_id, repairRunId: link.repair_run_id, code: issue.code, message: issue.message };
      this.store.appendEvents(link.repair_run_id, [event('continuation.workspace_isolation_refused', payload)]);
      this.store.appendEvents(link.parent_run_id, [event('continuation.workspace_isolation_refused', payload),
        event('continuation.repair_failed', { linkId: link.id, repairRunId: link.repair_run_id, repairState: repair?.state || 'missing' })]);
    });
    return true;
  };

  // A run is held, and must survive restart unchanged, when it is suspended for a linked repair or waits at a lifecycle gate
  // and has no attempt still in flight. Anything else follows the ordinary restart rules.
  P.isContinuationHeld = function (run) {
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

  // Suspend a parent and create its linked repair (ADR-0008 Suspend and Repair). The public owner requests this transition.
  // would request it is not implemented here.
  P.linkRepair = function (parentRunId, body) {
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
    if (to !== 'succeeded') return;
    const link = this.store.get("SELECT * FROM run_links WHERE repair_run_id = ? AND state = 'repair_completed'", repairRunId);
    if (link) this.resumeLinkedParent(link);
  };
}
