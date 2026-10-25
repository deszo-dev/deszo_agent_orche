// Process Custody F7: a managed-task delivery writes into its source repository (it fetches the verified commit there and updates the target
// ref). Its utility is the only managed-task utility that writes into the workspace: `assert-source` only reads committed Git objects, and
// `check-*`, `plan` and `assemble` work in the task's own directories. The proofs run a real managed task through the real Engine entrypoint,
// next to a Host-owned CLI under the real Lifecycle Host that keeps writing into its workspace:
// - same directory under another workspace id, a junction alias of it, and a nested directory: the delivery waits on the durable hold and
//   publishes only after the Host proves the CLI ended;
// - a disjoint directory: the delivery is not blocked;
// - the reverse order: a Host-owned CLI is not started in a repository that an active delivery is writing into;
// - the admission race: a Custody run and a delivery submitted together on one root, in either order, never overlap (F7-06);
// - a restart that could not confirm a process ended keeps its workspace unavailable to Custody until the record clears (F7-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fixtureAdapters, startTestRunner } from './helpers.mjs';
import { emptyTaskConfig } from '../../shared/task-config.mjs';
import { buildArtifacts, cleanup, eventually, fixtureExe, isAlive, newScratch, readInvocations, retargetJunction, startCustodyHost, testsRoot } from './custody-support.mjs';

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const TARGET = 'refs/heads/codex/managed-feature';
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
test.after(() => {
  mkdirSync(join(testsRoot, 'custody-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'custody-evidence', 'custody-delivery.json'), JSON.stringify(evidence, null, 2));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(cwd, args, required = true) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (required) assert.equal(result.status, 0, result.stderr || result.stdout);
  return required ? result.stdout.trim() : result;
}

// The managed task of `managed-task.test.mjs`, delivering a verified branch. Its check waits for `ready` (so that the delivery is reached only
// once the test has set up the Host-owned CLI), and when `slowSmoke` is set its delivery smoke announces itself in `smoke` and runs 8 s.
function taskWorkflow({ baseCommit, ready, smoke, slowSmoke }) {
  const config = emptyTaskConfig();
  for (const role of Object.values(config.roles)) role.model = 'fixture-managed-task';
  config.scope.documentation = [];
  config.scope.production = ['src/**', 'docs/storage/**'];
  config.projectPolicy = { criticalAreas: ['docs/storage/*.sql'], publicContracts: [], requireIndependentAcceptance: false };
  const script = `const fs=require('node:fs'),p=require('node:path');const until=Date.now()+90000;(function wait(){if(fs.existsSync(${JSON.stringify(ready)})||Date.now()>until){`
    + `if(${slowSmoke ? 'true' : 'false'}&&p.basename(process.cwd()).startsWith('delivery-')){fs.writeFileSync(${JSON.stringify(smoke)},'1');setTimeout(()=>process.exit(0),8000);}else process.exit(0);}`
    + `else setTimeout(wait,100);})();`;
  config.checks = [{ id: 'feature', command: process.execPath, args: ['-e', script], expectedExitCode: 0, timeoutMs: 120000, criteria: ['AC-1'] }];
  config.delivery = { boundary: 'verified_branch', baseCommit, targetBranchRef: TARGET, expectedOldValue: null,
    commitPolicy: { authorName: 'Fixture Author', authorEmail: 'fixture@example.com', message: 'Verified managed task' } };
  return { schemaVersion: 1, workflowId: `managed-${randomUUID().slice(0, 8)}`, capabilities: ['core-v1', 'loops-v1', 'task-planning-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: 'Implement the feature.' } }, { id: 'source', type: 'file-input', config: { mode: 'files', paths: ['README.md', 'src/feature.mjs'] } },
      { id: 'task', type: 'task', config }, { id: 'answer', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-task', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'task', port: 'request' } },
      { id: 'source-task', source: { nodeId: 'source', port: 'value' }, target: { nodeId: 'task', port: 'source' } },
      { id: 'task-answer', source: { nodeId: 'task', port: 'summary' }, target: { nodeId: 'answer', port: 'value' } }], after: [] };
}

// One plain agent run whose CLI is the Custody fixture writing into its own workspace.
function writerWorkflow(ticks = 400) {
  return { schemaVersion: 1, workflowId: `writer-${randomUUID().slice(0, 8)}`, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: `[ticks=${ticks}]` } },
      { id: 'agent', type: 'agent', config: { provider: 'codex', model: 'custody-writer', timeoutSeconds: 300, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
      { id: 'agent-result', source: { nodeId: 'agent', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
}

// The test harness's fixture providers, except that `custody-writer` runs the Custody fixture CLI (the Host allowlists only that executable).
function adapters(stateDir, custodyState) {
  const base = fixtureAdapters(stateDir);
  return { ...base, buildInvocation: options => options.model === 'custody-writer'
    ? { command: fixtureExe, args: ['--model', 'custody-writer'], stdin: options.prompt, cwd: options.cwd, env: { ...process.env, CUSTODY_FIXTURE_STATE_DIR: custodyState } }
    : base.buildInvocation(options) };
}

async function startEnvironment(label) {
  buildArtifacts();
  const scratch = newScratch(label);
  const host = await startCustodyHost(scratch.root);
  Object.assign(process.env, { DESZO_PROCESS_CUSTODY: '1', DESZO_CUSTODY_ADDRESS: host.address, DESZO_CUSTODY_CAPABILITY: host.capability, DESZO_CUSTODY_GENERATION: host.generation });
  let api;
  try {
    const root = join(scratch.root, 'runner');
    mkdirSync(root, { recursive: true });
    api = await startTestRunner({ root, runner: { adapters: adapters(join(root, 'fixture-state'), scratch.fixtureState) } });
  } finally { delete process.env.DESZO_PROCESS_CUSTODY; for (const name of ['DESZO_CUSTODY_ADDRESS', 'DESZO_CUSTODY_CAPABILITY', 'DESZO_CUSTODY_GENERATION']) delete process.env[name]; }
  assert.ok(api.runner.engine.custodyHost, 'the Engine runs with Process Custody');
  // The Host-owned CLI holds a provider slot for its whole run; the managed task's roles need their own.
  const settings = await api.call('GET', '/api/v2/settings');
  const updated = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.body.revision,
    settings: { ...settings.body.settings, globalLimit: 8, providerLimits: { ...settings.body.settings.providerLimits, codex: 4 } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const workspace = await api.workspace();
  writeFileSync(join(workspace.cwd, 'README.md'), 'Managed task fixture\n');
  mkdirSync(join(workspace.cwd, 'src'), { recursive: true });
  writeFileSync(join(workspace.cwd, 'src/feature.mjs'), 'export const feature=()=>1;\n');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.com'], ['config', 'core.autocrlf', 'false'],
    ['config', 'commit.gpgSign', 'false'], ['add', '.'], ['commit', '-m', 'base']]) git(workspace.cwd, args);
  const engine = api.runner.engine, launches = [], launchContained = engine.launchContained;
  engine.launchContained = function (runId, invocation) { launches.push({ at: Date.now(), runId, command: invocation.command, args: invocation.args }); return launchContained.call(this, runId, invocation); };
  return { scratch, host, api, engine, workspace, launches, baseCommit: git(workspace.cwd, ['rev-parse', 'HEAD']) };
}

async function registerWorkspace(api, id, cwd) {
  const response = await api.call('PUT', `/api/v2/workspaces/${id}`, { cwd });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

function deliverAttempt(engine, runId) {
  return engine.store.get(`SELECT * FROM attempts WHERE run_id = ? AND node_instance_id LIKE '%/deliver' ORDER BY ordinal DESC LIMIT 1`, runId) ?? null;
}

function writerAttempt(engine, runId) {
  return engine.store.get(`SELECT * FROM attempts WHERE run_id = ? AND node_instance_id = 'agent'`, runId) ?? null;
}

function size(path) { return existsSync(path) ? statSync(path).size : 0; }

const writesIntoRepository = launches => launches.filter(item => item.command === 'git' && (item.args.includes('update-ref') || item.args.includes('fetch')));

// Held roots: the same directory under another workspace id, a junction alias of it, and a nested directory. In each, the delivery waits
// while the Host-owned CLI writes, publishes nothing, and publishes after the Host proves the CLI ended.
for (const variant of ['same', 'alias', 'nested']) {
  test(`F7 (${variant}): a managed-task delivery into a held workspace waits until the Host proves the Custody CLI ended`, async () => {
    const env = await startEnvironment(`f7-${variant}`);
    const { api, engine, workspace, launches, host, scratch } = env;
    try {
      const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
      const managed = await api.run(taskWorkflow({ baseCommit: env.baseCommit, ready, smoke, slowSmoke: false }), 'main');
      const managedId = managed.body.run.runId;
      let writerCwd = workspace.cwd;
      if (variant === 'alias') { writerCwd = join(scratch.root, 'alias-of-repo'); retargetJunction(writerCwd, workspace.cwd); }
      if (variant === 'nested') writerCwd = join(workspace.cwd, 'src');
      await registerWorkspace(api, `writer-${variant}`, writerCwd);
      const writer = await api.run(writerWorkflow(), `writer-${variant}`);
      const writerId = writer.body.run.runId;
      const cli = await eventually(() => writerAttempt(engine, writerId)?.process_id ? writerAttempt(engine, writerId) : null, 'the Host-owned CLI to start', 60_000, 100);
      await eventually(() => engine.store.get(`SELECT state FROM custody_workspace_holds WHERE attempt_id = ?`, cli.id)?.state === 'held', 'the hold', 10_000, 100);
      writeFileSync(ready, '1');

      const waiting = await eventually(() => deliverAttempt(engine, managedId)?.state === 'waiting' ? deliverAttempt(engine, managedId) : null,
        'the delivery to wait on the hold', 120_000, 200);
      const marker = join(writerCwd, 'custody-writer.log');
      const before = size(marker);
      await delay(4_000);
      assert.ok(size(marker) > before, 'the Host-owned CLI keeps writing into its workspace');
      assert.equal(isAlive(cli.process_id), true);
      assert.equal(deliverAttempt(engine, managedId).state, 'waiting', 'the delivery is still held back');
      assert.equal(writesIntoRepository(launches.filter(item => item.runId === managedId)).length, 0, 'no fetch or ref update ran in the held repository');
      assert.notEqual(git(workspace.cwd, ['rev-parse', '--verify', TARGET], false).status, 0, 'the target ref was not created');
      const events = engine.store.all(`SELECT envelope_json FROM journal_events WHERE attempt_id = ?`, waiting.id).map(row => JSON.parse(row.envelope_json).payload);
      assert.ok(events.some(payload => /Host-owned process to end/.test(payload.reason ?? '')), 'the wait names the Host-owned process');

      const stop = await api.call('POST', `/api/v2/runs/${writerId}/stop`, { requestId: randomUUID() });
      assert.equal(stop.status, 202, JSON.stringify(stop.body));
      const released = await eventually(() => { const hold = engine.store.get(`SELECT * FROM custody_workspace_holds WHERE attempt_id = ?`, cli.id); return hold.state === 'released' ? hold : null; },
        'the hold to be released on the Host proof', 60_000, 200);
      assert.equal(isAlive(cli.process_id), false);
      const finished = await api.waitFor(managedId, run => SETTLED.includes(run.state), 120_000);
      assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished.run));
      const repositoryWrites = writesIntoRepository(launches.filter(item => item.runId === managedId));
      assert.ok(repositoryWrites.length > 0, 'the delivery wrote into the repository after the release');
      assert.ok(repositoryWrites.every(item => item.at >= Date.parse(released.released_at)), 'every repository write came after the Host proved the CLI ended');
      assert.ok(git(workspace.cwd, ['rev-parse', TARGET]), 'the branch was published');
      evidence.cases[`F7-${variant}`] = { managedRunId: managedId, writerRunId: writerId, cliPid: cli.process_id, deliveryWaited: true, heldWritesBlocked: true,
        releasedAt: released.released_at, firstRepositoryWriteAt: new Date(Math.min(...repositoryWrites.map(item => item.at))).toISOString(), finalState: finished.run.state };
    } finally {
      await api.close();
      host.crash();
      cleanup(scratch.root);
    }
  });
}

// A disjoint directory is not blocked: the delivery publishes while the Host-owned CLI still runs elsewhere.
test('F7 (disjoint): a managed-task delivery is not blocked by a Custody CLI in a disjoint workspace', async () => {
  const env = await startEnvironment('f7-disjoint');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
    const managed = await api.run(taskWorkflow({ baseCommit: env.baseCommit, ready, smoke, slowSmoke: false }), 'main');
    const managedId = managed.body.run.runId;
    const disjoint = join(scratch.root, 'disjoint');
    mkdirSync(disjoint, { recursive: true });
    await registerWorkspace(api, 'writer-disjoint', disjoint);
    const writer = await api.run(writerWorkflow(), 'writer-disjoint');
    const cli = await eventually(() => writerAttempt(engine, writer.body.run.runId)?.process_id ? writerAttempt(engine, writer.body.run.runId) : null, 'the Host-owned CLI to start', 60_000, 100);
    writeFileSync(ready, '1');
    const finished = await api.waitFor(managedId, run => SETTLED.includes(run.state), 120_000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished.run));
    assert.equal(isAlive(cli.process_id), true, 'the delivery completed while the disjoint CLI still ran');
    assert.ok(git(workspace.cwd, ['rev-parse', TARGET]));
    evidence.cases['F7-disjoint'] = { managedRunId: managedId, cliPid: cli.process_id, finalState: finished.run.state, cliAliveAtDelivery: true };
    // The disjoint CLI is stopped through the Host and its hold released on the Host's proof, so the test leaves no Host-owned process.
    const stop = await api.call('POST', `/api/v2/runs/${writer.body.run.runId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, JSON.stringify(stop.body));
    await eventually(() => engine.store.get('SELECT state FROM custody_workspace_holds WHERE attempt_id = ?', cli.id)?.state === 'released', 'the disjoint hold to be released', 60_000, 200);
    assert.equal(isAlive(cli.process_id), false);
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

// The reverse order: the delivery is running (its smoke check takes 8 s) when a Custody run for the same directory is dispatched. The Host-owned
// CLI is not started until the delivery has ended.
test('F7 (reverse): a Custody CLI is not started in a repository while a managed-task delivery writes into it', async () => {
  const env = await startEnvironment('f7-reverse');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
    writeFileSync(ready, '1');
    const managed = await api.run(taskWorkflow({ baseCommit: env.baseCommit, ready, smoke, slowSmoke: true }), 'main');
    const managedId = managed.body.run.runId;
    await eventually(() => existsSync(smoke), 'the delivery smoke to start', 120_000, 100);
    const delivering = deliverAttempt(engine, managedId);
    assert.equal(delivering.state, 'running', 'the delivery is in progress');
    await registerWorkspace(api, 'writer-reverse', workspace.cwd);
    const writer = await api.run(writerWorkflow(), 'writer-reverse');
    const writerId = writer.body.run.runId;
    await eventually(() => writerAttempt(engine, writerId)?.state === 'waiting', 'the Custody attempt to wait for the delivery', 20_000, 100);
    const events = engine.store.all(`SELECT envelope_json FROM journal_events WHERE attempt_id = ?`, writerAttempt(engine, writerId).id).map(row => JSON.parse(row.envelope_json).payload);
    assert.ok(events.some(payload => /managed-task delivery/.test(payload.reason ?? '')), 'the wait names the delivery');
    assert.equal(writerAttempt(engine, writerId).process_id, null, 'no CLI was started during the delivery');
    const finished = await api.waitFor(managedId, run => SETTLED.includes(run.state), 120_000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished.run));
    const deliveryEnded = Date.parse(engine.store.get('SELECT ended_at FROM attempts WHERE id = ?', delivering.id).ended_at);
    const cli = await eventually(() => writerAttempt(engine, writerId)?.process_id ? writerAttempt(engine, writerId) : null, 'the CLI to start after the delivery', 60_000, 100);
    assert.ok(Date.parse(cli.started_at) >= deliveryEnded, 'the CLI started only after the delivery ended');
    evidence.cases['F7-reverse'] = { managedRunId: managedId, writerRunId: writerId, deliveryEndedAt: new Date(deliveryEnded).toISOString(), cliStartedAt: cli.started_at };
    await api.call('POST', `/api/v2/runs/${writerId}/stop`, { requestId: randomUUID() });
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

// F7-07, the restart gate. recover() records the processes it could not confirm ended, with their workspaces. While one of them lives, a new
// Custody run in an overlapping workspace is refused (captureRun), and a Custody attempt already queued there is not dispatched (the scheduler).
// The record is cleared when the process ends, and the queued attempt is then dispatched. A real process cannot be made to survive a kill here,
// so the proof injects the record recover() writes (this test process is the live survivor) into the real Engine.
test('F7-07: a restart-unconfirmed workspace refuses new Custody runs and holds a queued one until the record clears', async () => {
  const env = await startEnvironment('f7-unconfirmed');
  const { api, engine, workspace, host, scratch } = env;
  try {
    // One provider slot, held by a busy Custody run in a disjoint directory, so the queued writer below waits for capacity (not yet dispatched).
    const current = await api.call('GET', '/api/v2/settings');
    const limited = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: current.body.revision,
      settings: { ...current.body.settings, globalLimit: 1, providerLimits: { ...current.body.settings.providerLimits, codex: 1 } } });
    assert.equal(limited.status, 200, JSON.stringify(limited.body));
    const busyDir = join(scratch.root, 'busy');
    mkdirSync(busyDir, { recursive: true });
    await registerWorkspace(api, 'busy-unconfirmed', busyDir);
    const busy = await api.run(writerWorkflow(40), 'busy-unconfirmed');
    const busyId = busy.body.run.runId;
    await eventually(() => writerAttempt(engine, busyId)?.process_id, 'the busy CLI to start', 60_000, 100);

    await registerWorkspace(api, 'writer-unconfirmed', workspace.cwd);
    const queued = await api.run(writerWorkflow(20), 'writer-unconfirmed');
    const queuedId = queued.body.run.runId;
    await eventually(() => writerAttempt(engine, queuedId)?.state === 'waiting', 'the queued Custody attempt to wait for capacity', 30_000, 100);

    // The restart record appears for this workspace; the scheduler is re-run by its own watch, not by the test.
    engine.unconfirmedWorkspaces = [{ pid: process.pid, cwd: workspace.cwd }];
    engine.watchUnconfirmed();
    const refused = await api.run(writerWorkflow(20), 'writer-unconfirmed');
    assert.equal(refused.status, 409, `a new run in the unconfirmed workspace is refused: ${JSON.stringify(refused.body)}`);
    const finishedBusy = await api.waitFor(busyId, run => SETTLED.includes(run.state), 120_000);
    assert.equal(finishedBusy.run.state, 'succeeded', JSON.stringify(finishedBusy.run));
    await delay(1_500);
    assert.equal(writerAttempt(engine, queuedId).process_id, null, 'the queued attempt was not dispatched while the record stands');
    const invocationsWhileRecorded = readInvocations(scratch.fixtureState).length;
    assert.equal(invocationsWhileRecorded, 1, 'only the busy CLI was started');

    engine.unconfirmedWorkspaces = [];
    const finished = await api.waitFor(queuedId, run => SETTLED.includes(run.state), 120_000);
    assert.equal(finished.run.state, 'succeeded', JSON.stringify(finished.run));
    assert.equal(readInvocations(scratch.fixtureState).length, 2, 'the queued CLI started once the record cleared');
    evidence.cases['F7-07'] = { busyRunId: busyId, queuedRunId: queuedId, newRunRefusedStatus: refused.status, invocationsWhileRecorded: invocationsWhileRecorded,
      invocationsAfterClear: readInvocations(scratch.fixtureState).length, finalState: finished.run.state };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});


// F7-06, the admission races. A Custody run and a managed-task delivery contend for one physical root. Each admission checks and claims the root
// in one synchronous step of the Engine; the claim is then started through the barrier. The barrier here is the proof's instrument: it records each
// claim in the order the Engine takes it, and it can hold a claim (Race A and Race B) while the other side is submitted. The winner is read from the
// claim order, never assumed from the submission order.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function claimRecorder(engine, root, holdFor = () => null) {
  const claims = [];
  engine.testBarrier = (name, detail) => {
    if (name === 'custody-claimed' && detail.workspaceCwd !== root) return null;
    if (name === 'delivery-claimed' && (detail.phase !== 'deliver' || detail.workspaceCwd !== root)) return null;
    claims.push({ side: name === 'custody-claimed' ? 'custody' : 'delivery', at: Date.now() });
    return holdFor(name);
  };
  return claims;
}

function managedWorkflow(root, ready, smoke) {
  return taskWorkflow({ baseCommit: root.baseCommit, ready, smoke, slowSmoke: false });
}

// The Custody CLI's ownership is [started, released] and the delivery's is [its first repository write, its end]. They must not overlap.
function assertNoOverlap({ cliStarted, released, firstWrite, deliveryEnded }) {
  assert.ok(released <= firstWrite || deliveryEnded <= cliStarted, 'the Custody CLI and the delivery writes do not overlap in time');
}

async function settleBoth(api, writerId, managedId) {
  const writerDone = await api.waitFor(writerId, run => SETTLED.includes(run.state), 150_000);
  const managedDone = await api.waitFor(managedId, run => SETTLED.includes(run.state), 150_000);
  assert.equal(writerDone.run.state, 'succeeded', JSON.stringify(writerDone.run));
  assert.equal(managedDone.run.state, 'succeeded', JSON.stringify(managedDone.run));
}

function timeline(engine, env, writerId, managedId) {
  const { launches, workspace, scratch } = env;
  const cli = writerAttempt(engine, writerId);
  const hold = engine.store.get('SELECT * FROM custody_workspace_holds WHERE attempt_id = ?', cli.id);
  const writes = writesIntoRepository(launches.filter(item => item.runId === managedId));
  const deliver = deliverAttempt(engine, managedId);
  return {
    root: realpathSync.native(workspace.cwd),
    cliPid: cli.process_id,
    cliStarted: Date.parse(cli.started_at),
    released: Date.parse(hold.released_at),
    firstWrite: Math.min(...writes.map(item => item.at)),
    lastWrite: Math.max(...writes.map(item => item.at)),
    deliveryEnded: Date.parse(engine.store.get('SELECT ended_at FROM attempts WHERE id = ?', deliver.id).ended_at),
    cliInvocations: readInvocations(scratch.fixtureState).length,
    holdEvidence: JSON.parse(hold.evidence_json),
  };
}

async function leaksNothing(engine) {
  await eventually(() => engine.processes.size === 0 && ![...engine.locks].some(key => key.startsWith('delivery:') || key.startsWith('cwd:')),
    'the Engine to drop its reservations', 30_000, 100);
}

test('F7-06 Race A (Custody-first): Custody holds the root; the delivery waits behind the claim and writes only after Custody releases', async () => {
  const env = await startEnvironment('f7-race-a');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
    writeFileSync(ready, '1');
    await registerWorkspace(api, 'writer-race-a', workspace.cwd);
    const release = deferred();
    const claims = claimRecorder(engine, workspace.cwd, name => (name === 'custody-claimed' ? release.promise : null));
    const writer = await api.run(writerWorkflow(20), 'writer-race-a');
    const writerId = writer.body.run.runId;
    await eventually(() => claims.some(claim => claim.side === 'custody'), 'Custody to claim the root', 60_000, 50);
    const managed = await api.run(managedWorkflow(env, ready, smoke), 'main');
    const managedId = managed.body.run.runId;
    await eventually(() => deliverAttempt(engine, managedId)?.state === 'waiting', 'the delivery to wait behind the Custody claim', 90_000, 100);
    assert.equal(writerAttempt(engine, writerId).process_id, null, 'Custody holds its claim and has not launched');
    assert.equal(writesIntoRepository(env.launches.filter(item => item.runId === managedId)).length, 0, 'the delivery has not written');
    const custodyClaimed = claims.find(claim => claim.side === 'custody').at;
    release.resolve();
    await settleBoth(api, writerId, managedId);
    await leaksNothing(engine);
    const t = timeline(engine, env, writerId, managedId);
    assert.ok(custodyClaimed <= t.cliStarted, 'Custody claimed the root before its CLI started');
    assert.deepEqual(claims.map(claim => claim.side), ['custody', 'delivery'], 'the claim order is Custody, then delivery');
    assert.ok(t.released <= t.firstWrite, 'the delivery wrote only after Custody released the root');
    assertNoOverlap(t);
    assert.equal(t.cliInvocations, 1, 'the Custody CLI was started exactly once');
    evidence.cases['F7-06-race-A'] = { winner: 'custody', physicalRoot: t.root, claimOrder: claims.map(claim => claim.side), custodyClaimedAt: new Date(custodyClaimed).toISOString(),
      cliPid: t.cliPid, cliStartedAt: new Date(t.cliStarted).toISOString(), releasedAt: new Date(t.released).toISOString(),
      firstRepositoryWriteAt: new Date(t.firstWrite).toISOString(), deliveryEndedAt: new Date(t.deliveryEnded).toISOString(), cliInvocations: t.cliInvocations,
      deliveryWaitingObserved: true, reservationsLeaked: 0 };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

test('F7-06 Race B (delivery-first): the delivery holds the root at its claim; Custody waits behind it and launches only after the delivery ends', async () => {
  const env = await startEnvironment('f7-race-b');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
    writeFileSync(ready, '1');
    await registerWorkspace(api, 'writer-race-b', workspace.cwd);
    const release = deferred();
    const claims = claimRecorder(engine, workspace.cwd, name => (name === 'delivery-claimed' ? release.promise : null));
    const managed = await api.run(managedWorkflow(env, ready, smoke), 'main');
    const managedId = managed.body.run.runId;
    await eventually(() => claims.some(claim => claim.side === 'delivery'), 'the delivery to claim the root', 120_000, 50);
    const writer = await api.run(writerWorkflow(20), 'writer-race-b');
    const writerId = writer.body.run.runId;
    await eventually(() => writerAttempt(engine, writerId)?.state === 'waiting', 'Custody to wait behind the delivery claim', 60_000, 100);
    assert.equal(writerAttempt(engine, writerId).process_id, null, 'Custody has not launched while the delivery holds the root');
    assert.equal(writesIntoRepository(env.launches.filter(item => item.runId === managedId)).length, 0, 'the delivery holds its claim before any write');
    release.resolve();
    await settleBoth(api, writerId, managedId);
    await leaksNothing(engine);
    const t = timeline(engine, env, writerId, managedId);
    assert.deepEqual(claims.map(claim => claim.side), ['delivery', 'custody'], 'the claim order is delivery, then Custody');
    assert.ok(t.deliveryEnded <= t.cliStarted, 'Custody launched only after the delivery ended');
    assertNoOverlap(t);
    assert.equal(t.cliInvocations, 1, 'the Custody CLI was started exactly once');
    evidence.cases['F7-06-race-B'] = { winner: 'delivery', physicalRoot: t.root, claimOrder: claims.map(claim => claim.side), cliPid: t.cliPid,
      cliStartedAt: new Date(t.cliStarted).toISOString(), deliveryEndedAt: new Date(t.deliveryEnded).toISOString(), cliInvocations: t.cliInvocations, reservationsLeaked: 0 };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

test('F7-06 Race C (simultaneous): a Custody run and a delivery submitted together are each admitted by one synchronous check-and-claim; never both', async () => {
  const env = await startEnvironment('f7-race-c');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const ready = join(scratch.root, 'ready'), smoke = join(scratch.root, 'smoke');
    writeFileSync(ready, '1');
    await registerWorkspace(api, 'writer-race-c', workspace.cwd);
    const claims = claimRecorder(engine, workspace.cwd);
    const [managed, writer] = await Promise.all([api.run(managedWorkflow(env, ready, smoke), 'main'), api.run(writerWorkflow(20), 'writer-race-c')]);
    const managedId = managed.body.run.runId, writerId = writer.body.run.runId;
    await settleBoth(api, writerId, managedId);
    await leaksNothing(engine);
    const t = timeline(engine, env, writerId, managedId);
    assert.equal(claims.length, 2, 'each side claimed the root exactly once');
    const [first, second] = claims;
    const firstReleased = first.side === 'custody' ? t.released : t.deliveryEnded;
    assert.ok(second.at >= firstReleased - 1, 'the second claim was taken only after the first side released the root');
    assertNoOverlap(t);
    assert.equal(t.cliInvocations, 1, 'the Custody CLI was started exactly once');
    evidence.cases['F7-06-race-C'] = { winner: first.side, physicalRoot: t.root, claimOrder: claims.map(claim => claim.side), claimTimesMs: claims.map(claim => claim.at),
      cliPid: t.cliPid, cliStartedAt: new Date(t.cliStarted).toISOString(), releasedAt: new Date(t.released).toISOString(),
      firstRepositoryWriteAt: new Date(t.firstWrite).toISOString(), deliveryEndedAt: new Date(t.deliveryEnded).toISOString(), cliInvocations: t.cliInvocations, reservationsLeaked: 0 };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

// F7-08, overlapping Custody roots. A Custody claim on a directory holds the root for its overlapping directories as well: a second Custody run in
// a nested directory (another workspace id, the same physical tree) waits behind the first claim, and launches only after the first CLI has ended.
test('F7-08: a Custody run in a nested directory waits behind a Custody claim on its parent root, and launches only after that CLI ended', async () => {
  const env = await startEnvironment('f7-nested-custody');
  const { api, engine, workspace, host, scratch } = env;
  try {
    const nested = join(workspace.cwd, 'nested-root');
    mkdirSync(nested, { recursive: true });
    await registerWorkspace(api, 'writer-parent-custody', workspace.cwd);
    await registerWorkspace(api, 'writer-nested-custody', nested);
    const release = deferred();
    const claims = [];
    engine.testBarrier = (name, detail) => {
      if (name !== 'custody-claimed') return null;
      claims.push({ cwd: detail.workspaceCwd, at: Date.now() });
      return claims.length === 1 ? release.promise : null;
    };
    const parent = await api.run(writerWorkflow(20), 'writer-parent-custody');
    const parentId = parent.body.run.runId;
    await eventually(() => claims.length === 1, 'the parent Custody claim to be taken', 60_000, 50);
    const child = await api.run(writerWorkflow(20), 'writer-nested-custody');
    const childId = child.body.run.runId;
    await eventually(() => writerAttempt(engine, childId)?.state === 'waiting', 'the nested Custody attempt to wait behind the parent claim', 30_000, 100);
    assert.equal(writerAttempt(engine, childId).process_id, null, 'the nested CLI has not launched while the parent claim holds the root');
    assert.equal(claims.length, 1, 'the nested claim was not taken while the parent holds the root');
    release.resolve();
    const parentDone = await api.waitFor(parentId, run => SETTLED.includes(run.state), 150_000);
    const childDone = await api.waitFor(childId, run => SETTLED.includes(run.state), 150_000);
    assert.equal(parentDone.run.state, 'succeeded', JSON.stringify(parentDone.run));
    assert.equal(childDone.run.state, 'succeeded', JSON.stringify(childDone.run));
    await leaksNothing(engine);
    const parentHold = engine.store.get('SELECT * FROM custody_workspace_holds WHERE attempt_id = ?', writerAttempt(engine, parentId).id);
    const childStarted = Date.parse(writerAttempt(engine, childId).started_at);
    assert.ok(Date.parse(parentHold.released_at) <= childStarted, 'the nested CLI launched only after the parent CLI ended');
    assert.equal(readInvocations(scratch.fixtureState).length, 2, 'each Custody CLI was started exactly once');
    evidence.cases['F7-08'] = { physicalRoots: [realpathSync.native(workspace.cwd), realpathSync.native(nested)], claimOrder: ['parent', 'nested'],
      parentReleasedAt: parentHold.released_at, nestedStartedAt: writerAttempt(engine, childId).started_at, invocations: readInvocations(scratch.fixtureState).length, reservationsLeaked: 0 };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});

// F7-09, a Stop while the Custody claim is held. The Stop arrives before any CLI exists; when the claim proceeds, the admission is withdrawn and no
// CLI is launched. The attempt ends canceled, never failed as a provider error, and nothing is left reserved.
test('F7-09: a Stop that arrives while a Custody claim is held cancels the attempt before any CLI launches', async () => {
  const env = await startEnvironment('f7-stop-before-launch');
  const { api, engine, host, scratch } = env;
  try {
    const release = deferred();
    engine.testBarrier = (name) => (name === 'custody-claimed' ? release.promise : null);
    const writer = await api.run(writerWorkflow(20), 'main');
    const writerId = writer.body.run.runId;
    await eventually(() => engine.processes.size > 0, 'the Custody claim to be taken', 60_000, 50);
    const stop = await api.call('POST', `/api/v2/runs/${writerId}/stop`, { requestId: randomUUID() });
    assert.equal(stop.status, 202, JSON.stringify(stop.body));
    release.resolve();
    const done = await api.waitFor(writerId, run => SETTLED.includes(run.state), 120_000);
    assert.equal(done.run.state, 'canceled', JSON.stringify(done.run));
    const attempt = writerAttempt(engine, writerId);
    assert.equal(attempt.state, 'canceled', 'the attempt ended canceled, not failed as a provider error');
    assert.equal(attempt.process_id, null, 'no CLI was launched');
    assert.equal(readInvocations(scratch.fixtureState).length, 0, 'the provider was never invoked');
    await leaksNothing(engine);
    evidence.cases['F7-09'] = { runId: writerId, attemptState: attempt.state, providerInvocations: 0, reservationsLeaked: 0 };
  } finally {
    await api.close();
    host.crash();
    cleanup(scratch.root);
  }
});
