// PDE-R10: linked repair admission and recovery must compare effective filesystem roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fixtureAdapters, startTestRunner } from './helpers.mjs';

const CANDIDATE = createHash('sha256').update('PDE-R10 fixture candidate').digest('hex');
const CHECKPOINT = 'chk-pde-r10';

function workflow(workflowId, nodes, edges) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [
    { id: 'request', type: 'text', config: { value: `${workflowId} request` } }, ...nodes, { id: 'result', type: 'result-viewer', config: {} }], edges, after: [] };
}
const agent = (id, provider, model, extra = {}) => ({ id, type: 'agent', config: { provider, model, timeoutSeconds: 30, output: { format: 'text' }, ...extra } });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const parentWorkflow = () => workflow('pde-r10-parent', [agent('watcher', 'claude', 'fixture-fail')], [
  edge('request-watcher', 'request', 'text', 'watcher', 'prompt'), edge('watcher-result', 'watcher', 'text', 'result', 'value')]);
const repairWorkflow = () => workflow('pde-r10-repair', [agent('judge', 'codex', 'fixture-lifecycle-proposal', { role: 'judge' })], [
  edge('request-judge', 'request', 'text', 'judge', 'prompt'), edge('judge-result', 'judge', 'text', 'result', 'value')]);

async function register(api, id, cwd) {
  await mkdir(cwd, { recursive: true });
  const result = await api.call('PUT', `/api/v2/workspaces/${id}`, { cwd });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function startPausedParent(api, workspaceId) {
  const started = await api.run(parentWorkflow(), workspaceId);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await api.waitFor(started.body.run.runId, run => run.state === 'waiting_for_user');
  return started.body.run.runId;
}

async function savedRepair(api) {
  return api.save(repairWorkflow());
}

function linkBody(saved, repairWorkspaceId) {
  return { requestId: randomUUID(), failedNodeInstanceId: 'watcher', repairWorkflowId: saved.workflow.workflowId,
    repairWorkflowSnapshotSha256: saved.snapshotSha256, repairWorkspaceId, candidateDigest: CANDIDATE, continuationCheckpointId: CHECKPOINT };
}

async function rejectPair(api, saved, { name, parentPath, repairPath, sameId = false, missingRepair = false }) {
  const parentId = `pde-${name}-parent`;
  const repairId = sameId ? parentId : `pde-${name}-repair`;
  await register(api, parentId, parentPath);
  if (!sameId) await register(api, repairId, repairPath);
  const parentRunId = await startPausedParent(api, parentId);
  if (missingRepair) await rm(repairPath, { recursive: true, force: true });
  const beforeRuns = api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count;
  const beforeLinks = api.runner.engine.store.get('SELECT COUNT(*) AS count FROM run_links').count;
  const response = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, repairId));
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.ok(['workspace_overlap', 'workspace_unavailable'].includes(response.body.code), response.body.code);
  assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, beforeRuns, 'rejection creates no Repair Run');
  assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM run_links').count, beforeLinks, 'rejection creates no link');
  assert.equal(api.runner.engine.store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'waiting_for_user', 'the Parent stays suspended');
  assertNoResourceLocks(api.runner.engine, `rejected admission ${name}`);
  assertNoHostPermits(api.runner.engine, `rejected admission ${name}`);
  assertNoProviderProcess(api.runner.engine, parentRunId, `rejected admission ${name}`);
}

async function createDirectoryAlias(target, alias, type = process.platform === 'win32' ? 'junction' : 'dir') {
  await mkdir(target, { recursive: true });
  await symlink(target, alias, type);
}

async function retargetDirectoryAlias(alias, target) {
  await rm(alias, { recursive: true, force: true });
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
}

function assertNoResourceLocks(engine, context) {
  assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM resource_locks').count, 0, `${context}: no resource locks remain`);
}

function assertNoHostPermits(engine, context) {
  assert.equal(engine.hostAuthority, null, `${context}: this fixture Engine has no Host permit authority`);
  assert.equal(engine.hostPermitRuns.size, 0, `${context}: no Host/provider permit is associated with a Run`);
  assert.equal(engine.hostRuns.size, 0, `${context}: no Host-permitted Run remains owned`);
}

function assertNoProviderProcess(engine, runId, context) {
  assert.equal(engine.runProcesses(runId).length, 0, `${context}: no provider process is owned by the Run`);
}

test('PDE-R10-01..04, 09, 13: same-ID, identical, nested, and missing-root admissions fail closed', async () => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const root = name => join(scratch, name);
    await rejectPair(api, saved, { name: 'same-id', parentPath: root('same-id'), repairPath: root('same-id'), sameId: true });
    await rejectPair(api, saved, { name: 'same-root', parentPath: root('same-root'), repairPath: root('same-root') });
    await rejectPair(api, saved, { name: 'repair-child', parentPath: root('repair-child-parent'), repairPath: root('repair-child-parent/repair') });
    await rejectPair(api, saved, { name: 'parent-child', parentPath: root('parent-child-repair/parent'), repairPath: root('parent-child-repair') });
    await rejectPair(api, saved, { name: 'missing', parentPath: root('missing-parent'), repairPath: root('missing-repair'), missingRepair: true });
  } finally { await api.close(); }
});

test('PDE-R10-05, 13: admission rejects a symbolic-link alias to the Parent root', async t => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'alias-parent');
    const alias = join(scratch, 'alias-repair');
    try { await createDirectoryAlias(parentPath, alias, 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip(`Directory symbolic-link creation is unavailable here (${error.code}).`);
        return;
      }
      throw error;
    }
    await rejectPair(api, saved, { name: 'alias', parentPath, repairPath: alias });
  } finally { await api.close(); }
});

test('PDE-R10-06, 13: admission rejects a Windows junction alias to the Parent root', { skip: process.platform !== 'win32' }, async t => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'junction-parent');
    const alias = join(scratch, 'junction-repair');
    try { await createDirectoryAlias(parentPath, alias, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip(`Windows junction creation is unavailable here (${error.code}).`);
        return;
      }
      throw error;
    }
    await rejectPair(api, saved, { name: 'junction', parentPath, repairPath: alias });
  } finally { await api.close(); }
});

test('PDE-R10-07..08, 13: disjoint siblings and similar string prefixes are admitted', async () => {
  for (const [name, repairFolder] of [['siblings', 'repair'], ['prefix', 'project-repair']]) {
    const api = await startTestRunner();
    try {
      const saved = await savedRepair(api);
      const scratch = api.runner.connection.scratchRoot;
      const parentPath = join(scratch, name === 'prefix' ? 'project' : 'parent', '');
      const repairPath = join(scratch, name === 'prefix' ? repairFolder : repairFolder, '');
      const parentId = `pde-${name}-parent`;
      const repairId = `pde-${name}-repair`;
      await register(api, parentId, parentPath);
      await register(api, repairId, repairPath);
      const parentRunId = await startPausedParent(api, parentId);
      const engine = api.runner.engine;
      const startRun = engine.startRun.bind(engine);
      engine.startRun = () => {}; // Keep the captured repair queued so this case tests admission only.
      const response = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, repairId));
      assert.equal(response.status, 202, JSON.stringify(response.body));
      assert.equal(engine.store.get('SELECT state FROM run_links WHERE id = ?', response.body.linkId).state, 'open');
      assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', response.body.repairRunId).state, 'queued');
      assertNoResourceLocks(engine, `R10-${name}`);
      assertNoHostPermits(engine, `R10-${name}`);
      assertNoProviderProcess(engine, response.body.repairRunId, `R10-${name}`);
      engine.startRun = startRun;
    } finally { await api.close(); }
  }
});

test('PDE-R10-10, 13: root redirection before dispatch is refused before a CLI process starts', async () => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'dispatch-parent');
    const repairTarget = join(scratch, 'dispatch-repair-target');
    const alias = join(scratch, 'dispatch-repair-alias');
    await mkdir(parentPath, { recursive: true });
    await createDirectoryAlias(repairTarget, alias);
    await register(api, 'pde-dispatch-parent', parentPath);
    await register(api, 'pde-dispatch-repair', alias);
    const parentRunId = await startPausedParent(api, 'pde-dispatch-parent');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const response = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, 'pde-dispatch-repair'));
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await retargetDirectoryAlias(alias, parentPath);
    engine.startRun = startRun;
    engine.startRun();
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', response.body.repairRunId).state, 'failed');
    assert.equal(engine.store.get('SELECT state FROM run_links WHERE id = ?', response.body.linkId).state, 'repair_failed');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'waiting_for_user');
    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND invocation_artifact_id IS NOT NULL', response.body.repairRunId).count, 0);
    assert.equal(engine.store.get("SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND event_type = 'continuation.workspace_isolation_refused'", response.body.repairRunId).count, 1);
    assertNoResourceLocks(engine, 'R10 dispatch refusal');
    assertNoHostPermits(engine, 'R10 dispatch refusal');
    assertNoProviderProcess(engine, response.body.repairRunId, 'R10 dispatch refusal');
  } finally { await api.close(); }
});

test('PDE-R10-10, 13: a redirect during asynchronous preflight is refused at the shared process-launch boundary', async () => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'preflight-parent');
    const repairTarget = join(scratch, 'preflight-repair-target');
    const alias = join(scratch, 'preflight-repair-alias');
    await mkdir(parentPath, { recursive: true });
    await createDirectoryAlias(repairTarget, alias);
    await register(api, 'pde-preflight-parent', parentPath);
    await register(api, 'pde-preflight-repair', alias);
    const parentRunId = await startPausedParent(api, 'pde-preflight-parent');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const response = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, 'pde-preflight-repair'));
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const realReserve = engine.reserveHostProviderInvocation.bind(engine);
    const realLaunch = engine.launchContained.bind(engine);
    let redirected = false;
    let boundaryIssue = null;
    const launchTrace = [];
    engine.reserveHostProviderInvocation = async (...args) => {
      launchTrace.push('provider-permit-begin');
      if (!redirected) { redirected = true; await retargetDirectoryAlias(alias, parentPath); launchTrace.push('root-redirected'); }
      return realReserve(...args);
    };
    engine.launchContained = function (runId, options) {
      launchTrace.push('launch-boundary');
      boundaryIssue = this.linkedRepairWorkspaceIssueForRun(runId);
      return realLaunch(runId, options);
    };
    engine.startRun = startRun;
    engine.startRun();
    const settled = await api.waitFor(response.body.repairRunId, run => ['failed', 'succeeded', 'waiting_for_user'].includes(run.state));
    engine.reserveHostProviderInvocation = realReserve;
    engine.launchContained = realLaunch;
    assert.equal(settled.run.state, 'failed', JSON.stringify({ state: settled.run.state, redirected, boundaryIssue, launchTrace }));
    assert.equal(redirected, true, 'the redirect occurred after scheduler admission');
    assert.equal(boundaryIssue?.code, 'workspace_overlap', JSON.stringify({ boundaryIssue, launchTrace }));
    assert.equal(engine.store.get('SELECT state FROM run_links WHERE id = ?', response.body.linkId).state, 'repair_failed');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'waiting_for_user');
    const attempt = engine.store.get("SELECT state, process_id, started_at FROM attempts WHERE run_id = ? AND node_instance_id = 'judge'", response.body.repairRunId);
    assert.equal(attempt.state, 'blocked', JSON.stringify({ attempt, boundaryIssue, launchTrace }));
    assert.equal(attempt.process_id, null);
    assert.equal(attempt.started_at, null, 'the provider CLI did not start');
    assertNoResourceLocks(engine, 'R10 shared launch refusal');
    assertNoHostPermits(engine, 'R10 shared launch refusal');
    assertNoProviderProcess(engine, response.body.repairRunId, 'R10 shared launch refusal');
  } finally { await api.close(); }
});

test('Supplemental PDE-R10: same-Engine recovery methods refuse a stored link whose roots now overlap', async () => {
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'recovery-parent');
    const repairTarget = join(scratch, 'recovery-repair-target');
    const alias = join(scratch, 'recovery-repair-alias');
    await mkdir(parentPath, { recursive: true });
    await createDirectoryAlias(repairTarget, alias);
    await register(api, 'pde-recovery-parent', parentPath);
    await register(api, 'pde-recovery-repair', alias);
    const parentRunId = await startPausedParent(api, 'pde-recovery-parent');
    const engine = api.runner.engine;
    const startRun = engine.startRun.bind(engine);
    engine.startRun = () => {};
    const response = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, 'pde-recovery-repair'));
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await retargetDirectoryAlias(alias, parentPath);

    await engine.recover();
    const reconciliation = engine.reconcileContinuations();
    assert.ok(reconciliation.repairsFailed.includes(response.body.linkId));
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', response.body.repairRunId).state, 'interrupted');
    assert.equal(engine.store.get('SELECT state FROM run_links WHERE id = ?', response.body.linkId).state, 'repair_failed');
    assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'waiting_for_user');
    assert.equal(engine.store.get("SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", parentRunId).count, 0);
    engine.startRun = startRun;
  } finally { await api.close(); }
});

test('PDE-R10-11, 13: a fresh Engine refuses a persisted overlapping link during startup recovery', async () => {
  const first = await startTestRunner();
  let second;
  let firstClosed = false;
  const scratch = first.runner.connection.scratchRoot;
  const parentPath = join(scratch, 'fresh-recovery-parent');
  const repairTarget = join(scratch, 'fresh-recovery-repair-target');
  const alias = join(scratch, 'fresh-recovery-repair-alias');
  try {
    const saved = await savedRepair(first);
    await mkdir(parentPath, { recursive: true });
    await createDirectoryAlias(repairTarget, alias);
    await register(first, 'pde-fresh-recovery-parent', parentPath);
    await register(first, 'pde-fresh-recovery-repair', alias);
    const parentRunId = await startPausedParent(first, 'pde-fresh-recovery-parent');
    const firstEngine = first.runner.engine;
    firstEngine.startRun = () => {}; // Persist admission while the Repair remains queued and has no process.
    const response = await first.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, 'pde-fresh-recovery-repair'));
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const { linkId, repairRunId } = response.body;
    assert.equal(firstEngine.store.get('SELECT state FROM run_links WHERE id = ?', linkId).state, 'open');
    assert.equal(firstEngine.store.get('SELECT state FROM runs WHERE id = ?', repairRunId).state, 'queued');
    assert.equal(firstEngine.requireRun(parentRunId).state, 'waiting_for_user');
    assert.equal(firstEngine.store.get('SELECT COUNT(*) AS count FROM runs WHERE workflow_id = ?', saved.workflow.workflowId).count, 1,
      'the persisted link has exactly one captured Repair Run');
    assertNoProviderProcess(firstEngine, repairRunId, 'before first Engine shutdown');
    assertNoResourceLocks(firstEngine, 'before first Engine shutdown');
    assertNoHostPermits(firstEngine, 'before first Engine shutdown');

    // startTestRunner.close() shuts down the Engine, closes SQLite, and releases the runtime lock.
    await first.close();
    firstClosed = true;
    assert.equal(firstEngine.closing, true, 'the original Engine has stopped');
    assert.equal(firstEngine.processes.size, 0, 'the original Engine owns no remaining provider process');

    await retargetDirectoryAlias(alias, parentPath);

    let providerBuildInvocations = 0;
    const adapters = fixtureAdapters(join(first.root, 'fixture-state'));
    const buildInvocation = adapters.buildInvocation;
    adapters.buildInvocation = invocation => {
      providerBuildInvocations++;
      return buildInvocation(invocation);
    };
    // Reopen the exact same runtime root so this is a new Engine over the durable store, with normal initialize() recovery.
    second = await startTestRunner({ root: first.root, runner: { adapters } });
    const engine = second.runner.engine;
    assert.notEqual(engine.runtimeInstanceId, firstEngine.runtimeInstanceId, 'startup created a fresh Engine runtime generation');
    await new Promise(resolve => setImmediate(resolve)); // Let the normal startup scheduler turn run before checking launch evidence.

    const link = engine.store.get('SELECT * FROM run_links WHERE id = ?', linkId);
    assert.ok(link, 'the new Engine loaded the persisted linked relationship');
    assert.equal(link.state, 'repair_failed');
    assert.equal(link.parent_workspace_id, 'pde-fresh-recovery-parent');
    assert.equal(link.repair_workspace_id, 'pde-fresh-recovery-repair', 'workspace IDs and persisted bindings were left unchanged');
    assert.equal(engine.linkedRepairWorkspaceIssueForLink(link).code, 'workspace_overlap', 'fresh Engine resolves the retargeted alias to the Parent root');

    assert.equal(engine.requireRun(parentRunId).state, 'waiting_for_user', 'startup did not resume the original Parent');
    assert.equal(engine.requireRun(repairRunId).state, 'interrupted', 'the queued Repair is interrupted by ordinary restart recovery');
    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM run_links WHERE parent_run_id = ?', parentRunId).count, 1,
      'startup did not silently create a replacement Repair');
    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM runs WHERE workflow_id = ?', saved.workflow.workflowId).count, 1);
    assert.equal(engine.store.get("SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND event_type = 'continuation.parent_resumed'", parentRunId).count, 0);
    const refusal = engine.store.readEvents(repairRunId).find(event => event.type === 'continuation.workspace_isolation_refused');
    assert.equal(refusal?.payload.code, 'workspace_overlap', 'startup reconciliation recorded the physical-root refusal');
    assert.equal(refusal?.payload.origin, 'ENGINE');
    const attempt = engine.store.get("SELECT state, process_id, started_at, invocation_artifact_id FROM attempts WHERE run_id = ? AND node_instance_id = 'judge'", repairRunId);
    assert.ok(attempt, 'the captured Repair attempt remains auditable');
    assert.equal(attempt.state, 'canceled', 'recovery canceled the queued, unstarted provider attempt');
    assert.equal(attempt.process_id, null);
    assert.equal(attempt.started_at, null);
    assert.equal(attempt.invocation_artifact_id, null);
    assert.equal(providerBuildInvocations, 0, 'startup never prepared a provider invocation');
    assertNoProviderProcess(engine, repairRunId, 'after fresh-Engine recovery');
    assert.equal(engine.processes.size, 0, 'the fresh Engine owns no provider subprocess');
    assertNoResourceLocks(engine, 'after fresh-Engine recovery');
    assertNoHostPermits(engine, 'after fresh-Engine recovery');
  } finally {
    try { if (second) await second.close(); }
    finally {
      try { if (!firstClosed) await first.close(); }
      finally {
        await rm(alias, { recursive: true, force: true });
        await rm(first.root, { recursive: true, force: true });
      }
    }
  }
});

test('PDE-R10-12, 13: a disjoint Repair completes and continues the original Parent Run', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const parentPath = join(scratch, 'success-parent');
    const repairPath = join(scratch, 'success-repair');
    const parentId = 'pde-success-parent';
    const repairId = 'pde-success-repair';
    await register(api, parentId, parentPath);
    await register(api, repairId, repairPath);
    await writeFile(join(repairPath, 'candidate.json'), JSON.stringify({ candidateDigest: CANDIDATE, continuationCheckpointId: CHECKPOINT }));
    const parentWorkflowForSuccess = workflow('pde-r10-parent-success', [agent('watcher', 'claude', 'fixture-fail-once')], [
      edge('request-watcher', 'request', 'text', 'watcher', 'prompt'), edge('watcher-result', 'watcher', 'text', 'result', 'value')]);
    const parentStart = await api.run(parentWorkflowForSuccess, parentId);
    assert.equal(parentStart.status, 202, JSON.stringify(parentStart.body));
    const parentRunId = parentStart.body.run.runId;
    await api.waitFor(parentRunId, run => run.state === 'waiting_for_user');
    const saved = await savedRepair(api);
    const linked = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, linkBody(saved, repairId));
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    const repairRunId = linked.body.repairRunId;
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const operation = api.runner.engine.store.get('SELECT id FROM lifecycle_operations WHERE run_id = ?', repairRunId);
    assert.ok(operation, 'the Repair reached its lifecycle gate');
    const receipt = api.runner.engine.applyLifecycleReceipt(repairRunId, { requestId: randomUUID(), operationId: operation.id,
      candidateDigest: CANDIDATE, outcome: 'verified', receiptId: randomUUID() }, { hostAuthenticated: true, receiptEvidence: { fixtureHost: true } });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    assert.equal(api.runner.engine.store.get('SELECT state FROM run_links WHERE id = ?', linked.body.linkId).state, 'resumed');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs WHERE id = ?', parentRunId).count, 1, 'the same Parent Run continued');
    assert.equal(api.runner.engine.store.get("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND node_instance_id = 'watcher'", parentRunId).count, 2,
      'only the failed Parent node was retried');
    assertNoResourceLocks(api.runner.engine, 'R10 successful continuation');
    assertNoHostPermits(api.runner.engine, 'R10 successful continuation');
    assertNoProviderProcess(api.runner.engine, parentRunId, 'R10 successful continuation');
    assertNoProviderProcess(api.runner.engine, repairRunId, 'R10 successful continuation');
  } finally { await api.close(); }
});

test('PDE-R10 supplemental: Windows case and drive-variant paths resolve to the same root', async t => {
  if (process.platform !== 'win32') { t.skip('Windows path case behavior is platform-specific.'); return; }
  const api = await startTestRunner();
  try {
    const saved = await savedRepair(api);
    const root = join(api.runner.connection.scratchRoot, 'CaseRoot');
    await rejectPair(api, saved, { name: 'case-variant', parentPath: root, repairPath: join(api.runner.connection.scratchRoot, 'caseroot') });
    const driveVariant = root.replace(/^([A-Za-z]):/, (_, drive) => `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`);
    assert.notEqual(driveVariant, root, 'the drive-letter case representation changed');
    await rejectPair(api, saved, { name: 'drive-variant', parentPath: root, repairPath: driveVariant });
  } finally { await api.close(); }
});
