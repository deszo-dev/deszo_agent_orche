// P4 integration proofs through the real Engine, SQLite journal, Rust Process Custody Host, and deterministic Rust provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptsOf, buildArtifacts, cleanup, database, eventually, exited, newScratch, readInvocations,
  registerWorkspace, runEventTypes, startCustodyHost, startEngine, startPublishedRun, waitForRunState,
} from './custody-support.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const p4Policy = (judgeModel = 'custody-p4-wait', repairProfiles = []) => ({
  version: 'workflow-judge/1', judgeNodeId: 'judge', maxJudgeAttemptsPerRun: 8, maxEvidenceExpansionsPerAttention: 1, repairProfiles,
});

function judgeWorkflow(workflowId, { workerModel = 'custody-p4-fail', judgeModel = 'custody-p4-wait', request = 'P4 deterministic request.',
  repairProfiles = [], parallelObserver = false } = {}) {
  const nodes = [
    { id: 'request', type: 'text', config: { value: request } },
    { id: 'worker', type: 'agent', config: { provider: 'codex', model: workerModel, timeoutSeconds: 120, output: { format: 'text' } } },
    { id: 'result', type: 'result-viewer', config: {} },
  ];
  const edges = [edge('request-worker', 'request', 'text', 'worker', 'prompt'), edge('worker-result', 'worker', 'text', 'result', 'value')];
  if (parallelObserver) {
    nodes.push(
      { id: 'observer-request', type: 'text', config: { value: 'Run this independent observer only after capacity becomes available.' } },
      { id: 'observer', type: 'agent', config: { provider: 'codex', model: 'custody-p4-observer', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'observer-result', type: 'result-viewer', config: {} },
    );
    edges.push(edge('observer-request-agent', 'observer-request', 'text', 'observer', 'prompt'),
      edge('observer-result-edge', 'observer', 'text', 'observer-result', 'value'));
  }
  nodes.push({ id: 'judge', type: 'agent', config: { provider: 'codex', model: judgeModel, timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } });
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes, edges, after: [],
    judgePolicy: p4Policy(judgeModel, repairProfiles) };
}

function repairWorkflow(workflowId, judgeModel = 'custody-p4-adaptive') {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Produce the captured Repair result and verification.' } },
      { id: 'repair-work', type: 'agent', config: { provider: 'codex', model: 'custody-p4-repair-result', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'verify', type: 'agent', config: { provider: 'codex', model: 'custody-p4-verify', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
      { id: 'repair-judge', type: 'agent', config: { provider: 'codex', model: judgeModel, timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } },
    ],
    edges: [edge('request-repair', 'request', 'text', 'repair-work', 'prompt'), edge('repair-verify', 'repair-work', 'text', 'verify', 'prompt'),
      edge('verify-result', 'verify', 'text', 'result', 'value')],
    after: [], judgePolicy: { ...p4Policy(judgeModel), judgeNodeId: 'repair-judge' },
  };
}

function p4Events(root, runId) { return runEventTypes(root, runId); }
function rows(root, sql, ...args) {
  const db = database(root);
  try { return db.prepare(sql).all(...args).map(row => ({ ...row })); } finally { db.close(); }
}
function one(root, sql, ...args) { return rows(root, sql, ...args)[0] ?? null; }
async function readArtifact(engine, artifactId) {
  const result = await engine.api('GET', `/api/v2/artifacts/${artifactId}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function createRun(engine, workflow, workspaceId, workspacePath) {
  await registerWorkspace(engine, workspaceId, workspacePath);
  const publication = await (await import('./custody-support.mjs')).publishDefinition(engine, workflow);
  return { publication, runId: await startPublishedRun(engine, publication, workspaceId) };
}
async function stopIfRunning(engine) { if (engine && !exited(engine.child)) await engine.stop(); }
function cleanupScratch(root) {
  if (process.env.P4_KEEP_SCRATCH === '1') { console.error(`P4 debug scratch retained for this test: ${root}`); return; }
  cleanup(root);
}
async function waitForRunStateWithDiagnostics(engine, root, runId, states, timeoutMs) {
  try { return await waitForRunState(engine, runId, states, timeoutMs); }
  catch (error) {
    const run = await engine.api('GET', `/api/v2/runs/${runId}`).catch(() => null);
    const attempts = rows(root, `SELECT n.node_id, a.id, a.state, a.exit_code, a.process_id
      FROM attempts a JOIN node_instances n ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? ORDER BY a.rowid`, runId);
    const events = p4Events(root, runId).map(item => ({ type: item.type, attemptId: item.attemptId, payload: item.payload }));
    throw new Error(`${error.message}\nrun=${JSON.stringify(run?.body?.run)}\nattempts=${JSON.stringify(attempts)}\nevents=${JSON.stringify(events)}\nengineStderr=${engine.stderr()}`);
  }
}

test('P4-E2E-01 and P4-E2E-08: failure opens one durable Judge attention; idle P4 spends no Judge invocation', async t => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-e2e-01');
  const host = await startCustodyHost(scratch.root);
  let engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    await t.test('failure, admission, evidence bound, and ordinary graph hold', async () => {
      const workspaceId = 'p4-e2e01';
      const workspacePath = join(scratch.root, 'workspace-e2e01');
      const started = await createRun(engine, judgeWorkflow('p4-e2e01', { workerModel: 'custody-p4-gated-fail',
        judgeModel: 'custody-p4-wait', request: 'P4 failure test gate=P4_WORKER', parallelObserver: true }), workspaceId, workspacePath);
      const runId = started.runId;
      const workerReady = join(workspacePath, 'READY-P4_WORKER.marker');
      const workerRelease = join(workspacePath, 'RELEASE-P4_WORKER.marker');
      await eventually(() => existsSync(workerReady), 'ordinary P4 worker to reach the deterministic failure gate', 60_000, 50);
      assert.equal(rows(scratch.root, 'SELECT a.id FROM attempts a JOIN node_instances n ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? AND n.node_id=?', runId, 'judge').length, 0,
        'capture does not create a Judge Attempt before a durable attention exists');
      assert.deepEqual(readInvocations(scratch.fixtureState).map(item => item.model), ['custody-p4-gated-fail'],
        'no Judge CLI starts while ordinary work is still running');
      writeFileSync(workerRelease, 'release\n');
      assert.equal(await waitForRunStateWithDiagnostics(engine, scratch.root, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');

      const invocations = readInvocations(scratch.fixtureState).map(item => item.model);
      assert.deepEqual(invocations, ['custody-p4-gated-fail', 'custody-p4-wait'], 'the designated Judge is the only post-failure launch');
      const attempts = rows(scratch.root, `SELECT n.node_id, a.state, a.ordinal FROM attempts a JOIN node_instances n
        ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? ORDER BY a.rowid`, runId);
      assert.equal(attempts.find(item => item.node_id === 'worker')?.state, 'failed');
      assert.equal(attempts.find(item => item.node_id === 'judge')?.state, 'succeeded');
      assert.ok(['scheduled', 'waiting'].includes(attempts.find(item => item.node_id === 'observer')?.state), 'independent ordinary work remains held');
      assert.equal(attempts.filter(item => item.node_id === 'judge').length, 1, 'exactly one Judge Attempt is admitted');

      const events = p4Events(scratch.root, runId);
      const opened = events.filter(item => item.type === 'judge.attention_opened');
      assert.equal(opened.length, 1);
      assert.equal(events.filter(item => item.type === 'judge.waited').length, 1);
      const attention = await readArtifact(engine, opened[0].payload.record.artifactId);
      const evidence = await readArtifact(engine, attention.evidenceArtifact.artifactId);
      assert.ok(Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= 16 * 1024, 'initial evidence is capped at 16 KiB');
      assert.equal(evidence.kind, 'JudgeEvidencePackage');
      assert.ok(evidence.provenance.includes('engine_trusted') && evidence.provenance.includes('provider_untrusted'));
      assert.equal(rows(scratch.root, 'SELECT * FROM failure_outcomes WHERE run_id=?', runId).length, 1, 'P3 records one durable ordinary failure');

      const beforeRestart = readInvocations(scratch.fixtureState).length;
      engine.kill();
      await eventually(() => exited(engine.child), 'Engine A to exit after the wait decision', 30_000, 50);
      engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
      assert.equal(await waitForRunState(engine, runId, ['waiting_for_user'], 30_000), 'waiting_for_user');
      await new Promise(resolve => setTimeout(resolve, 750));
      assert.equal(readInvocations(scratch.fixtureState).length, beforeRestart, 'an unchanged evaluated attention does not invoke Judge again after recovery');
      assert.equal(rows(scratch.root, "SELECT a.id FROM attempts a JOIN node_instances n ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? AND n.node_id='judge'", runId).length, 1);
    });

    await t.test('successful P4 workflow completes with no Judge Attempt or Judge process', async () => {
      const workspaceId = 'p4-e2e08';
      const workspacePath = join(scratch.root, 'workspace-e2e08');
      const started = await createRun(engine, judgeWorkflow('p4-e2e08', { workerModel: 'custody-p4-repair-result', judgeModel: 'custody-p4-wait' }), workspaceId, workspacePath);
      assert.equal(await waitForRunStateWithDiagnostics(engine, scratch.root, started.runId, ['succeeded'], 60_000), 'succeeded');
      const attempts = rows(scratch.root, `SELECT n.node_id FROM attempts a JOIN node_instances n ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=?`, started.runId);
      assert.equal(attempts.some(item => item.node_id === 'judge'), false);
      assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-wait').length, 1,
        'the only wait Judge invocation belongs to the earlier failure attention');
    });
  } finally {
    await stopIfRunning(engine);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});

test('unsupported P4 recovery interrupts the Run and closes its pending Owner question', async () => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-unsupported-question');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const workspaceId = 'p4-unsupported-question';
    const workspacePath = join(scratch.root, 'workspace-unsupported-question');
    const { runId } = await createRun(engineA, judgeWorkflow('p4-unsupported-question', { judgeModel: 'custody-p4-question' }), workspaceId, workspacePath);
    assert.equal(await waitForRunStateWithDiagnostics(engineA, scratch.root, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
    const pending = await engineA.api('GET', `/api/v2/runs/${runId}/judge-questions`);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.barrier, true);
    assert.equal(pending.body.items.length, 1);
    assert.equal(pending.body.items[0].status, 'pending');

    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to exit with a durable pending P4 question', 30_000, 50);
    engineB = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, ['interrupted'], 30_000), 'interrupted');
    const closed = await engineB.api('GET', `/api/v2/runs/${runId}/judge-questions`);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.barrier, false);
    assert.equal(closed.body.items[0].status, 'superseded');
    assert.equal(one(scratch.root, 'SELECT status FROM workflow_questions WHERE id=?', closed.body.items[0].questionId).status, 'superseded');
    const lateAnswer = await engineB.api('POST', `/api/v2/judge-questions/${closed.body.items[0].questionId}/answers`, {
      requestId: randomUUID(), answer: { type: 'choice', optionId: 'keep' },
    });
    assert.equal(lateAnswer.status, 409);
    assert.equal(lateAnswer.body.code, 'judge_question_closed');
    const events = p4Events(scratch.root, runId);
    assert.ok(events.some(item => item.type === 'question.superseded'));
  } finally {
    await stopIfRunning(engineB);
    await stopIfRunning(engineA);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});

test('unsupported P4 recovery supersedes an evaluated Judge wait barrier', async () => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-unsupported-wait');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const workspaceId = 'p4-unsupported-wait';
    const workspacePath = join(scratch.root, 'workspace-unsupported-wait');
    const { runId } = await createRun(engineA, judgeWorkflow('p4-unsupported-wait', { judgeModel: 'custody-p4-wait' }), workspaceId, workspacePath);
    assert.equal(await waitForRunStateWithDiagnostics(engineA, scratch.root, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
    assert.ok(p4Events(scratch.root, runId).some(item => item.type === 'judge.waited'));
    const pending = await engineA.api('GET', `/api/v2/runs/${runId}/judge-questions`);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.barrier, true);
    assert.equal(pending.body.items.length, 0);

    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to exit with an evaluated Judge wait barrier', 30_000, 50);
    engineB = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, ['interrupted'], 30_000), 'interrupted');
    const closed = await engineB.api('GET', `/api/v2/runs/${runId}/judge-questions`);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.barrier, false);
    assert.ok(p4Events(scratch.root, runId).some(item => item.type === 'judge.attention_superseded'));
  } finally {
    await stopIfRunning(engineB);
    await stopIfRunning(engineA);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});

test('P4-E2E-02 and P4-E2E-12: Engine replacement reattaches one live Judge Attempt across generations', async () => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-e2e-02');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null, engineC = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const workspaceId = 'p4-e2e02';
    const workspacePath = join(scratch.root, 'workspace-e2e02');
    const started = await createRun(engineA, judgeWorkflow('p4-e2e02', { workerModel: 'custody-p4-fail', judgeModel: 'custody-p4-gated-wait' }), workspaceId, workspacePath);
    const runId = started.runId;
    const judgeReady = join(workspacePath, 'READY-P4_JUDGE.marker');
    const judgeRelease = join(workspacePath, 'RELEASE-P4_JUDGE.marker');
    await eventually(() => existsSync(judgeReady), 'designated Judge CLI to start under Rust Process Custody', 90_000, 50);
    const before = attemptsOf(scratch.root, runId).find(item => item.state === 'running');
    assert.ok(before, 'the original Judge attempt is durably running');
    const hostBinding = one(scratch.root, 'SELECT custody_id FROM attempt_custody WHERE attempt_id=?', before.id);
    assert.ok(hostBinding?.custody_id, 'the active Judge is bound to one Rust Host custody record');
    const launchesBefore = readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-gated-wait');
    assert.equal(launchesBefore.length, 1);

    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to exit during the live Judge invocation', 30_000, 50);
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-gated-wait').length, 1,
      'Engine B reattaches to the existing Host process rather than launching another CLI');
    writeFileSync(judgeRelease, 'release\n');
    assert.equal(await waitForRunStateWithDiagnostics(engineB, scratch.root, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
    const sameAttempt = attemptsOf(scratch.root, runId).find(item => item.id === before.id);
    assert.equal(sameAttempt.state, 'succeeded', JSON.stringify({ sameAttempt, events: p4Events(scratch.root, runId), stderr: engineB.stderr() }));
    assert.equal(sameAttempt.process_id, before.process_id);
    assert.equal(attemptsOf(scratch.root, runId).filter(item => item.state === 'succeeded' && item.id === before.id).length, 1);
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-gated-wait').length, 1);

    engineB.kill();
    await eventually(() => exited(engineB.child), 'Engine B to exit after recovering the same decision', 30_000, 50);
    engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineC, runId, ['waiting_for_user'], 30_000), 'waiting_for_user');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-gated-wait').length, 1,
      'a third Engine generation does not repeat the unchanged evaluated attention');
    assert.equal(rows(scratch.root, "SELECT a.id FROM attempts a JOIN node_instances n ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? AND n.node_id='judge'", runId).length, 1);
  } finally {
    await stopIfRunning(engineA); await stopIfRunning(engineB); await stopIfRunning(engineC);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});

test('P4-E2E-03: decision, P2 link, suspension, and queued Repair survive a crash before dispatch', async () => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-e2e-03');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null, engineC = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState,
      extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_settle:judge' } });
    const parentWorkspaceId = 'p4-e2e03-parent';
    const repairWorkspaceId = 'p4-e2e03-repair';
    const repairWorkspacePath = join(scratch.root, 'repair-workspace');
    mkdirSync(repairWorkspacePath, { recursive: true });
    await registerWorkspace(engineA, repairWorkspaceId, repairWorkspacePath);
    const repairWorkflow = {
      schemaVersion: 1, workflowId: 'p4-e2e03-repair-workflow', capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
      nodes: [
        { id: 'request', type: 'text', config: { value: 'Return the expected P4 repair result.' } },
        { id: 'repair-result', type: 'agent', config: { provider: 'codex', model: 'custody-p4-repair-result', timeoutSeconds: 120, output: { format: 'text' } } },
        { id: 'result', type: 'result-viewer', config: {} },
      ], edges: [edge('request-result', 'request', 'text', 'repair-result', 'prompt'), edge('repair-result-view', 'repair-result', 'text', 'result', 'value')], after: [],
    };
    const { publishDefinition } = await import('./custody-support.mjs');
    const repairPublication = await publishDefinition(engineA, repairWorkflow);
    const profile = { profileId: 'default', repairWorkflowId: repairWorkflow.workflowId, repairPublishedVersion: repairPublication.version,
      repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId, failedNodeInstanceId: 'worker',
      repairResultNodeInstanceId: 'repair-result', verificationNodeInstanceIds: [], acceptanceMode: 'expected_digest',
      expectedRepairResultSha256: hash('P4_REPAIR_OK'), failedNodeRetry: 'never' };
    const parent = judgeWorkflow('p4-e2e03-parent-workflow', { workerModel: 'custody-p4-fail', judgeModel: 'custody-p4-repair', repairProfiles: [profile] });
    const started = await createRun(engineA, parent, parentWorkspaceId, scratch.workspace);
    const parentRunId = started.runId;
    await eventually(() => exited(engineA.child), 'Engine A to crash after the atomic Judge decision commit', 90_000, 50);

    const link = one(scratch.root, 'SELECT * FROM run_links WHERE parent_run_id=? AND continuation_contract=?', parentRunId, 'logical_policy');
    assert.ok(link, 'the P2 link committed before Engine A exited');
    assert.equal(rows(scratch.root, 'SELECT id FROM run_links WHERE parent_run_id=? AND continuation_contract=?', parentRunId, 'logical_policy').length, 1);
    assert.equal(link.parent_suspension_state, 'suspension_requested', 'the post-commit callback had not yet settled Parent suspension');
    assert.equal(one(scratch.root, 'SELECT state FROM runs WHERE id=?', parentRunId).state, 'waiting_for_user');
    assert.equal(one(scratch.root, 'SELECT state FROM runs WHERE id=?', link.repair_run_id).state, 'queued', 'Repair was durably created but not dispatched before the crash');
    const decisionEvents = p4Events(scratch.root, parentRunId).filter(item => item.type === 'judge.decision_applied');
    assert.equal(decisionEvents.length, 1);

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, link.repair_run_id, ['succeeded'], 90_000), 'succeeded');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-repair-result').length, 1,
      'recovery dispatches the existing queued Repair exactly once');
    assert.equal(rows(scratch.root, 'SELECT id FROM run_links WHERE parent_run_id=? AND continuation_contract=?', parentRunId, 'logical_policy').length, 1);
    const afterRepair = one(scratch.root, 'SELECT * FROM run_links WHERE id=?', link.id);
    assert.equal(afterRepair.state, 'blocked', 'the captured failed_node_retry=never policy prevents Parent replay');
    assert.equal(rows(scratch.root, 'SELECT id FROM attempts WHERE run_id=? AND node_instance_id=?', parentRunId, 'worker').length, 1);

    engineB.kill();
    await eventually(() => exited(engineB.child), 'Engine B to exit after Repair recovery', 30_000, 50);
    engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-repair-result').length, 1,
      'a later generation cannot duplicate the completed Repair');
    assert.equal(rows(scratch.root, 'SELECT id FROM run_links WHERE parent_run_id=? AND continuation_contract=?', parentRunId, 'logical_policy').length, 1);
  } finally {
    await stopIfRunning(engineA); await stopIfRunning(engineB); await stopIfRunning(engineC);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});

test('P4-CP03: parsed and validated Judge output replays once after a pre-commit Engine crash', async t => {
  buildArtifacts();
  for (const point of ['before_workflow_judge_validation', 'after_workflow_judge_validation']) {
    await t.test(point, async () => {
      const scratch = newScratch(`workflow-judge-${point}`);
      const id = point.replaceAll('_', '-');
      const host = await startCustodyHost(scratch.root);
      let engineA = null, engineB = null;
      try {
        engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState,
          extraEnv: { DESZO_CUSTODY_TEST_FAULT: point } });
        const { runId } = await createRun(engineA, judgeWorkflow(`workflow-judge-${id}`, {
          workerModel: 'custody-p4-fail', judgeModel: 'custody-p4-wait',
        }), `workspace-${id}`, join(scratch.root, 'workspace'));
        await eventually(() => exited(engineA.child), `Engine A to crash at ${point}`, 90_000, 50);

        const judge = one(scratch.root, `SELECT a.id, a.state, a.process_id FROM attempts a JOIN node_instances n
          ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? AND n.node_id='judge'`, runId);
        assert.ok(judge);
        assert.equal(judge.state, 'running', 'validation happened without committing the Judge settlement');
        assert.equal(p4Events(scratch.root, runId).filter(item => item.type === 'judge.decision_applied').length, 0);
        assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-wait').length, 1);

        engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
        assert.equal(await waitForRunState(engineB, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
        const settled = one(scratch.root, `SELECT a.id, a.state, a.process_id FROM attempts a JOIN node_instances n
          ON n.run_id=a.run_id AND n.id=a.node_instance_id WHERE a.run_id=? AND n.node_id='judge'`, runId);
        assert.equal(settled.id, judge.id, 'Engine B settles the original Judge Attempt');
        assert.equal(settled.state, 'succeeded');
        assert.equal(settled.process_id, judge.process_id);
        assert.equal(p4Events(scratch.root, runId).filter(item => item.type === 'judge.decision_applied').length, 1);
        assert.equal(p4Events(scratch.root, runId).filter(item => item.type === 'judge.waited').length, 1);
        assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p4-wait').length, 1,
          'the terminal Custody invocation is replayed without a second provider launch');
      } finally {
        await stopIfRunning(engineA); await stopIfRunning(engineB);
        if (!exited(host.child)) await host.shutdown();
        cleanupScratch(scratch.root);
      }
    });
  }
});

test('P4-CP03: adaptive Repair approval survives a crash before Parent resumption', async () => {
  buildArtifacts();
  const scratch = newScratch('workflow-judge-approval-recovery');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState,
      extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_p2_repair_acceptance' } });
    const repairWorkspaceId = 'p4-approval-repair';
    const repairWorkspacePath = join(scratch.root, 'repair-workspace-approval');
    mkdirSync(repairWorkspacePath, { recursive: true });
    await registerWorkspace(engineA, repairWorkspaceId, repairWorkspacePath);
    const repair = repairWorkflow('p4-approval-repair-workflow', 'custody-p4-adaptive');
    const { publishDefinition } = await import('./custody-support.mjs');
    const repairPublication = await publishDefinition(engineA, repair);
    const profile = { profileId: 'default', repairWorkflowId: repair.workflowId, repairPublishedVersion: repairPublication.version,
      repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId, failedNodeInstanceId: 'worker',
      repairResultNodeInstanceId: 'repair-work', verificationNodeInstanceIds: ['verify'], acceptanceMode: 'judge_post_execution',
      failedNodeRetry: 'never' };
    const parent = judgeWorkflow('p4-approval-recovery-parent', { workerModel: 'custody-p4-fail',
      judgeModel: 'custody-p4-adaptive', repairProfiles: [profile] });
    const started = await createRun(engineA, parent, 'p4-approval-parent', scratch.workspace);
    const parentRunId = started.runId;
    await eventually(() => exited(engineA.child), 'Engine A to crash after durable P4 approval and P2 acceptance', 90_000, 50);

    let link = one(scratch.root, 'SELECT * FROM run_links WHERE parent_run_id=? AND continuation_contract=?', parentRunId, 'logical_policy');
    assert.ok(link, 'the existing P2 link is durable before the injected crash');
    assert.equal(link.state, 'repair_accepted');
    assert.equal(link.parent_suspension_state, 'resumable');
    assert.equal(link.decision_status, 'accepted');
    assert.ok(link.repair_approval_artifact_id);
    assert.equal(one(scratch.root, 'SELECT state FROM runs WHERE id=?', parentRunId).state, 'waiting_for_user');
    assert.equal(one(scratch.root, 'SELECT state FROM runs WHERE id=?', link.repair_run_id).state, 'succeeded');
    assert.equal(p4Events(scratch.root, link.repair_run_id).filter(item => item.type === 'repair.approval_recorded').length, 1);

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await eventually(() => one(scratch.root, 'SELECT state FROM run_links WHERE id=?', link.id)?.state === 'blocked',
      'P2 to reconcile accepted Repair under failed_node_retry=never without resuming Parent', 30_000, 50);
    link = one(scratch.root, 'SELECT * FROM run_links WHERE id=?', link.id);
    assert.equal(link.parent_suspension_state, 'blocked');
    assert.equal(one(scratch.root, 'SELECT state FROM runs WHERE id=?', parentRunId).state, 'waiting_for_user');
    assert.equal(rows(scratch.root, "SELECT event_type FROM journal_events WHERE run_id=? AND event_type='continuation.parent_resumed'", parentRunId).length, 0);
    assert.equal(rows(scratch.root, 'SELECT id FROM attempts WHERE run_id=? AND node_instance_id=?', parentRunId, 'worker').length, 1);
    const models = readInvocations(scratch.fixtureState).map(item => item.model);
    assert.equal(models.filter(item => item === 'custody-p4-adaptive').length, 2, 'Parent and Repair Judge each ran exactly once');
    assert.equal(models.filter(item => item === 'custody-p4-repair-result').length, 1, 'the queued Repair is not repeated after recovery');
    assert.equal(models.filter(item => item === 'custody-p4-verify').length, 1);
  } finally {
    await stopIfRunning(engineA); await stopIfRunning(engineB);
    if (!exited(host.child)) await host.shutdown();
    cleanupScratch(scratch.root);
  }
});
