// Regressions for the M1–M6 resolution follow-up review (F1, F2, F3), adapted from its probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createParser } from '../core/adapters.mjs';
import { prepareDelivery } from '../core/gate.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';

const project = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(join(project, path), 'utf8');
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const copyProject = cwd => {
  for (const [path, source] of [['SPEC.md', 'SPEC.md'], ['spec-index.json', 'spec-index.json'], ['implementation-map.json', 'implementation-map.json'], ['src/api.mjs', 'project/src/api.mjs'], ['fixtures/tokens.json', 'project/fixtures/tokens.json']]) {
    let text = read(`docs/examples/round-recovery/${source}`);
    if (path === 'SPEC.md') text = text.replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n');
    mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text);
  }
};
const outputs = async (api, snapshot, id) => api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);
const run = async (api, workflow) => {
  const created = await api.run(workflow);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const done = await api.waitFor(created.body.run.runId, terminal, 180_000);
  assert.equal(done.run.state, 'succeeded', JSON.stringify(done.instances.filter(item => !['succeeded', 'skipped'].includes(item.state))));
  return done;
};

test('F3: an ambiguous structured answer is journaled as output_contract, not a process failure', async () => {
  const api = await startTestRunner({ runner: { adapters: {
    ...fixtureAdapters('unused'), createParser,
    buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath, args: [join(project, 'runtime/tests/stream-fixture.mjs'), 'antigravity-stale'], stdin: prompt, cwd, env: process.env }),
  } } });
  try {
    await api.workspace();
    const done = await api.waitFor((await api.run(singleAgent({ id: 'classification', provider: 'antigravity', output: { format: 'json' } }))).body.run.runId, terminal);
    assert.equal(done.run.state, 'waiting_for_user');
    await api.closeRun(done.run.runId);
    const error = (await api.events(done.run.runId)).find(event => event.type === 'attempt.error');
    assert.equal(error.payload.code, 'output_contract');
    assert.match(error.payload.message, /stale or ambiguous/);
  } finally { await api.close(); }
});

test('F1: a review whose Context another Agent writes first is never carried; an independent review still is', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    copyProject(workspace.cwd);
    const workflow = JSON.parse(read('docs/examples/m6-selective-delivery/workflow.json'));
    const remove = new Set(['project', 'prior-map-state', 'analyst-history', 'implement', 'outcome', 'candidate-view', 'revision-view', 'summary-view']);
    workflow.nodes = workflow.nodes.filter(node => !remove.has(node.id));
    workflow.edges = workflow.edges.filter(edge => !remove.has(edge.source.nodeId) && !remove.has(edge.target.nodeId));
    delete workflow.view;
    workflow.workflowId = 'context-policy-a';
    for (const node of workflow.nodes) if (node.type === 'agent') node.config.model = 'fixture-reviewer-approve-1';
    workflow.nodes.find(node => node.id === 'customer-review').config.contextId = 'review-memory';
    workflow.nodes.push(
      { id: 'review-memory', type: 'context', config: { provider: 'codex', mode: 'new' } },
      { id: 'memory-instructions', type: 'text', config: { value: 'Remember review policy A in this conversation.' } },
      { id: 'memory-writer', type: 'agent', config: { provider: 'codex', model: 'fixture-echo', contextId: 'review-memory', timeoutSeconds: 60, output: { format: 'text' } } },
    );
    workflow.edges.push({ id: 'memory-prompt', source: { nodeId: 'memory-instructions', port: 'text' }, target: { nodeId: 'memory-writer', port: 'prompt' } });
    workflow.after.push({ before: 'memory-writer', after: 'customer-review' });
    const first = await run(api, workflow);
    const prior = await api.artifactJson((await outputs(api, first, 'evaluate')).values.certificate.artifact.artifactId);
    workflow.workflowId = 'context-policy-b';
    workflow.nodes.find(node => node.id === 'memory-instructions').config.value = 'Remember review policy B: reject this specification.';
    workflow.nodes.find(node => node.id === 'carried-state').config.fields.find(field => field.name === 'documentationApproval').source.literal = prior;
    const second = await run(api, workflow);
    assert.equal(second.instances.find(item => item.nodeId === 'customer-review').state, 'succeeded', 'shared native history forces a live review');
    const plan = await api.artifactJson((await outputs(api, second, 'prepare')).values.plan.artifact.artifactId);
    const customer = plan.slots.find(slot => slot.id === 'customer'), readiness = plan.slots.find(slot => slot.id === 'readiness');
    assert.equal(customer.needsReview, true);
    assert.equal(customer.reviewerFingerprint, null, 'the shared history cannot be established');
    assert.equal(readiness.status, 'current', 'a provably unchanged, independent review is still reused');
    assert.equal(second.instances.find(item => item.nodeId === 'readiness-review').state, 'skipped');
  } finally { await api.close(); }
});

test('F2: delivery preparation rejects a summary that mixes another Map\'s candidate and checks; the coherent summary passes', async () => {
  let variant = false;
  const api = await startTestRunner();
  const adapters = api.runner.engine.adapters;
  const original = adapters.buildInvocation;
  adapters.buildInvocation = config => {
    const invocation = original(config);
    if (variant && config.model === 'fixture-implementer') invocation.args.unshift('--import', new URL('./code-variant-preload.mjs', import.meta.url).href);
    return invocation;
  };
  try {
    const workspace = await api.workspace();
    copyProject(workspace.cwd);
    const workflow = JSON.parse(read('docs/examples/m5-delivery/workflow.json'));
    workflow.workflowId = 'delivery-evidence-a';
    for (const node of workflow.nodes) {
      if (node.type === 'agent') node.config.model = 'fixture-reviewer-approve-1';
      if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') role.model = `fixture-${({ implementer: 'implementer', 'test-author': 'test-author', reviewer: 'task-reviewer', analyst: 'triage' })[role.id]}`;
    }
    const first = await run(api, workflow);
    variant = true; workflow.workflowId = 'delivery-evidence-b';
    const second = await run(api, workflow);
    const mapA = await outputs(api, first, 'implement'), mapB = await outputs(api, second, 'implement');
    const summaryA = await api.artifactJson(mapA.values.summary.artifact.artifactId), summaryB = await api.artifactJson(mapB.values.summary.artifact.artifactId);
    assert.notEqual(mapA.values.result.artifact.sha256, mapB.values.result.artifact.sha256, 'two different accepted candidates exist');
    const store = api.runner.engine.store;
    const json = value => { const artifact = store.putJson(value); return { type: 'JsonValue', artifact: { artifactId: artifact.artifactId, sha256: artifact.sha256 } }; };
    const config = { subject: 'delivery', mode: 'prepare', policy: { slots: [{ id: 'quality', role: 'reviewer', view: 'full' }] }, specificationPolicy: workflow.nodes.find(node => node.type === 'map').config.approvalPolicy };
    const base = { documentation: (await outputs(api, second, 'prepare')).values.subject, approval: (await outputs(api, second, 'evaluate')).values.certificate, issues: json([]) };
    const attempt = (summary, candidate) => () => prepareDelivery({ store, config, inputs: { ...base, summary: json(summary), candidate }, readRecord: api.runner.engine.recordLookup() });
    assert.throws(attempt({ ...summaryB, candidate: summaryA.candidate, checks: summaryA.checks }, mapA.values.result), /not .*the Candidate selected by MapState/);
    assert.throws(attempt(summaryB, mapA.values.result), /not the Candidate recorded by the Map/);
    assert.throws(attempt({ ...summaryB, selectedResults: summaryA.selectedResults }, mapB.values.result), /selected results differ/);
    const coherent = attempt(summaryB, mapB.values.result)();
    assert.match(coherent.outputs.plan ? (await api.artifactJson(coherent.outputs.plan.artifact.artifactId)).subjectId : '', /^DLV-/);
  } finally { adapters.buildInvocation = original; await api.close(); }
});
