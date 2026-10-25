// Process Custody workspace isolation (PC-26, PC-27). Linked Parent and Repair roots must never run a Host-owned CLI together
// when they overlap, and must run normally when they are disjoint. These tests use the real Rust Host custody service, real
// Engine processes and the provider fixture. The boundary test drives the production launch path directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { custodyBridgeFromEnvironment } from '../host/lifecycleBridge.mjs';
import { startTestRunner } from './helpers.mjs';
import {
  agentDefinition, attemptsOf, buildArtifacts, cleanup, custodyBindings, eventually, fixtureExe, hostRecords, newScratch, publishDefinition,
  readInvocations, registerWorkspace, retargetJunction, runEventTypes, runState, setCodexCapacity, startCustodyHost, startEngine,
  startPublishedRun, testsRoot, waitForRunState, committedChunks, database,
} from './custody-support.mjs';
import { writeFileSync } from 'node:fs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const CANDIDATE = createHash('sha256').update('process-custody linked repair candidate').digest('hex');
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-audit.json'), JSON.stringify(evidence, null, 2));
});

// A linked Repair is admitted for a Parent whose watcher has failed (so the Parent waits for a decision).
async function linkedRepair(engine, { parentRun, repairPublication, repairWorkspace }) {
  const link = await engine.api('POST', `/api/v2/runs/${parentRun}/linked-repair`, { requestId: randomUUID(), failedNodeInstanceId: 'watcher',
    repairWorkflowId: repairPublication.workflow.workflowId, repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId: repairWorkspace,
    candidateDigest: CANDIDATE, continuationCheckpointId: 'chk-process-custody-pc26' });
  return link;
}

async function parentWaitingForDecision(engine, scratch, parentWorkspace) {
  const publication = await publishDefinition(engine, agentDefinition({ workflowId: `pc-parent-${randomUUID().slice(0, 8)}`, nodeId: 'watcher',
    model: 'custody-exit', requestText: '[code=3]' }));
  const runId = await startPublishedRun(engine, publication, parentWorkspace);
  assert.equal(await waitForRunState(engine, runId, SETTLED, 60_000), 'waiting_for_user', 'the Parent waits for a decision after its watcher fails');
  return runId;
}

// PC-26 (end to end): a Repair whose root is redirected into its Parent's root by a junction is refused before any Custody
// admission or provider process, while the Parent stays suspended and the Host holds no record for the Repair.
test('PC-26: a Repair whose root overlaps its Parent is refused before any Custody admission or provider process', async () => {
  buildArtifacts();
  const scratch = newScratch('pc26');
  const linked = join(scratch.root, 'linked');
  const parentPath = join(linked, 'parent');
  const blockerPath = join(linked, 'blocker');
  const repairTarget = join(linked, 'repair-target');
  const repairAlias = join(linked, 'repair-alias');
  mkdirSync(repairTarget, { recursive: true });
  mkdirSync(parentPath, { recursive: true });
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    await registerWorkspace(engine, 'parent', parentPath);
    await registerWorkspace(engine, 'blocker', blockerPath);
    retargetJunction(repairAlias, repairTarget);
    await registerWorkspace(engine, 'repair', repairAlias);
    await setCodexCapacity(engine, { codex: 1, global: 2 });
    const parentRun = await parentWaitingForDecision(engine, scratch, 'parent');
    // The blocker holds the only Codex slot, so the Repair's agent cannot dispatch until the overlap is in place.
    const blocker = await publishDefinition(engine, agentDefinition({ workflowId: 'pc26-blocker', model: 'custody-steady', requestText: '[ticks=60]' }));
    const blockerRun = await startPublishedRun(engine, blocker, 'blocker');
    await eventually(() => attemptsOf(scratch.root, blockerRun).some(row => row.process_id), 'the blocker CLI to hold the slot', 60_000, 100);
    const repairPublication = await publishDefinition(engine, agentDefinition({ workflowId: 'pc26-repair', nodeId: 'judge', model: 'custody-echo', requestText: 'repair', role: 'judge' }));
    const link = await linkedRepair(engine, { parentRun, repairPublication, repairWorkspace: 'repair' });
    assert.equal(link.status, 202, `the disjoint link is admitted: ${JSON.stringify(link.body)}`);
    const repairRun = link.body.repairRunId;
    assert.equal(await runState(engine, repairRun) === 'failed', false, 'the Repair has not failed before the overlap appears');
    // The overlap appears while the Repair is still waiting for capacity: the alias now points at the Parent's root.
    retargetJunction(repairAlias, parentPath);
    assert.equal(await waitForRunState(engine, blockerRun, SETTLED, 90_000), 'succeeded', 'the blocker finishes and frees the slot');
    assert.equal(await waitForRunState(engine, repairRun, SETTLED, 90_000), 'failed', 'the overlapping Repair fails');
    const refusals = runEventTypes(scratch.root, repairRun).filter(event => event.type === 'continuation.workspace_isolation_refused');
    assert.ok(refusals.length >= 1, 'the isolation refusal is recorded on the Repair Run');
    assert.equal(refusals[0].payload.code, 'workspace_overlap');
    assert.equal(custodyBindings(scratch.root, repairRun).length, 0, 'no Custody attempt is bound to the refused Repair');
    assert.equal(attemptsOf(scratch.root, repairRun).filter(row => row.process_id).length, 0, 'no provider process was ever recorded for the Repair');
    assert.equal(hostRecords(host).filter(record => record.runId === repairRun).length, 0, 'the Host holds no admission for the refused Repair');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-echo').length, 0, 'no provider invocation of the Repair started');
    assert.equal(await runState(engine, parentRun), 'waiting_for_user', 'the Parent stays suspended');
    const db = database(scratch.root);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_locks').get().n, 0, 'no resource lock remains');
    } finally { db.close(); }
    const linkState = (() => { const d = database(scratch.root); try { return d.prepare('SELECT state FROM run_links WHERE id = ?').get(link.body.linkId).state; } finally { d.close(); } })();
    evidence.cases['PC-26'] = { level: 'end-to-end: real Host, Engine process, junction alias', parentRun, repairRun, blockerRun, refusalCode: refusals[0].payload.code,
      custodyBindings: 0, hostRecordsForRepair: 0, providerInvocationsForRepair: 0, parentState: 'waiting_for_user', linkState };
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// PC-26 (launch boundary): the Custody launch path itself refuses an overlapping workspace, before admission. The check is the
// production one; the test only makes the overlap present at the moment of launch, against the real Host.
test('PC-26 boundary: the Custody launch path refuses an overlapping linked workspace before the Host admits anything', async () => {
  buildArtifacts();
  const scratch = newScratch('pc26-boundary');
  const host = await startCustodyHost(scratch.root);
  const api = await startTestRunner({});
  try {
    const engine = api.runner.engine;
    engine.custodyHost = custodyBridgeFromEnvironment({ DESZO_CUSTODY_ADDRESS: host.address, DESZO_CUSTODY_CAPABILITY: host.capability, DESZO_CUSTODY_GENERATION: host.generation });
    await engine.custodyAttach();
    engine.linkedRepairWorkspaceIssueForRun = () => ({ code: 'workspace_overlap', message: 'The Repair Workspace overlaps the Parent Workspace.' });
    const runId = `run-pc26-boundary-${randomUUID().slice(0, 8)}`;
    const child = engine.launchCustody(runId, { id: `attempt-pc26-${randomUUID().slice(0, 8)}` }, { command: fixtureExe, args: ['--model', 'custody-steady'],
      cwd: scratch.workspace, env: { PATH: process.env.PATH }, stdin: '' }, { provider: 'codex', deadlineMs: 30_000 });
    const error = await new Promise(resolve => child.once('error', resolve));
    assert.equal(error.code, 'workspace_overlap', 'the Custody launch path applies the linked-repair boundary');
    assert.equal(child.pid, null, 'no process identity was ever recorded');
    assert.equal(hostRecords(host).filter(record => record.runId === runId).length, 0, 'the Host never admitted the refused launch');
    assert.equal(readInvocations(scratch.fixtureState).length, 0, 'no provider process started');
    evidence.cases['PC-26 boundary'] = { level: 'real Host custody service, production launch path', refusalCode: error.code, hostAdmissions: 0, processes: 0 };
  } finally { await api.close(); host.crash(); cleanup(scratch.root); }
});

// PC-27: a physically disjoint Repair, whose name shares a text prefix with its Parent's, is admitted and its CLI runs under
// Custody to a recorded terminal settlement. No isolation refusal occurs.
test('PC-27: a disjoint linked Repair with a similar-prefix name is admitted and runs under Custody to settlement', async () => {
  buildArtifacts();
  const scratch = newScratch('pc27');
  const prefix = join(scratch.root, 'prefix');
  const parentPath = join(prefix, 'ws');
  const repairPath = join(prefix, 'ws-repair');
  mkdirSync(parentPath, { recursive: true });
  mkdirSync(repairPath, { recursive: true });
  const host = await startCustodyHost(scratch.root);
  const engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
  try {
    await registerWorkspace(engine, 'parent', parentPath);
    await registerWorkspace(engine, 'repair', repairPath);
    const parentRun = await parentWaitingForDecision(engine, scratch, 'parent');
    const repairPublication = await publishDefinition(engine, agentDefinition({ workflowId: 'pc27-repair', nodeId: 'judge', model: 'custody-echo', requestText: 'repair', role: 'judge' }));
    const link = await linkedRepair(engine, { parentRun, repairPublication, repairWorkspace: 'repair' });
    assert.equal(link.status, 202, `the disjoint link is admitted: ${JSON.stringify(link.body)}`);
    const repairRun = link.body.repairRunId;
    const repairState = await waitForRunState(engine, repairRun, SETTLED, 90_000);
    const refusals = runEventTypes(scratch.root, repairRun).filter(event => event.type === 'continuation.workspace_isolation_refused');
    assert.equal(refusals.length, 0, 'no isolation refusal is recorded for a disjoint Repair');
    const bindings = custodyBindings(scratch.root, repairRun);
    assert.equal(bindings.length, 1, 'the Repair judge is bound to one Host-owned process');
    const attempt = attemptsOf(scratch.root, repairRun).find(row => row.id === bindings[0].attempt_id);
    const journal = runEventTypes(scratch.root, repairRun).filter(event => event.type !== 'attempt.log_chunk' && event.type !== 'attempt.log_stream_closed').map(event => event.type + ':' + String(event.payload?.reason ?? event.payload?.message ?? event.payload?.code ?? '').slice(0, 160));
    // The Custody CLI ran to exit and its output reached the Judge contract, which then settled the attempt. That contract (a lifecycle
    // proposal) is outside this isolation test; the settlement is recorded, not hidden.
    assert.equal(attempt.state, 'failed', 'the Repair judge settled through its own contract after its Custody-owned CLI ran');
    assert.ok(journal.includes('attempt.state_changed:CLI process launched.'), 'the CLI launched under Custody');
    assert.ok(journal.some(item => item.startsWith('attempt.error:The designated Judge of a linked repair must state exactly one lifecycle proposal')), 'the settlement reason is the Judge contract, not isolation');
    const record = hostRecords(host).find(item => item.custodyId === bindings[0].custody_id);
    assert.equal(record.state, 'exited', 'the Host recorded the normal exit');
    assert.equal(record.spoolComplete, true, 'the Host spool is complete');
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-echo').length, 1, 'the Repair judge launched exactly once');
    const durable = committedChunks(scratch.root, attempt.id, 'stdout').reduce((sum, chunk) => sum + chunk.byteLength, 0);
    assert.equal(durable, record.stdoutDurable, 'the Engine committed every byte the Host spooled');
    const linkState = (() => { const d = database(scratch.root); try { return d.prepare('SELECT state FROM run_links WHERE id = ?').get(link.body.linkId).state; } finally { d.close(); } })();
    // The failed Repair attempt leaves its Run awaiting a decision and its link open; the isolation check did not change the link.
    assert.equal(linkState, 'open', 'the link stays open, as for any failed Repair attempt awaiting a decision');
    evidence.cases['PC-27'] = { level: 'end-to-end: real Host, Engine process, disjoint similar-prefix roots', parentRun, repairRun, repairState,
      custodyId: bindings[0].custody_id, cliPid: attempt.process_id, cliIdentity: attempt.process_start_identity, hostRecordState: record.state,
      spoolComplete: record.spoolComplete, committedStdoutBytes: durable, hostStdoutDurable: record.stdoutDurable, linkState };
  } finally { engine.kill(); host.crash(); cleanup(scratch.root); }
});

// Scope of Process Custody (regression for two review findings): a Map-step attempt is never Host-owned, and a Custody-scoped
// attempt never falls back to an ordinary launch when the Host is unavailable. These run the production Engine's decisions.
test('Custody scope excludes Map-step attempts and fails closed when the Host is unavailable', async () => {
  const api = await startTestRunner({});
  try {
    const engine = api.runner.engine;
    engine.custodyHost = custodyBridgeFromEnvironment({ DESZO_CUSTODY_ADDRESS: '127.0.0.1:9', DESZO_CUSTODY_CAPABILITY: 'a'.repeat(64), DESZO_CUSTODY_GENERATION: 'gen' });
    const node = { id: 'agent', config: { provider: 'codex' } };
    const plain = { mapped: false, taskExecutionId: undefined, loops: [] };
    assert.equal(engine.custodyScopeAllows(node, plain), true, 'a plain top-level agent is in scope');
    assert.equal(engine.custodyScopeAllows(node, { ...plain, mapped: true }), false, 'a Map step is outside Custody scope');
    assert.equal(engine.custodyScopeAllows(node, { ...plain, loops: [{}] }), false, 'a loop body is outside Custody scope');
    assert.equal(engine.custodyEligible(node, plain), true);
    engine.custodyUnavailable = 'Process Custody is unavailable: test';
    assert.equal(engine.custodyScopeAllows(node, plain), true, 'the scope itself is unchanged');
    assert.equal(engine.custodyEligible(node, plain), false, 'an unavailable Host is not eligible; the attempt fails rather than falling back');
    engine.custodyHost = null;
    engine.custodyUnavailable = null;
  } finally { await api.close(); }
});
