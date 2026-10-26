// P1.5 process-lifecycle coverage. The tests use real Engine processes, the Rust Process Custody Host, and its deterministic provider fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256 } from '../core/canonical.mjs';
import { assertValid } from '../core/schemas.mjs';
import {
  buildArtifacts, cleanup, database, eventually, exited, hostRecords, isAlive, newScratch, publishDefinition, readInvocations,
  registerWorkspace, sha256File, startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';
import { startTestRunner } from './helpers.mjs';

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const v1JournalSchema = JSON.parse(readFileSync(join(import.meta.dirname, '../../docs/schemas/journal-event.schema.json'), 'utf8'));
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
const record = (id, value) => { evidence.cases[id] = value; };
test.after(() => {
  mkdirSync(join(testsRoot, 'p1.5-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'p1.5-evidence', 'workflow-p1-coverage-closure.json'), JSON.stringify(evidence, null, 2));
});

function rows(root, sql, ...params) {
  const db = database(root);
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
const attemptsOf = (root, runId, node = null) => rows(root,
  `SELECT id, node_instance_id AS node, state, process_id AS pid, invocation_artifact_id AS invocation, outputs_artifact_id AS outputs
    FROM attempts WHERE run_id = ? ${node === null ? '' : 'AND node_instance_id = ?'} ORDER BY rowid`, runId, ...(node === null ? [] : [node]));
const runRow = (root, runId) => rows(root, 'SELECT id, state, journal_version AS journalVersion, published_version_id AS publishedVersionId FROM runs WHERE id = ?', runId)[0];
const settledCount = (root, runId, node) => rows(root,
  `SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'attempt.state_changed'
    AND json_extract(envelope_json, '$.nodeInstanceId') = ? AND json_extract(envelope_json, '$.payload.to') = 'succeeded'`, runId, node)[0].n;
const launchesOf = (scratch, model) => readInvocations(scratch.fixtureState).filter(launch => launch.model === model);
function fixtureTurns(stateDir) {
  if (!existsSync(stateDir)) return 0;
  return readdirSync(stateDir).filter(name => name.endsWith('.log')).reduce((total, name) =>
    total + (readFileSync(join(stateDir, name), 'utf8').split('\n␞\n').length - 1), 0);
}
function journal(root, runId) {
  return rows(root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', runId).map(row => {
    const envelope = JSON.parse(row.envelope_json);
    return { sequence: row.sequence, type: row.event_type, node: envelope.nodeInstanceId, attemptId: envelope.attemptId, payload: envelope.payload };
  });
}
function rewriteJournalAsV1(root, runId) {
  const branches = new Map(v1JournalSchema.oneOf.map(branch => [branch.properties.type.const, branch]));
  const db = new DatabaseSync(join(root, 'store/state.sqlite'));
  try {
    const source = db.prepare('SELECT * FROM journal_events WHERE run_id = ? ORDER BY sequence').all(runId).map(row => ({ ...row }));
    const retained = [];
    const droppedTypes = new Set();
    for (const row of source) {
      const envelope = JSON.parse(row.envelope_json);
      const branch = branches.get(envelope.type);
      if (!branch) { droppedTypes.add(envelope.type); continue; }
      envelope.schemaVersion = 1;
      envelope.sequence = retained.length + 1;
      const payloadKeys = new Set(Object.keys(branch.properties.payload.properties || {}));
      envelope.payload = Object.fromEntries(Object.entries(envelope.payload).filter(([key]) => payloadKeys.has(key)));
      const v1 = Object.fromEntries(['schemaVersion', 'id', 'runId', 'sequence', 'timestamp', 'nodeInstanceId', 'attemptId', 'type', 'payload']
        .map(key => [key, envelope[key]]));
      assertValid('journal-event.schema.json', null, v1, `Converted v1 journal event ${v1.type}`);
      const json = canonicalize(v1);
      retained.push({ oldSequence: row.sequence, envelope: v1, json, hash: sha256(Buffer.from(json, 'utf8')),
        byteSize: Buffer.byteLength(json, 'utf8') });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE journal_events SET sequence = sequence + 1000000 WHERE run_id = ?').run(runId);
      const remove = db.prepare('DELETE FROM journal_events WHERE run_id = ? AND sequence = ?');
      const update = db.prepare(`UPDATE journal_events SET sequence = ?, event_type = ?, node_instance_id = ?, attempt_id = ?,
        envelope_json = ?, envelope_sha256 = ?, envelope_byte_size = ?, timestamp = ? WHERE run_id = ? AND sequence = ?`);
      const keptSequences = new Set(retained.map(row => row.oldSequence));
      for (const row of source) {
        const shiftedSequence = row.sequence + 1_000_000;
        if (!keptSequences.has(row.sequence)) { remove.run(runId, shiftedSequence); continue; }
        const item = retained.find(candidate => candidate.oldSequence === row.sequence);
        update.run(item.envelope.sequence, item.envelope.type, item.envelope.nodeInstanceId, item.envelope.attemptId,
          item.json, item.hash, item.byteSize, item.envelope.timestamp, runId, shiftedSequence);
      }
      db.prepare('UPDATE runs SET journal_version = 1, last_sequence = ? WHERE id = ?').run(retained.length, runId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { retainedCount: retained.length, droppedTypes: [...droppedTypes].sort() };
  } finally { db.close(); }
}
function assertV1Journal(root, runId) {
  const records = rows(root, 'SELECT sequence, event_type, envelope_json, envelope_sha256, envelope_byte_size FROM journal_events WHERE run_id = ? ORDER BY sequence', runId);
  for (const [index, row] of records.entries()) {
    const envelope = JSON.parse(row.envelope_json);
    assertValid('journal-event.schema.json', null, envelope, `Persisted v1 journal event ${envelope.type}`);
    assert.equal(envelope.sequence, index + 1, 'the persisted v1 journal has contiguous sequence numbers');
    assert.equal(row.sequence, envelope.sequence);
    assert.equal(row.event_type, envelope.type);
    const canonical = canonicalize(envelope);
    assert.equal(row.envelope_json, canonical, 'the persisted envelope uses canonical JSON');
    assert.equal(row.envelope_sha256, sha256(Buffer.from(canonical, 'utf8')));
    assert.equal(row.envelope_byte_size, Buffer.byteLength(canonical, 'utf8'));
  }
  return records.length;
}
const textLines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0;
async function stopAll(...engines) { for (const engine of engines) if (engine) await engine.stop().catch(() => engine.kill()); }

function acceptedSideEffectWorkflow(workflowId, gate) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request-a', type: 'text', config: { value: '[ticks=1] Record one external execution.' } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'custody-writer', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'b-prompt', type: 'prompt-template', config: { template: `Prior accepted result: {{prior}}\n[gate=${gate}] Wait for Engine recovery, then continue.`, slots: [{ id: 'prior' }] } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: 'custody-gated', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'c-prompt', type: 'prompt-template', config: { template: 'Verify the accepted B result: {{prior}}', slots: [{ id: 'prior' }] } },
      { id: 'c', type: 'agent', config: { provider: 'codex', model: 'custody-verify', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'request-a', source: { nodeId: 'request-a', port: 'text' }, target: { nodeId: 'a', port: 'prompt' } },
      { id: 'a-b-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'b-prompt', port: 'prior' } },
      { id: 'b-prompt-b', source: { nodeId: 'b-prompt', port: 'text' }, target: { nodeId: 'b', port: 'prompt' } },
      { id: 'b-c-prompt', source: { nodeId: 'b', port: 'text' }, target: { nodeId: 'c-prompt', port: 'prior' } },
      { id: 'c-prompt-c', source: { nodeId: 'c-prompt', port: 'text' }, target: { nodeId: 'c', port: 'prompt' } },
      { id: 'c-result', source: { nodeId: 'c', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    ],
    after: [],
  };
}

function restartChain(workflowId) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request-a', type: 'text', config: { value: '[ticks=1] Write the durable marker.' } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'custody-writer', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'b-prompt', type: 'prompt-template', config: { template: '{{prior}}\n[ticks=1]', slots: [{ id: 'prior' }] } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: 'custody-steady', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'request-a', source: { nodeId: 'request-a', port: 'text' }, target: { nodeId: 'a', port: 'prompt' } },
      { id: 'a-b-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'b-prompt', port: 'prior' } },
      { id: 'b-prompt-b', source: { nodeId: 'b-prompt', port: 'text' }, target: { nodeId: 'b', port: 'prompt' } },
      { id: 'b-result', source: { nodeId: 'b', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    ],
    after: [],
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

test('P1C-05: persisted journal-v1 state keeps accepted history and is not silently continued', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1c-05-journal-v1');
  const engineA = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState,
    extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'after_settle:a' } });
  let engineB = null;
  try {
    const { runId, publication } = await startRun(engineA, scratch, restartChain('p1c-05-journal-v1'));
    assert.equal(await eventually(() => exited(engineA.child) && runRow(scratch.root, runId)?.state === 'running',
      'Engine A to stop after A is durably accepted', 120_000, 100), true);
    const beforeA = attemptsOf(scratch.root, runId, 'a')[0];
    const beforeB = attemptsOf(scratch.root, runId, 'b')[0];
    const originalJournal = journal(scratch.root, runId);
    const marker = join(scratch.workspace, 'custody-writer.log');
    assert.equal(beforeA.state, 'succeeded');
    assert.ok(beforeA.outputs, 'A output is durably referenced');
    assert.equal(beforeB.state, 'scheduled');
    assert.equal(textLines(marker), 1, 'A wrote its external side effect once before the crash');
    assert.ok(!originalJournal.some(event => event.type === 'continuation.reconciled'));

    // Rebase the pre-continuation history to the actual v1 envelope contract, including its event vocabulary and canonical hashes.
    const conversion = rewriteJournalAsV1(scratch.root, runId);
    const oldJournal = journal(scratch.root, runId);
    assert.equal(oldJournal.length, conversion.retainedCount);
    assert.ok(oldJournal.length > 0, 'the converted v1 journal retains accepted history');
    assert.equal(assertV1Journal(scratch.root, runId), oldJournal.length);
    assert.equal(runRow(scratch.root, runId).journalVersion, 1);
    engineB = await startEngine(scratch.root, null, { custody: false, fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'interrupted');
    assert.equal(runRow(scratch.root, runId).publishedVersionId, publication.publishedVersionId, 'the publication binding is unchanged');
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].id, beforeA.id);
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].outputs, beforeA.outputs);
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].state, 'succeeded');
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].id, beforeB.id);
    assert.equal(attemptsOf(scratch.root, runId, 'b')[0].state, 'canceled');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1);
    assert.equal(launchesOf(scratch, 'custody-steady').length, 0, 'no provider launch comes from unsupported v1 state');
    assert.equal(textLines(marker), 1, 'the accepted side effect does not repeat');
    const afterJournal = journal(scratch.root, runId);
    assert.deepEqual(afterJournal.slice(0, oldJournal.length), oldJournal, 'historical journal records remain byte-for-byte equivalent at the envelope level');
    assert.equal(afterJournal.filter(event => event.type === 'continuation.reconciled').length, 0);
    assert.equal(assertV1Journal(scratch.root, runId), afterJournal.length, 'Engine B appends schema-valid v1 events for the safe stop');
    record('P1C-05', { runId, publishedVersionId: publication.publishedVersionId, journalVersion: 1, acceptedAttemptId: beforeA.id,
      dependentAttemptId: beforeB.id, sideEffectLines: 1, finalRunState: 'interrupted', historicalEventsPreserved: oldJournal.length,
      v2EventsDropped: conversion.droppedTypes });
  } finally { await stopAll(engineB); engineA.kill(); cleanup(scratch.root); }
});

function drainingDefinition(workflowId) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'a', type: 'text', config: { value: 'A accepted before B fails.' } },
      { id: 'fail-prompt', type: 'prompt-template', config: { template: '{{prior}} Fail after A is accepted.', slots: [{ id: 'prior' }] } },
      { id: 'fail', type: 'agent', config: { provider: 'codex', model: 'fixture-fail-after-5', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'c-prompt', type: 'prompt-template', config: { template: 'Continue only after an accepted B result: {{prior}}', slots: [{ id: 'prior' }] } },
      { id: 'c', type: 'agent', config: { provider: 'codex', model: 'fixture-never-dispatch', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'fail-result', type: 'result-viewer', config: {} },
      { id: 'result', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'a-fail-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'fail-prompt', port: 'prior' } },
      { id: 'fail-prompt-fail', source: { nodeId: 'fail-prompt', port: 'text' }, target: { nodeId: 'fail', port: 'prompt' } },
      { id: 'a-c-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'c-prompt', port: 'prior' } },
      { id: 'c-prompt-c', source: { nodeId: 'c-prompt', port: 'text' }, target: { nodeId: 'c', port: 'prompt' } },
      { id: 'fail-result', source: { nodeId: 'fail', port: 'text' }, target: { nodeId: 'fail-result', port: 'value' } },
      { id: 'c-result', source: { nodeId: 'c', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    ],
    after: [],
  };
}

test('P1C-06: a real draining Run with lock-waiting C stays blocked after restart', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1c-06-draining');
  const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: process.execPath, sha256: sha256File(process.execPath) }] });
  const custodyHost = { context: { generation: host.generation }, custody: (command, payload) => host.request(command, payload) };
  let first = null, second = null;
  try {
    first = await startTestRunner({ root: scratch.root, runner: { custodyHost } });
    const engineA = first.runner.engine;
    await first.workspace();
    const workflow = drainingDefinition('p1c-06-draining');
    const saved = await first.save(workflow);
    const publication = first.publication(workflow.workflowId);
    const started = await first.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    const failBefore = await eventually(() => {
      const attempt = attemptsOf(scratch.root, runId, 'fail')[0];
      return attempt?.state === 'running' && attempt.pid && isAlive(attempt.pid) ? attempt : null;
    }, 'the Host-owned failing invocation to be live before it exits', 90_000, 100);
    const aBefore = attemptsOf(scratch.root, runId, 'a')[0];
    assert.equal(aBefore.state, 'succeeded', 'A is durably accepted before B fails');
    assert.ok(aBefore.outputs, 'A has a committed output artifact before B fails');
    const cBefore = await eventually(() => {
      const fail = attemptsOf(scratch.root, runId, 'fail')[0];
      const c = attemptsOf(scratch.root, runId, 'c')[0];
      return fail?.state === 'running' && fail.pid && isAlive(fail.pid) && c?.state === 'waiting' ? c : null;
    }, 'C to become input-ready but wait behind B’s workspace lock', 30_000, 50);
    const turnsWhileCWaits = fixtureTurns(scratch.fixtureState);
    assert.equal(turnsWhileCWaits, 1, 'only the failing Custody invocation has reached the fixture');
    const originalFinish = engineA.finishRunIfDone.bind(engineA);
    // Hold only the scheduler's final draining transition. The real failing Attempt already journaled running -> draining;
    // this seam keeps that persisted state available for a fresh Engine without fabricating a Run state.
    engineA.finishRunIfDone = function finishRunIfDoneWhileDraining(state) {
      if (this.runState(state.id) === 'draining') { this.p1cHeldDrainingRun = state.id; return; }
      return originalFinish(state);
    };
    assert.equal(await eventually(() => runRow(scratch.root, runId)?.state === 'draining'
      && attemptsOf(scratch.root, runId, 'fail')[0]?.state === 'failed' && engineA.p1cHeldDrainingRun === runId,
      'the real failure transition to draining to persist while C waits', 30_000, 50), true);
    const failureJournal = journal(scratch.root, runId);
    const drainingEvent = failureJournal.find(event => event.type === 'run.state_changed' && event.payload.to === 'draining');
    const failAfter = attemptsOf(scratch.root, runId, 'fail')[0];
    assert.equal(failAfter.id, failBefore.id);
    assert.equal(failAfter.state, 'failed');
    assert.equal(drainingEvent.payload.from, 'running');
    assert.equal(runRow(scratch.root, runId).state, 'draining');
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].id, cBefore.id);
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].state, 'waiting', 'C was ready but blocked by B’s workspace lock before the failure');
    assert.equal(fixtureTurns(scratch.fixtureState), turnsWhileCWaits, 'the draining scheduler does not dispatch C');
    const failHostRecord = hostRecords(host).filter(item => item.attemptId === failBefore.id);
    assert.equal(failHostRecord.length, 1);
    assert.equal(failHostRecord[0].processId, failBefore.pid);
    assert.equal(failHostRecord[0].drained, true, 'the failed Host-owned process tree has a durable completion proof');
    const failCustodyId = rows(scratch.root, 'SELECT custody_id AS id FROM attempt_custody WHERE attempt_id = ?', failBefore.id)[0].id;
    const failHold = rows(scratch.root, 'SELECT state, evidence_json AS evidence FROM custody_workspace_holds WHERE custody_id = ?', failCustodyId)[0];
    assert.equal(failHold.state, 'released');
    assert.equal(JSON.parse(failHold.evidence).processTreeEnded, true);
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].outputs, aBefore.outputs, 'A’s accepted output remains unchanged through draining');
    const turnsBeforeRestart = fixtureTurns(first.stateDir);
    await first.close();
    assert.equal(runRow(scratch.root, runId).state, 'draining', 'Engine A closes before its real draining state is finalized');
    second = await startTestRunner({ root: scratch.root, runner: { custodyHost } });
    const engineB = second.runner.engine;
    assert.equal(runRow(scratch.root, runId).state, 'waiting_for_user', 'the fresh Engine applies the existing draining-to-waiting recovery rule');
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].id, aBefore.id, 'the accepted A attempt survives recovery');
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].state, 'succeeded');
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].outputs, aBefore.outputs);
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].id, cBefore.id);
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].state, 'waiting', 'C stays blocked after the draining recovery');
    assert.equal(fixtureTurns(second.stateDir), turnsBeforeRestart, 'restart launches no provider for C');
    assert.equal(journal(scratch.root, runId).filter(event => event.type === 'run.state_changed' && event.payload.to === 'draining').length, 1);
    record('P1C-06', { runId, engineA: engineA.runtimeInstanceId, engineB: engineB.runtimeInstanceId, hostPid: host.pid, acceptedAttemptId: aBefore.id,
      failedAttemptId: failBefore.id, failedProcessId: failBefore.pid, drainingEventSequence: drainingEvent.sequence,
      cAttemptId: cBefore.id, cWaitingBehindLockBeforeFailure: true, acceptedOutputArtifactId: aBefore.outputs, downstreamDispatches: 0,
      processTreeEnded: failHostRecord[0].drained, workspaceHold: failHold.state, finalRunState: 'waiting_for_user' });
  } finally { if (second) await second.close(); else if (first) await first.close(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root); }
});

test('P1C-08/P1C-11: accepted side effects survive A-to-B-to-C recovery without repeated attempts or settlements', { timeout: 360_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p1c-08-repeated');
  const gate = randomUUID().replaceAll('-', '');
  const workflowId = `p1c-side-effect-${gate.slice(0, 10)}`;
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null, engineC = null;
  try {
    const { runId, publication } = await startRun(engineA, scratch, acceptedSideEffectWorkflow(workflowId, gate));
    const ready = join(scratch.workspace, `READY-${gate}.marker`);
    const bBefore = await eventually(() => {
      const attempt = attemptsOf(scratch.root, runId, 'b')[0];
      return existsSync(ready) && attempt?.state === 'running' && attempt.pid && isAlive(attempt.pid) ? attempt : null;
    }, 'Node B READY after Node A committed its side effect', 120_000, 100);
    const aBefore = attemptsOf(scratch.root, runId, 'a')[0];
    assert.equal(aBefore.state, 'succeeded');
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].state, 'scheduled');
    assert.equal(textLines(join(scratch.workspace, 'custody-writer.log')), 1, 'A has one independently observable side effect before recovery');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'A was invoked once before recovery');

    engineA.kill();
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to exit while B is held READY', 30_000, 100), true);
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const bAfter = attemptsOf(scratch.root, runId, 'b')[0];
    assert.equal(bAfter.id, bBefore.id);
    assert.equal(bAfter.pid, bBefore.pid);
    assert.equal(isAlive(bAfter.pid), true);
    assert.equal(launchesOf(scratch, 'custody-gated').length, 1);
    assert.equal(textLines(join(scratch.workspace, 'custody-writer.log')), 1, 'A is not redispatched by Engine B');
    assert.equal(attemptsOf(scratch.root, runId, 'a')[0].id, aBefore.id);

    // A second real Engine replacement exercises another Host reattachment while the same invocation stays behind READY.
    engineB.kill();
    assert.equal(await eventually(() => exited(engineB.child), 'Engine B to exit while the original Custody process is still held', 30_000, 100), true);
    engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const bAfterSecondRecovery = attemptsOf(scratch.root, runId, 'b')[0];
    assert.equal(bAfterSecondRecovery.id, bBefore.id, 'Run and Attempt identities survive both replacements');
    assert.equal(bAfterSecondRecovery.pid, bBefore.pid, 'Engine C reattaches to the original Host-owned process');
    assert.equal(isAlive(bAfterSecondRecovery.pid), true);
    assert.equal(launchesOf(scratch, 'custody-gated').length, 1, 'repeated recovery produces one provider launch');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1, 'the accepted side-effect adapter is never reinvoked');
    assert.equal(textLines(join(scratch.workspace, 'custody-writer.log')), 1);
    assert.equal(attemptsOf(scratch.root, runId, 'c')[0].state, 'scheduled', 'C cannot run before B settles');
    assert.equal(launchesOf(scratch, 'custody-verify').length, 0);

    writeFileSync(join(scratch.workspace, `RELEASE-${gate}.marker`), 'release\n');
    assert.equal(await waitForRunState(engineC, runId, SETTLED, 180_000), 'succeeded');
    const aFinal = attemptsOf(scratch.root, runId, 'a');
    const bFinal = attemptsOf(scratch.root, runId, 'b');
    const cFinal = attemptsOf(scratch.root, runId, 'c');
    assert.equal(runRow(scratch.root, runId).id, runId, 'the original Run ID is retained');
    assert.equal(runRow(scratch.root, runId).publishedVersionId, publication.publishedVersionId, 'published v1 is retained');
    assert.equal(runRow(scratch.root, runId).state, 'succeeded');
    assert.equal(aFinal.length, 1); assert.equal(aFinal[0].id, aBefore.id); assert.equal(aFinal[0].state, 'succeeded');
    assert.equal(bFinal.length, 1); assert.equal(bFinal[0].id, bBefore.id); assert.equal(bFinal[0].pid, bBefore.pid); assert.equal(bFinal[0].state, 'succeeded');
    assert.equal(cFinal.length, 1); assert.equal(cFinal[0].state, 'succeeded');
    assert.equal(launchesOf(scratch, 'custody-writer').length, 1);
    assert.equal(launchesOf(scratch, 'custody-gated').length, 1);
    assert.equal(launchesOf(scratch, 'custody-verify').length, 1);
    assert.equal(textLines(join(scratch.workspace, 'custody-writer.log')), 1, 'the external side-effect counter is exactly one');
    assert.equal(textLines(join(scratch.workspace, 'custody-node-c.log')), 1, 'Node C records exactly one execution');
    assert.equal(settledCount(scratch.root, runId, 'a'), 1);
    assert.equal(settledCount(scratch.root, runId, 'b'), 1);
    assert.equal(settledCount(scratch.root, runId, 'c'), 1);
    const events = journal(scratch.root, runId);
    const bSuccess = events.find(event => event.type === 'attempt.state_changed' && event.attemptId === bBefore.id && event.payload.to === 'succeeded');
    const cStart = events.find(event => event.type === 'attempt.state_changed' && event.node === 'c' && event.payload.to === 'running');
    assert.ok(bSuccess && cStart && cStart.sequence > bSuccess.sequence, 'C starts only after B is accepted');
    assert.equal(rows(scratch.root, 'SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?', workflowId)[0].n, 1, 'recovery creates no new Run');
    assert.equal(launchesOf(scratch, 'custody-gated').length, 1, 'there was no manual continuation or duplicate dispatch');

    const bCustodyId = rows(scratch.root, 'SELECT custody_id AS id FROM attempt_custody WHERE attempt_id = ?', bBefore.id)[0].id;
    const bHostRecords = hostRecords(host).filter(item => item.attemptId === bBefore.id);
    assert.equal(bHostRecords.length, 1, 'the Host owns one durable record for the original B invocation');
    assert.equal(bHostRecords[0].custodyId, bCustodyId);
    assert.equal(bHostRecords[0].processId, bBefore.pid);
    assert.equal(bHostRecords[0].drained, true, 'the Host recorded proven process-tree completion');
    assert.equal(bHostRecords[0].spoolComplete, true);
    const hold = rows(scratch.root, 'SELECT state, evidence_json AS evidence FROM custody_workspace_holds WHERE custody_id = ?', bCustodyId)[0];
    assert.equal(hold.state, 'released');
    assert.equal(JSON.parse(hold.evidence).processTreeEnded, true);
    record('P1C-08/P1C-11', { runId, publishedVersionId: publication.publishedVersionId, engineA: engineA.pid, engineB: engineB.pid,
      engineC: engineC.pid, hostPid: host.pid, sideEffectNode: 'a', sideEffectAttemptId: aBefore.id, sideEffectCounter: 1,
      custodyAttemptId: bBefore.id, custodyId: bCustodyId, providerLaunches: { a: 1, b: 1, c: 1 }, settlements: { a: 1, b: 1, c: 1 },
      recoveryPasses: 2, downstreamCStartedAfterB: true, treeProof: bHostRecords[0].drained, hold: hold.state, finalRunState: 'succeeded' });
  } finally { await stopAll(engineC, engineB); engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root); }
});
