// Process Custody H3: a definitive Host refusal (`not_found`) about a running invocation. The refusal is no evidence that the CLI ended, so
// the attempt is never settled, its workspace stays held and its lock taken, and nothing is launched again; the condition is recorded once
// and the Engine stops its read cycle. When the Host answers for the invocation again, the same attempt continues and its workspace is
// released on the Host's proof of the end. Every proof uses the real Lifecycle Host, real Engine processes and the fixture CLI. The refusal
// is injected only at the Engine's Host boundary for one named invocation (a file the Engine checks before each Host call): the Host keeps
// running, and so does the CLI under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attemptsOf, buildArtifacts, cleanup, custodyRequest, database, eventually, exited, hostRecords, isAlive, newScratch, readInvocations, runEventTypes,
  runState, setCodexCapacity, startAgentRun, startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const CONFLICT = /Another run is active in this workspace|A Host-owned process may still be running in this workspace/;
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-unresolved.json'), JSON.stringify(evidence, null, 2));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function holdOf(root, attemptId) {
  const db = database(root);
  try {
    return db.prepare('SELECT custody_id, attempt_id, state, evidence_json, unresolved_json, released_at FROM custody_workspace_holds WHERE attempt_id = ?').get(attemptId) ?? null;
  } finally { db.close(); }
}

function locksOf(root, attemptId) {
  const db = database(root);
  try { return db.prepare('SELECT resource_key FROM resource_locks WHERE attempt_id = ?').all(attemptId); } finally { db.close(); }
}

function unresolvedEvents(root, runId) {
  return runEventTypes(root, runId).filter(event => event.type === 'attempt.error' && event.payload.code === 'custody_unresolved');
}

// The commands the Engine sent about the refused invocation while the refusal stood, from the injection's own record.
function refusedCalls(flag) {
  const path = `${flag}.calls`;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { const [at, command] = line.split(' '); return { at: Number(at), command }; });
}

async function startRunning(engine, scratch, host, { workflowId, ticks, workspaceId = 'main', workspaceCwd = scratch.workspace }) {
  const { runId } = await startAgentRun(engine, { workflowId, model: 'custody-steady', requestText: `[ticks=${ticks}]`, workspaceId, workspaceCwd });
  const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), `run ${workflowId}: the CLI to start`, 60_000, 100);
  await eventually(() => hostRecords(host).find(record => record.attemptId === attempt.id && record.state === 'running'),
    `run ${workflowId}: the Host to report the CLI running`, 30_000, 100);
  return { runId, attempt };
}

// NR-01, NR-02, NR-04, NR-05, NR-06. One CLI runs; the Host is made to refuse every command about it as `not_found`. The Engine records the
// typed unresolved condition once and stops its read cycle; the attempt, its lock and its hold stay; a conflicting Run is refused while a
// disjoint one runs. When the Host answers again, the same CLI continues to its end, and the workspace is released once, on the Host's proof.
test('NR-01, NR-02, NR-04 to NR-06: a not_found refusal leaves the attempt unresolved and held, then it continues and releases once', async () => {
  buildArtifacts();
  const scratch = newScratch('nr-refusal');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-refuse.flag');
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_REFUSE_FILE: flag } });
  try {
    await setCodexCapacity(engine, { codex: 3, global: 6 });
    // The refusal the Engine classifies is the one the real Host gives for an invocation it has no record of (no epoch needed, nothing fenced).
    const real = await custodyRequest(host, 'custody.emergency_stop', { custodyId: randomUUID(), emergencyToken: 'x' });
    assert.equal(real.refused, true);
    assert.equal(real.code, 'not_found', 'the real Host refuses an unknown invocation as not_found');

    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'nr-main', ticks: 120 });
    const custodyId = (await eventually(() => holdOf(scratch.root, attempt.id), 'the hold', 10_000, 100)).custody_id;
    const disjoint = join(scratch.root, 'disjoint');
    mkdirSync(disjoint, { recursive: true });

    // NR-01: the refusal during streaming becomes a typed, durable unresolved condition, reported once.
    writeFileSync(flag, custodyId);
    const unresolved = await eventually(() => holdOf(scratch.root, attempt.id)?.unresolved_json, 'the unresolved condition', 15_000, 100);
    const condition = JSON.parse(unresolved);
    assert.equal(condition.code, 'custody_unresolved');
    assert.equal(condition.refusal, 'not_found');
    // The pump reads, then acknowledges committed bytes; whichever command the refusal lands on, it came from the streaming cycle.
    assert.ok(['custody.read', 'custody.ack'].includes(condition.command), `the refusal came from the stream pump (${condition.command})`);
    assert.equal(unresolvedEvents(scratch.root, runId).length, 1, 'the operator is told once');

    // The read cycle stopped: over 10 seconds the old cycle asked about 20 times; now only the hold reconciler asks, every 2 seconds, by status.
    const windowStart = Date.now();
    await delay(10_000);
    const inWindow = refusedCalls(flag).filter(call => call.at >= windowStart);
    assert.ok(inWindow.length <= 7, `the Engine stopped retrying every 500 ms (${inWindow.length} refused commands in 10 s)`);
    assert.ok(inWindow.every(call => call.command === 'custody.status'), `only reconciliation asks: ${[...new Set(inWindow.map(call => call.command))].join(', ')}`);
    assert.equal(unresolvedEvents(scratch.root, runId).length, 1, 'no duplicate report while the condition stands');

    // NR-02: nothing was settled or released while the CLI may run.
    assert.equal(isAlive(attempt.process_id), true, 'the original CLI is alive');
    assert.equal(hostRecords(host).find(record => record.attemptId === attempt.id).state, 'running', 'the Host still runs it');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'running', 'the attempt is not settled');
    assert.equal(await runState(engine, runId), 'running', 'the run is not settled');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the workspace stays held');
    assert.ok(locksOf(scratch.root, attempt.id).some(row => row.resource_key.startsWith('cwd:')), 'the directory lock stays taken');
    await assert.rejects(startAgentRun(engine, { workflowId: 'nr-conflict', workspaceId: 'conflict', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: scratch.workspace }),
      CONFLICT, 'a conflicting run in the same physical root is refused');
    const disjointRun = await startAgentRun(engine, { workflowId: 'nr-disjoint', workspaceId: 'disjoint', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: disjoint });
    assert.equal(await waitForRunState(engine, disjointRun.runId, SETTLED, 60_000), 'succeeded', 'a disjoint workspace is not blocked');

    // NR-04: no second provider invocation for the attempt.
    assert.equal(hostRecords(host).filter(record => record.attemptId === attempt.id).length, 1, 'one Host record for the attempt');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'the CLI was launched once');

    // NR-05: the Host answers again; the same attempt continues with the same process.
    rmSync(flag, { force: true });
    await eventually(() => holdOf(scratch.root, attempt.id)?.unresolved_json === null, 'the condition to clear when the Host answers', 15_000, 100);
    assert.equal(isAlive(attempt.process_id), true, 'the same CLI continues');
    const final = await waitForRunState(engine, runId, SETTLED, 120_000);
    assert.equal(final, 'succeeded', 'the attempt completes from the Host\'s record');
    const invocations = readInvocations(scratch.fixtureState);
    assert.equal(invocations.filter(item => item.pid === attempt.process_id).length, 1, 'no relaunch on recovery');
    assert.equal(invocations.length, 2, 'only the original and the disjoint run invoked a CLI');

    // NR-06: released once, on the Host's proof that the process tree ended; the workspace is usable again.
    const released = holdOf(scratch.root, attempt.id);
    assert.equal(released.state, 'released');
    assert.equal(JSON.parse(released.evidence_json).processTreeEnded, true, 'the release evidence is the Host proof');
    assert.equal(locksOf(scratch.root, attempt.id).length, 0, 'the lock is released with the attempt');
    assert.equal(unresolvedEvents(scratch.root, runId).length, 1, 'the condition was reported exactly once overall');
    const next = await startAgentRun(engine, { workflowId: 'nr-next', workspaceId: 'next', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: scratch.workspace });
    assert.equal(await waitForRunState(engine, next.runId, SETTLED, 60_000), 'succeeded', 'the released workspace is usable');
    evidence.cases['NR-01/02/04/05/06'] = { runId, attemptId: attempt.id, cliPid: attempt.process_id, condition, refusedCommandsIn10s: inWindow.length,
      disjointRunId: disjointRun.runId, finalRunState: final, invocations: invocations.length, holdAfter: released.state, releasedAt: released.released_at };
  } finally {
    rmSync(flag, { force: true });
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// NR-08. A Stop issued while the Host refuses the invocation is not applied by the Host, so it stays pending: the CLI keeps running, the run
// is not settled and the workspace stays held. When the Host answers again, the pending Stop is delivered, the Host ends the tree, and the
// workspace is released on the Host's proof that it was stopped (not on the CLI's natural end).
test('NR-08: a Stop refused by the Host stays pending and is delivered when the Host answers again', async () => {
  buildArtifacts();
  const scratch = newScratch('nr-stop');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-refuse.flag');
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_REFUSE_FILE: flag } });
  try {
    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'nr-stop', ticks: 120 });
    const custodyId = (await eventually(() => holdOf(scratch.root, attempt.id), 'the hold', 10_000, 100)).custody_id;
    writeFileSync(flag, custodyId);
    await eventually(() => holdOf(scratch.root, attempt.id)?.unresolved_json, 'the unresolved condition', 15_000, 100);
    const stop = await engine.api('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, 'the Stop is accepted');
    await delay(6_000);
    assert.ok(refusedCalls(flag).some(call => call.command === 'custody.stop'), 'the Stop reached the boundary and was refused');
    assert.equal(isAlive(attempt.process_id), true, 'a refused Stop was not applied: the CLI still runs');
    assert.equal(SETTLED.includes(await runState(engine, runId)), false, 'the run is not settled while the Stop is pending');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the workspace stays held');

    rmSync(flag, { force: true });
    const final = await waitForRunState(engine, runId, SETTLED, 60_000);
    assert.equal(final, 'canceled', 'the pending Stop is delivered once the Host answers');
    await eventually(() => !isAlive(attempt.process_id), 'the CLI to end', 30_000, 100);
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the hold to be released', 30_000, 200);
    const proof = JSON.parse(released.evidence_json);
    assert.equal(proof.hostState, 'stopped', 'the Host stopped the tree (the CLI did not just run to its end)');
    assert.equal(proof.processTreeEnded, true);
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'nothing was launched again');
    evidence.cases['NR-08'] = { runId, attemptId: attempt.id, cliPid: attempt.process_id, finalRunState: final, holdEvidence: proof };
  } finally {
    rmSync(flag, { force: true });
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// NR-03 (and NR-04 across Engines). The Engine dies while the attempt is unresolved. Its successor reconstructs the hold and the lock, finds the
// Host still refusing, and keeps the condition without reporting it again; a conflicting Run stays refused. When the Host answers, the
// successor attaches to the same CLI and completes it; nothing is launched again.
test('NR-03: after an Engine restart the unresolved attempt stays held, is not reported twice, and continues when the Host answers', async () => {
  buildArtifacts();
  const scratch = newScratch('nr-restart');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-refuse.flag');
  const extraEnv = { DESZO_CUSTODY_TEST_REFUSE_FILE: flag };
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv });
  let engineB = null;
  try {
    await setCodexCapacity(engineA, { codex: 3, global: 6 });
    const nested = join(scratch.workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    const { runId, attempt } = await startRunning(engineA, scratch, host, { workflowId: 'nr-restart', ticks: 90 });
    const custodyId = (await eventually(() => holdOf(scratch.root, attempt.id), 'the hold', 10_000, 100)).custody_id;
    writeFileSync(flag, custodyId);
    await eventually(() => holdOf(scratch.root, attempt.id)?.unresolved_json, 'the unresolved condition', 15_000, 100);
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv });
    await delay(5_000);
    assert.equal(isAlive(attempt.process_id), true, 'the CLI runs on under the Host');
    assert.equal(await runState(engineB, runId), 'running', 'the successor does not settle the run');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'running', 'nor the attempt');
    const hold = holdOf(scratch.root, attempt.id);
    assert.equal(hold.state, 'held', 'the successor keeps the hold');
    assert.equal(JSON.parse(hold.unresolved_json).refusal, 'not_found', 'the condition is still recorded');
    assert.ok(locksOf(scratch.root, attempt.id).some(row => row.resource_key.startsWith('cwd:')), 'the successor re-took the directory lock');
    assert.equal(unresolvedEvents(scratch.root, runId).length, 1, 'the successor does not report the standing condition again');
    await assert.rejects(startAgentRun(engineB, { workflowId: 'nr-nested', workspaceId: 'nested', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: nested }),
      CONFLICT, 'a conflicting run in a nested directory is refused by the successor');

    rmSync(flag, { force: true });
    const final = await waitForRunState(engineB, runId, SETTLED, 120_000);
    assert.equal(final, 'succeeded', 'the successor continues the same CLI to its end');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'the CLI was never launched again');
    assert.equal(hostRecords(host).filter(record => record.attemptId === attempt.id).length, 1, 'one Host record for the attempt');
    const released = holdOf(scratch.root, attempt.id);
    assert.equal(released.state, 'released');
    assert.equal(JSON.parse(released.evidence_json).processTreeEnded, true);
    evidence.cases['NR-03'] = { runId, attemptId: attempt.id, cliPid: attempt.process_id, finalRunState: final, reports: unresolvedEvents(scratch.root, runId).length, holdAfter: released.state };
  } finally {
    rmSync(flag, { force: true });
    engineA.kill();
    if (engineB) await engineB.stop();
    host.crash();
    cleanup(scratch.root);
  }
});
