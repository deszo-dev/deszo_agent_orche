// Process Custody H3: a workspace stays held while a Host-owned CLI may still run in it. Every proof uses the real Lifecycle Host, real Engine
// processes and the deterministic fixture CLI. An outage is injected only at the Engine's Host boundary (a file the Engine checks before each
// Host call): the Host keeps running, and so does the CLI under it. Replacement and crash proofs stop real processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attemptsOf, buildArtifacts, cleanup, custodyRequest, database, eventually, exited, fixtureExe, hostRecords, isAlive, newScratch, readInvocations,
  retargetJunction, runState, setCodexCapacity, startAgentRun, startCustodyHost, startEngine, attachEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-workspace-hold.json'), JSON.stringify(evidence, null, 2));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The durable workspace holds of one store, read directly (the Engine may be running or stopped).
function holds(root) {
  const db = database(root);
  try {
    return db.prepare('SELECT custody_id, attempt_id, run_id, workspace_root, state, evidence_json FROM custody_workspace_holds ORDER BY held_at').all();
  } finally { db.close(); }
}

function holdOf(root, attemptId) {
  return holds(root).find(row => row.attempt_id === attemptId) ?? null;
}

// Starts one run that runs the fixture CLI for `ticks` half-seconds, and returns once the CLI is running under the Host.
async function startRunning(engine, scratch, host, { workflowId, ticks, workspaceId = 'main', workspaceCwd = scratch.workspace }) {
  const { runId } = await startAgentRun(engine, { workflowId, model: 'custody-steady', requestText: `[ticks=${ticks}]`, workspaceId, workspaceCwd });
  const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), `run ${workflowId}: the CLI to start`, 60_000, 100);
  await eventually(() => hostRecords(host).find(record => record.attemptId === attempt.id && record.state === 'running'),
    `run ${workflowId}: the Host to report the CLI running`, 30_000, 100);
  return { runId, attempt };
}

// Refused conflicting admissions surface as a 409 with the workspace message; a rejection is the proof that nothing was admitted.
const CONFLICT = /Another run is active in this workspace|A Host-owned process may still be running in this workspace/;

// H3-01 to H3-03, H3-07 to H3-10, H3-21, H3-22. One CLI runs through a short outage, then through an outage longer than 30 seconds
// (the boundary at which the previous implementation settled the attempt and released the workspace). During the long outage the CLI is
// alive, the run is not settled, the workspace hold is held, and conflicting Runs in the same, nested and aliased workspaces are refused
// while a disjoint workspace is admitted. When the Host answers again the original attempt reconciles and completes once.
test('H3-01 to H3-03, H3-07 to H3-10, H3-21, H3-22: an unreachable Host never releases a workspace whose CLI may still run', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-outage');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-outage.flag');
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: flag } });
  try {
    await setCodexCapacity(engine, { codex: 3, global: 6 });
    const nested = join(scratch.workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    const alias = join(scratch.root, 'alias-of-workspace');
    retargetJunction(alias, scratch.workspace);
    const disjoint = join(scratch.root, 'disjoint');
    mkdirSync(disjoint, { recursive: true });

    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'h3-main', ticks: 150 });
    const held = await eventually(() => holdOf(scratch.root, attempt.id), 'the workspace hold to be durable', 10_000, 100);
    assert.equal(held.state, 'held', 'the hold is held while the CLI runs');

    // H3-01: an outage shorter than 30 seconds.
    writeFileSync(flag, 'outage');
    await delay(8_000);
    assert.equal(await runState(engine, runId), 'running', 'a short outage does not settle the run');
    rmSync(flag, { force: true });
    await delay(3_000);

    // H3-02: an outage longer than 30 seconds, with the CLI alive throughout.
    writeFileSync(flag, 'outage');
    await delay(35_000);
    assert.equal(isAlive(attempt.process_id), true, 'the CLI is alive during the outage');
    assert.equal(exited(host.child), false, 'the Host is alive during the outage');
    assert.equal(await runState(engine, runId), 'running', 'the run is not settled as interrupted during the outage');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'running', 'the attempt stays running');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the workspace stays held during the outage');

    // H3-07: a conflicting Run in the same workspace is refused while the original run is active.
    await assert.rejects(startAgentRun(engine, { workflowId: 'h3-same', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: scratch.workspace }), CONFLICT);
    // H3-08: a conflicting Run in a nested directory of the held workspace is refused.
    await assert.rejects(startAgentRun(engine, { workflowId: 'h3-nested', workspaceId: 'nested', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: nested }), CONFLICT);
    // H3-09: a conflicting Run through a junction alias of the held workspace is refused.
    await assert.rejects(startAgentRun(engine, { workflowId: 'h3-alias', workspaceId: 'alias', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: alias }), CONFLICT);
    // H3-10: a physically disjoint workspace is admitted and runs while the held one is still unresolved.
    const disjointRun = await startAgentRun(engine, { workflowId: 'h3-disjoint', workspaceId: 'disjoint', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: disjoint });
    assert.ok(disjointRun.runId, 'the disjoint run was admitted');
    evidence.cases['H3-07/08/09/10'] = { outageSeconds: 35, heldAttempt: attempt.id, runId, disjointRunId: disjointRun.runId, cliPid: attempt.process_id };

    // H3-03 and H3-22: the Host answers again; the original attempt reconciles and completes exactly once.
    rmSync(flag, { force: true });
    const final = await waitForRunState(engine, runId, SETTLED, 180_000);
    assert.equal(final, 'succeeded', 'the original run completes after the Host answers again');
    assert.equal(await waitForRunState(engine, disjointRun.runId, SETTLED, 120_000), 'succeeded', 'the disjoint run completes');
    const invocations = readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id);
    assert.equal(invocations.length, 1, 'the CLI ran exactly once: no duplicate invocation');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released', 'the hold is released only after the Host proved the process tree ended');
    assert.equal(JSON.parse(holdOf(scratch.root, attempt.id).evidence_json).processTreeEnded, true, 'the release evidence is the Host proof');
    evidence.cases['H3-02/03/22'] = { outageSeconds: 35, finalRunState: final, cliInvocations: invocations.length, holdAfter: 'released' };
  } finally {
    rmSync(flag, { force: true });
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-11, H3-04. The Host launches the CLI, then the launch reply is lost. The Engine asks again with the same permit and the Host returns
// the existing record: no second spawn, no stop of a CLI the Engine has not heard from, and the original attempt continues.
test('H3-11: a lost launch reply after the Host launched the CLI continues the original attempt without a second spawn', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-launch-reply');
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_DROP_LAUNCH_REPLY: '1' } });
  try {
    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'h3-launch-reply', ticks: 6 });
    const final = await waitForRunState(engine, runId, SETTLED, 120_000);
    assert.equal(final, 'succeeded', 'the attempt the lost reply belonged to completes; it was not stopped or relaunched');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'succeeded');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'one process was created for the attempt');
    assert.equal(hostRecords(host).filter(record => record.attemptId === attempt.id).length, 1, 'one admission for the attempt');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released', 'the hold is released after the CLI ended');
    evidence.cases['H3-11'] = { runId, cliPid: attempt.process_id, finalRunState: final, processCreations: 1, admissions: 1 };
  } finally {
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-12 and H3-13. A repeated launch with the admission's permit returns the existing process and starts nothing. A launch with any other
// permit is refused deterministically.
test('H3-12/H3-13: a repeated identical launch starts nothing, and a conflicting launch is refused', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-idempotent');
  const host = await startCustodyHost(scratch.root);
  try {
    const epoch = await attachEngine(host);
    const admitted = await custodyRequest(host, 'custody.reserve', { epoch, generation: host.generation, attemptId: 'h3-12', runId: 'run-h3-12',
      provider: 'codex', command: fixtureExe, args: ['--model', 'custody-steady'], cwd: scratch.workspace, env: { PATH: process.env.PATH, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState },
      stdinHex: null, deadlineMs: 60_000 });
    const first = await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit });
    assert.equal(first.state, 'running');
    const again = await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: admitted.permit });
    assert.equal(again.processId, first.processId, 'the repeated launch returns the same process');
    assert.equal(again.processCreationTime, first.processCreationTime, 'the repeated launch returns the same process instance');
    const conflicting = await custodyRequest(host, 'custody.launch', { epoch, generation: host.generation, custodyId: admitted.custodyId, permit: 'not-the-permit' });
    assert.equal(conflicting.refused, true, 'a conflicting launch is refused');
    assert.equal(conflicting.code, 'permit_refused');
    await eventually(() => readInvocations(scratch.fixtureState).length >= 1, 'the single CLI to run', 30_000, 100);
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === first.processId).length, 1, 'one process was created');
    await custodyRequest(host, 'custody.stop', { epoch, generation: host.generation, custodyId: admitted.custodyId });
    evidence.cases['H3-12/13'] = { processId: first.processId, identicalRelaunchStartedNothing: true, conflictingLaunch: conflicting.code };
  } finally {
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-05, H3-06. The Engine dies while the Host is unreachable and the CLI keeps running. The hold is durable, a new Engine on the same store
// reconstructs it, refuses a conflicting Run, and then completes the original attempt once.
test('H3-05/H3-06: an Engine that dies during an outage leaves the workspace held, and its successor reconstructs the hold', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-engine-death');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-outage.flag');
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: flag } });
  let engineB = null;
  try {
    await setCodexCapacity(engineA, { codex: 3, global: 6 });
    const nested = join(scratch.workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    const { runId, attempt } = await startRunning(engineA, scratch, host, { workflowId: 'h3-death', ticks: 60 });
    writeFileSync(flag, 'outage');
    await delay(3_000);
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end during the outage', 20_000, 100);
    rmSync(flag, { force: true });
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the hold survives the Engine that took it');
    assert.equal(isAlive(attempt.process_id), true, 'the CLI keeps running with no Engine attached');

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await setCodexCapacity(engineB, { codex: 3, global: 6 });
    assert.equal(await runState(engineB, runId), 'running', 'the successor resumes the run, it does not settle it');
    await assert.rejects(startAgentRun(engineB, { workflowId: 'h3-nested-b', workspaceId: 'nested', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: nested }), CONFLICT,
      'the successor refuses a conflicting run in a nested directory of the held workspace');
    const final = await waitForRunState(engineB, runId, SETTLED, 180_000);
    assert.equal(final, 'succeeded');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'the CLI was never relaunched');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released');
    evidence.cases['H3-05/06'] = { runId, cliPid: attempt.process_id, finalRunState: final, holdAfter: 'released' };
  } finally {
    rmSync(flag, { force: true });
    engineA.kill();
    if (engineB) await engineB.stop();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-16. A Stop issued while the Host is unreachable is held by the Engine and delivered when the Host answers. The run ends only after the
// Host confirms the process tree ended, and the hold is released on that confirmation.
test('H3-16: an authorized Stop waits for the unreachable Host and releases the workspace only after the process tree ended', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-stop');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-outage.flag');
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: flag } });
  try {
    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'h3-stop', ticks: 120 });
    writeFileSync(flag, 'outage');
    const stop = await engine.api('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, 'the Stop is accepted');
    await delay(6_000);
    assert.equal(isAlive(attempt.process_id), true, 'the Stop is not delivered while the Host is unreachable; the CLI still runs');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held');
    rmSync(flag, { force: true });
    const final = await waitForRunState(engine, runId, SETTLED, 90_000);
    assert.equal(final, 'canceled', 'the Stop completes once the Host has it');
    await eventually(() => !isAlive(attempt.process_id), 'the CLI to end', 30_000, 100);
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the hold to be released', 30_000, 200);
    assert.equal(JSON.parse(released.evidence_json).processTreeEnded, true, 'the release follows the Host proof that the tree ended');
    evidence.cases['H3-16'] = { runId, cliPid: attempt.process_id, finalRunState: final, holdEvidence: JSON.parse(released.evidence_json) };
  } finally {
    rmSync(flag, { force: true });
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-04. The CLI finishes while the Host is unreachable. The Engine cannot read the end, so it settles nothing and keeps the hold; when the
// Host answers, the terminal evidence is reconciled once and the hold is released.
test('H3-04: a CLI that finishes during an outage has its terminal evidence reconciled once, when the Host answers', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-exit-outage');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-outage.flag');
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: flag } });
  try {
    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'h3-exit-outage', ticks: 20 });
    writeFileSync(flag, 'outage');
    await eventually(() => !isAlive(attempt.process_id), 'the CLI to finish during the outage', 60_000, 100);
    await delay(6_000);
    assert.equal(await runState(engine, runId), 'running', 'the Engine does not settle an outcome it cannot read');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the hold is kept until the Host reports the end');
    rmSync(flag, { force: true });
    const final = await waitForRunState(engine, runId, SETTLED, 120_000);
    assert.equal(final, 'succeeded', 'the terminal evidence is reconciled once the Host answers');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'the CLI ran exactly once');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released', 'the hold is released on the Host proof');
    evidence.cases['H3-04'] = { runId, cliPid: attempt.process_id, finalRunState: final, holdAfter: 'released' };
  } finally {
    rmSync(flag, { force: true });
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-17, H3-18. A real Host crash ends the CLI and its descendant. The workspace stays held while no Host can prove the end; the replacement
// Host proves it from the recorded process instance, and only then is the workspace available. The original attempt is not relaunched.
test('H3-17/H3-18: after a real Host crash the workspace is released only on the replacement Host proof that the process tree ended', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-host-death');
  const hostA = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, hostA, { fixtureStateDir: scratch.fixtureState });
  let engineB = null, hostB = null;
  try {
    const { runId, attempt } = await startRunning(engineA, scratch, hostA, { workflowId: 'h3-host-death', ticks: 200 });
    const descendantPid = await eventually(() => {
      const file = join(scratch.fixtureState, 'descendant.pid');
      return existsDescendant(file);
    }, 'the CLI descendant to start', 30_000, 100).catch(() => null);
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);
    hostA.crash();
    await eventually(() => exited(hostA.child), 'the Host process to terminate', 20_000, 50);
    await eventually(() => !isAlive(attempt.process_id) && (descendantPid === null || !isAlive(descendantPid)), 'the CLI tree to end with its Host', 20_000, 150);
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'no Host can prove the end yet: the hold is kept');

    hostB = await startCustodyHost(scratch.root, { generation: 'gen-2' });
    engineB = await startEngine(scratch.root, hostB, { fixtureStateDir: scratch.fixtureState });
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null,
      'the replacement Host to prove the end and the hold to be released', 60_000, 200);
    const proof = JSON.parse(released.evidence_json);
    assert.equal(proof.processTreeEnded, true);
    assert.equal(proof.hostState, 'host_lost', 'the proof comes from the replacement Host reconciling the lost invocation');
    // The release is committed before the attempt's settlement; the settlement is awaited, not read at the instant of the release.
    const settled = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state === 'interrupted' ? 'interrupted' : null,
      'the lost attempt to settle', 60_000, 200);
    assert.equal(settled, 'interrupted', 'the lost attempt is interrupted, never recorded as succeeded');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'the lost CLI was never relaunched');

    // The lost run awaits its operator decision in its own workspace record (an existing policy), so the physical directory is proven
    // available through a second workspace record for the same directory: only the durable hold could refuse it.
    const next = await startAgentRun(engineB, { workflowId: 'h3-after-release', workspaceId: 'after-release', model: 'custody-steady', requestText: '[ticks=4]', workspaceCwd: scratch.workspace });
    assert.equal(await waitForRunState(engineB, next.runId, SETTLED, 120_000), 'succeeded', 'the workspace is available again after the proof');
    evidence.cases['H3-17/18'] = { hostPid: hostA.pid, cliPid: attempt.process_id, descendantPid, replacementHostPid: hostB.pid,
      holdEvidence: proof, lostAttemptState: 'interrupted', nextRunState: 'succeeded' };
  } finally {
    engineA.kill();
    if (engineB) await engineB.stop();
    hostA.crash();
    if (hostB) hostB.crash();
    cleanup(scratch.root);
  }
});

function existsDescendant(file) {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// H3-23. The launch permit expires while the CLI runs. The permit gated the launch only; the process and the hold are unaffected.
test('H3-23: the launch permit expiring while the CLI runs does not release the workspace', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-permit');
  const host = await startCustodyHost(scratch.root, { permitTtlMs: 1000 });
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    const { runId, attempt } = await startRunning(engine, scratch, host, { workflowId: 'h3-permit', ticks: 16 });
    await delay(3_000);
    assert.equal(isAlive(attempt.process_id), true, 'the CLI runs after its permit expired');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the hold is held while the CLI runs');
    assert.equal(await waitForRunState(engine, runId, SETTLED, 120_000), 'succeeded');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released');
    evidence.cases['H3-23'] = { runId, cliPid: attempt.process_id, permitTtlMs: 1000 };
  } finally {
    engine.kill();
    host.crash();
    cleanup(scratch.root);
  }
});

// H3-20. The Engine dies at the instant it is about to release the hold, after the Host proved the process tree ended. The hold is not lost,
// and the successor releases it once and completes the attempt.
test('H3-20: an Engine that dies during the release transaction leaves a durable hold that its successor releases exactly once', async () => {
  buildArtifacts();
  const scratch = newScratch('h3-release-crash');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_FAULT: 'before_hold_release' } });
  let engineB = null;
  try {
    const { runId, attempt } = await startRunning(engineA, scratch, host, { workflowId: 'h3-release-crash', ticks: 4 });
    await eventually(() => exited(engineA.child), 'Engine A to end at the release point', 60_000, 100);
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the release did not commit');
    assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attempt.id).state, 'running', 'the attempt is not settled before its hold is released');
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, SETTLED, 120_000), 'succeeded');
    const released = holds(scratch.root).filter(row => row.attempt_id === attempt.id && row.state === 'released');
    assert.equal(released.length, 1, 'the hold is released exactly once');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1, 'the CLI was not relaunched');
    evidence.cases['H3-20'] = { runId, cliPid: attempt.process_id, releasesCommitted: released.length };
  } finally {
    engineA.kill();
    if (engineB) await engineB.stop();
    host.crash();
    cleanup(scratch.root);
  }
});
