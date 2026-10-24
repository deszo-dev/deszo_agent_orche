// Bridge-local observation receipts. Only an explicit acknowledgement renews supervision.
// Runtime journals remain authoritative; bridge loss never restores a credential from disk.
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from './runtime-client.mjs';

export const OBSERVATION_BYTES = 16 * 1024;
const DETAIL_BYTES = 2048;
const MAX_RUNS = 32;
const size = value => Buffer.byteLength(JSON.stringify(value));
const fail = (code, message) => { throw new BridgeError(409, code, message); };
async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError(504, 'observation_timeout', 'The bounded observation timed out. No ACK was sent. Reconcile get_controller_state before retrying.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const health = controller => {
  if (!controller) return null;
  const active = controller.state === 'active';
  return { ...controller,
    observationRemainingMs: active ? Math.max(0, controller.observationDeadlineMs - controller.millisecondsSinceAcknowledgement) : null,
    escalationRemainingMs: active ? Math.max(0, controller.escalationDeadlineMs - controller.millisecondsSinceAcknowledgement) : null };
};

export class RunObserver {
  constructor({ api, headersFor, prepareEmergency, now = () => new Date().toISOString(), observationTimeoutMs = 30_000, approvalTimeoutMs = 40_000 }) {
    Object.assign(this, { api, headersFor, prepareEmergency, now });
    Object.assign(this, { observationTimeoutMs, approvalTimeoutMs });
    this.runs = new Map();
    this.receipts = new Map();
    this.requests = new Map();
    this.busy = new Set();
  }

  rememberRequest(input, result) {
    const previous = this.requests.get(input.requestId);
    if (!previous && this.requests.size >= MAX_RUNS) fail('observer_capacity', 'Start-request tracking is full; use a fresh bridge after active runs end.');
    for (const key of ['workflowId', 'workflowSnapshotSha256', 'workspaceId', 'controlGrantId', 'controllerSessionId']) {
      if (previous?.[key] !== undefined && previous[key] !== input[key]) fail('request_binding_changed', `The requestId is already bound to another ${key}.`);
    }
    this.requests.set(input.requestId, { ...previous, ...input, state: result.state ?? result.outcome,
      runId: result.runId ?? result.run?.runId ?? previous?.runId ?? null });
  }

  async requestStatus(requestId) {
    const result = await this.api('GET', `/api/v2/run-requests/${requestId}`);
    const tracked = this.requests.get(requestId);
    if (tracked) {
      for (const key of ['workflowId', 'workflowSnapshotSha256', 'workspaceId', 'controlGrantId']) {
        if (tracked[key] && tracked[key] !== result[key]) fail('request_binding_changed', `The run request changed its ${key} binding.`);
      }
      this.rememberRequest(tracked, result);
    }
    return result;
  }

  async awaitStart({ requestId, waitMs = 0 }) {
    return bounded(this.waitForRequest(requestId, waitMs), this.approvalTimeoutMs);
  }

  async waitForRequest(requestId, waitMs) {
    if (!this.requests.has(requestId)) fail('request_not_tracked', 'This bridge did not submit that request. Reconcile its state before creating any new request.');
    const end = Date.now() + Math.min(waitMs, 20_000);
    let request;
    do {
      request = await this.requestStatus(requestId);
      if (request.runId || request.state !== 'pending' || Date.now() >= end) break;
      await new Promise(done => setTimeout(done, Math.min(250, end - Date.now())));
    } while (true);
    if (!request.runId) return { request, nextAction: request.state === 'pending' ? 'await_run_start' : 'inspect_request' };
    const tracked = this.requests.get(requestId);
    const [observation, emergencyPrepared] = await Promise.all([
      this.observe({ runId: request.runId, controllerSessionId: tracked.controllerSessionId }),
      tracked.controllerSessionId ? this.prepareEmergency(request.runId, tracked.controllerSessionId) : false,
    ]);
    return { request, emergencyPrepared, observation, nextAction: 'process_observation_then_explicitly_acknowledge' };
  }

  async observe({ runId, controllerSessionId, waitMs = 0, maxBytes = OBSERVATION_BYTES }) {
    return bounded(this.exclusive(runId, () => this.observeBatch({ runId, controllerSessionId, waitMs, maxBytes })), this.observationTimeoutMs);
  }

  async exclusive(runId, operation) {
    if (this.busy.has(runId)) fail('observer_busy', 'An observation or ACK for this run is still in flight. Reconcile its result before another operation.');
    this.busy.add(runId);
    try { return await operation(); } finally { this.busy.delete(runId); }
  }

  async observeBatch({ runId, controllerSessionId, waitMs, maxBytes }) {
    const control = await this.api('GET', `/api/v2/runs/${runId}/control`);
    let run = this.runs.get(runId);
    const associated = [...this.requests.values()].find(x => x.runId === runId)?.controllerSessionId;
    const sessionId = controllerSessionId ?? run?.controllerSessionId ?? associated;
    if (control.controlMode === 'supervised' && control.controller?.state === 'active') {
      if (!sessionId) fail('controller_session_required', 'Supply the controllerSessionId whose credential this bridge holds.');
      this.headersFor(sessionId);
      if (control.controller.controllerSessionId && control.controller.controllerSessionId !== sessionId)
        fail('controller_session_mismatch', 'This session does not own the run grant.');
    }
    if (!run) {
      if (this.runs.size >= MAX_RUNS) fail('observer_capacity', 'Observation tracking is full; active observations are never silently evicted.');
      run = { runId, controllerSessionId: sessionId, acknowledgedCursor: control.controller?.ackCursor ?? 0, pending: null };
      this.runs.set(runId, run);
    }
    if (run.controllerSessionId && sessionId !== run.controllerSessionId) fail('controller_session_mismatch', 'The observation belongs to another controller session.');
    run.controllerSessionId ??= sessionId;
    run.health = health(control.controller);
    run.healthObservedAt = this.now();
    if (run.pending) {
      const pending = this.presentation(this.receipts.get(run.pending), run);
      if (size(pending) > maxBytes) fail('pending_observation_bound', 'The pending observation exceeds this smaller bound. Read it with the original maxBytes before acknowledging.');
      return pending;
    }
    const page = await this.api('GET', `/api/v2/runs/${runId}/watch?${new URLSearchParams({ cursor: String(run.acknowledgedCursor), waitMs: String(Math.min(waitMs, 20_000)) })}`, undefined, { timeoutMs: 30_000 });
    if (page.skippedRanges?.length) fail('observation_gap', 'The runtime reports skipped journal ranges; acknowledgement is blocked.');
    if (page.lastSequence < run.acknowledgedCursor || (!page.events.length && page.lastSequence > run.acknowledgedCursor))
      fail('observation_gap', 'The journal boundary does not match the returned events. Acknowledgement is blocked.');
    if (page.nextCursor !== (page.events.at(-1)?.sequence ?? run.acknowledgedCursor))
      fail('observation_gap', 'The returned cursor does not match the returned event boundary.');
    const receipt = { observationId: randomUUID(), runId, controllerSessionId: sessionId,
      observedAt: this.now(), fromCursor: run.acknowledgedCursor, cursor: run.acknowledgedCursor,
      state: page.state, controlMode: page.controlMode, terminal: page.terminal, lastSequence: page.lastSequence,
      events: [], details: new Map(), ackRequestId: null, acknowledged: null };
    run.health = health(page.controller);
    run.healthObservedAt = this.now();
    for (const event of page.events) {
      if (event.sequence !== receipt.cursor + 1) fail('observation_gap', `Expected sequence ${receipt.cursor + 1}, received ${event.sequence}.`);
      receipt.events.push(event);
      if (size(this.presentation(receipt, run)) > maxBytes - 512) {
        receipt.events.pop();
        if (receipt.events.length) break;
        const bytes = Buffer.from(JSON.stringify(event.payload), 'utf8'), detailId = randomUUID();
        receipt.details.set(detailId, { bytes, readThrough: 0 });
        receipt.events.push({ ...event, payload: { detailId, byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), omitted: true,
          nextAction: 'read_observation_detail_before_acknowledging' } });
      }
      receipt.cursor = event.sequence;
      if (receipt.details.size) break;
    }
    if (page.nextCursor > receipt.cursor && !page.events.length) fail('observation_gap', 'The runtime advanced a cursor without returning its events.');
    if (size(this.presentation(receipt, run)) > maxBytes) fail('observation_too_large', 'Even this event metadata exceeds the bound; inspect the durable journal and Stop if necessary.');
    this.receipts.set(receipt.observationId, receipt);
    run.pending = receipt.observationId;
    return this.presentation(receipt, run);
  }

  presentation(receipt, run) {
    return { observationId: receipt.observationId, runId: receipt.runId, controllerSessionId: receipt.controllerSessionId ?? null,
      observedAt: receipt.observedAt, fromCursor: receipt.fromCursor, cursor: receipt.cursor,
      stateAtObservation: receipt.state, lastSequenceAtObservation: receipt.lastSequence,
      terminalAtObservation: receipt.terminal, controlMode: receipt.controlMode,
      backlogAtObservation: Math.max(0, receipt.lastSequence - receipt.cursor),
      currentControllerHealth: run.health, healthObservedAt: run.healthObservedAt, events: receipt.events,
      unreadDetails: [...receipt.details].filter(([, x]) => x.readThrough < x.bytes.length).map(([detailId, x]) => ({ detailId, readThrough: x.readThrough, byteSize: x.bytes.length })),
      nextAction: receipt.details.size && [...receipt.details.values()].some(x => x.readThrough < x.bytes.length)
        ? 'read_observation_detail' : 'process_observation_then_explicitly_acknowledge' };
  }

  readDetail({ observationId, detailId, offset, length = DETAIL_BYTES }) {
    const receipt = this.receipts.get(observationId), detail = receipt?.details.get(detailId);
    if (!detail) fail('observation_detail_missing', 'That observation detail is not held by this bridge.');
    const start = offset ?? detail.readThrough;
    if (start < 0 || start > detail.readThrough || start > detail.bytes.length) fail('observation_detail_gap', 'Read detail ranges in order; unread bytes cannot be skipped.');
    if (start < detail.bytes.length && (detail.bytes[start] & 0xc0) === 0x80) fail('invalid_detail_offset', 'Use a returned UTF-8 byte offset.');
    let end = Math.min(start + Math.min(Math.max(length, 4), DETAIL_BYTES), detail.bytes.length);
    while (end < detail.bytes.length && (detail.bytes[end] & 0xc0) === 0x80) end -= 1;
    detail.readThrough = Math.max(detail.readThrough, end);
    return { observationId, detailId, offset: start, nextOffset: end, byteSize: detail.bytes.length, eof: end === detail.bytes.length,
      untrusted: true, text: detail.bytes.subarray(start, end).toString('utf8') };
  }

  async acknowledge({ observationId, runId, controllerSessionId, cursor, requestId }) {
    return this.exclusive(runId, () => this.acknowledgeReceipt({ observationId, runId, controllerSessionId, cursor, requestId }));
  }

  async acknowledgeReceipt({ observationId, runId, controllerSessionId, cursor, requestId }) {
    const receipt = this.receipts.get(observationId);
    if (!receipt) fail('observation_required', 'Call observe_run through this bridge and acknowledge its observationId.');
    if (receipt.runId !== runId || (controllerSessionId && receipt.controllerSessionId !== controllerSessionId) || (cursor !== undefined && cursor !== receipt.cursor))
      fail('observation_mismatch', 'The acknowledgement must match this observation run, session and cursor.');
    if ([...receipt.details.values()].some(x => x.readThrough < x.bytes.length)) fail('observation_incomplete', 'Read all omitted event payload bytes before acknowledging this observation.');
    if (receipt.ackRequestId && receipt.ackRequestId !== requestId) fail('ack_request_conflict', 'Retry this observation with its original acknowledgement requestId.');
    if (receipt.acknowledged) return receipt.acknowledged;
    const run = this.runs.get(runId);
    if (run.pending !== observationId || run.acknowledgedCursor !== receipt.fromCursor) fail('observation_conflict', 'This observation no longer follows the acknowledged cursor.');
    receipt.ackRequestId = requestId;
    const result = await this.api('POST', `/api/v2/runs/${runId}/observation-acks`, { requestId, cursor: receipt.cursor },
      receipt.controllerSessionId ? { headers: this.headersFor(receipt.controllerSessionId) } : undefined);
    receipt.acknowledged = result;
    run.acknowledgedCursor = receipt.cursor;
    run.pending = null;
    // Keep recent receipts for idempotent lost-response recovery; never remove an unacknowledged one.
    const completed = [...this.receipts.values()].filter(x => x.acknowledged);
    for (const old of completed.slice(0, Math.max(0, completed.length - 64))) this.receipts.delete(old.observationId);
    return result;
  }

  state() {
    return { automaticAcknowledgement: false, credentialsOnDisk: false, inFlightRunIds: [...this.busy],
      pendingRequests: [...this.requests.values()].filter(x => !x.runId),
      runs: [...this.runs.values()].map(run => { const pending = this.receipts.get(run.pending); return {
        runId: run.runId, controllerSessionId: run.controllerSessionId ?? null, acknowledgedCursor: run.acknowledgedCursor,
        pendingObservationId: run.pending, pendingCursor: pending?.cursor ?? null, ackRequestId: pending?.ackRequestId ?? null,
        unreadDetails: pending ? this.presentation(pending, run).unreadDetails : [],
        operationInFlight: this.busy.has(run.runId), nextAction: pending ? 'process_pending_observation' : this.busy.has(run.runId) ? 'reconcile_inflight_observation' : 'observe_run' }; }) };
  }
}
