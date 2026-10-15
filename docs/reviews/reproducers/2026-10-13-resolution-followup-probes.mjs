// Quota-free follow-up audit. Uses only isolated fixture runners; never changes production code.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startTestRunner, singleAgent, fixtureAdapters } from '../../../runtime/tests/helpers.mjs';
import { createParser } from '../../../runtime/core/adapters.mjs';
import { prepareDelivery } from '../../../runtime/core/gate.mjs';
const project = resolve(import.meta.dirname, '../../..');
const read = path => readFileSync(join(project, path), 'utf8');
const copyProject = cwd => {
  for (const [path, source] of [['SPEC.md', 'SPEC.md'], ['spec-index.json', 'spec-index.json'], ['implementation-map.json', 'implementation-map.json'], ['src/api.mjs', 'project/src/api.mjs'], ['fixtures/tokens.json', 'project/fixtures/tokens.json']]) {
    let text = read(`docs/examples/round-recovery/${source}`);
    if (path === 'SPEC.md') text = text.replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n');
    mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text);
  }
};
const outputs = async (api, snapshot, id) => api.artifactJson(snapshot.instances.find(item => item.nodeInstanceId === id).outputs.artifactId);
const run = async (api, workflow) => {
  const created = await api.run(workflow); assert.equal(created.status, 202, JSON.stringify(created.body));
  const done = await api.waitFor(created.body.run.runId, undefined, 120_000);
  const errors = api.runner.engine.store.readEvents(done.run.runId).filter(event => event.type === 'attempt.error').map(event => event.payload);
  assert.equal(done.run.state, 'succeeded', JSON.stringify({ root: api.root, errors })); return done;
};
const result = [];
{
  const api = await startTestRunner({ runner: { adapters: {
    ...fixtureAdapters('unused'), createParser,
    buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath, args: [join(project, 'runtime/tests/stream-fixture.mjs'), 'antigravity-stale'], stdin: prompt, cwd, env: process.env }),
  } } });
  try {
    await api.workspace();
    const created = await api.run(singleAgent({ id: 'classification', provider: 'antigravity', output: { format: 'json' } }));
    const done = await api.waitFor(created.body.run.runId);
    await api.closeRun(done.run.runId);
    const error = (await api.events(done.run.runId)).find(event => event.type === 'attempt.error');
    result.push({ probe: 'R5-error-classification', state: done.run.state, expectedCode: 'output_contract', actualCode: error.payload.code, message: error.payload.message });
    console.log(JSON.stringify(result.at(-1)));
  } finally { await api.close(); }
}
{
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace(); copyProject(workspace.cwd);
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
    const plan = await api.artifactJson((await outputs(api, second, 'prepare')).values.plan.artifact.artifactId);
    result.push({ probe: 'R1-shared-New-Context-history', firstRun: first.run.runId, secondRun: second.run.runId, memoryWriter: second.instances.find(item => item.nodeId === 'memory-writer').state,
      customer: second.instances.find(item => item.nodeId === 'customer-review').state, expectedCustomer: 'succeeded', slot: plan.slots.find(slot => slot.id === 'customer'), root: api.root });
    console.log(JSON.stringify(result.at(-1)));
  } finally { await api.close(); }
}
{
  let variant = false;
  const api = await startTestRunner();
  const adapters = api.runner.engine.adapters;
  const original = adapters.buildInvocation;
  adapters.buildInvocation = config => {
    const invocation = original(config);
    if (variant && config.model === 'fixture-implementer') invocation.args.unshift('--import', new URL('2026-10-13-resolution-code-variant.mjs', import.meta.url).href);
    return invocation;
  };
  try {
    const workspace = await api.workspace(); copyProject(workspace.cwd);
    const workflow = JSON.parse(read('docs/examples/m5-delivery/workflow.json'));
    workflow.workflowId = 'delivery-evidence-a';
    for (const node of workflow.nodes) {
      if (node.type === 'agent') node.config.model = 'fixture-reviewer-approve-1';
      if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') role.model = `fixture-${({ implementer: 'implementer', 'test-author': 'test-author', reviewer: 'task-reviewer', analyst: 'triage' })[role.id]}`;
    }
    const first = await run(api, workflow);
    variant = true; workflow.workflowId = 'delivery-evidence-b';
    const second = await run(api, workflow);
    const mapA = await outputs(api, first, 'implement');
    const mapB = await outputs(api, second, 'implement');
    const summaryA = await api.artifactJson(mapA.values.summary.artifact.artifactId);
    const summaryB = await api.artifactJson(mapB.values.summary.artifact.artifactId);
    assert.notEqual(mapA.values.result.artifact.sha256, mapB.values.result.artifact.sha256, 'two different accepted candidates were produced');
    const mixed = { ...summaryB, candidate: summaryA.candidate, checks: summaryA.checks };
    const store = api.runner.engine.store;
    const input = { documentation: (await outputs(api, second, 'prepare')).values.subject, approval: (await outputs(api, second, 'evaluate')).values.certificate,
      summary: { type: 'JsonValue', artifact: store.putJson(mixed) }, candidate: mapA.values.result, issues: { type: 'JsonValue', artifact: store.putJson([]) } };
    let accepted = false, error = null;
    try {
      prepareDelivery({ store, config: { subject: 'delivery', mode: 'prepare', policy: { slots: [{ id: 'quality', role: 'reviewer', view: 'full' }] }, specificationPolicy: workflow.nodes.find(node => node.type === 'map').config.approvalPolicy },
        inputs: input, readRecord: api.runner.engine.recordLookup() });
      accepted = true;
    } catch (caught) { error = caught.message; }
    result.push({ probe: 'R2-mixed-MapState-and-candidate-evidence', expectedAccepted: false, actualAccepted: accepted, error, candidateA: mapA.values.result.artifact.sha256,
      candidateB: mapB.values.result.artifact.sha256, currentMapState: summaryB.state.recordId, currentCandidate: summaryB.candidate.recordId, substitutedCandidate: summaryA.candidate.recordId, root: api.root });
    console.log(JSON.stringify(result.at(-1)));
  } finally { await api.close(); }
}
const report = { timestamp: new Date().toISOString(), results: result };
writeFileSync(join(import.meta.dirname, '2026-10-13-resolution-followup-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
