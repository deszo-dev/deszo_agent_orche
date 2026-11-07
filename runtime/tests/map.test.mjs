import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verificationStep } from '../core/map.mjs';
import { startTestRunner } from './helpers.mjs';

const docs = resolve(import.meta.dirname, '../../docs');
const read = path => readFileSync(join(docs, path), 'utf8');
const decisions = JSON.parse(read('fixtures/decisions.json'));
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const POLICY = { slots: [{ id: 'readiness', role: 'implementation-readiness', view: 'full' }] };

function roles({ implementer = 'fixture-implementer', triage = 'fixture-triage', reviewer = 'fixture-task-reviewer', instructions = 'Implement the task exactly.' } = {}) {
  return [
    { id: 'implementer', kind: 'agent', provider: 'claude', model: implementer, effort: 'xhigh', instructions, timeoutSeconds: 60, context: 'task' },
    { id: 'test-author', kind: 'agent', provider: 'antigravity', model: 'fixture-test-author', effort: 'high', instructions: 'Write the tests.', timeoutSeconds: 60, context: 'task' },
    { id: 'reviewer', kind: 'agent', provider: 'codex', model: reviewer, effort: 'medium', instructions: 'Review the captured snapshot.', timeoutSeconds: 60, context: 'task' },
    { id: 'analyst', kind: 'agent', provider: 'codex', model: triage, effort: 'max', instructions: 'Triage failed verification.', timeoutSeconds: 60, context: { contextId: 'analyst-history' } },
    { id: 'verification', kind: 'utility', template: 'verification', embeddedRoles: { triage: 'analyst' } },
  ];
}

// Approval chain (prepare → readiness review → evaluate) feeding one Implementation Map.
function deliveryWorkflow({ id = 'map-flow', limits = { maxFailedVerificationCycles: 3, maxTaskAttempts: 3 }, roleOptions, prior = null, repair = null, docsPaths = ['SPEC.md', 'spec-index.json', 'implementation-map.json'] } = {}) {
  const optional = [...(prior ? ['prior-state'] : []), ...(repair ? ['repair'] : [])];
  const nodes = [
    { id: 'docs', type: 'file-input', config: { mode: 'files', paths: docsPaths } },
    { id: 'project', type: 'file-input', config: { mode: 'files', paths: ['src/api.mjs', 'fixtures/tokens.json'] } },
    { id: 'no-issues', type: 'merge', config: { mode: 'record', inputs: [], fields: [{ name: 'issues', source: { literal: [] } }] } },
    { id: 'issue-list', type: 'json-select', config: { pointer: '/issues', outputType: 'JsonValue' } },
    { id: 'prepare', type: 'gate', config: { mode: 'prepare', policy: POLICY } },
    { id: 'plan-text', type: 'json-select', config: { pointer: '', outputType: 'Text', render: 'canonical-json' } },
    { id: 'review-prompt', type: 'prompt-template', config: { template: 'Review the bundle.\n\nReview plan (JSON):\n{{plan}}\n\nReturn a ReviewDecision.', slots: [{ id: 'plan' }] } },
    { id: 'readiness', type: 'agent', config: { provider: 'claude', model: 'fixture-reviewer-approve-1', timeoutSeconds: 60, output: { format: 'json' }, attachFiles: true } },
    { id: 'evaluate', type: 'gate', config: { mode: 'evaluate', policy: POLICY } },
    { id: 'analyst-history', type: 'context', config: { provider: 'codex', mode: 'new' } },
    { id: 'implement', type: 'map', config: { approvalPolicy: POLICY, optionalInputs: optional, limits, roles: roles(roleOptions) } },
    { id: 'result', type: 'result-viewer', config: {} },
    { id: 'summary', type: 'result-viewer', config: {} },
  ];
  const edge = (from, fromPort, to, toPort) => ({ id: `${from}-${fromPort}-${to}-${toPort}`, source: { nodeId: from, port: fromPort }, target: { nodeId: to, port: toPort } });
  const edges = [
    edge('no-issues', 'value', 'issue-list', 'value'), edge('docs', 'value', 'prepare', 'subject'), edge('issue-list', 'value', 'prepare', 'issues'),
    edge('prepare', 'plan', 'plan-text', 'value'), edge('plan-text', 'value', 'review-prompt', 'plan'), edge('review-prompt', 'text', 'readiness', 'prompt'),
    edge('prepare', 'readiness', 'readiness', 'files'), edge('prepare', 'subject', 'evaluate', 'subject'), edge('prepare', 'plan', 'evaluate', 'plan'),
    edge('readiness', 'json', 'evaluate', 'readiness'), edge('prepare', 'subject', 'implement', 'documentation'), edge('evaluate', 'certificate', 'implement', 'approval'),
    edge('project', 'value', 'implement', 'base'), edge('implement', 'result', 'result', 'value'), edge('implement', 'summary', 'summary', 'value'),
  ];
  if (prior) {
    nodes.push({ id: 'prior-summary', type: 'file-input', config: { mode: 'artifact', valueType: 'JsonValue', artifact: prior } },
      { id: 'prior-state', type: 'json-select', config: { pointer: '/state', outputType: 'JsonValue' } });
    edges.push(edge('prior-summary', 'value', 'prior-state', 'value'), edge('prior-state', 'value', 'implement', 'prior-state'));
  }
  if (repair) {
    nodes.push({ id: 'repair-request', type: 'merge', config: { mode: 'record', inputs: [], fields: Object.entries(repair).map(([name, literal]) => ({ name, source: { literal } })) } });
    edges.push(edge('repair-request', 'value', 'implement', 'repair'));
  }
  return { schemaVersion: 1, workflowId: id, capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'delivery-v1'], settings: { nativeConfiguration: 'restricted' }, nodes, edges, after: [] };
}

function writeProject(cwd, { map, index, spec } = {}) {
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  put('SPEC.md', spec ?? read('examples/round-recovery/SPEC.md').replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n'));
  put('spec-index.json', index ? JSON.stringify(index, null, 2) : read('examples/round-recovery/spec-index.json'));
  put('implementation-map.json', map ? JSON.stringify(map, null, 2) : read('examples/round-recovery/implementation-map.json'));
  put('src/api.mjs', read('examples/round-recovery/project/src/api.mjs'));
  put('fixtures/tokens.json', read('examples/round-recovery/project/fixtures/tokens.json'));
}

async function start(api, workflow) {
  const saved = await api.save(workflow);
  const created = await api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return created.body.run.runId;
}
const navigator = async (api, runId) => (await api.call('GET', `/api/v2/runs/${runId}/maps/implement`)).body;
const task = (nav, id) => nav.tasks.find(item => item.taskId === id);
const outputsOf = async (api, snapshot, id) => api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);

test('decision fixtures: the verification-cycle bound', () => {
  for (const item of decisions.verificationCycles) assert.deepEqual(verificationStep(item), item.expected, item.id);
});

test('round recovery: a failed real check is triaged, only the auth code is repaired, and the Map completes on fixtures', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const runId = await start(api, deliveryWorkflow({ roleOptions: { implementer: 'fixture-implementer-buggy' } }));
    const done = await api.waitFor(runId, terminal, 120_000);
    const nav = await navigator(api, runId);
    assert.equal(done.run.state, 'succeeded', JSON.stringify({ nav: nav.tasks.map(item => [item.taskId, item.state]), instances: done.instances.filter(item => item.state !== 'succeeded') }));
    assert.equal(nav.state, 'implementation_complete');
    assert.deepEqual(nav.progress, { accepted: 5, total: 5, waiting: 0, running: 0, blocked: 0 });
    assert.equal(nav.failedVerificationCycles, 1);
    assert.equal(task(nav, 'TASK-AUTH-CODE').attempts, 2, 'the auth code was repaired once');
    for (const id of ['TASK-AUTH-TESTS', 'TASK-RESUME-CODE', 'TASK-RESUME-TESTS']) assert.equal(task(nav, id).attempts, 1, `${id} kept its exact-input selection`);
    assert.equal(task(nav, 'TASK-VERIFY').attempts, 2);
    assert.ok(task(nav, 'TASK-AUTH-TESTS').criteria.every(item => item.verdict === 'passed'));

    const events = await api.events(runId);
    const expectedEfforts = { 'fixture-implementer-buggy': 'xhigh', 'fixture-test-author': 'high', 'fixture-task-reviewer': 'medium', 'fixture-triage': 'max' };
    const observedRoles = new Set();
    for (const event of events.filter(item => item.type === 'attempt.invocation_committed' && item.nodeInstanceId.startsWith('implement/'))) {
      const manifest = await api.artifactJson(event.payload.manifest.artifactId);
      assert.equal(manifest.requestedEffort, expectedEfforts[manifest.requestedModel], 'generated Map steps retain their role effort');
      observedRoles.add(manifest.requestedModel);
    }
    assert.deepEqual([...observedRoles].sort(), Object.keys(expectedEfforts).sort(), 'executors, reviewers and embedded triage all ran');
    const cycles = events.filter(event => event.type === 'map.verification_cycle').map(event => [event.payload.outcome, event.payload.failedVerificationCycles]);
    assert.deepEqual(cycles, [['failed', 1], ['passed', 1]]);
    const records = events.filter(event => event.type === 'map.record_created').map(event => event.payload.kind);
    for (const kind of ['TaskResult', 'TaskReview', 'CheckReport', 'Candidate', 'Triage', 'MapState']) assert.ok(records.includes(kind), kind);

    // The failing check is real process evidence of the boundary defect.
    const failed = events.filter(event => event.type === 'attempt.state_changed' && /CHECK-AUTH failed: exit 1/.test(event.payload.reason));
    assert.equal(failed.length, 1);
    const failedCheck = events.find(event => event.type === 'attempt.failure_outcome' && event.attemptId === failed[0].attemptId);
    assert.equal(failedCheck.payload.outcome.source, 'workflow');
    assert.equal(failedCheck.payload.outcome.category, 'task_failure');
    assert.equal(failedCheck.payload.outcome.canonicalCode, 'process');
    assert.equal(failedCheck.payload.outcome.observedState.attemptState, 'succeeded', 'the check failure is evidence while the Map step itself succeeds');

    // Triage is an embedded Analyst invocation through the declared analyst Context.
    const analyst = done.contexts.find(item => item.contextNodeId === 'analyst-history').bindingId;
    const triage = done.instances.find(item => item.nodeInstanceId.endsWith('task-verify-triage'));
    const triageEvent = events.find(event => event.type === 'attempt.inputs_committed' && event.nodeInstanceId === triage.nodeInstanceId);
    assert.equal(triageEvent.payload.contextBindingId, analyst);

    const summary = await api.artifactJson((await outputsOf(api, done, 'implement')).values.summary.artifact.artifactId);
    assert.equal(summary.outcome, 'implementation_complete');
    assert.equal(summary.selectedResults.length, 5);
    assert.equal(summary.checks.length, 4);
    assert.match(summary.candidate.recordId, /^CAND-/);
    const result = await api.artifactJson((await outputsOf(api, done, 'implement')).values.result.artifact.artifactId);
    const auth = result.entries.find(entry => entry.path === 'src/auth.mjs');
    assert.match(await api.artifactText(auth.artifact.artifactId), /expiresAt <= now/);
    assert.deepEqual(result.entries.map(entry => entry.path).sort(), ['fixtures/tokens.json', 'src/api.mjs', 'src/auth.mjs', 'src/resume.mjs', 'tests/auth.test.mjs', 'tests/resume.test.mjs']);
  } finally { await api.close(); }
});

test('the documented delivery example runs: three documentation reviewers approve, the Map completes and the Route shows the candidate', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const workflow = JSON.parse(read('examples/m5-delivery/workflow.json'));
    const models = { implementer: 'fixture-implementer-buggy', 'test-author': 'fixture-test-author', reviewer: 'fixture-task-reviewer', analyst: 'fixture-triage' };
    for (const node of workflow.nodes) {
      if (node.type === 'agent') node.config.model = 'fixture-reviewer-approve-1';
      if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') role.model = models[role.id];
    }
    const runId = await start(api, workflow);
    const done = await api.waitFor(runId, terminal, 180_000);
    assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => !['succeeded', 'skipped'].includes(item.state))));
    const state = id => done.instances.find(item => item.nodeInstanceId === id)?.state;
    assert.equal(state('candidate-view'), 'succeeded');
    assert.equal(state('revision-view'), 'skipped');
    assert.equal((await navigator(api, runId)).failedVerificationCycles, 1);
  } finally { await api.close(); }
});

test('the verification bound pauses the Map before another cycle; raising it resumes triage and repair', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const runId = await start(api, deliveryWorkflow({ limits: { maxFailedVerificationCycles: 1, maxTaskAttempts: 3 }, roleOptions: { implementer: 'fixture-implementer-buggy' } }));
    const paused = await api.waitFor(runId, terminal, 120_000);
    assert.equal(paused.run.state, 'waiting_for_user');
    let nav = await navigator(api, runId);
    assert.equal(nav.state, 'paused');
    assert.equal(nav.pauseReason, 'verification_limit');
    assert.equal(nav.failedVerificationCycles, 1);
    assert.equal(task(nav, 'TASK-VERIFY').state, 'blocked');
    assert.ok(!paused.instances.some(item => item.nodeInstanceId.endsWith('triage')), 'no triage is dispatched at the limit');
    assert.equal(paused.maps[0].pauseReason, 'verification_limit');
    const bad = await api.recover(runId, { action: 'raise-map-limit', nodeInstanceId: 'implement', maxFailedVerificationCycles: 1, maxTaskAttempts: 3 });
    assert.equal(bad.status, 409);
    const raised = await api.recover(runId, { action: 'raise-map-limit', nodeInstanceId: 'implement', maxFailedVerificationCycles: 3, maxTaskAttempts: 3 });
    assert.equal(raised.status, 202, JSON.stringify(raised.body));
    const done = await api.waitFor(runId, terminal, 120_000);
    assert.equal(done.run.state, 'succeeded');
    nav = await navigator(api, runId);
    assert.equal(nav.maxFailedVerificationCycles, 3);
    assert.equal(nav.failedVerificationCycles, 1);
  } finally { await api.close(); }
});

test('specification triage returns a revision outcome; unknown triage pauses for the user', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const spec = await api.waitFor(await start(api, deliveryWorkflow({ roleOptions: { implementer: 'fixture-implementer-buggy', triage: 'fixture-triage-spec' } })), terminal, 120_000);
    assert.equal(spec.run.state, 'succeeded');
    const summary = await api.artifactJson((await outputsOf(api, spec, 'implement')).values.summary.artifact.artifactId);
    assert.equal(summary.outcome, 'specification_revision_required');
    assert.equal(summary.candidate, null);
    assert.ok(summary.issues.length >= 1 && summary.issues.every(issue => /^ISS-MAP-/.test(issue.id)));

    const unknown = await start(api, deliveryWorkflow({ id: 'map-unknown', roleOptions: { implementer: 'fixture-implementer-buggy', triage: 'fixture-triage-unknown' } }));
    const paused = await api.waitFor(unknown, terminal, 120_000);
    assert.equal(paused.run.state, 'waiting_for_user');
    assert.equal((await navigator(api, unknown)).pauseReason, 'triage_unknown');
    await api.closeRun(unknown);
    const closed = await api.waitFor(unknown, terminal);
    assert.equal(closed.run.state, 'failed');
    assert.equal(closed.maps[0].state, 'canceled');
  } finally { await api.close(); }
});

test('an executor may return specification_revision_required instead of a candidate', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const done = await api.waitFor(await start(api, deliveryWorkflow({ roleOptions: { implementer: 'fixture-implementer-spec' } })), terminal, 120_000);
    assert.equal(done.run.state, 'succeeded');
    const summary = await api.artifactJson((await outputsOf(api, done, 'implement')).values.summary.artifact.artifactId);
    assert.equal(summary.outcome, 'specification_revision_required');
    assert.equal(summary.issues[0].ownerRole, 'analyst');
  } finally { await api.close(); }
});

test('same-specification prior state carries independent selections; a repair re-runs only its target and consumers; new templates start a new generation', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const first = await api.waitFor(await start(api, deliveryWorkflow()), terminal, 120_000);
    assert.equal(first.run.state, 'succeeded');
    const summaryValue = (await outputsOf(api, first, 'implement')).values.summary;
    const summary = await api.artifactJson(summaryValue.artifact.artifactId);
    assert.equal(summary.generation, 1);

    const repair = { schemaVersion: 1, kind: 'MapRepair', subjectId: summary.specificationId, taskIds: ['TASK-RESUME-CODE'],
      issues: [{ id: 'ISS-CUSTOMER-0123456789', severity: 'blocker', ownerRole: 'implementer', requirementRefs: ['REQ-RESUME'], message: 'Final review asked for a change.', requestedChange: 'Keep the token stable.' }] };
    const second = await start(api, deliveryWorkflow({ id: 'map-repair', prior: summaryValue.artifact, repair }));
    const repaired = await api.waitFor(second, terminal, 120_000);
    assert.equal(repaired.run.state, 'succeeded', JSON.stringify(repaired.instances.filter(item => item.state !== 'succeeded')));
    const nav = await navigator(api, second);
    assert.equal(nav.generation, 1);
    for (const id of ['TASK-AUTH-CODE', 'TASK-AUTH-TESTS', 'TASK-RESUME-TESTS']) { assert.equal(task(nav, id).carried, true, id); assert.equal(task(nav, id).attempts, 0, id); }
    assert.equal(task(nav, 'TASK-RESUME-CODE').attempts, 1);
    assert.equal(task(nav, 'TASK-VERIFY').attempts, 1);
    const expanded = (await api.events(second)).find(event => event.type === 'map.expanded');
    assert.deepEqual(expanded.payload.carried.sort(), ['TASK-AUTH-CODE', 'TASK-AUTH-TESTS', 'TASK-RESUME-TESTS']);

    const third = await start(api, deliveryWorkflow({ id: 'map-new-template', prior: summaryValue.artifact, roleOptions: { instructions: 'Implement the task with the new template.' } }));
    const fresh = await api.waitFor(third, terminal, 120_000);
    assert.equal(fresh.run.state, 'succeeded');
    const freshNav = await navigator(api, third);
    assert.equal(freshNav.generation, 2);
    assert.ok(freshNav.tasks.every(item => !item.carried && item.attempts >= 1));
  } finally { await api.close(); }
});

test('Assemble reports a conflict instead of last-writer-wins, and the bound counts it once', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    const spec = '# Conflict\n\n## BUSINESS-TASK\n\nRevision 1. Two tasks write one file.\n\n## REQ-X\n\nOne behavior.\n\n## CHECK-X\n\nAlways passes.\n';
    const index = { schemaVersion: 1, document: 'SPEC.md', sections: [
      { id: 'BUSINESS-TASK', kind: 'business', normative: true, visibility: 'public', dependsOn: [] },
      { id: 'REQ-X', kind: 'requirement', normative: true, visibility: 'public', dependsOn: [] },
      { id: 'CHECK-X', kind: 'check', normative: true, visibility: 'internal', dependsOn: ['REQ-X'], command: { program: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30, requiredExitCode: 0, source: 'candidate' } }] };
    const writer = id => ({ id, title: `Writer ${id}`, executorRole: 'implementer', requirementRefs: ['REQ-X'], dependsOn: [], inputs: [{ id: 'project', ref: 'base:project' }, { id: 'req', ref: 'spec:REQ-X' }],
      outputs: [{ id: 'source', type: 'fileSet', paths: ['src/shared.mjs'] }], readScopes: ['spec:REQ-X'], writeScopes: ['src/shared.mjs'],
      acceptanceCriteria: [{ id: `AC-${id.slice(5)}`, description: 'Reviewed.', method: 'review', role: 'reviewer' }] });
    const map = { schemaVersion: 1, mapId: 'MAP-CONFLICT', tasks: [writer('TASK-A'), writer('TASK-B'), {
      id: 'TASK-VERIFY', title: 'Verify', executorRole: 'verification', requirementRefs: ['REQ-X'], dependsOn: [{ taskId: 'TASK-A', milestone: 'accepted' }, { taskId: 'TASK-B', milestone: 'accepted' }],
      inputs: [{ id: 'a', ref: 'task:TASK-A:source' }, { id: 'b', ref: 'task:TASK-B:source' }, { id: 'req', ref: 'spec:REQ-X' }, { id: 'check', ref: 'spec:CHECK-X' }],
      outputs: [{ id: 'candidate', type: 'candidate', paths: ['src/shared.mjs'] }], readScopes: ['spec:REQ-X', 'spec:CHECK-X'], writeScopes: ['reports/**'],
      acceptanceCriteria: [{ id: 'AC-CHECK', description: 'Passes.', method: 'check', checkId: 'CHECK-X' }] }] };
    writeProject(workspace.cwd, { spec, index, map });
    const runId = await start(api, deliveryWorkflow({ id: 'map-conflict', limits: { maxFailedVerificationCycles: 1, maxTaskAttempts: 3 } }));
    const paused = await api.waitFor(runId, terminal, 120_000);
    assert.equal(paused.run.state, 'waiting_for_user');
    const nav = await navigator(api, runId);
    assert.equal(nav.pauseReason, 'verification_limit');
    await api.closeRun(runId);
    const events = await api.events(runId);
    const cycle = events.find(event => event.type === 'map.verification_cycle');
    assert.equal(cycle.payload.outcome, 'conflict');
    assert.equal(cycle.payload.failedVerificationCycles, 1);
    assert.ok(events.some(event => event.type === 'map.record_created' && event.payload.kind === 'Conflict'));
    assert.ok(!events.some(event => event.type === 'map.record_created' && event.payload.kind === 'Candidate'));
  } finally { await api.close(); }
});

test('the Map refuses documentation without a valid approval or with an invalid map', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    const map = JSON.parse(read('examples/round-recovery/implementation-map.json'));
    map.tasks[0].readScopes = map.tasks[0].readScopes.filter(scope => scope !== 'spec:CONTRACT-AUTH');
    writeProject(workspace.cwd, { map });
    const done = await api.waitFor(await start(api, deliveryWorkflow({ id: 'map-invalid' })), terminal, 60_000);
    assert.equal(done.run.state, 'waiting_for_user');
    await api.closeRun(done.run.runId);
    const error = (await api.events(done.run.runId)).find(event => event.type === 'attempt.error' && event.nodeInstanceId === 'implement');
    assert.match(error.payload.message, /task\.closure/);
  } finally { await api.close(); }
});

test('pilot recovery: triage pins the specification identity in the native provider contract', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const runId = await start(api, deliveryWorkflow({ roleOptions: { implementer: 'fixture-implementer-buggy', triage: 'fixture-triage-native-subject' } }));
    const done = await api.waitFor(runId, terminal, 120_000);
    assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => item.state === 'failed')));
    assert.equal((await navigator(api, runId)).failedVerificationCycles, 1);
  } finally { await api.close(); }
});

test('pilot recovery: a Map triage retry acknowledges its visible shared Context and completes repair', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const runId = await start(api, deliveryWorkflow({ roleOptions: { implementer: 'fixture-implementer-buggy', triage: 'fixture-triage-wrong-subject-once' } }));
    const paused = await api.waitFor(runId, terminal, 120_000);
    assert.equal(paused.run.state, 'waiting_for_user');
    const nodeInstanceId = 'implement/1/task-verify-triage';
    const failed = api.runner.engine.latestAttempt(runId, nodeInstanceId);
    const bindingId = failed.context_binding_id;
    assert.equal(api.runner.engine.store.get('SELECT state FROM context_bindings WHERE id=?', bindingId).state, 'needs_review');
    const refused = await api.recover(runId, { action: 'retry', nodeInstanceId, binding: 'keep' });
    assert.equal(refused.status, 422);
    assert.equal(api.runner.engine.latestAttempt(runId, nodeInstanceId).id, failed.id, 'a refused recovery creates no attempt');
    const retry = await api.recover(runId, { action: 'retry', nodeInstanceId, binding: 'acknowledge' });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    const done = await api.waitFor(runId, terminal, 120_000);
    assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => item.state === 'failed')));
    const successful = api.runner.engine.latestAttempt(runId, nodeInstanceId);
    assert.equal(successful.context_binding_id, bindingId);
    const invocation = await api.artifactJson(successful.invocation_artifact_id);
    assert.ok(invocation.nativeSessionBefore, 'the acknowledged shared conversation is resumed');
    assert.equal((await navigator(api, runId)).failedVerificationCycles, 1);
  } finally { await api.close(); }
});

for (const binding of ['acknowledge', 'fresh']) test(`pilot recovery: a task reviewer retries with its own ${binding} Context`, async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    writeProject(workspace.cwd);
    const runId = await start(api, deliveryWorkflow({ roleOptions: { reviewer: 'fixture-task-reviewer-fail-once' } }));
    const paused = await api.waitFor(runId, terminal, 120_000);
    assert.equal(paused.run.state, 'waiting_for_user');
    const nodeInstanceId = 'implement/1/task-auth-code-review-ac-auth-code';
    const failed = api.runner.engine.latestAttempt(runId, nodeInstanceId);
    const originalBindingId = failed.context_binding_id;
    const writer = api.runner.engine.store.get('SELECT * FROM run_context_bindings WHERE run_id=? AND context_node_id=?', runId, 'implement/1/task-auth-code-implementer');
    assert.notEqual(writer.binding_id, originalBindingId);
    const writerBefore = api.runner.engine.store.get('SELECT binding_artifact_id FROM context_bindings WHERE id=?', writer.binding_id).binding_artifact_id;
    const retry = await api.recover(runId, { action: 'retry', nodeInstanceId, binding });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    const done = await api.waitFor(runId, terminal, 120_000);
    assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => item.state === 'failed')));
    const successful = api.runner.engine.latestAttempt(runId, nodeInstanceId);
    const invocation = await api.artifactJson(successful.invocation_artifact_id);
    assert.equal(Boolean(invocation.nativeSessionBefore), binding === 'acknowledge');
    assert.equal(api.runner.engine.store.get('SELECT binding_artifact_id FROM context_bindings WHERE id=?', writer.binding_id).binding_artifact_id, writerBefore, 'reviewer recovery leaves the writer conversation unchanged');
    if (binding === 'fresh') {
      assert.notEqual(successful.context_binding_id, originalBindingId);
      assert.equal(api.runner.engine.store.get('SELECT state FROM context_bindings WHERE id=?', originalBindingId).state, 'needs_review');
      const remap = (await api.events(runId)).find(event => event.type === 'context.remapped' && event.payload.fromBindingId === originalBindingId);
      assert.equal(remap.payload.toBindingId, successful.context_binding_id);
    } else assert.equal(successful.context_binding_id, originalBindingId);
  } finally { await api.close(); }
});
