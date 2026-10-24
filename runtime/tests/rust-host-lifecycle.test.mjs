// Proof A: a compiled Rust Host owns and replaces the real Node/Engine runtime without restarting itself.
// The test harness receives an ephemeral first-party setup token by direct inherited stdout for pre-restart
// fixture setup; Rust Host never reads that stream. After the restart this test performs GET-only observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const repo = resolve(import.meta.dirname, '../..');
const testsRoot = join(repo, '.deszo/tests');
const hostExe = join(repo, 'lifecycle-host/target/debug', process.platform === 'win32' ? 'deszo-lifecycle-host.exe' : 'deszo-lifecycle-host');
const CHECKPOINT_ID = 'chk-host-proof-a-checkpoint';

const agent = (id, provider, model, extra = {}) => ({ id, type: 'agent', config: { provider, model, timeoutSeconds: 120, output: { format: 'text' }, ...extra } });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const workflow = (workflowId, nodes, edges) => ({ schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [{ id: 'request', type: 'text', config: { value: `${workflowId} request` } }, ...nodes, { id: 'result', type: 'result-viewer', config: {} }], edges, after: [] });
const parentWorkflow = () => workflow('parent-host-proof', [
  agent('developer', 'codex', 'fixture-echo'), agent('watcher', 'claude', 'fixture-fail-once'), agent('judge', 'codex', 'fixture-echo'),
], [edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-result', 'judge', 'text', 'result', 'value')]);
const repairWorkflow = () => workflow('repair-host-proof', [
  agent('developer', 'codex', 'fixture-echo'), agent('watcher', 'claude', 'fixture-echo'), agent('judge', 'codex', 'fixture-lifecycle-proposal', { role: 'judge' }), agent('finalize', 'claude', 'fixture-echo'),
], [edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-finalize', 'judge', 'text', 'finalize', 'prompt'), edge('finalize-result', 'finalize', 'text', 'result', 'value')]);

async function copyRuntimePackage(root, buildId, marker) {
  await mkdir(root, { recursive: true });
  await cp(join(repo, 'runtime'), join(root, 'runtime'), { recursive: true });
  await cp(join(repo, 'mcp'), join(root, 'mcp'), { recursive: true });
  await cp(join(repo, 'shared'), join(root, 'shared'), { recursive: true });
  await cp(join(repo, 'docs/authoring'), join(root, 'docs/authoring'), { recursive: true });
  await cp(join(repo, 'docs/schemas'), join(root, 'docs/schemas'), { recursive: true });
  await cp(join(repo, 'docs/storage'), join(root, 'docs/storage'), { recursive: true });
  for (const name of ['m1-context-chain', 'reference-delivery', 'managed-task']) {
    const source = join(repo, 'docs/examples', name);
    await cp(source, join(root, 'docs/examples', name), { recursive: true });
  }
  await writeFile(join(root, 'build.json'), JSON.stringify({ schemaVersion: 1, buildId, runtimeApiVersion: 2, bootstrap: 'runtime', marker }));
}

function hostProcess(configPath, { expectSetupToken = true } = {}) {
  const child = spawn(hostExe, ['run', '--config', configPath], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdoutBuffer = ''; let stderrText = '';
  const lines = [];
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) { lines.push(stdoutBuffer.slice(0, index)); stdoutBuffer = stdoutBuffer.slice(index + 1); }
  });
  child.stderr.on('data', chunk => { stderrText += chunk; });
  const connection = expectSetupToken ? new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Rust Host did not forward the initial runtime setup descriptor. Host stderr: ${stderrText}`)), 45_000);
    const poll = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(poll); clearTimeout(deadline); reject(new Error(`Rust Host exited before Engine startup (code ${child.exitCode}): ${stderrText}`)); return; }
      while (lines.length) {
        const line = lines.shift();
        try {
          const value = JSON.parse(line);
          if (value.port && value.firstPartyToken) { clearInterval(poll); clearTimeout(deadline); resolvePromise(value); return; }
        } catch { /* This line was not the private runtime startup descriptor. */ }
      }
    }, 25);
  }) : null;
  return { child, connection, get stderrText() { return stderrText; }, get stdoutBuffer() { return stdoutBuffer; } };
}

async function stopHost(host, { crash = false, timeoutMs = 20_000 } = {}) {
  if (!host || host.child.exitCode !== null) return;
  if (crash) host.child.kill();
  else host.child.stdin.write('shutdown\n');
  let timer;
  await Promise.race([
    new Promise(resolvePromise => host.child.once('exit', resolvePromise)),
    new Promise(resolvePromise => { timer = setTimeout(resolvePromise, timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (host.child.exitCode === null) host.child.kill();
}

async function call(connection, method, path, body, { token = connection.firstPartyToken, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(connection, runId, predicate, timeoutMs = 45_000, token = connection.firstPartyToken) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const snapshot = await call(connection, 'GET', `/api/v2/runs/${runId}`, undefined, { token });
      if (snapshot.status === 200 && predicate(snapshot.body)) return snapshot.body;
    } catch { /* A managed restart replaces the loopback endpoint and descriptor. */ }
    await new Promise(done => setTimeout(done, 120));
  }
  throw new Error(`Run ${runId} did not reach the expected state within ${timeoutMs} ms.`);
}

async function currentConnection(profile, buildId, notGeneration = null, host = null) {
  const path = join(profile, 'runtime/connection.json');
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.applicationBuildId === buildId && (!notGeneration || value.applicationGeneration !== notGeneration)) return value;
    } catch { /* Engine has not published this generation yet. */ }
    if (host?.child.exitCode !== null && host?.child.exitCode !== undefined)
      throw new Error(`The Rust Host exited before the ${buildId} Engine published a connection descriptor (code ${host.child.exitCode}): ${host.stderrText}`);
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error(`The ${buildId} Engine did not publish its connection descriptor.`);
}

function databaseView(profile) {
  const db = new DatabaseSync(join(profile, 'store/state.sqlite'), { readOnly: true });
  try {
    const runs = db.prepare('SELECT id, workflow_id, workspace_id, state FROM runs ORDER BY created_at').all().map(row => ({ ...row }));
    const attempts = db.prepare(`SELECT a.id, a.run_id, n.node_id, a.state, a.ordinal, a.invocation_artifact_id IS NOT NULL AS invoked
      FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id ORDER BY a.rowid`).all().map(row => ({ ...row, invoked: Boolean(row.invoked) }));
    const operations = db.prepare('SELECT * FROM lifecycle_operations').all().map(row => ({ ...row }));
    const links = db.prepare('SELECT * FROM run_links').all().map(row => ({ ...row }));
    const journal = db.prepare('SELECT run_id, sequence, event_type, envelope_json FROM journal_events ORDER BY timestamp, run_id, sequence').all()
      .map(row => ({ runId: row.run_id, sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.envelope_json).payload }));
    return { runs, attempts, operations, links, journal };
  } finally { db.close(); }
}

function hostEvents(install) {
  const text = readFileSync(join(install, '.deszo-host/operations.ndjson'), 'utf8').trim();
  return text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

async function unauthenticatedStatusRequest(endpointPath) {
  const endpoint = JSON.parse(await readFile(endpointPath, 'utf8'));
  const [host, port] = endpoint.address.split(':');
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let data = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ capability: '0'.repeat(64), command: 'engine.status', payload: {} })}\n`));
    socket.on('data', chunk => { data += chunk.toString(); if (data.includes('\n')) { socket.destroy(); resolvePromise(JSON.parse(data.slice(0, data.indexOf('\n')))); } });
  });
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

async function eventually(predicate, description, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 40));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForHostEvent(host, install, predicate, timeoutMs = 30_000) {
  await eventually(() => host.child.exitCode !== null ? Promise.reject(new Error(`Host exited (${host.child.exitCode}): ${host.stderrText}`)) :
    hostEvents(install).some(predicate), 'the requested Rust Host journal event', timeoutMs);
  return hostEvents(install).find(predicate);
}

async function hostState(install) {
  return JSON.parse(await readFile(join(install, '.deszo-host/lifecycle.json'), 'utf8'));
}

async function digestCandidate(path) {
  const result = spawnSync(hostExe, ['digest-candidate', '--path', path], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const digest = result.stdout.trim();
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}

async function prepareFreshInstallation(iteration, { candidateManifestBuildId = 'build-b', corruptCandidateRunner = false,
  duplicateReceiptDelivery = false, pauseAfterShutdownRequestedMs } = {}) {
  const root = await mkdtemp(join(testsRoot, `rust-host-proof-a-${iteration}-`));
  const install = join(root, 'installation'); const profile = join(root, 'profile'); const staging = join(install, 'staging');
  const fixtureState = join(root, 'fixture-state'); const buildA = join(install, 'versions/build-a'); const candidateB = join(staging, 'build-b');
  await Promise.all([mkdir(buildA, { recursive: true }), mkdir(candidateB, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(staging, { recursive: true }), mkdir(fixtureState, { recursive: true })]);
  await copyRuntimePackage(buildA, 'build-a', `current-${iteration}`);
  await copyRuntimePackage(candidateB, candidateManifestBuildId, `candidate-${iteration}`);
  if (corruptCandidateRunner) await writeFile(join(candidateB, 'runtime/runner.mjs'), "throw new Error('candidate Engine readiness failure');\n");
  const candidateDigest = await digestCandidate(candidateB);
  const configPath = join(root, 'host-config.json');
  await writeFile(configPath, JSON.stringify({ installationRoot: install, profileRoot: profile, stagingRoot: staging, nodeExecutable: process.execPath,
    initialBuildId: 'build-a', fixtureState, devTestConfirmationOff: true, forwardRuntimeStdout: true, testSetupTokenStdout: true,
    testDuplicateReceiptDelivery: duplicateReceiptDelivery, ...(pauseAfterShutdownRequestedMs === undefined ? {} : { testPauseAfterShutdownRequestedMs: pauseAfterShutdownRequestedMs }) }));
  return { root, install, profile, staging, fixtureState, buildA, candidateB, candidateDigest, configPath };
}

async function startLinkedLifecycle(connection, profile, candidateDigest) {
  const setupCall = (method, path, body, opts) => call(connection, method, path, body, opts);
  for (const id of ['main', 'main-repair']) {
    const response = await setupCall('PUT', `/api/v2/workspaces/${id}`, { cwd: join(connection.scratchRoot, id) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  await writeFile(join(connection.scratchRoot, 'main-repair/candidate.json'), JSON.stringify({ candidateId: 'build-b', candidateDigest, continuationCheckpointId: CHECKPOINT_ID }));
  const save = async definition => {
    const response = await setupCall('PUT', `/api/v3/workflows/${definition.workflowId}`, { requestId: randomUUID(), expectedEtag: null, workflow: definition }, { headers: { 'If-None-Match': '*' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const parent = await save(parentWorkflow());
  const repair = await save(repairWorkflow());
  const parentStart = await setupCall('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(parentStart.status, 202, JSON.stringify(parentStart.body));
  const parentRunId = parentStart.body.run.runId;
  await waitFor(connection, parentRunId, body => body.run.state === 'waiting_for_user');
  const linked = await setupCall('POST', `/api/v2/runs/${parentRunId}/linked-repair`, { requestId: randomUUID(), failedNodeInstanceId: 'watcher',
    repairWorkflowId: repair.workflow.workflowId, repairWorkflowSnapshotSha256: repair.snapshotSha256, repairWorkspaceId: 'main-repair',
    candidateDigest, continuationCheckpointId: CHECKPOINT_ID });
  assert.equal(linked.status, 202, JSON.stringify(linked.body));
  const repairRunId = linked.body.repairRunId;
  const repairGate = await waitFor(connection, repairRunId, body => body.run.state === 'waiting_for_user');
  assert.equal(repairGate.instances.find(item => item.nodeId === 'judge').state, 'succeeded');
  assert.equal(repairGate.instances.find(item => item.nodeId === 'finalize').state, 'scheduled');
  const operation = databaseView(profile).operations.find(item => item.run_id === repairRunId);
  assert.ok(operation && operation.state === 'intent', 'the production Engine saved the Judge-validated intent');
  return { parentRunId, repairRunId, operation, repairGate };
}

async function runFreshProof(iteration) {
  const { root, install, profile, staging, fixtureState, buildA, candidateB, candidateDigest, configPath } =
    await prepareFreshInstallation(iteration, { duplicateReceiptDelivery: true });

  const host = hostProcess(configPath);
  try {
    const connectionA = await host.connection;
    assert.notEqual(host.child.pid, undefined);
    assert.equal(connectionA.applicationBuildId, 'build-a', 'Host launched the configured initial build');
    const hostPid = host.child.pid;
    const endpointPath = join(install, '.deszo-host/ipc-endpoint.json');
    const unauth = await unauthenticatedStatusRequest(endpointPath);
    assert.equal(unauth.ok, false, 'unauthenticated local clients cannot invoke Host operations');

    // A competing compiled Host cannot acquire this canonical installation/profile lock or spawn another Engine.
    const competitor = spawnSync(hostExe, ['run', '--config', configPath], { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(competitor.status, 0);
    assert.match(competitor.stderr, /already owns this installation\/profile/);

    const { parentRunId, repairRunId, operation } = await startLinkedLifecycle(connectionA, profile, candidateDigest);

    // From the Host-accepted intent onward the test observes only; there is no harness receipt or continuation call.
    const connectionB = await currentConnection(profile, 'build-b');
    const apiB = { ...connectionB, firstPartyToken: connectionA.firstPartyToken };
    const repairDone = await waitFor(apiB, repairRunId, body => body.run.state === 'succeeded', 60_000, connectionB.token);
    const parentDone = await waitFor(apiB, parentRunId, body => body.run.state === 'succeeded', 60_000, connectionB.token);
    assert.equal(repairDone.run.state, 'succeeded');
    assert.equal(parentDone.run.state, 'succeeded');
    assert.equal(connectionB.applicationBuildId, 'build-b');
    assert.notEqual(connectionB.applicationGeneration, connectionA.applicationGeneration);
    assert.equal(isAlive(hostPid), true, 'the original Rust Host process stayed alive across the managed restart');

    const view = databaseView(profile);
    const verified = view.operations.find(item => item.id === operation.id);
    assert.equal(verified.state, 'verified');
    assert.equal(verified.candidate_digest, candidateDigest);
    assert.equal(verified.target_version, 'build-b');
    assert.equal(view.links.find(item => item.repair_run_id === repairRunId).state, 'resumed');
    assert.deepEqual(view.attempts.filter(item => item.node_id === 'developer').map(item => item.run_id).sort(), [parentRunId, repairRunId].sort(),
      'committed Developer operations were not repeated across the application restart');
    assert.equal(view.journal.filter(item => item.type === 'continuation.parent_resumed').length, 1);
    const receiptEvent = view.journal.find(item => item.type === 'continuation.lifecycle_verified');
    assert.ok(receiptEvent, 'the new Engine consumed the Host result through its trusted startup channel');

    const journal = hostEvents(install);
    const appSpawns = journal.filter(item => item.type === 'application_spawned');
    assert.deepEqual(appSpawns.map(item => item.payload.buildId), ['build-a', 'build-b']);
    const engineReady = journal.filter(item => item.type === 'engine_ready');
    assert.equal(engineReady.length, 3, 'the candidate Engine received the same unacknowledged Host receipt twice');
    assert.notEqual(engineReady[0].payload.pid, engineReady[1].payload.pid, 'the managed Engine was a new OS process');
    assert.equal(engineReady[1].payload.receiptId, engineReady[2].payload.receiptId, 'Host replay returned the same durable receipt');
    assert.equal(journal[0].hostPid, hostPid);
    assert.equal(engineReady[0].hostPid, hostPid);
    assert.equal(engineReady[1].hostPid, hostPid);
    assert.ok(journal.some(item => item.type === 'managed_process_tree_stopped' && item.payload.buildId === 'build-a'));
    assert.ok(journal.some(item => item.type === 'candidate_activated' && item.payload.candidateDigest === candidateDigest));
    const receipt = JSON.parse(await readFile(join(install, '.deszo-host/lifecycle.json'), 'utf8')).operation.receipt;
    assert.equal(receipt.operationId, operation.id);
    assert.equal(receipt.receiptId, receiptEvent.payload.receiptId);
    assert.equal(receipt.candidateDigest, candidateDigest);
    assert.equal(receipt.candidateId, 'build-b');
    assert.equal(receipt.engineReady, true);
    assert.equal(receipt.applicationResponsive, true);
    assert.equal(receipt.hostPid, hostPid);
    assert.equal(receipt.enginePid, engineReady[1].payload.pid);
    assert.equal(receipt.storeId, connectionB.storeId);
    assert.notEqual(receipt.previousGeneration, receipt.activatedGeneration);
    assert.equal(journal.filter(item => item.type === 'candidate_activated').length, 1, 'one durable operation caused one activation');
    assert.ok(!JSON.stringify(journal).includes(connectionA.firstPartyToken), 'the Host journal contains no first-party credential');
    assert.ok(!JSON.stringify(receipt).includes(connectionA.firstPartyToken), 'the lifecycle receipt contains no first-party credential');
    assert.equal(view.runs.filter(run => ['queued', 'running', 'draining', 'waiting_for_user', 'stopping'].includes(run.state) && ['main', 'main-repair'].includes(run.workspace_id)).length, 0,
      'no conflicting active run remained in either workspace');

    return { iteration, hostPid, enginePids: engineReady.slice(0, 2).map(item => item.payload.pid), buildIds: appSpawns.map(item => item.payload.buildId),
      operationId: operation.id, candidateDigest, receiptId: receipt.receiptId, parentRunId, repairRunId, finalParent: parentDone.run.state,
      finalRepair: repairDone.run.state, journalTypes: journal.map(item => item.type) };
  } finally {
    await stopHost(host);
    await rm(root, { recursive: true, force: true });
  }
}

test('Rust Host Proof A: authenticated candidate replacement and autonomous Engine continuation (two fresh installs)', { timeout: 240_000 }, async () => {
  await mkdir(testsRoot, { recursive: true });
  const build = spawnSync('cargo', ['build', '--manifest-path', 'lifecycle-host/Cargo.toml', '--bin', 'deszo-lifecycle-host'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const evidence = [];
  evidence.push(await runFreshProof(1));
  evidence.push(await runFreshProof(2));
  assert.equal(evidence.length, 2);
  assert.notEqual(evidence[0].hostPid, evidence[1].hostPid);
  assert.ok(evidence.every(item => item.buildIds.join(',') === 'build-a,build-b'));
  await writeFile(join(testsRoot, 'rust-host-proof-a-runs.json'), JSON.stringify({ platform: process.platform, runs: evidence }, null, 2));
});

test('negative Rust Host case: a staged candidate with a different build identity is refused', { timeout: 120_000 }, async () => {
  await mkdir(testsRoot, { recursive: true });
  const prepared = await prepareFreshInstallation(`candidate-mismatch-${randomUUID()}`, { candidateManifestBuildId: 'other-build' });
  const host = hostProcess(prepared.configPath);
  try {
    const connectionA = await host.connection;
    const enginePid = hostEvents(prepared.install).find(item => item.type === 'engine_ready').payload.pid;
    const { parentRunId, repairRunId } = await startLinkedLifecycle(connectionA, prepared.profile, prepared.candidateDigest);
    await eventually(() => databaseView(prepared.profile).journal.some(item => item.type === 'continuation.lifecycle_host_delivery_failed'),
      'the Engine to record the Host candidate refusal');
    const view = databaseView(prepared.profile);
    const journal = hostEvents(prepared.install);
    assert.equal(journal.filter(item => item.type === 'activation_accepted').length, 0);
    assert.equal(journal.filter(item => item.type === 'candidate_activated').length, 0);
    assert.equal(journal.filter(item => item.type === 'application_spawned').length, 1);
    assert.equal(view.operations.find(item => item.run_id === repairRunId).state, 'intent', 'the refused candidate did not verify the workflow gate');
    assert.equal(view.runs.find(run => run.id === repairRunId).state, 'waiting_for_user');
    assert.equal(view.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
    assert.equal(view.attempts.some(item => item.run_id === repairRunId && item.node_id === 'finalize' && item.invoked), false);
    assert.equal(view.journal.some(item => item.type === 'continuation.lifecycle_verified'), false);
    assert.ok(isAlive(host.child.pid), 'the rejecting Rust Host remains available');
    assert.equal((await hostState(prepared.install)).activeBuildId, 'build-a');
    assert.ok(isAlive(enginePid), 'the unchanged managed Engine remains live after refusal');
  } finally {
    await stopHost(host);
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test('negative Rust Host case: a candidate that launches but fails Engine readiness is not receipted', { timeout: 120_000 }, async () => {
  await mkdir(testsRoot, { recursive: true });
  const prepared = await prepareFreshInstallation(`readiness-failure-${randomUUID()}`, { corruptCandidateRunner: true });
  const host = hostProcess(prepared.configPath);
  try {
    const connectionA = await host.connection;
    const { parentRunId, repairRunId, operation } = await startLinkedLifecycle(connectionA, prepared.profile, prepared.candidateDigest);
    await waitForHostEvent(host, prepared.install, item => item.type === 'activation_failed');
    const durable = await hostState(prepared.install);
    const journal = hostEvents(prepared.install);
    const view = databaseView(prepared.profile);
    assert.equal(durable.activeBuildId, 'build-b', `the distinct candidate was actually activated before its Engine failed; state=${JSON.stringify(durable)} events=${JSON.stringify(journal)}`);
    assert.equal(durable.operation.phase, 'failed');
    assert.match(durable.operation.failure, /exited before lifecycle readiness|readiness/i);
    assert.equal(durable.operation.receipt, null, 'Host did not create a success receipt');
    assert.equal(journal.filter(item => item.type === 'candidate_activated').length, 1);
    assert.equal(journal.filter(item => item.type === 'engine_ready').length, 1, 'only Engine A reached readiness');
    assert.equal(view.operations.find(item => item.id === operation.id).state, 'intent');
    assert.equal(view.runs.find(run => run.id === repairRunId).state, 'waiting_for_user');
    assert.equal(view.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
    assert.equal(view.journal.some(item => item.type === 'continuation.lifecycle_verified'), false);
    assert.equal(view.attempts.some(item => item.run_id === repairRunId && item.node_id === 'finalize' && item.invoked), false);
    assert.ok(isAlive(host.child.pid), 'the Host stays alive and exposes the readiness failure');
  } finally {
    await stopHost(host);
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test('negative Rust Host case: crash after durable shutdown intent is reconciled without replay or receipt', { timeout: 120_000 }, async () => {
  await mkdir(testsRoot, { recursive: true });
  const prepared = await prepareFreshInstallation(`crash-reconcile-${randomUUID()}`, { pauseAfterShutdownRequestedMs: 10_000 });
  const hosts = [];
  try {
    const hostA = hostProcess(prepared.configPath);
    hosts.push(hostA);
    const connectionA = await hostA.connection;
    const { parentRunId, repairRunId, operation } = await startLinkedLifecycle(connectionA, prepared.profile, prepared.candidateDigest);
    await waitForHostEvent(hostA, prepared.install, item => item.type === 'shutdown_requested');
    const engineA = hostEvents(prepared.install).find(item => item.type === 'engine_ready').payload.pid;
    await stopHost(hostA, { crash: true });
    assert.equal(isAlive(engineA), false, 'closing the Host process containment ends the old Engine tree');

    const hostB = hostProcess(prepared.configPath, { expectSetupToken: false });
    hosts.push(hostB);
    let connectionB;
    try { connectionB = await currentConnection(prepared.profile, 'build-a', connectionA.applicationGeneration, hostB); }
    catch (error) {
      throw new Error(`${error.message}\nHost B events: ${JSON.stringify(hostEvents(prepared.install))}\nHost state: ${JSON.stringify(await hostState(prepared.install))}`);
    }
    const durable = await hostState(prepared.install);
    const journal = hostEvents(prepared.install);
    const view = databaseView(prepared.profile);
    assert.notEqual(hostB.child.pid, hostA.child.pid);
    assert.equal(connectionB.storeId, connectionA.storeId, 'the recovered Engine reopened the same persistent profile');
    assert.equal(durable.activeBuildId, 'build-a', 'the candidate had not activated at the crash boundary');
    assert.equal(durable.operation.phase, 'failed');
    assert.match(durable.operation.failure, /not replayed/i);
    assert.equal(durable.operation.receipt, null, 'restart did not manufacture the missing Host receipt');
    assert.ok(journal.some(item => item.type === 'operation_reconciled_without_replay'));
    assert.equal(journal.filter(item => item.type === 'candidate_activated').length, 0);
    assert.equal(journal.filter(item => item.type === 'application_spawned').map(item => item.payload.buildId).join(','), 'build-a,build-a');
    assert.equal(view.operations.find(item => item.id === operation.id).state, 'intent');
    assert.equal(view.runs.find(run => run.id === repairRunId).state, 'waiting_for_user');
    assert.equal(view.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
    assert.equal(view.journal.some(item => item.type === 'continuation.lifecycle_verified'), false);
    assert.equal(view.attempts.some(item => item.run_id === repairRunId && item.node_id === 'finalize' && item.invoked), false);
    const repair = await call(connectionB, 'GET', `/api/v2/runs/${repairRunId}`, undefined, { token: connectionB.token });
    assert.equal(repair.body.run.state, 'waiting_for_user', 'Engine recovery cannot pass a missing lifecycle result');
  } finally {
    for (const host of hosts.reverse()) await stopHost(host);
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test('negative Rust Host case: shutdown terminates an active provider and its surviving descendant tree', { timeout: 120_000 }, async () => {
  await mkdir(testsRoot, { recursive: true });
  const prepared = await prepareFreshInstallation(`provider-tree-${randomUUID()}`);
  let host = hostProcess(prepared.configPath);
  try {
    const connection = await host.connection;
    const workspace = await call(connection, 'PUT', '/api/v2/workspaces/main', { cwd: join(connection.scratchRoot, 'main') });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const slowWorkflow = workflow('slow-provider-shutdown', [agent('slow', 'codex', 'fixture-slow-60')], [
      edge('request-slow', 'request', 'text', 'slow', 'prompt'), edge('slow-result', 'slow', 'text', 'result', 'value'),
    ]);
    const saved = await call(connection, 'PUT', `/api/v3/workflows/${slowWorkflow.workflowId}`,
      { requestId: randomUUID(), expectedEtag: null, workflow: slowWorkflow }, { headers: { 'If-None-Match': '*' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const started = await call(connection, 'POST', '/api/v2/runs', { workflowId: saved.body.workflow.workflowId,
      workflowSnapshotSha256: saved.body.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    await waitFor(connection, runId, body => body.run.state === 'running');
    const providerPidPath = join(prepared.fixtureState, 'slow-provider.pid');
    await eventually(() => existsSync(providerPidPath) && existsSync(join(prepared.fixtureState, 'slow-descendant.pid')),
      'the active fixture provider to spawn');
    const providerPid = Number(await readFile(providerPidPath, 'utf8'));
    const descendantPid = Number(await readFile(join(prepared.fixtureState, 'slow-descendant.pid'), 'utf8'));
    const enginePid = hostEvents(prepared.install).find(item => item.type === 'engine_ready').payload.pid;
    assert.ok(isAlive(providerPid) && isAlive(descendantPid), 'provider CLI and its child are live before shutdown');
    const hostPid = host.child.pid;
    await stopHost(host);
    assert.equal(host.child.exitCode, 0, host.stderrText);
    assert.equal(isAlive(hostPid), false);
    assert.equal(isAlive(enginePid), false);
    assert.equal(isAlive(providerPid), false, 'provider CLI did not survive the managed Host shutdown');
    assert.equal(isAlive(descendantPid), false, 'provider descendant did not survive the managed Host shutdown');
    assert.ok(hostEvents(prepared.install).some(item => item.type === 'managed_process_tree_stopped'));
    assert.equal(hostEvents(prepared.install).filter(item => item.type === 'application_spawned').length, 1, 'no conflicting replacement Engine started');

    // The next real Engine performs ordinary startup recovery only after Host confirmed that
    // every managed process had stopped; the uncertain provider attempt is not replayed.
    host = hostProcess(prepared.configPath);
    const recoveredConnection = await host.connection;
    const recovered = await waitFor(recoveredConnection, runId, body => body.run.state === 'interrupted', 20_000, recoveredConnection.token);
    assert.equal(recovered.run.state, 'interrupted');
    const final = databaseView(prepared.profile);
    assert.equal(final.attempts.find(item => item.run_id === runId && item.node_id === 'slow').state, 'interrupted');
    assert.equal(final.attempts.filter(item => item.run_id === runId && item.node_id === 'slow').length, 1, 'the uncertain provider operation was not retried');
  } finally {
    await stopHost(host);
    await rm(prepared.root, { recursive: true, force: true });
  }
});
