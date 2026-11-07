import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { singleAgent, startTestRunner } from './helpers.mjs';
import deliveryExample from '../../docs/examples/reference-delivery/workflow.json' with { type: 'json' };

const policy = (judgeNodeId = 'judge') => ({
  version: 'workflow-judge/1',
  judgeNodeId,
  maxJudgeAttemptsPerRun: 8,
  maxEvidenceExpansionsPerAttention: 1,
  repairProfiles: [],
});

function addJudge(workflow, id = 'judge') {
  workflow.nodes.push({ id, type: 'agent', config: {
    provider: 'codex', model: 'fixture-echo', timeoutSeconds: 60, output: { format: 'json' }, role: 'judge',
  } });
  workflow.judgePolicy = policy(id);
  return workflow;
}

function parentWorkflow(id = 'p4-parent') {
  return addJudge(singleAgent({ id, context: null, model: 'fixture-echo' }));
}

function repairWorkflow(id = 'p4-repair') {
  const workflow = singleAgent({ id, context: null, model: 'fixture-echo' });
  const worker = workflow.nodes.find(node => node.id === 'agent');
  worker.id = 'repair-work';
  workflow.edges[0].target.nodeId = worker.id;
  workflow.edges.splice(1, 1);
  workflow.nodes.push({ id: 'verify', type: 'agent', config: {
    provider: 'codex', model: 'fixture-echo', timeoutSeconds: 60, output: { format: 'text' },
  } });
  workflow.nodes.find(node => node.id === 'answer').id = 'result';
  workflow.edges.push(
    { id: 'repair-verify', source: { nodeId: worker.id, port: 'text' }, target: { nodeId: 'verify', port: 'prompt' } },
    { id: 'verify-result', source: { nodeId: 'verify', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
  );
  return addJudge(workflow, 'repair-judge');
}

const hasIssue = (validation, fragment) => validation.issues.some(issue => issue.path.includes(fragment) || issue.message.includes(fragment));

test('workflow-judge/1 is explicit, bounded, isolated, publication-bound, and inert for legacy workflows', async t => {
  const api = await startTestRunner();
  try {
    await api.workspace('repair');
    const engine = api.runner.engine;

    await t.test('publishes a valid explicit policy without creating Runs or Attempts', async () => {
      const workflow = parentWorkflow('p4-valid');
      const validation = engine.validateWorkflow(workflow);
      assert.equal(validation.valid, true, JSON.stringify(validation.issues));
      const saved = await api.save(workflow);
      assert.equal(saved.validation.valid, true);
      const published = api.publication(workflow.workflowId);
      assert.equal(published.authorityPolicyVersion, 'workflow-judge/1');
      assert.deepEqual(published.workflow.judgePolicy, workflow.judgePolicy);
      assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
      assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM attempts').n, 0);
    });

    await t.test('refuses P4 Run admission through direct, selected-node, branch, external and Host-permit paths', async () => {
      const workflow = parentWorkflow('p4-capture-boundary');
      await api.save(workflow);
      const pub = api.publication(workflow.workflowId);
      const publication = engine.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ?`, pub.publishedVersionId);
      const snapshot = engine.store.artifactRow(publication.snapshot_artifact_id);
      await api.workspace('p4-capture-boundary');
      const workspace = engine.requireWorkspace('p4-capture-boundary');

      let providerDetections = 0;
      const detect = engine.adapters.detect;
      engine.adapters.detect = async (...args) => { providerDetections++; return detect(...args); };
      const request = (mode, targets, requestId = randomUUID()) => ({
        workflowId: workflow.workflowId, workflowSnapshotSha256: pub.snapshotSha256,
        publishedVersionId: pub.publishedVersionId, definitionDigest: pub.definitionDigest,
        workspaceId: workspace.id, requestId, ...(mode ? { mode } : {}), ...(targets ? { targets } : {}),
      });
      const beforeRuns = engine.store.get('SELECT COUNT(*) AS n FROM runs').n;
      const beforeAttempts = engine.store.get('SELECT COUNT(*) AS n FROM attempts').n;
      const workflowPlan = engine.planRun(workflow, workspace, { mode: 'workflow', targets: [], refreshCaches: [] });
      assert.equal(workflowPlan.planned.has('judge'), false);
      assert.throws(() => engine.planRun(workflow, workspace, { mode: 'node', targets: ['judge'], refreshCaches: [] }),
        error => error.status === 422 && error.code === 'validation_failed');
      for (const mode of ['node', 'branch']) {
        const result = await api.call('POST', '/api/v2/runs', request(mode, ['judge']));
        assert.equal(result.status, 409);
        assert.equal(result.body.code, 'workflow_judge_runtime_unavailable');
      }
      const ordinary = await api.call('POST', '/api/v2/runs', request(undefined, undefined));
      assert.equal(ordinary.status, 409);
      assert.equal(ordinary.body.code, 'workflow_judge_runtime_unavailable');

      const external = await api.callExternal('POST', '/api/v2/runs', request(undefined, undefined));
      assert.equal(external.status, 409);
      assert.equal(external.body.code, 'workflow_judge_runtime_unavailable');
      assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM external_run_requests WHERE workflow_id = ?', workflow.workflowId).n, 0);

      assert.throws(() => engine.captureRun({ workflow, snapshot, workspace, kind: 'workflow', publication,
        options: { mode: 'workflow', targets: [], refreshCaches: [] }, requestId: randomUUID() }),
      error => error.status === 409 && error.code === 'workflow_judge_runtime_unavailable');

      const originalAdmit = engine.admitHostPermit;
      const originalIsHostAdmission = engine.isHostAdmission;
      const originalSettle = engine.settleHostPermit;
      const settled = [];
      engine.admitHostPermit = async permitId => ({ permitId, operation: 'run.approve' });
      engine.isHostAdmission = (admission, permitId, operation) => admission?.permitId === permitId && operation === 'run.approve';
      engine.settleHostPermit = async (permitId, effect) => { settled.push({ permitId, effect }); };
      try {
        const hostRequest = request(undefined, undefined);
        hostRequest.hostPermitId = randomUUID();
        await assert.rejects(() => engine.createRunUnderHostPermit(hostRequest, { role: 'first-party' }), error =>
          error.status === 409 && error.code === 'workflow_judge_runtime_unavailable');
      } finally {
        engine.admitHostPermit = originalAdmit;
        engine.isHostAdmission = originalIsHostAdmission;
        engine.settleHostPermit = originalSettle;
      }
      assert.equal(settled.length, 1);
      assert.equal(settled[0].effect, 'not_executed');
      assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM runs').n, beforeRuns);
      assert.equal(engine.store.get('SELECT COUNT(*) AS n FROM attempts').n, beforeAttempts);
      assert.equal(providerDetections, 0);
      assert.equal(engine.processes.size, 0);
      engine.adapters.detect = detect;

      const legacy = singleAgent({ id: 'p4-metadata-mismatch-legacy', context: null, model: 'fixture-echo' });
      await api.save(legacy);
      const legacyPub = api.publication(legacy.workflowId);
      const legacyRow = engine.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ?`, legacyPub.publishedVersionId);
      const legacySnapshot = engine.store.artifactRow(legacyRow.snapshot_artifact_id);
      await api.workspace('p4-metadata-mismatch');
      const mismatchWorkspace = engine.requireWorkspace('p4-metadata-mismatch');
      assert.throws(() => engine.captureRun({ workflow: legacy, snapshot: legacySnapshot, workspace: mismatchWorkspace, kind: 'workflow',
        publication: { ...legacyRow, authority_policy_version: 'workflow-judge/1' },
        options: { mode: 'workflow', targets: [], refreshCaches: [] }, requestId: randomUUID() }),
      error => error.status === 409 && /authority policy metadata/.test(error.message));
    });

    await t.test('rejects a missing designated Judge node', () => {
      const workflow = parentWorkflow('p4-missing-judge');
      workflow.judgePolicy.judgeNodeId = 'missing';
      const validation = engine.validateWorkflow(workflow);
      assert.equal(validation.valid, false);
      assert.ok(hasIssue(validation, '/judgePolicy/judgeNodeId'));
    });

    await t.test('rejects multiple Judge identities', () => {
      const workflow = parentWorkflow('p4-multiple-judges');
      workflow.nodes.push({ id: 'other-judge', type: 'agent', config: {
        provider: 'codex', model: 'fixture-echo', timeoutSeconds: 60, output: { format: 'json' }, role: 'judge',
      } });
      const validation = engine.validateWorkflow(workflow);
      assert.equal(validation.valid, false);
      assert.ok(hasIssue(validation, 'exactly one Agent'));
    });

    await t.test('rejects incoming or outgoing graph edges and After dependencies', () => {
      const edged = parentWorkflow('p4-judge-edge');
      edged.edges.push({ id: 'request-judge', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'judge', port: 'prompt' } });
      assert.ok(hasIssue(engine.validateWorkflow(edged), 'no incoming or outgoing data edges'));
      const ordered = parentWorkflow('p4-judge-after');
      ordered.after.push({ before: 'agent', after: 'judge' });
      assert.ok(hasIssue(engine.validateWorkflow(ordered), 'no incoming or outgoing After dependencies'));
    });

    await t.test('rejects a designated non-Agent or Agent without the Judge role', () => {
      const wrongType = parentWorkflow('p4-wrong-type');
      wrongType.judgePolicy.judgeNodeId = 'request';
      assert.ok(hasIssue(engine.validateWorkflow(wrongType), 'designated Judge node must be an Agent'));
      const wrongRole = parentWorkflow('p4-wrong-role');
      wrongRole.judgePolicy.judgeNodeId = 'agent';
      assert.ok(hasIssue(engine.validateWorkflow(wrongRole), 'must declare config.role "judge"'));
    });

    await t.test('rejects out-of-range budgets and unknown policy fields', () => {
      const tooMany = parentWorkflow('p4-budget-high');
      tooMany.judgePolicy.maxJudgeAttemptsPerRun = 9;
      assert.equal(engine.validateWorkflow(tooMany).valid, false);
      const unbounded = parentWorkflow('p4-budget-expansion');
      unbounded.judgePolicy.maxEvidenceExpansionsPerAttention = 2;
      assert.equal(engine.validateWorkflow(unbounded).valid, false);
      const extra = parentWorkflow('p4-extra-policy-field');
      extra.judgePolicy.ownerToken = true;
      assert.equal(engine.validateWorkflow(extra).valid, false);
    });

    await t.test('resolves Repair profile publication, workspace, result and verification references', async () => {
      const repair = repairWorkflow();
      const savedRepair = await api.save(repair);
      assert.equal(savedRepair.validation.valid, true, JSON.stringify(savedRepair.validation.issues));
      const repairPublication = api.publication(repair.workflowId);
      assert.equal(repairPublication.authorityPolicyVersion, 'workflow-judge/1');
      const parent = parentWorkflow('p4-with-profile');
      parent.judgePolicy.repairProfiles = [{
        profileId: 'repair-default',
        repairWorkflowId: repair.workflowId,
        repairPublishedVersion: repairPublication.version,
        repairWorkflowSnapshotSha256: repairPublication.snapshotSha256,
        repairWorkspaceId: 'repair',
        failedNodeInstanceId: 'agent',
        repairResultNodeInstanceId: 'repair-work',
        verificationNodeInstanceIds: ['verify'],
        acceptanceMode: 'judge_post_execution',
        failedNodeRetry: 'never',
      }];
      const validation = engine.validateWorkflow(parent);
      assert.equal(validation.valid, true, JSON.stringify(validation.issues));
      const invalidPublication = structuredClone(parent);
      invalidPublication.judgePolicy.repairProfiles[0].repairWorkflowSnapshotSha256 = '0'.repeat(64);
      assert.ok(hasIssue(engine.validateWorkflow(invalidPublication), 'exact workflow snapshot digest'));
      const invalidResult = structuredClone(parent);
      invalidResult.judgePolicy.repairProfiles[0].repairResultNodeInstanceId = 'missing-result';
      assert.ok(hasIssue(engine.validateWorkflow(invalidResult), 'Repair result node'));
      const invalidVerification = structuredClone(parent);
      invalidVerification.judgePolicy.repairProfiles[0].verificationNodeInstanceIds = ['missing-check'];
      assert.ok(hasIssue(engine.validateWorkflow(invalidVerification), 'verification node'));
      const invalidWorkspace = structuredClone(parent);
      invalidWorkspace.judgePolicy.repairProfiles[0].repairWorkspaceId = 'missing-workspace';
      assert.ok(hasIssue(engine.validateWorkflow(invalidWorkspace), 'not registered'));
      const invalidVersion = structuredClone(parent);
      invalidVersion.judgePolicy.repairProfiles[0].repairPublishedVersion = repairPublication.version + 1;
      assert.ok(hasIssue(engine.validateWorkflow(invalidVersion), 'existing runnable Published Version'));
    });

    await t.test('legacy ordinary Agents and role markers remain valid without P4 authority', async () => {
      const ordinary = singleAgent({ id: 'legacy-ordinary', context: null, model: 'fixture-echo' });
      assert.equal(engine.validateWorkflow(ordinary).valid, true);
      const legacyJudgeMarker = singleAgent({ id: 'legacy-judge-marker', context: null, model: 'fixture-echo' });
      legacyJudgeMarker.nodes.find(node => node.id === 'agent').config.role = 'judge';
      assert.equal(engine.validateWorkflow(legacyJudgeMarker).valid, true);
      assert.equal(legacyJudgeMarker.judgePolicy, undefined);
      const saved = await api.save(legacyJudgeMarker);
      assert.equal(saved.validation.valid, true);
      assert.equal(api.publication(legacyJudgeMarker.workflowId).authorityPolicyVersion, 'designated-judge/1');
      await api.workspace('main');
      const ordinaryRun = await api.run(ordinary, 'main');
      assert.equal(ordinaryRun.status, 202);
      assert.equal((await api.waitFor(ordinaryRun.body.run.runId)).run.state, 'succeeded');
      const markerRun = await api.run(legacyJudgeMarker, 'main');
      assert.equal(markerRun.status, 202);
      assert.equal((await api.waitFor(markerRun.body.run.runId)).run.state, 'succeeded');
    });

    await t.test('keeps published P4 identity immutable when the editable draft changes', async () => {
      const workflow = parentWorkflow('p4-publication-immutable');
      await api.save(workflow);
      const original = api.publication(workflow.workflowId);
      const edited = structuredClone(workflow);
      edited.nodes.find(node => node.id === 'agent').config.model = 'fixture-noop';
      await api.save(edited);
      const capturedIdentity = engine.getWorkflowPublication(workflow.workflowId, original.version);
      assert.equal(capturedIdentity.snapshotSha256, original.snapshotSha256);
      assert.equal(capturedIdentity.definitionDigest, original.definitionDigest);
      assert.deepEqual(capturedIdentity.workflow.judgePolicy, workflow.judgePolicy);
      const result = await api.call('POST', '/api/v2/runs', {
        workflowId: workflow.workflowId, workflowSnapshotSha256: original.snapshotSha256,
        publishedVersionId: original.publishedVersionId, definitionDigest: original.definitionDigest,
        workspaceId: 'main', requestId: randomUUID(),
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'workflow_judge_runtime_unavailable');
    });

    await t.test('rejects Context-backed Judges and unsupported execution classes only when P4 is opted in', () => {
      const contextBacked = parentWorkflow('p4-context-judge');
      contextBacked.nodes.splice(1, 0, { id: 'judge-context', type: 'context', config: { provider: 'codex', mode: 'new' } });
      contextBacked.judgePolicy.judgeNodeId = 'judge';
      contextBacked.nodes.find(node => node.id === 'judge').config.contextId = 'judge-context';
      assert.ok(hasIssue(engine.validateWorkflow(contextBacked), 'Context-backed Judge'));

      const unsupported = structuredClone(deliveryExample);
      unsupported.workflowId = 'p4-map-unsupported';
      addJudge(unsupported);
      assert.ok(hasIssue(engine.validateWorkflow(unsupported), 'cannot enroll workflows containing'));
      const legacyWithUnsupported = structuredClone(deliveryExample);
      legacyWithUnsupported.workflowId = 'legacy-map-workflow';
      assert.equal(engine.validateWorkflow(legacyWithUnsupported).valid, true, 'P4 restrictions must not alter legacy publication validation');
    });

    await t.test('requires a P4-enabled Repair publication for adaptive approval and bars nested profiles', async () => {
      const legacyRepair = singleAgent({ id: 'legacy-repair-target', context: null, model: 'fixture-echo' });
      const savedLegacy = await api.save(legacyRepair);
      const legacyPublication = api.publication(legacyRepair.workflowId);
      const exactDigestParent = parentWorkflow('p4-exact-digest-profile');
      exactDigestParent.judgePolicy.repairProfiles = [{
        profileId: 'legacy-exact', repairWorkflowId: legacyRepair.workflowId, repairPublishedVersion: legacyPublication.version,
        repairWorkflowSnapshotSha256: legacyPublication.snapshotSha256, repairWorkspaceId: 'repair',
        failedNodeInstanceId: 'agent', repairResultNodeInstanceId: 'agent', verificationNodeInstanceIds: [],
        acceptanceMode: 'expected_digest', expectedRepairResultSha256: 'b'.repeat(64), failedNodeRetry: 'never',
      }];
      assert.equal(engine.validateWorkflow(exactDigestParent).valid, true, JSON.stringify(engine.validateWorkflow(exactDigestParent).issues));
      const parent = parentWorkflow('p4-adaptive-needs-judge');
      parent.judgePolicy.repairProfiles = [{
        profileId: 'adaptive', repairWorkflowId: legacyRepair.workflowId, repairPublishedVersion: legacyPublication.version,
        repairWorkflowSnapshotSha256: legacyPublication.snapshotSha256, repairWorkspaceId: 'repair',
        failedNodeInstanceId: 'agent', repairResultNodeInstanceId: 'agent', verificationNodeInstanceIds: [],
        acceptanceMode: 'judge_post_execution', failedNodeRetry: 'never',
      }];
      assert.equal(savedLegacy.validation.valid, true);
      assert.ok(hasIssue(engine.validateWorkflow(parent), 'requires a Repair publication explicitly bound to workflow-judge/1'));

      const leafRepair = singleAgent({ id: 'p4-leaf-repair', context: null, model: 'fixture-echo' });
      await api.save(leafRepair);
      const leafPublication = api.publication(leafRepair.workflowId);
      const nestedRepair = repairWorkflow('nested-repair-target');
      nestedRepair.judgePolicy.repairProfiles = [{
        profileId: 'nested', repairWorkflowId: leafRepair.workflowId, repairPublishedVersion: leafPublication.version,
        repairWorkflowSnapshotSha256: leafPublication.snapshotSha256, repairWorkspaceId: 'repair',
        failedNodeInstanceId: 'repair-work', repairResultNodeInstanceId: 'agent', verificationNodeInstanceIds: [],
        acceptanceMode: 'expected_digest', expectedRepairResultSha256: 'c'.repeat(64), failedNodeRetry: 'never',
      }];
      assert.equal(engine.validateWorkflow(nestedRepair).valid, true);
      await api.save(nestedRepair);
      const nestedPublication = api.publication(nestedRepair.workflowId);
      const refusesNested = parentWorkflow('p4-refuses-nested-repair');
      refusesNested.judgePolicy.repairProfiles = [{
        profileId: 'nested-target', repairWorkflowId: nestedRepair.workflowId, repairPublishedVersion: nestedPublication.version,
        repairWorkflowSnapshotSha256: nestedPublication.snapshotSha256, repairWorkspaceId: 'repair',
        failedNodeInstanceId: 'agent', repairResultNodeInstanceId: 'repair-work', verificationNodeInstanceIds: ['verify'],
        acceptanceMode: 'expected_digest', expectedRepairResultSha256: 'd'.repeat(64), failedNodeRetry: 'never',
      }];
      assert.ok(hasIssue(engine.validateWorkflow(refusesNested), 'cannot declare further model-originated Repair profiles'));
    });

    await t.test('interrupts a previously captured P4 Run without dispatching it after Engine replacement', async () => {
      const workflow = parentWorkflow('p4-existing-unsupported-run');
      await api.save(workflow);
      const pub = api.publication(workflow.workflowId);
      const publication = engine.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ?`, pub.publishedVersionId);
      const snapshot = engine.store.artifactRow(publication.snapshot_artifact_id);
      await api.workspace('p4-existing-run');
      const workspace = engine.requireWorkspace('p4-existing-run');

      const captureBeforeGate = (capturedWorkflow, capturedPublication, selectedWorkspace, options) => {
        // Model a Run captured by the pre-gate P4.1 build, including ordinary planning with no native attention.
        const assertAvailable = engine.assertWorkflowJudgeRuntimeAvailable;
        const originalPlan = engine.planRun;
        engine.assertWorkflowJudgeRuntimeAvailable = () => {};
        engine.planRun = function (captured, workspaceArg, optionsArg) {
          const preGate = { ...captured };
          delete preGate.judgePolicy;
          return originalPlan.call(this, preGate, workspaceArg, optionsArg);
        };
        try {
          return engine.captureRun({ workflow: capturedWorkflow, snapshot: engine.store.artifactRow(capturedPublication.snapshot_artifact_id),
            workspace: selectedWorkspace, kind: 'workflow', publication: capturedPublication, options, requestId: randomUUID() });
        } finally {
          engine.assertWorkflowJudgeRuntimeAvailable = assertAvailable;
          engine.planRun = originalPlan;
        }
      };
      // Finish the independent legacy Repair child before inserting the old queued P4 Run, since a new Run admission pumps all queued rows.
      await api.workspace('p4-linked-repair');
      const legacyRepair = singleAgent({ id: 'legacy-linked-repair-child', context: null, model: 'fixture-echo' });
      const repairRun = await api.run(legacyRepair, 'p4-linked-repair');
      assert.equal((await api.waitFor(repairRun.body.run.runId)).run.state, 'succeeded');
      const repairRow = engine.requireRun(repairRun.body.run.runId);

      const captured = captureBeforeGate(workflow, publication, workspace, { mode: 'node', targets: ['judge'], refreshCaches: [] });
      const runId = captured.body.run.runId;
      const priorSequence = engine.requireRun(runId).last_sequence;
      assert.equal(engine.requireRun(runId).state, 'queued');
      // Model the scheduled Judge attempt captured by an earlier P4.1 build; current capture code excludes it.
      assert.equal(engine.store.get('SELECT state FROM attempts WHERE run_id = ? AND node_instance_id = ?', runId, 'judge'), undefined);
      const legacyJudgeAttemptId = randomUUID();
      engine.store.run("INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, 'judge', 'judge', 'agent', 'scheduled')", runId);
      engine.store.run("INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, 'judge', 1, 'scheduled')", legacyJudgeAttemptId, runId);
      engine.store.appendEvents(runId, [
        { type: 'node.planned', nodeInstanceId: 'judge', payload: { nodeId: 'judge', nodeType: 'agent', scope: null } },
        { type: 'attempt.state_changed', nodeInstanceId: 'judge', attemptId: legacyJudgeAttemptId,
          payload: { from: null, to: 'scheduled', reason: 'Captured by the earlier P4.1 build.', process: null, ordinal: 1 } },
      ]);

      const linkedParentWorkflow = parentWorkflow('p4-linked-parent');
      await api.save(linkedParentWorkflow);
      const linkedParentPublication = api.publication(linkedParentWorkflow.workflowId);
      const linkedParentRow = engine.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ?`, linkedParentPublication.publishedVersionId);
      await api.workspace('p4-linked-parent');
      const linkedParentWorkspace = engine.requireWorkspace('p4-linked-parent');
      const linkedParent = captureBeforeGate(linkedParentWorkflow, linkedParentRow, linkedParentWorkspace,
        { mode: 'workflow', targets: [], refreshCaches: [] });
      const linkedParentRunId = linkedParent.body.run.runId;
      const parentAttempts = engine.latestAttempts(linkedParentRunId);
      const parentEvents = [];
      for (const attempt of parentAttempts) {
        if (attempt.node_instance_id === 'agent') parentEvents.push(...engine.attemptTransition(attempt, 'failed', 'The old Parent attempt needs linked repair.'));
        else parentEvents.push(...engine.attemptTransition(attempt, 'canceled', 'The old Parent Run was held for linked repair.'));
      }
      engine.store.transaction(() => {
        parentEvents.push(engine.runEvent(engine.requireRun(linkedParentRunId), 'waiting_for_user', 'Held for linked repair.'));
        engine.store.appendEvents(linkedParentRunId, parentEvents);
      });
      const checkpoint = engine.store.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', parentRunId: linkedParentRunId, repairRunId: repairRow.id });
      const linkedAt = new Date().toISOString();
      const linkedRepairId = randomUUID();
      engine.store.run(`INSERT INTO run_links(id,kind,parent_run_id,repair_run_id,parent_workspace_id,repair_workspace_id,resume_node_instance_id,
        candidate_digest,checkpoint_artifact_id,state,created_at,updated_at) VALUES(?,'linked_repair',?,?,?,?,?,?,?,'repair_completed',?,?)`,
      linkedRepairId, linkedParentRunId, repairRow.id, linkedParentWorkspace.id, repairRow.workspace_id, 'agent', 'a'.repeat(64), checkpoint.artifactId, linkedAt, linkedAt);
      assert.equal(engine.isContinuationHeld(engine.requireRun(linkedParentRunId)), true);
      const linkedParentSequence = engine.requireRun(linkedParentRunId).last_sequence;

      let providerLaunches = 0;
      const adapters = engine.adapters;
      const detect = adapters.detect;
      adapters.detect = async (...args) => { providerLaunches++; return detect(...args); };
      await api.close();
      const restarted = await startTestRunner({ root: api.root, runner: { adapters } });
      try {
        const nextEngine = restarted.runner.engine;
        assert.equal(nextEngine.requireRun(runId).state, 'interrupted');
        assert.equal(nextEngine.store.get('SELECT state FROM attempts WHERE run_id = ? AND node_instance_id = ?', runId, 'judge').state, 'canceled');
        assert.ok(nextEngine.requireRun(runId).last_sequence > priorSequence);
        const events = await restarted.events(runId);
        assert.ok(events.some(event => event.type === 'run.state_changed'
          && event.payload.reason.includes('Unsupported runtime: workflow-judge/1')));
        const resumedParent = nextEngine.requireRun(linkedParentRunId);
        assert.equal(resumedParent.state, 'interrupted');
        assert.ok(resumedParent.last_sequence > linkedParentSequence);
        assert.equal(nextEngine.store.get('SELECT state FROM run_links WHERE id = ?', linkedRepairId).state, 'repair_completed');
        assert.equal(nextEngine.store.get('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND node_instance_id = ?', linkedParentRunId, 'agent').n, 1);
        const parentEventHistory = await restarted.events(linkedParentRunId);
        assert.ok(parentEventHistory.some(event => event.type === 'continuation.parent_resume_refused'
          && event.payload.code === 'workflow_judge_runtime_unavailable'));
        assert.equal(providerLaunches, 0);
        assert.equal(nextEngine.processes.size, 0);
        nextEngine.startRun();
        assert.equal(nextEngine.requireRun(runId).state, 'interrupted');
      } finally {
        await restarted.close();
        adapters.detect = detect;
      }
    });
  } finally {
    await api.close();
  }
});
