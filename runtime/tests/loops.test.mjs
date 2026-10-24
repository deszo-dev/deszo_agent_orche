import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from '../core/schemas.mjs';
import { Engine, loopStep, m2Transition } from '../core/engine.mjs';
import { startTestRunner } from './helpers.mjs';

const example = () => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/examples/m2-review-loop/workflow.json'), 'utf8'));
const decisions = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/fixtures/decisions.json'), 'utf8'));
const clean = (schema, definition, body) => assert.deepEqual(check(schema, definition, body), []);

function reviewLoop({ id = 'review-loop', writer = 'fixture-echo', checker = 'fixture-checker-approve-2', maxIterations = 3, maxActiveMinutes = 30, checkerSchema = true } = {}) {
  const workflow = example();
  workflow.workflowId = id;
  const loop = workflow.nodes.find(node => node.id === 'refine');
  loop.config.limits = { maxIterations, maxActiveMinutes };
  for (const node of loop.config.body.nodes) {
    if (node.id === 'writer') node.config.model = writer;
    if (node.id === 'checker') { node.config.model = checker; if (!checkerSchema) node.config.output = { format: 'json' }; }
  }
  return workflow;
}

const outputsOf = async (api, snapshot, instanceId, port) => {
  const instance = snapshot.instances.find(item => item.nodeInstanceId === instanceId);
  const manifest = await api.artifactJson(instance.outputs.artifactId);
  return api.artifactText(manifest.values[port].artifact.artifactId);
};

test('decision fixtures: the engine lifecycle table and loop step agree with the documentation', () => {
  for (const item of decisions.m2Lifecycle) assert.equal(m2Transition(item.state, item.event), item.expected, item.id);
  for (const item of decisions.loopIteration) assert.equal(loopStep(item), item.expected, item.id);
});

test('an Agent checker drives a structured-state loop to completion with a shared writer Context', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop());
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const snapshot = await api.waitFor(created.body.run.runId);
    clean('runtime-api-v2.schema.json', 'runSnapshot', snapshot);
    assert.equal(snapshot.run.state, 'succeeded');
    assert.deepEqual(snapshot.loops.map(loop => [loop.state, loop.iteration]), [['finished', 2]]);
    const events = await api.events(snapshot.run.runId);
    for (const event of events) clean('journal-event-v2.schema.json', null, event);
    const types = events.map(event => event.type);
    assert.deepEqual(types.filter(type => type.startsWith('loop.')), ['loop.started', 'loop.iteration_started', 'loop.iteration_returned', 'loop.iteration_started', 'loop.iteration_returned', 'loop.finished']);
    assert.ok(snapshot.instances.some(item => item.nodeInstanceId === 'refine/2/writer' && item.state === 'succeeded'));
    const final = await outputsOf(api, snapshot, 'final-draft', 'value');
    assert.match(final, /codex turn 2:/, 'the writer resumed its Context in iteration 2');
    const returned = events.filter(event => event.type === 'loop.iteration_returned').map(event => event.payload.continue);
    assert.deepEqual(returned, [true, false]);
    // Iteration 2 received iteration 1's checker feedback.
    const feedback = events.filter(event => event.type === 'loop.iteration_started')[1].payload.feedback;
    assert.equal(await api.artifactText(feedback.artifact.artifactId), 'Improve on turn 1.');
  } finally { await api.close(); }
});

test('the iteration limit pauses for the user; raise-limit continues to a normal finish', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop({ checker: 'fixture-checker-approve-3', maxIterations: 2 }));
    const runId = created.body.run.runId;
    let snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    assert.deepEqual(snapshot.loops[0], { ...snapshot.loops[0], state: 'paused', pauseReason: 'iteration_limit', iteration: 2 });
    assert.equal(snapshot.instances.find(item => item.nodeId === 'refine').state, 'waiting');
    const tooLow = await api.recover(runId, { action: 'raise-limit', loopNodeId: 'refine', maxIterations: 2, maxActiveMinutes: 30 });
    assert.equal(tooLow.status, 409);
    const raised = await api.recover(runId, { action: 'raise-limit', loopNodeId: 'refine', maxIterations: 4, maxActiveMinutes: 30 });
    assert.equal(raised.status, 202, JSON.stringify(raised.body)); clean('runtime-api-v2.schema.json', 'commandResponse', raised.body);
    snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'succeeded');
    assert.deepEqual([snapshot.loops[0].iteration, snapshot.loops[0].maxIterations], [3, 4]);
    const types = (await api.events(runId)).map(event => event.type);
    assert.ok(types.indexOf('run.recovery_requested') < types.indexOf('loop.limits_changed'));
    assert.ok(types.includes('loop.resumed'));
  } finally { await api.close(); }
});

test('an invalid checker decision pauses the loop as a body failure without inventing a decision', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop({ checker: 'fixture-checker-invalid', checkerSchema: false }));
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    assert.equal(snapshot.loops[0].pauseReason, 'body_failure');
    await api.closeRun(snapshot.run.runId);
    const events = await api.events(snapshot.run.runId);
    const error = events.find(event => event.type === 'attempt.error');
    assert.equal(error.nodeInstanceId, 'refine'); assert.match(error.payload.message, /loop-decision/);
    assert.ok(!events.some(event => event.type === 'loop.iteration_returned'), 'a malformed decision never means finish');
    const final = await api.waitFor(snapshot.run.runId);
    assert.equal(final.run.state, 'failed'); assert.equal(final.loops[0].state, 'canceled');
  } finally { await api.close(); }
});

test('retry of a failed body Agent needs an explicit Context choice and resumes the loop', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop({ writer: 'fixture-fail-once', checker: 'fixture-checker-approve-1' }));
    const runId = created.body.run.runId;
    let snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    assert.equal(snapshot.instances.find(item => item.nodeInstanceId === 'refine/1/writer').state, 'failed');
    const keep = await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/writer' });
    assert.equal(keep.status, 422, 'the writer Context needs review after a failed native write');
    const busy = await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/checker' });
    assert.equal(busy.status, 409, 'only failed or canceled attempts are retried');
    const retried = await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/writer', binding: 'acknowledge' });
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'succeeded');
    const writer = snapshot.instances.find(item => item.nodeInstanceId === 'refine/1/writer');
    assert.deepEqual([writer.ordinal, writer.state], [2, 'succeeded']);
    const events = await api.events(runId);
    assert.ok(events.some(event => event.type === 'context.state_changed' && event.payload.from === 'needs_review' && event.payload.to === 'ready'));
  } finally { await api.close(); }
});

test('fresh binding on retry remaps the Context node and keeps the old binding as history', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop({ writer: 'fixture-fail-once', checker: 'fixture-checker-approve-1' }));
    const runId = created.body.run.runId;
    const before = await api.waitFor(runId);
    const oldBinding = before.contexts.find(item => item.contextNodeId === 'writer-history').bindingId;
    assert.equal((await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/writer', binding: 'fresh' })).status, 202);
    const after = await api.waitFor(runId);
    assert.equal(after.run.state, 'succeeded');
    const newBinding = after.contexts.find(item => item.contextNodeId === 'writer-history').bindingId;
    assert.notEqual(newBinding, oldBinding);
    const bindings = (await api.call('GET', '/api/v2/context-bindings?workspaceId=main')).body.bindings;
    assert.equal(bindings.find(item => item.bindingId === oldBinding).state, 'needs_review');
    assert.equal(bindings.find(item => item.bindingId === newBinding).state, 'ready');
  } finally { await api.close(); }
});

test('the active-time limit stops body work, pauses, and raise-limit re-plans the canceled attempt', async () => {
  const api = await startTestRunner({ runner: { loopMinuteMs: 300 } });
  try {
    await api.workspace();
    const created = await api.run(reviewLoop({ writer: 'fixture-slow-2', checker: 'fixture-checker-approve-1', maxActiveMinutes: 1 }));
    const runId = created.body.run.runId;
    let snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    assert.equal(snapshot.loops[0].pauseReason, 'time_limit');
    assert.ok(snapshot.loops[0].activeMs >= 300);
    assert.equal(snapshot.instances.find(item => item.nodeInstanceId === 'refine/1/writer').state, 'canceled');
    const retry = await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/writer', binding: 'acknowledge' });
    assert.equal(retry.status, 409, 'a loop out of time needs a higher limit first');
    const raised = await api.recover(runId, { action: 'raise-limit', loopNodeId: 'refine', maxIterations: 3, maxActiveMinutes: 100 });
    assert.equal(raised.status, 202, JSON.stringify(raised.body));
    // The canceled native write left the binding for review; accept it and retry the re-planned writer if needed.
    snapshot = await api.waitFor(runId);
    if (snapshot.run.state === 'waiting_for_user') {
      assert.equal((await api.recover(runId, { action: 'retry', nodeInstanceId: 'refine/1/writer', binding: 'acknowledge' })).status, 202);
      snapshot = await api.waitFor(runId);
    }
    assert.equal(snapshot.run.state, 'succeeded');
  } finally { await api.close(); }
});

test('scoped Stop on a loop pauses it; restart-iteration runs the iteration again', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = reviewLoop({ writer: 'fixture-slow-30', checker: 'fixture-checker-approve-1' });
    const created = await api.run(workflow);
    const runId = created.body.run.runId;
    await api.waitFor(runId, (_, snapshot) => snapshot.instances.some(item => item.nodeInstanceId === 'refine/1/writer' && item.state === 'running'));
    const stop = await api.call('POST', `/api/v2/runs/${runId}/nodes/refine/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, JSON.stringify(stop.body));
    let snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    assert.equal(snapshot.loops[0].pauseReason, 'stopped');
    // Switch the writer to a fast scenario is impossible mid-run; restart keeps the captured definition.
    const restart = await api.recover(runId, { action: 'restart-iteration', loopNodeId: 'refine' });
    assert.equal(restart.status, 202, JSON.stringify(restart.body));
    await api.waitFor(runId, (_, s) => s.instances.some(item => item.nodeInstanceId === 'refine/1/writer' && item.ordinal === 2));
    snapshot = await api.waitFor(runId, run => run.state !== 'running');
    assert.equal(snapshot.run.state, 'waiting_for_user', 'the restarted writer cannot reuse the binding left for review');
    const stopRun = await api.call('POST', `/api/v2/runs/${runId}/stop`, { requestId: randomUUID() });
    assert.equal(stopRun.status, 202);
    snapshot = await api.waitFor(runId);
    assert.equal(snapshot.run.state, 'canceled');
    assert.equal(snapshot.loops[0].state, 'canceled');
  } finally { await api.close(); }
});

test('a deterministic Condition loop, files, merges, JSON Select, attachments and captures', async () => {
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    mkdirSync(join(workspace.cwd, 'notes'), { recursive: true });
    writeFileSync(join(workspace.cwd, 'notes', 'a.md'), 'alpha');
    writeFileSync(join(workspace.cwd, 'b.md'), 'beta');
    const workflow = {
      schemaVersion: 1, workflowId: 'utilities', capabilities: ['core-v1', 'loops-v1'], settings: { nativeConfiguration: 'restricted' },
      nodes: [
        { id: 'docs-a', type: 'file-input', config: { mode: 'files', paths: ['notes/a.md'] } },
        { id: 'docs-b', type: 'file-input', config: { mode: 'files', paths: ['b.md'] } },
        { id: 'docs', type: 'merge', config: { mode: 'artifacts', inputs: [{ id: 'a' }, { id: 'b' }] } },
        { id: 'ask', type: 'text', config: { value: 'Summarize the attached notes.' } },
        { id: 'reader', type: 'agent', config: { provider: 'codex', model: 'fixture-write-out', timeoutSeconds: 60, output: { format: 'text' }, attachFiles: true, captures: ['out.txt'] } },
        { id: 'pair', type: 'merge', config: { mode: 'text', inputs: [{ id: 'first' }, { id: 'second' }], separator: ' | ' } },
        { id: 'record', type: 'merge', config: { mode: 'record', inputs: [{ id: 'summary', type: 'Text' }, { id: 'files', type: 'ArtifactSet' }], fields: [
          { name: 'summary', source: { input: 'summary' } }, { name: 'files', source: { input: 'files' } }, { name: 'round', source: { literal: 0 } }] } },
        { id: 'files-back', type: 'json-select', config: { pointer: '/files', outputType: 'ArtifactSet' } },
        { id: 'count', type: 'loop', config: { valueType: 'Text', fixedInputs: [], limits: { maxIterations: 5, maxActiveMinutes: 5 }, body: {
          nodes: [{ id: 'enough', type: 'condition', config: { doneWhen: { pointer: '', op: 'equals', value: 3 }, reason: { literal: 'Counted to three.' }, feedback: { literal: 'again' } } }],
          edges: [
            { id: 'iteration-enough', source: { nodeId: '$input', port: 'iteration' }, target: { nodeId: 'enough', port: 'value' } },
            { id: 'value-return', source: { nodeId: '$input', port: 'value' }, target: { nodeId: '$return', port: 'candidate' } },
            { id: 'decision-return', source: { nodeId: 'enough', port: 'decision' }, target: { nodeId: '$return', port: 'decision' } }],
          after: [] } } },
        { id: 'view-files', type: 'result-viewer', config: {} },
        { id: 'view-record', type: 'result-viewer', config: {} },
        { id: 'view-count', type: 'result-viewer', config: {} },
      ],
      edges: [
        { id: 'e1', source: { nodeId: 'docs-a', port: 'value' }, target: { nodeId: 'docs', port: 'a' } },
        { id: 'e2', source: { nodeId: 'docs-b', port: 'value' }, target: { nodeId: 'docs', port: 'b' } },
        { id: 'e3', source: { nodeId: 'ask', port: 'text' }, target: { nodeId: 'reader', port: 'prompt' } },
        { id: 'e4', source: { nodeId: 'docs', port: 'value' }, target: { nodeId: 'reader', port: 'files' } },
        { id: 'e5', source: { nodeId: 'reader', port: 'text' }, target: { nodeId: 'pair', port: 'first' } },
        { id: 'e6', source: { nodeId: 'ask', port: 'text' }, target: { nodeId: 'pair', port: 'second' } },
        { id: 'e7', source: { nodeId: 'pair', port: 'value' }, target: { nodeId: 'record', port: 'summary' } },
        { id: 'e8', source: { nodeId: 'reader', port: 'files' }, target: { nodeId: 'record', port: 'files' } },
        { id: 'e9', source: { nodeId: 'record', port: 'value' }, target: { nodeId: 'files-back', port: 'value' } },
        { id: 'e10', source: { nodeId: 'files-back', port: 'value' }, target: { nodeId: 'view-files', port: 'value' } },
        { id: 'e11', source: { nodeId: 'record', port: 'value' }, target: { nodeId: 'view-record', port: 'value' } },
        { id: 'e12', source: { nodeId: 'pair', port: 'value' }, target: { nodeId: 'count', port: 'seed' } },
        { id: 'e13', source: { nodeId: 'count', port: 'result' }, target: { nodeId: 'view-count', port: 'value' } },
      ],
      after: [],
    };
    const created = await api.run(workflow);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const snapshot = await api.waitFor(created.body.run.runId);
    assert.equal(snapshot.run.state, 'succeeded', JSON.stringify(snapshot.instances.map(item => [item.nodeInstanceId, item.state])));
    assert.deepEqual(snapshot.loops.map(loop => [loop.state, loop.iteration]), [['finished', 3]]);
    const docs = await api.artifactJson((await api.artifactJson(snapshot.instances.find(item => item.nodeId === 'docs').outputs.artifactId)).values.value.artifact.artifactId);
    assert.deepEqual(docs.entries.map(entry => entry.path), ['b.md', 'notes/a.md']);
    const record = JSON.parse(await outputsOf(api, snapshot, 'record', 'value'));
    assert.match(record.summary, /codex turn 1: Summarize the attached notes\..* \| Summarize the attached notes\.$/);
    assert.equal(record.files.kind, 'ArtifactSet');
    const captured = await api.artifactJson(record.files.manifest.artifactId);
    assert.deepEqual(captured.entries.map(entry => entry.path), ['out.txt']);
    assert.equal(await api.artifactText(captured.entries[0].artifact.artifactId), 'written by codex\n');
    const events = await api.events(snapshot.run.runId);
    const inputs = await api.artifactJson(events.find(event => event.type === 'attempt.inputs_committed' && event.nodeInstanceId === 'reader').payload.manifest.artifactId);
    assert.ok(inputs.promptSources.some(source => source.kind === 'attachments'));
    assert.match(await api.artifactText(inputs.prompt.artifactId), /Attached files \(read-only copies\):\n- b\.md → .*\n- notes\/a\.md → /);
    assert.equal(await outputsOf(api, snapshot, 'count', 'result'), record.summary);
  } finally { await api.close(); }
});

test('a missing input file fails with input_unavailable and a path escape is rejected before running', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const base = (paths, id) => ({
      schemaVersion: 1, workflowId: id, capabilities: ['core-v1', 'loops-v1'], settings: { nativeConfiguration: 'restricted' },
      nodes: [{ id: 'files', type: 'file-input', config: { mode: 'files', paths } }, { id: 'view', type: 'result-viewer', config: {} }],
      edges: [{ id: 'e', source: { nodeId: 'files', port: 'value' }, target: { nodeId: 'view', port: 'value' } }], after: [],
    });
    const escaped = await api.run(base(['../outside.txt'], 'escape'));
    assert.equal(escaped.status, 422);
    const missing = await api.run(base(['missing.txt'], 'missing'));
    const snapshot = await api.waitFor(missing.body.run.runId);
    assert.equal(snapshot.run.state, 'waiting_for_user');
    await api.closeRun(snapshot.run.runId);
    const events = await api.events(snapshot.run.runId);
    assert.equal(events.find(event => event.type === 'attempt.error').payload.code, 'input_unavailable');
  } finally { await api.close(); }
});

test('runs created by the M2 runtime write journal v2; recovery is refused outside waiting_for_user', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop());
    const runId = created.body.run.runId;
    await api.waitFor(runId);
    const events = await api.events(runId);
    assert.ok(events.every(event => event.schemaVersion === 2));
    const late = await api.recover(runId, { action: 'close' });
    assert.equal(late.status, 409);
    const stopEnded = await api.call('POST', `/api/v2/runs/${runId}/nodes/refine/stop`, { requestId: randomUUID() });
    assert.equal(stopEnded.status, 409);
  } finally { await api.close(); }
});

test('restart recovery interrupts a running loop and its body attempt without retrying', async () => {
  const { Engine } = await import('../core/engine.mjs');
  const { fixtureAdapters } = await import('./helpers.mjs');
  const { killTree } = await import('../core/processes.mjs');
  const api = await startTestRunner();
  await api.workspace();
  const created = await api.run(reviewLoop({ writer: 'fixture-slow-30' }));
  const runId = created.body.run.runId;
  await api.waitFor(runId, (_, snapshot) => snapshot.instances.some(item => item.nodeInstanceId === 'refine/1/writer' && item.state === 'running'));
  const engineA = api.runner.engine;
  const pid = engineA.store.get(`SELECT process_id FROM attempts WHERE run_id = ? AND node_instance_id = 'refine/1/writer'`, runId).process_id;
  for (const record of engineA.processes.values()) { clearTimeout(record.timer); record.child.removeAllListeners('close'); record.child.stdout.removeAllListeners('data'); record.child.stderr.removeAllListeners('data'); }
  for (const state of engineA.runs.values()) for (const loop of state.loops.values()) clearInterval(loop.timer);
  engineA.runs.clear();
  await killTree(pid);
  const engine = new Engine({ root: api.root, adapters: fixtureAdapters(join(api.root, 'fixture-state')) });
  await engine.initialize();
  assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', runId).state, 'interrupted');
  assert.equal(engine.store.get(`SELECT state FROM loop_executions WHERE run_id = ?`, runId).state, 'interrupted');
  const states = Object.fromEntries(engine.latestAttempts(runId).map(item => [item.node_instance_id, item.state]));
  assert.equal(states.refine, 'interrupted'); assert.equal(states['refine/1/writer'], 'interrupted'); assert.equal(states['refine/1/checker'], 'canceled');
  assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND ordinal > 1', runId).n, 0, 'no automatic retry');
  engine.store.close();
  engineA.processes.clear();
  await api.close();
});

test('an M1 store migrates to the latest migration, keeps its v1 journal and backfills M6 identities', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, readdirSync, writeFileSync } = await import('node:fs');
  const { MIGRATION_PATHS, Store } = await import('../core/store.mjs');
  const { sha256 } = await import('../core/canonical.mjs');
  const root = mkdtempSync(join(resolve(import.meta.dirname, '../../.deszo/tests'), 'm1-store-'));
  mkdirSync(join(root, 'store', 'objects'), { recursive: true });
  const ddl = readFileSync(resolve(import.meta.dirname, '../../docs/storage/m1.sql'), 'utf8');
  const snapshot = Buffer.from(JSON.stringify({ workflowId: 'wf', nodes: [{ id: 'cache-live', type: 'cache' }] }));
  writeFileSync(join(root, 'store', 'objects', 'x'), snapshot);
  const db = new DatabaseSync(join(root, 'store', 'state.sqlite'));
  db.exec(ddl);
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(sha256(Buffer.from(ddl)), '2026-10-13T00:00:00Z');
  db.prepare("INSERT INTO artifacts VALUES ('a', ?, ?, 'application/json', 'objects/x', '2026-10-13T00:00:00Z')").run(sha256(snapshot), snapshot.length);
  db.prepare("INSERT INTO workspaces VALUES ('w', 'C:\\w', ?, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')").run('a'.repeat(64));
  db.prepare("INSERT INTO workflows VALUES ('wf', 'a', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')").run();
  db.prepare("INSERT INTO runs VALUES ('r', 'wf', 'w', 'a', 'a', ?, 'failed', 1, '2026-10-13T00:00:00Z')").run('a'.repeat(64));
  db.prepare("INSERT INTO node_instances VALUES ('r', 'n', 'n', 'text', 'failed')").run();
  db.prepare("INSERT INTO journal_events VALUES ('r', 1, 'e', 'run.created', NULL, NULL, '{}', ?, 2, '2026-10-13T00:00:00Z')").run(sha256(Buffer.from('{}')));
  db.close();

  const v5 = new Store(root, { migrations: MIGRATION_PATHS.slice(0, 5).map(path => readFileSync(path, 'utf8')) });
  v5.run("INSERT INTO attempts(id,run_id,node_instance_id,ordinal,state) VALUES('pin-attempt','r','n',1,'succeeded')");
  for (const nodeId of ['cache-live', 'cache-orphan']) v5.run(`INSERT INTO cache_pins(workflow_id,node_id,value_json,source_run_id,source_attempt_id,fingerprint,pinned_at)
    VALUES('wf',?,'{}','r','pin-attempt',?,?)`, nodeId, 'b'.repeat(64), '2026-10-13T00:00:00Z');
  v5.close();

  const store = new Store(root);
  // The store reaches the end of the migration catalogue (m14 added the continuation tables after this test was written).
  assert.equal(store.get('SELECT MAX(version) AS v FROM schema_migrations').v, MIGRATION_PATHS.length);
  assert.equal(store.get('SELECT kind FROM runs WHERE id = ?', 'r').kind, 'workflow');
  assert.equal(store.get('SELECT revision FROM workflows WHERE id = ?', 'wf').revision, 1);
  assert.deepEqual({ ...store.get('SELECT state, journal_version FROM runs WHERE id = ?', 'r') }, { state: 'failed', journal_version: 1 });
  assert.deepEqual(store.readEvents('r'), [{}]);
  assert.ok(readdirSync(join(root, 'store')).some(name => /^state\.v1\.\d+\.bak\.sqlite$/.test(name)), 'a backup precedes the migration');
  store.close();

  const engine = new Engine({ root });
  try {
    await engine.initialize();
    assert.ok(engine.store.get('SELECT store_id FROM runtime_identity WHERE singleton = 1').store_id);
    const current = engine.store.get("SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = 'wf' AND node_id = 'cache-live' AND active = 1");
    assert.ok(current?.incarnation_id, 'an existing Cache node receives an active incarnation');
    assert.equal(engine.store.get("SELECT incarnation_id FROM cache_pins WHERE workflow_id = 'wf' AND node_id = 'cache-live'").incarnation_id, current.incarnation_id);
    const orphan = engine.store.get("SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = 'wf' AND node_id = 'cache-orphan' AND active = 0");
    assert.ok(orphan?.incarnation_id, 'a removed Cache pin receives a retired orphan incarnation');
    assert.equal(engine.store.get("SELECT incarnation_id FROM cache_pins WHERE workflow_id = 'wf' AND node_id = 'cache-orphan'").incarnation_id, orphan.incarnation_id);
  } finally { engine.store.close(); }
});

test('Replay projects each step from the journal alone; later outputs stay invisible', async () => {
  const { project, replaySteps, describeEvent } = await import('../../shared/replay.mjs');
  const api = await startTestRunner();
  try {
    await api.workspace();
    const created = await api.run(reviewLoop());
    await api.waitFor(created.body.run.runId);
    const events = await api.events(created.body.run.runId);
    const steps = replaySteps(events);
    assert.ok(steps.length < events.length, 'log batches are skipped by default');
    assert.equal(replaySteps(events, { includeLogs: true }).length, events.length);
    const firstReturn = events.findIndex(event => event.type === 'loop.iteration_returned');
    const atReturn = project(events, firstReturn);
    assert.equal(atReturn.loops.get('refine').state, 'running');
    assert.equal(atReturn.loops.get('refine').iterations[0].continue, true);
    assert.equal(atReturn.instances.get('final-draft').outputs, null, 'future outputs are not visible yet');
    assert.equal(atReturn.instances.has('refine/2/writer'), false, 'iteration 2 is not planned yet');
    const end = project(events, events.length - 1);
    assert.equal(end.run, 'succeeded');
    assert.equal(end.loops.get('refine').state, 'finished');
    assert.ok(end.instances.get('final-draft').outputs);
    assert.equal(end.instances.get('refine/2/writer').state, 'succeeded');
    assert.ok(events.every(event => typeof describeEvent(event) === 'string'));
  } finally { await api.close(); }
});
