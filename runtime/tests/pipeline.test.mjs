import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { routeCase, selectedOutcome } from '../core/engine.mjs';
import { Store } from '../core/store.mjs';
import { values as valueHelpers } from '../core/utilities.mjs';
import * as gate from '../core/gate.mjs';
import { contextChain, singleAgent, startTestRunner } from './helpers.mjs';

const read = path => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs', path), 'utf8'));
const decisions = read('fixtures/decisions.json');
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);

function cacheWorkflow({ mode = 'live', researchModel = 'fixture-echo' } = {}) {
  const workflow = read('examples/m3-cache/workflow.json');
  workflow.workflowId = 'cache-flow';
  for (const node of workflow.nodes) {
    if (node.type === 'agent') node.config.model = node.id === 'research' ? researchModel : 'fixture-echo';
    if (node.type === 'cache') node.config.mode = mode;
  }
  return workflow;
}

function specificationLoop({ analyst = 'fixture-analyst', reviewer = 'fixture-reviewer-approve-2', readiness } = {}) {
  const workflow = read('examples/m4-specification-loop/workflow.json');
  const visit = nodes => {
    for (const node of nodes) {
      if (node.type === 'agent') node.config.model = node.id === 'analyst' ? analyst : node.id === 'readiness-review' && readiness ? readiness : reviewer;
      if (node.type === 'loop') visit(node.config.body.nodes);
    }
  };
  visit(workflow.nodes);
  return workflow;
}

function routeFlow(status) {
  return {
    schemaVersion: 1, workflowId: 'route-flow', capabilities: ['core-v1', 'loops-v1', 'pipeline-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'status', type: 'text', config: { value: status } },
      { id: 'payload', type: 'text', config: { value: 'payload text' } },
      { id: 'state', type: 'merge', config: { mode: 'record', inputs: [{ id: 'status', type: 'Text' }], fields: [{ name: 'status', source: { input: 'status' } }] } },
      { id: 'switch', type: 'route', config: { valueType: 'Text', selector: '/status', cases: [{ id: 'yes', equals: 'yes' }, { id: 'no', equals: 'no' }], onUnmatched: 'error' } },
      { id: 'on-yes', type: 'prompt-template', config: { template: 'YES: {{v}}', slots: [{ id: 'v' }] } },
      { id: 'on-no', type: 'prompt-template', config: { template: 'NO: {{v}}', slots: [{ id: 'v' }] } },
      { id: 'join', type: 'merge', config: { mode: 'selected', valueType: 'Text', inputs: [{ id: 'yes' }, { id: 'no' }] } },
      { id: 'out', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'status', port: 'text' }, target: { nodeId: 'state', port: 'status' } },
      { id: 'e2', source: { nodeId: 'state', port: 'value' }, target: { nodeId: 'switch', port: 'selector' } },
      { id: 'e3', source: { nodeId: 'payload', port: 'text' }, target: { nodeId: 'switch', port: 'value' } },
      { id: 'e4', source: { nodeId: 'switch', port: 'yes' }, target: { nodeId: 'on-yes', port: 'v' } },
      { id: 'e5', source: { nodeId: 'switch', port: 'no' }, target: { nodeId: 'on-no', port: 'v' } },
      { id: 'e6', source: { nodeId: 'on-yes', port: 'text' }, target: { nodeId: 'join', port: 'yes' } },
      { id: 'e7', source: { nodeId: 'on-no', port: 'text' }, target: { nodeId: 'join', port: 'no' } },
      { id: 'e8', source: { nodeId: 'join', port: 'value' }, target: { nodeId: 'out', port: 'value' } },
    ],
    after: [],
  };
}

async function runWith(api, workflow, extra = {}) {
  const saved = await api.save(workflow);
  return api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID(), ...extra });
}
const state = (snapshot, id) => snapshot.instances.find(item => item.nodeInstanceId === id)?.state;
const outputText = async (api, snapshot, id, port) => {
  const manifest = await api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);
  return api.artifactText(manifest.values[port].artifact.artifactId);
};
const outputJson = async (api, snapshot, id, port) => JSON.parse(await outputText(api, snapshot, id, port));

test('decision fixtures: Route case selection and selected-Merge joins', () => {
  for (const item of decisions.routeSelection) {
    const result = routeCase(item.cases.map((equals, index) => ({ id: `c${index}`, equals })), item.selector);
    const expected = item.expected === 'contract_error' ? { error: 'contract' } : item.expected === 'unmatched' ? { caseId: null } : { caseId: `c${item.cases.indexOf(item.expected)}` };
    assert.deepEqual(result, expected, item.id);
  }
  assert.equal(selectedOutcome(['succeeded', 'inactive']), 'commit');
  assert.equal(selectedOutcome(['inactive', 'inactive']), 'inactive');
  assert.equal(selectedOutcome(['succeeded', 'succeeded']), 'contract_error');
  assert.equal(selectedOutcome(['pending', 'inactive']), 'wait');
  assert.equal(selectedOutcome(['failed', 'inactive']), 'recovery');
});

test('a Live Cache is pinned, a Frozen Cache cuts its producer, and refresh replaces the pin', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const live = await runWith(api, cacheWorkflow());
    assert.equal(live.status, 202, JSON.stringify(live.body));
    const first = await api.waitFor(live.body.run.runId, terminal);
    assert.equal(first.run.state, 'succeeded');
    const pinned = await api.call('PUT', '/api/v2/workflows/cache-flow/cache-pins/checkpoint', { runId: first.run.runId, nodeInstanceId: 'checkpoint' });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.equal(pinned.body.pins[0].sourceRunId, first.run.runId);
    assert.equal(pinned.body.pins[0].sourceChanged, false);

    const frozen = await runWith(api, cacheWorkflow({ mode: 'frozen' }));
    assert.equal(frozen.status, 202, JSON.stringify(frozen.body));
    const second = await api.waitFor(frozen.body.run.runId, terminal);
    assert.equal(second.run.state, 'succeeded');
    assert.equal(state(second, 'research'), undefined, 'the frozen producer is not planned');
    assert.equal(await outputText(api, second, 'checkpoint', 'value'), await outputText(api, first, 'checkpoint', 'value'));
    const events = await api.events(second.run.runId);
    assert.ok(events.some(event => event.type === 'cache.reused' && event.payload.sourceRunId === first.run.runId));
    assert.ok(events.some(event => event.type === 'run.planned'));

    // Changing the producer marks the pin stale; nothing is replaced automatically.
    await api.save(cacheWorkflow({ mode: 'frozen', researchModel: 'fixture-noisy' }));
    const stale = await api.call('GET', '/api/v2/workflows/cache-flow/cache-pins');
    assert.equal(stale.body.pins[0].sourceChanged, true);
    assert.equal(stale.body.pins[0].sourceRunId, first.run.runId);

    const refresh = await runWith(api, cacheWorkflow({ mode: 'frozen', researchModel: 'fixture-noisy' }), { refreshCaches: ['checkpoint'] });
    assert.equal(refresh.status, 202, JSON.stringify(refresh.body));
    const third = await api.waitFor(refresh.body.run.runId, terminal);
    assert.equal(third.run.state, 'succeeded');
    assert.equal(state(third, 'research'), 'succeeded');
    assert.ok((await api.events(third.run.runId)).some(event => event.type === 'cache.pinned'));
    const after = await api.call('GET', '/api/v2/workflows/cache-flow/cache-pins');
    assert.equal(after.body.pins[0].sourceRunId, third.run.runId);
    assert.equal(after.body.pins[0].sourceChanged, false);

    const bad = await runWith(api, cacheWorkflow({ mode: 'frozen' }), { refreshCaches: ['research'] });
    assert.equal(bad.status, 422);
  } finally { await api.close(); }
});

function loopCache(mode) {
  return {
    schemaVersion: 1, workflowId: 'loop-cache', capabilities: ['core-v1', 'loops-v1', 'cache-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'topic', type: 'text', config: { value: 'Cache topic' } },
      { id: 'repeat', type: 'loop', config: { valueType: 'Text', fixedInputs: [], limits: { maxIterations: 3, maxActiveMinutes: 10 }, body: {
        nodes: [
          { id: 'research', type: 'agent', config: { provider: 'codex', model: 'fixture-echo', timeoutSeconds: 60, output: { format: 'text' } } },
          { id: 'memo', type: 'cache', config: { valueType: 'Text', mode } },
          { id: 'counter', type: 'merge', config: { mode: 'record', inputs: [{ id: 'iteration', type: 'JsonValue' }], fields: [{ name: 'i', source: { input: 'iteration' } }] } },
          { id: 'enough', type: 'condition', config: { doneWhen: { pointer: '/i', op: 'equals', value: 2 }, reason: { literal: 'Two passes.' }, feedback: { literal: 'Again.' } } },
        ],
        edges: [
          { id: 'b1', source: { nodeId: '$input', port: 'value' }, target: { nodeId: 'research', port: 'prompt' } },
          { id: 'b2', source: { nodeId: 'research', port: 'text' }, target: { nodeId: 'memo', port: 'value' } },
          { id: 'b3', source: { nodeId: '$input', port: 'iteration' }, target: { nodeId: 'counter', port: 'iteration' } },
          { id: 'b4', source: { nodeId: 'counter', port: 'value' }, target: { nodeId: 'enough', port: 'value' } },
          { id: 'b5', source: { nodeId: 'memo', port: 'value' }, target: { nodeId: '$return', port: 'candidate' } },
          { id: 'b6', source: { nodeId: 'enough', port: 'decision' }, target: { nodeId: '$return', port: 'decision' } },
        ],
        after: [],
      } } },
      { id: 'out', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'topic', port: 'text' }, target: { nodeId: 'repeat', port: 'seed' } },
      { id: 'e2', source: { nodeId: 'repeat', port: 'result' }, target: { nodeId: 'out', port: 'value' } },
    ],
    after: [],
  };
}

test('a Cache inside a loop: refresh pins after a successful pass, Frozen supplies the same value each iteration', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const refresh = await runWith(api, loopCache('frozen'), { refreshCaches: ['memo'] });
    assert.equal(refresh.status, 202, JSON.stringify(refresh.body));
    const first = await api.waitFor(refresh.body.run.runId, terminal);
    assert.equal(first.run.state, 'succeeded');
    assert.equal(state(first, 'repeat/2/research'), 'succeeded');
    const pins = (await api.call('GET', '/api/v2/workflows/loop-cache/cache-pins')).body.pins;
    assert.equal(pins[0].sourceRunId, first.run.runId);
    const pinned = await api.artifactText(pins[0].value.artifact.artifactId);

    const frozen = await api.waitFor((await runWith(api, loopCache('frozen'))).body.run.runId, terminal);
    assert.equal(frozen.run.state, 'succeeded');
    assert.ok(!frozen.instances.some(item => item.nodeId === 'research'), 'the frozen producer is cut in every iteration');
    assert.equal(await outputText(api, frozen, 'repeat/1/memo', 'value'), pinned);
    assert.equal(await outputText(api, frozen, 'repeat/2/memo', 'value'), pinned);
    assert.equal(await outputText(api, frozen, 'repeat', 'result'), pinned);
  } finally { await api.close(); }
});

test('a Frozen Cache keeps its After prerequisites', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = cacheWorkflow();
    workflow.nodes.push({ id: 'warmup', type: 'text', config: { value: 'warm' } });
    workflow.after.push({ before: 'warmup', after: 'checkpoint' });
    const live = await api.waitFor((await runWith(api, workflow)).body.run.runId, terminal);
    await api.call('PUT', '/api/v2/workflows/cache-flow/cache-pins/checkpoint', { runId: live.run.runId, nodeInstanceId: 'checkpoint' });
    workflow.nodes.find(node => node.id === 'checkpoint').config.mode = 'frozen';
    const frozen = await api.waitFor((await runWith(api, workflow)).body.run.runId, terminal);
    assert.equal(frozen.run.state, 'succeeded');
    assert.equal(state(frozen, 'warmup'), 'succeeded');
    assert.equal(state(frozen, 'research'), undefined);
  } finally { await api.close(); }
});

test('a Frozen Cache without a pin rejects run creation', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const result = await runWith(api, cacheWorkflow({ mode: 'frozen' }));
    assert.equal(result.status, 422);
    assert.match(result.body.message, /no pin/);
  } finally { await api.close(); }
});

test('Run Branch plans only the target and its producers; Run Node reuses current inputs and rejects stale ones', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const branch = await runWith(api, cacheWorkflow(), { mode: 'branch', targets: ['research'] });
    assert.equal(branch.status, 202, JSON.stringify(branch.body));
    const one = await api.waitFor(branch.body.run.runId, terminal);
    assert.equal(one.run.state, 'succeeded');
    assert.deepEqual(one.instances.map(item => item.nodeInstanceId).sort(), ['question', 'research']);

    const full = await api.waitFor((await runWith(api, cacheWorkflow())).body.run.runId, terminal);
    assert.equal(full.run.state, 'succeeded');

    const node = await runWith(api, cacheWorkflow(), { mode: 'node', targets: ['review'] });
    assert.equal(node.status, 202, JSON.stringify(node.body));
    const reused = await api.waitFor(node.body.run.runId, terminal);
    assert.equal(reused.run.state, 'succeeded');
    assert.equal(state(reused, 'review-prompt'), 'reused');
    assert.equal(state(reused, 'review'), 'succeeded');
    assert.equal(state(reused, 'research'), undefined);
    const reuseEvent = (await api.events(reused.run.runId)).find(event => event.type === 'attempt.reused');
    assert.equal(reuseEvent.payload.sourceRunId, full.run.runId);

    // An edited upstream definition makes the recorded input stale.
    const stale = await runWith(api, cacheWorkflow({ researchModel: 'fixture-noisy' }), { mode: 'node', targets: ['review'] });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.details[0].path, '/nodes/review-prompt');
  } finally { await api.close(); }
});

test('Run Node rejects a fresh Context that would stand in for an unplanned writer', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = await contextChain();
    const full = await api.waitFor((await runWith(api, workflow)).body.run.runId, terminal);
    assert.equal(full.run.state, 'succeeded');
    const node = await runWith(api, workflow, { mode: 'node', targets: ['revise'] });
    assert.equal(node.status, 422);
    assert.equal(node.body.code, 'context_prerequisite');
  } finally { await api.close(); }
});

test('manual chat continues a ready binding as a chat run hidden from workflow lists', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const first = await api.waitFor((await api.run(singleAgent())).body.run.runId, terminal);
    assert.equal(first.run.state, 'succeeded');
    const bindingId = first.contexts[0].bindingId;
    const chat = await api.call('POST', `/api/v2/context-bindings/${bindingId}/messages`, { requestId: randomUUID(), workspaceId: 'main', model: 'fixture-echo', effort: 'xhigh', prompt: 'And now?' });
    assert.equal(chat.status, 202, JSON.stringify(chat.body));
    assert.equal(chat.body.run.kind, 'chat');
    const turn = await api.waitFor(chat.body.run.runId, terminal);
    assert.equal(turn.run.state, 'succeeded');
    const invocationEvent = (await api.events(turn.run.runId)).find(item => item.type === 'attempt.invocation_committed');
    assert.equal((await api.artifactJson(invocationEvent.payload.manifest.artifactId)).requestedEffort, 'xhigh');
    assert.match(await outputText(api, turn, 'reply', 'text'), /turn 2: And now\?/);
    const transcript = await api.call('GET', `/api/v2/runs?kind=chat&bindingId=${bindingId}`);
    assert.equal(transcript.body.items.length, 1);
    const workflows = await api.call('GET', '/api/v2/workflows');
    assert.ok(!workflows.body.items.some(item => item.workflowId === 'context-chat'));
    const reserved = await api.call('PUT', '/api/v3/workflows/context-chat', {
      requestId: randomUUID(), expectedEtag: null, workflow: { ...singleAgent(), workflowId: 'context-chat' },
    }, { headers: { 'If-None-Match': '*' } });
    assert.equal(reserved.status, 410);
    assert.equal(reserved.body.code, 'api_upgrade_required');
    const unknown = await api.call('POST', `/api/v2/context-bindings/${randomUUID()}/messages`, { requestId: randomUUID(), workspaceId: 'main', model: 'fixture-echo', prompt: 'x' });
    assert.equal(unknown.status, 404);
  } finally { await api.close(); }
});

test('a Route activates one case, skips the other branch, and a selected Merge joins it', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await runWith(api, routeFlow('no'));
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const done = await api.waitFor(created.body.run.runId, terminal);
    assert.equal(done.run.state, 'succeeded');
    assert.equal(state(done, 'on-yes'), 'skipped');
    assert.equal(state(done, 'on-no'), 'succeeded');
    assert.equal(await outputText(api, done, 'join', 'value'), 'NO: payload text');
    const routed = (await api.events(done.run.runId)).find(event => event.type === 'route.selected');
    assert.equal(routed.payload.caseId, 'no');

    const unmatched = await api.waitFor((await runWith(api, routeFlow('maybe'))).body.run.runId, terminal);
    assert.equal(unmatched.run.state, 'waiting_for_user');
    const error = (await (async () => { await api.closeRun(unmatched.run.runId); return api.events(unmatched.run.runId); })()).find(event => event.type === 'attempt.error');
    assert.equal(error.payload.code, 'route_unmatched');
  } finally { await api.close(); }
});

test('the specification loop: reviewers request changes, the analyst revises, the gate opens and the next pass is verified', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await runWith(api, specificationLoop());
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const done = await api.waitFor(created.body.run.runId, terminal, 90_000);
    assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => item.state !== 'succeeded')));
    const loop = id => done.loops.find(item => item.loopNodeId === id);
    assert.equal(loop('delivery').iteration, 2);
    assert.equal(loop('delivery/1/specification').iteration, 2);
    assert.equal(loop('delivery/1/specification').state, 'finished');
    assert.equal(state(done, 'delivery/2/specification'), 'skipped');
    assert.equal(state(done, 'delivery/1/spec-route'), 'succeeded');
    assert.equal(state(done, 'delivery/1/specification/1/analyst'), 'succeeded');
    assert.equal(state(done, 'delivery/1/specification/2/analyst'), 'succeeded');

    const events = await api.events(done.run.runId);
    const gates = events.filter(event => event.type === 'gate.evaluated').map(event => `${event.payload.mode}:${event.payload.status}`);
    assert.deepEqual(gates.filter(item => !item.startsWith('prepare')), ['verify:REVISION_REQUIRED', 'evaluate:REVISION_REQUIRED', 'evaluate:OPEN', 'verify:OPEN']);
    const routes = events.filter(event => event.type === 'route.selected').map(event => event.payload.caseId);
    assert.deepEqual(routes, ['revise', 'approved']);

    const approval = await outputJson(api, done, 'approval', 'value');
    assert.match(approval.recordId, /^CERT-[A-F0-9]{12}$/);
    const certificate = await api.artifactJson(approval.artifact.artifactId);
    assert.equal(certificate.reviews.length, 3);
    const first = await outputJson(api, done, 'delivery/1/specification/1/evaluate', 'report');
    assert.equal(first.status, 'REVISION_REQUIRED');
    assert.equal(first.issues.length, 3);
    assert.ok(first.issues.every(issue => /^ISS-[A-Z]+-[A-F0-9]{10}$/.test(issue.id)));
    const second = await outputJson(api, done, 'delivery/1/specification/2/evaluate', 'report');
    assert.equal(second.status, 'OPEN');
    assert.deepEqual(second.issues, []);

    // The public customer view excludes internal contracts.
    const view = await api.artifactJson((await api.artifactJson(done.instances.find(item => item.nodeInstanceId === 'delivery/1/specification/1/prepare').outputs.artifactId)).values.customer.artifact.artifactId);
    assert.deepEqual(view.entries.map(entry => entry.path).sort(), ['SPEC.public.md', 'SUBJECT.json', 'spec-index.public.json']);
  } finally { await api.close(); }
});

test('the gate rejects a review for the wrong role and a bundle whose index does not match its headings', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const wrong = await api.waitFor((await runWith(api, specificationLoop({ readiness: 'fixture-reviewer-wrong-role-1' }))).body.run.runId, terminal, 60_000);
    assert.equal(wrong.run.state, 'waiting_for_user');
    assert.equal(state(wrong, 'delivery/1/specification/1/evaluate'), 'failed');
    await api.closeRun(wrong.run.runId);
    assert.match((await api.events(wrong.run.runId)).find(event => event.type === 'attempt.error').payload.message, /role is "someone-else"/);

    const bad = await api.waitFor((await runWith(api, specificationLoop({ analyst: 'fixture-analyst-bad' }))).body.run.runId, terminal, 60_000);
    assert.equal(bad.run.state, 'waiting_for_user');
    assert.equal(state(bad, 'delivery/1/specification/1/prepare'), 'failed');
    assert.equal(bad.loops.find(item => item.loopNodeId === 'delivery/1/specification').pauseReason, 'body_failure');
    await api.closeRun(bad.run.runId);
    assert.match((await api.events(bad.run.runId)).find(event => event.type === 'attempt.error').payload.message, /CONTRACT-MISSING/);
  } finally { await api.close(); }
});

test('a scoped Stop pauses a nested loop, active time counts for both loops, and root Stop cascades', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await runWith(api, specificationLoop({ analyst: 'fixture-analyst-slow' }));
    const runId = created.body.run.runId;
    await api.waitFor(runId, (run, snapshot) => snapshot.instances.some(item => item.nodeInstanceId === 'delivery/1/specification/1/analyst' && item.state === 'running'));
    await new Promise(done => setTimeout(done, 500));
    const stop = await api.call('POST', `/api/v2/runs/${runId}/nodes/${encodeURIComponent('delivery/1/specification')}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, JSON.stringify(stop.body));
    const paused = await api.waitFor(runId, terminal);
    assert.equal(paused.run.state, 'waiting_for_user');
    const loop = id => paused.loops.find(item => item.loopNodeId === id);
    assert.equal(loop('delivery/1/specification').pauseReason, 'stopped');
    assert.equal(loop('delivery').state, 'running');
    assert.ok(loop('delivery/1/specification').activeMs > 0);
    assert.ok(loop('delivery').activeMs >= loop('delivery/1/specification').activeMs);
    assert.equal(state(paused, 'delivery/1/specification/1/analyst'), 'canceled');
    const root = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(root.status, 202);
    const canceled = await api.waitFor(runId, terminal);
    assert.equal(canceled.run.state, 'canceled');
    assert.ok(canceled.loops.every(item => item.state === 'canceled'), JSON.stringify(canceled.loops));
  } finally { await api.close(); }
});

const claimRef = store => (({ artifactId, sha256 }) => ({ artifactId, sha256 }))(store.putJson({ review: true }));

test('verify never accepts a certificate the engine did not issue or one for another subject', () => {
  const root = join(resolve(import.meta.dirname, '../../.deszo/tests'), `gate-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new Store(root);
  try {
    const helpers = valueHelpers(store);
    const entry = (path, text) => { const artifact = store.putBytes(Buffer.from(text), 'text/plain'); return { path, artifact: { artifactId: artifact.artifactId, sha256: artifact.sha256 }, byteSize: Buffer.byteLength(text), mediaType: 'text/plain' }; };
    const subject = helpers.putSet([entry('SPEC.md', '## A\n')]);
    const other = helpers.putSet([entry('SPEC.md', '## B\n')]);
    const config = { mode: 'verify', policy: { slots: [{ id: 'customer', role: 'customer', view: 'public' }] } };
    const certificate = gate.certificateFor({ plan: { subjectId: gate.subjectIdOf(subject.artifact.sha256), subject: subject.artifact, policyFingerprint: gate.policyFingerprint(config.policy) },
      reviewRefs: [{ recordId: 'REV-000000000000', artifact: claimRef(store) }], runId: randomUUID(), now: new Date().toISOString() });
    const stored = store.putJson(certificate);
    const claim = { recordId: certificate.recordId, artifact: { artifactId: stored.artifactId, sha256: stored.sha256 } };
    const asJson = value => ({ type: 'JsonValue', artifact: (({ artifactId, sha256 }) => ({ artifactId, sha256 }))(store.putJson(value)) });
    const issued = id => id === certificate.recordId ? { kind: 'GateCertificate', artifact_id: stored.artifactId } : null;
    assert.equal(gate.verify({ store, config, inputs: { subject, certificate: asJson(claim) }, lookupRecord: issued }).status, 'OPEN');
    assert.equal(gate.verify({ store, config, inputs: { subject, certificate: asJson(claim) }, lookupRecord: () => null }).status, 'REVISION_REQUIRED');
    assert.match(gate.verify({ store, config, inputs: { subject: other, certificate: asJson(claim) }, lookupRecord: issued }).reason, /not the current subject/);
    assert.equal(gate.verify({ store, config, inputs: { subject, certificate: asJson(null) }, lookupRecord: issued }).status, 'REVISION_REQUIRED');
    const policy = { ...config, policy: { slots: [...config.policy.slots, { id: 'readiness', role: 'implementation-readiness', view: 'full' }] } };
    assert.match(gate.verify({ store, config: policy, inputs: { subject, certificate: asJson(claim) }, lookupRecord: issued }).reason, /different review policy/);
  } finally { store.close(); }
});
