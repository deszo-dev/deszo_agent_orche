import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { startTestRunner, singleAgent } from './helpers.mjs';
import { openBridge } from '../../scripts/authoring-test-support.mjs';

const script = resolve(import.meta.dirname, '../../mcp/bridge.mjs');
const bridgeFor = (api, options = {}) => openBridge({ script,
  args: ['--connection-file', api.runner.connection.connectionFile, '--client-provider', 'other', ...(options.execution ? ['--allow-execution'] : [])],
  env: { ...process.env, DESZO_MANAGED_INVOCATION: options.marker || '' } });
const data = result => { assert.equal(result.isError, undefined); assert.equal(result.structuredContent.status, 'ok'); return result.structuredContent.data; };

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
        for (const name of ['get_authoring_contract', 'list_workspaces']) {
          const result = await bridge.call(name);
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
