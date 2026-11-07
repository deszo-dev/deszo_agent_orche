// P2 deterministic proof: durable Parent/Repair coordination, authorization and idempotent continuation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startTestRunner } from './helpers.mjs';
import { eventually } from './custody-support.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });

function parentWorkflow(workflowId, { bModel = 'fixture-fail-once' } = {}) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'a', type: 'text', config: { value: 'P2_PARENT_A_OK' } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: bModel, timeoutSeconds: 30, output: { format: 'text' } } },
      { id: 'c', type: 'agent', config: { provider: 'codex', model: 'fixture-echo', timeoutSeconds: 30, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ], edges: [edge('a-b', 'a', 'text', 'b', 'prompt'), edge('b-c', 'b', 'text', 'c', 'prompt'), edge('c-result', 'c', 'text', 'result', 'value')], after: [] };
}

function repairWorkflow(workflowId, { model = null, result = 'P2_REPAIR_VERIFIED', role = null } = {}) {
  const repair = model
    ? { id: 'verified', type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 30, output: { format: 'text' }, ...(role ? { role } : {}) } }
    : { id: 'verified', type: 'text', config: { value: result } };
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [...(model ? [{ id: 'request', type: 'text', config: { value: 'Repair the test fixture.' } }] : []), repair, { id: 'result', type: 'result-viewer', config: {} }],
    edges: [...(model ? [edge('request-verified', 'request', 'text', 'verified', 'prompt')] : []), edge('verified-result', 'verified', 'text', 'result', 'value')], after: [] };
}

async function prepared(api, suffix, options = {}) {
  const parentWorkspaceId = `p2-${suffix}-parent`;
  const repairWorkspaceId = `p2-${suffix}-repair`;
  await api.workspace(parentWorkspaceId);
  await api.workspace(repairWorkspaceId);
  const parent = await api.save(parentWorkflow(`p2-${suffix}-parent-flow`, options.parent));
  const repair = await api.save(repairWorkflow(`p2-${suffix}-repair-flow`, options.repair));
  const started = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId,
    workflowSnapshotSha256: parent.snapshotSha256, publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId,
    definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest, workspaceId: parentWorkspaceId, requestId: randomUUID() });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await api.waitFor(started.body.run.runId, run => run.state === 'waiting_for_user');
  return { parent, repair, parentWorkspaceId, repairWorkspaceId, parentRunId: started.body.run.runId };
}

function requestFor(context, { incidentId = randomUUID(), requestId = randomUUID(), failedNodeRetry = 'explicit_safe', expected = 'P2_REPAIR_VERIFIED' } = {}) {
  return { requestId, incidentId, failedNodeInstanceId: 'b', repairWorkflowId: context.repair.workflow.workflowId,
    repairWorkflowSnapshotSha256: context.repair.snapshotSha256, repairWorkspaceId: context.repairWorkspaceId,
    repairResultNodeInstanceId: 'verified', expectedRepairResultSha256: digest(expected), failedNodeRetry };
}

function linkRow(engine, linkId) {
  return engine.store.get('SELECT * FROM run_links WHERE id = ?', linkId);
}

function attempts(engine, runId, nodeId) {
  return engine.store.all('SELECT * FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal', runId, nodeId);
}

function failureOutcome(engine, attemptId) {
  const row = engine.store.get('SELECT outcome_json FROM failure_outcomes WHERE attempt_id = ?', attemptId);
  return row ? JSON.parse(row.outcome_json) : null;
}

test('P2-D01..08: exact incident replay creates one Repair, accepts its exact result and resumes the original Parent once', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'idempotent');
    const engine = api.runner.engine;
    const before = engine.store.get('SELECT * FROM runs WHERE id = ?', context.parentRunId);
    assert.equal(before.state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'a').length, 1);
    assert.equal(attempts(engine, context.parentRunId, 'c')[0].state, 'scheduled');

    const request = requestFor(context);
    const parentTarget = attempts(engine, context.parentRunId, 'b')[0];
    const parentOutcomeBeforeLink = failureOutcome(engine, parentTarget.id);
    assert.ok(parentOutcomeBeforeLink);
    assert.equal(parentOutcomeBeforeLink.incidentId, undefined);
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {}; // Retain the durable queued boundary while checking duplicate admission.
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, request);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const sameReceipt = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, request);
    assert.equal(sameReceipt.status, 202);
    assert.equal(sameReceipt.body.repairRunId, started.body.repairRunId);
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM run_links WHERE incident_id = ?', request.incidentId).n, 1);
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs WHERE id = ?', started.body.repairRunId).n, 1);
    const parentOutcomeAfterLink = failureOutcome(engine, parentTarget.id);
    assert.equal(parentOutcomeAfterLink.outcomeId, parentOutcomeBeforeLink.outcomeId);
    assert.equal(parentOutcomeAfterLink.incidentId, request.incidentId);
    assert.equal(parentOutcomeAfterLink.repairRunId, started.body.repairRunId);

    const replay = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, { ...request, requestId: randomUUID() });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.outcome, 'existing');
    assert.equal(replay.body.repairRunId, started.body.repairRunId);
    const conflict = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, { ...request, requestId: randomUUID(), failedNodeRetry: 'never' });
    assert.equal(conflict.status, 409);

    let link = linkRow(engine, started.body.linkId);
    assert.equal(link.continuation_contract, 'logical_policy');
    assert.equal(link.parent_suspension_state, 'suspended_for_repair');
    assert.equal(link.state, 'open');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'c')[0].state, 'scheduled', 'Parent dispatch is held during Repair');
    assert.equal(engine.store.get('SELECT published_version_id FROM runs WHERE id = ?', context.parentRunId).published_version_id,
      before.published_version_id, 'Parent remains on its captured published version');

    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(started.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(context.parentRunId, run => run.state === 'succeeded');
    link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'resumed');
    assert.equal(link.parent_suspension_state, 'resumed');
    assert.equal(link.repair_outcome, 'succeeded');
    assert.equal(link.decision_status, 'accepted');
    assert.equal(engine.store.get('SELECT published_version_id FROM runs WHERE id = ?', context.parentRunId).published_version_id, before.published_version_id);
    assert.equal(attempts(engine, context.parentRunId, 'a').length, 1, 'accepted Node A is not replayed');
    assert.equal(attempts(engine, context.parentRunId, 'b').length, 2, 'Node B has its original fail and one authorized safe retry');
    assert.equal(attempts(engine, context.parentRunId, 'b').filter(item => item.state === 'succeeded').length, 1);
    assert.equal(attempts(engine, context.parentRunId, 'c').length, 1, 'Node C runs once after Parent resumption');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).n, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.repair_result_accepted'", context.parentRunId).n, 1);
  } finally { await api.close(); }
});

test('P2-D09: a successful Repair with an unauthorized exact result digest does not resume Parent', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'result-mismatch');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const request = requestFor(context, { expected: 'DIFFERENT_REPAIR_RESULT' });
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, request);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(started.body.repairRunId, run => run.state === 'succeeded');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'repair_failed');
    assert.equal(link.repair_outcome, 'succeeded');
    assert.equal(link.decision_status, 'rejected');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'b').length, 1);
    assert.equal(attempts(engine, context.parentRunId, 'c')[0].state, 'scheduled');
    const rejectedAttempt = attempts(engine, started.body.repairRunId, 'verified')[0];
    const mismatch = failureOutcome(engine, rejectedAttempt.id);
    assert.equal(mismatch.source, 'workflow');
    assert.equal(mismatch.category, 'task_failure');
    assert.equal(mismatch.canonicalCode, 'lifecycle_candidate_mismatch');
    assert.equal(mismatch.incidentId, request.incidentId);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.repair_result_rejected'", context.parentRunId).n, 1);
  } finally { await api.close(); }
});

test('P2-D10: Repair failure remains durable and never resumes Parent', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'repair-failure', { repair: { model: 'fixture-fail' } });
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(started.body.repairRunId, run => run.state === 'waiting_for_user');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'repair_failed');
    assert.equal(link.repair_outcome, 'failed');
    assert.equal(link.decision_status, 'rejected');
    assert.equal(link.parent_suspension_state, 'suspended_for_repair');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'b').length, 1);
    const repairAttempt = attempts(engine, started.body.repairRunId, 'verified')[0];
    const repairFailure = failureOutcome(engine, repairAttempt.id);
    assert.equal(repairFailure.source, 'provider');
    assert.equal(repairFailure.category, 'provider_failure');
    assert.equal(repairFailure.attemptId, repairAttempt.id);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).n, 0);
  } finally { await api.close(); }
});

test('P2-D11: a Repair result cannot override failedNodeRetry=never', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'retry-never');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context, { failedNodeRetry: 'never' }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(started.body.repairRunId, run => run.state === 'succeeded');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'blocked');
    assert.equal(link.parent_suspension_state, 'blocked');
    assert.equal(link.decision_status, 'accepted', 'Repair outcome acceptance is retained even though retry is not authorized');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'b').length, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'", context.parentRunId).n, 1);
  } finally { await api.close(); }
});

test('P2-D12: Parent Stop marks coordination stopped and prevents the completed Repair from resuming it', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'parent-stop');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const request = requestFor(context);
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, request);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    engine.startRun = startRun;
    const stopped = await api.call('POST', `/api/v2/runs/${context.parentRunId}/stop`, { requestId: randomUUID() });
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await api.waitFor(context.parentRunId, run => run.state === 'canceled');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'parent_stopped');
    assert.equal(link.parent_suspension_state, 'stopped');
    assert.ok(['canceled', 'stopping', 'queued'].includes(engine.store.get('SELECT state FROM runs WHERE id = ?', started.body.repairRunId).state));
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).n, 0);
  } finally { await api.close(); }
});

test('P2-D13: missing publication and overlapping physical workspace fail before Repair creation', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'admission-negative');
    const engine = api.runner.engine;
    const beforeRuns = engine.store.get('SELECT COUNT(*) AS n FROM runs').n;
    const request = requestFor(context);
    const missing = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, {
      ...request, requestId: randomUUID(), repairWorkflowSnapshotSha256: '0'.repeat(64),
    });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'published_version_not_runnable');
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, beforeRuns);
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM run_links WHERE incident_id = ?', request.incidentId).n, 0);

    const parentWorkspace = engine.store.get('SELECT cwd FROM workspaces WHERE id = ?', context.parentWorkspaceId).cwd;
    const rebound = await api.call('PUT', `/api/v2/workspaces/${context.repairWorkspaceId}`, { cwd: parentWorkspace });
    assert.equal(rebound.status, 200, JSON.stringify(rebound.body));
    const overlap = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, { ...request, requestId: randomUUID() });
    assert.equal(overlap.status, 422);
    assert.equal(overlap.body.code, 'workspace_overlap');
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, beforeRuns);
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM run_links WHERE incident_id = ?', request.incidentId).n, 0);
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
  } finally { await api.close(); }
});

test('P2-D14: a stopped Repair remains blocked and cannot resume Parent', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'repair-stop', { repair: { model: 'fixture-slow-20' } });
    const engine = api.runner.engine;
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await eventually(() => engine.store.get("SELECT id FROM attempts WHERE run_id = ? AND node_instance_id = 'verified' AND state = 'running'", started.body.repairRunId),
      'Repair provider attempt to enter running state', 30_000, 50);
    const stopped = await api.call('POST', `/api/v2/runs/${started.body.repairRunId}/stop`, { requestId: randomUUID() });
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await api.waitFor(started.body.repairRunId, run => run.state === 'canceled');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'repair_failed');
    assert.equal(link.repair_outcome, 'canceled');
    assert.equal(link.decision_status, 'rejected');
    assert.equal(link.parent_suspension_state, 'suspended_for_repair');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(attempts(engine, context.parentRunId, 'b').length, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).n, 0);
  } finally { await api.close(); }
});

test('P2-D15: suspension requested during active Parent B waits for its safe boundary and does not repeat accepted B', async () => {
  const api = await startTestRunner();
  try {
    const parentWorkspaceId = 'p2-active-parent';
    const repairWorkspaceId = 'p2-active-repair';
    await api.workspace(parentWorkspaceId);
    await api.workspace(repairWorkspaceId);
    const parentDefinition = parentWorkflow('p2-active-parent-flow', { bModel: 'fixture-slow-4' });
    const parent = await api.save(parentDefinition);
    const repair = await api.save(repairWorkflow('p2-active-repair-flow'));
    const startedParent = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId, definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest,
      workspaceId: parentWorkspaceId, requestId: randomUUID() });
    assert.equal(startedParent.status, 202, JSON.stringify(startedParent.body));
    const parentRunId = startedParent.body.run.runId;
    const engine = api.runner.engine;
    await eventually(() => engine.store.get("SELECT id FROM attempts WHERE run_id = ? AND node_instance_id = 'b' AND state = 'running'", parentRunId),
      'Parent B to enter its active execution boundary', 30_000, 50);
    assert.equal(attempts(engine, parentRunId, 'a').filter(item => item.state === 'succeeded').length, 1);
    const context = { ...parent, repair, parentRunId, parentWorkspaceId, repairWorkspaceId };
    const request = requestFor(context);
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {}; // Keep Repair queued after Parent B reaches the safe boundary.
    const linked = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, request);
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'suspension_requested');
    assert.equal(attempts(engine, parentRunId, 'c')[0].state, 'scheduled');
    await eventually(() => linkRow(engine, linked.body.linkId).parent_suspension_state === 'suspended_for_repair',
      'active Parent B to settle before Repair starts', 30_000, 50);
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'running');
    assert.equal(attempts(engine, parentRunId, 'b').length, 1, 'successful in-flight B is retained');
    assert.equal(attempts(engine, parentRunId, 'b')[0].state, 'succeeded');
    assert.equal(attempts(engine, parentRunId, 'c')[0].state, 'scheduled', 'C stays undispatched until Repair outcome');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', linked.body.repairRunId).state, 'queued');

    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(linked.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    assert.equal(linkRow(engine, linked.body.linkId).state, 'resumed');
    assert.equal(attempts(engine, parentRunId, 'a').length, 1);
    assert.equal(attempts(engine, parentRunId, 'b').length, 1, 'completed active B is not retried');
    assert.equal(attempts(engine, parentRunId, 'c').length, 1);
  } finally { await api.close(); }
});

test('P2-D16: suspension closes the scheduler-to-launch window and resumes the still-unstarted Parent attempt', async () => {
  const api = await startTestRunner();
  let releaseDetection;
  let detectionEntered;
  let restoreDetect = null;
  const detectionGate = new Promise(resolve => { releaseDetection = resolve; });
  const entered = new Promise(resolve => { detectionEntered = resolve; });
  try {
    const parentWorkspaceId = 'p2-prelaunch-parent';
    const repairWorkspaceId = 'p2-prelaunch-repair';
    await api.workspace(parentWorkspaceId);
    await api.workspace(repairWorkspaceId);
    const parent = await api.save(parentWorkflow('p2-prelaunch-parent-flow', { bModel: 'fixture-echo' }));
    const repair = await api.save(repairWorkflow('p2-prelaunch-repair-flow'));
    const engine = api.runner.engine;
    const detect = engine.detect.bind(engine);
    restoreDetect = detect;
    let blockFirstDetection = true;
    engine.detect = async (...args) => {
      if (blockFirstDetection) {
        blockFirstDetection = false;
        detectionEntered();
        await detectionGate;
      }
      return detect(...args);
    };
    const started = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId, definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest,
      workspaceId: parentWorkspaceId, requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const parentRunId = started.body.run.runId;
    await entered;
    await eventually(() => [...engine.processes.values()].some(record => record.runId === parentRunId),
      'Parent B to register its dispatch before provider detection', 10_000, 10);
    assert.equal(attempts(engine, parentRunId, 'b')[0].state, 'scheduled');

    const context = { parent, repair, parentRunId, parentWorkspaceId, repairWorkspaceId };
    const request = requestFor(context);
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const linked = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, request);
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'suspension_requested');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', linked.body.repairRunId).state, 'queued');

    releaseDetection();
    await eventually(() => linkRow(engine, linked.body.linkId).parent_suspension_state === 'suspended_for_repair',
      'the prelaunch Parent dispatch to withdraw at the suspension boundary', 10_000, 10);
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', linked.body.repairRunId).state, 'queued');
    assert.equal(attempts(engine, parentRunId, 'b').length, 1);
    assert.equal(attempts(engine, parentRunId, 'b')[0].state, 'scheduled');
    assert.equal(attempts(engine, parentRunId, 'b')[0].invocation_artifact_id, null, 'no invocation is committed before the hold is released');

    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(linked.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    assert.equal(linkRow(engine, linked.body.linkId).state, 'resumed');
    assert.equal(attempts(engine, parentRunId, 'a').length, 1);
    assert.equal(attempts(engine, parentRunId, 'b').length, 1, 'the never-launched B attempt continues once');
    assert.equal(attempts(engine, parentRunId, 'b')[0].state, 'succeeded');
    assert.equal(attempts(engine, parentRunId, 'c').length, 1);
  } finally {
    releaseDetection?.();
    if (restoreDetect && api.runner.engine) api.runner.engine.detect = restoreDetect;
    await api.close();
  }
});

test('P2-D17: a Judge-role Repair Agent can return an ordinary result without triggering lifecycle gating', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'judge-role', { repair: { model: 'fixture-echo', role: 'judge' } });
    const engine = api.runner.engine;
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context, {
      expected: JSON.stringify({ message: 'codex turn 1: Repair the test fixture.' }),
    }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await api.waitFor(started.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(context.parentRunId, run => run.state === 'succeeded');
    assert.equal(linkRow(engine, started.body.linkId).state, 'resumed');
    assert.equal(attempts(engine, started.body.repairRunId, 'verified')[0].state, 'succeeded');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.lifecycle_intent'", started.body.repairRunId).n, 0);
  } finally { await api.close(); }
});

test('P2-D18: a Parent with an active supervision grant is rejected before Repair creation', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'active-grant');
    const engine = api.runner.engine;
    const grantId = randomUUID();
    const sessionId = randomUUID();
    const at = new Date().toISOString();
    const snapshotSha256 = engine.store.artifactRow(engine.store.get('SELECT workflow_snapshot_artifact_id FROM runs WHERE id = ?', context.parentRunId).workflow_snapshot_artifact_id).sha256;
    const grantArtifact = engine.store.putJson({ schemaVersion: 1, kind: 'P2ControlGrantFixture', grantId, runId: context.parentRunId });
    engine.store.run('INSERT INTO controller_sessions(id,client_label,token_sha256,created_at,last_seen_at) VALUES(?,?,?,?,?)',
      sessionId, 'P2 active grant fixture', digest(sessionId), at, at);
    engine.store.run(`INSERT INTO control_grants(id,controller_session_id,workflow_id,workspace_id,workflow_snapshot_sha256,run_id,state,grant_artifact_id,
      observation_deadline_ms,escalation_deadline_ms,requested_at,bound_at) VALUES(?,?,?,?,?,?,'active',?,?,?, ?,?)`, grantId, sessionId,
      context.parent.workflow.workflowId, context.parentWorkspaceId, snapshotSha256, context.parentRunId, grantArtifact.artifactId, 60_000, 120_000, at, at);

    const before = engine.store.get('SELECT COUNT(*) AS n FROM runs').n;
    const refused = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'supervised_parent_ineligible');
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, before);
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM run_links WHERE parent_run_id = ?', context.parentRunId).n, 0);
  } finally { await api.close(); }
});

test('P2-D19: an accepted Repair resumes its Parent when the last Parent Custody hold is released', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'accepted-hold-release');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await eventually(() => linkRow(engine, started.body.linkId).parent_suspension_state === 'suspended_for_repair',
      'Parent suspension to settle before Repair dispatch', 10_000, 10);
    const parentAttempt = attempts(engine, context.parentRunId, 'b')[0];
    const custodyId = randomUUID();
    const parentRoot = engine.store.get('SELECT cwd FROM workspaces WHERE id = ?', context.parentWorkspaceId).cwd;
    const at = new Date().toISOString();
    // Install a durable P1 Host hold at the acceptance boundary, before the real coordinator checks whether it may resume.
    let holdInstalled = false;
    const originalResume = engine.resumeLogicalRepairParent;
    engine.resumeLogicalRepairParent = function (link) {
      if (link?.state === 'repair_accepted' && !holdInstalled) {
        this.store.transaction(() => {
          this.store.run('INSERT INTO attempt_custody(attempt_id, run_id, custody_id, emergency_token, created_at) VALUES (?, ?, ?, ?, ?)',
            parentAttempt.id, context.parentRunId, custodyId, 'd'.repeat(64), at);
          this.store.run(`INSERT INTO custody_workspace_holds(custody_id, attempt_id, run_id, workspace_root, state, held_at)
            VALUES (?, ?, ?, ?, 'held', ?)`, custodyId, parentAttempt.id, context.parentRunId, parentRoot, at);
        });
        holdInstalled = true;
      }
      return originalResume.call(this, link);
    };
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(started.body.repairRunId, run => run.state === 'succeeded');
    assert.equal(holdInstalled, true);
    assert.equal(linkRow(engine, started.body.linkId).state, 'repair_accepted');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.equal(engine.store.get("SELECT state FROM custody_workspace_holds WHERE custody_id = ?", custodyId).state, 'held');

    assert.equal(engine.parentRepairWorkInFlight(context.parentRunId), true, 'the durable Host hold blocks continuation after Repair acceptance');
    engine.resumeLogicalRepairParent = originalResume;
    assert.equal(engine.custodyReleaseIfEnded(custodyId, { state: 'exited', exitCode: 0, processTreeEnded: true, terminationReason: null }), true);
    assert.equal(engine.store.get("SELECT state FROM custody_workspace_holds WHERE custody_id = ?", custodyId).state, 'released');
    await api.waitFor(context.parentRunId, run => run.state === 'succeeded');
    assert.equal(linkRow(engine, started.body.linkId).state, 'resumed');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).n, 1);
  } finally { await api.close(); }
});

test('P2-D20: explicitly closing a suspended Parent blocks and cancels its queued Repair', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'parent-close');
    const engine = api.runner.engine;
    engine.startRun = () => {};
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', started.body.repairRunId).state, 'queued');

    await api.closeRun(context.parentRunId);
    await api.waitFor(started.body.repairRunId, run => run.state === 'canceled');
    const link = linkRow(engine, started.body.linkId);
    assert.equal(link.state, 'blocked');
    assert.equal(link.parent_suspension_state, 'blocked');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'failed');
    assert.equal(attempts(engine, started.body.repairRunId, 'verified')[0].state, 'canceled');
    assert.equal(attempts(engine, started.body.repairRunId, 'verified')[0].invocation_artifact_id, null);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'", context.parentRunId).n, 1);
  } finally { await api.close(); }
});

test('P2-D21: Parent suspension during Host reserve withdraws admission before any Custody launch', async () => {
  let releaseReserve;
  let reserveEntered;
  let releaseCancel;
  let secondCancelEntered;
  const reserveGate = new Promise(resolve => { releaseReserve = resolve; });
  const entered = new Promise(resolve => { reserveEntered = resolve; });
  const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
  const secondCancel = new Promise(resolve => { secondCancelEntered = resolve; });
  let cancelCalls = 0;
  let launchCalls = 0;
  let reserveCalls = 0;
  const reservations = [];
  const records = new Map();
  const providerOutput = Buffer.from([
    { type: 'thread.started', thread_id: 'p2-reserve-boundary' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'P2_HOST_CONTINUED' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const statusFor = custodyId => {
    const record = records.get(custodyId);
    if (record.canceled) return { custodyId, state: 'admission_cancelled', terminal: true, processId: null, processCreationTime: null,
      exitCode: null, terminationReason: 'The Engine withdrew this admission before launch; nothing was started.', stdoutDurable: 0, stderrDurable: 0,
      stdoutAcked: 0, stderrAcked: 0, spoolComplete: false, tailGapPossible: false, processTreeEnded: true };
    if (record.launched) return { custodyId, state: 'exited', terminal: true, processId: record.processId, processCreationTime: record.processCreationTime,
      exitCode: 0, terminationReason: null, stdoutDurable: providerOutput.length, stderrDurable: 0, stdoutAcked: record.stdoutAcked,
      stderrAcked: 0, spoolComplete: true, tailGapPossible: false, processTreeEnded: true };
    return { custodyId, state: 'admitted', terminal: false, processId: null, processCreationTime: null, exitCode: null, terminationReason: null,
      stdoutDurable: 0, stderrDurable: 0, stdoutAcked: 0, stderrAcked: 0, spoolComplete: false, tailGapPossible: false, processTreeEnded: false };
  };
  const host = {
    context: { generation: 'p2-reserve-boundary' },
    async custody(command, payload = {}) {
      if (command === 'custody.attach') return { epoch: 1 };
      if (command === 'custody.reserve') {
        reserveCalls += 1;
        if (reserveCalls === 1) { reserveEntered(); await reserveGate; }
        const custodyId = randomUUID();
        reservations.push({ attemptId: payload.attemptId, custodyId });
        records.set(custodyId, { stdoutAcked: 0, launched: false, canceled: false, processId: 4240 + reserveCalls, processCreationTime: 7000 + reserveCalls });
        return { custodyId, state: 'admitted', permit: `p2-reserve-permit-${reserveCalls}`, emergencyToken: 'a'.repeat(64), deadlineMs: payload.deadlineMs,
          executableSha256: 'b'.repeat(64), invocationDigest: 'c'.repeat(64), cwd: payload.cwd, reused: false };
      }
      if (command === 'custody.cancel') {
        cancelCalls += 1;
        const record = records.get(payload.custodyId);
        if (cancelCalls === 1) throw Object.assign(new Error('Injected temporary Host outage during admission withdrawal.'), { code: 'custody_unreachable' });
        secondCancelEntered();
        await cancelGate;
        if (record && !record.launched) record.canceled = true;
        return statusFor(payload.custodyId);
      }
      if (command === 'custody.launch') {
        launchCalls += 1;
        const record = records.get(payload.custodyId);
        if (!record || record.canceled) throw new Error('A withdrawn Host admission cannot launch.');
        record.launched = true;
        return { custodyId: payload.custodyId, state: 'running', processId: record.processId, processCreationTime: record.processCreationTime };
      }
      if (command === 'custody.status') return statusFor(payload.custodyId);
      if (command === 'custody.read') {
        const bytes = payload.stream === 'stdout' ? providerOutput : Buffer.alloc(0);
        const nextOffset = Math.min(bytes.length, payload.offset + (payload.max ?? 32768));
        const status = statusFor(payload.custodyId);
        return { stream: payload.stream, offset: payload.offset, nextOffset, durableEnd: bytes.length, terminal: status.terminal,
          eof: status.terminal && nextOffset === bytes.length, dataHex: bytes.subarray(payload.offset, nextOffset).toString('hex') };
      }
      if (command === 'custody.ack') {
        const record = records.get(payload.custodyId);
        if (payload.stream === 'stdout') record.stdoutAcked = payload.offset;
        return { acked: payload.offset };
      }
      if (command === 'custody.stop') return statusFor(payload.custodyId);
      throw new Error(`Unexpected Custody command ${command}.`);
    },
  };
  const api = await startTestRunner({ runner: { custodyHost: host } });
  try {
    const parentWorkspaceId = 'p2-reserve-parent';
    const repairWorkspaceId = 'p2-reserve-repair';
    await api.workspace(parentWorkspaceId);
    await api.workspace(repairWorkspaceId);
    const parent = await api.save(parentWorkflow('p2-reserve-parent-flow', { bModel: 'fixture-echo' }));
    const repair = await api.save(repairWorkflow('p2-reserve-repair-flow'));
    const engine = api.runner.engine;
    const started = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId, definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest,
      workspaceId: parentWorkspaceId, requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const parentRunId = started.body.run.runId;
    await entered;
    await eventually(() => [...engine.processes.values()].some(record => record.runId === parentRunId),
      'the Parent Custody dispatch to remain registered through reserve', 10_000, 10);
    assert.equal(attempts(engine, parentRunId, 'b')[0].state, 'scheduled', JSON.stringify({ reserveCalls, cancelCalls, launchCalls, reservations,
      activeProcesses: [...engine.processes.values()].filter(record => record.runId === parentRunId).map(record => ({ attemptId: record.attemptId, launched: record.launched })) }));

    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const context = { parent, repair, parentRunId, parentWorkspaceId, repairWorkspaceId };
    const linked = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, requestFor(context, { failedNodeRetry: 'never' }));
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'suspension_requested');
    releaseReserve();
    await eventually(() => cancelCalls === 1, 'the first Host withdrawal attempt to observe the injected outage', 10_000, 10);
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'suspension_requested', 'Parent cannot settle while Host withdrawal is unconfirmed');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'attempt.launch_withdrawn'", parentRunId).n, 0);
    await secondCancel;
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'suspension_requested');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'attempt.launch_withdrawn'", parentRunId).n, 0,
      'the marker is not durable until Host confirms the prelaunch admission is terminal');
    releaseCancel();
    await eventually(() => linkRow(engine, linked.body.linkId).parent_suspension_state === 'suspended_for_repair',
      'the Host admission to be withdrawn before Parent suspension completes', 10_000, 10);
    assert.equal(cancelCalls, 2);
    assert.equal(launchCalls, 0);
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', linked.body.repairRunId).state, 'queued');
    const withdrawnAttempt = attempts(engine, parentRunId, 'b')[0];
    assert.equal(withdrawnAttempt.state, 'scheduled', 'a never-launched attempt is not misclassified as a failed operation');
    const withdrawal = engine.store.get("SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.launch_withdrawn'", parentRunId, withdrawnAttempt.id);
    assert.ok(withdrawal);
    assert.deepEqual(JSON.parse(withdrawal.envelope_json).payload, { custodyId: reservations[0].custodyId, reason: 'parent_suspension', launchRequestSent: false });
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM attempt_custody WHERE run_id = ?', parentRunId).n, 0);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM custody_workspace_holds WHERE run_id = ? AND state = 'held'", parentRunId).n, 0);
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(linked.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    const parentAttempts = attempts(engine, parentRunId, 'b');
    assert.equal(parentAttempts.length, 2, 'the canceled Host admission requires a fresh Custody Attempt identity');
    assert.equal(parentAttempts[0].id, withdrawnAttempt.id);
    assert.equal(parentAttempts[0].state, 'canceled');
    assert.equal(parentAttempts[1].state, 'succeeded');
    assert.equal(attempts(engine, parentRunId, 'c').length, 1);
    assert.equal(attempts(engine, parentRunId, 'c')[0].state, 'succeeded');
    assert.equal(launchCalls, 2, 'only resumed B and downstream C reach Host launch');
    assert.equal(reservations.length, 3, 'one withdrawn admission plus one fresh B and one C invocation');
    assert.notEqual(reservations[0].attemptId, reservations[1].attemptId);
    assert.equal(reservations[1].attemptId, parentAttempts[1].id);
    assert.equal(reservations[2].attemptId, attempts(engine, parentRunId, 'c')[0].id);
    assert.equal(linkRow(engine, linked.body.linkId).state, 'resumed');
  } finally {
    releaseReserve?.();
    releaseCancel?.();
    await api.close();
  }
});

test('P2-D22: terminal reconciliation blocks a failed Repair after Parent close crosses the Engine crash window', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'parent-close-failed-repair', { repair: { model: 'fixture-fail' } });
    const engine = api.runner.engine;
    const linked = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    await api.waitFor(linked.body.repairRunId, run => run.state === 'waiting_for_user');
    assert.equal(linkRow(engine, linked.body.linkId).state, 'repair_failed');

    const afterClose = engine.afterLogicalParentClose;
    engine.afterLogicalParentClose = () => false; // Simulate Engine termination after Parent close commits but before child-stop delivery.
    await api.closeRun(context.parentRunId);
    engine.afterLogicalParentClose = afterClose;
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'failed');
    assert.equal(linkRow(engine, linked.body.linkId).state, 'repair_failed');

    engine.reconcileContinuations();
    await api.waitFor(linked.body.repairRunId, run => run.state === 'canceled');
    assert.equal(linkRow(engine, linked.body.linkId).state, 'blocked');
    assert.equal(linkRow(engine, linked.body.linkId).parent_suspension_state, 'blocked');
    assert.equal(attempts(engine, linked.body.repairRunId, 'verified').length, 1, 'the failed Repair cannot be retried after Parent close');
  } finally { await api.close(); }
});

test('P2-D23: manual Parent recovery cannot bypass an active logical Repair retry policy', async () => {
  const api = await startTestRunner();
  try {
    const context = await prepared(api, 'manual-retry-blocked');
    const engine = api.runner.engine;
    engine.startRun = () => {};
    const linked = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`,
      requestFor(context, { failedNodeRetry: 'never' }));
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    const attemptBefore = attempts(engine, context.parentRunId, 'b');
    const recovery = await api.call('POST', `/api/v2/runs/${context.parentRunId}/recovery`, {
      requestId: randomUUID(), action: 'retry', nodeInstanceId: 'b',
    });
    assert.equal(recovery.status, 409);
    assert.equal(recovery.body.code, 'parent_repair_pending');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user');
    assert.deepEqual(attempts(engine, context.parentRunId, 'b').map(item => ({ id: item.id, state: item.state })),
      attemptBefore.map(item => ({ id: item.id, state: item.state })), 'the recovery refusal leaves the checkpoint unchanged');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', linked.body.repairRunId).state, 'queued');
    assert.equal(linkRow(engine, linked.body.linkId).failed_node_retry, 'never');
  } finally { await api.close(); }
});

test('P2-D24: a durable prelaunch withdrawal restores Context binding in the same transaction', async () => {
  let releaseProviderPermit;
  let providerPermitEntered;
  const providerPermitGate = new Promise(resolve => { releaseProviderPermit = resolve; });
  const entered = new Promise(resolve => { providerPermitEntered = resolve; });
  let firstReservation = true;
  const api = await startTestRunner();
  try {
    const parentWorkspaceId = 'p2-context-withdrawal-parent';
    const repairWorkspaceId = 'p2-context-withdrawal-repair';
    await api.workspace(parentWorkspaceId);
    await api.workspace(repairWorkspaceId);
    const definition = parentWorkflow('p2-context-withdrawal-parent-flow', { bModel: 'fixture-echo' });
    definition.nodes.find(node => node.id === 'b').config.contextId = 'parent-history';
    definition.nodes.push({ id: 'parent-history', type: 'context', config: { provider: 'codex', mode: 'new' } });
    const parent = await api.save(definition);
    const repair = await api.save(repairWorkflow('p2-context-withdrawal-repair-flow'));
    const engine = api.runner.engine;
    const reserveProviderPermit = engine.reserveHostProviderInvocation.bind(engine);
    engine.reserveHostProviderInvocation = async (...args) => {
      if (firstReservation) {
        firstReservation = false;
        providerPermitEntered();
        await providerPermitGate;
      }
      return reserveProviderPermit(...args);
    };
    const started = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId, definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest,
      workspaceId: parentWorkspaceId, requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const parentRunId = started.body.run.runId;
    await entered;
    const bindingQuery = `SELECT b.state FROM context_bindings b JOIN run_context_bindings m ON m.binding_id = b.id
      WHERE m.run_id = ? AND m.context_node_id = 'parent-history'`;
    assert.equal(engine.store.get(bindingQuery, parentRunId).state, 'writing');
    assert.ok(attempts(engine, parentRunId, 'b')[0].invocation_artifact_id);

    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const context = { parent, repair, parentRunId, parentWorkspaceId, repairWorkspaceId };
    const linked = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, requestFor(context, { failedNodeRetry: 'never' }));
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    releaseProviderPermit();
    await eventually(() => linkRow(engine, linked.body.linkId).parent_suspension_state === 'suspended_for_repair',
      'invocation-withdrawal journal and Context restoration to commit before Repair dispatch', 10_000, 10);
    const withdrawnAttempt = attempts(engine, parentRunId, 'b')[0];
    assert.equal(withdrawnAttempt.state, 'scheduled');
    const withdrawal = engine.store.get("SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.launch_withdrawn'",
      parentRunId, withdrawnAttempt.id);
    assert.ok(withdrawal);
    assert.equal(JSON.parse(withdrawal.envelope_json).payload.custodyId, null);
    assert.equal(engine.store.get(bindingQuery, parentRunId).state, 'unbound');

    engine.reserveHostProviderInvocation = reserveProviderPermit;
    engine.startRun = startRun;
    engine.startRun();
    await api.waitFor(linked.body.repairRunId, run => run.state === 'succeeded');
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    const resumed = attempts(engine, parentRunId, 'b');
    assert.equal(resumed.length, 2);
    assert.equal(resumed[0].state, 'canceled');
    assert.equal(resumed[1].state, 'succeeded');
    assert.equal(engine.store.get(bindingQuery, parentRunId).state, 'ready');
  } finally {
    releaseProviderPermit?.();
    await api.close();
  }
});

test('P2-D25: startup reconciliation propagates Parent Stop after the Engine misses its after-commit hook', async () => {
  const api = await startTestRunner();
  let originalStopHook;
  try {
    const context = await prepared(api, 'parent-stop-crash-window', { repair: { model: 'fixture-analyst-slow' } });
    const engine = api.runner.engine;
    const started = await api.call('POST', `/api/v2/runs/${context.parentRunId}/linked-repair`, requestFor(context));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await eventually(() => [...engine.processes.values()].some(record => record.runId === started.body.repairRunId && record.launched),
      'linked Repair to have an active provider process before Parent Stop', 10_000, 10);

    originalStopHook = engine.afterLogicalParentStop;
    engine.afterLogicalParentStop = () => false; // Simulate a crash immediately after Parent Stop commits.
    const stopped = await api.call('POST', `/api/v2/runs/${context.parentRunId}/stop`, { requestId: randomUUID() });
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await api.waitFor(context.parentRunId, run => run.state === 'canceled');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', started.body.repairRunId).state, 'running');
    assert.equal(linkRow(engine, started.body.linkId).state, 'open', 'the callback loss leaves the durable pre-reconciliation state');

    engine.afterLogicalParentStop = originalStopHook;
    engine.reconcileContinuations();
    await api.waitFor(started.body.repairRunId, run => run.state === 'canceled');
    assert.equal(linkRow(engine, started.body.linkId).state, 'parent_stopped');
    assert.equal(linkRow(engine, started.body.linkId).parent_suspension_state, 'stopped');
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'",
      context.parentRunId).n, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'",
      started.body.repairRunId).n, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'",
      context.parentRunId).n, 0);
  } finally {
    if (originalStopHook && api.runner.engine) api.runner.engine.afterLogicalParentStop = originalStopHook;
    await api.close();
  }
});

