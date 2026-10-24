import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RunObserver } from '../../mcp/run-observer.mjs';

function fixture({ events = [], supervised = true } = {}) {
  const runId = randomUUID(), sessionId = randomUUID(), calls = [], durableAcks = new Map();
  let cursor = 0;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/control')) return { controlMode: supervised ? 'supervised' : 'unsupervised', controller: supervised ? {
      controllerSessionId: sessionId, state: 'active', ackCursor: cursor, observationDeadlineMs: 90_000,
      escalationDeadlineMs: 180_000, millisecondsSinceAcknowledgement: 2000 } : null };
    if (path.includes('/watch?')) {
      const after = Number(new URL(path, 'http://local').searchParams.get('cursor'));
      return { state: 'running', controlMode: supervised ? 'supervised' : 'unsupervised', terminal: false,
        events: events.filter(e => e.sequence > after), nextCursor: events.at(-1)?.sequence ?? after,
        lastSequence: events.at(-1)?.sequence ?? 0, skippedRanges: [] };
    }
    if (path.endsWith('/observation-acks')) {
      if (!durableAcks.has(body.requestId)) durableAcks.set(body.requestId, { runId, cursor: body.cursor, acknowledgedAt: new Date().toISOString() });
      cursor = Math.max(cursor, body.cursor);
      return durableAcks.get(body.requestId);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const options = { api, headersFor: id => { assert.equal(id, sessionId); return { credential: 'held-in-bridge' }; }, prepareEmergency: async () => true };
  return { runId, sessionId, calls, events, durableAcks, options, observer: new RunObserver(options) };
}
const event = (sequence, payload = {}) => ({ sequence, type: 'attempt.state_changed', timestamp: '2026-10-19T12:00:00.000Z',
  nodeInstanceId: 'agent', attemptId: randomUUID(), payload });
const ack = (f, observation, overrides = {}) => f.observer.acknowledge({ runId: f.runId, controllerSessionId: f.sessionId,
  observationId: observation.observationId, requestId: randomUUID(), ...overrides });

test('observation batches are bounded, contiguous and cannot ACK a later live snapshot', async () => {
  const f = fixture({ events: Array.from({ length: 100 }, (_, i) => event(i + 1, { to: 'scheduled', reason: 'Planned before dispatch.' })) });
  const first = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 4096);
  assert.ok(first.cursor > 0 && first.cursor < 100);
  assert.deepEqual(first.events.map(e => e.sequence), Array.from({ length: first.cursor }, (_, i) => i + 1));
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0, 'reading never renews the lease');
  f.events.push(event(101));
  const replay = await f.observer.observe({ runId: f.runId, maxBytes: 4096 });
  assert.equal(replay.observationId, first.observationId);
  assert.equal(replay.lastSequenceAtObservation, 100, 'a fresh health read does not rewrite the captured event boundary');
  await assert.rejects(ack(f, first, { cursor: 101 }), { code: 'observation_mismatch' });
  await ack(f, first);
  const next = await f.observer.observe({ runId: f.runId, maxBytes: 4096 });
  assert.equal(next.fromCursor, first.cursor);
  assert.equal(next.events[0].sequence, first.cursor + 1);
});

test('an oversized Unicode payload remains inspectable and blocks ACK until every byte has been returned', async () => {
  const payload = { reason: 'Проблема 🔍\n'.repeat(2000) };
  const f = fixture({ events: [event(1, payload), event(2)] });
  const observation = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 4096);
  assert.equal(observation.cursor, 1);
  assert.equal(observation.unreadDetails.length, 1);
  const detailId = observation.unreadDetails[0].detailId;
  await assert.rejects(ack(f, observation), { code: 'observation_incomplete' });
  assert.throws(() => f.observer.readDetail({ observationId: observation.observationId, detailId, offset: 10 }), { code: 'observation_detail_gap' });
  let reconstructed = '', result;
  do {
    result = f.observer.readDetail({ observationId: observation.observationId, detailId });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
    assert.ok(!result.text.includes('\ufffd'));
    reconstructed += result.text;
  } while (!result.eof);
  assert.deepEqual(JSON.parse(reconstructed), payload);
  await ack(f, observation);
  const next = await f.observer.observe({ runId: f.runId });
  assert.equal(next.events[0].sequence, 2);
});

test('context recovery exposes pending receipt/cursors; a new bridge cannot reuse that receipt', async () => {
  const f = fixture({ events: [event(1)] });
  const observation = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId });
  const restored = JSON.parse(JSON.stringify(f.observer.state()));
  assert.equal(restored.runs[0].pendingObservationId, observation.observationId);
  assert.equal(restored.runs[0].acknowledgedCursor, 0);
  assert.equal(restored.automaticAcknowledgement, false);
  assert.ok(!JSON.stringify(restored).includes('held-in-bridge'));
  const replacement = new RunObserver(f.options);
  await assert.rejects(replacement.acknowledge({ runId: f.runId, observationId: observation.observationId, requestId: randomUUID() }), { code: 'observation_required' });
});

test('a lost ACK response retries one durable command and never renews a receipt with another requestId', async () => {
  const f = fixture({ events: [event(1)] });
  const api = f.observer.api;
  let lose = true;
  f.observer.api = async (...args) => {
    const result = await api(...args);
    if (args[0] === 'POST' && lose) { lose = false; throw new Error('Response lost after commit'); }
    return result;
  };
  const observation = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId });
  const requestId = randomUUID();
  await assert.rejects(ack(f, observation, { requestId }), /Response lost/);
  assert.equal(f.observer.state().runs[0].ackRequestId, requestId);
  await assert.rejects(ack(f, observation), { code: 'ack_request_conflict' });
  const settled = await ack(f, observation, { requestId });
  const count = f.calls.length;
  assert.deepEqual(await ack(f, observation, { requestId }), settled);
  assert.equal(f.calls.length, count, 'replaying a settled receipt does not heartbeat again');
  assert.equal(f.durableAcks.size, 1);
});

test('a no-event period requires a new health observation for each explicit acknowledgement', async () => {
  const f = fixture();
  const first = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId });
  const requestId = randomUUID();
  await ack(f, first, { requestId });
  await ack(f, first, { requestId });
  const second = await f.observer.observe({ runId: f.runId });
  assert.notEqual(second.observationId, first.observationId);
  assert.equal(second.cursor, 0);
  await ack(f, second);
  assert.equal(f.durableAcks.size, 2);
});

test('journal gaps cannot be acknowledged', async () => {
  const f = fixture({ events: [event(1), event(3)] });
  await assert.rejects(f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId }), { code: 'observation_gap' });
  assert.equal(f.observer.state().runs[0].pendingObservationId, null);
  assert.equal(f.durableAcks.size, 0);
});

test('a smaller retry bound cannot silently cut a pending observation', async () => {
  const f = fixture({ events: Array.from({ length: 100 }, (_, i) => event(i + 1, { reason: 'A complete event payload.' })) });
  const first = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId, maxBytes: 8192 });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) > 4096);
  await assert.rejects(f.observer.observe({ runId: f.runId, maxBytes: 4096 }), { code: 'pending_observation_bound' });
  assert.equal(f.observer.state().runs[0].pendingObservationId, first.observationId);
  assert.equal(f.durableAcks.size, 0);
});

test('parallel observations cannot replace a pending receipt, and a bounded timeout sends no ACK', async () => {
  const f = fixture({ events: [event(1)] });
  const api = f.observer.api;
  let release;
  const barrier = new Promise(done => { release = done; });
  f.observer.api = async (...args) => { if (args[1].includes('/watch?')) await barrier; return api(...args); };
  f.observer.observationTimeoutMs = 10;
  const first = f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId });
  await assert.rejects(f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId }), { code: 'observer_busy' });
  await assert.rejects(first, { code: 'observation_timeout' });
  assert.equal(f.durableAcks.size, 0);
  assert.equal(f.observer.state().runs[0].operationInFlight, true);
  release();
  await new Promise(done => setImmediate(done));
  const recovered = await f.observer.observe({ runId: f.runId, controllerSessionId: f.sessionId });
  assert.equal(recovered.cursor, 1, 'the late read is recovered as an unacknowledged observation');
  assert.equal(f.durableAcks.size, 0);
});

test('approval wait reconciles the same request, prepares emergency Stop and returns an observation without ACK', async () => {
  const f = fixture({ events: [event(1)] }), requestId = randomUUID();
  const input = { requestId, workflowId: 'pilot', workspaceId: 'main', workflowSnapshotSha256: 'a'.repeat(64), controlGrantId: randomUUID(), controllerSessionId: f.sessionId };
  f.observer.rememberRequest(input, { outcome: 'confirmation_pending' });
  let reads = 0, prepared = false;
  const api = f.observer.api;
  f.observer.api = async (...args) => args[1].includes('/run-requests/')
    ? { ...input, state: ++reads === 1 ? 'pending' : 'approved', runId: reads === 1 ? null : f.runId }
    : api(...args);
  f.observer.prepareEmergency = async (runId, sessionId) => { assert.equal(runId, f.runId); assert.equal(sessionId, f.sessionId); prepared = true; return true; };
  const result = await f.observer.awaitStart({ requestId, waitMs: 10 });
  assert.equal(result.request.state, 'approved');
  assert.equal(result.observation.runId, f.runId);
  assert.equal(result.emergencyPrepared, true);
  assert.ok(prepared);
  assert.equal(f.durableAcks.size, 0);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0, 'the wait never creates a second run');
});
