// Process Custody: final safety proofs for findings F3 (a leader exits before its Job's descendants) and F6 (the Host cannot persist the
// running record of a CLI it has already started). Every proof uses the real Lifecycle Host, real Windows processes and the fixture CLI;
// the Engine proofs use real Engine processes. Two debug-build Host hooks place the faults exactly:
// - testUndrainedDrainMs: the ended invocation's Job is drained only briefly and not terminated, so a descendant that outlives its leader
//   leaves the Job not empty when the end is recorded (as a termination that did not empty the Job in time would). While
//   `custody/test-fail-drain-proof` exists in the Host state, the later drain proof cannot be written.
// - testFailRunningRecordAfterMs: after the CLI is created, assigned to its Job and resumed, the Host waits and then fails the write of its
//   running record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachEngine, attemptsOf, buildArtifacts, cleanup, custodyRequest, database, eventually, exited, fixtureExe, hostRecords, isAlive, newScratch,
  readInvocations, startAgentRun, startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const CONFLICT = /Another run is active in this workspace|A Host-owned process may still be running in this workspace/;
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-safety.json'), JSON.stringify(evidence, null, 2));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function holdOf(root, attemptId) {
  const db = database(root);
  try { return db.prepare('SELECT state, evidence_json FROM custody_workspace_holds WHERE attempt_id = ?').get(attemptId) ?? null; } finally { db.close(); }
}

function agentAttempt(root, runId) {
  const db = database(root);
  try { return db.prepare(`SELECT id, state, process_id FROM attempts WHERE run_id = ? AND node_instance_id = 'agent' ORDER BY rowid DESC LIMIT 1`).get(runId) ?? null; } finally { db.close(); }
}

function descendantPid(fixtureState) {
  try { return Number(readFileSync(join(fixtureState, 'descendant.pid'), 'utf8')) || null; } catch { return null; }
}

function markerSize(fixtureState) {
  const path = join(fixtureState, 'orphan.log');
  return existsSync(path) ? statSync(path).size : 0;
}

// The on-disk record of one invocation, as the Host wrote it.
function diskRecord(host, custodyId) {
  return JSON.parse(readFileSync(join(host.state, 'custody', 'attempts', `${custodyId}.json`), 'utf8'));
}

async function admitAndLaunch(host, epoch, scratch, { attemptId, model, prompt }) {
  const admitted = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId, runId: `run-${attemptId}`, provider: 'codex',
    command: fixtureExe, args: ['--model', model], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState },
    stdinHex: Buffer.from(prompt, 'utf8').toString('hex'), deadlineMs: 120_000 });
  assert.ok(admitted.permit, `admission refused: ${JSON.stringify(admitted)}`);
  const launched = await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit });
  return { custodyId: admitted.custodyId, launched };
}

const status = (host, epoch, custodyId) => custodyRequest(host, 'custody.status', { epoch, generation: host.generation, custodyId });

// F3-01, F3-03, F3-04 at the Host. The leader exits while its descendant keeps writing. The real custody.status never reports the tree ended
// while the descendant lives, nor when the proof cannot be made durable; once the Job is empty and the proof is written, it does.
test('F3-01/F3-03/F3-04: a leader that exits before its descendant never proves the tree ended, and an unwritten proof is not reported', async () => {
  buildArtifacts();
  const scratch = newScratch('f3-host');
  const host = await startCustodyHost(scratch.root, { testUndrainedDrainMs: 300 });
  const failProof = join(host.state, 'custody', 'test-fail-drain-proof');
  try {
    const epoch = await attachEngine(host);
    const { custodyId, launched } = await admitAndLaunch(host, epoch, scratch, { attemptId: 'f3-host', model: 'custody-orphan', prompt: '[orphanMs=9000]' });
    const leader = launched.processId;
    const descendant = await eventually(() => descendantPid(scratch.fixtureState), 'the descendant to start', 15_000, 50);
    const ended = await eventually(async () => { const s = await status(host, epoch, custodyId); return s.terminal ? s : null; }, 'the leader to end', 20_000, 100);

    // F3-01 / F3-03: leader gone, descendant alive and writing, Job not empty: the tree has not ended, in memory or on disk.
    assert.equal(isAlive(leader), false, 'the leader has exited');
    assert.equal(isAlive(descendant), true, 'its descendant is alive');
    const before = markerSize(scratch.fixtureState);
    await delay(600);
    assert.ok(markerSize(scratch.fixtureState) > before, 'the descendant is still writing');
    assert.equal(ended.processTreeEnded, false, 'a leader exit is not the end of the tree');
    assert.equal(diskRecord(host, custodyId).drained, false, 'the durable record says the Job was not empty');
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await status(host, epoch, custodyId)).processTreeEnded, false, 'every status while the descendant lives says not ended');
      await delay(300);
    }

    // F3-04: the descendant ends and the Job empties, but the proof cannot be written: nothing claims an end that is not durable.
    writeFileSync(failProof, 'fail');
    await eventually(() => !isAlive(descendant), 'the descendant to end', 30_000, 100);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await status(host, epoch, custodyId)).processTreeEnded, false, 'an unwritten proof is not reported');
      await delay(200);
    }
    assert.equal(diskRecord(host, custodyId).drained, false, 'nothing durable claims the end');

    // F3-02 (Host half): the proof can be written; the next status reports it, durably.
    rmSync(failProof, { force: true });
    assert.equal((await status(host, epoch, custodyId)).processTreeEnded, true, 'an empty Job with a durable proof has ended');
    assert.equal(diskRecord(host, custodyId).drained, true, 'the proof is durable');
    evidence.cases['F3-01/03/04'] = { leaderPid: leader, descendantPid: descendant, recordState: ended.state, treeEndedWhileDescendantAlive: false,
      treeEndedWithUnwrittenProof: false, treeEndedAfterProof: true };
  } finally {
    rmSync(failProof, { force: true });
    host.crash();
    cleanup(scratch.root);
  }
});

// F3-01, F3-02 through the Engine. The attempt's own result is settled when its leader ends, but its workspace stays held while the descendant
// runs: a conflicting run is refused. When the Job is empty the Host proves the end and the hold is released; the directory is usable again.
test('F3-01/F3-02: the workspace stays held until the descendant ends, and is released once the Host proves the Job empty', async () => {
  buildArtifacts();
  const scratch = newScratch('f3-engine');
  const host = await startCustodyHost(scratch.root, { testUndrainedDrainMs: 300 });
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const nested = join(scratch.workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    const { runId } = await startAgentRun(engine, { workflowId: 'f3-engine', model: 'custody-orphan', requestText: '[orphanMs=12000]', workspaceCwd: scratch.workspace });
    const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), 'the leader to start', 60_000, 100);
    const descendant = await eventually(() => descendantPid(scratch.fixtureState), 'the descendant to start', 15_000, 50);
    const final = await waitForRunState(engine, runId, SETTLED, 60_000);
    assert.equal(isAlive(attempt.process_id), false, 'the leader has exited');
    assert.equal(isAlive(descendant), true, 'the descendant still runs');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'a settled attempt whose Job is not empty keeps its workspace held');
    await assert.rejects(startAgentRun(engine, { workflowId: 'f3-nested', workspaceId: 'nested', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: nested }),
      CONFLICT, 'a conflicting run is refused while the descendant runs');

    await eventually(() => !isAlive(descendant), 'the descendant to end', 30_000, 100);
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the Host to prove the Job empty and the hold to be released', 30_000, 200);
    assert.equal(JSON.parse(released.evidence_json).processTreeEnded, true);
    const next = await startAgentRun(engine, { workflowId: 'f3-next', workspaceId: 'next', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: scratch.workspace });
    assert.equal(await waitForRunState(engine, next.runId, SETTLED, 60_000), 'succeeded', 'the workspace is usable after the proof');
    evidence.cases['F3-01/02'] = { runId, leaderPid: attempt.process_id, descendantPid: descendant, attemptRunState: final, holdWhileDescendantAlive: 'held', holdAfter: 'released' };
  } finally {
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// F3-05. The Host dies while an ended invocation's Job is not empty. The Job closes with the Host (kill-on-close), so the descendant ends;
// the replacement Host has no Job to query and decides by the recorded process instance; the hold is released, and nothing is relaunched.
test('F3-05: after a Host restart an undrained end is decided by verified death, and the descendant died with the old Host', async () => {
  buildArtifacts();
  const scratch = newScratch('f3-restart');
  const hostA = await startCustodyHost(scratch.root, { testUndrainedDrainMs: 300 });
  const engineA = await startEngine(scratch.root, hostA, { fixtureStateDir: scratch.fixtureState });
  let hostB = null, engineB = null;
  try {
    const { runId } = await startAgentRun(engineA, { workflowId: 'f3-restart', model: 'custody-orphan', requestText: '[orphanMs=120000]', workspaceCwd: scratch.workspace });
    const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), 'the leader to start', 60_000, 100);
    const descendant = await eventually(() => descendantPid(scratch.fixtureState), 'the descendant to start', 15_000, 50);
    await waitForRunState(engineA, runId, SETTLED, 60_000);
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held');
    assert.equal(isAlive(descendant), true);
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);
    hostA.crash();
    await eventually(() => exited(hostA.child), 'Host A to end', 20_000, 50);
    await eventually(() => !isAlive(descendant), 'the descendant to end with its Host (kill-on-close)', 20_000, 100);
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'no Host has proven the end yet');

    hostB = await startCustodyHost(scratch.root, { generation: 'gen-2' });
    engineB = await startEngine(scratch.root, hostB, { fixtureStateDir: scratch.fixtureState });
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the replacement Host to prove the end', 60_000, 200);
    assert.equal(JSON.parse(released.evidence_json).processTreeEnded, true);
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'nothing was launched again');
    evidence.cases['F3-05'] = { runId, leaderPid: attempt.process_id, descendantPid: descendant, descendantDiedWithHost: true, holdAfter: 'released' };
  } finally {
    engineA.kill();
    if (engineB) await engineB.stop();
    hostA.crash();
    if (hostB) hostB.crash();
    cleanup(scratch.root);
  }
});

// F6-01, F6-02, F6-04 at the Host. The CLI is created, assigned to its Job and resumed, and has started a descendant, when the write of its
// running record fails. The Host refuses the launch, terminates the Job, and records the end; neither the CLI nor its descendant survives.
test('F6-01/F6-04: a running record that cannot be written leaves no surviving CLI or descendant, and no false launch', async () => {
  buildArtifacts();
  const scratch = newScratch('f6-host');
  const host = await startCustodyHost(scratch.root, { testFailRunningRecordAfterMs: 2500 });
  try {
    const epoch = await attachEngine(host);
    const { custodyId, launched } = await admitAndLaunch(host, epoch, scratch, { attemptId: 'f6-host', model: 'custody-descendant', prompt: '[ticks=240]' });
    assert.equal(launched.refused, true, 'the launch is refused, not reported as running');
    assert.equal(launched.code, 'storage_unavailable', 'the refusal names the failed persistence');
    const [{ pid: leader }] = readInvocations(scratch.fixtureState);
    const descendant = descendantPid(scratch.fixtureState);
    assert.ok(leader, 'the CLI had started (it recorded its invocation) before the failure');
    assert.ok(descendant, 'and had started its descendant');
    await eventually(() => !isAlive(leader) && !isAlive(descendant), 'the CLI and its descendant to be terminated with their Job', 20_000, 100);
    const ended = await eventually(async () => { const s = await status(host, epoch, custodyId); return s.terminal ? s : null; }, 'the Host to record the end', 20_000, 100);
    assert.equal(ended.state, 'spool_failed', 'the end is recorded as a capture failure, not an exit');
    assert.equal(ended.processTreeEnded, true, 'the Job was verified empty');
    assert.equal(diskRecord(host, custodyId).state, 'spool_failed', 'the end is durable');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'nothing was launched again');
    evidence.cases['F6-01/04'] = { refusal: launched.code, leaderPid: leader, descendantPid: descendant, recordedState: ended.state, survivors: 0 };
  } finally {
    host.crash();
    cleanup(scratch.root);
  }
});

// F6-03 through the Engine. The launch refusal fails the attempt without any process; the workspace hold is released only on the Host's proof
// that the terminated tree ended. After the Engine and the Host restart, nothing is relaunched or adopted and the state stays consistent.
test('F6-03: after a failed running-record write the attempt fails closed, the hold waits for the Host proof, and a restart relaunches nothing', async () => {
  buildArtifacts();
  const scratch = newScratch('f6-engine');
  const hostA = await startCustodyHost(scratch.root, { testFailRunningRecordAfterMs: 2000 });
  const engineA = await startEngine(scratch.root, hostA, { fixtureStateDir: scratch.fixtureState });
  let hostB = null, engineB = null;
  try {
    const { runId } = await startAgentRun(engineA, { workflowId: 'f6-engine', model: 'custody-descendant', requestText: '[ticks=240]', workspaceCwd: scratch.workspace });
    const final = await waitForRunState(engineA, runId, SETTLED, 60_000);
    assert.equal(final, 'waiting_for_user', 'the attempt failed; the run awaits a decision');
    const attempt = agentAttempt(scratch.root, runId);
    assert.ok(attempt, 'the agent attempt exists');
    assert.equal(attempt.state, 'failed', 'no successful launch is recorded');
    assert.equal(attempt.process_id, null, 'the Engine never recorded a running process');
    const [{ pid: leader }] = readInvocations(scratch.fixtureState);
    const descendant = descendantPid(scratch.fixtureState);
    await eventually(() => !isAlive(leader) && (!descendant || !isAlive(descendant)), 'the terminated tree to end', 20_000, 100);
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the hold to be released on the Host proof', 30_000, 200);
    assert.equal(JSON.parse(released.evidence_json).hostState, 'spool_failed');

    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);
    hostA.crash();
    hostB = await startCustodyHost(scratch.root, { generation: 'gen-2' });
    engineB = await startEngine(scratch.root, hostB, { fixtureStateDir: scratch.fixtureState });
    await delay(4_000);
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'no duplicate provider invocation after the restart');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'failed', 'the failed attempt stays failed');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released', 'the released hold stays released');
    assert.equal(hostRecords(hostB).find(record => record.attemptId === attempt.id).state, 'spool_failed', 'the replacement Host keeps the recorded end');
    evidence.cases['F6-03'] = { runId, leaderPid: leader, descendantPid: descendant, attemptState: 'failed', holdAfter: 'released', invocations: 1 };
  } finally {
    engineA.kill();
    if (engineB) await engineB.stop();
    hostA.crash();
    if (hostB) hostB.crash();
    cleanup(scratch.root);
  }
});
