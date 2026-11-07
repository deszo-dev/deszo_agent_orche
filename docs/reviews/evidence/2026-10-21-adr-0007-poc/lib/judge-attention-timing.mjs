// Controlled-clock model of the ADR-0007 amended timing contract (amendment T01). Pure functions: no Codex, no I/O, no
// wall clock. Times are integer milliseconds on one monotonic timeline anchored at request creation (t0 = 0).
// This is a deterministic specification check for the PoC, not the production scheduler.
//
// Constants come from the captured initial profile. Their rationale is recorded in ADR-0007 section 4:
//   deliveryDeadlineMs  30 000  immediately dispatchable request: confirmed turn_started from t0.
//   activeTurnBoundMs  600 000  one autonomous Judge turn may not exceed this; the adapter enforces it by turn interruption.
//   queueWaitBoundMs   600 000  a request blocked behind an active turn must start within this bound from its queue entry.
//                               It equals activeTurnBoundMs because an admitted predecessor cannot outlast that bound, so a
//                               healthy session never expires a queued request. It leaves 300 000 ms of the absolute window.
//   responseDeadlineMs 900 000  absolute from t0. It is never reset by queueing, reconnect, retry or another request's completion.
export const TIMING = Object.freeze({
  deliveryDeadlineMs: 30_000,
  activeTurnBoundMs: 600_000,
  queueWaitBoundMs: 600_000,
  responseDeadlineMs: 900_000,
});

// Creates the immutable deadline record at request creation. A request created while another turn is active on its session is
// durably queued at creation, so its delivery clock is the queue bound from that moment.
export function createRequest({ requestId, t0 = 0, sessionBusy = false }) {
  const request = { requestId, t0, responseDeadlineMs: t0 + TIMING.responseDeadlineMs, queuedAt: null, deliveryDeadlineMs: t0 + TIMING.deliveryDeadlineMs, state: 'created', history: [] };
  if (sessionBusy) enterQueue(request, t0);
  else request.state = 'dispatchable';
  request.history.push({ at: t0, event: 'created', state: request.state });
  return request;
}

// Records the queue milestone. The delivery deadline switches to the queue bound exactly once, captured here, and never
// exceeds the absolute response deadline.
export function enterQueue(request, now) {
  if (request.queuedAt !== null) return request;
  request.queuedAt = now;
  request.deliveryDeadlineMs = Math.min(now + TIMING.queueWaitBoundMs, request.responseDeadlineMs);
  request.state = 'queued_behind_active_turn';
  request.history.push({ at: now, event: 'queued_behind_active_turn', deliveryDeadlineMs: request.deliveryDeadlineMs });
  return request;
}

// Returns the first applicable terminal outcome at `now`, or null while the request is still within its bounds.
// Expiry is recorded as a distinct cause; nothing here assigns successful delivery.
export function expiryAt(request, now) {
  if (request.state === 'decision_applied') return null;
  // The response deadline governs until a decision is applied, including after a confirmed turn_started.
  if (now >= request.responseDeadlineMs) return { outcome: 'attention_response_timeout', atMs: request.responseDeadlineMs };
  // The delivery deadline stops applying once turn_started is confirmed.
  if (request.state !== 'turn_started' && now >= request.deliveryDeadlineMs) {
    const cause = request.queuedAt !== null ? 'queue_wait_expired' : 'delivery_not_started';
    return { outcome: 'attention_delivery_timeout', cause, atMs: request.deliveryDeadlineMs };
  }
  return null;
}

// Admission of a queued request when capacity is free. Every check is evaluated at admission time, never reused from enqueue.
// A failed check is refused with its named reason and recorded; it is never silently dropped.
export function admitQueued(request, now, checks) {
  const expiry = expiryAt(request, now);
  if (expiry) { request.state = expiry.outcome; request.history.push({ at: now, event: expiry.outcome, cause: expiry.cause ?? null }); return { admitted: false, reason: expiry.outcome }; }
  for (const [name, passes] of Object.entries(checks)) {
    if (!passes) { request.state = 'refused_at_admission'; request.history.push({ at: now, event: 'refused_at_admission', reason: name }); return { admitted: false, reason: name }; }
  }
  request.state = 'turn_admitted';
  request.history.push({ at: now, event: 'turn_admitted' });
  return { admitted: true };
}

// Confirmed turn start is the only event that satisfies the delivery deadline.
export function observeTurnStarted(request, now) {
  const expiry = expiryAt(request, now);
  if (expiry) { request.state = expiry.outcome; request.history.push({ at: now, event: 'late_turn_started_refused', cause: expiry.cause ?? null }); return { delivered: false, reason: expiry.outcome }; }
  request.state = 'turn_started';
  request.history.push({ at: now, event: 'turn_started' });
  return { delivered: true };
}
