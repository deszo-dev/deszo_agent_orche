import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { startTestRunner, singleAgent } from './helpers.mjs';
import { openBridge } from '../../scripts/authoring-test-support.mjs';
import clientTimeouts from '../../docs/authoring/client-timeouts.json' with { type: 'json' };

const script = resolve(import.meta.dirname, '../../mcp/bridge.mjs');
const bridgeFor = (api, options = {}) => openBridge({ script,
  args: ['--connection-file', api.runner.connection.connectionFile, '--client-provider', 'other', ...(options.execution ? ['--allow-execution'] : [])],
  env: { ...process.env, DESZO_MANAGED_INVOCATION: options.marker || '' } });
const data = result => { assert.equal(result.isError, undefined); assert.equal(result.structuredContent.status, 'ok'); return result.structuredContent.data; };

test('stdio incident reads and updates accept the stable hash identity returned by Stop-and-report', async () => {
  const api = await startTestRunner(); let bridge;
  const observation = { schemaVersion: 1, kind: 'IncidentObservation', title: 'Fixture incident identity', component: 'bridge', category: 'capture',
    severity: 'medium', confidence: 'high', causeStatus: 'suspected', expected: 'A returned incident stays readable and appendable.', actual: 'Exercise the Stop-and-report identity.',
    reproduction: ['Stop the fixture and read its incident.'], versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId: null,
    nodeInstanceId: null, attemptId: null, eventRange: null, artifacts: [], captureGaps: [], controllerCommandId: null, reporter: { authority: 'external', sessionId: null } };
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' })), runId = created.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running');
    bridge = await bridgeFor(api, { execution: true });
    const stopped = data(await bridge.call('stop_and_report', { runId, requestId: '20a90f84-fcc7-4c9f-99c6-d38b4d17af8a', reason: 'Fixture stop.', observation }));
    const incidentId = stopped.incident.incidentId;
    assert.equal(incidentId, '80762e2f-2e1e-968e-a3dc-22b85f13d849');
    assert.equal(data(await bridge.call('get_incident', { incidentId })).incidentId, incidentId);
    const input = { incidentId, requestId: randomUUID(), observation };
    assert.equal(data(await bridge.call('append_incident_observation', input)).seq, 1);
    assert.equal(data(await bridge.call('append_incident_observation', input)).seq, 1);
    const detail = data(await bridge.call('get_incident', { incidentId }));
    assert.equal(detail.updates.length, 1); assert.equal(detail.updates[0].authority, 'external');
    const denied = await bridge.call('get_incident', { incidentId: '../incidents' });
    assert.equal(denied.isError, true);
    await api.waitFor(runId, run => run.state === 'canceled');
  } finally { await bridge?.close(); await api.close(); }
});

test('real stdio bridge discovers its runtime, hides execution tools, and conditionally saves with durable retry identity', async () => {
  const api = await startTestRunner(); let bridge;
  try {
    bridge = await bridgeFor(api);
    const tools = await bridge.request('tools/list');
    assert.ok(tools.tools.some(tool => tool.name === 'put_workflow'));
    assert.ok(!tools.tools.some(tool => ['start_run', 'stop_run'].includes(tool.name)));
    const contract = data(await bridge.call('get_authoring_contract'));
    assert.equal(contract.storeId, api.runner.connection.storeId);
    const workflow = singleAgent({ id: 'bridge-conditional-save', context: null });
    const body = { workflowId: workflow.workflowId, requestId: randomUUID(), expectedEtag: null, workflow };
    const first = data(await bridge.call('put_workflow', body));
    assert.equal(first.revision, 1);
    assert.deepEqual(data(await bridge.call('put_workflow', body)), first);
    const conflict = await bridge.call('put_workflow', { ...body, requestId: randomUUID() });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.error.status, 412);
    assert.equal(api.runner.engine.getWorkflowV3(workflow.workflowId).revision, 1);
    const results = JSON.stringify({ tools, contract, first, conflict });
    for (const token of [api.runner.connection.token, api.runner.connection.firstPartyToken]) assert.ok(!results.includes(token));
  } finally { await bridge?.close(); await api.close(); }
});

test('real stdio bridge refuses every management call with a same-runtime or foreign managed marker', async () => {
  const api = await startTestRunner();
  try {
    for (const marker of [api.runner.connection.runtimeInstanceId, randomUUID()]) {
      const bridge = await bridgeFor(api, { marker, execution: true });
      try {
        for (const [name, input] of [['get_authoring_contract', {}], ['list_workspaces', {}],
          ['get_controller_state', {}], ['read_observation_detail', { observationId: randomUUID(), detailId: randomUUID(), offset: 0 }]]) {
          const result = await bridge.call(name, input);
          assert.equal(result.isError, true);
          assert.equal(result.structuredContent.error.code, 'managed_invocation_denied');
        }
      } finally { await bridge.close(); }
    }
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM bridge_registrations').n, 0);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  } finally { await api.close(); }
});

test('execution-enabled stdio bridge submits a pending request and cannot dispatch before a first-party decision', async () => {
  const api = await startTestRunner(); let bridge;
  try {
    await api.workspace();
    const settings = api.runner.engine.currentSettings();
    await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision,
      settings: { ...settings.settings, externalRunConfirmation: true } });
    const workflow = singleAgent({ id: 'bridge-approved-run', context: null });
    const saved = await api.save(workflow);
    bridge = await bridgeFor(api, { execution: true });
    const tools = (await bridge.request('tools/list')).tools;
    assert.ok(tools.find(tool => tool.name === 'stop_run').annotations.destructiveHint);
    const requestId = randomUUID();
    const input = { requestId, workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main' };
    const pending = data(await bridge.call('start_run', input));
    assert.equal(pending.outcome, 'confirmation_pending');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
    const approved = await api.call('POST', `/api/v2/run-requests/${requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(approved.status, 202);
    assert.equal((await api.waitFor(approved.body.run.runId)).run.state, 'succeeded');
    assert.deepEqual(data(await bridge.call('start_run', input)), pending);
    assert.equal(data(await bridge.call('get_run_request', { requestId })).state, 'approved');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 1);
  } finally { await bridge?.close(); await api.close(); }
});

test('an open stdio bridge reconnects to the same store after restart and preserves save receipts', async () => {
  let api = await startTestRunner(); let bridge;
  const root = api.root;
  try {
    bridge = await bridgeFor(api);
    const workflow = singleAgent({ id: 'bridge-restart', context: null });
    const body = { workflowId: workflow.workflowId, requestId: randomUUID(), expectedEtag: null, workflow };
    const saved = data(await bridge.call('put_workflow', body));
    const oldRuntime = data(await bridge.call('get_authoring_contract')).runtimeInstanceId;
    await api.close();
    const unavailable = await bridge.call('get_authoring_contract');
    assert.equal(unavailable.structuredContent.error.code, 'runtime_unavailable');
    api = await startTestRunner({ root });
    const contract = data(await bridge.call('get_authoring_contract'));
    assert.notEqual(contract.runtimeInstanceId, oldRuntime);
    assert.equal(contract.storeId, api.runner.connection.storeId);
    assert.deepEqual(data(await bridge.call('put_workflow', body)), saved);
    assert.equal(api.runner.engine.getWorkflowV3(workflow.workflowId).revision, 1);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM bridge_registrations').n, 1);
  } finally { await bridge?.close(); await api.close(); }
});

test('an existing bridge refuses a replaced descriptor for a different store', async () => {
  const api = await startTestRunner(); const other = await startTestRunner(); let bridge;
  const connectionFile = api.runner.connection.connectionFile;
  const original = await readFile(connectionFile);
  try {
    bridge = await bridgeFor(api);
    await api.close();
    const replacement = JSON.parse(await readFile(other.runner.connection.connectionFile));
    replacement.connectionFile = connectionFile;
    await writeFile(connectionFile, JSON.stringify(replacement));
    const denied = await bridge.call('get_authoring_contract');
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.code, 'store_identity_mismatch');
    assert.equal(other.runner.engine.store.get('SELECT COUNT(*) AS n FROM bridge_registrations').n, 0);
  } finally { await writeFile(connectionFile, original); await bridge?.close(); await other.close(); }
});

test('supervised stdio observations recover after context loss, drain bounded pages and require explicit matching ACKs', async () => {
  const api = await startTestRunner(); let bridge, replacement, runId;
  const heartbeats = [];
  api.runner.engine.supervisor = {
    shimPath: null, pipeName: 'fixture-supervisor',
    armRun: async () => ({ armed: true, emergencyToken: 'fixture-emergency-secret' }),
    heartbeat: async id => { heartbeats.push(id); return { heartbeat: true }; },
    status: async () => ({ escalated: false }), disarmRun: async () => ({}), releaseRun: async () => ({}),
    proveStopped: async () => ({ containment: 'windows-job', confirmed: true, remainingMembers: 0, reason: 'Fixture supervisor proof.' }),
  };
  try {
    await api.workspace();
    const settings = api.runner.engine.currentSettings();
    await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision,
      settings: { ...settings.settings, externalRunConfirmation: true } });
    const workflow = singleAgent({ id: 'bounded-supervised-observer', context: null, model: 'fixture-slow-30' });
    const saved = await api.save(workflow);
    bridge = await bridgeFor(api, { execution: true });
    const tools = (await bridge.request('tools/list')).tools.map(tool => tool.name);
    for (const tool of ['observe_run', 'read_observation_detail', 'get_controller_state', 'await_run_start']) assert.ok(tools.includes(tool));
    const session = data(await bridge.call('create_controller_session', { requestId: randomUUID(), clientLabel: 'Observer integration', clientProvider: 'codex' }));
    assert.equal(session.credentialHeldByBridge, true);
    assert.ok(!JSON.stringify(session).includes('controllerToken'));
    const grant = data(await bridge.call('request_control_grant', { requestId: randomUUID(), controllerSessionId: session.controllerSessionId,
      workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', clientProvider: 'codex',
      clientVersion: clientTimeouts.entries.find(x => x.provider === 'codex').testedVersion,
      requestedActions: ['observe', 'acknowledge', 'stop'], observationDeadlineMs: 5000, escalationDeadlineMs: 20000 }));
    assert.equal((await api.call('POST', `/api/v2/control-grants/${grant.grantId}/decision`, { requestId: randomUUID(), decision: 'approve' })).status, 200);
    const requestId = randomUUID();
    const input = { requestId, workflowId: workflow.workflowId, workspaceId: 'main', workflowSnapshotSha256: saved.snapshotSha256,
      controlGrantId: grant.grantId, controllerSessionId: session.controllerSessionId };
    assert.equal(data(await bridge.call('start_run', input)).outcome, 'confirmation_pending');
    const before = data(await bridge.call('get_controller_state'));
    assert.equal(before.pendingRequests[0].requestId, requestId);
    assert.equal(data(await bridge.call('await_run_start', { requestId, waitMs: 0 })).request.state, 'pending');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
    const approved = await api.call('POST', `/api/v2/run-requests/${requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(approved.status, 202, JSON.stringify(approved.body));
    runId = approved.body.run.runId;
    const started = data(await bridge.call('await_run_start', { requestId, waitMs: 0 }));
    assert.equal(started.request.runId, runId);
    assert.equal(started.emergencyPrepared, true);
    let observation = started.observation;
    const state = data(await bridge.call('get_controller_state'));
    assert.equal(state.runs[0].pendingObservationId, observation.observationId);
    assert.equal(state.sessions[0].controllerSessionId, session.controllerSessionId);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM observation_acks').n, 0);
    assert.equal(heartbeats.length, 0, 'approval polling and reading state do not heartbeat');
    const bareAck = await bridge.call('acknowledge_run_observation', { runId, requestId: randomUUID(), cursor: observation.cursor, controllerSessionId: session.controllerSessionId });
    assert.equal(bareAck.structuredContent.error.code, 'observation_required');
    // A new event after the observation must not get implicitly acknowledged with a live snapshot cursor.
    api.runner.engine.store.appendEvents(runId, [{ type: 'node.planned', nodeInstanceId: 'request', payload: { nodeId: 'request', nodeType: 'text', scope: null } }]);
    const latest = api.runner.engine.requireRun(runId).last_sequence;
    assert.ok(latest > observation.cursor);
    const jumped = await bridge.call('acknowledge_run_observation', { runId, requestId: randomUUID(), cursor: latest, observationId: observation.observationId, controllerSessionId: session.controllerSessionId });
    assert.equal(jumped.structuredContent.error.code, 'observation_mismatch');
    const engine = api.runner.engine;
    engine.store.run('UPDATE control_grants SET last_ack_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), grant.grantId);
    engine.watchdogTick(grant.grantId, runId);
    assert.equal(engine.dispatchPaused.has(runId), true);
    const firstRequest = randomUUID();
    const acknowledged = data(await bridge.call('acknowledge_run_observation', { runId, requestId: firstRequest, observationId: observation.observationId }));
    assert.equal(acknowledged.resumedDispatch, true);
    assert.equal(engine.dispatchPaused.has(runId), false);
    const heartbeatCount = heartbeats.length;
    assert.deepEqual(data(await bridge.call('acknowledge_run_observation', { runId, requestId: firstRequest, observationId: observation.observationId })), acknowledged);
    assert.equal(heartbeats.length, heartbeatCount);
    let pages = 0;
    do {
      observation = data(await bridge.call('observe_run', { runId, maxBytes: 4096 }));
      assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 4096);
      assert.equal(observation.unreadDetails.length, 0);
      assert.equal(observation.currentControllerHealth.controllerSessionId, session.controllerSessionId);
      assert.ok(observation.currentControllerHealth.observationRemainingMs > 0);
      data(await bridge.call('acknowledge_run_observation', { runId, requestId: randomUUID(), observationId: observation.observationId }));
      assert.ok(++pages < 40);
    } while (observation.backlogAtObservation);
    replacement = await bridgeFor(api, { execution: true });
    assert.deepEqual(data(await replacement.call('get_controller_state')).sessions, []);
    const lostCredential = await replacement.call('observe_run', { runId, controllerSessionId: session.controllerSessionId });
    assert.equal(lostCredential.structuredContent.error.code, 'controller_credential_required');
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 1, 'recovery never starts a replacement run');
    data(await bridge.call('stop_run', { runId, requestId: randomUUID() }));
    await api.waitFor(runId, run => run.state === 'canceled');
    assert.deepEqual(data(await bridge.call('get_run_processes', { runId })).items, []);
    const terminalControl = data(await bridge.call('get_run_control', { runId }));
    assert.equal(terminalControl.controlMode, 'supervised');
    assert.equal(terminalControl.controller.state, 'ended');
    assert.equal(terminalControl.controller.controllerSessionId, session.controllerSessionId);
    assert.ok(terminalControl.controller.ackCursor > 0, 'terminal runs retain the durable checkpoint');
    const beforeTerminalAck = heartbeats.length;
    do {
      observation = data(await bridge.call('observe_run', { runId, maxBytes: 4096 }));
      const terminalAck = data(await bridge.call('acknowledge_run_observation', { runId, requestId: randomUUID(), observationId: observation.observationId }));
      assert.equal(terminalAck.controlMode, 'supervised');
      assert.equal(terminalAck.resumedDispatch, false);
    } while (observation.backlogAtObservation);
    assert.equal(heartbeats.length, beforeTerminalAck, 'terminal audit ACKs never renew a native lease');
    assert.equal(data(await bridge.call('get_run_control', { runId })).controller.ackCursor, observation.cursor);
  } finally {
    if (runId) await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    await replacement?.close(); await bridge?.close(); await api.close();
  }
});
