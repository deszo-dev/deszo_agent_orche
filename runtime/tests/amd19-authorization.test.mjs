import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startTestRunner } from './helpers.mjs';
import { singleAgent } from './helpers.mjs';

async function request(api, token, method, path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${api.runner.connection.port}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('AMD-19 inventories every route and Owner Token survives rotation and restart', async () => {
  const api = await startTestRunner();
  const root = api.root;
  try {
    const inventory = api.runner.routeInventory;
    const counts = Object.groupBy(inventory, route => route.classification);
    assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.length])), {
      public: 90, 'internal-host': 5, retired: 4,
    });
    assert.equal(inventory.length, 99);
    assert.equal(inventory.filter(route => route.preflight).length, 1);
    assert.equal(inventory.filter(route => route.hostVariant).length, 1);
    assert.equal(new Set(inventory.map(route => `${route.method} ${route.pattern}`)).size, inventory.length);

    const oldToken = api.runner.connection.token;
    assert.equal(api.runner.connection.firstPartyToken, oldToken, 'the desktop compatibility field is the same owner credential');
    assert.equal((await request(api, oldToken, 'GET', '/api/v2/settings')).status, 200);
    const currentSettings = (await request(api, oldToken, 'GET', '/api/v2/settings')).body;
    const updated = await request(api, oldToken, 'PUT', '/api/v2/settings', {
      requestId: randomUUID(), expectedRevision: currentSettings.revision,
      settings: { ...currentSettings.settings, globalLimit: currentSettings.settings.globalLimit + 1 },
    });
    assert.equal(updated.status, 200, 'Owner Token can change public Runtime settings');

    await api.workspace();
    const workflow = singleAgent({ id: `amd19-${randomUUID().slice(0, 8)}`, context: null, model: 'fixture-slow-30' });
    await api.save(workflow);
    const publication = api.runner.engine.getLatestWorkflowPublication(workflow.workflowId);
    const runRequest = { requestId: randomUUID(), workflowId: workflow.workflowId, workflowSnapshotSha256: publication.snapshotSha256,
      publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main' };
    const submitted = await request(api, oldToken, 'POST', '/api/v2/runs', runRequest);
    assert.equal(submitted.body.outcome, 'created', 'public Owner Token Run admission does not require a second first-party confirmation');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM external_run_requests').count, 0, 'Owner admission creates no pending owner-approval request');
    const active = await api.waitFor(submitted.body.run.runId, run => run.state === 'running');
    assert.equal(active.run.state, 'running', 'the Run is admitted before Owner Token revocation');
    const replay = await request(api, oldToken, 'POST', '/api/v2/runs', runRequest);
    assert.equal(replay.body.run.runId, submitted.body.run.runId, 'an exact Owner retry replays the same Run');
    const ownerForgedHostRun = await request(api, oldToken, 'POST', '/api/v2/runs', { ...runRequest, requestId: randomUUID(), hostPermitId: randomUUID() });
    assert.equal(ownerForgedHostRun.status, 409, 'Owner Token cannot attest a Host permit by supplying its identifier');
    assert.equal(ownerForgedHostRun.body.code, 'autonomy_unavailable');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 1, 'a forged Host permit creates no second Run');
    assert.equal((await request(api, oldToken, 'POST', `/api/v2/control-grants/${randomUUID()}/decision`, { requestId: randomUUID(), decision: 'approve' })).status, 404,
      'Owner Token reaches the public grant decision handler without a second first-party gate');
    assert.equal((await request(api, oldToken, 'POST', `/api/v2/incidents/${randomUUID()}/triage`, { requestId: randomUUID(), state: 'closed' })).status, 404,
      'Owner Token reaches the public incident triage handler');
    assert.equal((await request(api, oldToken, 'POST', `/api/v2/runs/${randomUUID()}/recovery`, { requestId: randomUUID(), action: 'close' })).status, 404,
      'Owner Token reaches the public recovery handler');

    assert.equal((await request(api, null, 'GET', '/api/v2/settings')).status, 401);
    assert.equal((await request(api, 'invalid', 'GET', '/api/v2/settings')).status, 401);
    assert.equal((await request(api, oldToken, 'GET', '/api/v2/not-registered')).status, 404);
    assert.equal((await request(api, null, 'OPTIONS', '/api/v2/settings')).status, 204);

    const rotated = await request(api, oldToken, 'POST', '/api/v2/owner-token/rotate', {});
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.rotated, true);
    assert.match(rotated.body.token, /^[a-f0-9]{64}$/);
    assert.notEqual(rotated.body.token, oldToken);
    assert.equal((await request(api, oldToken, 'GET', '/api/v2/settings')).status, 401);
    assert.equal((await request(api, rotated.body.token, 'GET', '/api/v2/settings')).status, 200);
    const stillRunning = await request(api, rotated.body.token, 'GET', `/api/v2/runs/${submitted.body.run.runId}`);
    assert.equal(stillRunning.status, 200);
    assert.equal(stillRunning.body.run.state, 'running', 'revoking the old token does not stop an already admitted Run');
    const descriptor = JSON.parse(await readFile(api.runner.connection.connectionFile, 'utf8'));
    assert.equal(descriptor.token, rotated.body.token);
  } finally {
    await api.close();
  }

  const restarted = await startTestRunner({ root });
  try {
    assert.equal(restarted.runner.connection.token, JSON.parse(await readFile(restarted.runner.connection.connectionFile, 'utf8')).token);
    assert.equal((await request(restarted, restarted.runner.connection.token, 'GET', '/api/v2/settings')).status, 200);
  } finally {
    await restarted.close();
  }
});

test('Owner Token cannot cross into internal Host routes or use Host-only credentials as Owner', async () => {
  const api = await startTestRunner({ runner: { devTestConfirmationOff: true, exposeHostRequestForTests: true } });
  const id = randomUUID();
  const owner = api.runner.connection.token;
  const wrongHost = '0'.repeat(64);
  const internal = [
    ['POST', '/api/v2/judge-invocations', {}],
    ['POST', `/api/v2/judge-invocations/${id}/started`, {}],
    ['POST', `/api/v2/judge-invocations/${id}/complete`, {}],
    ['GET', `/api/v2/judge-invocations/${id}/reads`],
    ['POST', `/api/v2/control-grants/${id}/host-approval`, {}],
  ];
  try {
    const before = api.runner.engine.store.get('SELECT COUNT(*) AS count FROM judge_invocations').count;
    for (const [method, path, body] of internal) {
      assert.equal((await request(api, owner, method, path, body)).status, 403, `Owner Token refused for ${method} ${path}`);
      assert.equal((await request(api, null, method, path, body)).status, 401, `missing token refused for ${method} ${path}`);
      assert.equal((await request(api, wrongHost, method, path, body)).status, 401, `incorrect Host token refused for ${method} ${path}`);
      assert.equal((await request(api, owner, method, path, body, { 'X-Deszo-Host-Identity': 'forged' })).status, 403, 'Host identity headers cannot elevate Owner Token');
    }
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM judge_invocations').count, before);
    assert.equal((await request(api, api.runner.connection.token, 'GET', '/api/v2/settings')).status, 200);
    assert.equal((await api.callHost('GET', '/api/v2/settings')).status, 403, 'Host credential cannot act as an Owner Token on public routes');
    assert.equal((await api.callHost('POST', '/api/v2/runs', {})).status, 403, 'Host route variant requires a Host permit');
    const forgedHostRun = await api.callHost('POST', '/api/v2/runs', { requestId: randomUUID(), hostPermitId: randomUUID() });
    assert.equal(forgedHostRun.status, 409);
    assert.equal(forgedHostRun.body.code, 'autonomy_unavailable', 'Host credential alone cannot create a Run without a Host-bound Engine permit');

    for (const [method, path, body] of internal) {
      const result = await api.callHost(method, path, body);
      assert.ok(![401, 403].includes(result.status), `the isolated Host protocol credential passed the boundary for ${method} ${path}`);
    }
  } finally {
    await api.close();
  }
});

test('every retired route rejects before former writes, including Owner and Host callers', async () => {
  const api = await startTestRunner({ runner: { devTestConfirmationOff: true, exposeHostRequestForTests: true } });
  const owner = api.runner.connection.token;
  const workflowId = `retired-${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const requestId = randomUUID();
  const retired = [
    ['PUT', `/api/v3/workflows/${workflowId}`, { requestId, expectedEtag: null, workflow: { workflowId } }],
    ['PUT', `/api/v2/workflows/${workflowId}`, { requestId, workflow: { workflowId } }],
    ['POST', `/api/v2/run-requests/${runId}/decision`, { requestId, decision: 'approve' }],
    ['POST', `/api/v2/runs/${runId}/lifecycle-receipt`, { requestId, operationId: randomUUID(), receiptId: randomUUID(), candidateDigest: 'a'.repeat(64), outcome: 'verified' }],
  ];
  try {
    const before = api.runner.engine.store.get('SELECT COUNT(*) AS count FROM workflows').count;
    for (const [method, path, body] of retired) {
      const expectedCode = path.startsWith('/api/v2/workflows/') || path.startsWith('/api/v3/workflows/') ? 'api_upgrade_required' : 'operation_retired';
      assert.equal((await request(api, null, method, path, body)).status, 401);
      for (const caller of [owner, 'host']) {
        const result = caller === 'host' ? await api.callHost(method, path, body) : await request(api, caller, method, path, body);
        assert.equal(result.status, 410, `${method} ${path} must remain retired for every authenticated principal`);
        assert.equal(result.body.code, expectedCode);
      }
    }
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM workflows').count, before);
    assert.equal((await request(api, owner, 'PATCH', `/api/v3/workflows/${workflowId}`, { workflow: { workflowId } })).status, 404);
  } finally {
    await api.close();
  }
});

test('retired v3 saves replay an exact committed receipt and reject new or changed writes', async () => {
  const api = await startTestRunner();
  const owner = api.runner.connection.token;
  const workflow = singleAgent({ id: `receipt-${randomUUID().slice(0, 8)}`, context: null });
  const requestId = randomUUID();
  const body = { requestId, expectedEtag: null, workflow };
  try {
    const saved = api.runner.engine.saveWorkflowV3(workflow.workflowId, body);
    const path = `/api/v3/workflows/${workflow.workflowId}`;
    const replay = await request(api, owner, 'PUT', path, body, { 'If-None-Match': '*' });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, saved);

    const changed = structuredClone(body);
    changed.workflow.nodes[0].config.value = 'different payload';
    const conflict = await request(api, owner, 'PUT', path, changed, { 'If-None-Match': '*' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'conflict');

    const newWrite = await request(api, owner, 'PUT', path, { ...body, requestId: randomUUID() }, { 'If-None-Match': '*' });
    assert.equal(newWrite.status, 410);
    assert.equal(newWrite.body.code, 'api_upgrade_required');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM workflows WHERE id = ?', workflow.workflowId).count, 1);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM workflow_changes WHERE workflow_id = ?', workflow.workflowId).count, 1);
  } finally {
    await api.close();
  }
});

test('Owner cutover closes pending requests durably without losing original receipts or launching', async () => {
  const first = await startTestRunner();
  const root = first.root;
  const requestId = randomUUID();
  let runBody;
  let originalResponse;
  try {
    await first.workspace();
    const workflow = singleAgent({ id: `pending-${randomUUID().slice(0, 8)}`, context: null });
    await first.save(workflow);
    const publication = first.runner.engine.getLatestWorkflowPublication(workflow.workflowId);
    runBody = { requestId, workflowId: workflow.workflowId, workflowSnapshotSha256: publication.snapshotSha256,
      publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main' };
    originalResponse = first.runner.engine.createRun(runBody, { role: 'external', clientLabel: 'legacy-client' });
    assert.equal(originalResponse.status, 202);
    assert.equal(originalResponse.body.outcome, 'confirmation_pending');
    assert.equal(first.runner.engine.getRunRequest(requestId).state, 'pending');
    assert.equal(first.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 0);
  } finally {
    await first.close();
  }

  const restarted = await startTestRunner({ root });
  try {
    const status = await request(restarted, restarted.runner.connection.token, 'GET', `/api/v2/run-requests/${requestId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.state, 'denied');
    assert.equal(status.body.problem.code, 'policy_cutover');

    const replay = await request(restarted, restarted.runner.connection.token, 'POST', '/api/v2/runs', runBody);
    assert.equal(replay.status, originalResponse.status);
    assert.deepEqual(replay.body, originalResponse.body);
    assert.equal(restarted.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 0);

    const freshRequest = await request(restarted, restarted.runner.connection.token, 'POST', '/api/v2/runs', { ...runBody, requestId: randomUUID() });
    assert.equal(freshRequest.status, 202);
    assert.equal(freshRequest.body.outcome, 'created');
  } finally {
    await restarted.close();
  }
});
