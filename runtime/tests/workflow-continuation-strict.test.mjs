// Strict verification of Engine-native continuation after real Engine restarts (ADR-0008 Suspend -> Repair -> Restart -> Resume).
//
// Boundary, enforced below: before Engine B starts, the harness starts the parent, links its repair through the Engine's
// route, and stops Engine A. After Engine B starts, the harness performs only observation: GET requests and read-only SQLite.
// Its only mutation is the Host's lifecycle receipt, which the Host would deliver and which the Engine verifies. No run is
// created, planned, recovered, resumed or completed by the harness after restart. Every journal transition is attributed to
// its origin in the trace, and the test fails if a continuation transition was not caused by the Engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ownedDir } from './test-roots.mjs';

const repo = resolve(import.meta.dirname, '../..');
const testsRoot = join(repo, '.deszo/tests');
const OBSERVATION_MS = 3_000;
const CANDIDATE_DIGEST = createHash('sha256').update('deszo-self-repair synthetic candidate v1').digest('hex');
const CHECKPOINT_ID = 'chk-self-repair-7';

async function startEngine(root, fixtureState, lifecycleHost, generation, buildId) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'runtime/runner.mjs', '--root', root,
    '--fixture-state', fixtureState, '--first-party-token-stdout', '--dev-test-confirmation-off'],
  { cwd: repo, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env,
    DESZO_LIFECYCLE_HOST_ADDRESS: lifecycleHost.address,
    DESZO_LIFECYCLE_HOST_CAPABILITY: lifecycleHost.capability,
    DESZO_LIFECYCLE_INSTALLATION_ID: lifecycleHost.installationId,
    DESZO_LIFECYCLE_PROFILE_ROOT: root,
    DESZO_LIFECYCLE_GENERATION: generation,
    DESZO_APPLICATION_BUILD_ID: buildId,
    DESZO_LIFECYCLE_APPLICATION_PID: 'self',
    DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT: '0',
  } });
  const connection = await new Promise((done, fail) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        try { const parsed = JSON.parse(line); if (parsed.port && parsed.firstPartyToken) { child.stdout.off('data', onData); done(parsed); return; } } catch { /* partial line */ }
      }
    };
    child.stdout.on('data', onData);
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Engine exited early with code ${code}`)));
  });
  const http = [];
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
      headers: { Authorization: `Bearer ${connection.firstPartyToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    http.push({ at: new Date().toISOString(), pid: child.pid, method, path, status: response.status });
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const stop = () => new Promise(done => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } done(); }, 8_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    try { child.stdin.write(`${JSON.stringify({ command: 'shutdown' })}\n`); } catch { clearTimeout(timer); done(); }
  });
  return { pid: child.pid, connection, call, stop, http, exited: () => child.exitCode !== null };
}

async function startLifecycleTestHost(profileRoot) {
  const capability = randomBytes(32).toString('hex');
  const state = { activationRequest: null, receiptDelivered: false, receiptAcknowledged: false, receipt: null };
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let result = {};
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.capability !== capability) throw new Error('invalid fixture capability');
        if (message.command === 'lifecycle.activate_candidate') {
          state.activationRequest = message.payload;
          result = { accepted: true };
        } else if (message.command === 'engine.ready' && state.activationRequest && !state.receiptDelivered) {
          const request = state.activationRequest, ready = message.payload;
          state.receipt = {
            operationId: request.operationId, receiptId: randomUUID(), installationId: request.installationId,
            profileRoot: request.profileRoot, candidateId: request.candidateId, candidateDigest: request.candidateDigest,
            previousGeneration: request.expectedGeneration, activatedGeneration: ready.generation,
            enginePid: ready.pid, applicationPid: ready.applicationPid, applicationBuildId: ready.applicationBuildId,
            runtimeInstanceId: ready.runtimeInstanceId, storeId: ready.storeId, actualActivation: true,
            applicationResponsive: true, engineReady: true,
          };
          state.receiptDelivered = true;
          result = { receipt: state.receipt };
        } else if (message.command === 'lifecycle.receipt_ack') {
          state.receiptAcknowledged = message.payload.receiptId === state.receipt?.receiptId;
        } else if (message.command !== 'engine.ready') throw new Error(`unexpected fixture command: ${message.command}`);
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) { socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`); }
    });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = `127.0.0.1:${server.address().port}`;
  return {
    address, capability, installationId: randomUUID(), state,
    async waitForActivation(timeoutMs = 5_000) {
      const started = Date.now();
      while (!state.activationRequest && Date.now() - started < timeoutMs) await new Promise(done => setTimeout(done, 25));
      assert.ok(state.activationRequest, 'the Engine sent the Judge-authorized lifecycle operation over the private Host channel');
      return state.activationRequest;
    },
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  };
}

function workflow(workflowId, nodes, edges) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [
    { id: 'request', type: 'text', config: { value: `${workflowId} request` } }, ...nodes, { id: 'result', type: 'result-viewer', config: {} }], edges, after: [] };
}
const agent = (id, provider, model, extra = {}) => ({ id, type: 'agent', config: { provider, model, timeoutSeconds: 120, output: { format: 'text' }, ...extra } });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });

// The parent's Watcher fails once (fixture-fail-once), so the parent is suspended for repair at that node.
function parentWorkflow() {
  return workflow('parent-delivery', [agent('developer', 'codex', 'fixture-echo'), agent('watcher', 'claude', 'fixture-fail-once'), agent('judge', 'codex', 'fixture-echo')], [
    edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
    edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-result', 'judge', 'text', 'result', 'value')]);
}
// The repair: Developer -> Watcher -> Judge (designated; proposes application.activate_candidate) -> finalize -> result.
// finalize is the repair's final node. It is gated behind the Judge's lifecycle receipt, so it runs only after restart.
function repairWorkflow() {
  return workflow('deszo-self-repair', [agent('developer', 'codex', 'fixture-echo'), agent('watcher', 'claude', 'fixture-echo'),
    agent('judge', 'codex', 'fixture-lifecycle-proposal', { role: 'judge' }), agent('finalize', 'claude', 'fixture-echo')], [
    edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
    edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-finalize', 'judge', 'text', 'finalize', 'prompt'), edge('finalize-result', 'finalize', 'text', 'result', 'value')]);
}

async function waitFor(engine, runId, predicate, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const snapshot = await engine.call('GET', `/api/v2/runs/${runId}`);
    if (snapshot.status === 200 && predicate(snapshot.body)) return snapshot.body;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Run ${runId} did not reach the expected state within ${timeout} ms.`);
}

// Read-only view of persisted state. Opened and closed around each read; never written.
function storeView(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runs = db.prepare('SELECT id, workflow_id, workspace_id, state, created_at FROM runs ORDER BY created_at').all().map(row => ({ ...row }));
    const attempts = db.prepare(`SELECT a.id, a.run_id, n.node_id, a.state, a.ordinal, a.invocation_artifact_id IS NOT NULL AS invoked
      FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id ORDER BY a.rowid`).all().map(row => ({ ...row, invoked: Boolean(row.invoked) }));
    const links = db.prepare('SELECT * FROM run_links').all().map(row => ({ ...row }));
    const operations = db.prepare('SELECT id, run_id, node_instance_id, candidate_digest, state, receipt_artifact_id FROM lifecycle_operations').all().map(row => ({ ...row }));
    const journal = db.prepare('SELECT run_id, sequence, event_type, timestamp, envelope_json FROM journal_events ORDER BY timestamp, run_id, sequence').all()
      .map(row => { const envelope = JSON.parse(row.envelope_json); return { runId: row.run_id, sequence: row.sequence, type: row.event_type, at: row.timestamp, nodeInstanceId: envelope.nodeInstanceId, attemptId: envelope.attemptId, payload: envelope.payload }; });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    return { runs, attempts, links, operations, journal, tables };
  } finally { db.close(); }
}

const providerInvocations = view => view.attempts.filter(attempt => attempt.invoked).length;
const runState = (view, id) => view.runs.find(run => run.id === id)?.state;
const attemptsOf = (view, runId, node) => view.attempts.filter(attempt => attempt.run_id === runId && attempt.node_id === node);

let observation;
async function scenario() {
  if (observation) return observation;
  await mkdir(testsRoot, { recursive: true });
  const root = ownedDir(join(testsRoot, 'root-strict-continuation-'));
  const fixtureState = join(root, 'fixture-state');
  const dbPath = join(root, 'store', 'state.sqlite');
  const harness = [];
  const mark = (origin, what, detail = {}) => harness.push({ at: new Date().toISOString(), origin, what, ...detail });
  let engineA, engineB, engineC;
  const lifecycleHost = await startLifecycleTestHost(root);
  try {
    // ---- Phase A: Engine A starts the parent and suspends it for repair through the Engine's own route ----
    engineA = await startEngine(root, fixtureState, lifecycleHost, 'generation-a', 'build-a');
    mark('HOST_HARNESS', 'engine_a_started', { pid: engineA.pid });
    for (const id of ['main', 'main-repair']) {
      const workspace = await engineA.call('PUT', `/api/v2/workspaces/${id}`, { cwd: join(engineA.connection.scratchRoot, id) });
      assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    }
    // The candidate identity is saved in the repair workspace, where the repair's Judge reads it.
    await writeFile(join(engineA.connection.scratchRoot, 'main-repair', 'candidate.json'), JSON.stringify({ candidateDigest: CANDIDATE_DIGEST, continuationCheckpointId: CHECKPOINT_ID }));
    const save = async wf => {
      const draft = await engineA.call('PUT', `/api/v4/workflows/${wf.workflowId}/draft`, { requestId: randomUUID(), workflow: wf }, { 'If-None-Match': '*' });
      assert.equal(draft.status, 200, JSON.stringify(draft.body));
      const validation = await engineA.call('POST', `/api/v4/workflows/${wf.workflowId}/draft/validate`, {}, { 'If-Match': draft.body.etag });
      assert.equal(validation.status, 200, JSON.stringify(validation.body));
      assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
      const published = await engineA.call('POST', `/api/v4/workflows/${wf.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.body.etag });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      return published.body;
    };
    const parent = await save(parentWorkflow());
    const repair = await save(repairWorkflow());
    const parentStart = await engineA.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: parent.publishedVersionId, definitionDigest: parent.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(parentStart.status, 202, JSON.stringify(parentStart.body));
    const parentRunId = parentStart.body.run.runId;
    mark('TEST_HARNESS', 'parent_run_requested', { runId: parentRunId, workspace: 'main' });
    const parentPaused = await waitFor(engineA, parentRunId, body => body.run.state === 'waiting_for_user');

    const link = await engineA.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, { requestId: randomUUID(), failedNodeInstanceId: 'watcher',
      repairWorkflowId: repair.workflow.workflowId, repairWorkflowSnapshotSha256: repair.snapshotSha256, repairWorkspaceId: 'main-repair',
      candidateDigest: CANDIDATE_DIGEST, continuationCheckpointId: CHECKPOINT_ID });
    assert.equal(link.status, 202, JSON.stringify(link.body));
    const repairRunId = link.body.repairRunId;
    mark('TEST_HARNESS', 'linked_repair_requested_through_engine_route', { linkId: link.body.linkId, repairRunId, note: 'the Engine captures and starts the repair; the harness only names it' });

    // The repair runs Developer -> Watcher -> Judge; the Judge proposes activation and the repair waits at its gate.
    const repairAtGate = await waitFor(engineA, repairRunId, body => body.run.state === 'waiting_for_user');
    assert.equal(repairAtGate.instances.find(item => item.nodeId === 'judge').state, 'succeeded');
    assert.equal(repairAtGate.instances.find(item => item.nodeId === 'finalize').state, 'scheduled', 'the final node waits for the lifecycle receipt');
    // The parent is also suspended, and it still occupies workspace main; the one-active-run index is the authority.
    assert.equal((await engineA.call('GET', `/api/v2/runs/${parentRunId}`)).body.run.state, 'waiting_for_user');
    const conflict = await engineA.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: parent.publishedVersionId, definitionDigest: parent.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(conflict.status, 409, 'a second run in the suspended parent workspace is refused');
    mark('TEST_HARNESS', 'conflicting_run_in_parent_workspace_refused', { status: conflict.status });

    const beforeStop = storeView(dbPath);
    const operation = beforeStop.operations.find(item => item.run_id === repairRunId);
    assert.ok(operation && operation.state === 'intent', 'the Judge proposal is a durable lifecycle intent');
    await lifecycleHost.waitForActivation();
    mark('ENGINE', 'judge_lifecycle_intent_recorded', { runId: repairRunId, operationId: operation.id, candidateDigest: operation.candidate_digest });
    const invocationsBeforeStop = providerInvocations(beforeStop);

    // ---- Phase B: Engine A stops (managed shutdown). Engine B starts in a new OS process on the same profile. ----
    const pidA = engineA.pid;
    await engineA.stop();
    mark('HOST_HARNESS', 'engine_a_stopped', { pid: pidA });
    assert.ok(engineA.exited(), 'Engine A has terminated');
    engineB = await startEngine(root, fixtureState, lifecycleHost, 'generation-b', 'build-b');
    mark('HOST_HARNESS', 'engine_b_started', { pid: engineB.pid });
    const afterStartup = storeView(dbPath);

    // ---- Phase C: observation only (GET and read-only SQLite) ----
    const seenRuns = new Set(afterStartup.runs.map(run => run.id));
    const observed = Date.now();
    while (Date.now() - observed < OBSERVATION_MS) {
      const listed = await engineB.call('GET', '/api/v2/runs?limit=50');
      for (const run of listed.body?.items ?? []) if (!seenRuns.has(run.runId)) { seenRuns.add(run.runId); mark('ENGINE', 'unexpected_new_run_observed', { runId: run.runId }); }
      await new Promise(done => setTimeout(done, 250));
    }
    const duringObservation = storeView(dbPath);
    mark('HOST_FIXTURE', 'authenticated_receipt_delivered_during_engine_ready', { operationId: operation.id, receiptId: lifecycleHost.state.receipt?.receiptId });

    // ---- Phase E: observe the Engine finish the repair and resume the parent on its own ----
    const repairDone = await waitFor(engineB, repairRunId, body => body.run.state === 'succeeded', 30_000);
    const parentDone = await waitFor(engineB, parentRunId, body => body.run.state === 'succeeded', 30_000);
    const afterCompletion = storeView(dbPath);
    mark('ENGINE', 'repair_and_parent_observed_succeeded', { repair: repairDone.run.state, parent: parentDone.run.state });

    // ---- Phase F: restart again; reconciliation must not repeat any transition ----
    const beforeSecondRestart = storeView(dbPath);
    await engineB.stop();
    mark('HOST_HARNESS', 'engine_b_stopped', { pid: engineB.pid });
    engineC = await startEngine(root, fixtureState, lifecycleHost, 'generation-b', 'build-b');
    mark('HOST_HARNESS', 'engine_c_started', { pid: engineC.pid });
    await new Promise(done => setTimeout(done, OBSERVATION_MS));
    const finalView = storeView(dbPath);
    const finalParent = (await engineC.call('GET', `/api/v2/runs/${parentRunId}`)).body;
    const finalRepair = (await engineC.call('GET', `/api/v2/runs/${repairRunId}`)).body;
    mark('ENGINE', 'final_observation', { parent: finalParent.run.state, repair: finalRepair.run.state });

    observation = { root, pids: { a: pidA, b: engineB.pid, c: engineC.pid }, parentRunId, repairRunId, operation, parentPaused, repairAtGate,
      beforeStop, afterStartup, duringObservation, afterCompletion, beforeSecondRestart, finalView, invocationsBeforeStop, link: link.body, harness,
      http: [...engineA.http, ...engineB.http, ...engineC.http], lifecycleHost: lifecycleHost.state };
    return observation;
  } finally {
    if (engineA) await engineA.stop();
    if (engineB) await engineB.stop();
    if (engineC) await engineC.stop();
    await lifecycleHost.close();
    if (process.env.DESZO_KEEP_STRICT_TRACE && observation) {
      const journal = observation.finalView.journal.map(event => ({ at: event.at, runId: event.runId, sequence: event.sequence, type: event.type,
        nodeInstanceId: event.nodeInstanceId, attemptId: event.attemptId, origin: event.payload?.origin ?? 'ENGINE', payload: event.payload }));
      await writeFile(process.env.DESZO_KEEP_STRICT_TRACE, JSON.stringify({ pids: observation.pids, harness: observation.harness, http: observation.http, journal }, null, 2));
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('STRICT-CONT: Engine B completes the linked repair and resumes the parent with no harness scheduling', async () => {
  const o = await scenario();

  // ECONT-04: real OS process boundaries between the three Engine processes.
  assert.equal(new Set([o.pids.a, o.pids.b, o.pids.c]).size, 3, 'three distinct Engine processes');

  // ECONT-01 and ECONT-03: the parent and the repair are durably linked, and the repair runs in a different workspace.
  const link = o.afterStartup.links.find(item => item.parent_run_id === o.parentRunId);
  assert.ok(link && link.repair_run_id === o.repairRunId && link.kind === 'linked_repair', 'the link is durable across restart');
  const parentRow = o.afterStartup.runs.find(run => run.id === o.parentRunId), repairRow = o.afterStartup.runs.find(run => run.id === o.repairRunId);
  assert.notEqual(parentRow.workspace_id, repairRow.workspace_id, 'the repair runs in its own workspace');
  assert.equal(repairRow.workspace_id, 'main-repair');

  // ECONT-02: while suspended, the parent is the single active run of its workspace; the Engine refused a second one.
  assert.equal(runState(o.beforeStop, o.parentRunId), 'waiting_for_user');
  assert.ok(o.beforeStop.runs.filter(run => run.workspace_id === 'main' && ['queued', 'running', 'draining', 'waiting_for_user', 'stopping'].includes(run.state)).length === 1);

  // ECONT-05: Engine B discovered the held runs from durable state and consumed the Host receipt at startup.
  assert.ok(o.lifecycleHost.receiptDelivered && o.lifecycleHost.receiptAcknowledged, 'the private Host channel delivered and acknowledged the receipt');
  assert.equal(o.afterStartup.operations.find(item => item.id === o.operation.id).state, 'verified');
  assert.ok(o.afterStartup.journal.some(event => event.type === 'continuation.lifecycle_verified' && event.payload.origin === 'HOST_RECEIPT'), 'the Host receipt is recorded as Host evidence');
  assert.ok(o.afterCompletion.journal.some(event => event.type === 'continuation.reconciled' && event.runId === o.repairRunId && event.payload.origin === 'ENGINE'), 'Engine B reconciled the repair at startup');
  assert.ok(o.afterCompletion.journal.some(event => event.type === 'continuation.reconciled' && event.runId === o.parentRunId && event.payload.origin === 'ENGINE'), 'Engine B reconciled the parent at startup');

  // ECONT-06 and ECONT-07: Engine B executed the repair's remaining work and completed the repair by its own transitions.
  const finalize = attemptsOf(o.afterCompletion, o.repairRunId, 'finalize');
  assert.equal(finalize.length, 1);
  assert.equal(finalize[0].state, 'succeeded');
  assert.ok(finalize[0].invoked, 'the post-restart repair operation was executed');
  assert.equal(runState(o.afterCompletion, o.repairRunId), 'succeeded');
  assert.ok(o.afterCompletion.journal.some(event => event.type === 'continuation.repair_completed' && event.runId === o.repairRunId && event.payload.origin === 'ENGINE'), 'repair completion originated in the Engine');

  // ECONT-08 and ECONT-09: Engine B resumed the parent in place at its suspended node, and the parent completed.
  assert.ok(o.afterCompletion.journal.some(event => event.type === 'continuation.parent_resumed' && event.payload.origin === 'ENGINE' && event.payload.resumeNodeInstanceId === 'watcher'), 'the parent resumed through the Engine');
  const parentWatcher = attemptsOf(o.afterCompletion, o.parentRunId, 'watcher');
  assert.deepEqual(parentWatcher.map(attempt => attempt.state), ['failed', 'succeeded'], 'the parent watcher was retried once, by the Engine');
  assert.equal(runState(o.afterCompletion, o.parentRunId), 'succeeded');
  assert.equal(attemptsOf(o.afterCompletion, o.parentRunId, 'judge')[0].state, 'succeeded');

  // ECONT-10: completed agent operations are not repeated. Each committed developer ran exactly once across both restarts.
  const invokedDeveloper = view => view.attempts.filter(attempt => attempt.node_id === 'developer' && attempt.invoked).length;
  assert.equal(invokedDeveloper(o.afterCompletion), 2, 'one parent Developer and one repair Developer, each invoked once');
  assert.equal(attemptsOf(o.afterCompletion, o.parentRunId, 'developer')[0].state, 'succeeded', 'the parent Developer was not re-run');
  assert.equal(attemptsOf(o.afterCompletion, o.repairRunId, 'judge')[0].ordinal, 1, 'the repair Judge was not re-run');

  // ECONT-11: a further restart and reconciliation create nothing and repeat nothing.
  assert.equal(o.finalView.runs.length, o.beforeSecondRestart.runs.length, 'no run was created by reconciliation');
  assert.equal(o.finalView.attempts.length, o.beforeSecondRestart.attempts.length, 'no attempt was created by reconciliation');
  assert.equal(providerInvocations(o.finalView), providerInvocations(o.beforeSecondRestart), 'no provider invocation after the second restart');
  assert.equal(o.finalView.journal.filter(event => event.type === 'continuation.parent_resumed').length, 1, 'the parent was resumed exactly once');
  assert.equal(o.finalView.links.find(item => item.id === link.id).state, 'resumed');

  // ECONT-13: no external user answer or public HTTP mutation was needed after restart; the private Host channel carried the receipt.
  const afterRestartMutations = o.http.filter(entry => entry.pid === o.pids.b || entry.pid === o.pids.c).filter(entry => entry.method !== 'GET');
  assert.deepEqual(afterRestartMutations, [], 'the harness made no mutating HTTP call after restart');
  assert.ok(!o.http.filter(entry => entry.pid === o.pids.b || entry.pid === o.pids.c).some(entry => entry.path.endsWith('/recovery') || entry.path.endsWith('/linked-repair') || (entry.method === 'POST' && entry.path === '/api/v2/runs')),
    'no recovery, linked repair or run creation was called after restart');

  // ECONT-14: every provider invocation is a deterministic fixture (the Engine processes run with --fixture-state only).
  assert.ok(providerInvocations(o.afterCompletion) >= 6, 'the expected agent operations ran');

  // ECONT-15: the test ran only inside its isolated root under .deszo/tests.
  assert.ok(o.root.startsWith(testsRoot), 'the test used an isolated root');
  assert.ok(!o.afterCompletion.tables.some(name => /^test_only_/.test(name)), 'no test-only table exists in the production schema');

  // ECONT-16: no journal transition in this scenario is attributed to a user Stop.
  assert.ok(!o.afterCompletion.journal.some(event => event.payload?.reason === 'Stopped by the user.' || event.payload?.to === 'canceled'), 'graceful shutdown is not journaled as a user Stop');

  // Trace: chronological, every continuation transition attributed to its origin.
  const trace = [...o.harness, ...o.afterCompletion.journal.filter(event => event.payload?.origin || /continuation|lifecycle|repair|run.state_changed/.test(event.type)).map(event => ({ at: event.at, origin: event.payload?.origin ?? 'ENGINE', what: event.type, runId: event.runId }))]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  assert.ok(trace.some(entry => entry.what === 'continuation.parent_resumed' && entry.origin === 'ENGINE'));
  assert.ok(!trace.some(entry => /continuation\.(repair_completed|parent_resumed|reconciled)/.test(entry.what) && entry.origin !== 'ENGINE'), 'no continuation transition is harness-originated');
});
