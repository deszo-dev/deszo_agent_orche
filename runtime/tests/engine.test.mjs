import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../core/schemas.mjs';
import { Engine } from '../core/engine.mjs';
import { killTree } from '../core/processes.mjs';
import { contextChain, fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';

const schemaClean = (definition, body) => assert.deepEqual(check('runtime-api-v2.schema.json', definition, body), [], definition);

test('provider detection forwards and caches Process Custody scope independently', async () => {
  const api = await startTestRunner();
  try {
    const calls = [];
    api.runner.engine.adapters.detect = async (provider, options) => {
      calls.push({ provider, options });
      return { provider, available: true, processCustody: options.processCustody };
    };
    const standard = await api.runner.engine.detect('codex', { fresh: true });
    const custody = await api.runner.engine.detect('codex', { processCustody: true });
    const cached = await api.runner.engine.detect('codex', { processCustody: true });
    assert.equal(standard.processCustody, false);
    assert.equal(custody.processCustody, true);
    assert.equal(cached.processCustody, true);
    assert.deepEqual(calls, [
      { provider: 'codex', options: { processCustody: false } },
      { provider: 'codex', options: { processCustody: true } },
    ]);
  } finally { await api.close(); }
});

test('saved Context chain runs Codex → Claude → Codex, resuming the first Codex conversation', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = await contextChain();
    const created = await api.run(workflow);
    assert.equal(created.status, 202); schemaClean('acceptRun', created.body);
    const snapshot = await api.waitFor(created.body.run.runId);
    schemaClean('runSnapshot', snapshot);
    assert.equal(snapshot.run.state, 'succeeded');
    const events = await api.events(snapshot.run.runId);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1), 'contiguous sequences');
    assert.equal(events[0].type, 'run.created');
    assert.deepEqual(events[1].payload, { from: null, to: 'queued', reason: 'Run captured.' });
    for (const event of events) assert.deepEqual(check('journal-event-v2.schema.json', null, event), []);
    const planned = events.filter(event => event.type === 'node.planned').length;
    assert.equal(planned, 7, 'seven executable nodes; Context declarations have no attempt');
    const firstDispatch = events.findIndex(event => event.type === 'attempt.inputs_committed');
    assert.ok(events.slice(0, firstDispatch).filter(event => event.type === 'attempt.state_changed' && event.payload.from === null).length === 7, 'all attempts scheduled before dispatch');
    // Codex invocations: the revision resumes the proposal's native session.
    const invocations = [];
    for (const event of events.filter(item => item.type === 'attempt.invocation_committed')) invocations.push(await api.artifactJson(event.payload.manifest.artifactId));
    const codex = invocations.filter(item => item.provider === 'codex');
    assert.equal(codex.length, 2);
    assert.equal(codex[0].nativeSessionBefore, null);
    const resumed = await api.artifactJson(codex[1].nativeSessionBefore.artifactId);
    const bound = events.filter(event => event.type === 'context.bound');
    assert.equal(bound.length, 2, 'one native binding per Context');
    const firstSession = await api.artifactJson(bound[0].payload.nativeSessionRef.artifactId);
    assert.equal(resumed.nativeSessionId, firstSession.nativeSessionId);
    const answer = snapshot.instances.find(item => item.nodeId === 'answer');
    const viewerInputs = await api.artifactJson(events.find(event => event.type === 'attempt.inputs_committed' && event.nodeInstanceId === 'answer').payload.manifest.artifactId);
    const final = await api.artifactJson(viewerInputs.values.value.artifact.artifactId);
    assert.match(final.message, /^codex turn 2: The reviewer returned:/);
    assert.equal(answer.state, 'succeeded');
    assert.equal(snapshot.contexts.length, 2);
    const bindings = await api.call('GET', '/api/v2/context-bindings?workspaceId=main');
    schemaClean('contextBindings', bindings.body);
    assert.ok(bindings.body.bindings.every(binding => binding.state === 'ready'));
  } finally { await api.close(); }
});

test('createRun is idempotent per requestId and rejects a reused ID with another payload', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ context: null });
    const saved = await api.save(workflow);
    const publication = api.publication(workflow.workflowId);
    const requestId = randomUUID();
    const body = { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, publishedVersionId: publication.publishedVersionId,
      definitionDigest: publication.definitionDigest, workspaceId: 'main', requestId };
    const first = await api.call('POST', '/api/v2/runs', body);
    const again = await api.call('POST', '/api/v2/runs', body);
    assert.equal(first.status, 202); assert.deepEqual(again.body, first.body);
    const conflict = await api.call('POST', '/api/v2/runs', { ...body, workspaceId: 'other' });
    assert.equal(conflict.status, 409);
    await api.waitFor(first.body.run.runId);
    const stale = await api.call('POST', '/api/v2/runs', { ...body, requestId: randomUUID(), workflowSnapshotSha256: 'f'.repeat(64) });
    assert.equal(stale.status, 409, 'snapshot hash must match the saved workflow');
  } finally { await api.close(); }
});

test('a failed run receipt write rolls back run records and skips post-commit dispatch', async () => {
  const api = await startTestRunner();
  const engine = api.runner.engine;
  let dispatches = 0;
  const originalStartRun = engine.startRun;
  let originalPutJson;
  try {
    await api.workspace();
    const workflow = singleAgent({ context: null });
    const saved = await api.save(workflow);
    const publication = api.publication(workflow.workflowId);
    await new Promise(resolve => setImmediate(resolve));

    engine.startRun = function (...args) {
      dispatches += 1;
      return originalStartRun.apply(this, args);
    };
    originalPutJson = engine.store.putJson.bind(engine.store);
    engine.store.putJson = value => {
      if (value?.status === 202 && value?.body?.run?.runId) throw new Error('injected receipt persistence failure');
      return originalPutJson(value);
    };

    const requestId = randomUUID();
    assert.throws(() => engine.createRun({
      workflowId: workflow.workflowId,
      workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: publication.publishedVersionId,
      definitionDigest: publication.definitionDigest,
      workspaceId: 'main',
      requestId,
    }), /injected receipt persistence failure/);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 0);
    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM journal_events').count, 0);
    assert.equal(engine.store.get('SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = ?', requestId).count, 0);
    assert.equal(dispatches, 0);
  } finally {
    if (originalPutJson) engine.store.putJson = originalPutJson;
    engine.startRun = originalStartRun;
    await api.close();
  }
});

test('an output-contract failure drains the run, blocks consumers, and marks the Context for review', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ model: 'fixture-bad-json', output: { format: 'json', schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } } });
    const created = await api.run(workflow);
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'waiting_for_user', 'M2: a failure waits for a recovery decision');
    const states = Object.fromEntries(snapshot.instances.map(item => [item.nodeId, item.state]));
    assert.deepEqual(states, { request: 'succeeded', agent: 'failed', answer: 'scheduled' }, 'unstarted consumers are held, not blocked');
    const closed = await api.closeRun(snapshot.run.runId);
    assert.equal(closed.state, 'failed');
    const events = await api.events(snapshot.run.runId);
    assert.equal(events.find(event => event.type === 'attempt.error').payload.code, 'output_contract');
    const runStates = events.filter(event => event.type === 'run.state_changed').map(event => event.payload.to);
    assert.deepEqual(runStates, ['queued', 'running', 'draining', 'waiting_for_user', 'failed']);
    const after = await api.waitFor(snapshot.run.runId);
    assert.equal(after.instances.find(item => item.nodeId === 'answer').state, 'canceled');
    assert.equal(snapshot.instances.find(item => item.nodeId === 'agent').outputs, null, 'no partial output is committed');
    const bindings = await api.call('GET', '/api/v2/context-bindings?workspaceId=main');
    assert.equal(bindings.body.bindings[0].state, 'needs_review');
  } finally { await api.close(); }
});

test('typed provider failures stay distinct', async () => {
  const api = await startTestRunner({ unavailable: ['claude'] });
  try {
    await api.workspace();
    for (const [model, provider, code] of [['fixture-quota', 'codex', 'quota'], ['fixture-rate-limited', 'codex', 'rate_limited'],
      ['fixture-auth-required', 'codex', 'authentication'], ['fixture-service-unavailable', 'codex', 'provider_unavailable'],
      ['fixture-malformed-jsonl', 'codex', 'provider_protocol'], ['fixture-no-terminal', 'codex', 'output_contract'],
      ['fixture-not-json', 'codex', 'output_contract'], ['fixture-echo', 'claude', 'authentication']]) {
      const workflow = singleAgent({ id: `typed-${code.replace('_', '-')}-${provider}-${model.replace('fixture-', '')}`, model, provider, context: null, output: model === 'fixture-not-json' ? { format: 'json' } : { format: 'text' } });
      const created = await api.run(workflow);
      const snapshot = await api.waitFor(created.body.run.runId);
      assert.equal(snapshot.run.state, 'waiting_for_user', model);
      await api.closeRun(snapshot.run.runId);
      const events = await api.events(snapshot.run.runId);
      assert.equal(events.find(event => event.type === 'attempt.error').payload.code, code, model);
    }
  } finally { await api.close(); }
});

test('root Stop terminates the CLI tree, cancels unstarted work, and finishes canceled', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, (_, snapshot) => snapshot.instances.some(item => item.nodeId === 'agent' && item.state === 'running'));
    const stop = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202); schemaClean('stopResponse', stop.body);
    const started = Date.now();
    const snapshot = await api.waitFor(runId);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(snapshot.run.state, 'canceled');
    const states = Object.fromEntries(snapshot.instances.map(item => [item.nodeId, item.state]));
    assert.equal(states.agent, 'canceled'); assert.equal(states.answer, 'canceled');
    const again = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(again.status, 200); assert.equal(again.body.state, 'canceled');
    const bindings = await api.call('GET', '/api/v2/context-bindings?workspaceId=main');
    assert.equal(bindings.body.bindings[0].state, 'needs_review');
  } finally { await api.close(); }
});

test('active process timeout is a typed failure', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-slow-30', timeoutSeconds: 5, context: null }));
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    await api.closeRun(snapshot.run.runId);
    const events = await api.events(snapshot.run.runId);
    assert.equal(events.find(event => event.type === 'attempt.error').payload.code, 'timeout');
  } finally { await api.close(); }
});

test('Continue reuses a ready binding; a binding needing review blocks creation until acknowledged', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const first = await api.run(singleAgent({ id: 'first' }));
    await api.waitFor(first.body.run.runId);
    const [binding] = (await api.call('GET', '/api/v2/context-bindings?workspaceId=main')).body.bindings;
    const continued = singleAgent({ id: 'second', context: 'continue', bindingId: binding.bindingId });
    const second = await api.run(continued);
    const snapshot = await api.waitFor(second.body.run.runId);
    assert.equal(snapshot.run.state, 'succeeded');
    assert.deepEqual(snapshot.contexts, [{ contextNodeId: 'history', mode: 'continue', bindingId: binding.bindingId }]);
    const events = await api.events(snapshot.run.runId);
    const invocation = await api.artifactJson(events.find(event => event.type === 'attempt.invocation_committed').payload.manifest.artifactId);
    assert.ok(invocation.nativeSessionBefore, 'Continue resumes the stored native session');
    // Fail a Continue run so the binding needs review.
    const failing = singleAgent({ id: 'third', context: 'continue', bindingId: binding.bindingId, model: 'fixture-fail' });
    const third = await api.run(failing);
    await api.waitFor(third.body.run.runId);
    const held = await api.run({ ...continued, workflowId: 'held' });
    assert.equal(held.status, 409, 'a run waiting for recovery keeps the workspace slot');
    await api.closeRun(third.body.run.runId);
    const blocked = await api.run({ ...continued, workflowId: 'fourth' });
    assert.equal(blocked.status, 422); assert.equal(blocked.body.code, 'context_unavailable');
    const listed = (await api.call('GET', '/api/v2/context-bindings?workspaceId=main')).body.bindings.find(item => item.bindingId === binding.bindingId);
    assert.equal(listed.state, 'needs_review');
    const detail = await api.call('POST', `/api/v2/context-bindings/${binding.bindingId}/acknowledge`, { requestId: randomUUID(), observedBindingSha256: 'a'.repeat(64) });
    assert.equal(detail.status, 409, 'a stale digest is rejected');
    const digest = await currentDigest(api, binding.bindingId);
    const acknowledged = await api.call('POST', `/api/v2/context-bindings/${binding.bindingId}/acknowledge`, { requestId: randomUUID(), observedBindingSha256: digest });
    assert.equal(acknowledged.status, 200); schemaClean('contextBinding', acknowledged.body);
    assert.equal(acknowledged.body.state, 'ready');
    const fifth = await api.run({ ...continued, workflowId: 'fifth' });
    assert.equal(fifth.status, 202);
    await api.waitFor(fifth.body.run.runId);
  } finally { await api.close(); }
});

async function currentDigest(api, bindingId) {
  const row = api.runner.engine.store.get('SELECT binding_artifact_id FROM context_bindings WHERE id = ?', bindingId);
  return api.runner.engine.store.artifactRow(row.binding_artifact_id).sha256;
}

test('capacity is application-wide across workspaces and settings changes are journaled', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace('alpha'); await api.workspace('beta');
    const a = await api.run(singleAgent({ id: 'cap-a', model: 'fixture-slow-3', context: null }), 'alpha');
    await api.waitFor(a.body.run.runId, (_, snapshot) => snapshot.instances.some(item => item.nodeId === 'agent' && item.state === 'running'));
    const b = await api.run(singleAgent({ id: 'cap-b', model: 'fixture-echo', context: null }), 'beta');
    await api.waitFor(b.body.run.runId, (_, snapshot) => snapshot.instances.some(item => item.nodeId === 'agent' && item.state === 'waiting'));
    const settings = await api.call('GET', '/api/v2/settings');
    schemaClean('applicationSettings', settings.body);
    const wrong = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: 99, settings: settings.body.settings });
    assert.equal(wrong.status, 409);
    const raised = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.body.revision, settings: { ...settings.body.settings, providerLimits: { codex: 2, claude: 1, antigravity: 1 } } });
    assert.equal(raised.status, 200); assert.equal(raised.body.revision, settings.body.revision + 1);
    const done = await api.waitFor(b.body.run.runId);
    assert.equal(done.run.state, 'succeeded');
    const bEvents = await api.events(b.body.run.runId);
    assert.ok(bEvents.some(event => event.type === 'run.capacity_changed'));
    await api.waitFor(a.body.run.runId);
  } finally { await api.close(); }
});

test('logs are captured as contiguous byte batches that reassemble the stream', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ model: 'fixture-noisy', context: null }));
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'succeeded');
    const chunks = (await api.events(snapshot.run.runId)).filter(event => event.type === 'attempt.log_chunk' && event.payload.stream === 'stdout');
    assert.deepEqual(chunks.map(event => event.payload.chunkIndex), chunks.map((_, index) => index));
    assert.ok(chunks.length >= 2 && chunks.length < 50, `batched (${chunks.length} chunks for ~400 lines)`);
    let text = '';
    for (const chunk of chunks) text += await api.artifactText(chunk.payload.chunk.artifactId);
    assert.equal(text.trim().split('\n').length, 403, 'thread start, 400 noise lines, answer and turn completion');
  } finally { await api.close(); }
});

test('lists paginate with fenced cursors; foreign cursors are rejected', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const ids = [];
    for (const id of ['page-a', 'page-b', 'page-c']) { const created = await api.run(singleAgent({ id, context: null })); ids.push(created.body.run.runId); await api.waitFor(created.body.run.runId); }
    const first = await api.call('GET', '/api/v2/runs?workspaceId=main&limit=2');
    schemaClean('runs', first.body);
    assert.equal(first.body.items.length, 2); assert.ok(first.body.nextCursor);
    const later = await api.run(singleAgent({ id: 'page-d', context: null })); await api.waitFor(later.body.run.runId);
    const second = await api.call('GET', `/api/v2/runs?workspaceId=main&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.body.items.length, 1); assert.equal(second.body.nextCursor, null);
    assert.deepEqual([...first.body.items, ...second.body.items].map(item => item.runId), [...ids].reverse(), 'later inserts are excluded');
    const mismatch = await api.call('GET', `/api/v2/runs?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(mismatch.status, 400);
    assert.equal((await api.call('GET', '/api/v2/runs?workspaceId=missing')).status, 404);
    schemaClean('workflows', (await api.call('GET', '/api/v2/workflows')).body);
    schemaClean('workspaces', (await api.call('GET', '/api/v2/workspaces')).body);
  } finally { await api.close(); }
});

test('artifacts are digest-verified on read; tampering is reported as corruption', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ context: null }));
    const snapshot = await api.waitFor(created.body.run.runId);
    const id = snapshot.run.workflowSnapshot.artifactId;
    const ok = await api.call('GET', `/api/v2/artifacts/${id}`, undefined, { raw: true });
    assert.equal(ok.headers.get('etag'), `"${snapshot.run.workflowSnapshot.sha256}"`);
    const row = api.runner.engine.store.artifactRow(id);
    writeFileSync(join(api.root, 'store', row.relative_path), 'tampered');
    const bad = await api.call('GET', `/api/v2/artifacts/${id}`);
    assert.equal(bad.status, 500); assert.equal(bad.body.code, 'corruption');
  } finally { await api.close(); }
});

test('validation rejects executable defects and save keeps disconnected drafts', async () => {
  const api = await startTestRunner();
  try {
    const workflow = singleAgent({ id: 'draft', context: null });
    workflow.edges = workflow.edges.slice(0, 1);
    const saved = await api.save(workflow);
    assert.equal(saved.validation.valid, false);
    assert.ok(saved.validation.issues.some(issue => /answer.value/.test(issue.message)));
    schemaClean('savedWorkflow', saved);
    await api.workspace();
    const created = await api.call('POST', '/api/v2/runs', { workflowId: 'draft', workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: randomUUID(), definitionDigest: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(created.status, 404, 'a Draft has no launchable Published Version');
    assert.equal(created.body.code, 'published_version_not_found');
    const legacy = await api.call('PUT', '/api/v2/workflows/dup', { workflowId: 'dup' });
    assert.equal(legacy.status, 410);
    assert.equal(legacy.body.code, 'api_upgrade_required');
    for (const options of [undefined, { kind: 'system' }])
      assert.throws(() => api.runner.engine.putWorkflow('draft', workflow, options), error => error.code === 'precondition_required');
    assert.equal(api.runner.engine.getWorkflowV3('draft').revision, 1);
    const unauthorized = await fetch(`http://127.0.0.1:${api.runner.connection.port}/api/v2/settings`);
    assert.equal(unauthorized.status, 401);
  } finally { await api.close(); }
});

test('restart recovery marks running work interrupted, never retries, and frees the workspace', async () => {
  const api = await startTestRunner();
  const root = api.root;
  await api.workspace();
  const created = await api.run(singleAgent({ model: 'fixture-slow-30' }));
  const runId = created.body.run.runId;
  await api.waitFor(runId, (_, snapshot) => snapshot.instances.some(item => item.nodeId === 'agent' && item.state === 'running'));
  const pid = api.runner.engine.store.get(`SELECT process_id FROM attempts WHERE run_id = ? AND node_instance_id = 'agent'`, runId).process_id;
  // Simulate losing the runtime: detach the old engine, kill the CLI, and open the store again.
  for (const record of api.runner.engine.processes.values()) {
    clearTimeout(record.timer); record.child.removeAllListeners('close'); record.child.stdout.removeAllListeners('data'); record.child.stderr.removeAllListeners('data');
  }
  api.runner.engine.runs.clear();
  await killTree(pid);
  const engine = new Engine({ root, adapters: fixtureAdapters(join(root, 'fixture-state')) });
  await engine.initialize();
  const run = engine.store.get('SELECT state FROM runs WHERE id = ?', runId);
  assert.equal(run.state, 'interrupted');
  const attempts = engine.store.all('SELECT node_instance_id, state FROM attempts WHERE run_id = ?', runId);
  assert.deepEqual(Object.fromEntries(attempts.map(item => [item.node_instance_id, item.state])), { request: 'succeeded', agent: 'interrupted', answer: 'canceled' });
  const binding = engine.store.get('SELECT state FROM context_bindings');
  assert.equal(binding.state, 'needs_review');
  assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM resource_locks').n, 0);
  assert.equal(engine.activeRun('main'), undefined);
  engine.store.close();
  api.runner.engine.processes.clear();
  await api.close();
  assert.ok(readdirSync(join(root, 'store')).includes('state.sqlite'));
});
