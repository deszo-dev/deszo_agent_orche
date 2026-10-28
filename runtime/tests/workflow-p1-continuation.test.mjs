// P1 durable workflow continuation. Real Engine runtimes, the real Rust Lifecycle Host (Process Custody) and the deterministic
// provider fixture run one published three-node workflow: A (writes a marker) -> B (a provider run) -> C (a deterministic
// verification that starts only after B is accepted). Assertions use the Engine's own journal and attempts, the fixture's launch
// record, the marker the workflow wrote in its workspace, and operating-system process state. Nothing is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  buildArtifacts, cleanup, committedChunks, database, eventually, exited, hostRecords, isAlive, newScratch, publishDefinition, readInvocations,
  registerWorkspace, startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
const record = (id, value) => { evidence.cases[id] = value; };
test.after(() => {
  mkdirSync(join(testsRoot, 'p1-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'p1-evidence', 'workflow-p1-continuation.json'), JSON.stringify(evidence, null, 2));
});

// A (writer) -> B (provider) -> C (verification). C reads the marker A wrote and is ordered after B by an After dependency.
function chainDefinition(workflowId, { bModel = 'custody-steady', bTicks = 24, bCode = null, cPaths = ['custody-writer.log'] } = {}) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1', 'loops-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request-a', type: 'text', config: { value: '[ticks=1] Write the marker.' } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'custody-writer', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'b-prompt', type: 'prompt-template', config: { template: `Previous step: {{prior}}\n[ticks=${bTicks}]${bCode === null ? '' : ` [code=${bCode}]`} Continue.`, slots: [{ id: 'prior' }] } },
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

// Read-only views of the durable store. Each call opens and closes its own connection.
function rows(root, sql, ...params) {
  const db = database(root);
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
function committedStreamBytes(root, attemptId, stream) {
  const db = database(root);
  try {
    const chunks = db.prepare(`SELECT a.relative_path FROM journal_events e
      JOIN artifacts a ON a.id = json_extract(e.envelope_json, '$.payload.chunk.artifactId')
      WHERE e.attempt_id = ? AND e.event_type = 'attempt.log_chunk' AND json_extract(e.envelope_json, '$.payload.stream') = ?
      ORDER BY json_extract(e.envelope_json, '$.payload.chunkIndex')`).all(attemptId, stream);
    return Buffer.concat(chunks.map(chunk => readFileSync(join(root, 'store', chunk.relative_path))));
  } finally { db.close(); }
}
const attemptsOf = (root, runId, node) => rows(root,
  'SELECT id, node_instance_id AS node, state, process_id AS pid, invocation_artifact_id AS invocation FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal',
  runId, node);
const runRow = (root, runId) => rows(root, 'SELECT id, state, published_version_id AS publishedVersionId, execution_hash AS executionHash FROM runs WHERE id = ?', runId)[0];
function journal(root, runId) {
  return rows(root, 'SELECT id, sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', runId).map(row => {
    const envelope = JSON.parse(row.envelope_json);
    return { id: row.id, sequence: row.sequence, type: row.event_type, node: envelope.nodeInstanceId, attemptId: envelope.attemptId, payload: envelope.payload };
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

async function stopAll(...engines) { for (const engine of engines) if (engine) { await engine.stop().catch(() => engine.kill()); } }

// P1-01: Engine A is replaced while Node B's provider runs. Engine B restores the Run, reattaches to B's invocation, settles it
// once and dispatches C after it. A is not run again.
test('P1-01: Engine A is replaced while Node B runs; Engine B resumes the same Run and runs C once after B is accepted', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-01');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId, publication } = await startRun(engineA, scratch, chainDefinition('p1-01'));
    const bBefore = await waitForRunningProvider(scratch.root, runId, 'b');
    const cliOsIdentity = bBefore.pid;
    engineA.kill();
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to exit before the Host-owned provider completes', 30_000, 100), true);
    await sleep(800);
    assert.equal(host.child.exitCode, null, 'the Host survives Engine A');
    assert.equal(isAlive(bBefore.pid), true, 'the Node B provider survives Engine A');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded', 'the original Run succeeds under Engine B');
    const [bAfter] = attemptsOf(scratch.root, runId, 'b');
    assert.equal(bAfter.id, bBefore.id, 'Node B keeps its Attempt identity');
    assert.equal(bAfter.pid, cliOsIdentity, 'Node B keeps its provider process');
    assert.equal(bAfter.state, 'succeeded');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'Node B has one provider launch');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'Node A has one provider launch');
    assert.equal(markerLines(scratch), 1, 'the marker A wrote exists once');
    assert.equal(settledCount(scratch.root, runId, 'a'), 1, 'Node A is accepted once');
    assert.equal(settledCount(scratch.root, runId, 'b'), 1, 'Node B is settled once');
    assert.equal(settledCount(scratch.root, runId, 'c'), 1, 'Node C runs once');
    const events = journal(scratch.root, runId);
    const bAccepted = events.find(event => event.node === 'b' && event.payload?.to === 'succeeded').sequence;
    const cAccepted = events.find(event => event.node === 'c' && event.payload?.to === 'succeeded').sequence;
    assert.ok(bAccepted < cAccepted, 'Node C is accepted only after Node B is accepted');
    assert.equal(runRow(scratch.root, runId).publishedVersionId, publication.publishedVersionId, 'the Run stays bound to its published version');
    record('P1-01/P1-E2E-SIM', { runId, publishedVersionId: publication.publishedVersionId, bAttempt: bAfter.id, bPid: bAfter.pid,
      launches: { a: launchesOf(scratch, 'custody-writer').length, b: launchesOf(scratch, 'custody-steady').length }, settlements: { a: 1, b: 1, c: 1 }, finalRunState: 'succeeded' });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-02: Engine A stops after Node A is accepted and before B is dispatched. Engine B dispatches B and C without rerunning A.
// Engine B then restarts again after success: repeated recovery of a terminal Run creates no attempt and launches nothing.
test('P1-02/P1-05/P1-11: a restart after A is accepted dispatches B then C; repeated recovery of the finished Run changes nothing', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-02');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_settle:a' } });
  let engineB = null, engineC = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-02', { bTicks: 2 }));
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to stop at the fault point', 120_000, 100), true);
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'scheduled', 'B was not dispatched before the replacement');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'A launched once, before the replacement');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'B launched once, after the replacement');
    assert.equal(settledCount(scratch.root, runId, 'a'), 1);
    assert.equal(settledCount(scratch.root, runId, 'b'), 1);
    assert.equal(settledCount(scratch.root, runId, 'c'), 1);
    const before = JSON.stringify(rows(scratch.root, 'SELECT id, node_instance_id, state FROM attempts WHERE run_id = ? ORDER BY rowid', runId));
    const eventsBefore = journal(scratch.root, runId).length;
    await engineB.stop();
    engineB = null;
    engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal((await engineC.api('GET', `/api/v2/runs/${runId}`)).body.run.state, 'succeeded', 'a finished Run is not reopened');
    assert.equal(JSON.stringify(rows(scratch.root, 'SELECT id, node_instance_id, state FROM attempts WHERE run_id = ? ORDER BY rowid', runId)), before, 'no attempt is created or changed');
    assert.equal(journal(scratch.root, runId).length, eventsBefore, 'no journal event is written for a finished Run');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'no provider launch after repeated recovery');
    record('P1-02/P1-05/P1-11', { runId, launches: { a: 1, b: 1 }, settlements: { a: 1, b: 1, c: 1 }, repeatedRecoveryChanges: 0 });
  } finally {
    await stopAll(engineC, engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-03: Engine A stops after Node B is accepted and before C is dispatched. Engine B runs C exactly once.
test('P1-03/CP-08: a restart after B is accepted and before C is dispatched runs C once and does not rerun B', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-03');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_settle:b' } });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-03', { bTicks: 2 }));
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to stop after B is accepted', 120_000, 100), true);
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'succeeded', 'B is accepted durably');
    assert.equal(settledCount(scratch.root, runId, 'c'), 0, 'C is not accepted yet');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'B is not launched again');
    assert.equal(settledCount(scratch.root, runId, 'b'), 1, 'B is accepted exactly once');
    assert.equal(settledCount(scratch.root, runId, 'c'), 1, 'C runs exactly once');
    record('P1-03/CP-08', { runId, launches: { a: 1, b: 1 }, settlements: { b: 1, c: 1 } });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-04 / P1-E2E-02: B's provider finishes while no Engine is attached. Engine B settles B from the Host's record and runs C.
test('P1-04/P1-E2E-02: Node B finishes while the Engine is absent; Engine B settles it once and runs C', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-04');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-04', { bModel: 'custody-stdio', bTicks: 6 }));
    const bBefore = await waitForRunningProvider(scratch.root, runId, 'b');
    const bCustodyId = rows(scratch.root, 'SELECT custody_id AS id FROM attempt_custody WHERE attempt_id = ?', bBefore.id)[0].id;
    engineA.kill();
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to exit before the Host-owned provider completes', 30_000, 100), true);
    await eventually(() => !isAlive(bBefore.pid), 'Node B to finish while no Engine is attached', 90_000, 200);
    await sleep(500);
    assert.equal(host.child.exitCode, null, 'the Host recorded the outcome');
    assert.ok(hostRecords(host).length >= 1, 'the Host holds the invocation record');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 180_000), 'succeeded');
    const bAfter = attemptsOf(scratch.root, runId, 'b')[0];
    assert.equal(bAfter.id, bBefore.id, 'B keeps its original Attempt identity');
    assert.equal(bAfter.pid, bBefore.pid, 'B keeps its provider process');
    assert.equal(launchesOf(scratch, 'custody-stdio').length, 1, 'no second launch of B');
    assert.equal(settledCount(scratch.root, runId, 'b'), 1, 'B is settled exactly once');
    assert.equal(settledCount(scratch.root, runId, 'c'), 1, 'C runs once, after B');
    const bHostRecords = hostRecords(host).filter(item => item.attemptId === bBefore.id);
    assert.equal(bHostRecords.length, 1, 'the Host retains exactly one record for B');
    const hostRecord = bHostRecords[0];
    assert.equal(hostRecord.state, 'exited');
    assert.equal(hostRecord.processId, bBefore.pid);
    assert.equal(hostRecord.drained, true, 'the Host proves the complete process tree ended');
    assert.equal(hostRecord.spoolComplete, true);
    assert.ok(hostRecord.stdoutDurable > 0 && hostRecord.stderrDurable > 0, 'the Host durably captured both streams');
    assert.equal(hostRecord.stdoutAcked, hostRecord.stdoutDurable, 'Engine B acknowledged every durable stdout byte');
    assert.equal(hostRecord.stderrAcked, hostRecord.stderrDurable, 'Engine B acknowledged every durable stderr byte');
    const stdoutSpool = readFileSync(join(host.state, 'custody', 'spool', bCustodyId, 'stdout.bin'));
    const stderrSpool = readFileSync(join(host.state, 'custody', 'spool', bCustodyId, 'stderr.bin'));
    assert.equal(stdoutSpool.length, hostRecord.stdoutDurable);
    assert.equal(stderrSpool.length, hostRecord.stderrDurable);
    assert.deepEqual(committedStreamBytes(scratch.root, bBefore.id, 'stdout'), stdoutSpool, 'Engine B replays exact durable stdout bytes');
    assert.deepEqual(committedStreamBytes(scratch.root, bBefore.id, 'stderr'), stderrSpool, 'Engine B replays exact durable stderr bytes');
    const closed = journal(scratch.root, runId).filter(event => event.type === 'attempt.log_stream_closed' && event.attemptId === bBefore.id);
    assert.deepEqual(closed.map(event => event.payload.stream).sort(), ['normalized', 'stderr', 'stdout']);
    assert.ok(closed.every(event => event.payload.integrity === 'complete'), 'both replayed streams close as complete');
    const hold = rows(scratch.root, 'SELECT state, evidence_json AS evidence FROM custody_workspace_holds WHERE custody_id = ?', bCustodyId)[0];
    assert.equal(hold.state, 'released');
    assert.equal(JSON.parse(hold.evidence).processTreeEnded, true, 'workspace release follows Host tree-completion proof');
    record('P1C-10/P1-04/P1-E2E-02', { runId, bAttemptId: bBefore.id, custodyId: bCustodyId, bPid: bBefore.pid,
      launches: { b: 1 }, settlements: { b: 1, c: 1 }, stdoutBytes: stdoutSpool.length, stderrBytes: stderrSpool.length,
      spoolComplete: hostRecord.spoolComplete, treeEnded: hostRecord.drained, hold: hold.state, finalRunState: 'succeeded' });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-09 / P1-19: B fails and the Run waits for the user. A replacement Engine keeps the Run waiting and operable; it never
// reinterprets the wait as success, and it does not relaunch the failed node.
test('P1-09/P1-19: a Run waiting for the user after a failure stays waiting through Engine replacement and remains operable', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-09');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-09', { bModel: 'custody-exit', bCode: 3 }));
    assert.equal(await waitForRunState(engineA, runId, ['waiting_for_user'], 120_000), 'waiting_for_user');
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'failed', 'B failed under the existing failure policy');
    engineA.kill();
    await sleep(500);
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await runState(engineB, runId), 'waiting_for_user', 'the wait survives the replacement');
    assert.equal(settledCount(scratch.root, runId, 'c'), 0, 'C does not run');
    assert.equal(launchesOf(scratch, 'custody-exit').length, 1, 'the failed node is not relaunched');
    const closed = await engineB.api('POST', `/api/v2/runs/${runId}/recovery`, { requestId: randomUUID(), action: 'close' });
    assert.equal(closed.status, 200, `the user can still decide: ${JSON.stringify(closed.body)}`);
    assert.equal(closed.body.state, 'failed');
    record('P1-09/P1-19', { runId, waitingAfterReplacement: true, launches: 1, decision: 'close', finalRunState: 'failed' });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

async function runState(engine, runId) { return (await engine.api('GET', `/api/v2/runs/${runId}`)).body?.run?.state ?? null; }

// P1-13: the Run's recorded definition no longer matches its snapshot. Recovery refuses to continue it, explicitly.
test('P1-13: a Run whose published definition is inconsistent is not continued; it is interrupted with an explicit reason', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-13');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-13'));
    const bBefore = await waitForRunningProvider(scratch.root, runId, 'b');
    engineA.kill();
    await sleep(500);
    const db = new DatabaseSync(join(scratch.root, 'store/state.sqlite'));
    try { db.prepare('UPDATE runs SET execution_hash = ? WHERE id = ?').run('0'.repeat(64), runId); } finally { db.close(); }
    const engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'interrupted');
      const reason = journal(scratch.root, runId).filter(event => event.type === 'run.state_changed' && event.payload?.to === 'interrupted').at(-1).payload.reason;
      assert.match(reason, /published workflow definition/, 'the refusal names the cause');
      const outcomes = await engineB.api('GET', `/api/v2/runs/${runId}/failure-outcomes/page?afterSequence=0&limit=10`);
      assert.equal(outcomes.status, 200);
      const runOutcomes = outcomes.body.items.filter(item => !item.outcome.attemptId);
      assert.equal(runOutcomes.length, 1, 'the Engine recovery refusal has a durable run-scoped outcome');
      assert.equal(runOutcomes[0].outcome.category, 'orchestrator_failure');
      assert.equal(runOutcomes[0].outcome.canonicalCode, 'corruption');
      assert.equal(runOutcomes[0].outcome.observedState.runState, 'interrupted');
      const runTransitionRef = runOutcomes[0].outcome.evidenceReferences.find(reference => reference.type === 'journal_event');
      assert.ok(runTransitionRef && journal(scratch.root, runId).some(event => event.id === runTransitionRef.id && event.type === 'run.state_changed'),
        'the run-scoped outcome resolves to the recovery refusal transition');
      assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'nothing is relaunched or substituted');
      record('P1-13', { runId, providerPid: bBefore.pid, finalRunState: 'interrupted', reason });
    } finally { await stopAll(engineB); }
  } finally {
    engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-13 (second case): the store itself refuses every state in which a Run's publication binding and its published digest disagree.
// Recovery's publication check is defense in depth behind these triggers, so the proof is that the tampering is refused.
test('P1-13b: the store refuses to change a published digest or to rebind a Run to another digest', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-13b');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, publication } = await startRun(engineA, scratch, chainDefinition('p1-13b'));
    await waitForRunningProvider(scratch.root, runId, 'b');
    engineA.kill();
    await sleep(500);
    const db = new DatabaseSync(join(scratch.root, 'store/state.sqlite'));
    try {
      assert.throws(() => db.prepare('UPDATE workflow_publications SET definition_digest = ? WHERE id = ?').run('0'.repeat(64), publication.publishedVersionId),
        /immutable/, 'a published version cannot change its digest');
      assert.throws(() => db.prepare('UPDATE runs SET definition_digest = ? WHERE id = ?').run('0'.repeat(64), runId),
        /immutable/, 'a Run cannot be rebound to another digest');
      assert.throws(() => db.prepare('UPDATE runs SET published_version_id = NULL WHERE id = ?').run(runId),
        /immutable/, 'a Run cannot be detached from its published version');
    } finally { db.close(); }
    record('P1-13b', { runId, refusedMutations: 3 });
  } finally {
    engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-14 / CP-03: Engine A stops after B's invocation is committed but before any provider launch. Recovery cannot know whether the
// launch happened, so it never launches B again; the Run is not continued into an unknown operation.
test('P1-14/CP-03: an invocation committed but never launched is not relaunched after a replacement', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-14');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_invocation_commit' } });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-14'));
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to stop after the invocation commit', 120_000, 100), true);
    const [a] = attemptsOf(scratch.root, runId, 'a');
    assert.ok(a.invocation, 'the invocation was committed');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'interrupted');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 0, 'A is never relaunched on an unknown launch outcome');
    assert.equal(markerLines(scratch), 0, 'no marker is written by a second launch');
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'canceled', 'B never started');
    record('P1-14/CP-03', { runId, launches: 0, finalRunState: 'interrupted' });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-17: Engine A stops after the last node is accepted and before the Run is finalized. Engine B finalizes the Run without
// rerunning any node.
test('P1-17/CP-09: a crash after the final node and before Run settlement is finalized once without rerunning nodes', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-17');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'before_run_settle' } });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-17', { bTicks: 2 }));
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to stop before Run settlement', 120_000, 100), true);
    assert.equal(runRow(scratch.root, runId).state, 'running', 'the Run is not yet settled');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'succeeded');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'no node reran');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'no node reran');
    assert.equal(settledCount(scratch.root, runId, 'c'), 1);
    record('P1-17/CP-09', { runId, launches: { a: 1, b: 1 }, settlements: { c: 1 }, finalRunState: 'succeeded' });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

// P1-10: a Stop is pending while B runs; the replacement Engine keeps the Stop's meaning, launches nothing, and never reaches C.
test('P1-10: a pending Stop survives Engine replacement; nothing is launched and C never runs', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1-10');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId } = await startRun(engineA, scratch, chainDefinition('p1-10'));
    const bRunning = await waitForRunningProvider(scratch.root, runId, 'b');
    const stopped = await engineA.api('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.ok(stopped.status === 200 || stopped.status === 202, `the Stop is accepted: ${JSON.stringify(stopped.body)}`);
    engineA.kill();
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineB, runId, SETTLED, 180_000);
    assert.ok(['canceled', 'interrupted'].includes(final), `the Stop ends the Run without completing it (state ${final})`);
    assert.equal(await eventually(() => !isAlive(bRunning.pid), 'the recovered Root Stop to end its targeted provider process', 30_000, 100), true,
      'the provider process the Stop targeted has ended');
    assert.equal(settledCount(scratch.root, runId, 'c'), 0, 'C is never accepted');
    assert.equal(launchesOf(scratch, 'custody-steady').length, 1, 'no second launch of B');
    record('P1-10', { runId, finalRunState: final, launches: { b: 1 } });
  } finally {
    await stopAll(engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});
