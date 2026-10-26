// P1.5 recovery eligibility boundaries. These fixtures persist Runs through the Engine, stop before dispatch where possible,
// then open the same store with a new Engine and assert the recovery outcome and absence of provider launches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../core/engine.mjs';
import { fixtureAdapters, startTestRunner, singleAgent } from './helpers.mjs';
import { cleanup, hostRecords, isAlive, newScratch, sha256File, startCustodyHost } from './custody-support.mjs';

const repo = resolve(import.meta.dirname, '../..');
const clientTimeouts = JSON.parse(readFileSync(join(repo, 'docs/authoring/client-timeouts.json'), 'utf8'));

function stateOf(engine, runId) { return engine.store.get('SELECT state FROM runs WHERE id = ?', runId)?.state ?? null; }
function attemptsOf(engine, runId) {
  return engine.store.all('SELECT id, node_instance_id AS node, state, process_id, invocation_artifact_id AS invocation FROM attempts WHERE run_id = ? ORDER BY rowid', runId)
    .map(row => ({ ...row }));
}
function fixtureTurns(stateDir) {
  if (!existsSync(stateDir)) return 0;
  return readdirSync(stateDir).filter(name => name.endsWith('.log')).reduce((total, name) =>
    total + (readFileSync(join(stateDir, name), 'utf8').split('\n␞\n').length - 1), 0);
}
function dormantWorkflow(id) {
  return {
    schemaVersion: 1, workflowId: id, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'P1.5 recovery gate fixture.' } },
      { id: 'a', type: 'agent', config: { provider: 'codex', model: 'fixture-never-dispatch-a', timeoutSeconds: 60, output: { format: 'text' } } },
      { id: 'b-prompt', type: 'prompt-template', config: { template: '{{prior}} continue', slots: [{ id: 'prior' }] } },
      { id: 'b', type: 'agent', config: { provider: 'codex', model: 'fixture-never-dispatch-b', timeoutSeconds: 60, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'request-a', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'a', port: 'prompt' } },
      { id: 'a-prompt', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'b-prompt', port: 'prior' } },
      { id: 'prompt-b', source: { nodeId: 'b-prompt', port: 'text' }, target: { nodeId: 'b', port: 'prompt' } },
      { id: 'b-result', source: { nodeId: 'b', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    ],
    after: [],
  };
}

async function createRun(api, workflow, { state = 'queued' } = {}) {
  const engine = api.runner.engine;
  if (state === 'queued') engine.startRun = () => {};
  else engine.pump = () => {};
  const saved = await api.save(workflow);
  const started = await api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId,
    workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run.runId;
  const expected = state === 'queued' ? 'queued' : 'running';
  assert.equal(stateOf(engine, runId), expected, `the persisted fixture is ${expected} before Engine A closes`);
  return { runId, publication: api.publication(workflow.workflowId), saved };
}

function prepareExample(name, id) {
  const path = join(repo, 'docs/examples', name, 'workflow.json');
  const workflow = JSON.parse(readFileSync(path, 'utf8'));
  workflow.workflowId = id;
  for (const node of workflow.nodes) if (node.type === 'agent') node.config.model = 'fixture-echo';
  const task = workflow.nodes.find(node => node.type === 'task');
  if (task?.config?.roles) for (const role of Object.values(task.config.roles)) if (role.model) role.model = 'fixture-managed-task';
  const map = workflow.nodes.find(node => node.type === 'map');
  if (map?.config?.roles) for (const role of map.config.roles) if (role.model) role.model = 'fixture-echo';
  return workflow;
}

async function waitUntil(probe, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function custodyRunnerOptions(host) {
  return { runner: { custodyHost: { context: { generation: host.generation }, custody: (command, payload) => host.request(command, payload) } } };
}

function supervisorFixture() {
  return { shimPath: null, pipeName: 'p1c-active-custody',
    armRun: async () => ({ armed: true, emergencyToken: 'p1c-emergency-token' }),
    disarmRun: async () => ({ armed: false }), releaseRun: async () => ({ released: true }),
    heartbeat: async () => ({ heartbeat: true }), status: async () => ({ escalated: false }) };
}

async function startSupervisedCustodyRun(api, workflow) {
  const engine = api.runner.engine;
  engine.supervisor = supervisorFixture();
  await api.workspace();
  const saved = await api.save(workflow);
  const session = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'P1.5 active Custody reviewer', clientProvider: 'codex' }).body;
  const grant = engine.requestControlGrant({ requestId: randomUUID(), controllerSessionId: session.controllerSessionId, workflowId: workflow.workflowId,
    workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', clientProvider: 'codex',
    clientVersion: clientTimeouts.entries.find(item => item.provider === 'codex').testedVersion,
    requestedActions: ['observe', 'stop'], observationDeadlineMs: 90_000, escalationDeadlineMs: 180_000 }, { controllerToken: session.controllerToken }).body;
  engine.decideControlGrant(grant.grantId, { requestId: randomUUID(), decision: 'approve' });
  const started = await api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
    workspaceId: 'main', controlGrantId: grant.grantId, requestId: randomUUID() }, { headers: { 'X-Deszo-Controller-Token': session.controllerToken } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return { runId: started.body.run.runId, grantId: grant.grantId, engine, session };
}

function activeLoopWorkflow() {
  const workflow = prepareExample('m4-specification-loop', `p1c-active-loop-${randomUUID().slice(0, 8)}`);
  workflow.nodes.push(
    { id: 'custody-request', type: 'text', config: { value: 'Hold the accepted Custody attempt across recovery.' } },
    { id: 'custody-agent', type: 'agent', config: { provider: 'codex', model: 'fixture-slow-60', timeoutSeconds: 120, output: { format: 'text' } } },
    { id: 'custody-result', type: 'result-viewer', config: {} },
  );
  workflow.edges.push(
    { id: 'custody-request-agent', source: { nodeId: 'custody-request', port: 'text' }, target: { nodeId: 'custody-agent', port: 'prompt' } },
    { id: 'custody-agent-result', source: { nodeId: 'custody-agent', port: 'text' }, target: { nodeId: 'custody-result', port: 'value' } },
  );
  workflow.after = [{ before: 'custody-agent', after: 'delivery' }];
  return workflow;
}

async function populateExampleWorkspace(example, cwd) {
  const examples = join(repo, 'docs/examples');
  if (example === 'm5-delivery') {
    const source = join(examples, 'round-recovery');
    for (const name of ['SPEC.md', 'spec-index.json', 'implementation-map.json']) cpSync(join(source, name), join(cwd, name));
    for (const name of ['src/api.mjs', 'fixtures/tokens.json']) {
      const target = join(cwd, name);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(join(source, 'project', name), target);
    }
  }
  if (example === 'managed-task') {
    const source = join(examples, 'managed-task/project');
    for (const name of ['README.md', 'src/feature.mjs', 'docs/usage.md']) {
      const target = join(cwd, name);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(join(source, name), target);
    }
  }
}

test('P1C-01: a queued supervised Run is interrupted and its old grant is ended, never reused', { timeout: 120_000 }, async () => {
  const first = await startTestRunner();
  let second = null;
  try {
    await first.workspace();
    const engine = first.runner.engine;
    engine.supervisor = { shimPath: null, pipeName: 'p1c-01', armRun: async () => ({ armed: true }),
      disarmRun: async () => ({ armed: false }), releaseRun: async () => ({ released: true }) };
    const workflow = singleAgent({ id: 'p1c-01-supervised', context: null, model: 'fixture-supervised-must-not-start' });
    const saved = await first.save(workflow);
    const session = engine.createControllerSession({ requestId: randomUUID(), clientLabel: 'P1C-01 fixture', clientProvider: 'codex' }).body;
    const grant = engine.requestControlGrant({ requestId: randomUUID(), controllerSessionId: session.controllerSessionId, workflowId: workflow.workflowId,
      workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', clientProvider: 'codex',
      clientVersion: clientTimeouts.entries.find(item => item.provider === 'codex').testedVersion,
      requestedActions: ['observe', 'stop'], observationDeadlineMs: 90_000, escalationDeadlineMs: 180_000 }, { controllerToken: session.controllerToken }).body;
    engine.decideControlGrant(grant.grantId, { requestId: randomUUID(), decision: 'approve' });
    engine.startRun = () => {};
    const started = await first.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      workspaceId: 'main', controlGrantId: grant.grantId, requestId: randomUUID() }, { headers: { 'X-Deszo-Controller-Token': session.controllerToken } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    assert.equal(stateOf(engine, runId), 'queued');
    const attemptCount = attemptsOf(engine, runId).length;
    const providerTurns = fixtureTurns(first.stateDir);
    assert.equal(attemptCount > 0, true, 'the queued Run has persisted planned attempts');
    const armDeadline = Date.now() + 5_000;
    while (engine.awaitingArm.has(runId) && Date.now() < armDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    assert.equal(engine.awaitingArm.has(runId), false, 'the deterministic supervisor arm completed');
    engine.stopWatchdog(runId);
    await first.close();

    second = await startTestRunner({ root: first.root });
    const recovered = second.runner.engine;
    assert.equal(stateOf(recovered, runId), 'interrupted', 'the queued supervised Run follows the existing safe restart outcome');
    assert.equal(recovered.store.get('SELECT COUNT(*) AS n FROM runs').n, 1, 'the original Run remains authoritative');
    assert.equal(attemptsOf(recovered, runId).length, attemptCount, 'recovery creates no duplicate attempts');
    assert.ok(attemptsOf(recovered, runId).every(attempt => attempt.state === 'canceled'), 'unstarted attempts are canceled');
    assert.equal(recovered.store.get('SELECT state FROM control_grants WHERE id = ?', grant.grantId).state, 'ended', 'restart does not reuse the grant');
    assert.equal(fixtureTurns(second.stateDir), providerTurns, 'no supervised provider invocation starts after restart');
    assert.equal(recovered.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.reconciled'", runId).n, 0);
  } finally { if (second) await second.close(); else await first.close(); }
});

test('P1C-12: active supervised Custody is abandoned rather than reattached after restart', { timeout: 180_000 }, async () => {
  const scratch = newScratch('p1c-12-active-supervised-custody');
  const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: process.execPath, sha256: sha256File(process.execPath) }] });
  let first = null, second = null;
  try {
    first = await startTestRunner({ root: scratch.root, ...custodyRunnerOptions(host) });
    const { runId, grantId, engine } = await startSupervisedCustodyRun(first, singleAgent({ id: 'p1c-12-active-supervised-custody',
      context: null, model: 'fixture-slow-60', timeoutSeconds: 120 }));
    const attemptBefore = await waitUntil(() => {
      const attempt = attemptsOf(engine, runId).find(item => item.node === 'agent');
      const record = attempt && hostRecords(host).find(item => item.attemptId === attempt.id && item.state === 'running');
      return attempt?.state === 'running' && attempt.invocation && attempt.process_id && isAlive(attempt.process_id) && record ? attempt : null;
    }, 'the supervised provider process to be running under Process Custody');
    assert.equal(engine.store.get('SELECT state FROM control_grants WHERE id = ?', grantId).state, 'active');
    const attemptCountBefore = attemptsOf(engine, runId).length;
    const launchesBefore = fixtureTurns(first.stateDir);
    assert.equal(launchesBefore, 1, 'one active Host-owned fixture invocation exists');

    engine.stopWatchdog(runId);
    await first.close();
    assert.equal(isAlive(attemptBefore.process_id), true, 'Engine A detaches while the Host keeps the original process alive');
    second = await startTestRunner({ root: scratch.root, ...custodyRunnerOptions(host) });
    const recovered = second.runner.engine;
    assert.equal(stateOf(recovered, runId), 'interrupted', 'the active control grant excludes Custody reattachment');
    assert.equal(recovered.store.get('SELECT state FROM control_grants WHERE id = ?', grantId).state, 'ended');
    const attemptsAfter = attemptsOf(recovered, runId);
    assert.equal(attemptsAfter.length, attemptCountBefore, 'recovery creates no replacement Attempt');
    assert.equal(attemptsAfter.find(item => item.id === attemptBefore.id)?.state, 'interrupted');
    await waitUntil(() => !isAlive(attemptBefore.process_id), 'the excluded Host-owned process to stop');
    assert.equal(fixtureTurns(second.stateDir), launchesBefore, 'recovery neither reattaches nor relaunches the supervised invocation');
    assert.equal(hostRecords(host).filter(item => item.attemptId === attemptBefore.id).length, 1);
  } finally {
    if (second) await second.close(); else if (first) await first.close();
    await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

test('P1C-13: an active top-level Custody attempt does not resume a workflow containing a Loop', { timeout: 180_000 }, async () => {
  const scratch = newScratch('p1c-13-active-loop-custody');
  const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: process.execPath, sha256: sha256File(process.execPath) }] });
  let first = null, second = null;
  try {
    first = await startTestRunner({ root: scratch.root, ...custodyRunnerOptions(host) });
    await first.workspace();
    const workflow = activeLoopWorkflow();
    const saved = await first.save(workflow);
    const publication = first.publication(workflow.workflowId);
    const started = await first.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run.runId;
    const engine = first.runner.engine;
    const attemptBefore = await waitUntil(() => {
      const attempt = attemptsOf(engine, runId).find(item => item.node === 'custody-agent');
      const record = attempt && hostRecords(host).find(item => item.attemptId === attempt.id && item.state === 'running');
      return attempt?.state === 'running' && attempt.process_id && isAlive(attempt.process_id) && record ? attempt : null;
    }, 'the top-level Custody attempt in the Loop workflow to be active');
    const attemptCountBefore = attemptsOf(engine, runId).length;
    assert.ok(engine.store.readJson(engine.requireRun(runId).workflow_snapshot_artifact_id).nodes.some(node => node.type === 'loop'));
    assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM loop_executions WHERE run_id = ?', runId).n, 0, 'the Loop is behind A in the captured graph');

    await first.close();
    second = await startTestRunner({ root: scratch.root, ...custodyRunnerOptions(host) });
    const recovered = second.runner.engine;
    assert.equal(stateOf(recovered, runId), 'interrupted', 'the unsupported execution class excludes the active Custody shortcut');
    assert.equal(attemptsOf(recovered, runId).length, attemptCountBefore, 'recovery creates no Attempts');
    assert.equal(attemptsOf(recovered, runId).find(item => item.id === attemptBefore.id).state, 'interrupted');
    await waitUntil(() => !isAlive(attemptBefore.process_id), 'the excluded Loop workflow Custody process to stop');
    assert.equal(recovered.store.get('SELECT COUNT(*) AS n FROM loop_executions WHERE run_id = ?', runId).n, 0);
    assert.equal(recovered.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'loop.started'", runId).n, 0);
    assert.equal(hostRecords(host).filter(item => item.attemptId === attemptBefore.id).length, 1);
  } finally {
    if (second) await second.close(); else if (first) await first.close();
    await host.shutdown().catch(() => host.crash()); cleanup(scratch.root);
  }
});

test('P1C-02: a queued chat Run remains excluded after restart and emits no assistant invocation', { timeout: 120_000 }, async () => {
  const first = await startTestRunner();
  let second = null;
  try {
    await first.workspace();
    const seed = await first.run(singleAgent({ id: 'p1c-02-context-seed', model: 'fixture-context-seed' }));
    const seedRunId = seed.body.run.runId;
    assert.equal((await first.waitFor(seedRunId, run => run.state === 'succeeded')).run.state, 'succeeded');
    const bindingId = first.runner.engine.store.get('SELECT binding_id FROM run_context_bindings WHERE run_id = ?', seedRunId)?.binding_id;
    assert.ok(bindingId, 'the seed Run persisted its ready Context binding');
    assert.equal(first.runner.engine.store.get('SELECT state FROM context_bindings WHERE id = ?', bindingId).state, 'ready');
    const providerTurns = fixtureTurns(first.stateDir);
    first.runner.engine.startRun = () => {};
    const requestId = randomUUID();
    const chat = await first.call('POST', `/api/v2/context-bindings/${bindingId}/messages`, { requestId, workspaceId: 'main',
      prompt: 'P1C-02 must never start after restart.', model: 'fixture-chat-must-not-start', timeoutSeconds: 60 });
    assert.equal(chat.status, 202, JSON.stringify(chat.body));
    const runId = chat.body.run.runId;
    assert.equal(stateOf(first.runner.engine, runId), 'queued');
    const attemptCount = attemptsOf(first.runner.engine, runId).length;
    await first.close();

    second = await startTestRunner({ root: first.root });
    const recovered = second.runner.engine;
    assert.equal(stateOf(recovered, runId), 'interrupted', 'chat is not reinterpreted as an ordinary workflow');
    assert.equal(recovered.requireRun(runId).kind, 'chat');
    assert.equal(recovered.store.get('SELECT COUNT(*) AS n FROM runs').n, 2, 'recovery emits no duplicate Run request');
    assert.equal(attemptsOf(recovered, runId).length, attemptCount);
    assert.ok(attemptsOf(recovered, runId).every(attempt => attempt.state === 'canceled'));
    assert.equal(recovered.store.get('SELECT COUNT(*) AS n FROM command_receipts WHERE request_id = ?', requestId).n, 1);
    assert.equal(fixtureTurns(second.stateDir), providerTurns, 'the assistant fixture was not invoked for the queued chat');
    assert.equal(recovered.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.reconciled'", runId).n, 0);
  } finally { if (second) await second.close(); else await first.close(); }
});

test('P1C-03: a Host-bound replacement interrupts an otherwise-continuable Run without treating stale ownership as valid', { timeout: 120_000 }, async () => {
  const first = await startTestRunner();
  let hostBound = null;
  try {
    await first.workspace();
    const { runId } = await createRun(first, dormantWorkflow('p1c-03-host-bound'), { state: 'running' });
    const attemptsBefore = attemptsOf(first.runner.engine, runId);
    assert.ok(attemptsBefore.length > 0 && attemptsBefore.every(attempt => attempt.state === 'scheduled'));
    await first.close();

    hostBound = new Engine({ root: first.root, adapters: fixtureAdapters(first.stateDir), hostAuthority: { fixture: 'host-bound' },
      hostRuntimeGeneration: 'expired-generation', hostPolicyId: 'p1c-03-policy' });
    await hostBound.initialize();
    assert.equal(stateOf(hostBound, runId), 'interrupted', 'the Host-bound runtime gate prevents P1 continuation');
    assert.deepEqual(attemptsOf(hostBound, runId).map(attempt => attempt.id), attemptsBefore.map(attempt => attempt.id), 'no attempt is recreated');
    assert.ok(attemptsOf(hostBound, runId).every(attempt => attempt.state === 'canceled'));
    assert.equal(hostBound.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.reconciled'", runId).n, 0);
    assert.equal(fixtureTurns(first.stateDir), 0, 'no process is launched under stale Host ownership');
  } finally { if (hostBound) await hostBound.shutdown(); else await first.close(); }
});

test('P1C-04: an unconfirmed owned-process result blocks recovery and dependent scheduling until a fresh restart', { timeout: 120_000 }, async () => {
  const first = await startTestRunner();
  let blockedEngine = null, clearEngine = null;
  try {
    const workspace = await first.workspace();
    const { runId } = await createRun(first, dormantWorkflow('p1c-04-recovery-blocked'), { state: 'running' });
    const attemptIds = attemptsOf(first.runner.engine, runId).map(attempt => attempt.id);
    await first.close();

    // Deterministically supply the exact survivor evidence recoverSurvivors produces when an owned process cannot be confirmed ended.
    // The recovery method, gate decision, interruption and recoveryBlocked message remain production code.
    blockedEngine = new Engine({ root: first.root, adapters: fixtureAdapters(first.stateDir) });
    blockedEngine.recoverSurvivors = async (uncertain, unconfirmed) => {
      uncertain.push(424242);
      unconfirmed.push({ pid: 424242, cwd: workspace.cwd });
    };
    await blockedEngine.initialize();
    assert.match(blockedEngine.recoveryBlocked, /424242/);
    assert.equal(stateOf(blockedEngine, runId), 'interrupted', 'uncertain ownership is fail-closed');
    assert.deepEqual(attemptsOf(blockedEngine, runId).map(attempt => attempt.id), attemptIds);
    assert.ok(attemptsOf(blockedEngine, runId).every(attempt => attempt.state === 'canceled'), 'dependent work is canceled, never dispatched');
    assert.equal(blockedEngine.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.reconciled'", runId).n, 0);
    await blockedEngine.shutdown(); blockedEngine = null;

    // The documented way out is to resolve the uncertain process and restart. A later clean recovery clears the startup block;
    // the already interrupted Run stays interrupted and is not silently reopened.
    clearEngine = new Engine({ root: first.root, adapters: fixtureAdapters(first.stateDir) });
    await clearEngine.initialize();
    assert.equal(clearEngine.recoveryBlocked, null);
    assert.equal(stateOf(clearEngine, runId), 'interrupted');
    assert.equal(fixtureTurns(first.stateDir), 0, 'neither pass launched the dependent Agent');
  } finally {
    if (blockedEngine) await blockedEngine.shutdown();
    if (clearEngine) await clearEngine.shutdown();
    else await first.close();
  }
});

for (const [label, example] of [['Loop', 'm4-specification-loop'], ['Map', 'm5-delivery'], ['Managed Task', 'managed-task']]) {
  test(`P1C-07: queued ${label} workflow remains excluded from P1 restart continuation`, { timeout: 120_000 }, async () => {
    const first = await startTestRunner();
    let second = null;
    try {
      const workspace = await first.workspace();
      await populateExampleWorkspace(example, workspace.cwd);
      const workflow = prepareExample(example, `p1c-07-${label.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 8)}`);
      const { runId } = await createRun(first, workflow);
      const before = attemptsOf(first.runner.engine, runId);
      assert.ok(before.length > 0, 'the captured Run has planned attempts');
      assert.ok(first.runner.engine.store.readJson(first.runner.engine.requireRun(runId).workflow_snapshot_artifact_id).nodes.some(node =>
        label === 'Loop' ? node.type === 'loop' : label === 'Map' ? node.type === 'map' : node.type === 'task'), 'the persisted snapshot exercises the named execution class');
      const providerTurns = fixtureTurns(first.stateDir);
      await first.close();

      second = await startTestRunner({ root: first.root });
      const recovered = second.runner.engine;
      assert.equal(stateOf(recovered, runId), 'interrupted', `${label} Run keeps its pre-P1 restart outcome`);
      assert.equal(attemptsOf(recovered, runId).length, before.length, 'recovery creates no attempts');
      assert.ok(attemptsOf(recovered, runId).every(attempt => attempt.state === 'canceled'), 'unstarted attempts are canceled');
      assert.equal(recovered.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id = ? AND event_type = 'continuation.reconciled'", runId).n, 0);
      assert.equal(fixtureTurns(second.stateDir), providerTurns, 'no Agent or Managed Task provider starts during recovery');
    } finally { if (second) await second.close(); else await first.close(); }
  });
}

