// ADR-0006 route coverage for the MCP bridge: a controller session's credential stays in the bridge that created it. A second
// bridge process, even on the same store and with execution enabled, cannot start a run under that session, and the refusal
// happens before any request reaches the runtime. Real stdio bridges over a real runtime; no fixture substitutes for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { startTestRunner, singleAgent } from './helpers.mjs';
import { openBridge } from '../../scripts/authoring-test-support.mjs';

const script = resolve(import.meta.dirname, '../../mcp/bridge.mjs');
const bridgeFor = api => openBridge({ script,
  args: ['--connection-file', api.runner.connection.connectionFile, '--client-provider', 'other', '--allow-execution'],
  env: { ...process.env, DESZO_MANAGED_INVOCATION: '' } });
const data = result => { assert.equal(result.isError, undefined); assert.equal(result.structuredContent.status, 'ok'); return result.structuredContent.data; };

test('ADR6 bridge credentials: a bridge that did not create a controller session cannot start a run under it, and nothing is created', async () => {
  const api = await startTestRunner(); let creator, stranger;
  try {
    await api.workspace();
    const workflow = singleAgent({ id: 'bridge-foreign-controller', context: null });
    const saved = await api.save(workflow);
    creator = await bridgeFor(api);
    const session = data(await creator.call('create_controller_session', { requestId: randomUUID(), clientLabel: 'fixture-controller', clientProvider: 'other' }));
    assert.equal(session.credentialHeldByBridge, true, 'The creating bridge holds the credential.');
    assert.equal(JSON.stringify(session).includes('controllerToken'), false, 'The credential is never returned to the model.');

    stranger = await bridgeFor(api);
    const refused = await stranger.call('start_run', { requestId: randomUUID(), workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', controllerSessionId: session.controllerSessionId });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.code, 'controller_credential_required');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0, 'No run was created by the bridge that lacks the credential.');
  } finally { await stranger?.close(); await creator?.close(); await api.close(); }
});
