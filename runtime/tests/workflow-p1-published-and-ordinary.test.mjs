// P1 published-version binding and the ordinary (non-Process-Custody) restart path. Real Engine runtimes and the deterministic provider
// fixture run the same three-node published workflow as workflow-p1-continuation.test.mjs. Assertions use the Engine's journal and
// attempts, the fixture launch record, and the marker the workflow writes in its workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  buildArtifacts, cleanup, database, eventually, exited, isAlive, newScratch, publishDefinition, readInvocations,
  registerWorkspace, startCustodyHost, startEngine, waitForRunState,
} from './custody-support.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];

// A (writer) -> B (provider) -> C (verification of the marker). C is a file-input node, so the workflow version decides what it reads.
function chainDefinition(workflowId, { bModel = 'custody-steady', bTicks = 24, cPaths = ['custody-writer.log'] } = {}) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1', 'loops-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request-a', type: 'text', config: { value: '[ticks=1] Write the marker.' } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'custody-writer', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'b-prompt', type: 'prompt-template', config: { template: `Previous step: {{prior}}\n[ticks=${bTicks}] Continue.`, slots: [{ id: 'prior' }] } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: bModel, timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'c', type: 'file-input', config: { mode: 'files', paths: cPaths } },
      { id: 'result', type: 'result-viewer', config: {} },
      { id: 'result-c', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'request-a-to-a', source: { nodeId: 'request-a', port: 'text' }, target: { nodeId: 'a', port: 'prompt' } },
      { id: 'a-to-b-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'b-prompt', port: 'prior' } },
      { id: 'b-prompt-to-b', source: { nodeId: 'b-prompt', port: 'text' }, target: { nodeId: 'b', port: 'prompt' } },
      { id: 'b-to-result', source: { nodeId: 'b', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
      { id: 'c-to-result', source: { nodeId: 'c', port: 'value' }, target: { nodeId: 'result-c', port: 'value' } },
    ],
    after: [{ before: 'b', after: 'c' }],
  };
}

async function startRun(engine, scratch, definition) {
  await registerWorkspace(engine, 'main', scratch.workspace);
  const publication = await publishDefinition(engine, definition);
  const started = await engine.api('POST', '/api/v2/runs', { workflowId: definition.workflowId, workflowSnapshotSha256: publication.snapshotSha256,
    publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
  if (started.status !== 202) throw new Error(`run refused: ${JSON.stringify(started.body)}`);
  return { runId: started.body.run.runId, publication };
}

function rows(root, sql, ...params) {
  const db = database(root);
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
const attemptsOf = (root, runId, node) => rows(root,
  'SELECT id, node_instance_id AS node, state, process_id AS pid FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal', runId, node);
const runRow = (root, runId) => rows(root, 'SELECT id, state, published_version_id AS publishedVersionId FROM runs WHERE id = ?', runId)[0];
const publicationCount = (root, workflowId) => rows(root, 'SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', workflowId)[0].n;
function journal(root, runId) {
  return rows(root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', runId).map(row => {
    const envelope = JSON.parse(row.envelope_json);
    return { sequence: row.sequence, type: row.event_type, node: envelope.nodeInstanceId, attemptId: envelope.attemptId, payload: envelope.payload };
  });
}
const settledCount = (root, runId, node) => journal(root, runId)
  .filter(event => event.type === 'attempt.state_changed' && event.node === node && event.payload?.to === 'succeeded').length;
const launchesOf = (scratch, model) => readInvocations(scratch.fixtureState).filter(launch => launch.model === model);
const markerLines = scratch => existsSync(join(scratch.workspace, 'custody-writer.log'))
  ? readFileSync(join(scratch.workspace, 'custody-writer.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0;

async function waitForRunningProvider(root, runId, node) {
  return eventually(() => {
    const [attempt] = attemptsOf(root, runId, node).filter(row => row.state === 'running');
    return attempt && attempt.pid && isAlive(attempt.pid) ? attempt : null;
  }, `node ${node} to be running with a live provider process`, 90_000, 200);
}

// P1-12: Published v1 is running when v2 is published. Engine B continues the Run on v1: C reads v1's paths, and the Run keeps v1's id.
test('P1-12: a Run continues on its published v1 after v2 is published and the Engine is replaced', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-12');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const workflowId = 'p1-12';
    const v1 = chainDefinition(workflowId);
    const { runId, publication: v1Publication } = await startRun(engineA, scratch, v1);
    const bRunning = await waitForRunningProvider(scratch.root, runId, 'b');
    // v2: a derived draft whose C reads a file that does not exist. Had the Run switched to v2, C would fail.
    const current = await engineA.api('GET', `/api/v4/workflows/${workflowId}/draft`);
    assert.equal(current.status, 200, `the draft that published v1 is read: ${JSON.stringify(current.body)}`);
    const v2 = structuredClone(current.body.workflow);
    v2.nodes.find(node => node.id === 'c').config.paths = ['no-such-file-in-v2.txt'];
    const saved = await engineA.api('PUT', `/api/v4/workflows/${workflowId}/draft`, { requestId: randomUUID(), workflow: v2 }, { 'If-Match': current.etag });
    assert.equal(saved.status, 200, `v2 draft saved: ${JSON.stringify(saved.body)}`);
    const validated = await engineA.api('POST', `/api/v4/workflows/${workflowId}/draft/validate`, {}, { 'If-Match': saved.etag });
    assert.equal(validated.body.validation.valid, true, `v2 is valid: ${JSON.stringify(validated.body)}`);
    const v2Publication = await engineA.api('POST', `/api/v4/workflows/${workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': saved.etag });
    assert.equal(v2Publication.status, 201, `v2 published: ${JSON.stringify(v2Publication.body)}`);
    assert.notEqual(v2Publication.body.publishedVersionId, v1Publication.publishedVersionId);
    const publicationsBefore = publicationCount(scratch.root, workflowId);

    engineA.kill();
    await sleep(800);
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded', 'the Run completes on v1');
    assert.equal(runRow(scratch.root, runId).publishedVersionId, v1Publication.publishedVersionId, 'the Run is still bound to v1');
    assert.equal(settledCount(scratch.root, runId, 'c'), 1, 'C read v1 paths (v2 would have failed it)');
    assert.equal(publicationCount(scratch.root, workflowId), publicationsBefore, 'recovery publishes nothing');
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].pid, bRunning.pid, 'B keeps its provider process');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'B launched once');
    record('P1-12', { runId, v1: v1Publication.publishedVersionId, v2: v2Publication.body.publishedVersionId, finalRunState: 'succeeded' });
  } finally {
    if (engineB) await engineB.stop().catch(() => engineB.kill());
    engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

const evidence = { schemaVersion: 1, cases: {} };
const record = (id, value) => { evidence.cases[id] = value; };

// Ordinary path, no Process Custody: Engine A is terminated while a plain CLI is running. The CLI belonged to Engine A's process tree,
// so it does not survive; the Run is interrupted, and the replacement does not relaunch the node or claim it survived.
test('P1-NC-01: without Process Custody a CLI that was running when the Engine stopped is not claimed to survive or relaunched', { timeout: 300_000 }, async () => {
  const scratch = newScratch('p1-nc-01');
  const engineA = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-nc-01'));
    const bRunning = await waitForRunningProvider(scratch.root, runId, 'b');
    engineA.kill();
    await eventually(() => !isAlive(bRunning.pid), 'the ordinary CLI to end with its Engine', 60_000, 200);
    engineB = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'interrupted', 'the outcome is unknown, so the Run is interrupted');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'B is not relaunched');
    assert.equal(settledCount(scratch.root, runId, 'c'), 0, 'C never runs');
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'interrupted', 'B is recorded as interrupted');
    record('P1-NC-01', { runId, finalRunState: 'interrupted', launches: { b: 1 } });
  } finally {
    if (engineB) await engineB.stop().catch(() => engineB.kill());
    engineA.kill(); cleanup(scratch.root);
  }
});

// Ordinary path, no Process Custody: Engine A stops after node A is accepted and before B is dispatched. Engine B continues the Run
// with its ordinary dispatch: B runs once, C after it, and A is not rerun.
test('P1-NC-02: without Process Custody a Run restarted between nodes continues with the next node and runs C after it', { timeout: 300_000 }, async () => {
  const scratch = newScratch('p1-nc-02');
  const engineA = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_settle:a' } });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-nc-02', { bTicks: 2 }));
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to stop after A is accepted', 120_000, 100), true);
    const aBefore = attemptsOf(scratch.root, runId, 'a')[0];
    assert.equal(aBefore.state, 'succeeded');
    assert.equal(markerLines(scratch), 1, 'Node A already made one external side effect at the crash boundary');
    engineB = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded');
    const aAfter = attemptsOf(scratch.root, runId, 'a')[0];
    assert.equal(aAfter.id, aBefore.id, 'the accepted Node A attempt identity is unchanged');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'A is not rerun');
    assert.equal(markerLines(scratch), 1, 'Engine B does not repeat Node A external side effect');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'B runs once after the replacement');
    assert.equal(settledCount(scratch.root, runId, 'a'), 1);
    assert.equal(settledCount(scratch.root, runId, 'b'), 1);
    assert.equal(settledCount(scratch.root, runId, 'c'), 1);
    record('P1-NC-02', { runId, launches: { a: 1, b: 1 }, settlements: { a: 1, b: 1, c: 1 }, finalRunState: 'succeeded' });
  } finally {
    if (engineB) await engineB.stop().catch(() => engineB.kill());
    engineA.kill(); cleanup(scratch.root);
  }
});
