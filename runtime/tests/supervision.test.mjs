import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../core/engine.mjs';
import { StreamRecorder } from '../core/streams.mjs';
import { canonicalBytes, sha256 } from '../core/canonical.mjs';
import { assertValid } from '../core/schemas.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';
import clientTimeouts from '../../docs/authoring/client-timeouts.json' with { type: 'json' };

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');
const ENDED = ['succeeded', 'failed', 'canceled', 'interrupted'];

function fakeStore() {
  const events = [], artifacts = new Map();
  const put = (bytes, mediaType) => { const artifactId = randomUUID(); artifacts.set(artifactId, { bytes, mediaType }); return { artifactId, sha256: sha256(bytes) }; };
  return { events, artifacts, transaction: fn => fn(), putBytes: put, putJson: value => put(canonicalBytes(value), 'application/json'),
    appendEvents: (runId, batch) => events.push(...batch) };
}

function incidentObservation(overrides = {}) {
  return { schemaVersion: 1, kind: 'IncidentObservation', title: 'Check report lost its output', component: 'scheduler', category: 'capture',
    severity: 'high', confidence: 'medium', causeStatus: 'suspected', expected: 'The full output is captured.', actual: 'The output was truncated.',
    reproduction: ['Run the fixture workflow.'], versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId: null,
    nodeInstanceId: null, attemptId: null, eventRange: null, artifacts: [], captureGaps: [], controllerCommandId: null,
    reporter: { authority: 'external', sessionId: null }, ...overrides };
}

// A supervisor that records every call. Arming, proofs and escalation are the native contract's observable surface.
function fakeSupervisor({ refuseArm = false } = {}) {
  const state = { escalated: false, arms: [], calls: [] };
  return Object.assign(state, {
    shimPath: null, pipeName: 'pipe-test',
    extendRun(runId, extensionMs) { state.calls.push(['extend', runId, extensionMs]); return Promise.resolve({ extendedByMs: extensionMs }); },
    armRun(runId, deadlines) {
      state.calls.push(['arm', runId]);
      if (refuseArm) return Promise.reject(new Error('The supervisor refused the arm.'));
      state.arms.push({ runId, ...deadlines });
      return Promise.resolve({ armed: true, emergencyToken: 'emergency-token-for-test' });
    },
    disarmRun(runId) { state.calls.push(['disarm', runId]); return Promise.resolve({ armed: false }); },
    releaseRun(runId) { state.calls.push(['release', runId]); return Promise.resolve({ released: true }); },
    heartbeat(runId) { state.calls.push(['heartbeat', runId]); return Promise.resolve({ heartbeat: true }); },
    status() { return Promise.resolve({ escalated: state.escalated }); },
    bindShim() { return Promise.resolve({ bound: true }); },
    proveStopped(runId) { state.calls.push(['prove', runId]); return Promise.resolve({ containment: 'windows-job', confirmed: true, remainingMembers: 0, reason: 'The native run Job reports zero active members.' }); },
  });
}

// Seeds an approved grant for a run through the engine's own session path. The grant pins the run's workflow revision.
function seedApprovedGrant(engine, runId) {
  const run = engine.store.get('SELECT workflow_id, workspace_id, workflow_snapshot_artifact_id FROM runs WHERE id = ?', runId);
  const session = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'test controller', clientProvider: 'codex' }).body;
  const snapshotSha256 = engine.store.artifactRow(run.workflow_snapshot_artifact_id).sha256;
  const artifact = engine.store.putJson({ schemaVersion: 1, kind: 'ControlGrant', controllerSessionId: session.controllerSessionId, workflowId: run.workflow_id,
    workflowSnapshotSha256: snapshotSha256, workspaceId: run.workspace_id, clientProvider: 'codex', clientVersion: null, requestedActions: ['observe'],
    observationDeadlineMs: 5000, escalationDeadlineMs: 20000 });
  const grantId = randomUUID(), at = new Date().toISOString();
  engine.store.run(`INSERT INTO control_grants(id, controller_session_id, workflow_id, workspace_id, workflow_snapshot_sha256, run_id, state, grant_artifact_id, observation_deadline_ms, escalation_deadline_ms, requested_at, decided_at)
    VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, 5000, 20000, ?, ?)`, grantId, session.controllerSessionId, run.workflow_id, run.workspace_id, snapshotSha256, artifact.artifactId, at, at);
  return { grantId, sessionId: session.controllerSessionId, token: session.controllerToken, workflowId: run.workflow_id, workspaceId: run.workspace_id, snapshotSha256 };
}
const bindFor = seeded => ({ workflowId: seeded.workflowId, workspaceId: seeded.workspaceId, snapshotSha256: seeded.snapshotSha256, controllerToken: seeded.token });
const credentialFor = seeded => ({ headers: { 'X-Deszo-Controller-Token': seeded.token } });

async function waitUntil(predicate, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('The condition was not reached.');
}

test('a stream keeps every byte in order across batches, with contiguous offsets and a verifiable manifest', () => {
  const store = fakeStore();
  const recorder = new StreamRecorder({ store, runId: randomUUID(), attempt: { id: randomUUID(), node_instance_id: 'agent' }, stream: 'stdout', mediaType: 'application/octet-stream' });
  const parts = [Buffer.alloc(700_000, 'a'), Buffer.from('é'.repeat(10), 'utf8'), Buffer.alloc(400_000, 'b')];
  for (const part of parts) recorder.add(part);
  const { manifest, integrity } = recorder.close('process exited with code 0', { complete: true });
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  assert.equal(integrity, 'complete');
  assert.equal(manifest.receivedBytes, total);
  assert.equal(manifest.committedBytes, total);
  assert.ok(manifest.chunkCount > 1, 'a stream larger than one batch is split into chunks');
  let offset = 0;
  for (const chunk of manifest.chunks) { assert.equal(chunk.byteOffset, offset); offset += chunk.byteLength; }
  assert.deepEqual(Buffer.concat(manifest.chunks.map(chunk => store.artifacts.get(chunk.artifact.artifactId).bytes)), Buffer.concat(parts));
  assertValid('execution-evidence.schema.json', 'streamManifest', manifest);
  assert.ok(store.events.some(event => event.type === 'attempt.log_stream_closed'), 'the closure is journaled');
});

test('a stream stops at its hard bound with an explicit capture-limit fault and keeps what it captured', () => {
  const store = fakeStore(), faults = [];
  const recorder = new StreamRecorder({ store, runId: randomUUID(), attempt: { id: randomUUID(), node_instance_id: 'check' }, stream: 'stderr',
    mediaType: 'application/octet-stream', hardLimitBytes: 100_000, onFault: error => faults.push(error), extended: false });
  recorder.add(Buffer.alloc(80_000, 'x'));
  recorder.add(Buffer.alloc(80_000, 'y'));
  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, 'capture_limit');
  const { manifest, integrity } = recorder.close('stopped at the capture limit', { complete: false });
  assert.equal(integrity, 'capture_failed');
  assert.equal(manifest.receivedBytes, 160_000);
  assert.equal(manifest.committedBytes, 100_000);
  assert.equal(manifest.complete, false);
  assert.ok(!store.events.some(event => event.type === 'attempt.log_stream_closed'), 'a v1 run keeps the original journal shape');
});

test('supervision is refused without a supervisor, and grant decisions need the first-party credential', async () => {
  const api = await startTestRunner();
  try {
    const session = await api.callExternal('POST', '/api/v2/controller-sessions', { requestId: randomUUID(), clientLabel: 'test controller', clientProvider: 'codex' });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    const refused = await api.callExternal('POST', '/api/v2/control-grants', { requestId: randomUUID(), controllerSessionId: session.body.controllerSessionId,
      workflowId: 'w', workflowSnapshotSha256: 'a'.repeat(64), workspaceId: 'main', clientProvider: 'codex', requestedActions: ['observe'], observationDeadlineMs: 10000, escalationDeadlineMs: 30000 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'supervision_unavailable');
    const decision = await api.callExternal('POST', `/api/v2/control-grants/${randomUUID()}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(decision.status, 403, 'a grant decision is first-party only');
  } finally { await api.close(); }
});

test('an unverified client matrix refuses a grant even when a supervisor exists', async () => {
  const api = await startTestRunner();
  try {
    api.runner.engine.supervisor = fakeSupervisor();
    const session = await api.callExternal('POST', '/api/v2/controller-sessions', { requestId: randomUUID(), clientLabel: 'test', clientProvider: 'claude' });
    const refused = await api.callExternal('POST', '/api/v2/control-grants', { requestId: randomUUID(), controllerSessionId: session.body.controllerSessionId,
      workflowId: 'w', workflowSnapshotSha256: 'a'.repeat(64), workspaceId: 'main', clientProvider: 'claude', requestedActions: ['observe'], observationDeadlineMs: 10000, escalationDeadlineMs: 30000 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /tool-timeout matrix is unverified/);
  } finally { await api.close(); }
});

test('incidents are filed by any authorised writer, triaged only by the first-party credential, and record their authority', async () => {
  const api = await startTestRunner();
  try {
    const filed = await api.callExternal('POST', '/api/v2/incidents', { requestId: randomUUID(), observation: incidentObservation({ reporter: { authority: 'first-party', sessionId: null } }) });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const incidentId = filed.body.incidentId;
    const detail = await api.call('GET', `/api/v2/incidents/${incidentId}`);
    assert.equal(detail.body.initial.reporter.authority, 'external', 'the recorded authority is the caller\'s, not the body\'s');
    const external = await api.callExternal('POST', `/api/v2/incidents/${incidentId}/triage`, { requestId: randomUUID(), state: 'closed' });
    assert.equal(external.status, 403, 'triage is first-party only');
    const appended = await api.callExternal('POST', `/api/v2/incidents/${incidentId}/observations`, { requestId: randomUUID(), observation: incidentObservation({ actual: 'Again.' }) });
    assert.equal(appended.status, 201, JSON.stringify(appended.body));
    const triaged = await api.call('POST', `/api/v2/incidents/${incidentId}/triage`, { requestId: randomUUID(), state: 'triaged', causeStatus: 'confirmed', note: 'Reproduced.' });
    assert.equal(triaged.status, 200, JSON.stringify(triaged.body));
    const after = await api.call('GET', `/api/v2/incidents/${incidentId}`);
    assert.equal(after.body.state, 'triaged');
    assert.equal(after.body.causeStatus, 'confirmed');
    assert.deepEqual(after.body.updates.map(update => [update.kind, update.authority]), [['observation', 'external'], ['cause', 'first-party']]);
    const listed = await api.call('GET', '/api/v2/incidents?state=triaged');
    assert.ok(listed.body.items.some(item => item.incidentId === incidentId));
  } finally { await api.close(); }
});

test('stop-and-report stops the run, files one incident per request, and records a headless termination as unconfirmed', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    const requestId = randomUUID();
    const report = await api.callExternal('POST', `/api/v2/runs/${runId}/stop-and-report`, { requestId, reason: 'Suspected scheduling defect.', observation: incidentObservation({ runId }) });
    assert.equal(report.status, 202, JSON.stringify(report.body));
    assert.equal(report.body.incident.persisted, true);
    const incidentId = report.body.incident.incidentId;
    const ended = await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    assert.equal(ended.run.state, 'canceled');
    const proof = await waitUntil(() => api.runner.engine.store.get('SELECT outcome, containment, control_mode FROM termination_proofs WHERE run_id = ?', runId));
    assert.equal(proof.outcome, 'termination_unconfirmed', 'with no native containment, direct exit is not proof');
    assert.equal(proof.containment, 'none');
    assert.equal(proof.control_mode, 'unsupervised');
    const retried = await api.callExternal('POST', `/api/v2/runs/${runId}/stop-and-report`, { requestId, reason: 'Suspected scheduling defect.', observation: incidentObservation({ runId }) });
    assert.equal(retried.body.incident.incidentId, incidentId, 'a retried report reconciles with the same incident');
    const listed = await api.call('GET', `/api/v2/incidents?runId=${runId}`);
    assert.equal(listed.body.items.length, 1);
    const journal = api.runner.engine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'run.termination_proof'", runId);
    assert.equal(journal.n, 1, 'the termination proof is journaled on a journal-v2 run');
  } finally { await api.close(); }
});

test('a finished run exports a verifiable audit bundle; the shareable profile omits raw streams and says so', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent());
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'succeeded');
    const bundle = await api.call('POST', `/api/v2/runs/${runId}/audit-bundles`, { requestId: randomUUID(), profile: 'private-local' });
    assert.equal(bundle.status, 201, JSON.stringify(bundle.body));
    assert.equal(bundle.body.state, 'complete', 'every stream closed and the run ended');
    const manifest = JSON.parse(readFileSync(join(bundle.body.directory, 'manifest.json'), 'utf8'));
    assertValid('audit-manifest.schema.json', 'auditManifest', manifest);
    for (const member of manifest.members) {
      const bytes = readFileSync(join(bundle.body.directory, ...member.path.split('/')));
      assert.equal(sha256(bytes), member.sha256, `${member.path} matches its recorded digest`);
      assert.equal(bytes.length, member.byteSize);
    }
    assert.ok(manifest.members.some(member => member.path === 'journal.jsonl'));
    const shared = await api.call('POST', `/api/v2/runs/${runId}/audit-bundles`, { requestId: randomUUID(), profile: 'shareable' });
    assert.equal(shared.status, 201);
    const sharedManifest = JSON.parse(readFileSync(join(shared.body.directory, 'manifest.json'), 'utf8'));
    assert.ok(sharedManifest.omissions.some(item => item.category === 'raw-process-streams'), 'the shareable profile declares its omission');
    assert.ok(sharedManifest.members.length < manifest.members.length, 'the shareable members are a strict subset of the private ones');
    assert.equal((await api.call('GET', `/api/v2/audit-bundles/${bundle.body.exportId}`)).body.present, true);
  } finally { await api.close(); }
});

test('watch returns the journal after a cursor, acknowledgement records its lag, and command status reconciles', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent());
    const runId = created.body.run.runId;
    const ended = await api.waitFor(runId, run => run.state === 'succeeded');
    const first = await api.call('GET', `/api/v2/runs/${runId}/watch?cursor=0&waitMs=0`);
    assert.equal(first.status, 200);
    assert.equal(first.body.reason, 'event');
    assert.ok(first.body.events.length > 0);
    assert.ok(first.body.nextCursor > 0);
    assert.equal(ended.run.state, 'succeeded');
    const done = await api.call('GET', `/api/v2/runs/${runId}/watch?cursor=${first.body.lastSequence}&waitMs=50`);
    assert.equal(done.body.reason, 'terminal');
    assert.equal(done.body.terminal, true);
    const ack = await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId: randomUUID(), cursor: first.body.nextCursor });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(typeof ack.body.lagMs, 'number');
    assert.equal(ack.body.controlMode, 'unsupervised');
    const requestId = randomUUID();
    await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId, cursor: 0 });
    const status = await api.call('GET', `/api/v2/command-status/${requestId}`);
    assert.equal(status.body.state, 'committed');
    assert.equal((await api.call('GET', `/api/v2/command-status/${randomUUID()}`)).body.state, 'unknown');
  } finally { await api.close(); }
});

test('an artifact range is byte-exact, carries its own digest, and never splits more than the request asked for', async () => {
  const api = await startTestRunner();
  try {
    const bytes = Buffer.from('héllo wörld, ünïcode', 'utf8');
    const artifact = api.runner.engine.store.putBytes(bytes, 'text/plain; charset=utf-8');
    const range = await api.call('GET', `/api/v2/artifacts/${artifact.artifactId}/range?offset=1&length=4`);
    assert.equal(range.status, 200);
    assert.equal(range.body.encoding, 'base64');
    assert.deepEqual(Buffer.from(range.body.data, 'base64'), bytes.subarray(1, 5));
    assert.equal(range.body.rangeSha256, sha256(bytes.subarray(1, 5)));
    assert.equal(range.body.byteSize, bytes.length);
    assert.equal(range.body.eof, false);
    const tail = await api.call('GET', `/api/v2/artifacts/${artifact.artifactId}/range?offset=${bytes.length - 2}&length=65536`);
    assert.equal(tail.body.eof, true);
    assert.deepEqual(Buffer.from(tail.body.data, 'base64'), bytes.subarray(bytes.length - 2));
    assert.equal((await api.call('GET', `/api/v2/artifacts/${artifact.artifactId}/range?offset=${bytes.length + 1}`)).status, 400);
  } finally { await api.close(); }
});

test('a Stop on a live run produces a termination proof that the run records before it returns to the runtime', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    const stop = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202);
    await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    const proof = await waitUntil(() => api.runner.engine.store.get('SELECT outcome FROM termination_proofs WHERE run_id = ?', runId));
    assert.equal(proof.outcome, 'termination_unconfirmed');
    const proofs = api.runner.engine.store.get('SELECT COUNT(*) AS n FROM termination_proofs WHERE run_id = ?', runId);
    assert.equal(proofs.n, 1);
  } finally { await api.close(); }
});

test('a supervised run is armed before its first launch, a missed acknowledgement pauses dispatch, and escalation stops the run', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  const supervisor = fakeSupervisor();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    engine.supervisor = supervisor;
    const seeded = seedApprovedGrant(engine, runId);
    const { grantId } = seeded;
    engine.bindControlGrant(grantId, { runId, ...bindFor(seeded) });
    assert.equal(engine.controlModeOf(runId), 'supervised');
    await waitUntil(() => !engine.awaitingArm.has(runId));
    assert.deepEqual(supervisor.arms[0], { runId, grantId, observationDeadlineMs: 5000, escalationDeadlineMs: 20000 }, 'the observer is armed with the grant deadlines');
    // A missed acknowledgement pauses new dispatch and raises an incident; a fresh acknowledgement resumes.
    engine.store.run("UPDATE control_grants SET last_ack_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), grantId);
    engine.watchdogTick(grantId, runId);
    assert.ok(engine.dispatchPaused.has(runId));
    const incidents = engine.listIncidents({ runId });
    assert.ok(incidents.items.some(item => item.category === 'controller_unresponsive' && item.severity === 'high'));
    const ack = await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId: randomUUID(), cursor: 0 }, credentialFor(seeded));
    assert.equal(ack.status, 200);
    assert.equal(engine.dispatchPaused.has(runId), false, 'a fresh acknowledgement resumes dispatch');
    const extendBody = { requestId: randomUUID(), extensionMs: 60000, reason: 'The controller is busy.' };
    const external = await api.callExternal('POST', `/api/v2/runs/${runId}/control-extension`, { ...extendBody, requestId: randomUUID() });
    assert.equal(external.status, 403, 'an extension is first-party only');
    const extended = await api.call('POST', `/api/v2/runs/${runId}/control-extension`, extendBody);
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.confirmed.extendedByMs, 60000);
    const replayed = await api.call('POST', `/api/v2/runs/${runId}/control-extension`, extendBody);
    assert.deepEqual(replayed.body, extended.body, 'a retried extension replays its answer');
    assert.equal(supervisor.calls.filter(([op]) => op === 'extend').length, 1, 'the supervisor is asked once');
    // The supervisor escalates on its own clock; the runtime records the escalation and stops the run.
    supervisor.escalated = true;
    await engine.checkEscalation(runId);
    assert.ok(engine.listIncidents({ runId }).items.some(item => item.severity === 'critical'));
    await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    const proof = await waitUntil(() => engine.store.get('SELECT outcome, containment FROM termination_proofs WHERE run_id = ?', runId));
    assert.equal(proof.containment, 'windows-job', 'the supervisor proved the Stop');
    assert.equal(proof.outcome, 'stopped');
    assert.ok(supervisor.calls.some(([op]) => op === 'prove'));
  } finally {
    for (const runId of engine.watchdogs.keys()) engine.stopWatchdog(runId);
    await api.close();
  }
});

test('controller-paused Root Stop finalizes an idle supervised run without dispatching more work', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  try {
    const seeded = await pendingSupervisedRun(api);
    const approval = await api.call('POST', `/api/v2/run-requests/${seeded.command.requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(approval.status, 202, JSON.stringify(approval.body));
    const runId = approval.body.run.runId;
    await api.waitFor(runId, run => run.state === 'waiting_for_user');
    assert.equal(engine.liveIn(engine.runs.get(runId)).length, 0, 'the shim refusal has left no launched child');
    engine.store.run('UPDATE control_grants SET last_ack_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), seeded.grantId);
    engine.watchdogTick(seeded.grantId, runId);
    assert.equal(engine.dispatchPaused.has(runId), true);
    const attemptsBeforeStop = engine.store.get('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?', runId).n;
    engine.supervisor.escalated = true;
    await engine.checkEscalation(runId);
    const ended = await api.waitFor(runId, run => ENDED.includes(run.state), 2_000);
    assert.equal(ended.run.state, 'canceled');
    const proof = await waitUntil(() => engine.store.get('SELECT outcome, containment, proof_artifact_id FROM termination_proofs WHERE run_id = ?', runId), 2_000);
    assert.equal(proof.outcome, 'stopped');
    assert.equal(proof.containment, 'none', 'an empty launch set is proven without claiming native process containment');
    const record = engine.store.readJson(proof.proof_artifact_id);
    assert.equal(record.controlMode, 'supervised', 'the proof retains execution mode after the grant ends');
    assert.equal(record.ownedAttempts, 0);
    assert.deepEqual(record.members, []);
    assert.ok(engine.supervisor.calls.some(([operation]) => operation === 'prove'));
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?', runId).n, attemptsBeforeStop, 'Stop does not plan another attempt');
    assert.ok(engine.store.all('SELECT process_id FROM attempts WHERE run_id = ?', runId).every(attempt => attempt.process_id === null), 'no child was launched after controller pause');
    assert.equal(engine.activeGrant(runId), null, 'ending the run ends its control grant');
    assert.equal(engine.watchdogs.has(runId), false);
    assert.equal(engine.dispatchPaused.has(runId), false);
  } finally { await api.close(); }
});

test('an incident spooled while the store was unavailable is reconciled into the registry on the next start', async () => {
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, 'spool-'));
  const incidentId = randomUUID();
  mkdirSync(join(root, 'spool', 'incidents'), { recursive: true });
  const spoolFile = join(root, 'spool', 'incidents', `${incidentId}.json`);
  writeFileSync(spoolFile, JSON.stringify({ incidentId, spooledAt: new Date().toISOString(), runId: null, observation: incidentObservation(), reason: 'The store was unavailable.' }));
  const api = await startTestRunner({ root });
  try {
    const incident = await api.call('GET', `/api/v2/incidents/${incidentId}`);
    assert.equal(incident.status, 200);
    assert.equal(incident.body.title, incidentObservation().title);
    assert.equal(existsSync(spoolFile), false, 'a reconciled spool file is removed');
  } finally { await api.close(); }
});

test('a refused arm revokes the grant and stops the run after exactly one arm request, with no unhandled rejection', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  const supervisor = fakeSupervisor({ refuseArm: true });
  const unhandled = [];
  const record = error => unhandled.push(error);
  process.on('unhandledRejection', record);
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    engine.supervisor = supervisor;
    const seeded = seedApprovedGrant(engine, runId);
    const { grantId } = seeded;
    engine.bindControlGrant(grantId, { runId, ...bindFor(seeded) });
    await waitUntil(() => !engine.awaitingArm.has(runId));
    await new Promise(done => setTimeout(done, 100));
    assert.equal(supervisor.calls.filter(([op]) => op === 'arm').length, 1, 'the arm is requested exactly once');
    assert.equal(engine.store.get('SELECT state FROM control_grants WHERE id = ?', grantId).state, 'revoked');
    await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    assert.deepEqual(unhandled, [], 'a refused arm is handled, not an unhandled rejection');
  } finally {
    process.off('unhandledRejection', record);
    for (const id of api.runner.engine.watchdogs.keys()) api.runner.engine.stopWatchdog(id);
    await api.close();
  }
});

test('a truncated spool file is quarantined and recorded as a capture gap, and startup continues', async () => {
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, 'truncated-spool-'));
  const incidentId = randomUUID();
  mkdirSync(join(root, 'spool', 'incidents'), { recursive: true });
  const spoolFile = join(root, 'spool', 'incidents', `${incidentId}.json`);
  writeFileSync(spoolFile, '{"incidentId": "' + incidentId + '", "observation": {"title": "trunc');
  const api = await startTestRunner({ root });
  try {
    assert.equal(existsSync(spoolFile), false, 'the damaged file leaves the spool');
    assert.ok(existsSync(join(root, 'spool', 'incidents', 'quarantine', `${incidentId}.json`)), 'the damaged file is kept for inspection');
    const gaps = api.runner.engine.listIncidents({});
    assert.ok(gaps.items.some(item => item.category === 'capture_gap'), 'the damaged report is a recorded capture gap');
  } finally { await api.close(); }
});

test('a retried spool write for the same incident overwrites the entry instead of failing', async () => {
  const api = await startTestRunner();
  try {
    const engine = api.runner.engine;
    const incidentId = randomUUID();
    const first = engine.spoolIncident(incidentId, { runId: null, observation: incidentObservation(), reason: 'first attempt' });
    const second = engine.spoolIncident(incidentId, { runId: null, observation: incidentObservation(), reason: 'retried attempt' });
    assert.equal(first, second);
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).reason, 'retried attempt');
  } finally { await api.close(); }
});

test('an unknown supervisor record never proves a stop', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    engine.supervisor = { ...fakeSupervisor(), proveStopped: () => Promise.resolve({ containment: 'windows-job', confirmed: false, remainingMembers: null, reason: 'unknown Job' }) };
    const stop = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202);
    await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    const proof = await waitUntil(() => engine.store.get('SELECT outcome FROM termination_proofs WHERE run_id = ?', runId));
    assert.equal(proof.outcome, 'termination_unconfirmed');
  } finally {
    for (const id of engine.watchdogs.keys()) engine.stopWatchdog(id);
    await api.close();
  }
});

test('a supervised run is acknowledged only with its grant\'s controller credential', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    engine.supervisor = fakeSupervisor();
    const seeded = seedApprovedGrant(engine, runId);
    engine.bindControlGrant(seeded.grantId, { runId, ...bindFor(seeded) });
    await waitUntil(() => !engine.awaitingArm.has(runId));
    const body = { requestId: randomUUID(), cursor: 0 };
    const none = await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, body);
    assert.equal(none.status, 403, 'an acknowledgement without the credential is refused');
    assert.equal(none.body.code, 'controller_credential_required');
    const other = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'other', clientProvider: 'codex' }).body;
    const wrong = await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId: randomUUID(), cursor: 0 }, { headers: { 'X-Deszo-Controller-Token': other.controllerToken } });
    assert.equal(wrong.status, 403, 'another session\'s credential is refused');
    const right = await api.call('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId: randomUUID(), cursor: 0 }, credentialFor(seeded));
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(engine.store.get('SELECT controller_session_id FROM observation_acks WHERE run_id = ? ORDER BY acknowledged_at DESC LIMIT 1', runId).controller_session_id, seeded.sessionId, 'the acknowledgement records the authenticated session');
    assert.notEqual(engine.store.get('SELECT token_sha256 FROM controller_sessions WHERE id = ?', seeded.sessionId).token_sha256, seeded.token, 'only the hash of the credential is stored');
  } finally {
    for (const id of engine.watchdogs.keys()) engine.stopWatchdog(id);
    await api.close();
  }
});

test('a grant pins its workflow revision, and requesting or binding it needs the controller credential', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  const codex = clientTimeouts.entries.find(entry => entry.provider === 'codex');
  const savedStatus = codex.status;
  codex.status = 'verified';
  engine.supervisor = fakeSupervisor();
  try {
    await api.workspace();
    const saved = await api.save(singleAgent({ id: 'pinned' }));
    const session = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'test controller', clientProvider: 'codex' }).body;
    const request = sha => ({ requestId: randomUUID(), controllerSessionId: session.controllerSessionId, workflowId: 'pinned', workflowSnapshotSha256: sha,
      workspaceId: 'main', clientProvider: 'codex', clientVersion: codex.testedVersion, requestedActions: ['observe'], observationDeadlineMs: 10000, escalationDeadlineMs: 30000 });
    const refusal = (fn, status, code) => { try { fn(); } catch (error) { assert.equal(error.status, status, error.message); assert.equal(error.code, code); return; } assert.fail(`expected ${status} ${code}`); };
    refusal(() => engine.requestControlGrant(request('f'.repeat(64)), { controllerToken: session.controllerToken }), 409, 'conflict');
    refusal(() => engine.requestControlGrant(request(saved.snapshotSha256), { controllerToken: null }), 403, 'controller_credential_required');
    const pending = engine.requestControlGrant(request(saved.snapshotSha256), { controllerToken: session.controllerToken }).body;
    assert.equal(pending.state, 'pending');
    engine.decideControlGrant(pending.grantId, { requestId: randomUUID(), decision: 'approve' });
    const bind = { workflowId: 'pinned', workspaceId: 'main' };
    refusal(() => engine.bindControlGrant(pending.grantId, { runId: randomUUID(), ...bind, snapshotSha256: 'f'.repeat(64), controllerToken: session.controllerToken }), 409, 'conflict');
    refusal(() => engine.bindControlGrant(pending.grantId, { runId: randomUUID(), ...bind, snapshotSha256: saved.snapshotSha256, controllerToken: null }), 403, 'controller_credential_required');
    assert.equal(engine.store.get('SELECT state FROM control_grants WHERE id = ?', pending.grantId).state, 'approved', 'a refused bind changes nothing');
    assert.notEqual(engine.store.get('SELECT token_sha256 FROM controller_sessions WHERE id = ?', session.controllerSessionId).token_sha256, session.controllerToken);
  } finally {
    codex.status = savedStatus;
    await api.close();
  }
});

async function pendingSupervisedRun(api) {
  const engine = api.runner.engine;
  engine.supervisor = fakeSupervisor();
  await api.workspace();
  const current = engine.currentSettings();
  await api.call('PUT', '/api/v2/settings', {requestId: randomUUID(), expectedRevision: current.revision,
    settings: {...current.settings, externalRunConfirmation: true}});
  const saved = await api.save(singleAgent({id: 'supervised-approval', context: null}));
  const session = engine.createControllerSession({requestId: randomUUID(), clientLabel: 'approval controller', clientProvider: 'codex'}).body;
  const grantBody = {requestId: randomUUID(), controllerSessionId: session.controllerSessionId, workflowId: 'supervised-approval',
    workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', clientProvider: 'codex',
    clientVersion: clientTimeouts.entries.find(x => x.provider === 'codex').testedVersion,
    requestedActions: ['observe', 'acknowledge', 'stop'], observationDeadlineMs: 10000, escalationDeadlineMs: 30000};
  const options = {headers: {'X-Deszo-Controller-Token': session.controllerToken}};
  const wrongVersion = await api.callExternal('POST', '/api/v2/control-grants', {...grantBody, requestId: randomUUID(), clientVersion: 'unmeasured-version'}, options);
  assert.equal(wrongVersion.status, 409);
  assert.equal(wrongVersion.body.code, 'supervision_unavailable');
  const grant = await api.callExternal('POST', '/api/v2/control-grants', grantBody, options);
  assert.equal(grant.status, 202, JSON.stringify(grant.body));
  assert.equal((await api.callExternal('GET', '/api/v2/control-grants')).status, 403, 'only the first-party app can list the approval queue');
  const queue = await api.call('GET', '/api/v2/control-grants');
  assert.equal(queue.body.items[0].workflowSnapshotSha256, saved.snapshotSha256);
  assert.equal(queue.body.items[0].clientLabel, 'approval controller');
  assert.equal(queue.body.items[0].clientVersion, grantBody.clientVersion);
  await api.call('POST', `/api/v2/control-grants/${grant.body.grantId}/decision`, {requestId: randomUUID(), decision: 'approve'});
  const command = {requestId: randomUUID(), workflowId: 'supervised-approval', workflowSnapshotSha256: saved.snapshotSha256,
    workspaceId: 'main', controlGrantId: grant.body.grantId};
  const withoutCredential = await api.callExternal('POST', '/api/v2/runs', {...command, requestId: randomUUID()});
  assert.equal(withoutCredential.status, 403);
  const pending = await api.callExternal('POST', '/api/v2/runs', command, options);
  assert.equal(pending.body.outcome, 'confirmation_pending', JSON.stringify(pending.body));
  assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  assert.equal(JSON.stringify(engine.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', command.requestId)).includes(session.controllerToken), false);
  const status = await api.callExternal('GET', `/api/v2/run-requests/${command.requestId}`);
  assert.equal(status.body.controlModeRequested, 'supervised');
  assert.equal(status.body.controlGrantId, grant.body.grantId);
  return {command, session, grantId: grant.body.grantId};
}

test('first-party approval binds a pending supervised run after restart without persisting its controller secret', async () => {
  const first = await startTestRunner();
  let seeded;
  try {seeded = await pendingSupervisedRun(first);} finally {await first.close();}
  const api = await startTestRunner({root: first.root});
  api.runner.engine.supervisor = fakeSupervisor();
  try {
    const approval = await api.call('POST', `/api/v2/run-requests/${seeded.command.requestId}/decision`, {requestId: randomUUID(), decision: 'approve'});
    assert.equal(approval.status, 202, JSON.stringify(approval.body));
    assert.equal(approval.body.run.controlMode, 'supervised');
    assert.equal(approval.body.request.controlModeRequested, 'supervised');
    const runId = approval.body.run.runId;
    await api.waitFor(runId, run => run.state === 'waiting_for_user');
    assert.deepEqual(api.runner.engine.supervisor.arms.map(x => x.runId), [runId], 'the native arm happens exactly once');
    const attempts = api.runner.engine.store.all('SELECT process_id FROM attempts WHERE run_id = ?', runId);
    assert.ok(attempts.every(x => x.process_id === null), 'the fake supervisor has no shim and must not fall back to direct process creation');
    await api.call('POST', `/api/v2/runs/${runId}/stop`, {requestId: randomUUID()});
    await api.waitFor(runId, run => ENDED.includes(run.state));
  } finally {await api.close();}
});

test('revoking a pending run grant prevents capture and cannot fall back to an ordinary run', async () => {
  const api = await startTestRunner();
  try {
    const seeded = await pendingSupervisedRun(api);
    await api.call('POST', `/api/v2/control-grants/${seeded.grantId}/revoke`, {requestId: randomUUID(), reason: 'Operator revoked before dispatch.'});
    const approval = await api.call('POST', `/api/v2/run-requests/${seeded.command.requestId}/decision`, {requestId: randomUUID(), decision: 'approve'});
    assert.equal(approval.status, 409, JSON.stringify(approval.body));
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
    assert.equal(api.runner.engine.supervisor.arms.length, 0);
    assert.equal((await api.callExternal('GET', `/api/v2/run-requests/${seeded.command.requestId}`)).body.state, 'denied');
  } finally {await api.close();}
});

test('the emergency credential goes only to the granted controller, and the run ending ends it', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    engine.supervisor = fakeSupervisor();
    const seeded = seedApprovedGrant(engine, runId);
    engine.bindControlGrant(seeded.grantId, { runId, ...bindFor(seeded) });
    await waitUntil(() => !engine.awaitingArm.has(runId));
    const path = `/api/v2/runs/${runId}/emergency-credential`;
    assert.equal((await api.call('GET', path)).status, 403, 'no controller credential, no emergency credential');
    const other = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'other', clientProvider: 'codex' }).body;
    assert.equal((await api.call('GET', path, undefined, { headers: { 'X-Deszo-Controller-Token': other.controllerToken } })).status, 403);
    const issued = await api.call('GET', path, undefined, credentialFor(seeded));
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.emergencyToken, 'emergency-token-for-test');
    assert.equal(issued.body.pipeName, 'pipe-test');
    const stop = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202);
    await api.waitFor(runId, run => ENDED.includes(run.state), 30_000);
    assert.equal(engine.emergencyCredentials.has(runId), false, 'the credential is forgotten when the run ends');
    assert.equal((await api.call('GET', path, undefined, credentialFor(seeded))).status, 409);
  } finally {
    for (const id of engine.watchdogs.keys()) engine.stopWatchdog(id);
    await api.close();
  }
});

test('building an audit bundle with a 64 MiB object keeps the event loop responsive, and the worst stall is measured', async t => {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const api = await startTestRunner();
  const engine = api.runner.engine;
  try {
    await api.workspace();
    const created = await api.run(singleAgent());
    const runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'succeeded');
    // Evidence references the object by its artifact, so the bundle's closure includes it without parsing it as JSON.
    const large = engine.store.putBytes(Buffer.alloc(64 * 1024 * 1024, 0x61), 'application/x-deszo-test');
    const attempt = engine.store.get('SELECT id, node_instance_id FROM attempts WHERE run_id = ? LIMIT 1', runId);
    engine.store.run('INSERT INTO execution_evidence(id, run_id, attempt_id, outcome, evidence_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(), runId, attempt.id, 'passed', large.artifactId, new Date().toISOString());
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const bundle = await api.call('POST', `/api/v2/runs/${runId}/audit-bundles`, { requestId: randomUUID(), profile: 'private-local' });
    histogram.disable();
    assert.equal(bundle.status, 201, JSON.stringify(bundle.body));
    const manifest = JSON.parse(readFileSync(join(bundle.body.directory, 'manifest.json'), 'utf8'));
    assert.ok(manifest.members.some(member => member.role === 'object' && member.byteSize === 64 * 1024 * 1024), 'the large object is a bundle member');
    const worstMs = histogram.max / 1e6;
    t.diagnostic(`worst event-loop stall while building a 64 MiB bundle: ${worstMs.toFixed(1)} ms`);
    assert.ok(worstMs < 2000, `the event loop stalled for ${worstMs.toFixed(1)} ms`);
  } finally { await api.close(); }
});
