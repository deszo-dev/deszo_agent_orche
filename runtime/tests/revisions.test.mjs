import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { carryDecision } from '../core/map.mjs';
import { project } from '../../shared/replay.mjs';
import { startTestRunner } from './helpers.mjs';
import { ownedPath } from './test-roots.mjs';

const docs = resolve(import.meta.dirname, '../../docs');
const read = path => readFileSync(join(docs, path), 'utf8');
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const SLOTS = [{ id: 'customer', role: 'customer', view: 'public', provider: 'codex' }, { id: 'readiness', role: 'implementation-readiness', view: 'full', provider: 'claude' }];
const POLICY = { slots: SLOTS.map(({ provider, ...slot }) => slot) };
const ROLES = [
  { id: 'implementer', kind: 'agent', provider: 'claude', model: 'fixture-implementer', instructions: 'Implement the task exactly.', timeoutSeconds: 60, context: 'task' },
  { id: 'test-author', kind: 'agent', provider: 'antigravity', model: 'fixture-test-author', instructions: 'Write the tests.', timeoutSeconds: 60, context: 'task' },
  { id: 'reviewer', kind: 'agent', provider: 'codex', model: 'fixture-task-reviewer', instructions: 'Review the captured snapshot.', timeoutSeconds: 60, context: 'task' },
  { id: 'analyst', kind: 'agent', provider: 'codex', model: 'fixture-triage', instructions: 'Triage failed verification.', timeoutSeconds: 60, context: { contextId: 'analyst-history' } },
  { id: 'verification', kind: 'utility', template: 'verification', embeddedRoles: { triage: 'analyst' } },
];

// Selective documentation review (per-slot Routes and selected joins) feeding a revision-aware Map.
function selectiveWorkflow({ id = 'selective', prior = null, issues = [], customerText = 'Review the public business view as the Customer.', instructions = 'Review policy A.', nativeConfiguration = 'restricted', roles = ROLES } = {}) {
  const nodes = [], edges = [];
  const edge = (from, fromPort, to, toPort) => edges.push({ id: `${from}-${fromPort}-${to}-${toPort}`.slice(0, 64), source: { nodeId: from, port: fromPort }, target: { nodeId: to, port: toPort } });
  nodes.push(
    { id: 'docs', type: 'file-input', config: { mode: 'files', paths: ['SPEC.md', 'spec-index.json', 'implementation-map.json'] } },
    { id: 'project', type: 'file-input', config: { mode: 'files', paths: ['src/api.mjs', 'fixtures/tokens.json'] } },
    { id: 'seed', type: 'merge', config: { mode: 'record', inputs: [], fields: [{ name: 'issues', source: { literal: issues } }, { name: 'none', source: { literal: null } }] } },
    { id: 'issue-list', type: 'json-select', config: { pointer: '/issues', outputType: 'JsonValue' } },
    { id: 'prepare', type: 'gate', config: { mode: 'prepare', policy: POLICY, carry: true } },
    { id: 'plan-text', type: 'json-select', config: { pointer: '', outputType: 'Text', render: 'canonical-json' } },
    { id: 'evaluate', type: 'gate', config: { mode: 'evaluate', policy: POLICY } },
    { id: 'analyst-history', type: 'context', config: { provider: 'codex', mode: 'new' } },
    { id: 'implement', type: 'map', config: { approvalPolicy: POLICY, optionalInputs: ['prior-state'], limits: { maxFailedVerificationCycles: 3, maxTaskAttempts: 3 }, roles, carryAcrossRevisions: true } },
    { id: 'summary', type: 'result-viewer', config: {} },
    { id: 'policy-text', type: 'text', config: { value: instructions } },
  );
  edge('seed', 'value', 'issue-list', 'value'); edge('docs', 'value', 'prepare', 'subject'); edge('issue-list', 'value', 'prepare', 'issues'); edge('prepare', 'plan', 'plan-text', 'value');
  if (prior) {
    nodes.push({ id: 'prior-certificate', type: 'file-input', config: { mode: 'artifact', valueType: 'JsonValue', artifact: prior.certificate } },
      { id: 'prior-summary', type: 'file-input', config: { mode: 'artifact', valueType: 'JsonValue', artifact: prior.summary } },
      { id: 'prior-state', type: 'json-select', config: { pointer: '/state', outputType: 'JsonValue' } });
    edge('prior-certificate', 'value', 'prepare', 'prior'); edge('prior-summary', 'value', 'prior-state', 'value'); edge('prior-state', 'value', 'implement', 'prior-state');
  } else {
    nodes.push({ id: 'no-prior', type: 'json-select', config: { pointer: '/none', outputType: 'JsonValue' } }, { id: 'no-state', type: 'json-select', config: { pointer: '/none', outputType: 'JsonValue' } });
    edge('seed', 'value', 'no-prior', 'value'); edge('no-prior', 'value', 'prepare', 'prior'); edge('seed', 'value', 'no-state', 'value'); edge('no-state', 'value', 'implement', 'prior-state');
  }
  for (const slot of SLOTS) {
    const s = slot.id;
    const text = s === 'customer' ? customerText : 'Review the full bundle for implementation readiness.';
    nodes.push(
      { id: `${s}-route`, type: 'route', config: { valueType: 'JsonValue', selector: '/needsReview', cases: [{ id: 'live', equals: true }, { id: 'carried', equals: false }], onUnmatched: 'error' } },
      { id: `${s}-need-text`, type: 'json-select', config: { pointer: '/status', outputType: 'Text', render: 'raw-string' } },
      { id: `${s}-prompt`, type: 'prompt-template', config: { template: `${text} {{policy}}\n\nReview plan (JSON):\n{{plan}}\n\nStatus: {{status}}\nReturn a ReviewDecision.`, slots: [{ id: 'policy' }, { id: 'plan' }, { id: 'status' }] } },
      { id: `${s}-review`, type: 'agent', config: { provider: slot.provider, model: 'fixture-reviewer-approve-1', timeoutSeconds: 60, output: { format: 'json' }, attachFiles: true } },
      { id: `${s}-carry`, type: 'json-select', config: { pointer: '/carry', outputType: 'JsonValue' } },
      { id: `${s}-decision`, type: 'merge', config: { mode: 'selected', valueType: 'JsonValue', inputs: [{ id: 'live' }, { id: 'carried' }] } },
    );
    edge('prepare', `${s}-need`, `${s}-route`, 'selector'); edge('prepare', `${s}-need`, `${s}-route`, 'value');
    edge('policy-text', 'text', `${s}-prompt`, 'policy');
    edge(`${s}-route`, 'live', `${s}-need-text`, 'value'); edge('plan-text', 'value', `${s}-prompt`, 'plan'); edge(`${s}-need-text`, 'value', `${s}-prompt`, 'status');
    edge(`${s}-prompt`, 'text', `${s}-review`, 'prompt'); edge('prepare', s, `${s}-review`, 'files');
    edge(`${s}-route`, 'carried', `${s}-carry`, 'value');
    edge(`${s}-review`, 'json', `${s}-decision`, 'live'); edge(`${s}-carry`, 'value', `${s}-decision`, 'carried');
    edge(`${s}-decision`, 'value', 'evaluate', s);
  }
  edge('prepare', 'subject', 'evaluate', 'subject'); edge('prepare', 'plan', 'evaluate', 'plan');
  edge('prepare', 'subject', 'implement', 'documentation'); edge('evaluate', 'certificate', 'implement', 'approval'); edge('project', 'value', 'implement', 'base');
  edge('implement', 'summary', 'summary', 'value');
  return { schemaVersion: 1, workflowId: id, capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1'], settings: { nativeConfiguration }, nodes, edges, after: [] };
}

function writeProject(cwd, { contractResume = null, contractAuth = null } = {}) {
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  let spec = read('examples/round-recovery/SPEC.md').replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n');
  if (contractResume) spec = spec.replace('## CONTRACT-RESUME\n', `## CONTRACT-RESUME\n\n${contractResume}\n`);
  if (contractAuth) spec = spec.replace('## CONTRACT-AUTH\n', `## CONTRACT-AUTH\n\n${contractAuth}\n`);
  put('SPEC.md', spec);
  put('spec-index.json', read('examples/round-recovery/spec-index.json'));
  put('implementation-map.json', read('examples/round-recovery/implementation-map.json'));
  put('src/api.mjs', read('examples/round-recovery/project/src/api.mjs'));
  put('fixtures/tokens.json', read('examples/round-recovery/project/fixtures/tokens.json'));
}

async function run(api, workflow) {
  const saved = await api.save(workflow);
  const created = await api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const done = await api.waitFor(created.body.run.runId, terminal, 180_000);
  assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => !['succeeded', 'skipped'].includes(item.state))));
  return done;
}
const outputs = async (api, snapshot, id) => api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);
const priorOf = async (api, snapshot) => ({ certificate: (await outputs(api, snapshot, 'evaluate')).values.certificate.artifact, summary: (await outputs(api, snapshot, 'implement')).values.summary.artifact });
const state = (snapshot, id) => snapshot.instances.find(item => item.nodeInstanceId === id)?.state;
const navigator = async (api, runId) => (await api.call('GET', `/api/v2/runs/${runId}/maps/implement`)).body;
const task = (nav, id) => nav.tasks.find(item => item.taskId === id);

test('carry decisions fail closed: an unknown closure never carries across revisions, and dependencies must carry first', () => {
  const map = JSON.parse(read('examples/round-recovery/implementation-map.json'));
  const fingerprints = Object.fromEntries(map.tasks.map(item => [item.id, 'a'.repeat(64)]));
  const accepted = (taskId, fingerprint) => ({ taskId, state: 'accepted', selectedResult: { recordId: `RES-${taskId.length}`, artifact: {} }, attempts: 1, ...(fingerprint ? { fingerprint } : {}) });
  const legacy = { tasks: map.tasks.map(item => accepted(item.id)) };
  assert.equal(carryDecision({ map, prior: legacy, fingerprints, crossRevision: true }).size, 0);
  assert.equal(carryDecision({ map, prior: legacy, fingerprints, crossRevision: false }).size, 5, 'same-subject M5 states keep their behavior');
  const changedAuth = { tasks: map.tasks.map(item => accepted(item.id, item.id === 'TASK-AUTH-CODE' ? 'b'.repeat(64) : 'a'.repeat(64))) };
  const carried = carryDecision({ map, prior: changedAuth, fingerprints, crossRevision: true });
  assert.deepEqual([...carried.keys()].sort(), ['TASK-AUTH-TESTS', 'TASK-RESUME-CODE', 'TASK-RESUME-TESTS'], 'TASK-VERIFY needs every dependency carried');
});

test('evaluate refuses a carry request that prepare did not plan', async () => {
  const { Store } = await import('../core/store.mjs');
  const { values: valueHelpers } = await import('../core/utilities.mjs');
  const gate = await import('../core/gate.mjs');
  const root = ownedPath(join(resolve(import.meta.dirname, '../../.deszo/tests'), `carry-${randomUUID()}`));
  mkdirSync(root, { recursive: true });
  const store = new Store(root);
  try {
    const { putSet } = valueHelpers(store);
    const file = (path, text) => { const artifact = store.putBytes(Buffer.from(text), 'text/plain'); return { path, artifact: { artifactId: artifact.artifactId, sha256: artifact.sha256 }, byteSize: Buffer.byteLength(text), mediaType: 'text/plain' }; };
    const index = { schemaVersion: 1, document: 'SPEC.md', sections: [{ id: 'BUS-X', kind: 'business', normative: true, visibility: 'public', dependsOn: [] }] };
    const subject = putSet([file('SPEC.md', '## BUS-X\nRevision 1.\n'), file('spec-index.json', JSON.stringify(index))]);
    const json = value => ({ type: 'JsonValue', artifact: (({ artifactId, sha256 }) => ({ artifactId, sha256 }))(store.putJson(value)) });
    const config = { mode: 'prepare', carry: true, policy: { slots: [{ id: 'customer', role: 'customer', view: 'public' }] } };
    const prepared = gate.prepare({ store, config, inputs: { subject, issues: json([]), prior: json(null) }, reviewerFingerprints: { customer: 'a'.repeat(64) }, readRecord: () => null });
    const need = store.readJson(prepared.outputs['customer-need'].artifact.artifactId);
    assert.equal(need.status, 'missing');
    assert.equal(need.needsReview, true);
    const forged = { schemaVersion: 1, kind: 'ReviewCarryRequest', slot: 'customer', subjectId: need.subjectId, scopeHash: need.scopeHash, priorReview: { recordId: 'REV-0123456789AB', artifact: { artifactId: randomUUID(), sha256: 'b'.repeat(64) } } };
    assert.throws(() => gate.evaluate({ store, config: { ...config, mode: 'evaluate' }, inputs: { subject, plan: prepared.outputs.plan, customer: json(forged) }, reviewers: {}, runId: randomUUID(), now: new Date().toISOString(), readRecord: () => null }),
      /did not plan a carried review/);
  } finally { store.close(); }
});

test('a changed internal contract: the Customer approval is carried with provenance, readiness re-reviews, and only independent tasks are carried', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const first = await run(api, selectiveWorkflow());
    assert.equal(state(first, 'customer-review'), 'succeeded');
    assert.equal(state(first, 'readiness-review'), 'succeeded');
    const plan1 = await api.artifactJson((await outputs(api, first, 'prepare')).values.plan.artifact.artifactId);
    assert.deepEqual(plan1.slots.map(slot => slot.status), ['missing', 'missing']);

    writeProject(workspace.cwd, { contractResume: 'Revision 2 adds an explicit duplicate-request rule for concurrent resumes.' });
    const second = await run(api, selectiveWorkflow({ id: 'selective-2', prior: await priorOf(api, first) }));
    assert.equal(state(second, 'customer-review'), 'skipped', 'the unchanged public scope skips the live Customer');
    assert.equal(state(second, 'readiness-review'), 'succeeded', 'the full scope changed and is re-reviewed');
    const plan2 = await api.artifactJson((await outputs(api, second, 'prepare')).values.plan.artifact.artifactId);
    assert.deepEqual(plan2.slots.map(slot => [slot.id, slot.status, slot.needsReview]), [['customer', 'carried', false], ['readiness', 'stale', true]]);
    assert.equal(plan2.slots[0].scopeHash, plan1.slots[0].scopeHash);
    assert.notEqual(plan2.slots[1].scopeHash, plan1.slots[1].scopeHash);

    const events = await api.events(second.run.runId);
    const carriedReview = events.find(event => event.type === 'gate.review_carried');
    assert.equal(carriedReview.payload.slot, 'customer');
    assert.equal(carriedReview.payload.priorSubjectId, plan1.subjectId);
    const certificate = await api.artifactJson((await api.artifactJson((await outputs(api, second, 'evaluate')).values.certificate.artifact.artifactId)).artifact.artifactId);
    assert.ok(certificate.reviews.some(item => /^RCAR-/.test(item.recordId)));
    const carry = await api.artifactJson(certificate.reviews.find(item => /^RCAR-/.test(item.recordId)).artifact.artifactId);
    assert.equal(carry.priorSubjectId, plan1.subjectId);
    assert.equal(carry.subjectId, plan2.subjectId);

    const nav = await navigator(api, second.run.runId);
    assert.equal(nav.generation, 2);
    assert.equal(nav.crossRevision, true);
    for (const id of ['TASK-AUTH-CODE', 'TASK-AUTH-TESTS']) {
      assert.equal(task(nav, id).carried, true, id);
      assert.equal(task(nav, id).attempts, 0, id);
      assert.match(task(nav, id).carriedFrom.carryRecordId, /^TCAR-/);
      assert.equal(task(nav, id).carriedFrom.subjectId, plan1.subjectId);
    }
    for (const id of ['TASK-RESUME-CODE', 'TASK-RESUME-TESTS', 'TASK-VERIFY']) assert.ok(!task(nav, id).carried && task(nav, id).attempts >= 1, id);
    const summary = await api.artifactJson((await outputs(api, second, 'implement')).values.summary.artifact.artifactId);
    assert.equal(summary.outcome, 'implementation_complete');
    assert.equal(summary.carries.length, 2);

    // Generation history: this run's execution and the prior-state lineage into the first run.
    const history = (await api.call('GET', `/api/v2/runs/${second.run.runId}/maps/implement/executions`)).body;
    assert.deepEqual(history.executions.map(item => [item.generation, item.runId === first.run.runId]), [[2, false], [1, true]]);
    const old = (await api.call('GET', `/api/v2/map-executions/${history.executions[1].mapExecutionId}`)).body;
    assert.equal(old.generation, 1);
    assert.ok(old.tasks.every(item => item.state === 'accepted' && item.results.some(result => result.status === 'accepted')));

    // Replay projects the generated Map scope step by step from the journal alone.
    const planned = events.findLastIndex(event => event.type === 'map.task_state_changed' && event.payload.from === null);
    const early = project(events, planned);
    const map = [...early.maps.values()][0];
    assert.equal(map.generation, 2);
    assert.equal(map.tasks.get('TASK-AUTH-CODE').state, 'accepted');
    assert.equal(map.tasks.get('TASK-VERIFY').state, 'waiting');
    const final = [...project(events, events.length - 1).maps.values()][0];
    assert.equal(final.state, 'implementation_complete');
    assert.ok(final.records.some(item => item.kind === 'TaskCarry'));
  } finally { await api.close(); }
});

test('the documented selective-delivery example runs its first revision with every reviewer live', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const workflow = JSON.parse(read('examples/m6-selective-delivery/workflow.json'));
    const models = { implementer: 'fixture-implementer', 'test-author': 'fixture-test-author', reviewer: 'fixture-task-reviewer', analyst: 'fixture-triage' };
    for (const node of workflow.nodes) {
      if (node.type === 'agent') node.config.model = 'fixture-reviewer-approve-1';
      if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') role.model = models[role.id];
    }
    const done = await run(api, workflow);
    for (const slot of ['customer', 'readiness', 'testability']) { assert.equal(state(done, `${slot}-review`), 'succeeded'); assert.equal(state(done, `${slot}-carry`), 'skipped'); }
    assert.equal(state(done, 'candidate-view'), 'succeeded');
    assert.equal(state(done, 'revision-view'), 'skipped');
  } finally { await api.close(); }
});

test('a changed auth contract invalidates every dependent scope; an edited reviewer prompt makes its approval stale', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const first = await run(api, selectiveWorkflow());
    writeProject(workspace.cwd, { contractAuth: 'Revision 2 states that tokens are compared in constant time.' });
    const second = await run(api, selectiveWorkflow({ id: 'auth-change', prior: await priorOf(api, first), customerText: 'Review the public business view as the Customer, focusing on reconnect.' }));
    assert.equal(state(second, 'customer-review'), 'succeeded', 'a changed reviewer prompt cannot carry the old approval');
    const plan = await api.artifactJson((await outputs(api, second, 'prepare')).values.plan.artifact.artifactId);
    assert.equal(plan.slots[0].status, 'stale');
    const nav = await navigator(api, second.run.runId);
    assert.ok(nav.tasks.every(item => !item.carried), JSON.stringify(nav.tasks.map(item => [item.taskId, item.carried])));
  } finally { await api.close(); }
});

test('R1: instructions changed through a template slot, or a changed native profile, invalidate carried approvals and tasks', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    // Antigravity cannot inherit native configuration, so this exercise gives every role to Codex/Claude.
    const roles = ROLES.map(role => role.id === 'test-author' ? { ...role, provider: 'claude' } : role);
    const first = await run(api, selectiveWorkflow({ roles }));
    writeProject(workspace.cwd, { contractResume: 'Revision 2 clarifies concurrency.' });
    const prior = await priorOf(api, first);
    const instructions = await run(api, selectiveWorkflow({ id: 'policy-b', prior, roles, instructions: 'Review policy B: reject this specification.' }));
    assert.equal(state(instructions, 'customer-review'), 'succeeded', 'changed upstream instructions force a live review');
    const native = await run(api, selectiveWorkflow({ id: 'inherit', prior, roles, nativeConfiguration: 'inherit' }));
    assert.equal(state(native, 'customer-review'), 'succeeded', 'a changed native profile forces a live review');
    assert.ok((await navigator(api, native.run.runId)).tasks.every(item => !item.carried), 'no task carries under another native profile');
    const same = await run(api, selectiveWorkflow({ id: 'policy-a', prior, roles }));
    assert.equal(state(same, 'customer-review'), 'skipped', 'unchanged instructions still carry');
    assert.ok((await navigator(api, same.run.runId)).tasks.some(item => item.carried), 'and the same profile still carries tasks');
  } finally { await api.close(); }
});

test('changing reviewer and Map role effort invalidates carried approvals and task selections', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const first = await run(api, selectiveWorkflow());
    writeProject(workspace.cwd, { contractResume: 'Revision 2 clarifies concurrency.' });
    const roles = ROLES.map(role => role.kind === 'agent' ? { ...role, effort: 'high' } : role);
    const workflow = selectiveWorkflow({ id: 'changed-effort', prior: await priorOf(api, first), roles });
    workflow.nodes.find(node => node.id === 'customer-review').config.effort = 'max';
    const second = await run(api, workflow);
    assert.equal(state(second, 'customer-review'), 'succeeded', 'the changed reviewer effort forces a live review');
    assert.ok((await navigator(api, second.run.runId)).tasks.every(item => !item.carried), 'changed role effort prevents task carry');
  } finally { await api.close(); }
});

test('an open blocker raised by a slot forces that reviewer to run live', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const first = await run(api, selectiveWorkflow());
    writeProject(workspace.cwd, { contractResume: 'Revision 2 clarifies concurrency.' });
    const issue = { id: 'ISS-CUSTOMER-0123456789', severity: 'blocker', ownerRole: 'analyst', requirementRefs: ['REQ-RESUME'], message: 'Clarify the resumed status.', requestedChange: 'State it.' };
    const second = await run(api, selectiveWorkflow({ id: 'blocked-carry', prior: await priorOf(api, first), issues: [issue] }));
    assert.equal(state(second, 'customer-review'), 'succeeded');
    const plan = await api.artifactJson((await outputs(api, second, 'prepare')).values.plan.artifact.artifactId);
    assert.equal(plan.slots[0].status, 'stale');
  } finally { await api.close(); }
});

test('a reviewer inspects immutable snapshot A while another task is still being produced', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const workflow = selectiveWorkflow({ id: 'snapshot-a' });
    workflow.nodes.find(node => node.id === 'implement').config.roles[0].model = 'fixture-implementer-slow';
    const done = await run(api, workflow);
    const events = await api.events(done.run.runId);
    const at = (instance, to) => events.find(event => event.type === 'attempt.state_changed' && event.nodeInstanceId === `implement/1/${instance}` && event.payload.to === to).sequence;
    assert.ok(at('task-auth-code-review-ac-auth-code', 'running') < at('task-resume-code-execute', 'succeeded'), 'review A ran while B was produced');
    const reviewInputs = events.find(event => event.type === 'attempt.invocation_committed' && event.nodeInstanceId === 'implement/1/task-auth-code-review-ac-auth-code');
    const executeInputs = events.find(event => event.type === 'attempt.invocation_committed' && event.nodeInstanceId === 'implement/1/task-auth-code-execute');
    const cwd = async event => (await api.artifactJson(event.payload.manifest.artifactId)).cwd;
    assert.notEqual(await cwd(reviewInputs), await cwd(executeInputs), 'the reviewer works on its own copy');
  } finally { await api.close(); }
});
