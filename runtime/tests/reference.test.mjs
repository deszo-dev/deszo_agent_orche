// The complete reference Delivery Loop (TEST_PIPELINE.md): documentation approval or bypass,
// Implementation Map, technical review, final Customer acceptance, and rejection → triage → repair or revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestRunner } from './helpers.mjs';

const docs = resolve(import.meta.dirname, '../../docs');
const read = path => readFileSync(join(docs, path), 'utf8');
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const MAP_MODELS = { implementer: 'fixture-implementer', 'test-author': 'fixture-test-author', reviewer: 'fixture-task-reviewer', analyst: 'fixture-triage' };

function reference({ customer = 'fixture-reviewer-reject-once-1', triage = 'fixture-final-triage', implementer = MAP_MODELS.implementer } = {}) {
  const workflow = JSON.parse(read('examples/reference-delivery/workflow.json'));
  const visit = nodes => {
    for (const node of nodes) {
      if (node.type === 'agent') node.config.model = node.id === 'analyst' ? 'fixture-analyst-m5' : node.id === 'final-customer' ? customer : node.id === 'triage' ? triage : 'fixture-reviewer-approve-1';
      if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') role.model = role.id === 'implementer' ? implementer : MAP_MODELS[role.id];
      if (node.type === 'loop') visit(node.config.body.nodes);
    }
  };
  visit(workflow.nodes);
  return workflow;
}

async function runReference(api, workflow) {
  const saved = await api.save(workflow);
  const created = await api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const done = await api.waitFor(created.body.run.runId, terminal, 300_000);
  assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => !['succeeded', 'skipped'].includes(item.state)).map(item => [item.nodeInstanceId, item.state])));
  return done;
}
const state = (snapshot, id) => snapshot.instances.find(item => item.nodeInstanceId === id)?.state;
const output = async (api, snapshot, id, port) => {
  const manifest = await api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);
  return api.artifactJson(manifest.values[port].artifact.artifactId);
};
const prepareProject = cwd => {
  for (const path of ['src/api.mjs', 'fixtures/tokens.json']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), read(`examples/round-recovery/project/${path}`));
  }
};

test('reference delivery: the final Customer rejects once, triage repairs one task, and the next pass is accepted with pinned prerequisites', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    prepareProject(workspace.cwd);
    const done = await runReference(api, reference());
    const delivery = done.loops.find(item => item.loopNodeId === 'delivery');
    assert.equal(delivery.iteration, 2);
    // Iteration 1: documentation authored and approved, Map completed, technical approval, Customer rejection, task repair.
    assert.equal(state(done, 'delivery/1/specification'), 'succeeded');
    assert.equal(state(done, 'delivery/1/technical'), 'succeeded');
    assert.equal(state(done, 'delivery/1/accepted'), 'skipped');
    assert.equal(state(done, 'delivery/1/repair-state'), 'succeeded');
    assert.equal(state(done, 'delivery/1/spec-revision'), 'skipped');
    // Iteration 2: the exact approved specification bypasses authoring; only the repaired task and its consumer run.
    assert.equal(state(done, 'delivery/2/specification'), 'skipped');
    assert.equal(state(done, 'delivery/2/accepted'), 'succeeded');
    assert.equal(state(done, 'delivery/2/triage'), 'skipped', 'an accepted delivery leaves the failure join and triage inactive');
    const nav = (await api.call('GET', `/api/v2/runs/${done.run.runId}/maps/${encodeURIComponent('delivery/2/implement')}`)).body;
    const carried = nav.tasks.filter(item => item.carried).map(item => item.taskId).sort();
    assert.deepEqual(carried, ['TASK-AUTH-CODE', 'TASK-AUTH-TESTS', 'TASK-RESUME-TESTS']);
    assert.ok(nav.tasks.find(item => item.taskId === 'TASK-RESUME-CODE').attempts >= 1);

    const acceptance = await output(api, done, 'acceptance', 'value');
    assert.match(acceptance.recordId, /^CERT-/);
    const certificate = await api.artifactJson(acceptance.artifact.artifactId);
    assert.equal(certificate.subjectKind, 'delivery');
    assert.match(certificate.subjectId, /^DLV-/);
    assert.equal(certificate.prerequisites.length, 2, 'the specification and the technical certificate');
    const technical = await api.artifactJson(certificate.prerequisites[1].artifact.artifactId);
    assert.equal(technical.subject.sha256, certificate.subject.sha256, 'Customer approval pins the technically approved subject');
    const subject = await api.artifactJson(certificate.subject.artifactId);
    const deliveryFile = subject.entries.find(entry => entry.path === 'DELIVERY.json');
    const record = await api.artifactJson(deliveryFile.artifact.artifactId);
    assert.equal(record.checks.length, 4, 'every check criterion of the approved map has passing engine evidence');
    assert.ok(subject.entries.some(entry => entry.path === 'candidate/src/auth.mjs'));
    const candidate = await output(api, done, 'candidate', 'value');
    assert.match(candidate.recordId, /^CAND-/);
  } finally { await api.close(); }
});

test('reference delivery: specification triage reopens documentation, every reviewer re-reviews, unchanged tasks carry, and acceptance follows', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    prepareProject(workspace.cwd);
    const done = await runReference(api, reference({ triage: 'fixture-final-triage-spec' }));
    assert.equal(done.loops.find(item => item.loopNodeId === 'delivery').iteration, 2);
    assert.equal(state(done, 'delivery/1/spec-revision'), 'succeeded');
    assert.equal(state(done, 'delivery/2/specification'), 'succeeded', 'the revision is authored and reviewed again');
    for (const slot of ['customer', 'readiness', 'testability']) assert.equal(state(done, `delivery/2/specification/1/${slot}-review`), 'succeeded');
    const nav = (await api.call('GET', `/api/v2/runs/${done.run.runId}/maps/${encodeURIComponent('delivery/2/implement')}`)).body;
    assert.equal(nav.crossRevision, true);
    assert.ok(nav.tasks.every(item => item.carried), 'the revision changed no task closure, so verified selections carry');
    const certificate = await api.artifactJson((await output(api, done, 'acceptance', 'value')).artifact.artifactId);
    assert.equal(certificate.subjectKind, 'delivery');
  } finally { await api.close(); }
});

test('RERUN-04: a Map-raised specification issue is resolved by an authorized reviewer, the revised Gate opens, and the delivery is accepted', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    prepareProject(workspace.cwd);
    const done = await runReference(api, reference({ customer: 'fixture-reviewer-approve-1', implementer: 'fixture-implementer-spec-once' }));
    assert.equal(done.loops.find(item => item.loopNodeId === 'delivery').iteration, 2);
    // Iteration 1: the executor asked for a specification revision; the Map returned it with an ISS-MAP blocker.
    assert.equal(state(done, 'delivery/1/map-revision'), 'succeeded');
    const summary = await output(api, done, 'delivery/1/implement', 'summary');
    assert.equal(summary.outcome, 'specification_revision_required');
    const imported = summary.issues[0].id;
    assert.match(imported, /^ISS-MAP-/);
    // Iteration 2: the revised bundle is reviewed with the imported blocker open; authorized reviewers close it.
    const plan = await output(api, done, 'delivery/2/specification/1/prepare', 'plan');
    assert.ok(plan.openIssues.some(issue => issue.id === imported));
    const customer = plan.slots.find(slot => slot.id === 'customer');
    assert.ok(customer.resolvableIssueIds.includes(imported), 'the public Customer scope covers the cited requirement');
    const report = await output(api, done, 'delivery/2/specification/1/evaluate', 'report');
    assert.equal(report.status, 'OPEN');
    assert.ok(!report.issues.some(issue => issue.id === imported), 'the imported blocker is closed by a live review');
    assert.equal(state(done, 'delivery/2/accepted'), 'succeeded');
    const certificate = await api.artifactJson((await output(api, done, 'acceptance', 'value')).artifact.artifactId);
    assert.equal(certificate.subjectKind, 'delivery');
  } finally { await api.close(); }
});
