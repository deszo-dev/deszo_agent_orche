// Process Custody replay audit (SP-02 to SP-07). An Engine is ended at a named point of the output path; a second Engine must
// finish the same Run from durable state, with contiguous output, one launch and one settlement. A Host ended during a spool
// write must leave a valid durable prefix and an honest, incomplete tail. All processes are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attachEngine, attemptsOf, buildArtifacts, cleanup, committedChunks, custodyBindings, database, eventually, exited, hostRecords, newScratch,
  readInvocations, runEventTypes, startAgentRun, startCustodyHost, startEngine, testsRoot, waitForRunState, custodyRequest,
} from './custody-support.mjs';
import { writeFileSync } from 'node:fs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-replay.json'), JSON.stringify(evidence, null, 2));
});

const FAULT_EXIT = 97;

function contiguous(chunks) {
  let expected = 0;
  for (const chunk of chunks) {
    if (chunk.byteOffset !== expected) return { ok: false, at: chunk.chunkIndex, expected, found: chunk.byteOffset };
    expected = chunk.byteOffset + chunk.byteLength;
  }
  return { ok: true, bytes: expected };
}

// Ends the first Engine at one named point, then finishes the Run with a second Engine that has no fault.
async function crashThenFinish(point, label, { ticks = 12 } = {}) {
  const scratch = newScratch(`sp-${label}`);
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: point } });
  let engineB = null;
  try {
    const { runId } = await startAgentRun(engineA, { workflowId: `custody-${label}`, model: 'custody-steady', requestText: `[ticks=${ticks}]`, workspaceCwd: scratch.workspace });
    await eventually(() => engineA.child.exitCode === FAULT_EXIT, `the Engine to end at ${point}`, 90_000, 50);
    const bindingBeforeRestart = custodyBindings(scratch.root, runId);
    const committedAtCrash = bindingBeforeRestart.length
      ? committedChunks(scratch.root, attemptsOf(scratch.root, runId).find(row => row.process_id).id, 'stdout').reduce((sum, chunk) => sum + chunk.byteLength, 0)
      : 0;
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineB, runId, SETTLED, 120_000);
    const attempt = attemptsOf(scratch.root, runId).find(row => row.process_id);
    const chunks = committedChunks(scratch.root, attempt.id, 'stdout');
    const span = contiguous(chunks);
    const settlements = runEventTypes(scratch.root, runId).filter(event => event.attemptId === attempt.id && event.type === 'attempt.outputs_committed');
    const record = hostRecords(host).find(item => item.runId === runId);
    return { scratch, host, runId, final, attempt, chunks, span, settlements, record, committedAtCrash, launches: readInvocations(scratch.fixtureState).length };
  } finally {
    engineA.kill(); if (engineB) await engineB.stop(); host.crash(); cleanup(scratch.root);
  }
}

// SP-02: output delivered to the Engine but not committed when it ends. The bytes are read again and applied once.
test('SP-02: delivered but uncommitted output is replayed and applied exactly once', async () => {
  buildArtifacts();
  const result = await crashThenFinish('after_deliver', 'sp02');
  assert.equal(result.final, 'succeeded', 'the Run completes after the replay');
  assert.equal(result.span.ok, true, `contiguous committed output: ${JSON.stringify(result.span)}`);
  assert.equal(result.span.bytes, result.record.stdoutDurable, 'every spooled byte was applied once');
  assert.equal(result.launches, 1, 'one launch');
  assert.equal(result.settlements.length, 1, 'one settlement');
  evidence.cases['SP-02'] = { crashPoint: 'delivered, not committed', committedAtCrash: result.committedAtCrash, committedBytes: result.span.bytes,
    spoolDurableBytes: result.record.stdoutDurable, launches: result.launches, settlements: result.settlements.length, runState: result.final };
});

// SP-03: effect committed, acknowledgement not yet sent. Replay starts from the committed cursor: no duplicate effect.
test('SP-03: committed output whose acknowledgement was lost is not applied again', async () => {
  buildArtifacts();
  const result = await crashThenFinish('after_commit', 'sp03');
  assert.equal(result.final, 'succeeded');
  assert.equal(result.span.ok, true, `no duplicate or missing chunk: ${JSON.stringify(result.span)}`);
  assert.equal(result.span.bytes, result.record.stdoutDurable);
  assert.equal(result.launches, 1);
  assert.equal(result.settlements.length, 1);
  evidence.cases['SP-03'] = { crashPoint: 'committed, acknowledgement not sent', committedAtCrash: result.committedAtCrash, committedBytes: result.span.bytes,
    spoolDurableBytes: result.record.stdoutDurable, chunks: result.chunks.length, launches: result.launches, settlements: result.settlements.length };
});

// SP-04: acknowledgement recorded, then the Engine is gone. Nothing committed is missing after the replay.
test('SP-04: an acknowledged prefix is never missing after the Engine reconnects', async () => {
  buildArtifacts();
  const result = await crashThenFinish('after_ack', 'sp04');
  assert.equal(result.final, 'succeeded');
  assert.equal(result.span.ok, true);
  assert.equal(result.span.bytes, result.record.stdoutDurable);
  assert.ok(result.record.stdoutAcked > 0, 'the Host recorded an acknowledgement before the crash');
  assert.ok(result.record.stdoutAcked <= result.span.bytes, 'no acknowledgement is beyond the applied output');
  assert.equal(result.launches, 1);
  evidence.cases['SP-04'] = { crashPoint: 'acknowledged, Engine gone', hostAcknowledgedBytes: result.record.stdoutAcked, committedBytes: result.span.bytes,
    launches: result.launches, settlements: result.settlements.length };
});

// SP-06: the attempt's terminal outcome is applied, then the Engine ends before anything else. The outcome is not applied twice.
test('SP-06: a terminal outcome applied before the Engine ends is not applied again', async () => {
  buildArtifacts();
  const result = await crashThenFinish('after_settle', 'sp06', { ticks: 4 });
  // The attempt's outcome is settled once and is never repeated. Its outcome was accepted before the Engine ended, and every other node of
  // the Run is deterministic, so the replacement Engine finishes the Run from its durable state (P1 continuation) without rerunning it.
  assert.equal(result.final, 'succeeded', 'the accepted outcome is not repeated, and the Run finishes from its durable state');
  assert.equal(result.settlements.length, 1, 'the attempt settled exactly once');
  assert.equal(result.launches, 1, 'the CLI was not launched again after its outcome was applied');
  assert.equal(result.span.ok, true);
  evidence.cases['SP-06'] = { crashPoint: 'terminal applied, Engine ended', settlements: result.settlements.length, launches: result.launches, runState: result.final };
});

// SP-07: the Host ends while a spool write is in flight. The durable prefix stays valid; the unknown tail is reported as such.
test('SP-07: a Host that dies during a spool write leaves a valid durable prefix and reports the tail honestly', async () => {
  buildArtifacts();
  const scratch = newScratch('sp07');
  const crashing = await startCustodyHost(scratch.root, { testCrashAfterSpoolBytes: 60 });
  const engine = await startEngine(scratch.root, crashing, { fixtureStateDir: scratch.fixtureState });
  let replacement = null, engineB = null;
  try {
    const { runId } = await startAgentRun(engine, { workflowId: 'custody-sp07', model: 'custody-steady', requestText: '[ticks=12]', workspaceCwd: scratch.workspace });
    await eventually(() => exited(crashing.child), 'the Host to end during the spool write', 90_000, 50);
    engine.kill();
    const custodyId = custodyBindings(scratch.root, runId)[0].custody_id;
    const spoolPath = join(crashing.state, 'custody', 'spool', custodyId, 'stdout.bin');
    const spoolBytes = readFileSync(spoolPath);
    replacement = await startCustodyHost(scratch.root);
    const record = hostRecords(replacement).find(item => item.custodyId === custodyId);
    assert.equal(record.state, 'host_lost', 'the replacement records the interrupted invocation as lost');
    assert.equal(record.tailGapPossible, true, 'the unknown tail is reported');
    assert.equal(record.spoolComplete, false, 'the spool is not claimed complete');
    assert.equal(record.stdoutDurable, spoolBytes.length, 'the durable prefix is what the file holds');
    engineB = await startEngine(scratch.root, replacement, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineB, runId, SETTLED, 120_000);
    const attempt = attemptsOf(scratch.root, runId).find(row => row.process_id);
    assert.equal(attempt.state, 'interrupted', 'the attempt is interrupted, never recorded as a successful exit');
    const committed = Buffer.concat(committedChunks(scratch.root, attempt.id, 'stdout').map(chunk =>
      readFileSync(join(scratch.root, 'store', (() => { const d = database(scratch.root); try { return d.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(chunk.chunk.artifactId).relative_path; } finally { d.close(); } })()))));
    assert.ok(committed.length <= spoolBytes.length, 'the Engine committed no bytes beyond the durable prefix');
    assert.ok(spoolBytes.subarray(0, committed.length).equals(committed), 'the committed output is a byte-exact prefix of the spool');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'the lost invocation was never launched again');
    // The stream manifest is the evidence a reader trusts: an unknown tail must never be closed as a complete stream.
    const closed = runEventTypes(scratch.root, runId).find(event => event.type === 'attempt.log_stream_closed' && event.attemptId === attempt.id && event.payload.stream === 'stdout');
    assert.ok(closed, 'the stdout stream is closed in the journal');
    assert.notEqual(closed.payload.integrity, 'complete', 'the stream manifest does not claim a complete tail');
    assert.equal(closed.payload.integrity, 'partial', 'the stream manifest records the unknown tail as partial');
    evidence.cases['SP-07'] = { crashPoint: 'Host ended during spool write', spoolBytesOnDisk: spoolBytes.length, committedBytes: committed.length,
      hostState: record.state, tailGapPossible: record.tailGapPossible, spoolComplete: record.spoolComplete, attemptState: attempt.state, runState: final,
      streamIntegrity: closed.payload.integrity, launches: readInvocations(scratch.fixtureState).length };
  } finally {
    engine.kill(); if (engineB) await engineB.stop(); crashing.crash(); if (replacement) replacement.crash(); cleanup(scratch.root);
  }
});
