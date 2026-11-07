// Deterministic boundary tests for the ADR-0007 amended timing contract (controlled clock; no Codex involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMING, createRequest, enterQueue, expiryAt, admitQueued, observeTurnStarted } from './judge-attention-timing.mjs';

test('T01 timing: an immediately dispatchable request must reach confirmed turn_started before 30 000 ms from creation', () => {
  assert.equal(TIMING.deliveryDeadlineMs, 30_000);
  const inTime = createRequest({ requestId: 'a', t0: 0 });
  assert.deepEqual(observeTurnStarted(inTime, 29_999), { delivered: true });
  const late = createRequest({ requestId: 'b', t0: 0 });
  assert.equal(observeTurnStarted(late, 30_000).reason, 'attention_delivery_timeout');
  assert.equal(late.history.at(-1).event, 'late_turn_started_refused');
});

test('T01 timing: a request queued behind an active turn is not expired by the 30 s rule, but by the captured queue bound', () => {
  const queued = createRequest({ requestId: 'q', t0: 0, sessionBusy: true });
  assert.equal(queued.state, 'queued_behind_active_turn');
  assert.equal(queued.deliveryDeadlineMs, 600_000, 'Queue wait is the captured bound from the queue entry, not 30 s.');
  assert.equal(expiryAt(queued, 30_000), null, 'The 30 s point of a queued request is not an expiry.');
  assert.equal(expiryAt(queued, 599_999), null);
  assert.deepEqual(expiryAt(queued, 600_000), { outcome: 'attention_delivery_timeout', cause: 'queue_wait_expired', atMs: 600_000 });
});

test('T01 timing: queue entry at a later milestone captures its bound once and never resets it', () => {
  const r = createRequest({ requestId: 'late-entry', t0: 0 });
  enterQueue(r, 10_000);
  assert.equal(r.deliveryDeadlineMs, 610_000);
  enterQueue(r, 400_000); // a repeat queue record must not move the captured deadline
  assert.equal(r.queuedAt, 10_000);
  assert.equal(r.deliveryDeadlineMs, 610_000);
});

test('T01 timing: the absolute 900 000 ms response deadline is never extended by queueing or by a later start', () => {
  const r = createRequest({ requestId: 'capped', t0: 0 });
  enterQueue(r, 400_000);
  assert.equal(r.deliveryDeadlineMs, 900_000, 'The queue bound is clamped to the response deadline.');
  assert.equal(r.responseDeadlineMs, 900_000);
  assert.deepEqual(observeTurnStarted(r, 500_000), { delivered: true });
  assert.equal(r.responseDeadlineMs, 900_000, 'Starting the turn does not move the response deadline.');
  assert.equal(expiryAt(r, 899_999), null);
  assert.equal(expiryAt(r, 900_000).outcome, 'attention_response_timeout');
});

test('T01 timing: a queued request is admitted only after every check passes at admission time, and failures are named', () => {
  const r = createRequest({ requestId: 'checked', t0: 0, sessionBusy: true });
  assert.deepEqual(admitQueued(r, 100_000, { authorityValid: true, ownerGenerationCurrent: false, budgetAvailable: true }), { admitted: false, reason: 'ownerGenerationCurrent' });
  assert.equal(r.state, 'refused_at_admission', 'A stale owner generation is refused, not silently dropped.');
  const ok = createRequest({ requestId: 'ok', t0: 0, sessionBusy: true });
  assert.deepEqual(admitQueued(ok, 100_000, { authorityValid: true, ownerGenerationCurrent: true, budgetAvailable: true }), { admitted: true });
  assert.equal(ok.state, 'turn_admitted');
});

test('T01 timing: a queued request that expires before capacity frees cannot be admitted later', () => {
  const r = createRequest({ requestId: 'expired-queue', t0: 0, sessionBusy: true });
  const result = admitQueued(r, 600_000, { authorityValid: true, ownerGenerationCurrent: true, budgetAvailable: true });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'attention_delivery_timeout');
  assert.equal(r.history.at(-1).cause, 'queue_wait_expired');
  assert.equal(observeTurnStarted(r, 600_001).delivered, false, 'A late start is never a successful delivery.');
});

test('T01 timing: no state is reachable as delivered without the confirmed turn_started event', () => {
  const r = createRequest({ requestId: 'no-ack', t0: 0 });
  assert.notEqual(r.state, 'turn_started');
  assert.notEqual(r.state, 'delivered');
  for (const event of r.history) assert.notEqual(event.event, 'adapter_received');
});
