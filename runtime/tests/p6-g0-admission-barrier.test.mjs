// P6-G0-FINAL admission barrier (ADR-0010 section 5). A quiescing Engine admits no executable Run from any path, the switch
// closes admission before the Host sees it, a switch waits for Runs already admitted and then proceeds without deadlock, a refused
// switch reopens admission, and admitted work keeps settling while quiescing. The Lifecycle Host is a test double here;
// the Engine's Store and its admission and coordination code are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertAdmissionOpen, requestEngineSwitch, SwitchRefusal } from '../host/p6Switch.mjs';
import { startTestRunner } from './helpers.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A Lifecycle Host double that records what the Host was asked and whether this Engine was quiescing at that moment.
function fakeBridge({ switchResult = { accepted: true, phase: 'fenced' }, stageGate = null } = {}) {
  const bridge = {
    commands: [],
    seen: [],
    engine: null,
    context: { buildId: 'engine-a', shellBuildId: 'shell-g0', generation: 'g0-barrier', applicationPid: process.pid },
    ready: async () => ({}),
    acknowledgeReceipt: async () => ({}),
    activateCandidate: async () => ({}),
    p6Call: async command => {
      bridge.commands.push(command);
      bridge.seen.push({ command, quiescent: bridge.engine?.switchQuiescence?.active === true });
      if (command === 'engine.stage') {
        if (stageGate) await stageGate;
        return { phase: 'staged' };
      }
      if (command === 'engine.switch') return switchResult;
      return { accepted: false, phase: 'rolled_back' };
    },
  };
  return bridge;
}

// A candidate Run request that the barrier must refuse. The barrier is the first statement of captureRun, so no other argument is read.
const candidateAdmission = () => ({ workflow: { capabilities: [] }, snapshot: {}, workspace: {}, kind: 'workflow', options: {},
  requestId: randomUUID() });

const switchBody = () => ({ operationId: randomUUID(), targetEngineBuildId: 'engine-b', packageSha256: 'a'.repeat(64) });

test('P6-G0 barrier: a quiescing Engine refuses Run admission at its creation point and leaves no row, event or receipt', { timeout: 120_000 }, async () => {
  const bridge = fakeBridge();
  const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
  try {
    const engine = api.runner.engine;
    const count = sql => engine.store.get(sql).count;
    const before = { runs: count('SELECT COUNT(*) AS count FROM runs'), receipts: count('SELECT COUNT(*) AS count FROM command_receipts') };
    engine.switchQuiescence.active = true;
    try {
      assert.throws(() => engine.captureRun(candidateAdmission()), error => error.status === 503 && error.code === 'switch_in_progress');
      assert.deepEqual({ runs: count('SELECT COUNT(*) AS count FROM runs'), receipts: count('SELECT COUNT(*) AS count FROM command_receipts') },
        before, 'a refused admission writes no Run row and no command receipt');
    } finally {
      engine.switchQuiescence.active = false;
    }
  } finally {
    await api.close();
  }
});

test('P6-G0 barrier: every executable Run is created by one INSERT, and that INSERT follows the barrier inside captureRun', () => {
  const source = readFileSync(new URL('../core/engine.mjs', import.meta.url), 'utf8');
  const inserts = [...source.matchAll(/INSERT INTO runs\(/g)].map(match => match.index);
  assert.equal(inserts.length, 1, 'exactly one production statement creates a Run row, so no path can bypass the barrier');
  const barrier = source.indexOf("if (this.switchQuiescence?.active) throw new ApiError(503, 'switch_in_progress'");
  const captureRun = source.indexOf('  captureRun({ workflow, snapshot');
  assert.ok(captureRun >= 0 && barrier > captureRun && inserts[0] > barrier, 'the barrier is the first check of captureRun, before its INSERT');
});

test('P6-G0 barrier: the switch closes admission before the Host sees it, and an admission racing that closure is refused', { timeout: 120_000 }, async () => {
  const bridge = fakeBridge();
  const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
  try {
    const engine = api.runner.engine;
    bridge.engine = engine;
    const switching = requestEngineSwitch({ engine, lifecycleHost: bridge, quiescence: engine.switchQuiescence, body: switchBody() });
    // requestEngineSwitch closes admission in its synchronous prelude, before its first await: an admission issued now races it.
    assert.throws(() => engine.captureRun(candidateAdmission()), error => error.code === 'switch_in_progress');
    const result = await switching;
    assert.equal(result.accepted, true);
    assert.deepEqual(bridge.commands, ['engine.stage', 'engine.switch'], 'the Host is asked to stage, then to switch, in that order');
    assert.ok(bridge.seen.every(entry => entry.quiescent), 'the Host saw the admission boundary already closed for both requests');
    assert.equal(engine.switchQuiescence.active, true, 'an accepted switch keeps this Engine closed while the Host stops it');
  } finally {
    api.runner.engine.switchQuiescence.active = false;
    await api.close();
  }
});

test('P6-G0 barrier: a switch waits for a Run admitted before quiescence, settles it, and then proceeds without deadlock', { timeout: 120_000 }, async () => {
  const bridge = fakeBridge();
  const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
  try {
    const engine = api.runner.engine;
    bridge.engine = engine;
    const store = engine.store;
    const now = new Date().toISOString();
    // A Run admitted earlier and still executing: its snapshot, settings and workspace are real rows, so the Store's keys hold.
    const snapshot = store.putJson({ schemaVersion: 1, kind: 'p6-barrier-snapshot' }).artifactId;
    const settings = store.putJson({ schemaVersion: 1, kind: 'p6-barrier-settings' }).artifactId;
    store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'ws-barrier', store.workdirs, 'b'.repeat(64), now, now);
    store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?)', 'wf-barrier', snapshot, now, now);
    // A workflow Run binds an exact Published Version and digest, as the Store requires of every workflow Run.
    const publicationId = randomUUID();
    const definitionDigest = 'd'.repeat(64);
    store.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,
      authority_policy_version,provenance,runnable,validation_json,source_draft_revision,created_at)
      VALUES(?,?,1,?,?,?,?, 'owner-publication',1,'{}',1,?)`, publicationId, 'wf-barrier', snapshot, definitionDigest, 'e'.repeat(64),
    'designated-judge/1', now);
    const runId = randomUUID();
    store.run(`INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,published_version_id,definition_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, runId, 'wf-barrier', 'ws-barrier', snapshot, settings, 'a'.repeat(64), 'running', now, publicationId, definitionDigest);

    const switching = requestEngineSwitch({ engine, lifecycleHost: bridge, quiescence: engine.switchQuiescence, body: switchBody() });
    await pause(400);
    assert.deepEqual(bridge.commands, [], 'the Host is not asked while the admitted Run still executes');
    store.run("UPDATE runs SET state = 'succeeded' WHERE id = ?", runId);
    const result = await switching;
    assert.equal(result.accepted, true, 'the switch proceeds once the admitted Run has settled');
    assert.deepEqual(bridge.commands, ['engine.stage', 'engine.switch']);
  } finally {
    api.runner.engine.switchQuiescence.active = false;
    await api.close();
  }
});

test('P6-G0 barrier: a refused switch reopens admission, and a refused stage or switch admits Runs again', { timeout: 120_000 }, async () => {
  const bridge = fakeBridge({ switchResult: { accepted: false, phase: 'rolled_back' } });
  const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
  try {
    const engine = api.runner.engine;
    bridge.engine = engine;
    await assert.rejects(requestEngineSwitch({ engine, lifecycleHost: bridge, quiescence: engine.switchQuiescence, body: switchBody() }),
      error => error instanceof SwitchRefusal && error.code === 'switch_refused');
    assert.equal(engine.switchQuiescence.active, false, 'the refused switch clears the quiescence');
    // The creation barrier tests exactly this flag (engine.captureRun), so it is open again once the flag is clear.
    assert.doesNotThrow(() => assertAdmissionOpen(engine.switchQuiescence), 'the public admission gate is open again');
  } finally {
    await api.close();
  }
});

// A P2 fixture of the shape the P2 proofs use: a Parent run waiting for its user, and an exact Runnable Repair publication.
const digest = value => createHash('sha256').update(value).digest('hex');
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const parentFlow = workflowId => ({ schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [
    { id: 'a', type: 'text', config: { value: 'P6_BARRIER_PARENT_A' } },
    { id: 'b', type: 'agent', config: { provider: 'codex', model: 'fixture-fail-once', timeoutSeconds: 30, output: { format: 'text' } } },
    { id: 'c', type: 'agent', config: { provider: 'codex', model: 'fixture-echo', timeoutSeconds: 30, output: { format: 'text' } } },
    { id: 'result', type: 'result-viewer', config: {} },
  ], edges: [edge('a-b', 'a', 'text', 'b', 'prompt'), edge('b-c', 'b', 'text', 'c', 'prompt'), edge('c-result', 'c', 'text', 'result', 'value')], after: [] });
const repairFlow = workflowId => ({ schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [{ id: 'verified', type: 'text', config: { value: 'P6_BARRIER_REPAIR_VERIFIED' } }, { id: 'result', type: 'result-viewer', config: {} }],
  edges: [edge('verified-result', 'verified', 'text', 'result', 'value')], after: [] });

async function parentAwaitingRepair(api, suffix) {
  await api.workspace(`barrier-${suffix}-parent`);
  await api.workspace(`barrier-${suffix}-repair`);
  const parent = await api.save(parentFlow(`barrier-${suffix}-parent-flow`));
  const repair = await api.save(repairFlow(`barrier-${suffix}-repair-flow`));
  const started = await api.call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
    publishedVersionId: api.publication(parent.workflow.workflowId).publishedVersionId,
    definitionDigest: api.publication(parent.workflow.workflowId).definitionDigest, workspaceId: `barrier-${suffix}-parent`, requestId: randomUUID() });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await api.waitFor(started.body.run.runId, run => run.state === 'waiting_for_user');
  return { repair, parentRunId: started.body.run.runId, repairWorkspaceId: `barrier-${suffix}-repair` };
}

function linkedRepairRequest(context) {
  return { requestId: randomUUID(), incidentId: randomUUID(), failedNodeInstanceId: 'b', repairWorkflowId: context.repair.workflow.workflowId,
    repairWorkflowSnapshotSha256: context.repair.snapshotSha256, repairWorkspaceId: context.repairWorkspaceId,
    repairResultNodeInstanceId: 'verified', expectedRepairResultSha256: digest('P6_BARRIER_REPAIR_VERIFIED'), failedNodeRetry: 'explicit_safe' };
}

test('P6-G0 barrier: an internal linked Repair cannot be admitted while quiescing, and the same request is admitted once admission reopens', { timeout: 300_000 }, async () => {
  const api = await startTestRunner();
  try {
    const context = await parentAwaitingRepair(api, 'linked');
    const engine = api.runner.engine;
    const count = sql => engine.store.get(sql).count;
    const before = { runs: count('SELECT COUNT(*) AS count FROM runs'), links: count('SELECT COUNT(*) AS count FROM run_links'),
      receipts: count('SELECT COUNT(*) AS count FROM command_receipts') };
    const request = linkedRepairRequest(context);
    engine.switchQuiescence.active = true;
    try {
      // The Engine's own linked-Repair path (no HTTP dispatcher in front of it) reaches the creation barrier and is refused there.
      assert.throws(() => engine.linkRepair(context.parentRunId, request), error => error.code === 'switch_in_progress');
      assert.deepEqual({ runs: count('SELECT COUNT(*) AS count FROM runs'), links: count('SELECT COUNT(*) AS count FROM run_links'),
        receipts: count('SELECT COUNT(*) AS count FROM command_receipts') }, before, 'a refused linked Repair admits no Run, no link and no receipt');
      assert.equal(engine.store.get('SELECT state FROM runs WHERE id = ?', context.parentRunId).state, 'waiting_for_user',
        'the Parent stays suspended for its user');
    } finally {
      engine.switchQuiescence.active = false;
    }
    // The same request is admitted once admission reopens: the refusal was the barrier, not the request.
    const admitted = engine.linkRepair(context.parentRunId, request);
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  } finally {
    await api.close();
  }
});

test('P6-G0 barrier: an unconfirmed switch reply keeps this Engine quiesced while the Host may have accepted, and reopens only on a pre-acceptance phase', { timeout: 120_000 }, async () => {
  // Each case is the Host's answer to the re-sent switch after a lost first reply: accepted, refused, or refused with a stable code (M1, M-1).
  const cases = [
    { phase: 'accepted', accepted: true, answer: { accepted: true, phase: 'fenced' } },
    { phase: 'refused', accepted: false, answer: { accepted: false, phase: 'staged' } },
    { phase: 'coded refusal', accepted: false, answer: Object.assign(new Error('custody_jobs_active'), { code: 'custody_jobs_active' }) },
  ];
  for (const { phase, accepted, answer } of cases) {
    const bridge = fakeBridge();
    let switchCalls = 0;
    bridge.p6Call = async command => {
      bridge.commands.push(command);
      if (command === 'engine.stage') return { phase: 'staged' };
      if (command === 'engine.switch') {
        switchCalls += 1;
        // The first reply is lost (no coded refusal); the re-sent request gets the Host's decision.
        if (switchCalls === 1) throw new Error('Lifecycle Host IPC timed out.');
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return {};
    };
    const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
    try {
      const engine = api.runner.engine;
      bridge.engine = engine;
      const outcome = requestEngineSwitch({ engine, lifecycleHost: bridge, quiescence: engine.switchQuiescence, body: switchBody() });
      if (accepted) {
        assert.equal((await outcome).accepted, true, `phase ${phase}: the Host accepted the switch`);
        assert.equal(engine.switchQuiescence.active, true, `phase ${phase}: the Host will stop this Engine, so admission stays closed`);
      } else {
        await assert.rejects(outcome, error => error instanceof SwitchRefusal && error.code === 'switch_refused');
        assert.equal(engine.switchQuiescence.active, false, `phase ${phase}: the Host recorded no accepted switch, so admission reopens`);
      }
    } finally {
      api.runner.engine.switchQuiescence.active = false;
      await api.close();
    }
  }
});

test('P6-G0 barrier: a quiescing Engine lets admitted work settle: settling routes stay open, and an owner route that starts a Run is refused', { timeout: 120_000 }, async () => {
  const bridge = fakeBridge();
  const api = await startTestRunner({ runner: { lifecycleHostBridge: bridge } });
  const { port, token } = api.runner.connection;
  const send = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const engine = api.runner.engine;
    engine.switchQuiescence.active = true;
    try {
      // Judge decisions, observation acknowledgements and escalation extensions settle work the Engine already admitted. None is
      // refused by the admission barrier, whatever outcome its own validation gives this request.
      const runId = randomUUID();
      for (const path of ['/api/v2/judge-decisions', `/api/v2/runs/${runId}/observation-acks`, `/api/v2/runs/${runId}/control-extension`]) {
        const response = await send('POST', path, {});
        const body = await response.json().catch(() => ({}));
        assert.notEqual(body.code, 'switch_in_progress', `${path} settles admitted work while the Engine quiesces`);
      }
      // A route that would start a Run is refused at the barrier, before its body is read.
      const started = await send('POST', '/api/v2/runs', {});
      assert.equal(started.status, 503);
      assert.equal((await started.json()).code, 'switch_in_progress');
    } finally {
      engine.switchQuiescence.active = false;
    }
  } finally {
    await api.close();
  }
});
