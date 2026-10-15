// Deterministic policy/cutover checks. Fixture/utility execution only; no provider inference.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startTestRunner } from '../runtime/tests/helpers.mjs';

const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const expectedConfirmation = option('--confirmation') === 'on';
const retired = option('--v2') === 'retired';
const reportPath = option('--report') && resolve(option('--report'));
const results = [];
const api = await startTestRunner();
const workflow = { schemaVersion: 1, workflowId: 'release-utility', capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [{ id: 'input', type: 'text', config: { value: 'Release acceptance utility' } }, { id: 'result', type: 'result-viewer', config: {} }],
  edges: [{ id: 'input-result', source: { nodeId: 'input', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
const counts = () => ({ workflows: api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflows').n,
  revisions: api.runner.engine.store.get('SELECT SUM(revision) AS n FROM workflows').n,
  changes: api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_changes').n,
  receipts: api.runner.engine.store.get('SELECT COUNT(*) AS n FROM command_receipts').n });
try {
  assert.equal(api.runner.engine.currentSettings().settings.externalRunConfirmation, expectedConfirmation);
  results.push({ name: 'fresh-store-default', passed: true, confirmation: expectedConfirmation });
  const saved = await api.save(workflow);
  const before = counts();
  const legacy = await api.callExternal('PUT', '/api/v2/workflows/release-legacy', { ...workflow, workflowId: 'release-legacy' });
  assert.equal(legacy.status, retired ? 410 : 428);
  if (retired) assert.equal(legacy.body.code, 'api_upgrade_required');
  assert.deepEqual(counts(), before);
  const guarded = await api.callExternal('PUT', '/api/v2/workflows/release-legacy', { ...workflow, workflowId: 'release-legacy' }, {
    headers: { 'If-None-Match': '*', 'Idempotency-Key': randomUUID() },
  });
  assert.equal(guarded.status, retired ? 410 : 200);
  if (retired) assert.deepEqual(counts(), before);
  results.push({ name: 'legacy-save-phase-and-no-bypass', passed: true, phase: retired ? 'retired' : 'guarded' });
  assert.equal((await api.callExternal('GET', `/api/v2/workflows/${workflow.workflowId}`)).status, 200);
  assert.equal((await api.callExternal('POST', '/api/v2/workflows/validate', workflow)).body.valid, true);
  assert.equal((await api.call('GET', `/api/v2/workflows/${workflow.workflowId}/cache-pins`)).status, 200);
  await api.workspace();
  const body = { workflowId: workflow.workflowId, workspaceId: 'main', workflowSnapshotSha256: saved.snapshotSha256, requestId: randomUUID() };
  const accepted = await api.callExternal('POST', '/api/v2/runs', body);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.outcome, expectedConfirmation ? 'confirmation_pending' : 'created');
  let runId;
  if (expectedConfirmation) {
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
    const deniedExternal = await api.callExternal('POST', `/api/v2/run-requests/${body.requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(deniedExternal.status, 403);
    const approved = await api.call('POST', `/api/v2/run-requests/${body.requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(approved.status, 202); runId = approved.body.run.runId;
    assert.deepEqual((await api.callExternal('POST', '/api/v2/runs', body)).body, accepted.body);
  } else runId = accepted.body.run.runId;
  assert.equal((await api.waitFor(runId)).run.state, 'succeeded');
  assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 1);
  results.push({ name: 'run-outcomes-approval-and-idempotency', passed: true });
  // A legacy missing field gets the new fallback; explicit saved preferences remain intact.
  const settings = api.runner.engine.currentSettings();
  const legacySettings = { ...settings.settings }; delete legacySettings.externalRunConfirmation;
  const old = api.runner.engine.store.putJson(legacySettings);
  api.runner.engine.store.run('UPDATE application_settings SET settings_artifact_id = ? WHERE singleton = 1', old.artifactId);
  assert.equal(api.runner.engine.currentSettings().settings.externalRunConfirmation, expectedConfirmation);
  const changed = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision,
    settings: { ...settings.settings, externalRunConfirmation: false } });
  assert.equal(changed.status, 200);
  const testRoot = api.root; await api.close();
  const restarted = await startTestRunner({ root: testRoot });
  try { assert.equal(restarted.runner.engine.currentSettings().settings.externalRunConfirmation, false); }
  finally { await restarted.close(); }
  results.push({ name: 'missing-field-fallback-and-explicit-opt-out-persistence', passed: true });
  const report = { at: new Date().toISOString(), root: api.root, confirmation: expectedConfirmation, v2: retired ? 'retired' : 'guarded', results, passed: true };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ results, passed: false, error: error.message }, null, 2));
  throw error;
} finally { await api.close(); }
