// Negative and boundary cases for Engine-native continuation (ADR-0008). Each case uses the Engine's real routes and durable state;
// restarts are real runner restarts on the same profile. The cases are deliberately small: duplicate reconciliation, busy
// workspace, failed repair, restart in the continuation window, lifecycle receipt and proposal refusals, missing receipt after
// restart, and managed shutdown attribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestRunner, singleAgent } from './helpers.mjs';

const GOOD = createHash('sha256').update('negative candidate identity A').digest('hex');
const OTHER = createHash('sha256').update('negative candidate identity B').digest('hex');

function workflow(workflowId, nodes, edges) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [
    { id: 'request', type: 'text', config: { value: `${workflowId} request` } }, ...nodes, { id: 'result', type: 'result-viewer', config: {} }], edges, after: [] };
}
const agent = (id, provider, model, extra = {}) => ({ id, type: 'agent', config: { provider, model, timeoutSeconds: 120, output: { format: 'text' }, ...extra } });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const parentWorkflow = () => workflow('parent-delivery', [agent('developer', 'codex', 'fixture-echo'), agent('watcher', 'claude', 'fixture-fail-once'), agent('judge', 'codex', 'fixture-echo')], [
  edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-result', 'judge', 'text', 'result', 'value')]);
const repairWorkflow = ({ developer = 'fixture-echo', watcher = 'fixture-echo', judge = 'fixture-lifecycle-proposal' } = {}) => workflow('deszo-self-repair', [
  agent('developer', 'codex', developer), agent('watcher', 'claude', watcher), agent('judge', 'codex', judge, { role: 'judge' }), agent('finalize', 'claude', 'fixture-echo')], [
  edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-finalize', 'judge', 'text', 'finalize', 'prompt'), edge('finalize-result', 'finalize', 'text', 'result', 'value')]);

// Starts a parent that is suspended for repair, and its linked repair, then waits until the repair is held at its gate.
async function suspendedParent(api, { repair = repairWorkflow(), candidateOnFile = GOOD } = {}) {
  await api.workspace('main'); await api.workspace('main-repair');
  await writeFile(join(api.runner.connection.scratchRoot, 'main-repair', 'candidate.json'), JSON.stringify({ candidateDigest: candidateOnFile, continuationCheckpointId: 'chk-negative-1' }));
  const repairSaved = await api.save(repair);
  const started = await api.run(parentWorkflow(), 'main');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const parentRunId = started.body.run.runId;
  await api.waitFor(parentRunId, run => run.state === 'waiting_for_user');
  const link = await api.call('POST', `/api/v2/runs/${parentRunId}/linked-repair`, { requestId: randomUUID(), failedNodeInstanceId: 'watcher',
    repairWorkflowId: repair.workflowId, repairWorkflowSnapshotSha256: repairSaved.snapshotSha256, repairWorkspaceId: 'main-repair',
    candidateDigest: GOOD, continuationCheckpointId: 'chk-negative-1' });
  assert.equal(link.status, 202, JSON.stringify(link.body));
  return { parentRunId, repairRunId: link.body.repairRunId, linkId: link.body.linkId };
}

const receipt = (api, repairRunId, operationId, candidateDigest = GOOD) => {
  try {
    return api.runner.engine.applyLifecycleReceipt(repairRunId,
      { requestId: randomUUID(), operationId, candidateDigest, outcome: 'verified', receiptId: randomUUID() },
      { hostAuthenticated: true, receiptEvidence: { fixtureHost: true } });
  } catch (error) {
    return { status: error.status ?? 500, body: { code: error.code ?? 'internal_error', message: error.message } };
  }
};

function view(root) {
  const db = new DatabaseSync(join(root, 'store', 'state.sqlite'), { readOnly: true });
  try {
    return {
      runs: db.prepare('SELECT id, workflow_id, workspace_id, state FROM runs').all(),
      attempts: db.prepare(`SELECT a.run_id, n.node_id, a.state, a.ordinal, a.invocation_artifact_id IS NOT NULL AS invoked, a.id FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id`).all(),
      links: db.prepare('SELECT * FROM run_links').all(),
      operations: db.prepare('SELECT * FROM lifecycle_operations').all(),
      events: db.prepare("SELECT run_id, event_type, envelope_json FROM journal_events WHERE event_type LIKE 'continuation.%'").all().map(row => ({ runId: row.run_id, type: row.event_type, payload: JSON.parse(row.envelope_json).payload })),
      errors: db.prepare("SELECT a.run_id, n.node_id, a.state, a.id FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id WHERE a.state = 'failed'").all(),
    };
  } finally { db.close(); }
}
const invoked = (v, nodeId, runId) => v.attempts.filter(a => a.node_id === nodeId && a.run_id === runId && a.invoked).length;

// The repair's Judge is the designated node; its lifecycle gate is the operation in lifecycle_operations.
const operationFor = (v, runId) => v.operations.find(op => op.run_id === runId);

test('negative: duplicate startup reconciliation creates no second continuation', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId, linkId } = await suspendedParent(api);
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const operation = operationFor(view(api.root), repairRunId);
    assert.equal((await receipt(api, repairRunId, operation.id)).status, 200);
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
    const engine = api.runner.engine;
    const before = view(api.root);
    engine.reconcileContinuations(); engine.reconcileContinuations();
    assert.equal(engine.resumeLinkedParent(before.links.find(item => item.id === linkId)), false, 'an already resumed link cannot be claimed again');
    const after = view(api.root);
    assert.equal(after.attempts.length, before.attempts.length, 'reconciliation created no attempt');
    assert.equal(after.runs.length, before.runs.length, 'reconciliation created no run');
    assert.equal(after.events.filter(e => e.type === 'continuation.parent_resumed').length, 1, 'the parent was resumed exactly once');
    assert.equal(invoked(after, 'developer', parentRunId), 1, 'the parent Developer was not re-invoked');
  } finally { await api.close(); }
});

test('negative: a suspended parent and its repair each block a second run in their own workspace', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId } = await suspendedParent(api);
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const parentAgain = await api.run(parentWorkflow(), 'main');
    assert.equal(parentAgain.status, 409, 'the suspended parent occupies workspace main');
    const repairAgain = await api.run(repairWorkflow(), 'main-repair');
    assert.equal(repairAgain.status, 409, 'the held repair occupies workspace main-repair');
    const v = view(api.root);
    assert.equal(v.runs.filter(run => run.workspace_id === 'main' && ['waiting_for_user', 'running'].includes(run.state)).length, 1);
    assert.equal(v.runs.filter(run => run.id === parentRunId).length, 1, 'no run was created by the refused requests');
  } finally { await api.close(); }
});

test('negative: a failed repair never resumes its parent, and closing it records the failure durably', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId, linkId } = await suspendedParent(api, { repair: repairWorkflow({ developer: 'fixture-fail' }) });
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    assert.equal(view(api.root).links.find(item => item.id === linkId).state, 'open', 'a paused repair keeps the link open');
    await api.closeRun(repairRunId);
    const v = view(api.root);
    assert.equal(v.links.find(item => item.id === linkId).state, 'repair_failed');
    assert.equal(v.runs.find(run => run.id === parentRunId).state, 'waiting_for_user', 'the parent stays suspended');
    assert.equal(v.attempts.filter(a => a.run_id === parentRunId && a.node_id === 'watcher').length, 1, 'the parent Watcher was not retried');
    assert.equal(v.events.filter(e => e.type === 'continuation.parent_resumed').length, 0);
  } finally { await api.close(); }
});

test('negative: a restart in the continuation window (repair completed, parent not yet resumed) finishes the parent exactly once', async () => {
  const api = await startTestRunner();
  const root = api.root;
  let repairDone;
  try {
    const { parentRunId, repairRunId, linkId } = await suspendedParent(api);
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const operation = operationFor(view(root), repairRunId);
    // The continuation step is withheld for this engine instance, so the durable state is exactly the crash window.
    const engine = api.runner.engine;
    engine.resumeLinkedParent = () => false;
    assert.equal((await receipt(api, repairRunId, operation.id)).status, 200);
    repairDone = await api.waitFor(repairRunId, run => run.state === 'succeeded');
    const window = view(root);
    assert.equal(window.links.find(item => item.id === linkId).state, 'repair_completed', 'the repair completed durably');
    assert.equal(window.runs.find(run => run.id === parentRunId).state, 'waiting_for_user', 'the parent is not yet resumed');
    await api.close();
    const restarted = await startTestRunner({ root });
    try {
      const parent = await restarted.waitFor(parentRunId, run => run.state === 'succeeded');
      assert.equal(parent.run.state, 'succeeded');
      const v = view(root);
      assert.equal(v.links.find(item => item.id === linkId).state, 'resumed');
      assert.equal(v.events.filter(e => e.type === 'continuation.parent_resumed').length, 1, 'the missed transition happened exactly once');
      assert.equal(v.attempts.filter(a => a.run_id === parentRunId && a.node_id === 'watcher').map(a => a.state).join(','), 'failed,succeeded');
      assert.equal(invoked(v, 'developer', parentRunId), 1);
    } finally { await restarted.close(); }
  } finally { if (!repairDone) await api.close().catch(() => {}); }
});

test('negative: a receipt for another candidate is refused and the gate holds until the matching receipt arrives', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId } = await suspendedParent(api);
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const operation = operationFor(view(api.root), repairRunId);
    const wrong = await receipt(api, repairRunId, operation.id, OTHER);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'lifecycle_candidate_mismatch');
    assert.equal(view(api.root).operations.find(op => op.id === operation.id).state, 'intent', 'a refused receipt changes nothing');
    assert.equal(view(api.root).runs.find(run => run.id === repairRunId).state, 'waiting_for_user');
    assert.equal((await receipt(api, repairRunId, operation.id)).status, 200);
    await api.waitFor(parentRunId, run => run.state === 'succeeded');
  } finally { await api.close(); }
});

test('negative: after a restart without the receipt, nothing resumes and nothing is assumed', async () => {
  const api = await startTestRunner();
  const root = api.root;
  try {
    const { parentRunId, repairRunId, linkId } = await suspendedParent(api);
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const judgeBefore = invoked(view(root), 'judge', repairRunId);
    await api.close();
    const restarted = await startTestRunner({ root });
    try {
      await new Promise(done => setTimeout(done, 1_000));
      const v = view(root);
      assert.equal(v.runs.find(run => run.id === repairRunId).state, 'waiting_for_user', 'the repair stays at its gate');
      assert.equal(v.runs.find(run => run.id === parentRunId).state, 'waiting_for_user', 'the parent stays suspended');
      assert.equal(v.links.find(item => item.id === linkId).state, 'open');
      assert.equal(invoked(v, 'finalize', repairRunId), 0, 'the final node did not run without a receipt');
      assert.equal(invoked(v, 'judge', repairRunId), judgeBefore, 'the Judge was not re-run');
    } finally { await restarted.close(); }
  } finally { /* closed above */ }
});

test('negative: a Developer cannot propose a lifecycle action', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId } = await suspendedParent(api, { repair: repairWorkflow({ developer: 'fixture-lifecycle-proposal' }) });
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const v = view(api.root);
    const developer = v.errors.find(e => e.run_id === repairRunId && e.node_id === 'developer');
    assert.ok(developer, 'the Developer attempt failed');
    const developerAttempt = api.runner.engine.latestAttempt(repairRunId, 'developer');
    const typed = api.runner.engine.store.get('SELECT outcome_json FROM failure_outcomes WHERE attempt_id = ?', developerAttempt.id);
    const outcome = JSON.parse(typed.outcome_json);
    assert.equal(outcome.source, 'workflow');
    assert.equal(outcome.category, 'task_failure');
    assert.equal(outcome.canonicalCode, 'lifecycle_unauthorized');
    const errorRow = (await api.call('GET', `/api/v2/runs/${repairRunId}/events/page?afterSequence=0&limit=200`)).body;
    const codes = JSON.stringify(errorRow);
    assert.ok(codes.includes('lifecycle_unauthorized'), 'the refusal is named');
    assert.equal(operationFor(v, repairRunId), undefined, 'no lifecycle intent was recorded');
    assert.equal(v.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
  } finally { await api.close(); }
});

test('negative: a Watcher cannot propose a lifecycle action', async () => {
  const api = await startTestRunner();
  try {
    const { parentRunId, repairRunId } = await suspendedParent(api, { repair: repairWorkflow({ watcher: 'fixture-lifecycle-proposal' }) });
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const v = view(api.root);
    assert.ok(v.errors.some(e => e.run_id === repairRunId && e.node_id === 'watcher'), 'the Watcher attempt failed');
    const events = JSON.stringify(await api.call('GET', `/api/v2/runs/${repairRunId}/events/page?afterSequence=0&limit=200`));
    assert.ok(events.includes('lifecycle_unauthorized'), 'the refusal is named');
    assert.equal(operationFor(v, repairRunId), undefined, 'no lifecycle intent was recorded');
    assert.equal(v.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
  } finally { await api.close(); }
});

test('negative: the Judge may not propose a candidate other than the linked one', async () => {
  const api = await startTestRunner();
  try {
    const { repairRunId, parentRunId } = await suspendedParent(api, { candidateOnFile: OTHER });
    await api.waitFor(repairRunId, run => run.state === 'waiting_for_user');
    const v = view(api.root);
    assert.equal(operationFor(v, repairRunId), undefined, 'no lifecycle intent was recorded for the wrong candidate');
    assert.ok(v.errors.some(e => e.run_id === repairRunId && e.node_id === 'judge'), 'the Judge attempt was refused');
    assert.equal(v.runs.find(run => run.id === parentRunId).state, 'waiting_for_user');
    const events = JSON.stringify(await api.call('GET', `/api/v2/runs/${repairRunId}/events/page?afterSequence=0&limit=200`));
    assert.ok(events.includes('lifecycle_candidate_mismatch'));
  } finally { await api.close(); }
});

test('negative: managed shutdown interrupts an in-flight attempt, journals the cause honestly, and never reruns it', async () => {
  const api = await startTestRunner();
  const root = api.root;
  try {
    await api.workspace('main');
    const started = await api.run(workflow('slow-run', [agent('slow', 'codex', 'fixture-slow-5')], [edge('request-slow', 'request', 'text', 'slow', 'prompt'), edge('slow-result', 'slow', 'text', 'result', 'value')]), 'main');
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    await api.waitFor(runId, run => run.state === 'running', 20_000).catch(() => {});
    await new Promise(done => setTimeout(done, 1500));
    await api.close();
    const restarted = await startTestRunner({ root });
    try {
      const attempt = view(root).attempts.find(a => a.run_id === runId && a.node_id === 'slow');
      assert.equal(attempt.state, 'interrupted', 'a managed shutdown interrupts the attempt, not cancels it');
      const reason = JSON.stringify(view(root).events) + JSON.stringify(restarted.runner.engine.store.all("SELECT envelope_json FROM journal_events WHERE event_type = 'attempt.state_changed'").map(row => row.envelope_json));
      assert.ok(reason.includes('Runtime shutdown; the attempt outcome is unknown.'), 'the cause is journaled as a runtime shutdown');
      assert.ok(!reason.includes('Stopped by the user.'), 'the shutdown is not journaled as a user Stop');
      assert.equal(view(root).runs.find(run => run.id === runId).state, 'interrupted');
    } finally { await restarted.close(); }
  } finally { /* closed above */ }
});
