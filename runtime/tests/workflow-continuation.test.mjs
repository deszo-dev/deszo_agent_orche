import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readdir, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');

// Spawns a real OS process of the Deszo Engine runner CLI.
async function spawnEngineProcess({ root, fixtureState }) {
  await mkdir(testsRoot, { recursive: true });
  await mkdir(fixtureState, { recursive: true });
  
  const child = spawn(process.execPath, [
    'runtime/runner.mjs',
    '--root', root,
    '--fixture-state', fixtureState,
    '--first-party-token-stdout',
    '--dev-test-confirmation-off',
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  const connection = await new Promise((resolvePromise, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.port && parsed.firstPartyToken) {
            child.stdout.off('data', onData);
            resolvePromise(parsed);
            return;
          }
        } catch { /* wait for more */ }
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Engine process exited prematurely with code ${code}`)));
  });

  const callWithToken = async (bearer, method, path, body, { raw = false, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (raw) return response;
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  const call = (method, path, body, options) => callWithToken(connection.firstPartyToken, method, path, body, options);

  const workflowEtags = new Map();
  const api = {
    pid: child.pid,
    connection,
    call,
    async createWorkspace(id = 'main') {
      const result = await call('PUT', `/api/v2/workspaces/${id}`, { cwd: join(connection.scratchRoot, id) });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      return result.body;
    },
    async saveWorkflow(workflow) {
      const expectedEtag = workflowEtags.get(workflow.workflowId) ?? null;
      const requestId = randomUUID();
      const result = await call('PUT', `/api/v4/workflows/${workflow.workflowId}/draft`, { requestId, workflow }, {
        headers: expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag },
      });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      workflowEtags.set(workflow.workflowId, result.body.etag);
      const validation = await call('POST', `/api/v4/workflows/${workflow.workflowId}/draft/validate`, {}, { headers: { 'If-Match': result.body.etag } });
      if (validation.status !== 200 || !validation.body.validation.valid) throw new Error(JSON.stringify(validation.body));
      const publication = await call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': result.body.etag } });
      if (publication.status !== 201) throw new Error(JSON.stringify(publication.body));
      return publication.body;
    },
    async waitFor(runId, predicate = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state), timeout = 30_000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const snapshot = await call('GET', `/api/v2/runs/${runId}`);
        if (predicate(snapshot.body.run, snapshot.body)) return snapshot.body;
        await new Promise(done => setTimeout(done, 50));
      }
      throw new Error(`Run ${runId} did not reach expected state within ${timeout}ms.`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      return new Promise(resolvePromise => {
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          resolvePromise();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
        try { child.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n'); } catch {
          clearTimeout(timer);
          resolvePromise();
        }
      });
    },
    async kill() {
      if (child.exitCode !== null) return;
      return new Promise(resolvePromise => {
        const timer = setTimeout(() => resolvePromise(), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
        try { child.kill(); } catch {
          clearTimeout(timer);
          resolvePromise();
        }
      });
    },
  };

  return api;
}

// Builds a sequential 3-agent workflow: Developer -> Watcher -> Judge -> Result Viewer
function buildThreeAgentWorkflow(workflowId, { devModel = 'fixture-echo', watcherModel = 'fixture-echo', judgeModel = 'fixture-echo' } = {}) {
  return {
    schemaVersion: 1,
    workflowId,
    capabilities: ['core-v1'],
    settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Autonomous delivery request.' } },
      { id: 'developer', type: 'agent', config: { provider: 'codex', model: devModel, timeoutSeconds: 60, output: { format: 'text' } } },
      { id: 'watcher', type: 'agent', config: { provider: 'codex', model: watcherModel, timeoutSeconds: 60, output: { format: 'text' } } },
      { id: 'judge', type: 'agent', config: { provider: 'codex', model: judgeModel, timeoutSeconds: 60, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'req-dev', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'developer', port: 'prompt' } },
      { id: 'dev-watch', source: { nodeId: 'developer', port: 'text' }, target: { nodeId: 'watcher', port: 'prompt' } },
      { id: 'watch-judge', source: { nodeId: 'watcher', port: 'text' }, target: { nodeId: 'judge', port: 'prompt' } },
      { id: 'judge-res', source: { nodeId: 'judge', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    ],
    after: [],
  };
}

// Counts model invocations from the fixture log directory
async function countInvocations(fixtureState) {
  let count = 0;
  try {
    const files = await readdir(fixtureState);
    for (const file of files) {
      if (file.endsWith('.log')) {
        const text = await readFile(join(fixtureState, file), 'utf8');
        const turns = text.split('\n␞\n').filter(Boolean).length;
        count += turns;
      }
    }
  } catch { /* directory might not exist yet */ }
  return count;
}

// Scope note (2026-10-22 independent verification): this test is HARNESS-DRIVEN. After the restart the test itself
// creates every repair and parent run through POST /api/v2/runs (mode 'node'), writes the test-only tables
// `test_only_workflow_continuations` and `test_only_lifecycle_operations` directly in SQLite, and checks Judge-only authorization with a
// function defined in this file rather than production code. It verifies durable outputs and predecessor reuse across a
// real process restart. It does NOT verify autonomous continuation; see workflow-continuation-strict.test.mjs and
// docs/reviews/2026-10-22-workflow-continuation-independent-verification.md.
test('CONT (harness-driven): committed outputs survive a real restart and are reused by harness-created mode:node runs', async () => {
  const root = await mkdtemp(join(testsRoot, 'root-continuation-'));
  const fixtureState = join(root, 'fixture-state');
  const dbPath = join(root, 'store', 'state.sqlite');
  let engine1, engine2;

  try {
    // -------------------------------------------------------------------------
    // Phase A: Start Original Workflow in Engine Process 1
    // -------------------------------------------------------------------------
    engine1 = await spawnEngineProcess({ root, fixtureState });
    assert.ok(engine1.pid > 0, 'Engine 1 must have a valid OS PID');
    await engine1.createWorkspace('main');
    await engine1.createWorkspace('main-repair');

    const parentWf = buildThreeAgentWorkflow('parent-delivery');
    const savedParent = await engine1.saveWorkflow(parentWf);

    // Execute Phase A: run Developer in workspace 'main'.
    const initialRunRes = await engine1.call('POST', '/api/v2/runs', {
      workflowId: 'parent-delivery',
      workflowSnapshotSha256: savedParent.snapshotSha256,
      publishedVersionId: savedParent.publishedVersionId,
      definitionDigest: savedParent.definitionDigest,
      workspaceId: 'main',
      requestId: randomUUID(),
      mode: 'branch',
      targets: ['developer'],
    });
    assert.equal(initialRunRes.status, 202, JSON.stringify(initialRunRes.body));
    const parentRunId = initialRunRes.body.run.runId;

    const phaseASnapshot = await engine1.waitFor(parentRunId, run => run.state === 'succeeded');
    assert.equal(phaseASnapshot.run.state, 'succeeded');
    
    // Verify Developer completed and output was committed in SQLite (CONT-01)
    const devInstance = phaseASnapshot.instances.find(item => item.nodeInstanceId === 'developer');
    assert.equal(devInstance.state, 'succeeded');
    assert.ok(devInstance.outputs?.artifactId, 'Developer must have committed outputs artifact');

    const devInvocationsAfterPhaseA = await countInvocations(fixtureState);
    assert.equal(devInvocationsAfterPhaseA, 1, 'Developer must have been invoked exactly once');

    // -------------------------------------------------------------------------
    // Phase B: Interrupt / Suspend Parent Workflow with Linked Repair Record
    // -------------------------------------------------------------------------
    const repairRunId = randomUUID();
    const sqlite1 = new DatabaseSync(dbPath);
    
    // Durably record suspension & linkage to repair workflow (CONT-01, CONT-02, CONT-03)
    sqlite1.exec(`
      CREATE TABLE IF NOT EXISTS test_only_workflow_continuations (
        parent_run_id TEXT PRIMARY KEY,
        parent_workflow_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        linked_repair_run_id TEXT,
        next_logical_node TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    sqlite1.prepare(`
      INSERT INTO test_only_workflow_continuations (
        parent_run_id, parent_workflow_id, workspace_id, state, reason, linked_repair_run_id, next_logical_node, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parentRunId,
      'parent-delivery',
      'main',
      'suspended',
      'linked_repair',
      repairRunId,
      'watcher',
      new Date().toISOString()
    );
    sqlite1.close();

    // -------------------------------------------------------------------------
    // Phase C: Run Linked Repair Workflow in Isolated Workspace
    // -------------------------------------------------------------------------
    const repairWf = buildThreeAgentWorkflow('deszo-self-repair');
    const savedRepair = await engine1.saveWorkflow(repairWf);

    // Repair Developer prepares the fix
    const repairDevRes = await engine1.call('POST', '/api/v2/runs', {
      workflowId: 'deszo-self-repair',
      workflowSnapshotSha256: savedRepair.snapshotSha256,
      publishedVersionId: savedRepair.publishedVersionId,
      definitionDigest: savedRepair.definitionDigest,
      workspaceId: 'main-repair',
      requestId: randomUUID(),
      mode: 'branch',
      targets: ['developer'],
    });
    assert.equal(repairDevRes.status, 202);
    const repairRunDevId = repairDevRes.body.run.runId;
    await engine1.waitFor(repairRunDevId, run => run.state === 'succeeded');

    // Repair Watcher verifies the fix
    const repairWatchRes = await engine1.call('POST', '/api/v2/runs', {
      workflowId: 'deszo-self-repair',
      workflowSnapshotSha256: savedRepair.snapshotSha256,
      publishedVersionId: savedRepair.publishedVersionId,
      definitionDigest: savedRepair.definitionDigest,
      workspaceId: 'main-repair',
      requestId: randomUUID(),
      mode: 'node',
      targets: ['watcher'],
    });
    assert.equal(repairWatchRes.status, 202);
    const repairRunWatchId = repairWatchRes.body.run.runId;
    await engine1.waitFor(repairRunWatchId, run => run.state === 'succeeded');

    // Test-local stand-in only: no production Engine/Host code implements this check, so these assertions do not
    // verify CONT-09 against production behavior.
    function authorizeLifecycleProposal({ role, action, candidateDigest }) {
      if (action !== 'application.activate_candidate') {
        throw { status: 400, code: 'invalid_action', message: `Unknown lifecycle action "${action}".` };
      }
      if (role !== 'judge') {
        throw { status: 403, code: 'lifecycle_unauthorized', message: `Only an authorized Judge role may propose ${action}; role "${role}" is forbidden.` };
      }
      return {
        operationId: randomUUID(),
        action,
        candidateDigest,
        proposedBy: role,
        outcome: 'in_progress',
        proposedAt: new Date().toISOString(),
      };
    }

    assert.throws(
      () => authorizeLifecycleProposal({ role: 'developer', action: 'application.activate_candidate', candidateDigest: 'sha256-cand-v2' }),
      err => err.status === 403 && err.code === 'lifecycle_unauthorized',
      'Developer must be rejected from proposing application.activate_candidate'
    );
    assert.throws(
      () => authorizeLifecycleProposal({ role: 'watcher', action: 'application.activate_candidate', candidateDigest: 'sha256-cand-v2' }),
      err => err.status === 403 && err.code === 'lifecycle_unauthorized',
      'Watcher must be rejected from proposing application.activate_candidate'
    );

    // Only Judge proposes application.activate_candidate
    const lifecycleProposal = authorizeLifecycleProposal({
      role: 'judge',
      action: 'application.activate_candidate',
      candidateDigest: 'sha256-cand-v2-synthetic',
    });
    assert.equal(lifecycleProposal.proposedBy, 'judge');
    assert.equal(lifecycleProposal.outcome, 'in_progress');

    // Persist lifecycle proposal intent in durable SQLite host operations table
    const sqliteLifecycle = new DatabaseSync(dbPath);
    sqliteLifecycle.exec(`
      CREATE TABLE IF NOT EXISTS test_only_lifecycle_operations (
        operation_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        candidate_digest TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        outcome TEXT NOT NULL,
        proposed_at TEXT NOT NULL,
        receipt_at TEXT
      );
    `);
    sqliteLifecycle.prepare(`
      INSERT INTO test_only_lifecycle_operations (
        operation_id, action, candidate_digest, proposed_by, outcome, proposed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      lifecycleProposal.operationId,
      lifecycleProposal.action,
      lifecycleProposal.candidateDigest,
      lifecycleProposal.proposedBy,
      lifecycleProposal.outcome,
      lifecycleProposal.proposedAt
    );
    sqliteLifecycle.close();

    // -------------------------------------------------------------------------
    // Phase D: Restart Engine across Real Operating System Process Boundary
    // -------------------------------------------------------------------------
    const engine1Pid = engine1.pid;
    await engine1.stop();

    // Verify engine 1 is dead
    assert.throws(() => process.kill(engine1Pid, 0), /ESRCH/, 'Engine Process 1 must be terminated');

    // Spawn Engine Process 2 against the exact same root
    engine2 = await spawnEngineProcess({ root, fixtureState });
    assert.ok(engine2.pid > 0, 'Engine 2 must have an OS PID');
    assert.notEqual(engine2.pid, engine1Pid, 'Engine 2 must cross a real OS process boundary (different PID)');

    // Verify SQLite state survived restart intact (CONT-04, CONT-07)
    const sqlite2 = new DatabaseSync(dbPath);
    const savedContinuation = sqlite2.prepare('SELECT * FROM test_only_workflow_continuations WHERE parent_run_id = ?').get(parentRunId);
    assert.ok(savedContinuation, 'Continuation record must exist after restart');
    assert.equal(savedContinuation.linked_repair_run_id, repairRunId);
    assert.equal(savedContinuation.next_logical_node, 'watcher');

    const opRecord = sqlite2.prepare('SELECT * FROM test_only_lifecycle_operations WHERE operation_id = ?').get(lifecycleProposal.operationId);
    assert.equal(opRecord.outcome, 'in_progress');

    // Simulate Host confirming application candidate replacement
    sqlite2.prepare("UPDATE test_only_lifecycle_operations SET outcome = 'verified', receipt_at = ? WHERE operation_id = ?").run(
      new Date().toISOString(),
      lifecycleProposal.operationId
    );
    sqlite2.close();

    // -------------------------------------------------------------------------
    // Phase E: Finish Repair Workflow after Restart
    // -------------------------------------------------------------------------
    // Execute Judge in repair workflow; Developer and Watcher are REUSED without re-execution (CONT-05, CONT-07)
    const repairJudgeRes = await engine2.call('POST', '/api/v2/runs', {
      workflowId: 'deszo-self-repair',
      workflowSnapshotSha256: savedRepair.snapshotSha256,
      publishedVersionId: savedRepair.publishedVersionId,
      definitionDigest: savedRepair.definitionDigest,
      workspaceId: 'main-repair',
      requestId: randomUUID(),
      mode: 'node',
      targets: ['judge'],
    });
    assert.equal(repairJudgeRes.status, 202);
    const repairJudgeRunId = repairJudgeRes.body.run.runId;
    const repairJudgeSnapshot = await engine2.waitFor(repairJudgeRunId, run => run.state === 'succeeded');
    assert.equal(repairJudgeSnapshot.run.state, 'succeeded');
    
    // Repair Watcher was reused
    const repairWatchInstance = repairJudgeSnapshot.instances.find(item => item.nodeInstanceId === 'watcher');
    assert.equal(repairWatchInstance.state, 'reused', 'Repair Watcher must be reused without re-running');

    // Update continuation state: repair is complete, parent is clear to continue (CONT-06, CONT-10)
    const sqliteUpdate = new DatabaseSync(dbPath);
    sqliteUpdate.prepare("UPDATE test_only_workflow_continuations SET state = 'repair_completed' WHERE parent_run_id = ?").run(parentRunId);
    sqliteUpdate.close();

    // -------------------------------------------------------------------------
    // Phase F: Resume Original Parent Workflow from Next Unfinished Operation
    // -------------------------------------------------------------------------
    // Parent continues: next unfinished node is 'watcher'
    const parentWatcherRes = await engine2.call('POST', '/api/v2/runs', {
      workflowId: 'parent-delivery',
      workflowSnapshotSha256: savedParent.snapshotSha256,
      publishedVersionId: savedParent.publishedVersionId,
      definitionDigest: savedParent.definitionDigest,
      workspaceId: 'main',
      requestId: randomUUID(),
      mode: 'node',
      targets: ['watcher'],
    });
    assert.equal(parentWatcherRes.status, 202);
    const parentWatcherRunId = parentWatcherRes.body.run.runId;
    const parentWatcherSnapshot = await engine2.waitFor(parentWatcherRunId, run => run.state === 'succeeded');
    assert.equal(parentWatcherSnapshot.run.state, 'succeeded');

    // CRITICAL ASSERTION (CONT-07, CONT-09, CONT-10):
    // Developer in the parent workflow was REUSED from Run 1!
    const devInstanceInResumed = parentWatcherSnapshot.instances.find(item => item.nodeInstanceId === 'developer');
    assert.equal(devInstanceInResumed.state, 'reused', 'Parent Developer must be marked reused');

    // Complete the parent workflow with Judge
    const parentJudgeRes = await engine2.call('POST', '/api/v2/runs', {
      workflowId: 'parent-delivery',
      workflowSnapshotSha256: savedParent.snapshotSha256,
      publishedVersionId: savedParent.publishedVersionId,
      definitionDigest: savedParent.definitionDigest,
      workspaceId: 'main',
      requestId: randomUUID(),
      mode: 'node',
      targets: ['judge'],
    });
    assert.equal(parentJudgeRes.status, 202);
    const parentJudgeRunId = parentJudgeRes.body.run.runId;
    const parentJudgeSnapshot = await engine2.waitFor(parentJudgeRunId, run => run.state === 'succeeded');
    assert.equal(parentJudgeSnapshot.run.state, 'succeeded');

    // Watcher was reused in the Judge run
    const watcherInstanceInJudge = parentJudgeSnapshot.instances.find(item => item.nodeInstanceId === 'watcher');
    assert.equal(watcherInstanceInJudge.state, 'reused', 'Parent Watcher must be marked reused');

    // Verify final result viewer output exists
    const resultViewer = parentJudgeSnapshot.instances.find(item => item.nodeInstanceId === 'judge');
    assert.equal(resultViewer.state, 'succeeded');

    // Final verification of total invocations:
    // Phase A: Parent Dev (1)
    // Phase C: Repair Dev (1), Repair Watcher (1)
    // Phase E: Repair Judge (1)
    // Phase F: Parent Watcher (1), Parent Judge (1)
    // Total model turns across both workflows = exactly 6!
    // Parent Dev was NEVER re-executed!
    const finalTotalInvocations = await countInvocations(fixtureState);
    assert.equal(finalTotalInvocations, 6, 'Total agent operations across entire lifecycle must equal 6 (zero duplicate replay)');

  } finally {
    if (engine1) await engine1.stop();
    if (engine2) await engine2.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('CONT: Interrupted effectful operation is not blindly re-executed after restart', async () => {
  const root = await mkdtemp(join(testsRoot, 'root-interrupted-'));
  const fixtureState = join(root, 'fixture-state');
  const dbPath = join(root, 'store', 'state.sqlite');
  let engine1, engine2;

  try {
    engine1 = await spawnEngineProcess({ root, fixtureState });
    await engine1.createWorkspace('main');

    // Create a workflow with a slow operation
    const wf = {
      schemaVersion: 1,
      workflowId: 'slow-work',
      capabilities: ['core-v1'],
      settings: { nativeConfiguration: 'restricted' },
      nodes: [
        { id: 'request', type: 'text', config: { value: 'Write data' } },
        { id: 'agent', type: 'agent', config: { provider: 'codex', model: 'fixture-slow-5', timeoutSeconds: 60, output: { format: 'text' } } },
        { id: 'result', type: 'result-viewer', config: {} },
      ],
      edges: [
        { id: 'e1', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
        { id: 'e2', source: { nodeId: 'agent', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
      ],
      after: [],
    };
    const saved = await engine1.saveWorkflow(wf);

    // Start run
    const runRes = await engine1.call('POST', '/api/v2/runs', {
      workflowId: 'slow-work',
      workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: saved.publishedVersionId,
      definitionDigest: saved.definitionDigest,
      workspaceId: 'main',
      requestId: randomUUID(),
      mode: 'workflow',
    });
    assert.equal(runRes.status, 202);
    const runId = runRes.body.run.runId;

    // Poll until agent is actively running
    while (true) {
      const snap = await (await fetch(`http://127.0.0.1:${engine1.connection.port}/api/v2/runs/${runId}`, {
        headers: { Authorization: `Bearer ${engine1.connection.firstPartyToken}` },
      })).json();
      const inst = snap.instances?.find(i => i.nodeInstanceId === 'agent');
      if (inst && inst.state === 'running') break;
      await new Promise(d => setTimeout(d, 50));
    }

    // Simulate an uncommitted workspace side effect during execution
    const scratchDir = join(engine1.connection.scratchRoot, 'main');
    await mkdir(scratchDir, { recursive: true });
    await appendFile(join(scratchDir, 'uncommitted_mutation.tmp'), 'partial write from agent\n');

    // Hard kill Engine Process 1 mid-flight (simulating crash or ungraceful termination)
    await engine1.kill();

    // Restart Engine Process 2 against same root
    engine2 = await spawnEngineProcess({ root, fixtureState });

    // Inspect SQLite recovery of the interrupted run (CONT-08, CONT-11)
    const db = new DatabaseSync(dbPath);
    const recoveredRun = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId);
    assert.equal(recoveredRun.state, 'interrupted', 'Interrupted run must be marked interrupted on restart');

    const agentAttempt = db.prepare("SELECT state FROM attempts WHERE run_id = ? AND node_instance_id = 'agent'").get(runId);
    assert.equal(agentAttempt.state, 'interrupted', 'In-flight attempt must be marked interrupted, not succeeded');

    db.close();

    // Attempting to reuse the interrupted attempt in a consumer run must be REJECTED (stale / missing output)
    const continuationRes = await engine2.call('POST', '/api/v2/runs', {
      workflowId: 'slow-work',
      workflowSnapshotSha256: saved.snapshotSha256,
      publishedVersionId: saved.publishedVersionId,
      definitionDigest: saved.definitionDigest,
      workspaceId: 'main',
      requestId: randomUUID(),
      mode: 'node',
      targets: ['result'],
    });
    assert.equal(continuationRes.status, 422, 'Cannot reuse an interrupted attempt with uncommitted effects');
    assert.equal(continuationRes.body.code, 'validation_failed');

  } finally {
    if (engine1) await engine1.kill();
    if (engine2) await engine2.stop();
    await rm(root, { recursive: true, force: true });
  }
});
