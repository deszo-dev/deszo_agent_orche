// Process Custody terminal settlement (F3, stop family). Each case scripts one Lifecycle Host terminal answer and nothing else: the Engine's
// real Custody child, its settlement and its workspace hold run unchanged, through the in-process runner. No CLI process is started, so the
// outcome depends only on the Host's answer. A Host stop is a stop outcome, never a result; an unproven tree is never a result; a durable
// hold is released only on the Host's proof that the process tree ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { singleAgent, startTestRunner } from './helpers.mjs';
import { eventually } from './custody-support.mjs';

// The provider's Codex-compatible output: a final answer and a successful terminal event.
const PROVIDER_JSONL = [
  { type: 'thread.started', thread_id: 'terminal-settlement' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Terminal settlement answer.' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
].map(event => JSON.stringify(event)).join('\n') + '\n';

// The Host's answers for one invocation. `end` is the terminal record the Host reports once the CLI has ended; `endAfterMs` ends it on its own
// (null: it ends only when the Engine asks the Host to stop it). `proven` is the Host's proof that the process tree ended; `prove()` gives it.
// `refuseLaunch` makes the Host refuse the launch with that code: the CLI never starts, and the Host's record of the refusal is terminal.
function scriptedHost(end, { endAfterMs = 150, refuseLaunch = null } = {}) {
  const stdout = Buffer.from(PROVIDER_JSONL, 'utf8');
  const custodyId = randomUUID();
  let ended = false, refused = false, proven = end.processTreeEnded === true, timer = null, acks = 0, statusCalls = 0;
  const endCli = () => { ended = true; clearTimeout(timer); };
  const refusedRecord = { custodyId, state: 'launch_failed', terminal: true, processId: null, processCreationTime: null, exitCode: null,
    terminationReason: 'The Host refused the launch.', stdoutDurable: 0, stderrDurable: 0, stdoutAcked: 0, stderrAcked: 0, spoolComplete: false, tailGapPossible: false,
    processTreeEnded: true };
  const status = () => (refused ? refusedRecord : ended
    ? { custodyId, state: end.state, terminal: true, processId: 4242, processCreationTime: 7, exitCode: end.exitCode, terminationReason: null,
      stdoutDurable: stdout.length, stderrDurable: 0, stdoutAcked: stdout.length, stderrAcked: 0, spoolComplete: end.spoolComplete, tailGapPossible: false,
      processTreeEnded: proven }
    : { custodyId, state: 'running', terminal: false, processId: 4242, processCreationTime: 7, exitCode: null, terminationReason: null,
      stdoutDurable: stdout.length, stderrDurable: 0, stdoutAcked: 0, stderrAcked: 0, spoolComplete: false, tailGapPossible: false, processTreeEnded: false });
  const custody = async (command, payload = {}) => {
    switch (command) {
      case 'custody.attach': return { epoch: 1 };
      case 'custody.reserve': return { custodyId, state: 'admitted', permit: 'terminal-permit', emergencyToken: randomBytes(32).toString('hex'),
        deadlineMs: payload.deadlineMs, executableSha256: 'a'.repeat(64), invocationDigest: 'b'.repeat(64), reused: false };
      case 'custody.launch':
        if (refuseLaunch) { refused = true; throw Object.assign(new Error(refuseLaunch.message), { code: refuseLaunch.code }); }
        if (endAfterMs !== null) timer = setTimeout(endCli, endAfterMs);
        return { custodyId, state: 'running', processId: 4242, processCreationTime: 7 };
      case 'custody.read': {
        const bytes = payload.stream === 'stdout' ? stdout : Buffer.alloc(0);
        const next = Math.min(bytes.length, payload.offset + (payload.max ?? 32768));
        return { stream: payload.stream, offset: payload.offset, nextOffset: next, durableEnd: bytes.length, terminal: ended, eof: ended && next === bytes.length,
          dataHex: bytes.subarray(payload.offset, next).toString('hex') };
      }
      case 'custody.ack': acks += 1; return { acked: payload.offset };
      case 'custody.status': statusCalls += 1; return status();
      case 'custody.stop': endCli(); return status();
      case 'custody.cancel': return status();
      default: throw new Error(`The scripted Host has no answer for ${command}.`);
    }
  };
  return {
    context: { generation: 'gen-terminal' }, custody,
    prove() { proven = true; },
    acknowledged: () => acks,
    statusCalls: () => statusCalls,
  };
}

// The durable outcome of one attempt: its state, every terminal transition it was given, and its workspace hold.
function outcomeOf(root, runId) {
  const db = new DatabaseSync(join(root, 'store', 'state.sqlite'), { readOnly: true });
  try {
    const attempt = db.prepare(`SELECT id, state FROM attempts WHERE run_id = ? AND node_instance_id = 'agent' ORDER BY rowid DESC LIMIT 1`).get(runId);
    const hold = attempt ? db.prepare('SELECT state, evidence_json FROM custody_workspace_holds WHERE attempt_id = ?').get(attempt.id) : null;
    const transitions = attempt ? db.prepare(`SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.state_changed' ORDER BY sequence`)
      .all(runId, attempt.id).map(row => JSON.parse(row.envelope_json).payload.to) : [];
    const stateChangeEventIds = attempt ? db.prepare(`SELECT id FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.state_changed' ORDER BY sequence`)
      .all(runId, attempt.id).map(row => row.id) : [];
    const failure = attempt ? db.prepare(`SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.error' ORDER BY sequence DESC LIMIT 1`)
      .get(runId, attempt.id) : null;
    const outcomeRow = attempt ? db.prepare('SELECT outcome_json FROM failure_outcomes WHERE attempt_id = ?').get(attempt.id) : null;
    const outcomeEvents = attempt ? db.prepare(`SELECT event_type,envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ?
      AND event_type IN ('attempt.failure_outcome','attempt.failure_outcome_updated') ORDER BY sequence`).all(runId, attempt.id)
      .map(row => ({ type: row.event_type, ...JSON.parse(row.envelope_json).payload.outcome })) : [];
    return {
      attempt: attempt?.state ?? null,
      settlements: transitions.filter(to => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(to)),
      hold: hold?.state ?? null,
      holdEvidence: hold?.evidence_json ? JSON.parse(hold.evidence_json) : null,
      failureCode: failure ? JSON.parse(failure.envelope_json).payload.code ?? null : null,
      failureEvidence: failure ? JSON.parse(failure.envelope_json).payload.evidence ?? null : null,
      failureMessage: failure ? JSON.parse(failure.envelope_json).payload.message ?? null : null,
      failureOutcome: outcomeRow ? JSON.parse(outcomeRow.outcome_json) : null,
      outcomeEvents,
      stateChangeEventIds,
      run: db.prepare('SELECT state FROM runs WHERE id = ?').get(runId)?.state ?? null,
    };
  } finally { db.close(); }
}

// An in-process runner whose Engine uses the scripted Host, with its workspace registered. A setup failure closes the runner.
async function openRunner(host) {
  const api = await startTestRunner({ runner: { custodyHost: host } });
  try { await api.workspace('main'); return api; } catch (error) { await api.close(); throw error; }
}

// Starts the one-agent run and waits for it to settle; a failure closes the runner.
async function runToSettlement(api, label) {
  try {
    const started = await api.run(singleAgent({ id: `terminal-${label}`, context: null, model: 'fixture-echo', timeoutSeconds: 60 }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    await api.waitFor(runId);
    return runId;
  } catch (error) { await api.close(); throw error; }
}

// One run whose agent attempt the scripted Host answers. The run is awaited until it settles.
async function settledRun(label, end, { endAfterMs } = {}) {
  const host = scriptedHost(end, { endAfterMs });
  const api = await openRunner(host);
  const runId = await runToSettlement(api, label);
  return { api, host, runId, outcome: () => outcomeOf(api.root, runId) };
}

// The reconciler asks the Host about each held workspace every two seconds. Over a five-second window the unproven hold must stay held, and the Host
// must have been asked about it at least twice.
async function heldAcrossReconciles(outcome, host) {
  const asked = host.statusCalls();
  await new Promise(resolve => setTimeout(resolve, 2_500));
  const first = outcome();
  await new Promise(resolve => setTimeout(resolve, 2_500));
  assert.equal(first.hold, 'held', 'the first reconciliation keeps the unproven hold');
  assert.ok(host.statusCalls() - asked >= 2, 'the reconciler asked the Host about the held workspace at least twice');
  return outcome();
}

// Each case below is one row of the terminal table in the F3 fix: the Host answer, then the attempt, the run and the hold.

test('F3 terminal: exited, tree proven, exit 0 is the one success (normal Codex success is unchanged)', async () => {
  const { api, outcome } = await settledRun('exited-proven', { state: 'exited', exitCode: 0, spoolComplete: true, processTreeEnded: true });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'succeeded');
    assert.equal(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['succeeded'], 'the attempt settles exactly once');
    assert.equal(result.hold, 'released');
    assert.equal(result.holdEvidence.processTreeEnded, true);
  } finally { await api.close(); }
});

test('F3 terminal: exited, tree not proven, exit 0 is not a success; the hold waits for the Host proof', async () => {
  const { api, host, outcome } = await settledRun('exited-unproven', { state: 'exited', exitCode: 0, spoolComplete: true, processTreeEnded: false });
  try {
    const before = await heldAcrossReconciles(outcome, host);
    assert.equal(before.attempt, 'failed');
    assert.notEqual(before.run, 'succeeded');
    assert.deepEqual(before.settlements, ['failed'], 'the attempt settles exactly once, as failed');
    assert.match(before.failureMessage, /has not proven that its process tree ended/);
    assert.equal(before.hold, 'held', 'no proof, no release');
    assert.equal(before.failureOutcome.category, 'execution_uncertain');
    assert.equal(before.failureOutcome.executionCertainty, 'unresolved');
    assert.equal(before.failureOutcome.observedState.processTreeEnded, false);
    host.prove();
    const after = await eventually(() => { const next = outcome(); return next.hold === 'released' ? next : null; }, 'the hold to be released on the proof', 15_000, 200);
    assert.equal(after.holdEvidence.processTreeEnded, true);
    assert.equal(after.attempt, 'failed', 'a late proof does not turn the failed attempt into a success');
    assert.equal(after.failureOutcome.outcomeId, before.failureOutcome.outcomeId, 'a late proof updates the original outcome identity');
    assert.equal(after.failureOutcome.executionCertainty, 'completed');
    assert.equal(after.failureOutcome.observedState.processTreeEnded, true);
    assert.equal(after.failureOutcome.observedState.spoolComplete, true);
    assert.equal(after.outcomeEvents.filter(event => event.type === 'attempt.failure_outcome').length, 1);
    assert.equal(after.outcomeEvents.filter(event => event.type === 'attempt.failure_outcome_updated').length, 1);
  } finally { await api.close(); }
});

test('F3 terminal: stopped, tree not proven, exit 0 is not a success; the hold stays held', async () => {
  const { api, host, outcome } = await settledRun('stopped-unproven', { state: 'stopped', exitCode: 0, spoolComplete: true, processTreeEnded: false }, { endAfterMs: 150 });
  try {
    const before = await heldAcrossReconciles(outcome, host);
    assert.equal(before.attempt, 'failed');
    assert.notEqual(before.run, 'succeeded');
    assert.deepEqual(before.settlements, ['failed']);
    assert.match(before.failureMessage, /has not proven that its process tree ended/);
    assert.equal(before.hold, 'held');
    host.prove();
    assert.equal((await eventually(() => { const next = outcome(); return next.hold === 'released' ? next : null; }, 'the hold to be released on the proof', 15_000, 200)).holdEvidence.hostState, 'stopped');
  } finally { await api.close(); }
});

test('F3 terminal: deadline_terminated, tree not proven, exit 0 is not a success; the hold stays held', async () => {
  const { api, host, outcome } = await settledRun('deadline-unproven', { state: 'deadline_terminated', exitCode: 0, spoolComplete: true, processTreeEnded: false });
  try {
    const before = await heldAcrossReconciles(outcome, host);
    assert.equal(before.attempt, 'failed');
    assert.notEqual(before.run, 'succeeded');
    assert.deepEqual(before.settlements, ['failed']);
    assert.match(before.failureMessage, /has not proven that its process tree ended/);
    assert.equal(before.hold, 'held');
    host.prove();
    await eventually(() => { const next = outcome(); return next.hold === 'released' ? next : null; }, 'the hold to be released on the proof', 15_000, 200);
  } finally { await api.close(); }
});

test('F3 terminal: emergency_stopped, tree not proven, exit 0 is not a success; the hold stays held', async () => {
  const { api, host, outcome } = await settledRun('emergency-unproven', { state: 'emergency_stopped', exitCode: 0, spoolComplete: true, processTreeEnded: false });
  try {
    const before = await heldAcrossReconciles(outcome, host);
    assert.equal(before.attempt, 'failed');
    assert.notEqual(before.run, 'succeeded');
    assert.deepEqual(before.settlements, ['failed']);
    assert.match(before.failureMessage, /has not proven that its process tree ended/);
    assert.equal(before.hold, 'held');
    host.prove();
    await eventually(() => { const next = outcome(); return next.hold === 'released' ? next : null; }, 'the hold to be released on the proof', 15_000, 200);
  } finally { await api.close(); }
});

test('F3 terminal: stopped, tree proven, exit 0 is a stop (canceled), not a success', async () => {
  const { api, outcome } = await settledRun('stopped-proven', { state: 'stopped', exitCode: 0, spoolComplete: true, processTreeEnded: true }, { endAfterMs: 150 });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'canceled');
    assert.notEqual(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['canceled'], 'the attempt settles exactly once');
    assert.equal(result.hold, 'released');
  } finally { await api.close(); }
});

test('F3 terminal: deadline_terminated, tree proven, exit 0 is a timeout, not a success', async () => {
  const { api, outcome } = await settledRun('deadline-proven', { state: 'deadline_terminated', exitCode: 0, spoolComplete: true, processTreeEnded: true }, { endAfterMs: 150 });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'failed');
    assert.notEqual(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['failed']);
    assert.match(result.failureMessage, /admitted deadline/);
    assert.equal(result.hold, 'released');
    assert.equal(result.failureOutcome.source, 'workflow');
    assert.equal(result.failureOutcome.category, 'task_failure');
    assert.equal(result.failureOutcome.canonicalCode, 'timeout');
    assert.equal(result.failureOutcome.observedState.hostState, 'deadline_terminated');
  } finally { await api.close(); }
});

test('F3 terminal: emergency_stopped, tree proven, exit 0 is a stop (canceled), not a success', async () => {
  const { api, outcome } = await settledRun('emergency-proven', { state: 'emergency_stopped', exitCode: 0, spoolComplete: true, processTreeEnded: true }, { endAfterMs: 150 });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'canceled');
    assert.notEqual(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['canceled']);
    assert.equal(result.hold, 'released');
  } finally { await api.close(); }
});

test('F3 terminal: exited, tree proven, exit 0 with an incomplete spool is not a success', async () => {
  const { api, outcome } = await settledRun('exited-incomplete', { state: 'exited', exitCode: 0, spoolComplete: false, processTreeEnded: true });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'failed');
    assert.notEqual(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['failed']);
    assert.equal(result.hold, 'released', 'the proof releases the hold even when the answer is not accepted');
    assert.equal(result.failureOutcome.source, 'host');
    assert.equal(result.failureOutcome.category, 'execution_uncertain');
    assert.equal(result.failureOutcome.observedState.spoolComplete, false);
    assert.equal(result.failureOutcome.executionCertainty, 'unresolved');
  } finally { await api.close(); }
});

// A launch the Host refuses is a failed attempt with a code its journal accepts; the Host's record of the refusal releases the hold.
test('F3 launch refusal: a refused launch fails the attempt with a journal-valid code, and the hold is released on the Host record', async () => {
  const host = scriptedHost({ state: 'launch_failed', exitCode: null, spoolComplete: false, processTreeEnded: true },
    { endAfterMs: null, refuseLaunch: { code: 'launch_failed', message: 'The launch permit expired before launch.' } });
  const api = await openRunner(host);
  const runId = await runToSettlement(api, 'launch-refused');
  try {
    const result = outcomeOf(api.root, runId);
    assert.equal(result.attempt, 'failed');
    assert.equal(result.failureCode, 'provider_unavailable', 'a Host code the journal does not name is recorded as a provider that did not start');
    assert.match(result.failureMessage, /could not be started/);
    assert.notEqual(result.failureEvidence, null, 'the raw Host code is kept as the attempt evidence');
    assert.equal(result.failureOutcome.executionCertainty, 'not_started');
    assert.equal(result.failureOutcome.sideEffectCertainty, 'none_proven');
    assert.equal(result.failureOutcome.source, 'host');
    assert.equal(result.failureOutcome.category, 'orchestrator_failure');
    assert.equal(result.failureOutcome.canonicalCode, 'provider_unavailable', 'the existing journal code remains valid while typed provenance identifies the Host refusal');
    assert.equal(result.failureOutcome.observedState.hostState, 'launch_failed');
    assert.deepEqual(result.settlements, ['failed'], 'the attempt settles exactly once');
    const released = await eventually(() => { const next = outcomeOf(api.root, runId); return next.hold === 'released' ? next : null; },
      'the hold to be released on the Host record', 15_000, 200);
    assert.equal(released.holdEvidence.hostState, 'launch_failed');
  } finally { await api.close(); }
});

// The Engine's own Stop: the Engine requests it, then the Host reports the end. The Engine's stop outcome (canceled) is unchanged; a Host stop is
// not made a success by a zero exit code, with the tree proven or not.
async function settledStopRun(label, end) {
  const host = scriptedHost(end, { endAfterMs: null });
  const api = await openRunner(host);
  try {
    const started = await api.run(singleAgent({ id: `terminal-${label}`, context: null, model: 'fixture-echo', timeoutSeconds: 60 }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    // The Engine stops only after it has read and committed the provider's output, so the Host's zero exit is the only answer that could be a success.
    await eventually(() => host.acknowledged() > 0 ? true : null, 'the Engine to commit the provider output', 30_000, 50);
    const stopped = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await api.waitFor(runId);
    return { api, host, runId, outcome: () => outcomeOf(api.root, runId) };
  } catch (error) { await api.close(); throw error; }
}

test('F3 terminal: an Engine Stop of a proven stop with exit 0 is canceled, not a success', async () => {
  const { api, outcome } = await settledStopRun('engine-stop-proven', { state: 'stopped', exitCode: 0, spoolComplete: true, processTreeEnded: true });
  try {
    const result = outcome();
    assert.equal(result.attempt, 'canceled');
    assert.notEqual(result.run, 'succeeded');
    assert.deepEqual(result.settlements, ['canceled']);
    assert.equal(result.hold, 'released');
    assert.equal(result.failureOutcome.source, 'external_control');
    assert.equal(result.failureOutcome.category, 'control_outcome');
    assert.equal(result.failureOutcome.canonicalCode, 'interrupted');
    assert.ok(result.failureOutcome.evidenceReferences.some(ref => ref.type === 'journal_event' && result.stateChangeEventIds.includes(ref.id)),
      'the explicit stop outcome references its journaled Attempt transition');
  } finally { await api.close(); }
});

test('F3 terminal: an Engine Stop of an unproven stop with exit 0 is canceled, and the hold waits for the proof', async () => {
  const { api, host, outcome } = await settledStopRun('engine-stop-unproven', { state: 'stopped', exitCode: 0, spoolComplete: true, processTreeEnded: false });
  try {
    const before = await heldAcrossReconciles(outcome, host);
    assert.equal(before.attempt, 'canceled');
    assert.notEqual(before.run, 'succeeded');
    assert.deepEqual(before.settlements, ['canceled']);
    assert.equal(before.hold, 'held');
    host.prove();
    await eventually(() => { const next = outcome(); return next.hold === 'released' ? next : null; }, 'the hold to be released on the proof', 15_000, 200);
  } finally { await api.close(); }
});
