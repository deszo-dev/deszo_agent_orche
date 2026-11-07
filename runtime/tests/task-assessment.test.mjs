import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check } from '../core/schemas.mjs';
import { MIGRATION_PATHS, Store, nowIso } from '../core/store.mjs';
import {
  deriveSourceFacts,
  selectExecutionPlan,
  evaluateCandidateFloors,
  chargeAggregateBounds,
  DEFAULT_DESZO_CRITICAL_AREAS,
  REFERENCE_STAGES,
} from '../core/taskAssessment.mjs';
import { ownedPath } from './test-roots.mjs';

function createSampleAssessment(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'TaskAssessment',
    assessmentId: 'ASSESS-001',
    assessmentRunId: randomUUID(),
    businessRequestId: 'REQ-1234',
    authorRole: 'analyst',
    sourceSnapshotHash: 'a'.repeat(64),
    intendedOutcome: 'Add dark mode toggle to navigation header.',
    constraints: ['Must not change storage', 'Must follow existing styles'],
    exclusions: ['Do not redesign entire app'],
    requirements: [
      {
        id: 'REQ-1',
        title: 'Dark mode toggle',
        description: 'Toggle button in header',
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Button toggles theme in state',
            requiredEvidence: 'Unit test report',
            evidenceProducer: 'test-author',
          },
        ],
      },
    ],
    scope: {
      affectedComponents: ['src/Header.tsx'],
      affectedInterfaces: [],
      affectedData: [],
      executionEnvironments: ['browser'],
      anticipatedDependencies: [],
    },
    sourceDerivedFacts: {
      criticalPaths: [],
      publicContracts: [],
      dependencyFanOut: 1,
    },
    assessmentAxes: {
      scopeCoupling: 'local',
      technicalDifficulty: 'low',
      failureImpact: 'limited',
      uncertainty: 'low',
      verifiability: 'clear',
    },
    grounds: {
      references: ['src/Header.tsx'],
      assumptions: ['Header component is isolated'],
      confidence: 'High: local UI component only.',
      unresolvedQuestions: [],
    },
    planningAdvice: {
      recommendedStages: ['define', 'implement', 'assemble_and_check', 'delivery_review', 'accept_outcome'],
      suggestedDecomposition: 'Single developer task',
      riskNotes: 'Low risk UI change.',
    },
    createdAt: nowIso(),
    ...overrides,
  };
}

test('ADR3-01: TaskAssessment schema validates complete structure and rejects invalid axes', () => {
  const assessment = createSampleAssessment();
  const issues = check('task-assessment.schema.json', '', assessment);
  assert.deepEqual(issues, []);

  // Reject unsupported axis value
  const badAssessment = {
    ...assessment,
    assessmentAxes: {
      ...assessment.assessmentAxes,
      failureImpact: 'extreme',
    },
  };
  const badIssues = check('task-assessment.schema.json', '', badAssessment);
  assert.ok(badIssues.length > 0, 'Expected schema failure on invalid axis');
});

function createSampleRoleBindings(overrides = {}) {
  return {
    analyst: { role: 'analyst', provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
    developer: { role: 'developer', provider: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' },
    codeReviewer: { role: 'codeReviewer', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    testReviewer: { role: 'testReviewer', provider: 'claude', model: 'claude-haiku-5-5', effort: 'high' },
    ...overrides,
  };
}

test('ADR3-02: Deterministic plan selection produces identical fingerprints for identical inputs', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };
  const roleBindings = createSampleRoleBindings();

  const plan1 = selectExecutionPlan({ assessment, sourceFacts, roleBindings, reviewerConfirmation: confirmation });
  const plan2 = selectExecutionPlan({ assessment, sourceFacts, roleBindings, reviewerConfirmation: confirmation });

  assert.equal(plan1.planFingerprint, plan2.planFingerprint);
  assert.equal(plan1.classification.winningClassification, 'local');
  assert.deepEqual(plan1.selectedStages, ['define', 'implement', 'assemble_and_check', 'delivery_review', 'accept_outcome']);
});

test('ADR3-03: Source-derived floors override underestimated Analyst assessment when critical paths are touched', () => {
  // Analyst reports local change with low impact, but source paths touch storage migrations
  const assessment = createSampleAssessment({
    assessmentAxes: {
      scopeCoupling: 'local',
      technicalDifficulty: 'low',
      failureImpact: 'limited',
      uncertainty: 'low',
      verifiability: 'clear',
    },
  });

  const sourceFacts = deriveSourceFacts(
    ['docs/storage/m9.sql', 'src/Header.tsx'],
    { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS }
  );

  assert.deepEqual(sourceFacts.criticalPaths, ['docs/storage/m9.sql']);

  const plan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings: createSampleRoleBindings(),
    projectPolicy: { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS },
  });

  // Stricter derived floor wins!
  assert.equal(plan.classification.derivedFloor, 'critical');
  assert.equal(plan.classification.winningClassification, 'critical');
  assert.ok(plan.classification.reason.includes('Source-derived floor (critical'));

  // Full reference stages must be selected
  assert.deepEqual(plan.selectedStages, REFERENCE_STAGES);
  assert.equal(plan.omittedStages.length, 0);
});

test('ADR3-03: Undeclared critical areas in project policy fails closed to full reference stages', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], {}); // No criticalAreas declared

  assert.equal(sourceFacts.undeclaredPolicy, true);

  const plan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings: createSampleRoleBindings(),
    projectPolicy: {}, // No criticalAreas declared
  });

  assert.equal(plan.classification.derivedFloor, 'critical');
  assert.equal(plan.classification.winningClassification, 'critical');
  assert.ok(plan.classification.reason.includes('undeclared; failing closed to full reference stages'));
  assert.deepEqual(plan.selectedStages, REFERENCE_STAGES);
});

test('ADR3-S01 / ADR3-03: Assembly-time candidate floor check catches undeclared critical edits and escalates workflow', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };

  // Plan was initially compact
  const plan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings: createSampleRoleBindings(),
    reviewerConfirmation: confirmation,
  });
  assert.equal(plan.selectedStages.includes('readiness_review'), false);

  // During implementation, Developer edited supervisor.rs!
  const candidateDiff = ['src/Header.tsx', 'src-tauri/src/supervisor.rs'];
  const checkResult = evaluateCandidateFloors(plan, candidateDiff, { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });

  assert.equal(checkResult.status, 'escalated');
  assert.deepEqual(checkResult.exceededPaths, ['src-tauri/src/supervisor.rs']);
  assert.ok(checkResult.escalationPlan, 'Escalation plan generated');
  assert.equal(checkResult.escalationPlan.classification.winningClassification, 'critical');
  assert.deepEqual(checkResult.escalationPlan.selectedStages, REFERENCE_STAGES);
  assert.equal(checkResult.escalationPlan.candidateFloorCheck.status, 'escalated');
});

test('ADR3-04: Distinct code and test reviewers are enforced', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };

  // Two separate objects with identical role string 'reviewer'
  const sameRoleBindings = {
    analyst: { role: 'analyst', provider: 'codex', model: 'v1', effort: 'high' },
    developer: { role: 'developer', provider: 'claude', model: 'v1', effort: 'high' },
    codeReviewer: { role: 'reviewer', provider: 'codex', model: 'v1', effort: 'high' },
    testReviewer: { role: 'reviewer', provider: 'claude', model: 'v2', effort: 'high' },
  };

  assert.throws(() => {
    selectExecutionPlan({
      assessment,
      sourceFacts,
      roleBindings: sameRoleBindings,
      reviewerConfirmation: confirmation,
    });
  }, /distinct/i);

  // Distinct roles succeed
  const distinctPlan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings: createSampleRoleBindings(),
    reviewerConfirmation: confirmation,
  });
  assert.ok(distinctPlan.planId);
});

test('ADR3-06: Aggregate bounds accounting tracks attempts and duration, halting on exhaustion', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };

  let plan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings: createSampleRoleBindings(),
    aggregateBounds: { maxAttempts: 5, maxElapsedSeconds: 100 },
    reviewerConfirmation: confirmation,
  });

  // Charge preparation attempts
  let charge = chargeAggregateBounds(plan, { attempts: 2, elapsedSeconds: 30 });
  assert.equal(charge.exhausted, false);
  plan = { ...plan, aggregateBounds: charge.bounds };

  // Charge implementation attempts
  charge = chargeAggregateBounds(plan, { attempts: 2, elapsedSeconds: 40 });
  assert.equal(charge.exhausted, false);
  plan = { ...plan, aggregateBounds: charge.bounds };

  // Charge that exceeds maxAttempts
  charge = chargeAggregateBounds(plan, { attempts: 2, elapsedSeconds: 10 });
  assert.equal(charge.exhausted, true);
  assert.ok(charge.reason.includes('attempts limit exhausted'));
});

test('ADR3-09: EvaluationRecord schema validates comparative evaluation metrics and corpus cases', () => {
  const evalRecord = {
    schemaVersion: 1,
    kind: 'EvaluationRecord',
    evaluationId: 'EVAL-001',
    caseClass: 'small_change_critical_consequences',
    policyVariant: 'compact_packages',
    runId: randomUUID(),
    planRevisionId: 'REV-001',
    plannedStages: ['define', 'implement', 'assemble_and_check', 'delivery_review', 'accept_outcome'],
    observedStages: ['define', 'implement', 'assemble_and_check', 'readiness_review', 'delivery_review', 'accept_outcome'],
    revisions: 1,
    qualityResult: {
      independentAcceptance: 'passed',
      escapedDefects: 0,
      falseApprovals: 0,
    },
    workMetrics: {
      invocations: 18,
      repairCycles: 1,
      repeatedReviews: 1,
      durationMs: 45000,
    },
    evaluatedAt: nowIso(),
  };

  const issues = check('evaluation-record.schema.json', '', evalRecord);
  assert.deepEqual(issues, []);
});

test('R9: Missing role bindings are rejected and never substituted with invented defaults', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };

  assert.throws(() => {
    selectExecutionPlan({ assessment, sourceFacts, reviewerConfirmation: confirmation });
  }, /Explicit role bindings required/);
});

test('R11: Plan fingerprint changes when requirements or aggregate bounds change', () => {
  const assessment = createSampleAssessment();
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };
  const roleBindings = createSampleRoleBindings();

  const plan1 = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings,
    reviewerConfirmation: confirmation,
    aggregateBounds: { maxAttempts: 5, maxElapsedSeconds: 60 },
  });

  const modifiedAssessment = {
    ...assessment,
    intendedOutcome: 'Completely different outcome',
    requirements: [
      {
        id: 'REQ-DIFF',
        title: 'Different obligation',
        description: 'New obligation',
        acceptanceCriteria: [],
      },
    ],
  };

  const plan2 = selectExecutionPlan({
    assessment: modifiedAssessment,
    sourceFacts,
    roleBindings,
    reviewerConfirmation: confirmation,
    aggregateBounds: { maxAttempts: 100, maxElapsedSeconds: 3600 },
  });

  assert.notEqual(plan1.planFingerprint, plan2.planFingerprint);
});

test('R14: High uncertainty or unverified verifiability elevates floor to at least modular', () => {
  const assessment = createSampleAssessment({
    assessmentAxes: {
      scopeCoupling: 'local',
      technicalDifficulty: 'low',
      failureImpact: 'limited',
      uncertainty: 'high',
      verifiability: 'unverified',
    },
    grounds: {
      references: ['src/Header.tsx'],
      assumptions: [],
      confidence: 'Recorded',
      unresolvedQuestions: ['Unknown acceptance criteria meaning'],
    },
  });
  const sourceFacts = deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
  const confirmation = { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified local UI scope' };
  const roleBindings = createSampleRoleBindings();

  const plan = selectExecutionPlan({
    assessment,
    sourceFacts,
    roleBindings,
    reviewerConfirmation: confirmation,
  });

  assert.equal(plan.classification.winningClassification, 'modular');
  assert.deepEqual(plan.selectedStages, REFERENCE_STAGES);
  assert.equal(plan.omittedStages.length, 0);
});

// A stored run, assessment and plan, so execution plan revisions can be recorded against real parents.
function seedExecutionStore(store) {
  const runId = randomUUID();
  // Real artifacts for the run's references, so the store's foreign-key check passes when it is reopened.
  const snapshot = store.putJson({ fixture: 'workflow snapshot' }).artifactId;
  const settings = store.putJson({ fixture: 'settings' }).artifactId;
  store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'ws-1', 'C:/fixture', 'c'.repeat(64), nowIso(), nowIso());
  store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?)', 'wf-1', snapshot, nowIso(), nowIso());
  const hasPublications = Boolean(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_publications'"));
  if (hasPublications) {
    const definitionDigest = 'd'.repeat(64), publicationId = randomUUID();
    store.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,
      authority_policy_version,provenance,runnable,validation_json,source_draft_revision,created_at)
      VALUES(?,?,1,?,?,?,?, 'owner-publication',1,'{}',1,?)`, publicationId, 'wf-1', snapshot, definitionDigest, 'e'.repeat(64),
    'designated-judge/1', nowIso());
    store.run(
      `INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,published_version_id,definition_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
      runId, 'wf-1', 'ws-1', snapshot, settings, 'a'.repeat(64), 'running', nowIso(), publicationId, definitionDigest
    );
  } else {
    store.run('INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      runId, 'wf-1', 'ws-1', snapshot, settings, 'a'.repeat(64), 'running', nowIso());
  }
  const assessment = createSampleAssessment({ assessmentRunId: runId });
  store.recordTaskAssessment(assessment);
  const plan = selectExecutionPlan({
    assessment,
    sourceFacts: deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS }),
    roleBindings: createSampleRoleBindings(),
    reviewerConfirmation: { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified' },
  });
  return { plan, assessmentId: assessment.assessmentId };
}

const revisionsOf = (store, planId) => store.all('SELECT plan_revision_id, status FROM execution_plans WHERE id = ? ORDER BY plan_revision_id', planId)
  .map(row => ({ plan_revision_id: row.plan_revision_id, status: row.status }));
const primaryKeyOf = store => store.all('PRAGMA table_info(execution_plans)').filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

test('A4: an identical retry of an execution plan revision returns its receipt and keeps the active revision', () => {
  const store = new Store(join(tmpdir(), `plan-retry-${randomUUID()}`));
  try {
    const { plan, assessmentId } = seedExecutionStore(store);
    const first = store.recordExecutionPlan(plan, assessmentId);
    const retry = store.recordExecutionPlan(plan, assessmentId);
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(retry.artifactId, first.artifactId);
    assert.deepEqual(revisionsOf(store, plan.planId), [{ plan_revision_id: plan.planRevisionId, status: 'active' }]);
  } finally {
    store.close();
  }
});

test('A4: a different document under an existing revision is refused and the active revision is preserved', () => {
  const store = new Store(join(tmpdir(), `plan-conflict-${randomUUID()}`));
  try {
    const { plan, assessmentId } = seedExecutionStore(store);
    store.recordExecutionPlan(plan, assessmentId);
    assert.throws(
      () => store.recordExecutionPlan({ ...plan, planFingerprint: 'f'.repeat(64) }, assessmentId),
      /already stored with different content/
    );
    assert.deepEqual(revisionsOf(store, plan.planId), [{ plan_revision_id: plan.planRevisionId, status: 'active' }]);
  } finally {
    store.close();
  }
});

test('A4: a failed revision insert rolls back its supersession so the previous revision stays active', () => {
  const store = new Store(join(tmpdir(), `plan-rollback-${randomUUID()}`));
  try {
    const { plan, assessmentId } = seedExecutionStore(store);
    store.recordExecutionPlan(plan, assessmentId);
    // An out-of-contract boundary violates the table's CHECK after the supersession UPDATE has run.
    assert.throws(() => store.recordExecutionPlan({ ...plan, planRevisionId: randomUUID(), deliveryBoundary: 'bogus' }, assessmentId));
    assert.deepEqual(revisionsOf(store, plan.planId), [{ plan_revision_id: plan.planRevisionId, status: 'active' }]);
  } finally {
    store.close();
  }
});

test('A5: opening a store migrated with the earlier m9 upgrades execution plans and keeps its rows', () => {
  const root = join(tmpdir(), `legacy-m9-${randomUUID()}`);
  const steps = MIGRATION_PATHS.map(path => readFileSync(path, 'utf8'));
  const legacy = new Store(root, { migrations: steps.slice(0, 9) });
  let planId;
  let assessmentId;
  let plan;
  try {
    ({ plan, assessmentId } = seedExecutionStore(legacy));
    planId = plan.planId;
    legacy.recordExecutionPlan(plan, assessmentId);
    assert.deepEqual(primaryKeyOf(legacy), ['id'], 'The earlier m9 is expected to key execution plans by id alone.');
  } finally {
    legacy.close();
  }
  const upgraded = new Store(root);
  try {
    assert.deepEqual(primaryKeyOf(upgraded), ['id', 'plan_revision_id']);
    assert.deepEqual(revisionsOf(upgraded, planId), [{ plan_revision_id: plan.planRevisionId, status: 'active' }], 'The upgrade dropped or changed an existing revision.');
    upgraded.recordExecutionPlan({ ...plan, planRevisionId: randomUUID() }, assessmentId);
    assert.deepEqual(revisionsOf(upgraded, planId).map(r => r.status).sort(), ['active', 'superseded']);
  } finally {
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: Store persists TaskAssessment and ExecutionPlan records into m9 tables', () => {
  const storeRoot = ownedPath(join(resolve(import.meta.dirname, '../../.deszo/tests'), `task-store-${randomUUID()}`));
  mkdirSync(join(storeRoot, 'store'), { recursive: true });
  const store = new Store(storeRoot);
  try {
    const runId = randomUUID();
    store.run('PRAGMA foreign_keys = OFF;');
    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      runId, 'wf-1', 'ws-1', 'art-1', 'art-2', 'a'.repeat(64), 'running', nowIso()
    );

    const sampleAssessment = createSampleAssessment({ assessmentRunId: runId });
    const { assessmentId } = store.recordTaskAssessment(sampleAssessment);
    assert.equal(assessmentId, sampleAssessment.assessmentId);

    const row = store.get('SELECT * FROM task_assessments WHERE id = ?', assessmentId);
    assert.ok(row);
    assert.equal(row.assessment_run_id, runId);

    const plan = selectExecutionPlan({
      assessment: sampleAssessment,
      sourceFacts: deriveSourceFacts(['src/Header.tsx'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS }),
      roleBindings: createSampleRoleBindings(),
      reviewerConfirmation: { confirmed: true, confirmedBy: 'code-reviewer', confirmedAt: nowIso(), reason: 'Verified' },
    });

    const { planId } = store.recordExecutionPlan(plan, assessmentId);
    const planRow = store.get('SELECT * FROM execution_plans WHERE id = ?', planId);
    assert.ok(planRow);
    assert.equal(planRow.assessment_id, assessmentId);
    assert.equal(planRow.plan_fingerprint, plan.planFingerprint);
  } finally {
    store.close();
  }
});


