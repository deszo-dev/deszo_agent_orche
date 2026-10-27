// P2 Host-backed proofs use the real Engine, SQLite store, Rust Lifecycle Host and deterministic Rust Custody CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  attemptsOf, buildArtifacts, cleanup, custodyBindings, database, eventually, exited, hostRecords, isAlive, newScratch,
  processIdentity, readInvocations, registerWorkspace, startCustodyHost, startEngine, startPublishedRun, testsRoot, waitForRunState,
} from './custody-support.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const finalStates = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });

function parentDefinition(workflowId, aValue = 'P2_PARENT_A_OK gate=P2_PARENT_B') {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'a-request', type: 'text', config: { value: aValue } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'custody-p2-parent-a', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: 'custody-p2-fail-once', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'c', type: 'agent', config: { provider: 'codex', model: 'custody-p2-parent-c', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ], edges: [edge('request-a', 'a-request', 'text', 'a', 'prompt'), edge('a-b', 'a', 'text', 'b', 'prompt'),
      edge('b-c', 'b', 'text', 'c', 'prompt'), edge('c-result', 'c', 'text', 'result', 'value')], after: [] };
}

function repairDefinition(workflowId, model = 'custody-p2-gated-repair', request = 'Perform the linked P2 repair. gate=P2_REPAIR') {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: request } },
      { id: 'verified', type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ], edges: [edge('request-verified', 'request', 'text', 'verified', 'prompt'), edge('verified-result', 'verified', 'text', 'result', 'value')], after: [] };
}

function query(root, sql, ...parameters) {
  const db = database(root);
  try { return db.prepare(sql).all(...parameters).map(row => ({ ...row })); }
  finally { db.close(); }
}

function one(root, sql, ...parameters) { return query(root, sql, ...parameters)[0] ?? null; }

async function publishNext(engine, workflow) {
  const path = `/api/v4/workflows/${workflow.workflowId}/draft`;
  const previous = await engine.api('GET', path);
  assert.equal(previous.status, 200, JSON.stringify(previous.body));
  const draft = await engine.api('PUT', path, { requestId: randomUUID(), workflow }, { 'If-Match': previous.body.etag });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const validation = await engine.api('POST', `${path}/validate`, {}, { 'If-Match': draft.etag });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
  const publication = await engine.api('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  return publication.body;
}

async function launchCase(label, { repairModel = 'custody-p2-gated-repair', extraEnv = {}, engineArgs = [] } = {}) {
  buildArtifacts();
  const scratch = newScratch(`p2-${label}`);
  const repairWorkspace = join(scratch.root, 'repair-workspace');
  mkdirSync(repairWorkspace, { recursive: true });
  const parentWorkspaceId = `p2-${label}-parent`;
  const repairWorkspaceId = `p2-${label}-repair`;
  const host = await startCustodyHost(scratch.root);
  let engineA = null;
  let parentRunId = null;
  let repairRunId = null;
  try {
    const engineEnv = typeof extraEnv === 'function' ? extraEnv(scratch) : extraEnv;
    const resolvedEngineArgs = typeof engineArgs === 'function' ? engineArgs(scratch) : engineArgs;
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: engineEnv, extraArgs: resolvedEngineArgs });
    await registerWorkspace(engineA, parentWorkspaceId, scratch.workspace);
    await registerWorkspace(engineA, repairWorkspaceId, repairWorkspace);
    const parent = await publish(engineA, parentDefinition(`p2-${label}-parent`));
    const repair = await publish(engineA, repairDefinition(`p2-${label}-repair`, repairModel));
    parentRunId = await startPublishedRun(engineA, parent, parentWorkspaceId);
    assert.equal(await waitForRunState(engineA, parentRunId, ['waiting_for_user'], 120_000), 'waiting_for_user');
    assert.equal(attemptsOf(scratch.root, parentRunId).filter(item => item.state === 'failed').length, 1, 'Parent B has one durable initial failure');
    const parentAMarker = join(scratch.workspace, 'p2-parent-a.log');
    const parentAAttempts = query(scratch.root, 'SELECT id, node_instance_id, state, process_id, ordinal FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY rowid', parentRunId, 'a');
    const parentAInvocations = readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p2-parent-a');
    assert.equal(lineCount(parentAMarker), 1, 'Parent A side effect was accepted once before Repair; run=' + parentRunId
      + '; marker=' + parentAMarker + '; parentAAttempts=' + JSON.stringify(parentAAttempts)
      + '; providerInvocations=' + JSON.stringify(parentAInvocations));
    const request = { requestId: randomUUID(), incidentId: randomUUID(), failedNodeInstanceId: 'b', repairWorkflowId: repair.workflow.workflowId,
      repairWorkflowSnapshotSha256: repair.snapshotSha256, repairWorkspaceId, repairResultNodeInstanceId: 'verified',
      expectedRepairResultSha256: hash('P2_REPAIR_VERIFIED'), failedNodeRetry: 'explicit_safe' };
    const linked = await engineA.api('POST', `/api/v2/runs/${parentRunId}/linked-repair`, request);
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    repairRunId = linked.body.repairRunId;
    let repairAttempt;
    let binding;
    let identity;
    if (['custody-p2-gated-repair', 'custody-p2-gated-repair-fail'].includes(repairModel)) {
      await eventually(() => existsSync(join(repairWorkspace, 'READY-P2_REPAIR.marker')), 'Repair Custody process to reach its deterministic barrier', 90_000, 100);
      repairAttempt = await eventually(() => attemptsOf(scratch.root, repairRunId).find(item => item.state === 'running'),
        'the linked Repair Attempt to be durably running after its READY marker', 30_000, 100);
      assert.ok(repairAttempt, 'the linked Repair has an active process attempt');
      binding = await eventually(() => custodyBindings(scratch.root, repairRunId).find(item => item.attempt_id === repairAttempt.id),
        'the linked Repair Attempt to have its Host binding', 30_000, 100);
      assert.ok(binding?.custody_id, 'the Repair Attempt is bound to a Rust Host invocation');
      identity = await eventually(() => hostRecords(host).find(record => record.attemptId === repairAttempt.id && record.state === 'running'),
        'the Rust Host running record for the linked Repair', 30_000, 100);
      assert.ok(identity, 'the Host records the live Repair process');
    } else {
      await waitForRunState(engineA, repairRunId, ['waiting_for_user'], 90_000);
      repairAttempt = attemptsOf(scratch.root, repairRunId).find(item => item.state === 'failed');
    }
    return { label, scratch, repairWorkspace, parentWorkspaceId, repairWorkspaceId, parent, repair, parentRunId, repairRunId,
      incidentId: request.incidentId, linkId: linked.body.linkId, repairAttemptId: repairAttempt.id, repairCustodyId: binding?.custody_id ?? null,
      repairPid: identity?.processId ?? null, host, engineA, engineB: null, engineC: null };
  } catch (error) {
    const diagnostic = {
      parentRunId,
      parentRun: parentRunId ? one(scratch.root, 'SELECT id, workflow_id, workspace_id, state, created_at FROM runs WHERE id = ?', parentRunId) : null,
      parentAttempts: parentRunId ? query(scratch.root, 'SELECT id, node_instance_id, state, process_id, ordinal FROM attempts WHERE run_id = ? ORDER BY rowid', parentRunId) : [],
      parentEvents: parentRunId ? query(scratch.root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', parentRunId)
        .map(row => ({ sequence: row.sequence, type: row.event_type, envelope: JSON.parse(row.envelope_json) })) : [],
      parentInvocations: readInvocations(scratch.fixtureState),
      repairRunId,
      repairRun: repairRunId ? one(scratch.root, 'SELECT id, workflow_id, workspace_id, state, created_at FROM runs WHERE id = ?', repairRunId) : null,
      repairAttempts: repairRunId ? query(scratch.root, 'SELECT id, node_instance_id, state, process_id, ordinal FROM attempts WHERE run_id = ? ORDER BY rowid', repairRunId) : [],
      hostRecords: hostRecords(host),
    };
    error.message += `\nP2 launch snapshot: ${JSON.stringify(diagnostic)}`;
    if (engineA?.stderr()) error.message = `${error.message}\nEngine A stderr:\n${engineA.stderr()}`;
    if (engineA && !exited(engineA.child)) engineA.kill();
    await host.shutdown().catch(() => host.crash());
    cleanup(scratch.root);
    throw error;
  }
}

async function publish(engine, definition) {
  const draft = await engine.api('PUT', `/api/v4/workflows/${definition.workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const validation = await engine.api('POST', `/api/v4/workflows/${definition.workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
  const publication = await engine.api('POST', `/api/v4/workflows/${definition.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  return publication.body;
}

function lineCount(path) { return existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0; }

async function stopCase(context) {
  if (!context) return;
  if (context.stopBarrierReleasePath) writeFileSync(context.stopBarrierReleasePath, 'test teardown release\n');
  writeFileSync(join(context.repairWorkspace, 'RELEASE-P2_REPAIR.marker'), 'test teardown\n');
  writeFileSync(join(context.scratch.workspace, 'RELEASE-P2_PARENT_B.marker'), 'test teardown\n');
  for (const engine of [context.engineC, context.engineB, context.engineA]) {
    if (!engine || exited(engine.child)) continue;
    await engine.stop().catch(() => engine.kill());
  }
  await context.host.shutdown().catch(() => context.host.crash());
  cleanup(context.scratch.root);
}

async function restartAfterRepairBarrier(context, { extraEnv = {} } = {}) {
  context.engineA.kill();
  assert.equal(await eventually(() => exited(context.engineA.child), 'Engine A to exit while Repair is active', 30_000, 100), true);
  assert.equal(isAlive(context.host.pid), true, 'the Rust Lifecycle Host remains alive');
  assert.equal(isAlive(context.repairPid), true, 'the same Repair process remains alive under Host custody');
  context.engineB = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState, extraEnv });
  assert.equal(await waitForRunState(context.engineB, context.repairRunId, ['running', ...finalStates], 60_000), 'running', 'Engine B reattaches the active Repair');
  assert.deepEqual(custodyBindings(context.scratch.root, context.repairRunId), [{ attempt_id: context.repairAttemptId, custody_id: context.repairCustodyId }]);
  assert.equal(isAlive(context.repairPid), true);
  assert.equal(hostRecords(context.host).filter(item => item.attemptId === context.repairAttemptId).length, 1, 'replacement does not relaunch Repair');
}

async function reachParentBBarrier(context, engine) {
  writeFileSync(join(context.repairWorkspace, 'RELEASE-P2_REPAIR.marker'), 'authorized verification release\n');
  assert.equal(await waitForRunState(engine, context.repairRunId, ['succeeded', ...finalStates], 90_000), 'succeeded');
  await eventually(() => existsSync(join(context.scratch.workspace, 'READY-P2_PARENT_B.marker')), 'resumed Parent B to reach its deterministic Custody barrier', 90_000, 100);
  const link = one(context.scratch.root, 'SELECT state, parent_suspension_state, repair_outcome, decision_status FROM run_links WHERE id = ?', context.linkId);
  assert.equal(link.state, 'resumed');
  assert.equal(link.parent_suspension_state, 'resumed');
  assert.equal(link.repair_outcome, 'succeeded');
  assert.equal(link.decision_status, 'accepted');
  return attemptsOf(context.scratch.root, context.parentRunId).find(item => item.process_id && item.state === 'running');
}

function assertFinalLifecycle(context) {
  const parent = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.parentRunId);
  const repair = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.repairRunId);
  const link = one(context.scratch.root, 'SELECT * FROM run_links WHERE id = ?', context.linkId);
  const parentAttempts = query(context.scratch.root, 'SELECT node_instance_id, state, ordinal FROM attempts WHERE run_id = ? ORDER BY rowid', context.parentRunId);
  const repairAttempts = query(context.scratch.root, 'SELECT node_instance_id, state, ordinal FROM attempts WHERE run_id = ? ORDER BY rowid', context.repairRunId);
  assert.equal(parent.state, 'succeeded');
  assert.equal(repair.state, 'succeeded');
  assert.equal(parent.published_version_id, context.parent.publishedVersionId, 'Parent remains on v1 after recovery');
  assert.equal(repair.published_version_id, context.repair.publishedVersionId, 'Repair remains on v1 after recovery');
  assert.equal(link.incident_id, context.incidentId);
  assert.equal(link.state, 'resumed');
  assert.equal(parentAttempts.filter(item => item.node_instance_id === 'a' && item.state === 'succeeded').length, 1);
  assert.equal(parentAttempts.filter(item => item.node_instance_id === 'b').length, 2);
  assert.equal(parentAttempts.filter(item => item.node_instance_id === 'b' && item.state === 'succeeded').length, 1);
  assert.equal(parentAttempts.filter(item => item.node_instance_id === 'c' && item.state === 'succeeded').length, 1);
  assert.equal(repairAttempts.filter(item => item.node_instance_id === 'verified' && item.state === 'succeeded').length, 1);
  assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-a.log')), 1);
  assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-b-accepted.log')), 1);
  assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-c.log')), 1);
  assert.equal(lineCount(join(context.repairWorkspace, 'p2-repair-executed.log')), 1);
  assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair').length, 1);
  assert.equal(query(context.scratch.root, "SELECT event_type FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).length, 1);
  assert.equal(query(context.scratch.root, "SELECT event_type FROM journal_events WHERE run_id = ? AND event_type = 'continuation.repair_result_accepted'", context.parentRunId).length, 1);
  const workspaces = one(context.scratch.root, `SELECT p.cwd AS parent_root, q.cwd AS repair_root FROM run_links l
    JOIN workspaces p ON p.id = l.parent_workspace_id JOIN workspaces q ON q.id = l.repair_workspace_id WHERE l.id = ?`, context.linkId);
  assert.notEqual(resolve(workspaces.parent_root), resolve(workspaces.repair_root));
  assert.equal(resolve(workspaces.parent_root).startsWith(`${resolve(workspaces.repair_root)}${sep}`), false);
  assert.equal(resolve(workspaces.repair_root).startsWith(`${resolve(workspaces.parent_root)}${sep}`), false);
  return { parentAttempts, repairAttempts, link, parent, repair, workspaces };
}

test('P2-E2E-01: Engine A replacement during an active linked Repair resumes the original Parent on pinned v1', { timeout: 360_000 }, async () => {
  let context;
  try {
    context = await launchCase('e2e01');
    const engineAPid = context.engineA.pid;
    const hostPid = context.host.pid;
    const repairPid = context.repairPid;
    const repairIdentity = processIdentity(repairPid);
    const v2Parent = parentDefinition(context.parent.workflow.workflowId, 'P2_PARENT_A_V2 gate=P2_PARENT_B');
    const v2Repair = repairDefinition(context.repair.workflow.workflowId, 'custody-p2-gated-repair', 'Newer published Repair v2. gate=P2_REPAIR');
    const parentV2 = await publishNext(context.engineA, v2Parent);
    const repairV2 = await publishNext(context.engineA, v2Repair);
    assert.notEqual(parentV2.publishedVersionId, context.parent.publishedVersionId);
    assert.notEqual(repairV2.publishedVersionId, context.repair.publishedVersionId);
    assert.equal(one(context.scratch.root, 'SELECT published_version_id FROM runs WHERE id = ?', context.parentRunId).published_version_id, context.parent.publishedVersionId);
    assert.equal(one(context.scratch.root, 'SELECT published_version_id FROM runs WHERE id = ?', context.repairRunId).published_version_id, context.repair.publishedVersionId);

    await restartAfterRepairBarrier(context);
    const parentBAttempt = await reachParentBBarrier(context, context.engineB);
    assert.ok(parentBAttempt?.process_id);
    assert.equal(isAlive(hostPid), true);
    assert.equal(isAlive(repairPid), false, 'the Repair provider has finished after its accepted result');
    assert.equal(processIdentity(repairPid), null);
    const beforeRelease = hostRecords(context.host).find(item => item.custodyId === context.repairCustodyId);
    assert.equal(beforeRelease.state, 'exited');
    assert.equal(beforeRelease.drained, true, 'Host proves the Repair process tree ended');
    writeFileSync(join(context.scratch.workspace, 'RELEASE-P2_PARENT_B.marker'), 'continue Parent B\n');
    assert.equal(await waitForRunState(context.engineB, context.parentRunId, finalStates, 120_000), 'succeeded');
    const outcome = assertFinalLifecycle(context);
    const proof = { schemaVersion: 1, scenario: 'P2-E2E-01', generatedAt: new Date().toISOString(), sourceBaseHead: '40fa26a',
      engineA: { pid: engineAPid, exited: exited(context.engineA.child) }, engineB: { pid: context.engineB.pid, exited: false },
      host: { pid: hostPid, alive: isAlive(hostPid) }, parentRunId: context.parentRunId, repairRunId: context.repairRunId,
      incidentId: context.incidentId, parentPublishedVersionId: context.parent.publishedVersionId, parentV2PublishedVersionId: parentV2.publishedVersionId,
      repairPublishedVersionId: context.repair.publishedVersionId, repairV2PublishedVersionId: repairV2.publishedVersionId,
      repairAttemptId: context.repairAttemptId, repairCustodyInvocationId: context.repairCustodyId, repairPid, repairProcessIdentity: repairIdentity,
      parentBAttemptId: parentBAttempt.id, parentBProcessId: parentBAttempt.process_id, finalParentState: outcome.parent.state,
      finalRepairState: outcome.repair.state, linkState: outcome.link.state, parentContinuationEvents: 1,
      acceptedAttempts: { parentA: 1, parentB: 1, parentC: 1, repairVerification: 1 },
      sideEffects: { parentA: 1, parentBAccepted: 1, parentC: 1, repair: 1 },
      physicalWorkspaces: outcome.workspaces, hostRepairProof: { state: beforeRelease.state, drained: beforeRelease.drained,
        spoolComplete: beforeRelease.spoolComplete, stdoutAcked: beforeRelease.stdoutAcked, stdoutDurable: beforeRelease.stdoutDurable,
        stderrAcked: beforeRelease.stderrAcked, stderrDurable: beforeRelease.stderrDurable } };
    const evidencePath = join('docs', 'reviews', 'evidence', '2026-10-26-p2-parent-repair-e2e.json');
    if (process.env.DESZO_P2_WRITE_EVIDENCE === '1' || !existsSync(evidencePath)) {
      mkdirSync(join('docs', 'reviews', 'evidence'), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(proof, null, 2)}\n`);
    }
  } finally { await stopCase(context); }
});

test('P2-E2E-02: the Rust Host finishes Repair while the Engine is absent; replacement settles and resumes Parent', { timeout: 360_000 }, async () => {
  let context;
  try {
    context = await launchCase('e2e02');
    context.engineA.kill();
    assert.equal(await eventually(() => exited(context.engineA.child), 'Engine A to exit before Repair completes', 30_000, 100), true);
    writeFileSync(join(context.repairWorkspace, 'RELEASE-P2_REPAIR.marker'), 'complete while Engine absent\n');
    await eventually(() => !isAlive(context.repairPid), 'the Host-owned Repair process to finish without an Engine', 90_000, 150);
    const hostRecord = hostRecords(context.host).find(item => item.custodyId === context.repairCustodyId);
    assert.equal(hostRecord.state, 'exited');
    assert.equal(hostRecord.drained, true);
    assert.equal(hostRecord.spoolComplete, true);
    context.engineB = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    await eventually(() => one(context.scratch.root, 'SELECT state FROM run_links WHERE id = ?', context.linkId)?.state === 'resumed', 'Engine B to reconcile accepted Repair and resume Parent');
    const attempt = await reachParentBBarrier(context, context.engineB);
    assert.deepEqual(custodyBindings(context.scratch.root, context.repairRunId), [{ attempt_id: context.repairAttemptId, custody_id: context.repairCustodyId }]);
    writeFileSync(join(context.scratch.workspace, 'RELEASE-P2_PARENT_B.marker'), 'continue after Engine-absent completion\n');
    assert.equal(await waitForRunState(context.engineB, context.parentRunId, finalStates, 120_000), 'succeeded');
    assertFinalLifecycle(context);
    assert.ok(attempt?.process_id);
  } finally { await stopCase(context); }
});

test('P2-E2E-03: accepted Repair survives a crash before Parent rescheduling and resumes exactly once', { timeout: 360_000 }, async () => {
  let context;
  try {
    context = await launchCase('e2e03');
    context.engineA.kill();
    await eventually(() => exited(context.engineA.child), 'Engine A to exit before the injected acceptance crash', 30_000, 100);
    context.engineB = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState,
      extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_p2_repair_acceptance' } });
    writeFileSync(join(context.repairWorkspace, 'RELEASE-P2_REPAIR.marker'), 'trigger accepted-outcome crash\n');
    assert.equal(await eventually(() => exited(context.engineB.child), 'Engine B to exit after durable Repair acceptance', 90_000, 100), true);
    let link = one(context.scratch.root, 'SELECT state, parent_suspension_state, decision_status FROM run_links WHERE id = ?', context.linkId);
    assert.deepEqual(link, { state: 'repair_accepted', parent_suspension_state: 'resumable', decision_status: 'accepted' });
    context.engineC = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    const parentBAttempt = await reachParentBBarrier(context, context.engineC);
    writeFileSync(join(context.scratch.workspace, 'RELEASE-P2_PARENT_B.marker'), 'continue after accepted-outcome recovery\n');
    assert.equal(await waitForRunState(context.engineC, context.parentRunId, finalStates, 120_000), 'succeeded');
    const outcome = assertFinalLifecycle(context);
    link = one(context.scratch.root, 'SELECT state FROM run_links WHERE id = ?', context.linkId);
    assert.equal(link.state, 'resumed');
    assert.equal(query(context.scratch.root, "SELECT event_type FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).length, 1);
    assert.ok(parentBAttempt?.process_id);
    assert.equal(outcome.parent.state, 'succeeded');
  } finally { await stopCase(context); }
});

test('P2-E2E-04: Repair failure during Engine absence is reconciled and remains blocked after replacement', { timeout: 360_000 }, async () => {
  let context;
  try {
    context = await launchCase('e2e04', { repairModel: 'custody-p2-gated-repair-fail' });
    context.engineA.kill();
    await eventually(() => exited(context.engineA.child), 'Engine A to exit after Repair failure', 30_000, 100);
    context.engineB = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    writeFileSync(join(context.repairWorkspace, 'RELEASE-P2_REPAIR.marker'), 'fail while Engine is absent\n');
    assert.equal(await waitForRunState(context.engineB, context.parentRunId, ['waiting_for_user'], 10_000), 'waiting_for_user');
    assert.equal(await waitForRunState(context.engineB, context.repairRunId, ['waiting_for_user'], 10_000), 'waiting_for_user');
    const link = one(context.scratch.root, 'SELECT state, parent_suspension_state, repair_outcome, decision_status FROM run_links WHERE id = ?', context.linkId);
    assert.deepEqual(link, { state: 'repair_failed', parent_suspension_state: 'suspended_for_repair', repair_outcome: 'failed', decision_status: 'rejected' });
    assert.equal(attemptsOf(context.scratch.root, context.parentRunId).filter(item => item.state === 'failed').length, 1);
    assert.equal(attemptsOf(context.scratch.root, context.repairRunId).filter(item => item.state === 'failed').length, 1);
    assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-c.log')), 0);
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair-fail').length, 1);
    assert.equal(query(context.scratch.root, "SELECT event_type FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).length, 0);
  } finally { await stopCase(context); }
});

test('P2-E2E-05: two Engine replacements at Repair and resumed-Parent boundaries preserve one association and invocation', { timeout: 360_000 }, async () => {
  let context;
  try {
    context = await launchCase('e2e05');
    await restartAfterRepairBarrier(context);
    const parentBAttempt = await reachParentBBarrier(context, context.engineB);
    assert.ok(parentBAttempt?.process_id);
    const parentBCustodyId = custodyBindings(context.scratch.root, context.parentRunId).find(item => item.attempt_id === parentBAttempt.id)?.custody_id;
    assert.ok(parentBCustodyId, 'resumed Parent B is Host-owned before the second replacement');
    const parentBIdentity = processIdentity(parentBAttempt.process_id);
    context.engineB.kill();
    assert.equal(await eventually(() => exited(context.engineB.child), 'Engine B to exit during resumed Parent B', 30_000, 100), true);
    assert.equal(isAlive(parentBAttempt.process_id), true, 'Parent B continues under the Host during the second replacement');
    context.engineC = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    assert.equal(await waitForRunState(context.engineC, context.parentRunId, ['running', ...finalStates], 60_000), 'running');
    assert.deepEqual(custodyBindings(context.scratch.root, context.parentRunId).find(item => item.attempt_id === parentBAttempt.id),
      { attempt_id: parentBAttempt.id, custody_id: parentBCustodyId });
    assert.equal(processIdentity(parentBAttempt.process_id), parentBIdentity, 'the same Parent B process is reattached');
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-fail-once').length, 2,
      'the initial failure and one authorized safe retry are the only Parent B invocations');
    writeFileSync(join(context.scratch.workspace, 'RELEASE-P2_PARENT_B.marker'), 'complete after second replacement\n');
    assert.equal(await waitForRunState(context.engineC, context.parentRunId, finalStates, 120_000), 'succeeded');
    assertFinalLifecycle(context);
    assert.equal(query(context.scratch.root, "SELECT event_type FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", context.parentRunId).length, 1);
  } finally { await stopCase(context); }
});

test('P2-E2E-06: Parent Stop callback loss is recovered across real Engine replacement', { timeout: 360_000 }, async () => {
  let context;
  const causalTrace = [];
  const record = (event, details = {}) => causalTrace.push({ ordinal: causalTrace.length + 1, event, ...details });
  try {
    context = await launchCase('e2e06', {
      extraEnv: scratch => {
        const barrierDir = join(scratch.root, 'd25-stop-barrier');
        mkdirSync(barrierDir, { recursive: true });
        return { DESZO_P2_D25_BARRIER_DIR: barrierDir };
      },
      engineArgs: () => ['--import', new URL('./fixtures/p2-d25-stop-commit-barrier.mjs', import.meta.url).href],
    });
    const barrierDir = join(context.scratch.root, 'd25-stop-barrier');
    const preloadReadyPath = join(barrierDir, 'preload-ready.json');
    context.stopBarrierReleasePath = join(barrierDir, 'release');
    const barrierEnteredPath = join(barrierDir, 'callback-entered.json');
    const originalEnteredPath = join(barrierDir, 'original-callback-entered.json');
    const originalCompletedPath = join(barrierDir, 'original-callback-completed.json');
    const armPath = join(barrierDir, 'arm.json');
    writeFileSync(armPath, JSON.stringify({ parentRunId: context.parentRunId }));

    const linkBeforeStop = one(context.scratch.root, 'SELECT * FROM run_links WHERE id = ?', context.linkId);
    const repairBeforeStop = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.repairRunId);
    const holdBeforeStop = one(context.scratch.root, 'SELECT * FROM custody_workspace_holds WHERE custody_id = ?', context.repairCustodyId);
    const hostBeforeStop = hostRecords(context.host).find(item => item.custodyId === context.repairCustodyId);
    const engineALock = JSON.parse(readFileSync(join(context.scratch.root, 'runtime', 'runner.lock'), 'utf8'));
    const engineAIdentity = processIdentity(context.engineA.pid);
    const hostIdentity = processIdentity(context.host.pid);
    const repairIdentity = processIdentity(context.repairPid);
    const preloadReady = await eventually(() => existsSync(preloadReadyPath) ? JSON.parse(readFileSync(preloadReadyPath, 'utf8')) : null,
      'Engine A to install the test-only callback barrier', 10_000, 25);
    assert.equal(preloadReady.enginePid, context.engineA.pid);
    assert.equal(linkBeforeStop.state, 'open', 'the original logical link is still awaiting Repair');
    assert.equal(repairBeforeStop.state, 'running');
    assert.equal(repairBeforeStop.published_version_id, context.repair.publishedVersionId);
    assert.equal(holdBeforeStop.state, 'held');
    assert.equal(holdBeforeStop.evidence_json, null);
    assert.equal(hostBeforeStop.state, 'running');
    assert.equal(hostBeforeStop.processId, context.repairPid);
    assert.ok(engineAIdentity && hostIdentity && repairIdentity, 'all three original process identities are observable');
    assert.equal(engineALock.pid, context.engineA.pid, 'Engine A owns runner.lock before Stop');

    record('owner_stop_request_sent', { engineAPid: context.engineA.pid, parentRunId: context.parentRunId });
    let stopCallState = 'pending';
    const stopPromise = context.engineA.api('POST', `/api/v2/runs/${context.parentRunId}/stop`, { requestId: randomUUID() })
      .then(response => { stopCallState = `response:${response.status}`; return { response }; }, error => {
        stopCallState = `error:${error.message}`;
        return { error: { name: error.name, message: error.message } };
      });
    try {
      await eventually(() => existsSync(barrierEnteredPath), 'Engine A to enter the post-commit Parent Stop callback barrier', 20_000, 25);
    } catch (error) {
      const parentState = one(context.scratch.root, 'SELECT state FROM runs WHERE id = ?', context.parentRunId)?.state;
      const linkState = one(context.scratch.root, 'SELECT state FROM run_links WHERE id = ?', context.linkId)?.state;
      throw new Error(`${error.message} Preload=${JSON.stringify(preloadReady)}; stopCall=${stopCallState}; parentState=${parentState}; linkState=${linkState}; Engine A stderr=${context.engineA.stderr()}`);
    }
    const barrierEvent = JSON.parse(readFileSync(barrierEnteredPath, 'utf8'));
    assert.equal(barrierEvent.parentRunId, context.parentRunId);
    assert.equal(barrierEvent.enginePid, context.engineA.pid);
    assert.equal(existsSync(originalEnteredPath), false, 'the original P2 callback has not been entered');
    assert.equal(existsSync(originalCompletedPath), false, 'the original P2 callback has not completed');

    const parentAtCommit = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.parentRunId);
    assert.equal(parentAtCommit.state, 'stopping', 'the real Stop transaction committed before the callback barrier');
    assert.equal(parentAtCommit.published_version_id, context.parent.publishedVersionId);
    const stopEvent = query(context.scratch.root, 'SELECT sequence, envelope_json FROM journal_events WHERE run_id = ? AND event_type = ? ORDER BY sequence DESC LIMIT 1',
      context.parentRunId, 'run.state_changed').map(row => ({ sequence: row.sequence, ...JSON.parse(row.envelope_json).payload }))[0];
    assert.equal(stopEvent.to, 'stopping');
    assert.equal(one(context.scratch.root, 'SELECT state FROM run_links WHERE id = ?', context.linkId).state, 'open', 'link reconciliation has not run');
    assert.equal(one(context.scratch.root, 'SELECT state FROM runs WHERE id = ?', context.repairRunId).state, 'running');
    assert.equal(one(context.scratch.root, 'SELECT state FROM custody_workspace_holds WHERE custody_id = ?', context.repairCustodyId).state, 'held');
    assert.equal(isAlive(context.repairPid), true, 'Repair remains active while the callback is blocked');
    assert.equal(hostRecords(context.host).find(item => item.custodyId === context.repairCustodyId).state, 'running');
    record('parent_stop_commit_observed', { journalSequence: stopEvent.sequence, callbackBarrier: barrierEvent.event, repairPid: context.repairPid });

    const engineAExit = { pid: context.engineA.pid, identity: engineAIdentity };
    record('engine_a_termination_requested', engineAExit);
    context.engineA.kill();
    assert.equal(await eventually(() => exited(context.engineA.child) && !isAlive(context.engineA.pid), 'Engine A process to exit', 30_000, 50), true);
    engineAExit.exited = true;
    engineAExit.exitIdentity = processIdentity(context.engineA.pid);
    assert.equal(engineAExit.exitIdentity, null);
    assert.equal(existsSync(originalEnteredPath), false, 'Engine A died before entering the original callback');
    assert.equal(existsSync(originalCompletedPath), false, 'Engine A died before completing the original callback');
    assert.equal(isAlive(context.host.pid), true, 'the original Rust Host survives Engine A');
    assert.equal(processIdentity(context.host.pid), hostIdentity, 'the Host process identity is unchanged');
    assert.equal(isAlive(context.repairPid), true, 'the same Repair process remains active under the Host');
    assert.equal(processIdentity(context.repairPid), repairIdentity, 'Repair process identity is unchanged across Engine A exit');
    const repairIdentityAfterEngineAExit = processIdentity(context.repairPid);
    assert.deepEqual(custodyBindings(context.scratch.root, context.repairRunId), [
      { attempt_id: context.repairAttemptId, custody_id: context.repairCustodyId },
    ]);
    const holdAfterAExit = one(context.scratch.root, 'SELECT state, evidence_json FROM custody_workspace_holds WHERE custody_id = ?', context.repairCustodyId);
    assert.deepEqual(holdAfterAExit, { state: 'held', evidence_json: null }, 'the Host-owned workspace hold remains in force');
    assert.equal(one(context.scratch.root, 'SELECT state FROM run_links WHERE id = ?', context.linkId).state, 'open');
    record('engine_a_exit_verified', { ...engineAExit, hostPid: context.host.pid, repairPid: context.repairPid, callbackExecuted: false });

    const stopOutcome = await Promise.race([
      stopPromise,
      new Promise(resolvePromise => setTimeout(() => resolvePromise({ timedOut: true }), 5_000)),
    ]);
    assert.equal(stopOutcome.timedOut, undefined, 'Engine A Stop request terminates with its process, not a success response');
    assert.ok(stopOutcome.error, `Engine A Stop response was not returned: ${JSON.stringify(stopOutcome.response)}`);
    assert.equal(stopOutcome.response, undefined);
    const durableStopReceipt = query(context.scratch.root, 'SELECT request_id, command FROM command_receipts WHERE command = ? ORDER BY created_at DESC LIMIT 1',
      `POST /runs/${context.parentRunId}/stop`)[0];
    assert.ok(durableStopReceipt, 'the committed Stop has a durable command receipt');
    record('stop_receipt_verified_after_engine_a_exit', { requestId: durableStopReceipt.request_id, command: durableStopReceipt.command });

    const lockAfterAExit = JSON.parse(readFileSync(join(context.scratch.root, 'runtime', 'runner.lock'), 'utf8'));
    assert.equal(lockAfterAExit.id, engineALock.id, 'the stale marker remains until the replacement acquires ownership');
    context.engineB = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    const engineBLock = JSON.parse(readFileSync(join(context.scratch.root, 'runtime', 'runner.lock'), 'utf8'));
    const engineBIdentity = processIdentity(context.engineB.pid);
    assert.equal(engineBLock.pid, context.engineB.pid, 'Engine B is the authoritative runner.lock owner');
    assert.notEqual(engineBLock.id, engineALock.id, 'Engine B owns a new lock generation');
    assert.ok(engineBIdentity && context.engineB.pid !== context.engineA.pid);
    assert.equal(isAlive(context.host.pid), true);
    record('engine_b_started_and_lock_acquired', { pid: context.engineB.pid, identity: engineBIdentity, lockId: engineBLock.id });

    assert.equal(await waitForRunState(context.engineB, context.parentRunId, ['canceled', 'interrupted'], 60_000), 'canceled',
      'Engine B preserves the committed Owner Stop as a canceled Parent');
    const parentStoppedEvent = await eventually(() => query(context.scratch.root,
      "SELECT sequence, envelope_json FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked' ORDER BY sequence DESC LIMIT 1",
      context.parentRunId).map(row => ({ sequence: row.sequence, ...JSON.parse(row.envelope_json).payload }))[0] ?? null,
    'Engine B to reconcile the original link from the durable Parent Stop', 30_000, 25);
    assert.equal(parentStoppedEvent.linkId, context.linkId);
    assert.equal(parentStoppedEvent.incidentId, context.incidentId);
    assert.equal(parentStoppedEvent.code, 'parent_stopped');
    const reconciledLink = one(context.scratch.root, 'SELECT state, parent_suspension_state, incident_id, repair_run_id FROM run_links WHERE id = ?', context.linkId);
    assert.deepEqual(reconciledLink, { state: 'parent_stopped', parent_suspension_state: 'stopped', incident_id: context.incidentId, repair_run_id: context.repairRunId });
    assert.ok(parentStoppedEvent.sequence > stopEvent.sequence, 'Parent Stop commit precedes the Engine B blocked-transition event in the Parent journal');
    record('engine_b_recovered_parent_stop', { parentState: one(context.scratch.root, 'SELECT state FROM runs WHERE id = ?', context.parentRunId).state,
      linkId: context.linkId, journalSequence: parentStoppedEvent.sequence, code: parentStoppedEvent.code });

    assert.equal(await waitForRunState(context.engineB, context.repairRunId, ['canceled'], 90_000), 'canceled',
      'Engine B stops the original linked Repair through the ordinary Stop path');
    const repairStopEvent = query(context.scratch.root, 'SELECT sequence, envelope_json FROM journal_events WHERE run_id = ? AND event_type = ? ORDER BY sequence DESC LIMIT 1',
      context.repairRunId, 'run.state_changed').map(row => ({ sequence: row.sequence, ...JSON.parse(row.envelope_json).payload }))[0];
    assert.equal(repairStopEvent.to, 'canceled');
    assert.match(repairStopEvent.reason, /Root Stop completed/);
    const repairAttempt = one(context.scratch.root, 'SELECT id, state FROM attempts WHERE id = ? AND run_id = ?', context.repairAttemptId, context.repairRunId);
    assert.deepEqual(repairAttempt, { id: context.repairAttemptId, state: 'canceled' });
    const hostStopped = await eventually(() => {
      const item = hostRecords(context.host).find(recordItem => recordItem.custodyId === context.repairCustodyId);
      return item?.state === 'stopped' && item.drained === true ? item : null;
    }, 'Rust Host to record a stopped and drained Repair process tree', 60_000, 50);
    assert.equal(hostStopped.attemptId, context.repairAttemptId);
    assert.equal(hostStopped.processId, context.repairPid);
    assert.equal(hostStopped.terminationReason, 'Stopped by an authorized Stop request.');
    assert.equal(isAlive(context.repairPid), false, 'the Host-owned Repair process tree has ended');
    assert.equal(processIdentity(context.repairPid), null);
    const releasedHold = await eventually(() => {
      const hold = one(context.scratch.root, 'SELECT state, evidence_json FROM custody_workspace_holds WHERE custody_id = ?', context.repairCustodyId);
      return hold?.state === 'released' ? hold : null;
    }, 'workspace hold release after Host process-tree proof', 30_000, 25);
    const holdProof = JSON.parse(releasedHold.evidence_json);
    assert.equal(holdProof.hostState, 'stopped');
    assert.equal(holdProof.processTreeEnded, true);
    record('repair_host_stop_and_tree_proof_observed', { custodyId: context.repairCustodyId, state: hostStopped.state,
      drained: hostStopped.drained, processId: hostStopped.processId, holdState: releasedHold.state, holdProof });

    const parentWorkspace = one(context.scratch.root, `SELECT p.cwd AS parent_root, q.cwd AS repair_root FROM run_links l
      JOIN workspaces p ON p.id = l.parent_workspace_id JOIN workspaces q ON q.id = l.repair_workspace_id WHERE l.id = ?`, context.linkId);
    const parentRoot = resolve(parentWorkspace.parent_root), repairRoot = resolve(parentWorkspace.repair_root);
    assert.notEqual(parentRoot, repairRoot);
    assert.equal(parentRoot.startsWith(`${repairRoot}${sep}`), false);
    assert.equal(repairRoot.startsWith(`${parentRoot}${sep}`), false);
    assert.equal(parentWorkspace.parent_root, context.scratch.workspace);
    assert.equal(parentWorkspace.repair_root, context.repairWorkspace);
    assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-a.log')), 1);
    assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-b-attempts.log')), 1);
    assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-b-accepted.log')), 0);
    assert.equal(lineCount(join(context.scratch.workspace, 'p2-parent-c.log')), 0);
    assert.equal(lineCount(join(context.repairWorkspace, 'p2-repair-executed.log')), 0);
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair').length, 1,
      'Engine B reused the single original Repair provider invocation');
    assert.equal(hostRecords(context.host).filter(item => item.attemptId === context.repairAttemptId).length, 1,
      'the Host retains one record for the original Repair Attempt');
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-fail-once').length, 1,
      'Parent B was not retried after its explicit Stop');
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-parent-c').length, 0,
      'Parent C was not dispatched after its explicit Stop');
    assert.equal(query(context.scratch.root, 'SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ?',
      context.repair.workflow.workflowId, context.repairWorkspaceId).length, 1, 'no second Repair Run was created');
    assert.equal(custodyBindings(context.scratch.root, context.repairRunId).length, 1, 'the original Attempt/Custody binding is preserved');
    const finalParent = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.parentRunId);
    const finalRepair = one(context.scratch.root, 'SELECT state, published_version_id FROM runs WHERE id = ?', context.repairRunId);
    assert.equal(finalParent.state, 'canceled');
    assert.equal(finalRepair.state, 'canceled');
    assert.equal(one(context.scratch.root, 'SELECT published_version_id FROM runs WHERE id = ?', context.parentRunId).published_version_id,
      context.parent.publishedVersionId);
    assert.equal(one(context.scratch.root, 'SELECT published_version_id FROM runs WHERE id = ?', context.repairRunId).published_version_id,
      context.repair.publishedVersionId);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'",
      context.parentRunId).length, 0);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.repair_result_accepted'",
      context.parentRunId).length, 0);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'",
      context.parentRunId).length, 1);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'",
      context.repairRunId).length, 1);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.state_changed' AND json_extract(envelope_json, '$.payload.to') = 'succeeded'",
      context.repairRunId, context.repairAttemptId).length, 0, 'the stopped Repair provider Attempt cannot settle as a success');
    assert.equal(one(context.scratch.root, "SELECT COUNT(*) AS count FROM run_links WHERE parent_run_id = ? AND continuation_contract = 'logical_policy'",
      context.parentRunId).count, 1);
    record('terminal_state_and_no_resume_verified', { parentState: 'canceled', repairState: 'canceled', linkState: 'parent_stopped',
      providerLaunchCount: readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair').length,
      parentResumeCount: 0, duplicateSettlementCount: 0 });

    await context.engineB.stop();
    assert.equal(await eventually(() => exited(context.engineB.child), 'Engine B to shut down before repeated reconciliation', 20_000, 50), true);
    context.engineC = await startEngine(context.scratch.root, context.host, { fixtureStateDir: context.scratch.fixtureState });
    const engineCLock = JSON.parse(readFileSync(join(context.scratch.root, 'runtime', 'runner.lock'), 'utf8'));
    assert.equal(engineCLock.pid, context.engineC.pid);
    assert.equal(await waitForRunState(context.engineC, context.parentRunId, ['canceled']), 'canceled');
    assert.equal(await waitForRunState(context.engineC, context.repairRunId, ['canceled']), 'canceled');
    assert.equal(one(context.scratch.root, 'SELECT state, parent_suspension_state FROM run_links WHERE id = ?', context.linkId).state, 'parent_stopped');
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumption_blocked'",
      context.parentRunId).length, 1);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'",
      context.parentRunId).length, 0);
    assert.equal(query(context.scratch.root, "SELECT sequence FROM journal_events WHERE run_id = ? AND event_type = 'continuation.repair_result_accepted'",
      context.parentRunId).length, 0);
    assert.equal(readInvocations(context.scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair').length, 1);
    assert.equal(isAlive(context.host.pid), true, 'Host remained alive through repeated Engine recovery');
    record('engine_c_reconciliation_remained_idempotent', { pid: context.engineC.pid, lockId: engineCLock.id,
      linkState: 'parent_stopped', parentResumeCount: 0, providerLaunchCount: 1, duplicateSettlementCount: 0 });

    const finalParentEvents = query(context.scratch.root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence',
      context.parentRunId).map(row => ({ sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.envelope_json).payload }));
    const finalRepairEvents = query(context.scratch.root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence',
      context.repairRunId).map(row => ({ sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.envelope_json).payload }));
    const proof = {
      schemaVersion: 1,
      testId: 'P2-E2E-06',
      scenario: 'Parent Stop callback loss across real Engine A-to-B replacement',
      generatedAt: new Date().toISOString(),
      sourceManifest: process.env.DESZO_P2_D25_SOURCE_MANIFEST ?? null,
      sourceManifestSha256: process.env.DESZO_P2_D25_SOURCE_MANIFEST && existsSync(process.env.DESZO_P2_D25_SOURCE_MANIFEST)
        ? hash(readFileSync(process.env.DESZO_P2_D25_SOURCE_MANIFEST)) : null,
      baseHead: process.env.DESZO_P2_D25_BASE_HEAD ?? null,
      processes: {
        engineA: { pid: engineAExit.pid, processIdentity: engineAIdentity, runnerLock: engineALock, exitIdentity: engineAExit.exitIdentity, exited: engineAExit.exited },
        engineB: { pid: context.engineB.pid, processIdentity: engineBIdentity, runnerLock: engineBLock },
        engineC: { pid: context.engineC.pid, runnerLock: engineCLock },
        host: { pid: context.host.pid, processIdentity: hostIdentity, aliveAfterEngineAExit: true, aliveAfterEngineCRecovery: true },
        repair: { pid: context.repairPid, processIdentityBeforeEngineAExit: repairIdentity, processIdentityAfterEngineAExit: repairIdentityAfterEngineAExit,
          hostProcessCreationTime: hostBeforeStop.processCreationTime, hostFinalProcessId: hostStopped.processId },
      },
      identities: {
        parentRunId: context.parentRunId, repairRunId: context.repairRunId, linkId: context.linkId, incidentId: context.incidentId,
        parentPublicationId: context.parent.publishedVersionId, repairPublicationId: context.repair.publishedVersionId,
        repairAttemptId: context.repairAttemptId, custodyInvocationId: context.repairCustodyId,
      },
      stopCommit: { requestId: durableStopReceipt.request_id, command: durableStopReceipt.command, journalSequence: stopEvent.sequence,
        parentStateAtCommit: parentAtCommit.state, linkStateAtCommit: 'open' },
      callbackBarrier: { ...barrierEvent, originalCallbackEntered: existsSync(originalEnteredPath), originalCallbackCompleted: existsSync(originalCompletedPath) },
      recovery: { engineBPid: context.engineB.pid, parentStoppedEventSequence: parentStoppedEvent.sequence,
        parentState: finalParent.state, repairStopEventSequence: repairStopEvent.sequence, repairAttemptId: repairAttempt.id,
        repairState: finalRepair.state, linkState: reconciledLink.state },
      hostStop: { state: hostStopped.state, drained: hostStopped.drained, terminationReason: hostStopped.terminationReason,
        processTreeEnded: holdProof.processTreeEnded, holdState: releasedHold.state, holdEvidence: holdProof },
      workspaceIsolation: { parentRoot: parentWorkspace.parent_root, repairRoot: parentWorkspace.repair_root, rootsAreDisjoint: true },
      final: { parentState: 'canceled', repairState: 'canceled', linkState: 'parent_stopped', providerLaunchCount: 1,
        parentResumeCount: 0, duplicateSettlementCount: 0, parentAcceptedEffects: { a: 1, b: 0, c: 0 }, repairAcceptedEffects: 0 },
      causalTrace,
      journal: { parent: finalParentEvents, repair: finalRepairEvents },
    };
    const evidencePath = join('docs', 'reviews', 'evidence', '2026-10-27-p2-d25-engine-replacement.json');
    if (process.env.DESZO_P2_D25_WRITE_EVIDENCE === '1') {
      assert.ok(proof.sourceManifest && proof.sourceManifestSha256, 'D25 evidence is bound to the frozen source manifest');
      mkdirSync(join('docs', 'reviews', 'evidence'), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(proof, null, 2)}\n`);
    }
  } finally { await stopCase(context); }
});

