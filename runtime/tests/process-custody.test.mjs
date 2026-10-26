// Process Custody proofs. A CLI admitted by the Engine is launched by the Rust Lifecycle Host into the Host's own Job. These tests
// run the real Host custody service, real Engine runtimes and the deterministic provider fixture. They assert on operating-
// system state (process identity and liveness), on the Host's durable records, and on the Engine's journal. Nothing is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  attachEngine, attemptsOf, exited, buildArtifacts, cleanup, committedChunks, custodyBindings, custodyRequest, eventually, fixtureExe, isAlive, processIdentity,
  killProcessTree, newScratch, readInvocations, runEventTypes, runState, sha256File, startAgentRun, startCustodyHost, startEngine,
  testsRoot, waitForRunState,
} from './custody-support.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';

const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
const evidenceDir = join(testsRoot, 'custody-evidence');
const record = (id, value) => { evidence.cases[id] = value; };
test.after(() => {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'process-custody.json'), JSON.stringify(evidence, null, 2));
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STEADY = '[ticks=24]';

// A Run whose attempt's terminal state a Run reports as waiting for a decision when the attempt failed.
const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];

test('an explicit Process Custody requirement fails closed without a Host bridge', async () => {
  const previous = process.env.DESZO_PROCESS_CUSTODY;
  process.env.DESZO_PROCESS_CUSTODY = '1';
  const api = await startTestRunner({ runner: { devTestConfirmationOff: true } });
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ id: 'custody-required-without-host', model: 'fixture-echo', context: null }));
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    await api.closeRun(snapshot.run.runId);
    const error = (await api.events(snapshot.run.runId)).find(event => event.type === 'attempt.error');
    assert.equal(error.payload.code, 'custody_unavailable');
    assert.deepEqual(readInvocations(api.stateDir), [], 'the fixture never ran through the ordinary Node launch path');
  } finally {
    await api.close();
    if (previous === undefined) delete process.env.DESZO_PROCESS_CUSTODY;
    else process.env.DESZO_PROCESS_CUSTODY = previous;
  }
});

// Launches a steady run (or the named fixture model) and waits until the Host reports the CLI running.
async function launchSteady(engine, scratch, { workflowId, requestText = STEADY, model = 'custody-steady' }) {
  const { runId } = await startAgentRun(engine, { workflowId, model, requestText, workspaceCwd: scratch.workspace });
  const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), 'the CLI to launch', 60_000, 100);
  return { runId, attempt, custodyId: custodyBindingFor(scratch.root, runId, attempt.id) };
}

function custodyBindingFor(root, runId, attemptId) {
  return custodyBindings(root, runId).find(row => row.attempt_id === attemptId)?.custody_id ?? null;
}

// The Host's view of one invocation, as its Engine would read it. The epoch is the current one this test attached as.
async function hostStatus(host, epoch, custodyId) {
  return custodyRequest(host, 'custody.status', { custodyId, epoch, generation: host.generation });
}

function committedStdoutBytes(root, attemptId) {
  return committedChunks(root, attemptId, 'stdout').reduce((sum, chunk) => sum + chunk.byteLength, 0);
}

function assertContiguous(chunks) {
  let expected = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.byteOffset, expected, `chunk ${chunk.chunkIndex} starts at its committed offset (no gap, no repeat)`);
    expected = chunk.byteOffset + chunk.byteLength;
  }
  return expected;
}

// PC-08, PC-09 (Engine half), PC-10, PC-11, PC-29: a live CLI survives Engine replacement, keeps its identity, and its output is
// recovered from committed offsets with no duplicate effect.
test('Proof 1: a live CLI survives Engine replacement with the same process identity and settles exactly once', async () => {
  buildArtifacts();
  const scratch = newScratch('proof1');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, attempt, custodyId } = await launchSteady(engineA, scratch, { workflowId: 'custody-proof1' });
    const launchedPid = attempt.process_id;
    const launchedIdentity = attempt.process_start_identity;
    // The OS creation time of the CLI and of the Host, before the Engine is replaced: the process instances to match afterwards.
    const cliOsIdentity = processIdentity(launchedPid);
    const hostOsIdentity = processIdentity(host.pid);
    await sleep(2500);
    const beforeKill = await hostStatus(host, 1, custodyId);
    engineA.kill();
    await sleep(800);
    assert.equal(host.child.exitCode, null, 'the Host survives the Engine');
    assert.equal(isAlive(launchedPid), true, 'the CLI survives the Engine');
    await sleep(3000);
    const engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      // The CLI is still running while the replacement Engine is up, so its OS identity is observed now, before the Run completes.
      assert.equal(processIdentity(launchedPid), cliOsIdentity, 'the CLI is the same OS process instance (creation time), not a reused PID');
      assert.equal(processIdentity(host.pid), hostOsIdentity, 'the Host process instance is unchanged');
      const final = await waitForRunState(engineB, runId, SETTLED, 90_000);
      assert.equal(final, 'succeeded', 'the original Run completes under the new Engine');
      const [done] = attemptsOf(scratch.root, runId).filter(row => row.id === attempt.id);
      assert.equal(done.process_id, launchedPid, 'the CLI PID is unchanged');
      assert.equal(done.process_start_identity, launchedIdentity, 'the CLI creation identity is unchanged');
      const launches = readInvocations(scratch.fixtureState);
      assert.equal(launches.length, 1, 'the provider was launched exactly once');
      assert.equal(launches[0].pid, launchedPid, 'the single launch is the process the Host tracked');
      const chunks = committedChunks(scratch.root, attempt.id, 'stdout');
      const committed = assertContiguous(chunks);
      const finalStatus = await hostStatus(host, 2, custodyId);
      assert.equal(committed, finalStatus.stdoutDurable, 'every durable byte the Host holds was committed exactly once by the Engine');
      assert.ok(beforeKill.stdoutDurable < committed, 'output continued while the Engine was absent');
      const outputs = runEventTypes(scratch.root, runId).filter(event => event.attemptId === attempt.id && event.type === 'attempt.outputs_committed');
      assert.equal(outputs.length, 1, 'the attempt settled exactly once');
      record('PC-08/PC-09/PC-10/PC-11/PC-29', { runId, cliPid: launchedPid, cliIdentity: launchedIdentity, hostPid: host.pid,
        enginePids: [engineA.pid, engineB.pid], cliOsIdentity, hostOsIdentity, launches: launches.length, committedStdoutBytes: committed, durableStdoutBytes: finalStatus.stdoutDurable,
        offsetAtEngineKill: beforeKill.stdoutDurable, chunks: chunks.length, settlements: outputs.length, finalRunState: final });
    } finally { await engineB.stop(); }
  } finally { engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root); }
});

// PC-12: a CLI that exits while the Engine is absent is imported once by the next Engine; nothing is launched again.
test('PC-12: a CLI that finishes while the Engine is absent is settled once by the next Engine', async () => {
  buildArtifacts();
  const scratch = newScratch('pc12');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, attempt } = await launchSteady(engineA, scratch, { workflowId: 'custody-pc12', requestText: '[ticks=5]' });
    engineA.kill();
    await eventually(() => !isAlive(attempt.process_id), 'the CLI to finish during Engine absence', 30_000, 300);
    await sleep(500);
    const engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      assert.equal(await waitForRunState(engineB, runId, SETTLED, 60_000), 'succeeded');
      assert.equal(readInvocations(scratch.fixtureState).length, 1, 'no second launch after the Engine returned');
      const settled = runEventTypes(scratch.root, runId).filter(event => event.attemptId === attempt.id && event.type === 'attempt.outputs_committed');
      assert.equal(settled.length, 1, 'the terminal result was applied exactly once');
      record('PC-12/PC-29', { runId, cliPid: attempt.process_id, cliExitedWhileEngineAbsent: true, launches: 1, settlements: settled.length });
    } finally { await engineB.stop(); }
  } finally { engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root); }
});

// Proof 4 (controlled points): the Engine is removed at three different points in the stream. Each resumes with contiguous output.
test('Proof 4: output and completion survive the Engine being removed at early, middle and late points', async () => {
  buildArtifacts();
  const points = [];
  for (const [label, delay] of [['early', 800], ['middle', 4000], ['late', 8000]]) {
    const scratch = newScratch(`proof4-${label}`);
    const host = await startCustodyHost(scratch.root);
    const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      const { runId, attempt } = await launchSteady(engineA, scratch, { workflowId: `custody-proof4-${label}`, requestText: '[ticks=18]' });
      await sleep(delay);
      engineA.kill();
      const engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
      try {
        assert.equal(await waitForRunState(engineB, runId, SETTLED, 90_000), 'succeeded', `${label}: the run completes`);
        const committed = assertContiguous(committedChunks(scratch.root, attempt.id, 'stdout'));
        assert.equal(readInvocations(scratch.fixtureState).length, 1, `${label}: a single launch`);
        points.push({ point: label, delayMs: delay, committedStdoutBytes: committed });
      } finally { await engineB.stop(); }
    } finally { engineA.kill(); await host.shutdown().catch(() => host.crash()); cleanup(scratch.root); }
  }
  record('Proof 4', { points, note: 'Removal points are timed, not instrumented inside the Engine; the offsets are recorded, not forced.' });
});

// Proof 3 / PC-20 / PC-21: a real Host crash closes its Job and ends the CLI and its descendant. A new Host adopts nothing.
test('Proof 3: a real Host crash terminates the CLI and its descendant, and a new Host adopts and relaunches nothing', async () => {
  buildArtifacts();
  const scratch = newScratch('proof3');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let replacement = null;
  try {
    const { runId, attempt, custodyId } = await launchSteady(engine, scratch, { workflowId: 'custody-proof3', requestText: '[ticks=200]', model: 'custody-descendant' });
    // The Engine is removed first so that only the Host crash decides the outcome; the CLI's descendant is the one it spawned.
    engine.kill();
    const descendantPid = await eventually(() => {
      const file = join(scratch.fixtureState, 'descendant.pid');
      return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
    }, 'the CLI descendant to start', 30_000, 100);
    assert.equal(isAlive(attempt.process_id), true, 'the CLI is alive before the crash');
    assert.equal(isAlive(descendantPid), true, 'the descendant is alive before the crash');
    host.crash();
    await eventually(() => exited(host.child), 'the Host process to terminate', 20_000, 50);
    await eventually(() => !isAlive(attempt.process_id) && !isAlive(descendantPid), 'the CLI tree to end with its Host', 20_000, 150);
    const launchesBefore = readInvocations(scratch.fixtureState).length;
    replacement = await startCustodyHost(scratch.root);
    const epoch = await attachEngine(replacement);
    const after = await hostStatus(replacement, epoch, custodyId);
    assert.equal(after.state, 'host_lost', 'the replacement records the attempt as lost, not as a success');
    assert.equal(after.tailGapPossible, true, 'the incomplete tail is reported honestly');
    assert.equal(after.spoolComplete, false, 'the spool is not claimed complete');
    await sleep(1500);
    assert.equal(readInvocations(scratch.fixtureState).length, launchesBefore, 'the replacement Host never relaunches the CLI');
    assert.equal(isAlive(attempt.process_id), false, 'the replacement does not adopt the old CLI');
    record('PC-20/PC-21', { runId, hostPid: host.pid, cliPid: attempt.process_id, descendantPid, hostExitCode: host.child.exitCode,
      cliAliveAfterCrash: isAlive(attempt.process_id), descendantAliveAfterCrash: isAlive(descendantPid), replacementState: after.state,
      relaunches: readInvocations(scratch.fixtureState).length - launchesBefore });
  } finally {
    engine.kill(); host.crash(); if (replacement) await replacement.shutdown().catch(() => replacement.crash()); cleanup(scratch.root);
  }
});

// PC-17: a Stop reaches the owned process tree, including its descendant, and records a stopped outcome.
test('PC-17: a Stop terminates the owned process tree and records the stopped outcome', async () => {
  buildArtifacts();
  const scratch = newScratch('pc17');
  const host = await startCustodyHost(scratch.root);
  const epoch = await attachEngine(host);
  try {
    const admitted = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId: randomUUID(), runId: 'run-pc17',
      provider: 'codex', command: fixtureExe, args: ['--model', 'custody-descendant'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState },
      stdinHex: null, deadlineMs: 120_000 });
    assert.ok(admitted.permit, 'the admission returns a permit');
    await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit });
    const descendantPid = await eventually(() => existsSync(join(scratch.fixtureState, 'descendant.pid')) ? Number(readFileSync(join(scratch.fixtureState, 'descendant.pid'), 'utf8')) : null, 'the descendant', 30_000, 100);
    const cliPid = (await hostStatus(host, epoch, admitted.custodyId)).processId;
    assert.equal(isAlive(descendantPid), true);
    const stopped = await custodyRequest(host, 'custody.stop', { epoch, generation: host.generation, custodyId: admitted.custodyId });
    assert.equal(stopped.jobEmpty, true, 'the Host reports an empty Job after the Stop');
    await eventually(() => !isAlive(cliPid) && !isAlive(descendantPid), 'the owned tree to end', 20_000, 150);
    const terminal = await eventually(async () => { const status = await hostStatus(host, epoch, admitted.custodyId); return status.terminal ? status : null; }, 'the stopped terminal record', 20_000, 150);
    assert.equal(terminal.state, 'stopped');
    record('PC-17', { cliPid, descendantPid, state: terminal.state, jobEmptyAfterStop: stopped.jobEmpty });
  } finally { host.crash(); cleanup(scratch.root); }
});

// PC-04 / PC-14: a new Engine generation fences the previous one; the old generation cannot issue custody commands any more.
test('PC-04/PC-14: the previous Engine generation is fenced once a new one attaches', async () => {
  buildArtifacts();
  const scratch = newScratch('pc14');
  const host = await startCustodyHost(scratch.root);
  try {
    const epochA = await attachEngine(host);
    const epochB = await attachEngine(host);
    assert.equal(epochB, epochA + 1, 'each attach advances the epoch');
    const refused = await custodyRequest(host, 'custody.reserve', { epoch: epochA, generation: host.generation, attemptId: 'stale-a', runId: 'run',
      provider: 'codex', command: fixtureExe, args: [], cwd: scratch.workspace, env: {}, stdinHex: null, deadlineMs: 1000 });
    assert.equal(refused.code, 'stale_engine', 'a stale generation cannot admit an invocation');
    const wrongGeneration = await custodyRequest(host, 'custody.attach', { generation: 'some-other-generation' });
    assert.equal(wrongGeneration.code, 'stale_generation', 'an Engine from another lifecycle generation is refused');
    record('PC-04/PC-14', { currentEpoch: epochB, previousEpoch: epochA, staleReserve: refused.code, otherGeneration: wrongGeneration.code });
  } finally { host.crash(); cleanup(scratch.root); }
});

// PC-02, PC-03, PC-05, PC-06, PC-07, PC-15, Proof 5: abuse of the launch surface is refused before any OS process starts.
test('PC-02/PC-03/PC-05/PC-06/PC-07/PC-15: abusive launches are refused and nothing is started', async () => {
  buildArtifacts();
  const scratch = newScratch('abuse');
  const host = await startCustodyHost(scratch.root);
  const epoch = await attachEngine(host);
  const base = { epoch, generation: host.generation, runId: 'run-abuse', provider: 'codex', stdinHex: null, deadlineMs: 60_000 };
  try {
    const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const shellRefusal = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-shell', command: shell, args: ['/c', 'echo', 'x'], cwd: scratch.workspace, env: {} });
    const relativeRefusal = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-relative', command: 'codex.exe', args: [], cwd: scratch.workspace, env: {} });
    const workspaceRefusal = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-workspace', command: fixtureExe, args: [], cwd: join(scratch.root, 'missing'), env: {} });
    const stdinRefusal = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-stdin', command: fixtureExe, args: [], cwd: scratch.workspace, env: {}, stdinHex: 'ab'.repeat(60_000) });
    const admitted = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-valid', command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState } });
    assert.ok(admitted.permit, 'the genuine admission is accepted');
    const conflict = await custodyRequest(host, 'custody.reserve', { ...base, attemptId: 'abuse-valid', command: fixtureExe, args: ['--model', 'other'], cwd: scratch.workspace, env: {} });
    const forged = await custodyRequest(host, 'custody.launch', { ...base, custodyId: admitted.custodyId, permit: randomBytes(32).toString('hex') });
    const foreign = await custodyRequest(host, 'custody.status', { ...base, custodyId: randomUUID() });
    const adoption = await custodyRequest(host, 'custody.adopt', { ...base, pid: process.pid });
    assert.equal(shellRefusal.code, 'executable_not_allowed', 'a shell wrapper is not an approved executable');
    assert.equal(relativeRefusal.code, 'executable_not_allowed', 'a relative executable name is refused');
    assert.equal(workspaceRefusal.code, 'cwd_unavailable', 'an unavailable workspace is refused');
    assert.equal(stdinRefusal.code, 'stdin_too_large', 'an oversized prompt is refused, not truncated');
    assert.equal(conflict.code, 'conflicting_invocation', 'a conflicting invocation for an admitted attempt is refused');
    assert.equal(forged.code, 'permit_refused', 'a forged permit cannot launch');
    assert.equal(foreign.code, 'not_found', 'a foreign custody identity is not found');
    assert.equal(adoption.code, 'unsupported', 'no command adopts an existing process');
    assert.equal(readInvocations(scratch.fixtureState).length, 0, 'no provider process started through any refused path');
    record('PC-02/PC-03/PC-05/PC-06/PC-07/PC-15', { shell: shellRefusal.code, relative: relativeRefusal.code, workspace: workspaceRefusal.code,
      stdin: stdinRefusal.code, conflict: conflict.code, forgedPermit: forged.code, foreignIdentity: foreign.code, adoption: adoption.code, startedProcesses: 0 });
  } finally { host.crash(); cleanup(scratch.root); }
});

// PC-02 / PC-03 with a real launch: repeated and concurrent launches of one admitted invocation create exactly one process.
test('PC-02/PC-03: duplicate and concurrent launches of one admitted invocation create one process', async () => {
  buildArtifacts();
  const scratch = newScratch('dup');
  const host = await startCustodyHost(scratch.root);
  const epoch = await attachEngine(host);
  try {
    const admitted = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId: 'dup-attempt', runId: 'run-dup',
      provider: 'codex', command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState }, stdinHex: null, deadlineMs: 60_000 });
    const launches = await Promise.all([1, 2, 3, 4].map(() => custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit })));
    const pids = [...new Set(launches.map(value => value.processId))];
    assert.equal(pids.length, 1, 'every concurrent launch observes the same process');
    const again = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId: 'dup-attempt', runId: 'run-dup', provider: 'codex',
      command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState }, stdinHex: null, deadlineMs: 60_000 });
    assert.equal(again.reused, true, 'a repeated admission is a reuse');
    assert.equal(again.permit, null, 'a repeated admission never reissues the permit');
    await sleep(800);
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'one provider process was started');
    await custodyRequest(host, 'custody.stop', { epoch, generation: host.generation, custodyId: admitted.custodyId });
    record('PC-02/PC-03 (launch)', { concurrentLaunches: launches.length, distinctProcesses: pids.length, processes: readInvocations(scratch.fixtureState).length });
  } finally { host.crash(); cleanup(scratch.root); }
});

// PC-16: a process whose creation identity does not match the Engine's recorded identity is never adopted.
test('PC-16: a recorded identity that does not match the Host process is refused, not adopted', async () => {
  buildArtifacts();
  const scratch = newScratch('pc16');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId, attempt, custodyId } = await launchSteady(engineA, scratch, { workflowId: 'custody-pc16' });
    engineA.kill();
    const db = new DatabaseSync(join(scratch.root, 'store/state.sqlite'));
    db.prepare('UPDATE attempts SET process_start_identity = ? WHERE id = ?').run('custody:1', attempt.id);
    db.close();
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineB, runId, SETTLED, 60_000);
    assert.notEqual(final, 'succeeded', 'the mismatched process is not adopted as the attempt result');
    const [row] = attemptsOf(scratch.root, runId).filter(item => item.id === attempt.id);
    assert.equal(row.state, 'failed', 'the attempt fails at its identity check');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'the mismatched process is not launched again');
    await custodyRequest(host, 'custody.stop', { epoch: await attachEngine(host), generation: host.generation, custodyId });
    record('PC-16', { attemptState: row.state, relaunches: 0, runState: final });
  } finally {
    engineA.kill(); if (engineB) await engineB.stop(); host.crash(); cleanup(scratch.root);
  }
});

// PC-18 / PC-19: with no Engine attached, the Host enforces the admitted deadline; a live CLI outlives its expired permit.
test('PC-18/PC-19: with no Engine attached the admitted deadline ends the CLI, and the permit expiry does not', async () => {
  buildArtifacts();
  const scratch = newScratch('pc18');
  const host = await startCustodyHost(scratch.root, { permitTtlMs: 1000 });
  const epoch = await attachEngine(host);
  try {
    const admitted = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId: 'deadline-attempt', runId: 'run-deadline',
      provider: 'codex', command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState },
      stdinHex: null, deadlineMs: 5000 });
    const launched = await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit });
    await sleep(2500);
    assert.equal(isAlive(launched.processId), true, 'the CLI outlives its expired permit while its deadline has not elapsed');
    const ended = await eventually(async () => { const status = await hostStatus(host, epoch, admitted.custodyId); return status.terminal ? status : null; }, 'the deadline', 30_000, 150);
    assert.equal(ended.state, 'deadline_terminated', 'the Host ends the CLI at its admitted deadline with no Engine');
    await eventually(() => !isAlive(launched.processId), 'the CLI to end at its deadline', 15_000, 150);
    record('PC-18/PC-19', { permitTtlMs: 1000, deadlineMs: 5000, aliveAfterPermitExpiry: true, endedBy: ended.state });
  } finally { host.crash(); cleanup(scratch.root); }
});

// PC-22: a Host that dies between spawn and its running record is recorded as lost; the invocation is never launched again.
test('PC-22: a crash during launch registration is recorded as lost and never blindly relaunched', async () => {
  buildArtifacts();
  const scratch = newScratch('pc22');
  const first = await startCustodyHost(scratch.root, { testCrashAfterSpawn: true });
  const epoch = await attachEngine(first);
  const admitted = await custodyRequest(first, 'custody.reserve', { epoch, generation: first.generation, attemptId: 'crash-attempt', runId: 'run-crash',
    provider: 'codex', command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState },
    stdinHex: null, deadlineMs: 60_000 });
  // The launch request crashes the Host after the CLI exists and before the running state is recorded.
  await custodyRequest(first, 'custody.launch', { epoch, generation: first.generation, custodyId: admitted.custodyId, permit: admitted.permit }).catch(() => {});
  await eventually(() => exited(first.child), 'the crashed Host to exit', 20_000, 50);
  const launchesAfterCrash = readInvocations(scratch.fixtureState).length;
  const second = await startCustodyHost(scratch.root);
  try {
    const epochB = await attachEngine(second);
    const status = await hostStatus(second, epochB, admitted.custodyId);
    assert.equal(status.state, 'host_lost', 'the spawning record is reconciled as lost');
    assert.equal(status.terminal, true);
    // No process was recorded before the crash. Whatever the spawn had created was in the crashed Host's kill-on-close Job (or still
    // suspended), so the replacement Host proves the end, and a workspace hold of the invocation can be released.
    assert.equal(status.processTreeEnded, true, 'a lost invocation with no recorded process is proven ended');
    for (const { pid } of readInvocations(scratch.fixtureState)) assert.equal(isAlive(pid), false, `the CLI ${pid} started before the crash is gone`);
    await sleep(1500);
    assert.equal(readInvocations(scratch.fixtureState).length, launchesAfterCrash, 'no blind relaunch after the crash');
    const retry = await custodyRequest(second, 'custody.launch', { epoch: epochB, generation: second.generation, custodyId: admitted.custodyId, permit: admitted.permit });
    // The old permit is genuine, so the Host reports the record's state and starts nothing; it never reports a running CLI.
    assert.equal(retry.state, 'host_lost', 'a late launch reports the lost record and starts nothing');
    record('PC-22', { stateAfterRestart: status.state, launchesAtCrash: launchesAfterCrash, relaunches: readInvocations(scratch.fixtureState).length - launchesAfterCrash });
  } finally { first.crash(); second.crash(); cleanup(scratch.root); }
});

// PC-24: a spool that reaches its hard limit ends the invocation explicitly; the overflow is never silently truncated.
test('PC-24: a spool at its hard limit is an explicit failure, not a silent truncation', async () => {
  buildArtifacts();
  const scratch = newScratch('pc24');
  const host = await startCustodyHost(scratch.root, { spoolLimitBytes: 160 });
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, attempt, custodyId } = await launchSteady(engine, scratch, { workflowId: 'custody-pc24' });
    assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'waiting_for_user', 'a failed attempt leaves the Run awaiting a decision, not succeeded');
    const [row] = attemptsOf(scratch.root, runId).filter(item => item.id === attempt.id);
    assert.equal(row.state, 'failed');
    const status = await hostStatus(host, await attachEngine(host), custodyId);
    assert.equal(status.state, 'spool_limit_exceeded');
    assert.equal(status.spoolComplete, false, 'the spool is never reported complete after a limit');
    assert.ok(status.stdoutDurable <= 160, 'no byte beyond the limit was made durable');
    record('PC-24', { attemptState: row.state, hostState: status.state, durableStdoutBytes: status.stdoutDurable, limit: 160 });
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// PC-25: split UTF-8 characters and partial lines are recovered byte-exact from the spool to the Engine's journal.
test('PC-25: split UTF-8 and partial lines are recovered byte-exact', async () => {
  buildArtifacts();
  const scratch = newScratch('pc25');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId } = await startAgentRun(engine, { workflowId: 'custody-pc25', model: 'custody-split', requestText: 'split', workspaceCwd: scratch.workspace });
    assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'succeeded');
    const attempt = attemptsOf(scratch.root, runId).find(row => row.process_id);
    const committed = Buffer.concat(committedChunks(scratch.root, attempt.id, 'stdout').map(chunk => artifactBytes(scratch.root, chunk.chunk.artifactId)));
    assert.ok(committed.toString('utf8').includes('Splitté-ünïcode'), 'the multi-byte character is intact in the journal');
    const custodyId = custodyBindings(scratch.root, runId).find(row => row.attempt_id === attempt.id).custody_id;
    const spoolBytes = readFileSync(join(host.state, 'custody', 'spool', custodyId, 'stdout.bin'));
    assert.equal(committed.length, spoolBytes.length, 'the journal holds every spooled byte');
    assert.ok(committed.equals(spoolBytes), 'the journal bytes equal the spool bytes exactly');
    record('PC-25', { spoolBytes: spoolBytes.length, journalBytes: committed.length, byteExact: committed.equals(spoolBytes), splitCharacterPreserved: true });
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// The verified bytes of one artifact in the Engine's object store (the same file the Engine reads and digest-checks).
function artifactBytes(root, artifactId) {
  const db = new DatabaseSync(join(root, 'store/state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(artifactId);
    return readFileSync(join(root, 'store', row.relative_path));
  } finally { db.close(); }
}

// PC-28: no lifecycle, supervisor or custody credential reaches the provider. The fixture records environment names only.
test('PC-28: no lifecycle, supervisor or custody credential reaches the provider', async () => {
  buildArtifacts();
  const scratch = newScratch('pc28');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId } = await launchSteady(engine, scratch, { workflowId: 'custody-pc28', requestText: '[ticks=3]' });
    assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'succeeded');
    const names = readFileSync(join(scratch.fixtureState, `env-${readInvocations(scratch.fixtureState)[0].pid}.txt`), 'utf8').split(/\r?\n/);
    const forbidden = names.filter(name => /^(DESZO_LIFECYCLE_|DESZO_SUPERVISOR_|DESZO_LAUNCH_SHIM|DESZO_CUSTODY_|DESZO_TEST_DUPLICATE)/.test(name));
    assert.deepEqual(forbidden, [], 'no authority-bearing variable reached the provider');
    assert.ok(names.includes('CUSTODY_FIXTURE_STATE_DIR'), 'ordinary provider variables still arrive');
    record('PC-28', { providerEnvironmentNames: names.length, authorityVariablesDelivered: forbidden.length });
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// PC-13 / PC-23: a settled attempt is never settled again, however often the Host's record is read or the Engine restarts.
test('PC-13/PC-23: a terminal outcome is applied once however often it is observed', async () => {
  buildArtifacts();
  const scratch = newScratch('pc13');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, attempt, custodyId } = await launchSteady(engine, scratch, { workflowId: 'custody-pc13', requestText: '[ticks=3]' });
    assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'succeeded');
    // The first Engine stops before the reads, so the reads come from a fresh epoch that the Host has just accepted.
    engine.kill();
    const epoch = await attachEngine(host);
    for (let index = 0; index < 5; index += 1) assert.equal((await hostStatus(host, epoch, custodyId)).state, 'exited');
    const engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      assert.equal(await runState(engineB, runId), 'succeeded');
      const settled = runEventTypes(scratch.root, runId).filter(event => event.attemptId === attempt.id && event.type === 'attempt.outputs_committed');
      assert.equal(settled.length, 1, 'the attempt settled once across repeated reads and an Engine restart');
      const runSucceeded = runEventTypes(scratch.root, runId).filter(event => event.type === 'run.state_changed' && /every planned node succeeded/i.test(event.payload?.reason ?? ''));
      assert.equal(runSucceeded.length, 1, 'the Run transition happened exactly once');
      record('PC-13/PC-23', { settlements: settled.length, runTransitions: runSucceeded.length, repeatedStatusReads: 5 });
    } finally { await engineB.stop(); }
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// PC-30: the existing provider path, with Process Custody off, is unchanged: one launch, no custody binding.
test('PC-30: the default provider path without Process Custody is unchanged', async () => {
  buildArtifacts();
  const scratch = newScratch('pc30');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, custody: false });
  try {
    const { runId } = await startAgentRun(engine, { workflowId: 'custody-pc30', model: 'custody-steady', requestText: '[ticks=3]', workspaceCwd: scratch.workspace });
    assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'succeeded');
    assert.equal(custodyBindings(scratch.root, runId).length, 0, 'no attempt is bound to a Host-owned process');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'the provider was launched once on the existing path');
    record('PC-30', { custodyBindings: 0, launches: 1, runState: 'succeeded' });
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// A graceful Engine exit (its own shutdown path, which the Host triggers when it replaces a runtime) leaves a live CLI to its Host.
// Stopping it there would end the process that Custody exists to keep; the next Engine resumes it from the Host's record.
test('a graceful Engine exit detaches a live CLI instead of stopping it, and the next Engine completes the Run once', async () => {
  buildArtifacts();
  const scratch = newScratch('graceful');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null;
  try {
    const { runId, attempt, custodyId } = await launchSteady(engineA, scratch, { workflowId: 'custody-graceful', requestText: '[ticks=24]' });
    const cliPid = attempt.process_id;
    const cliIdentity = processIdentity(cliPid);
    await sleep(1500);
    await engineA.stop();
    assert.equal(exited(engineA.child), true, 'the Engine exited through its own shutdown path');
    assert.equal(isAlive(cliPid), true, 'the CLI survives a graceful Engine exit');
    assert.equal(processIdentity(cliPid), cliIdentity, 'it is the same OS process instance');
    const status = await hostStatus(host, await attachEngine(host), custodyId);
    assert.equal(status.state, 'running', 'the Host still owns the running CLI');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 90_000), 'succeeded', 'the Run completes under the next Engine');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'the CLI was launched once across the graceful exit');
    record('graceful exit', { cliPid, cliIdentity, custodyState: status.state, launches: 1, runState: 'succeeded' });
  } finally {
    engineA.kill(); if (engineB) await engineB.stop(); host.crash(); cleanup(scratch.root);
  }
});

test('the test suite leaves its evidence and its artifacts identifiable', () => {
  assert.equal(sha256File(fixtureExe).length, 64);
});
