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

async function launchCase(label, { repairModel = 'custody-p2-gated-repair', extraEnv = {} } = {}) {
  buildArtifacts();
  const scratch = newScratch(`p2-${label}`);
  const repairWorkspace = join(scratch.root, 'repair-workspace');
  mkdirSync(repairWorkspace, { recursive: true });
  const parentWorkspaceId = `p2-${label}-parent`;
  const repairWorkspaceId = `p2-${label}-repair`;
  const host = await startCustodyHost(scratch.root);
  let engineA = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv });
    await registerWorkspace(engineA, parentWorkspaceId, scratch.workspace);
    await registerWorkspace(engineA, repairWorkspaceId, repairWorkspace);
    const parent = await publish(engineA, parentDefinition(`p2-${label}-parent`));
    const repair = await publish(engineA, repairDefinition(`p2-${label}-repair`, repairModel));
    const parentRunId = await startPublishedRun(engineA, parent, parentWorkspaceId);
    assert.equal(await waitForRunState(engineA, parentRunId, ['waiting_for_user'], 120_000), 'waiting_for_user');
    assert.equal(attemptsOf(scratch.root, parentRunId).filter(item => item.state === 'failed').length, 1, 'Parent B has one durable initial failure');
    assert.equal(lineCount(join(scratch.workspace, 'p2-parent-a.log')), 1, 'Parent A side effect was accepted once before Repair');
    const request = { requestId: randomUUID(), incidentId: randomUUID(), failedNodeInstanceId: 'b', repairWorkflowId: repair.workflow.workflowId,
      repairWorkflowSnapshotSha256: repair.snapshotSha256, repairWorkspaceId, repairResultNodeInstanceId: 'verified',
      expectedRepairResultSha256: hash('P2_REPAIR_VERIFIED'), failedNodeRetry: 'explicit_safe' };
    const linked = await engineA.api('POST', `/api/v2/runs/${parentRunId}/linked-repair`, request);
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    const repairRunId = linked.body.repairRunId;
    let repairAttempt;
    let binding;
    let identity;
    if (['custody-p2-gated-repair', 'custody-p2-gated-repair-fail'].includes(repairModel)) {
      await eventually(() => existsSync(join(repairWorkspace, 'READY-P2_REPAIR.marker')), 'Repair Custody process to reach its deterministic barrier', 90_000, 100);
      repairAttempt = attemptsOf(scratch.root, repairRunId).find(item => item.state === 'running');
      assert.ok(repairAttempt, 'the linked Repair has an active process attempt');
      binding = custodyBindings(scratch.root, repairRunId).find(item => item.attempt_id === repairAttempt.id);
      assert.ok(binding?.custody_id, 'the Repair Attempt is bound to a Rust Host invocation');
      identity = hostRecords(host).find(record => record.attemptId === repairAttempt.id && record.state === 'running');
      assert.ok(identity, 'the Host records the live Repair process');
    } else {
      await waitForRunState(engineA, repairRunId, ['waiting_for_user'], 90_000);
      repairAttempt = attemptsOf(scratch.root, repairRunId).find(item => item.state === 'failed');
    }
    return { label, scratch, repairWorkspace, parentWorkspaceId, repairWorkspaceId, parent, repair, parentRunId, repairRunId,
      incidentId: request.incidentId, linkId: linked.body.linkId, repairAttemptId: repairAttempt.id, repairCustodyId: binding?.custody_id ?? null,
      repairPid: identity?.processId ?? null, host, engineA, engineB: null, engineC: null };
  } catch (error) {
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

