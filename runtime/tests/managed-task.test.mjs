import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startTestRunner } from './helpers.mjs';
import { emptyTaskConfig } from '../../shared/task-config.mjs';
import { isAlive } from '../core/processes.mjs';

function taskWorkflow({ request = 'Implement the feature.', boundary = 'candidate', baseCommit, expectedOldValue = null, independent = false, bounds = {} } = {}) {
  const config = emptyTaskConfig();
  for (const role of Object.values(config.roles)) role.model = 'fixture-managed-task';
  config.scope.documentation = [];
  config.scope.production = ['src/**', 'docs/storage/**'];
  config.projectPolicy = { criticalAreas: ['docs/storage/*.sql'], publicContracts: [], requireIndependentAcceptance: independent };
  if (independent) config.roles.businessAccepter = { role: 'businessAccepter', provider: 'codex', model: 'fixture-managed-task', effort: 'max', timeoutSeconds: 60 };
  Object.assign(config.bounds, bounds);
  config.checks = [{ id: 'feature', command: process.execPath, args: ['--test', 'tests/feature.test.mjs'], expectedExitCode: 0, timeoutMs: 10000, criteria: ['AC-1'] }];
  config.delivery = boundary === 'candidate' ? { boundary } : { boundary, baseCommit, targetBranchRef: 'refs/heads/codex/managed-feature', expectedOldValue,
    commitPolicy: { authorName: 'Fixture Author', authorEmail: 'fixture@example.com', message: 'Verified managed task' } };
  return { schemaVersion: 1, workflowId: `managed-${randomUUID().slice(0, 8)}`, capabilities: ['core-v1', 'loops-v1', 'task-planning-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: request } }, { id: 'source', type: 'file-input', config: { mode: 'files', paths: ['README.md', 'src/feature.mjs'] } },
      { id: 'task', type: 'task', config }, { id: 'answer', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-task', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'task', port: 'request' } },
      { id: 'source-task', source: { nodeId: 'source', port: 'value' }, target: { nodeId: 'task', port: 'source' } },
      { id: 'task-answer', source: { nodeId: 'task', port: 'summary' }, target: { nodeId: 'answer', port: 'value' } }], after: [] };
}
async function setup() {
  const api = await startTestRunner(); const workspace = await api.workspace();
  writeFileSync(join(workspace.cwd, 'README.md'), 'Managed task fixture\n');
  mkdirSync(join(workspace.cwd, 'src'), { recursive: true });
  writeFileSync(join(workspace.cwd, 'src/feature.mjs'), 'export const feature=()=>1;\n');
  return { api, workspace };
}
function git(cwd, args, required = true) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (required) assert.equal(result.status, 0, result.stderr || result.stdout);
  return required ? result.stdout.trim() : result;
}
async function summary(api, runId) {
  const attempt = api.runner.engine.latestAttempt(runId, 'task');
  const outputs = await api.artifactJson(attempt.outputs_artifact_id);
  return api.artifactJson(outputs.values.summary.artifact.artifactId);
}

test('managed task runs assessment, deterministic planning, isolated test/code roles, checks and authoritative acceptance through Engine', async () => {
  const { api } = await setup();
  try {
    const response = await api.run(taskWorkflow());
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const id = response.body.run.runId, finished = await api.waitFor(id, undefined, 60000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished));
    const result = await summary(api, id);
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.plan.classification.winningClassification, 'local');
    assert.ok(result.plan.selectedStages.includes('prepare'), 'A declared test scope requires the independent test author.');
    assert.ok(result.work.attempts >= 8);
    assert.ok(result.work.outputBytes > 0);
    assert.equal(result.plan.workflowBinding.taskNodeId, 'task');
    assert.equal(result.plan.workflowBinding.snapshot.sha256, finished.run.workflowSnapshot.sha256);
    assert.equal(result.candidateFloorEvaluation.status, 'passed'); assert.equal(result.candidateFloorEvaluation.planRevisionId, result.plan.planRevisionId);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM acceptance_records WHERE run_id=?', id).n, 1);
    const bindings = api.runner.engine.store.all('SELECT context_node_id,binding_id FROM run_context_bindings WHERE run_id=?', id);
    assert.ok(bindings.some(row => row.context_node_id.endsWith('/review-code')));
    assert.ok(bindings.some(row => row.context_node_id.endsWith('/review-tests')));
    assert.equal(new Set(bindings.map(row => row.binding_id)).size, bindings.length);
    assert.ok(api.runner.engine.runEvidence(id).length > 0);
    const firstWork = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body.work;
    await new Promise(done => setTimeout(done, 30));
    const laterWork = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body.work;
    assert.equal(laterWork.elapsedMilliseconds, firstWork.elapsedMilliseconds, 'Completed task timing must not keep growing while history is inspected.');
  } finally { await api.close(); }
});

test('managed task delivers a byte-verified feature branch without changing the caller checkout', async () => {
  const { api, workspace } = await setup();
  try {
    const launches = [], engine = api.runner.engine, launchContained = engine.launchContained;
    engine.launchContained = function (runId, invocation) { launches.push({ runId, command: invocation.command, args: invocation.args }); return launchContained.call(this, runId, invocation); };
    git(workspace.cwd, ['init', '-b', 'main']); git(workspace.cwd, ['config', 'user.name', 'Fixture']); git(workspace.cwd, ['config', 'user.email', 'fixture@example.com']);
    git(workspace.cwd, ['config', 'core.autocrlf', 'false']); git(workspace.cwd, ['config', 'commit.gpgSign', 'false']); git(workspace.cwd, ['add', '.']); git(workspace.cwd, ['commit', '-m', 'base']);
    const baseCommit = git(workspace.cwd, ['rev-parse', 'HEAD']);
    const response = await api.run(taskWorkflow({ boundary: 'verified_branch', baseCommit }));
    const id = response.body.run.runId, finished = await api.waitFor(id, undefined, 90000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished));
    const result = await summary(api, id);
    assert.equal(result.outcome, 'READY_FOR_MERGE');
    assert.equal(result.acceptanceRecords.length, 2);
    assert.equal(git(workspace.cwd, ['rev-parse', 'refs/heads/codex/managed-feature']), result.deliveryResult.verifiedCommitId);
    assert.equal(git(workspace.cwd, ['status', '--porcelain']), '');
    assert.equal(git(workspace.cwd, ['rev-parse', 'HEAD']), baseCommit);
    assert.equal(api.runner.engine.store.get('SELECT phase FROM delivery_operations WHERE run_id=?', id).phase, 'completed');
    assert.ok(result.deliveryResult.commandEvidence.length > 0);
    assert.ok(launches.some(item => item.command === 'git' && item.args.includes('clone')));
    assert.ok(launches.some(item => item.command === 'git' && item.args.includes('update-ref')));
    assert.ok(launches.filter(item => item.args.includes('--test')).length >= 2, 'Both verification and delivery smoke use the contained launcher.');
    const nav = await api.call('GET', `/api/v2/runs/${id}/tasks/task`);
    assert.equal(nav.status, 200); assert.equal(nav.body.deliveryOperation.phase, 'completed'); assert.ok(nav.body.stateArtifact.artifactId);
    const audit = await api.call('POST', `/api/v2/runs/${id}/audit-bundles`, { requestId: randomUUID(), profile: 'private-local' });
    assert.equal(audit.status, 201, JSON.stringify(audit.body));
    const offline = JSON.parse(readFileSync(join(audit.body.directory, 'tasks.json'), 'utf8'));
    assert.equal(offline.acceptance.length, 2); assert.equal(offline.operations[0].phase, 'completed');
    const evidenceRow = engine.store.get('SELECT content_artifact_id FROM task_evidence WHERE task_execution_id=? LIMIT 1', result.taskExecutionId);
    const evidenceDigest = engine.store.artifactRow(evidenceRow.content_artifact_id).sha256;
    assert.ok(existsSync(join(audit.body.directory, 'objects', evidenceDigest)), 'Offline reference closure includes criterion evidence content.');
  } finally { await api.close(); }
});

test('check and reviewer repair loops consume the shared bound and require fresh evidence before acceptance', async () => {
  const { api } = await setup();
  try {
    const response = await api.run(taskWorkflow({ request: 'REPAIR_CHECK REPAIR_REVIEW', independent: true }));
    const id = response.body.run.runId, finished = await api.waitFor(id, undefined, 90000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished));
    const result = await summary(api, id);
    assert.equal(result.work.repairs, 2); assert.ok(result.plan.independentAcceptance);
    const accept = api.runner.engine.store.readJson(api.runner.engine.store.get('SELECT record_artifact_id FROM acceptance_records WHERE run_id=?', id).record_artifact_id);
    assert.equal(accept.accepter.role, 'businessAccepter'); assert.equal(accept.accepter.independent, true);
    assert.ok(api.runner.engine.store.get("SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND node_instance_id LIKE '%/triage'", id).n > 0);
    assert.ok(api.runner.engine.store.get("SELECT COUNT(*) AS n FROM execution_evidence WHERE run_id=? AND outcome='failed'", id).n > 0);
    const execution = api.runner.engine.store.readJson(api.runner.engine.store.get('SELECT state_artifact_id FROM managed_tasks WHERE run_id=?', id).state_artifact_id);
    assert.ok(accept.criteria.every(criterion => criterion.evidenceRefs.every(reference => execution.evidenceIds.includes(reference.id))), 'No earlier repair approval can be carried implicitly.');
  } finally { await api.close(); }
});

test('incomplete review, absent dependencies, scope violations and reviewer mutations block acceptance without fake repair', async t => {
  for (const request of ['REVIEW_INCOMPLETE', 'MISSING_CONTEXT', 'SCOPE_VIOLATION', 'REVIEW_MUTATION']) await t.test(request, async () => {
    const { api } = await setup();
    try {
      const response = await api.run(taskWorkflow({ request })), id = response.body.run.runId;
      const finished = await api.waitFor(id, undefined, 60000);
      assert.equal(finished.run.state, 'waiting_for_user', JSON.stringify(finished));
      const nav = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body;
      assert.equal(nav.state, 'paused'); assert.equal(nav.work.repairs, 0); assert.ok(nav.incompleteReason);
      assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM acceptance_records WHERE run_id=?', id).n, 0);
    } finally { await api.close(); }
  });
});

test('aggregate attempts include preparation and cannot be reset through retry', async () => {
  const { api } = await setup();
  try {
    const response = await api.run(taskWorkflow({ bounds: { maxAttempts: 3 } })), id = response.body.run.runId;
    const finished = await api.waitFor(id, undefined, 60000);
    assert.equal(finished.run.state, 'waiting_for_user', JSON.stringify(finished));
    const nav = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body;
    assert.equal(nav.work.attempts, 3); assert.equal(nav.incompleteReason, 'aggregate_budget_exhausted');
    const retried = await api.recover(id, { action: 'retry', nodeInstanceId: nav.current, binding: 'fresh' });
    assert.equal(retried.status, 202);
    await api.waitFor(id, undefined, 30000);
    assert.equal((await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body.work.attempts, 3);
  } finally { await api.close(); }
});

test('the aggregate elapsed deadline interrupts a running Agent sooner than its local timeout and cannot be reset', async () => {
  const { api } = await setup();
  try {
    const started = Date.now(), response = await api.run(taskWorkflow({ request: 'SLOW_DEFINE', bounds: { maxElapsedSeconds: 1 } })), id = response.body.run.runId;
    const finished = await api.waitFor(id, undefined, 15000);
    assert.equal(finished.run.state, 'waiting_for_user'); assert.ok(Date.now() - started < 4500);
    const nav = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body;
    assert.equal(nav.incompleteReason, 'aggregate_budget_exhausted'); assert.equal(nav.work.attempts, 1);
    assert.equal((await api.recover(id, { action: 'retry', nodeInstanceId: nav.current, binding: 'fresh' })).status, 409);
  } finally { await api.close(); }
});

async function waitForFile(path, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')); await new Promise(done => setTimeout(done, 50)); }
  throw new Error('A delivery smoke child did not start.');
}

test('root, task and command Stop during actual delivery smoke terminate child trees and never publish a branch', async t => {
  for (const mode of ['root', 'task', 'command']) await t.test(mode, async () => {
    const scoped = mode !== 'root';
    const { api, workspace } = await setup();
    try {
      git(workspace.cwd, ['init', '-b', 'main']); git(workspace.cwd, ['config', 'user.name', 'Fixture']); git(workspace.cwd, ['config', 'user.email', 'fixture@example.com']);
      git(workspace.cwd, ['config', 'core.autocrlf', 'false']); git(workspace.cwd, ['config', 'commit.gpgSign', 'false']); git(workspace.cwd, ['add', '.']); git(workspace.cwd, ['commit', '-m', 'base']);
      const baseCommit = git(workspace.cwd, ['rev-parse', 'HEAD']);
      const workflow = taskWorkflow({ boundary: 'verified_branch', baseCommit });
      const marker = join(api.root, 'smoke-started.json');
      workflow.nodes.find(node => node.type === 'task').config.checks[0].args = ['-e', `if(require('node:path').basename(process.cwd()).startsWith('delivery-')){const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>process.stdout.write('smoke alive\\n'),1000);}else{console.log('candidate verified');}`];
      const response = await api.run(workflow), id = response.body.run.runId;
      const pids = await waitForFile(marker);
      assert.ok(isAlive(pids.parent) && isAlive(pids.child));
      const childId = [...api.runner.engine.processes.entries()].find(([, record]) => record.child?.pid === pids.parent)?.[0];
      const stopTarget = mode === 'command' ? api.runner.engine.store.get('SELECT node_instance_id FROM attempts WHERE id=?', childId).node_instance_id : 'task';
      const stopId = randomUUID();
      const observation = { schemaVersion: 1, kind: 'IncidentObservation', title: 'Fixture stop during delivery smoke', component: 'delivery', category: 'execution', severity: 'high', confidence: 'high', causeStatus: 'suspected', expected: 'Stop cancels the smoke tree before publication.', actual: 'The smoke is currently running.', reproduction: ['Start the managed task delivery smoke.'], versions: { app: null, runtime: null, cli: 'fixture' }, sourceRevision: baseCommit, runId: id, nodeInstanceId: 'task', attemptId: null, eventRange: null, artifacts: [], captureGaps: [], controllerCommandId: null, reporter: { authority: 'external', sessionId: null } };
      const stopped = await api.callExternal('POST', `/api/v2/runs/${id}/${scoped ? `nodes/${encodeURIComponent(stopTarget)}/stop` : 'stop-and-report'}`, scoped ? { requestId: stopId } : { requestId: stopId, reason: 'Fixture observed a running smoke child.', observation });
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      const finished = await api.waitFor(id, undefined, 30000);
      assert.equal(finished.run.state, scoped ? 'waiting_for_user' : 'canceled', JSON.stringify(finished));
      assert.equal(isAlive(pids.parent), false); assert.equal(isAlive(pids.child), false);
      assert.notEqual(git(workspace.cwd, ['rev-parse', '--verify', 'refs/heads/codex/managed-feature'], false).status, 0);
      assert.equal(api.runner.engine.store.get("SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND state='running'", id).n, 0);
      assert.equal((await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body.state, mode === 'command' ? 'paused' : 'canceled');
      if (!scoped) assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM incidents WHERE run_id=?', id).n, 1);
      else assert.equal((await api.recover(id, { action: 'retry', nodeInstanceId: 'task' })).status, 409, 'Parent retry must not reset the task budget.');
    } finally { await api.close(); }
  });
});

test('final manual acceptance evidence comes from a fresh policy-selected accepter, never a readiness review', async t => {
  for (const independent of [false, true]) await t.test(independent ? 'independent' : 'same Analyst fresh Context', async () => {
    const { api } = await setup();
    try {
      const workflow = taskWorkflow({ request: 'MANUAL_ACCEPTANCE', independent });
      const config = workflow.nodes.find(node => node.type === 'task').config; config.scope.tests = []; config.checks = [];
      const response = await api.run(workflow), id = response.body.run.runId;
      const finished = await api.waitFor(id, undefined, 60000);
      assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished));
      const record = api.runner.engine.store.readJson(api.runner.engine.store.get('SELECT record_artifact_id FROM acceptance_records WHERE run_id=?', id).record_artifact_id);
      assert.equal(record.accepter.independent, independent);
      const evidence = api.runner.engine.store.all('SELECT e.producer,a.node_instance_id FROM task_evidence e JOIN attempts a ON a.id=e.attempt_id JOIN managed_tasks t ON t.id=e.task_execution_id WHERE t.run_id=?', id);
      assert.deepEqual(evidence.map(item => item.producer), [independent ? 'businessAccepter' : 'analyst']);
      assert.ok(evidence.every(item => item.node_instance_id.endsWith('/accept')));
    } finally { await api.close(); }
  });
});

test('an indeterminate ref-update receipt pauses delivery, preserves commit intent and refuses blind retry', async () => {
  const { api, workspace } = await setup();
  try {
    git(workspace.cwd, ['init', '-b', 'main']); git(workspace.cwd, ['config', 'user.name', 'Fixture']); git(workspace.cwd, ['config', 'user.email', 'fixture@example.com']);
    git(workspace.cwd, ['config', 'core.autocrlf', 'false']); git(workspace.cwd, ['config', 'commit.gpgSign', 'false']); git(workspace.cwd, ['add', '.']); git(workspace.cwd, ['commit', '-m', 'base']);
    const baseCommit = git(workspace.cwd, ['rev-parse', 'HEAD']), engine = api.runner.engine, runCommand = engine.runTaskCommand;
    engine.runTaskCommand = async function (state, execution, attempt, command, args, options) {
      const result = await runCommand.call(this, state, execution, attempt, command, args, options);
      return command === 'git' && args.includes('update-ref') ? { ...result, status: null, error: new Error('Injected loss of publication receipt.'), aborted: true } : result;
    };
    const response = await api.run(taskWorkflow({ boundary: 'verified_branch', baseCommit })), id = response.body.run.runId;
    assert.equal((await api.waitFor(id, undefined, 90000)).run.state, 'waiting_for_user');
    const nav = (await api.call('GET', `/api/v2/runs/${id}/tasks/task`)).body;
    assert.equal(nav.delivery.status, 'publication_uncertain'); assert.equal(nav.delivery.refUpdated, null); assert.equal(nav.deliveryOperation.phase, 'reconciliation_required');
    assert.equal(git(workspace.cwd, ['rev-parse', 'refs/heads/codex/managed-feature']), nav.delivery.verifiedCommitId);
    assert.equal(engine.store.get("SELECT COUNT(*) AS n FROM acceptance_records WHERE run_id=? AND boundary='verified_branch'", id).n, 0);
    assert.equal((await api.recover(id, { action: 'retry', nodeInstanceId: nav.current })).status, 409);
    assert.equal(engine.store.get('SELECT status FROM branch_deliveries WHERE run_id=?', id).status, 'publication_uncertain');
  } finally { await api.close(); }
});

test('restart preserves delivery intent for reconciliation and never resumes publishing', async () => {
  const { api } = await setup(); let restarted;
  try {
    const response = await api.run(taskWorkflow({ request: 'REVIEW_INCOMPLETE' })), id = response.body.run.runId;
    await api.waitFor(id, undefined, 60000);
    const store = api.runner.engine.store, task = store.get('SELECT * FROM managed_tasks WHERE run_id=?', id);
    const intent = store.putJson({ fixture: 'publication interrupted' });
    store.run('INSERT INTO delivery_operations(id,run_id,task_execution_id,intent_artifact_id,phase,receipt_artifact_id,updated_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), id, task.id, intent.artifactId, 'publish-intent', intent.artifactId, new Date().toISOString());
    await api.close(); restarted = await startTestRunner({ root: api.root });
    const nav = await restarted.call('GET', `/api/v2/runs/${id}/tasks/task`);
    assert.equal(nav.status, 200); assert.equal(nav.body.state, 'interrupted'); assert.equal(nav.body.deliveryOperation.phase, 'reconciliation_required');
    assert.equal((await restarted.call('GET', `/api/v2/runs/${id}`)).body.run.state, 'interrupted');
    assert.equal(restarted.runner.engine.processes.size, 0);
  } finally { if (restarted) await restarted.close(); else if (!api.runner.engine.closing) await api.close(); }
});

test('candidate risk escalation, bounded discovery and context expansion execute actual extra Engine attempts', async () => {
  const { api } = await setup();
  try {
    const response = await api.run(taskWorkflow({ request: 'UNCERTAIN CRITICAL_ACTUAL CONTEXT_EXPANSION EVIDENCE_EXPANSION' }));
    const id = response.body.run.runId, finished = await api.waitFor(id, undefined, 90000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished));
    const result = await summary(api, id);
    assert.equal(result.plan.classification.winningClassification, 'critical');
    assert.ok(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM task_assessments WHERE assessment_run_id=?', id).n >= 2);
    assert.ok(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM execution_plans WHERE execution_run_id=?', id).n >= 3);
    const attempts = api.runner.engine.store.all('SELECT node_instance_id,ordinal FROM attempts WHERE run_id=?', id);
    assert.ok(attempts.some(row => row.node_instance_id.endsWith('/discovery')));
    assert.ok(attempts.some(row => row.node_instance_id.endsWith('/review-code') && row.ordinal === 2));
    assert.ok(attempts.some(row => row.node_instance_id.endsWith('/review-code') && row.ordinal === 3));
  } finally { await api.close(); }
});
