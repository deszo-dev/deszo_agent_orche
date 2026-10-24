import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import clientTimeouts from '../../docs/authoring/client-timeouts.json' with { type: 'json' };
import { singleAgent, startTestRunner } from './helpers.mjs';

// Run-scoped identity. The workflow Draft pointer is editing state. An admitted Run, its Judge subject, its pending
// attention, its supervision grant and its cache pins follow immutable Published Versions, so editing cannot change them.

const EXAMPLE = resolve(import.meta.dirname, '../../docs/examples/m3-cache/workflow.json');
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.state);
const codex = clientTimeouts.entries.find(entry => entry.provider === 'codex');

const countOf = (api, sql, ...params) => api.runner.engine.store.get(sql, ...params).n;
const draftPath = workflowId => `/api/v4/workflows/${workflowId}/draft`;

// A valid save publishes. The Run is admitted with the exact Published Version it names, not with the Draft.
async function admitPublished(api, workflow) {
  await api.save(workflow);
  const publication = api.publication(workflow.workflowId);
  const started = await api.call('POST', '/api/v2/runs', { requestId: randomUUID(), workflowId: workflow.workflowId,
    workflowSnapshotSha256: publication.snapshotSha256, publishedVersionId: publication.publishedVersionId,
    definitionDigest: publication.definitionDigest, workspaceId: 'main' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.outcome, 'created');
  await api.waitFor(started.body.run.runId, terminal);
  return { runId: started.body.run.runId, publication };
}

// Saves a Draft revision without publishing it.
async function saveDraftOnly(api, workflowId, workflow) {
  const current = await api.call('GET', draftPath(workflowId));
  const saved = await api.call('PUT', draftPath(workflowId), { requestId: randomUUID(), workflow }, { headers: { 'If-Match': current.body.etag } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}

function editedAgentTimeout(workflow, seconds) {
  const edited = structuredClone(workflow);
  for (const node of edited.nodes) if (node.type === 'agent') node.config.timeoutSeconds = seconds;
  return edited;
}

// A disposable controller and a judge session over the given runs, through the public route.
async function judgeFor(api, runIds) {
  const controller = api.runner.engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'identity controller', clientProvider: 'other' }).body;
  const registration = { requestId: randomUUID(), controllerSessionId: controller.controllerSessionId, runIds, provider: 'antigravity',
    model: 'gemini-3.8-flash-high', effort: 'high', nativeSessionId: randomUUID(), ownership: 'dedicated', billing: 'subscription_only',
    maxInvocations: 3, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), queueWaitMs: 600_000 };
  const registered = await api.call('POST', '/api/v2/judge-sessions', registration);
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { sessionId: registered.body.judgeSessionId, headers: { 'X-Deszo-Controller-Token': controller.controllerToken } };
}

const requestAttention = (api, judge, runId) => api.callExternal('POST', '/api/v2/judge-attention',
  { requestId: randomUUID(), judgeSessionId: judge.sessionId, runId }, { headers: judge.headers });

function fakeSupervisor() {
  return { pipeName: 'pipe-test', shimPath: null, status: () => Promise.resolve({ escalated: false }), armRun: () => Promise.resolve({ armed: true }),
    disarmRun: () => Promise.resolve({}), releaseRun: () => Promise.resolve({}), heartbeat: () => Promise.resolve({}) };
}

// The supervision suite measures the codex tool-timeout matrix in the shipped JSON; the grant test marks it verified in-process only.
function requestGrant(api, controllerToken, controllerSessionId, workflowId, snapshotSha256) {
  return api.runner.engine.requestControlGrant({ requestId: randomUUID(), controllerSessionId, workflowId, workflowSnapshotSha256: snapshotSha256,
    workspaceId: 'main', clientProvider: 'codex', clientVersion: codex.testedVersion, requestedActions: ['observe'],
    observationDeadlineMs: 10000, escalationDeadlineMs: 30000 }, { controllerToken });
}

function codexSession(api) {
  return api.runner.engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'identity controller', clientProvider: 'codex' }).body;
}

test('Case A: an unpublished Draft leaves an admitted Run, its Judge identity, its pending attention and supervision on the published version', async () => {
  const savedStatus = codex.status;
  codex.status = 'verified';
  const api = await startTestRunner({ runner: { judgeAttentionEnabled: true } });
  try {
    await api.workspace();
    const v1 = singleAgent({ id: 'identity-a', context: null });
    const { runId, publication } = await admitPublished(api, v1);
    // Attached after admission: an unsupervised run must finish without a supervisor, as in every other suite.
    api.runner.engine.supervisor = fakeSupervisor();
    const judge = await judgeFor(api, [runId]);
    const attention = await requestAttention(api, judge, runId);
    assert.equal(attention.status, 201, JSON.stringify(attention.body));

    await saveDraftOnly(api, v1.workflowId, editedAgentTimeout(v1, 90));
    assert.equal(countOf(api, 'SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', v1.workflowId), 1, 'the Draft is not a publication');

    const subject = api.runner.engine.judgeSubject(runId);
    assert.equal(subject.currentSnapshotSha256, publication.snapshotSha256, 'the Judge subject still names Published Version 1');
    assert.equal(subject.workflowRevision, 1);
    const listed = await api.callExternal('GET', `/api/v2/judge-sessions/${judge.sessionId}/attention`, undefined, { headers: judge.headers });
    assert.equal(listed.body.items[0].state, 'pending', 'an unpublished Draft does not stale the pending attention');
    const secondJudge = await judgeFor(api, [runId]);
    assert.ok(secondJudge.sessionId, 'Judge registration over the admitted Run is accepted');

    const session = codexSession(api);
    const grant = requestGrant(api, session.controllerToken, session.controllerSessionId, v1.workflowId, publication.snapshotSha256);
    assert.equal(grant.body.state, 'pending', 'supervision of the published definition is still granted');
  } finally {
    codex.status = savedStatus;
    api.runner.engine.supervisor = null;
    await api.close();
  }
});

test('Case B: publishing a later version leaves admitted Run A on V1 and its Judge identity unchanged', async () => {
  const api = await startTestRunner({ runner: { judgeAttentionEnabled: true } });
  try {
    await api.workspace();
    const v1 = singleAgent({ id: 'identity-b', context: null });
    const { runId, publication: pubV1 } = await admitPublished(api, v1);
    const judge = await judgeFor(api, [runId]);

    await api.save(editedAgentTimeout(v1, 90));
    const pubV2 = api.publication(v1.workflowId);
    assert.equal(pubV2.version, 2);
    assert.notEqual(pubV2.publishedVersionId, pubV1.publishedVersionId);

    const bound = api.runner.engine.store.get('SELECT published_version_id FROM runs WHERE id = ?', runId);
    assert.equal(bound.published_version_id, pubV1.publishedVersionId, 'publication never retargets an admitted Run');
    const subject = api.runner.engine.judgeSubject(runId);
    assert.equal(subject.currentSnapshotSha256, pubV1.snapshotSha256);
    assert.equal(subject.workflowRevision, 1);
    assert.equal((await requestAttention(api, judge, runId)).status, 201, 'Judge review of Run A is still admitted after V2');

    const draft = await api.call('GET', draftPath(v1.workflowId));
    assert.equal(draft.body.sourcePublishedVersionId, pubV2.publishedVersionId, 'the Draft records the publication it produced');
  } finally {
    await api.close();
  }
});

test('Case C: an invalid publication association is refused deterministically by the Judge identity check', async () => {
  const api = await startTestRunner({ runner: { judgeAttentionEnabled: true } });
  try {
    await api.workspace();
    const v1 = singleAgent({ id: 'identity-c', context: null });
    const { runId } = await admitPublished(api, v1);
    await api.save(editedAgentTimeout(v1, 90));
    const pubV2 = api.publication(v1.workflowId);

    // Isolated fixture: the production binding trigger would refuse this association, so this disposable store drops it.
    api.runner.engine.store.db.exec('DROP TRIGGER runs_published_binding_update');
    api.runner.engine.store.run('UPDATE runs SET published_version_id = ? WHERE id = ?', pubV2.publishedVersionId, runId);

    const subject = api.runner.engine.judgeSubject(runId);
    assert.equal(subject.currentSnapshotSha256, pubV2.snapshotSha256);
    assert.notEqual(subject.currentSnapshotSha256, subject.workflowSnapshotSha256, 'the captured definition no longer matches its binding');
    const controller = api.runner.engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'identity controller', clientProvider: 'other' }).body;
    const refused = await api.call('POST', '/api/v2/judge-sessions', { requestId: randomUUID(), controllerSessionId: controller.controllerSessionId,
      runIds: [runId], provider: 'antigravity', model: 'gemini-3.8-flash-high', effort: 'high', nativeSessionId: randomUUID(), ownership: 'dedicated',
      billing: 'subscription_only', maxInvocations: 3, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), queueWaitMs: 600_000 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'stale_judge_subject');
  } finally {
    await api.close();
  }
});

test('Case D: an unpublished Draft never admits, launches or supervises a Run', async () => {
  const savedStatus = codex.status;
  codex.status = 'verified';
  const api = await startTestRunner();
  try {
    await api.workspace();
    const v1 = singleAgent({ id: 'identity-d', context: null });
    const { publication } = await admitPublished(api, v1);
    api.runner.engine.supervisor = fakeSupervisor();
    await saveDraftOnly(api, v1.workflowId, editedAgentTimeout(v1, 90));
    const draft = (await api.call('GET', draftPath(v1.workflowId))).body;
    assert.notEqual(draft.definitionDigest, publication.definitionDigest, 'the Draft really differs from the published version');
    const runsBefore = countOf(api, 'SELECT COUNT(*) AS n FROM runs');

    const attempt = body => api.call('POST', '/api/v2/runs', { requestId: randomUUID(), workflowId: v1.workflowId, workspaceId: 'main', ...body });
    const draftWithPublishedId = await attempt({ workflowSnapshotSha256: draft.snapshotSha256, definitionDigest: draft.definitionDigest, publishedVersionId: publication.publishedVersionId });
    assert.equal(draftWithPublishedId.status, 409, 'a Draft digest cannot name Published Version 1');
    const draftWithPublishedDigest = await attempt({ workflowSnapshotSha256: draft.snapshotSha256, definitionDigest: publication.definitionDigest, publishedVersionId: publication.publishedVersionId });
    assert.equal(draftWithPublishedDigest.status, 409, 'a Draft snapshot cannot ride on the published digest');
    const unknownVersion = await attempt({ workflowSnapshotSha256: draft.snapshotSha256, definitionDigest: draft.definitionDigest, publishedVersionId: randomUUID() });
    assert.equal(unknownVersion.status, 404);
    assert.equal(unknownVersion.body.code, 'published_version_not_found');
    assert.equal(countOf(api, 'SELECT COUNT(*) AS n FROM runs'), runsBefore, 'no refused attempt created a Run');

    const session = codexSession(api);
    assert.throws(() => requestGrant(api, session.controllerToken, session.controllerSessionId, v1.workflowId, draft.snapshotSha256),
      error => error.status === 409 && error.code === 'conflict', 'supervision names only a Runnable Published Version');
  } finally {
    codex.status = savedStatus;
    api.runner.engine.supervisor = null;
    await api.close();
  }
});

test('cache identity follows publications: an unpublished Draft that removes a Cache node cannot refuse the published frozen version', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const cacheWorkflow = mode => {
      const workflow = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
      workflow.workflowId = 'cache-identity';
      for (const node of workflow.nodes) {
        if (node.type === 'agent') node.config.model = 'fixture-echo';
        if (node.type === 'cache') node.config.mode = mode;
      }
      return workflow;
    };
    const cacheIds = workflow => workflow.nodes.filter(node => node.type === 'cache').map(node => node.id);
    const live = cacheWorkflow('live');
    const first = await api.run(live);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal((await api.waitFor(first.body.run.runId, terminal)).run.state, 'succeeded');
    const [cacheId] = cacheIds(live);
    const pinned = await api.call('PUT', `/api/v2/workflows/cache-identity/cache-pins/${cacheId}`, { runId: first.body.run.runId, nodeInstanceId: cacheId });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));

    const frozen = cacheWorkflow('frozen');
    const second = await api.run(frozen);
    assert.equal(second.status, 202, JSON.stringify(second.body));
    assert.equal((await api.waitFor(second.body.run.runId, terminal)).run.state, 'succeeded');
    const publishedFrozen = api.publication('cache-identity');

    const ids = new Set(cacheIds(frozen));
    const draft = structuredClone(frozen);
    draft.nodes = draft.nodes.filter(node => !ids.has(node.id));
    draft.edges = draft.edges.filter(edge => !ids.has(edge.source.nodeId) && !ids.has(edge.target.nodeId));
    draft.after = draft.after.filter(pair => !ids.has(pair.before) && !ids.has(pair.after));
    await saveDraftOnly(api, 'cache-identity', draft);

    const pins = await api.call('GET', '/api/v2/workflows/cache-identity/cache-pins');
    assert.equal(pins.body.pins[0].orphaned, false, 'an unpublished Draft does not retire the executable pin');
    const readmit = await api.call('POST', '/api/v2/runs', { requestId: randomUUID(), workflowId: 'cache-identity',
      workflowSnapshotSha256: publishedFrozen.snapshotSha256, publishedVersionId: publishedFrozen.publishedVersionId,
      definitionDigest: publishedFrozen.definitionDigest, workspaceId: 'main' });
    assert.equal(readmit.status, 202, JSON.stringify(readmit.body));
    assert.equal(readmit.body.outcome, 'created');
    assert.equal((await api.waitFor(readmit.body.run.runId, terminal)).run.state, 'succeeded');
  } finally {
    await api.close();
  }
});

test('Judge registration and owner transfer stay refused in host-bound mode; the Owner Token reaches them only without a Host', async () => {
  const api = await startTestRunner({ runner: { judgeAttentionEnabled: true } });
  try {
    await api.workspace();
    const { runId } = await admitPublished(api, singleAgent({ id: 'trusted-judge', context: null }));
    const judge = await judgeFor(api, [runId]);
    const successor = api.runner.engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'successor controller', clientProvider: 'other' }).body;
    const ownerGeneration = () => countOf(api, 'SELECT owner_generation AS n FROM judge_sessions WHERE id = ?', judge.sessionId);
    try {
      // refuseHostMutation keys on the Host authority that a host-bound runtime registers.
      api.runner.engine.hostAuthority = {};
      const registration = { requestId: randomUUID(), controllerSessionId: successor.controllerSessionId, runIds: [runId], provider: 'antigravity',
        model: 'gemini-3.8-flash-high', effort: 'high', nativeSessionId: randomUUID(), ownership: 'dedicated', billing: 'subscription_only',
        maxInvocations: 3, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), queueWaitMs: 600_000 };
      const reRegistered = await api.call('POST', '/api/v2/judge-sessions', registration);
      assert.equal(reRegistered.status, 403);
      assert.equal(reRegistered.body.code, 'trusted_authority_required');
      const transfer = await api.call('POST', `/api/v2/judge-sessions/${judge.sessionId}/owner`,
        { requestId: randomUUID(), controllerSessionId: successor.controllerSessionId }, { headers: judge.headers });
      assert.equal(transfer.status, 403);
      assert.equal(transfer.body.code, 'trusted_authority_required');
      assert.equal(ownerGeneration(), 1, 'a refused transfer changes no owner generation');
    } finally {
      api.runner.engine.hostAuthority = null;
    }
    const accepted = await api.call('POST', `/api/v2/judge-sessions/${judge.sessionId}/owner`,
      { requestId: randomUUID(), controllerSessionId: successor.controllerSessionId }, { headers: judge.headers });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(ownerGeneration(), 2);
  } finally {
    await api.close();
  }
});

test('lifecycle receipts require the Host-authenticated channel, even in an unbound runtime', async () => {
  const api = await startTestRunner();
  try {
    const receipt = { requestId: randomUUID(), operationId: randomUUID(), candidateDigest: 'a'.repeat(64), outcome: 'verified', receiptId: randomUUID() };
    let refusal = null;
    try { api.runner.engine.applyLifecycleReceipt(randomUUID(), receipt); } catch (error) { refusal = error; }
    assert.equal(refusal?.status, 403);
    assert.equal(refusal?.code, 'trusted_host_channel_required');
    const route = await api.call('POST', `/api/v2/runs/${randomUUID()}/lifecycle-receipt`, receipt);
    assert.equal(route.status, 410, 'the public receipt route stays retired');
  } finally {
    await api.close();
  }
});
