import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../core/engine.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deszo-engine-startup-'));
  const engine = new Engine({ root });
  t.after(async () => {
    engine.store.close();
    await rm(root, { recursive: true, force: true });
  });
  return engine;
}

test('Engine startup awaits the protected initialization hook after identity setup and before recovery', async t => {
  const engine = await fixture(t);
  const order = [];
  engine.recover = async () => { order.push('recover'); };
  engine.reconcileProtectedSelfRepairPreparations = async () => { order.push('p5-preparation-recovery'); };
  engine.reconcileProtectedSelfRepairProjections = () => { order.push('p5-projection-recovery'); };
  engine.resumeCustodyAttempts = () => { order.push('resume'); };
  engine.reconcileContinuations = () => { order.push('continuations'); };
  engine.initializeJudgeAttention = () => { order.push('judge-attention'); };
  engine.initializeWorkflowJudge = () => { order.push('workflow-judge'); };

  await engine.initialize({ beforeRecovery: async () => {
    assert.ok(engine.runtimeIdentity().storeId, 'runtime identity is durable before the hook');
    assert.ok(engine.store.get('SELECT 1 FROM schema_migrations LIMIT 1'), 'Store migrations are complete before the hook');
    order.push('protected-initialization');
  } });

  assert.deepEqual(order, ['protected-initialization', 'recover', 'p5-preparation-recovery', 'p5-projection-recovery',
    'resume', 'continuations', 'judge-attention', 'workflow-judge']);
});

test('a failed protected initialization hook prevents recovery and process resumption', async t => {
  const engine = await fixture(t);
  const order = [];
  engine.recover = async () => { order.push('recover'); };
  engine.resumeCustodyAttempts = () => { order.push('resume'); };
  engine.reconcileContinuations = () => { order.push('continuations'); };

  await assert.rejects(engine.initialize({ beforeRecovery: async () => {
    order.push('protected-initialization');
    throw new Error('enrollment boundary failed');
  } }), /enrollment boundary failed/);
  assert.deepEqual(order, ['protected-initialization']);
});

test('P5 startup projects corrupt linked history as held and blocks the open link before resumption', () => {
  const engine = Object.create(Engine.prototype);
  const link = { id: 'p5-link', parent_run_id: 'parent-run', repair_run_id: 'repair-run', incident_id: 'incident',
    continuation_contract: 'logical_policy', state: 'open', repair_approval_artifact_id: null };
  const parent = { id: 'parent-run', last_sequence: 4 };
  const repair = { id: 'repair-run', last_sequence: 2, workflow_snapshot_artifact_id: 'repair-workflow' };
  const blocked = [];
  engine.store = {
    all: () => [link],
    get(sql, id) {
      if (sql.includes('run_links')) return link;
      if (sql.includes('runs') && id === parent.id) return parent;
      if (sql.includes('runs') && id === repair.id) return repair;
      return null;
    },
    readEvents: () => [],
    readJson: () => { throw new Error('missing enrollment fixture'); },
    verifyRef: () => { throw new Error('unexpected artifact read'); },
  };
  engine.parentRepairAuthorization = () => ({ profile: { selfRepair: {} } });
  engine.blockLogicalRepair = (current, code) => { blocked.push({ linkId: current.id, code }); return true; };

  const report = engine.reconcileProtectedSelfRepairProjections();
  assert.deepEqual(report.projected, [{ linkId: link.id, stage: 'held_uncertain' }]);
  assert.deepEqual(report.blocked, [link.id]);
  assert.deepEqual(blocked, [{ linkId: link.id, code: 'p5_projection_invalid' }]);
});

test('P5 startup projects bound preparation, verification and P2 terminal stages accurately', () => {
  const parentRunId = randomUUID(), repairRunId = randomUUID(), linkId = randomUUID();
  const ref = id => ({ artifactId: id || randomUUID(), sha256: 'a'.repeat(64) });
  const enrollmentId = randomUUID(), allocationId = randomUUID();
  const baselineId = 'b'.repeat(64), sourceDigest = 'c'.repeat(64);
  const publication = { workflowId: 'p5-parent', publishedVersionId: randomUUID(), version: 1, snapshotSha256: 'd'.repeat(64) };
  const repairPublication = { workflowId: 'p5-repair', publishedVersionId: randomUUID(), version: 1, snapshotSha256: 'e'.repeat(64) };
  const identity = { volumeId: 'volume', fileId: 'workspace' };
  const workspace = { workspaceId: 'p5-slot', allocationId, canonicalRoot: 'C:/fixture/p5-slot', nativeIdentity: identity };
  const repositoryIdentity = { enrollmentId, canonicalCommonDirectory: 'C:/fixture/.git',
    nativeDirectoryIdentity: { volumeId: 'volume', fileId: 'repository' } };
  const scope = { add: [], modify: ['runtime/core/engine.mjs'], delete: [], executable: [], denied: [], sensitiveCategories: [] };
  const budgets = { maxSourceFiles: 10, maxSourceBytes: 10000, developerTimeoutSeconds: 60,
    verificationTimeoutSeconds: 120, maxCheckOutputBytes: 1024, verificationRetries: 0,
    maxJudgeAttempts: 1, maxEvidenceExpansions: 1 };
  const enrollmentRef = ref(), profileRef = ref(), sourceBindingRef = ref(), verificationInputsRef = ref();
  const baselineManifest = ref(), sourceManifest = ref(), runningSourceRelease = ref(), verificationPolicy = ref();
  const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
    gitObjectFormat: 'sha1', baseCommit: 'f'.repeat(40), baseTree: '1'.repeat(40), pathPolicyDigest: '2'.repeat(64),
    effectiveSourceDigest: sourceDigest, baselineId, baselineManifest, runningSourceRelease, parentPublication: publication,
    profile: profileRef, repairPublication, workspace: { ...workspace }, verificationPolicy, harnessClosureDigest: '3'.repeat(64),
    toolIdentities: [{ name: 'node', path: 'C:/node.exe', sha256: '4'.repeat(64) }], scope, budgets,
    minimumReaderCapability: 'protected-self-repair-v1' };
  const profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity, baselineId,
    baseline: baselineManifest, runningSourceRelease, repairPublication, developerNodeId: 'developer',
    verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
    workspace: { workspaceId: workspace.workspaceId, allocationId, canonicalRoot: workspace.canonicalRoot,
      singleUse: true, cleanCommitted: true }, scope, verificationPolicy, requiredCheckIds: ['check'],
    eligibleIncidents: [{ category: 'test-failure', canonicalCode: 'assertion-failed' }], failedNodeRetry: 'never',
    acceptanceMode: 'judge_post_execution', budgets };
  const sourceBinding = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId, parentRunId,
    parentPublication: publication, parentSnapshot: ref(), baselineId, baselineManifest, profile: profileRef, runningSourceRelease,
    runtimeInstanceId: randomUUID(), lifecycleGeneration: randomUUID(), boundAt: new Date().toISOString() };
  const intentRef = ref(), preparationRef = ref();
  const intent = { schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: enrollmentRef,
    baselineManifest, sourceManifest, sourceBinding: sourceBindingRef, verificationInputs: verificationInputsRef,
    parentRunId, repairRunId, linkId, workspace: { ...workspace }, createdAt: new Date().toISOString() };
  const preparation = { schemaVersion: 1, kind: 'ProtectedSelfRepairWorkspacePreparation', intent: intentRef,
    workspaceRoot: workspace.canonicalRoot, sourceRoot: resolve(workspace.canonicalRoot, 'source'), workspaceIdentity: identity,
    sourceIdentity: { volumeId: 'volume', fileId: 'source' }, baselineId, sourceDigest, snapshotDigest: '5'.repeat(64),
    pathDigest: '6'.repeat(64), contentDigest: '7'.repeat(64), fileCount: 1, totalBytes: 1, hostPid: 1,
    generation: randomUUID(), epoch: 1, preparedAt: new Date().toISOString() };
  const artifacts = new Map([[enrollmentRef.artifactId, enrollment], [profileRef.artifactId, profile],
    [sourceBindingRef.artifactId, sourceBinding], [intentRef.artifactId, intent], [preparationRef.artifactId, preparation],
    ['repair-workflow', { capabilities: ['protected-self-repair-v1'] }]]);
  const events = new Map([[parentRunId, [{ type: 'self_repair.source_bound', payload: { record: sourceBindingRef }, attemptId: null }]],
    [repairRunId, [
      { type: 'self_repair.preparation_intent', payload: { record: intentRef }, attemptId: null },
      { type: 'self_repair.workspace_prepared', payload: { record: preparationRef }, attemptId: null },
    ]]]);
  const link = { id: linkId, incident_id: randomUUID(), continuation_contract: 'logical_policy',
    parent_run_id: parentRunId, repair_run_id: repairRunId, state: 'open' };
  const engine = Object.create(Engine.prototype);
  engine.logicalRepairLinkForRun = () => link;
  engine.parentRepairAuthorization = () => ({ profile: { selfRepair: { artifactId: profileRef.artifactId, sha256: profileRef.sha256 } },
    p5Enrollment: enrollmentRef, selfRepairProfile: profileRef, p5SourceBinding: sourceBindingRef,
    verificationInputs: verificationInputsRef });
  engine.latestAttempt = () => null;
  engine.store = {
    get(sql, id) { return sql.includes('runs') ? (id === parentRunId ? { id: parentRunId, last_sequence: 1 }
      : id === repairRunId ? { id: repairRunId, last_sequence: 2, workflow_snapshot_artifact_id: 'repair-workflow' } : null) : null; },
    readEvents: runId => events.get(runId) || [],
    readJson: id => artifacts.get(id),
    verifyRef: artifactRef => { if (!artifacts.has(artifactRef.artifactId)) throw new Error('unknown fixture artifact'); },
  };

  const projection = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(projection.stage, 'prepared');
  assert.equal(projection.eligible, true);
  assert.deepEqual(projection.issues, []);

  const candidateRef = ref(), candidateId = '8'.repeat(64), candidateSourceDigest = '9'.repeat(64), gateAttemptId = randomUUID();
  const candidate = { schemaVersion: 1, kind: 'ProtectedSelfRepairCandidate', candidateId, enrollment: enrollmentRef,
    baselineRef: baselineManifest, baselineId, baseCommit: enrollment.baseCommit, baseSourceDigest: sourceDigest,
    candidateSourceDigest, sourceManifest, changeManifest: ref(), sourceCaptureEvidence: ref(), repositoryIdentity,
    sourceBinding: sourceBindingRef,
    workspace: { workspaceId: workspace.workspaceId, allocationId, canonicalRoot: workspace.canonicalRoot,
      sourceRoot: resolve(workspace.canonicalRoot, 'source'), nativeIdentity: identity },
    parentRunId, repairRunId, linkId, incidentId: link.incident_id, outcomeId: randomUUID(), outcomeRevision: 1,
    parentPublication: publication, repairPublication, developerNodeId: 'developer', developerAttemptId: randomUUID(),
    selfRepairProfile: profileRef, verificationPolicy, verificationInputs: verificationInputsRef, developerTerminalEvidence: ref(),
    scopeVerdict: { status: 'within_scope', changeCount: 1 }, capturedAt: new Date().toISOString(), journalCursor: 3 };
  const startedRef = ref();
  const started = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationStarted', runId: repairRunId,
    repairRunId, parentRunId, linkId, incidentId: link.incident_id, gateNodeId: profile.verificationNodeId, gateAttemptId,
    candidateId, candidateSourceDigest, candidateManifest: candidateRef, verificationPolicy, verificationInputs: verificationInputsRef,
    verifierPlan: ref(), commandManifest: ref(), testInputManifest: ref(), invocation: ref(), candidateSourceRoot: 'C:/slot/source',
    candidateSourceBefore: candidateSourceDigest, freshSourceRoot: 'C:/slot/.p5/verify/source',
    executionRoot: 'C:/slot/.p5/verify/execution', verifyScratch: 'C:/slot/.p5/verify/scratch',
    environmentDigest: 'a'.repeat(64), harnessClosureDigest: 'b'.repeat(64), lifecycleGeneration: randomUUID(),
    engineEpoch: 1, startedAt: new Date().toISOString() };
  const withCandidateAndStart = [
    ...events.get(repairRunId),
    { type: 'self_repair.candidate_captured', payload: { record: candidateRef }, attemptId: null },
    { type: 'self_repair.verification_started', payload: { record: startedRef }, attemptId: null },
  ];
  artifacts.set(candidateRef.artifactId, candidate);
  artifacts.set(startedRef.artifactId, started);
  artifacts.set(verificationPolicy.artifactId, {});
  artifacts.set(verificationInputsRef.artifactId, {});
  const makeOutcome = (status, overrides = {}) => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationOutcome', status,
    candidateManifest: candidateRef, candidateId, candidateSourceDigest, baselineId, repairRunId, linkId,
    incidentId: link.incident_id, gateAttemptId, verificationPolicy, verificationInputs: verificationInputsRef,
    verifierResult: null, terminalEvidence: null, streamEvidence: null,
    captureStatus: status === 'failed' ? 'complete' : 'incomplete', reason: null, checks: [],
    recordedAt: new Date().toISOString(), ...overrides });
  for (const status of ['failed', 'incomplete']) {
    const outcomeRef = ref();
    artifacts.set(outcomeRef.artifactId, makeOutcome(status));
    events.set(repairRunId, [...withCandidateAndStart,
      { type: 'self_repair.verification_recorded', payload: { record: outcomeRef }, attemptId: null }]);
    const failedVerification = engine.protectedSelfRepairRunProjection(repairRunId);
    assert.equal(failedVerification.stage, 'incomplete', `${status} verification remains incomplete`);
    assert.equal(failedVerification.eligible, false);
    assert.deepEqual(failedVerification.issues, []);
  }

  const foreignOutcomeRef = ref();
  artifacts.set(foreignOutcomeRef.artifactId, makeOutcome('failed', { linkId: randomUUID() }));
  events.set(repairRunId, [...withCandidateAndStart,
    { type: 'self_repair.verification_recorded', payload: { record: foreignOutcomeRef }, attemptId: null }]);
  const foreignOutcome = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(foreignOutcome.stage, 'held_uncertain');
  assert.equal(foreignOutcome.eligible, false);
  assert.ok(foreignOutcome.issues.includes('verification_outcome_mismatch'));

  const terminalOutcomeRef = ref();
  artifacts.set(terminalOutcomeRef.artifactId, makeOutcome('failed'));
  events.set(repairRunId, [...withCandidateAndStart,
    { type: 'self_repair.verification_recorded', payload: { record: terminalOutcomeRef }, attemptId: null }]);

  link.state = 'repair_failed';
  link.decision_status = 'rejected';
  const rejected = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(rejected.stage, 'rejected');
  assert.equal(rejected.eligible, false);

  link.state = 'parent_stopped';
  link.parent_suspension_state = 'stopped';
  const stopped = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(stopped.stage, 'stopped');
  assert.equal(stopped.eligible, false);

  link.state = 'blocked';
  link.parent_suspension_state = 'blocked';
  link.decision_status = 'pending';
  const held = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(held.stage, 'held_uncertain');
  assert.equal(held.eligible, false);

  link.state = 'resumed';
  link.parent_suspension_state = 'resumed';
  const resumedWithoutHandoff = engine.protectedSelfRepairRunProjection(repairRunId);
  assert.equal(resumedWithoutHandoff.stage, 'held_uncertain');
  assert.equal(resumedWithoutHandoff.eligible, false);
  assert.ok(resumedWithoutHandoff.issues.includes('accepted_handoff_missing'));
});
