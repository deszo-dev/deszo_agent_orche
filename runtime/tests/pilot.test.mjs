// Regressions for the 2026-10-14 pilot (PILOT-01 native output schemas, PILOT-03 Replay lifecycle).
// PILOT-02 (packaged runtime path) is covered by the native tests in src-tauri/src/main.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInvocation, createParser } from '../core/adapters.mjs';
import { outputSchema } from '../core/map.mjs';
import { compileOutputSchema } from '../core/schemas.mjs';
import { nativeSchemaProblems, transportSchema, TransportSchemaError } from '../core/transport.mjs';
import { semanticIssues } from '../core/validate.mjs';
import { project } from '../../shared/replay.mjs';
import { fixture, singleAgent, startTestRunner } from './helpers.mjs';
import { validatePilotDocuments } from '../../scripts/pilot-documents.mjs';

const docs = resolve(import.meta.dirname, '../../docs');
const read = path => JSON.parse(readFileSync(join(docs, path), 'utf8'));

test('pilot author validation rejects unindexed and duplicate headings while ignoring fenced examples', () => {
  const text = readFileSync(join(docs, 'examples/round-recovery/SPEC.md'), 'utf8');
  const index = read('examples/round-recovery/spec-index.json');
  const map = read('examples/round-recovery/implementation-map.json');
  const workflow = read('examples/reference-delivery/workflow.json');
  const roles = workflow.nodes.find(node => node.id === 'delivery').config.body.nodes.find(node => node.type === 'map').config.roles;
  validatePilotDocuments(text, index, map, roles);
  const missing = { ...index, sections: index.sections.filter(section => section.id !== 'ACCEPTANCE-SCENARIOS') };
  assert.throws(() => validatePilotDocuments(text, missing, map, roles), /Unindexed heading ACCEPTANCE-SCENARIOS/);
  assert.throws(() => validatePilotDocuments(text + `\n\n## ${index.sections[0].id}\nDuplicate.\n`, index, map, roles), /appears more than once/);
  validatePilotDocuments(text + '\n\n```markdown\n## FENCED-EXAMPLE\n```\n', index, map, roles);
});
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const review = (({ $schema, $id, title, ...rest }) => rest)(read('schemas/review-decision.schema.json'));
const CONTRACTS = {
  ReviewDecision: review, TaskReturn: outputSchema('taskReturn'), TaskReview: outputSchema('taskReview'), TriageDecision: outputSchema('triageDecision'),
  LoopDecision: (({ $schema, $id, title, ...rest }) => rest)(read('schemas/loop-decision.schema.json')),
};

test('PILOT-01: every engine answer contract has a provider-compatible transport, while the raw contracts do not', () => {
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    const transport = transportSchema(contract);
    assert.deepEqual(nativeSchemaProblems(transport.schema), [], `${name} transport`);
  }
  for (const name of ['ReviewDecision', 'TaskReturn', 'TaskReview', 'TriageDecision'])
    assert.ok(nativeSchemaProblems(CONTRACTS[name]).length > 0, `${name} needs a transport form (root composition / open objects)`);
});

test('PILOT-01: transport answers decode to values the complete contract still judges', () => {
  const taskReturn = transportSchema(CONTRACTS.TaskReturn);
  const candidate = taskReturn.decode({ schemaVersion: 1, kind: 'candidate', summary: 'Wrote src/auth.mjs.', reason: null, issues: null });
  assert.deepEqual(candidate, { schemaVersion: 1, kind: 'candidate', summary: 'Wrote src/auth.mjs.' });
  assert.deepEqual(compileOutputSchema(CONTRACTS.TaskReturn)(candidate), []);
  // A transport-valid but contract-invalid answer is still rejected by the engine's full validation.
  const mixed = taskReturn.decode({ schemaVersion: 1, kind: 'candidate', summary: null, reason: 'Unclear.', issues: null });
  assert.ok(compileOutputSchema(CONTRACTS.TaskReturn)(mixed).length > 0);
  const decision = transportSchema(CONTRACTS.ReviewDecision);
  const rejected = { schemaVersion: 1, subjectId: 'SPEC-0123456789AB', role: 'customer', verdict: 'CHANGES_REQUESTED', scopeRefs: [], resolvedIssueIds: [], issues: [] };
  assert.deepEqual(decision.decode(rejected), rejected);
  assert.ok(compileOutputSchema(CONTRACTS.ReviewDecision)(rejected).length > 0, 'the root allOf rule (a rejection needs a blocker) is still enforced');
});

test('PILOT-01: Gemini numeric and nullable enum restrictions remain engine-owned', () => {
  // Real Antigravity/Gemini rejected schemaVersion enum [1] with "enum[0]: cannot be empty".
  const contract = { type: 'object', properties: {
    schemaVersion: { type: 'integer', const: 1 },
    enabled: { type: 'boolean', enum: [true] },
    status: { type: 'string', enum: ['ready', 'failed'] },
  }, required: ['schemaVersion', 'enabled'], additionalProperties: false };
  const transport = transportSchema(contract);
  assert.deepEqual(transport.schema.properties.schemaVersion, { type: 'integer' });
  assert.equal(transport.schema.properties.enabled.enum, undefined);
  assert.equal(transport.schema.properties.status.enum, undefined, 'the optional null does not become an enum member');
  assert.deepEqual(transport.schema.properties.status.anyOf[0].enum, ['ready', 'failed']);
  assert.deepEqual(transport.schema.properties.status.anyOf[1], { type: 'null' });
  assert.deepEqual(nativeSchemaProblems(transport.schema), []);
  assert.ok(nativeSchemaProblems({ type: 'object', properties: { schemaVersion: { type: 'integer', enum: [1] } }, required: ['schemaVersion'], additionalProperties: false }).length > 0);
  const validate = compileOutputSchema(contract);
  assert.deepEqual(validate(transport.decode({ schemaVersion: 1, enabled: true, status: null })), []);
  assert.ok(validate(transport.decode({ schemaVersion: 2, enabled: true, status: null })).length > 0);
  assert.ok(validate(transport.decode({ schemaVersion: 1, enabled: false, status: null })).length > 0);
  assert.ok(validate(transport.decode({ schemaVersion: 1, enabled: true, status: 'unknown' })).length > 0);
});

test('PILOT-01: Antigravity finish echoes must agree with every complete JSON message and the requested schema', () => {
  const answer = { schemaVersion: 1, subjectId: 'SPEC-73796E47D6B1', role: 'testability-reviewer', verdict: 'APPROVED', scopeRefs: [], resolvedIssueIds: [], issues: [] };
  const native = transportSchema(CONTRACTS.ReviewDecision).schema;
  const response = JSON.stringify(answer) + '\n' + JSON.stringify({ ...answer, toolAction: 'Finishing review', toolSummary: 'Finish review' }) + '\n';
  const parse = (text, schema = native) => {
    const parser = createParser('antigravity', { output: { format: 'json', schema: CONTRACTS.ReviewDecision } });
    parser.feed({ event: 'result', result: { status: 'SUCCESS', response: text, structured_output: answer, json_schema: schema } });
    return parser.state;
  };
  assert.deepEqual(JSON.parse(parse(response).finalText), answer);
  assert.equal(parse(response).formatError, null);
  assert.match(parse(JSON.stringify({ ...answer, subjectId: 'SPEC-OTHER' }) + '\n' + response).formatError, /stale or ambiguous/);
  assert.match(parse('Here is the decision:\n' + response).formatError, /stale or ambiguous/, 'no JSON is extracted from prose');
  assert.match(parse(response, {}).formatError, /stale or ambiguous/, 'the CLI must report the requested native schema');
  assert.match(parse(response + 'trailing words').formatError, /stale or ambiguous/);
  assert.match(parse('{"schemaVersion":1,"schemaVersion":2}\n' + response).formatError, /stale or ambiguous/, 'duplicate keys are rejected');
});

test('PILOT-01: TaskReturn null alternatives and finish echoes decode without hiding extra task issues', () => {
  const contract = CONTRACTS.TaskReturn;
  const native = transportSchema(contract).schema;
  assert.equal(native.properties.issues.type, undefined);
  assert.deepEqual(native.properties.issues.anyOf.at(-1), { type: 'null' });
  const candidate = { schemaVersion: 1, kind: 'candidate', summary: 'Wrote the tests.' };
  const encoded = { ...candidate, reason: null, issues: null };
  const parse = value => {
    const parser = createParser('antigravity', { output: { format: 'json', schema: contract } });
    parser.feed({ event: 'result', result: { status: 'SUCCESS', json_schema: native, structured_output: value,
      response: JSON.stringify(candidate) + '\n' + JSON.stringify({ ...value, toolAction: 'Finish', toolSummary: 'Done' }) } });
    return parser.state;
  };
  assert.deepEqual(transportSchema(contract).decode(JSON.parse(parse(encoded).finalText)), candidate);
  assert.match(parse({ ...encoded, reason: 'Unrelated reason', issues: [{ localId: 'dummy' }] }).formatError, /stale or ambiguous/);
});

test('PILOT-01: unsupported contracts are refused before any request (workflow validation)', () => {
  assert.throws(() => transportSchema({ type: 'object' }), TransportSchemaError);
  assert.throws(() => transportSchema({ type: 'array', items: { type: 'string' } }), TransportSchemaError);
  assert.throws(() => transportSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }), TransportSchemaError);
  const workflow = singleAgent({ id: 'free-form', output: { format: 'json', schema: { type: 'object' } } });
  assert.ok(semanticIssues(workflow).some(issue => issue.code === 'output.transport'));
});

test('PILOT-01: new and resumed invocations of every provider carry only the transport schema', () => {
  const transport = transportSchema(CONTRACTS.ReviewDecision).schema;
  for (const provider of ['codex', 'claude', 'antigravity']) for (const nativeSessionId of [null, 'session-1']) {
    const invocation = buildInvocation({ provider, cliPath: 'cli', model: 'm', prompt: 'p', cwd: '.', nativeSessionId, output: { format: 'json', schema: transport },
      nativeConfiguration: 'restricted', timeoutSeconds: 60, schemaPath: 'schema.json' });
    const inline = invocation.args.find(arg => arg.startsWith('{"'));
    if (provider === 'codex') assert.ok(invocation.args.includes('--output-schema'));
    else assert.deepEqual(nativeSchemaProblems(JSON.parse(inline)), [], `${provider} ${nativeSessionId ? 'resume' : 'new'}`);
  }
});

test('PILOT-01: the fixture CLI rejects a raw contract like the real CLIs, and a run with optional properties succeeds through the transport', async () => {
  const dir = mkdtempSync(join(resolve(import.meta.dirname, '../../.deszo/tests'), 'schema-'));
  writeFileSync(join(dir, 'raw.json'), JSON.stringify(CONTRACTS.ReviewDecision));
  const raw = spawnSync(process.execPath, [fixture, 'echo', '', dir, 'codex', join(dir, 'raw.json')], { input: 'x', encoding: 'utf8' });
  assert.equal(raw.status, 1);
  assert.match(raw.stdout, /Invalid schema for response_format/);

  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ id: 'native-review', model: 'fixture-echo', context: null,
      output: { format: 'json', schema: { type: 'object', properties: { message: { type: 'string' }, note: { type: 'string' } }, required: ['message'], additionalProperties: false } } });
    const done = await api.waitFor((await api.run(workflow)).body.run.runId, terminal);
    assert.equal(done.run.state, 'succeeded', 'an optional property travels as nullable and is decoded away');
  } finally { await api.close(); }
});

test('PILOT-03: after a paused loop is closed, Replay shows the loop canceled and the undecided iteration as closed without a decision', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = read('examples/m2-review-loop/workflow.json');
    workflow.workflowId = 'closed-loop';
    for (const node of workflow.nodes.find(item => item.type === 'loop').config.body.nodes) if (node.type === 'agent') node.config.model = node.id === 'writer' ? 'fixture-fail' : 'fixture-checker-approve-2';
    const paused = await api.waitFor((await api.run(workflow)).body.run.runId, terminal);
    assert.equal(paused.run.state, 'waiting_for_user');
    const before = project(await (async () => api.runner.engine.store.readEvents(paused.run.runId))(), Infinity);
    assert.equal([...before.loops.values()][0].state, 'paused');
    await api.closeRun(paused.run.runId);
    const events = await api.events(paused.run.runId);
    const after = project(events, events.length - 1);
    const loop = [...after.loops.values()][0];
    assert.equal(after.run, 'failed');
    assert.equal(loop.state, 'canceled');
    assert.equal(loop.pauseReason, null);
    assert.equal(loop.iterations.at(-1).continue, null, 'no decision is invented');
    assert.equal(loop.iterations.at(-1).outcome, 'canceled');
  } finally { await api.close(); }
});

test('RERUN-04: issue resolution authority — own namespace, imported scope coverage, and full view for uncited issues', async () => {
  const { mayResolve } = await import('../core/gate.mjs');
  const bundle = { index: read('examples/round-recovery/spec-index.json') };
  const slots = [{ id: 'customer', role: 'customer', view: 'public' }, { id: 'readiness', role: 'implementation-readiness', view: 'full' },
    { id: 'testability', role: 'testability-reviewer', view: 'full', scopeRefs: ['REQ-AUTH'] }];
  const issue = (id, requirementRefs) => ({ id, severity: 'blocker', ownerRole: 'analyst', requirementRefs, message: 'm', requestedChange: 'c' });
  const can = (item, slotId) => mayResolve({ issue: item, slot: slots.find(slot => slot.id === slotId), slots, bundle });
  // A reviewer's own blocker stays with that reviewer.
  assert.equal(can(issue('ISS-READINESS-0123456789', ['REQ-AUTH']), 'readiness'), true);
  assert.equal(can(issue('ISS-READINESS-0123456789', ['REQ-AUTH']), 'customer'), false);
  // Imported (Map) issues: any live slot whose scope covers every cited requirement.
  const publicRequirement = issue('ISS-MAP-0123456789', ['REQ-RESUME']);
  assert.deepEqual(slots.map(slot => can(publicRequirement, slot.id)), [true, true, false], 'REQ-RESUME is outside the REQ-AUTH scope closure');
  assert.equal(can(issue('ISS-MAP-1111111111', ['REQ-AUTH']), 'testability'), true, 'a narrowed scope covers its own closure');
  const internalContract = issue('ISS-MAP-ABCDEF0123', ['CONTRACT-AUTH']);
  assert.deepEqual(slots.map(slot => can(internalContract, slot.id)), [false, true, false], 'the public view does not cover internal contracts');
  const uncited = issue('ISS-MAP-FEDCBA9876', []);
  assert.deepEqual(slots.map(slot => can(uncited, slot.id)), [false, true, false], 'an uncited import needs an unrestricted full view');
});
