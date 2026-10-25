// Process Custody: proofs for the independent review's findings F1 and F4. Every proof uses the real Lifecycle Host, real Engine processes and
// the fixture CLI. An outage is injected only at the Engine's Host boundary (a file the Engine checks before each Host call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attemptsOf, buildArtifacts, cleanup, database, eventually, exited, hostRecords, isAlive, newScratch, readInvocations, runState, startAgentRun,
  startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const CONFLICT = /Another run is active in this workspace|A Host-owned process may still be running in this workspace/;
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-review.json'), JSON.stringify(evidence, null, 2));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function holdOf(root, attemptId) {
  const db = database(root);
  try { return db.prepare('SELECT state, evidence_json FROM custody_workspace_holds WHERE attempt_id = ?').get(attemptId) ?? null; } finally { db.close(); }
}

async function startRunning(engine, scratch, host, { workflowId, ticks }) {
  const { runId } = await startAgentRun(engine, { workflowId, model: 'custody-steady', requestText: `[ticks=${ticks}]`, workspaceCwd: scratch.workspace });
  const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), `run ${workflowId}: the CLI to start`, 60_000, 100);
  await eventually(() => hostRecords(host).find(record => record.attemptId === attempt.id && record.state === 'running'), 'the Host to run the CLI', 30_000, 100);
  return { runId, attempt };
}

// F1. An Engine started without Process Custody on a store that holds a live Host-owned process starts normally, settles nothing, and keeps
// the workspace held: it cannot reach the Host, so a conflicting run is refused. An Engine with Custody then completes the same CLI.
test('F1: an Engine without Process Custody keeps a Host-owned workspace held and starts normally', async () => {
  buildArtifacts();
  const scratch = newScratch('rv-f1');
  const host = await startCustodyHost(scratch.root);
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  let engineB = null, engineC = null;
  try {
    const nested = join(scratch.workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    const { runId, attempt } = await startRunning(engineA, scratch, host, { workflowId: 'rv-f1', ticks: 80 });
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);

    engineB = await startEngine(scratch.root, host, { custody: false, fixtureStateDir: scratch.fixtureState });
    await delay(3_000);
    assert.equal(exited(engineB.child), false, 'the Engine without Custody started and keeps running');
    assert.match(engineB.stderr(), /Process Custody is not enabled, but Host-owned processes/, 'it says why the workspace stays held');
    assert.equal(isAlive(attempt.process_id), true, 'the CLI runs on under the Host');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'held', 'the hold is kept');
    assert.equal(SETTLED.includes(await runState(engineB, runId)), false, 'nothing was settled');
    await assert.rejects(startAgentRun(engineB, { workflowId: 'rv-f1-nested', workspaceId: 'nested', model: 'custody-steady', requestText: '[ticks=2]', workspaceCwd: nested }),
      CONFLICT, 'a conflicting run is refused');
    await engineB.stop();

    engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineC, runId, SETTLED, 120_000);
    assert.equal(final, 'succeeded', 'an Engine with Custody completes the same CLI');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'nothing was launched again');
    assert.equal(holdOf(scratch.root, attempt.id).state, 'released');
    evidence.cases.F1 = { runId, cliPid: attempt.process_id, finalRunState: final };
  } finally {
    engineA.kill();
    if (engineB) engineB.kill();
    if (engineC) await engineC.stop();
    host.crash();
    cleanup(scratch.root);
  }
});

// F4. A Stop issued while the Host is unreachable is pending only in the Engine. When that Engine dies, the run is still stopping; its
// successor issues the Stop again once it attaches, so the CLI is stopped by the Host rather than left to run to its end.
test('F4: a Stop pending when its Engine dies is issued again by the successor', async () => {
  buildArtifacts();
  const scratch = newScratch('rv-f4');
  const host = await startCustodyHost(scratch.root);
  const flag = join(scratch.root, 'custody-outage.flag');
  const engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: flag } });
  let engineB = null;
  try {
    const { runId, attempt } = await startRunning(engineA, scratch, host, { workflowId: 'rv-f4', ticks: 200 });
    writeFileSync(flag, 'outage');
    const stop = await engineA.api('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202);
    await delay(3_000);
    assert.equal(isAlive(attempt.process_id), true, 'the Stop has not reached the Host');
    engineA.kill();
    await eventually(() => exited(engineA.child), 'Engine A to end', 20_000, 100);
    rmSync(flag, { force: true });

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const final = await waitForRunState(engineB, runId, SETTLED, 60_000);
    assert.equal(final, 'canceled', 'the successor completes the Stop');
    await eventually(() => !isAlive(attempt.process_id), 'the CLI to end', 30_000, 100);
    const released = await eventually(() => holdOf(scratch.root, attempt.id)?.state === 'released' ? holdOf(scratch.root, attempt.id) : null, 'the hold to be released', 30_000, 200);
    assert.equal(JSON.parse(released.evidence_json).hostState, 'stopped', 'the Host stopped the CLI; it did not run to its end');
    assert.equal(readInvocations(scratch.fixtureState).length, 1, 'nothing was launched again');
    evidence.cases.F4 = { runId, cliPid: attempt.process_id, finalRunState: final, holdEvidence: JSON.parse(released.evidence_json) };
  } finally {
    rmSync(flag, { force: true });
    engineA.kill();
    if (engineB) await engineB.stop();
    host.crash();
    cleanup(scratch.root);
  }
});
