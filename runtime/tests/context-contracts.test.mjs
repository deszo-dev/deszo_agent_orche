import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check } from '../core/schemas.mjs';
import { Store, nowIso } from '../core/store.mjs';
import {
  buildContextPackage,
  computeCompatibilityFingerprint,
  canCarryApproval,
  handleContextNeededRequest,
  handleReviewOutcomeInLoop,
  evaluateAcceptanceRecord,
} from '../core/contextPackage.mjs';

test('ADR4-04: ContextPackage is built deterministically with canonical sorting and role inclusion', () => {
  const params = {
    role: 'developer',
    taskBinding: 'TASK-1',
    subjectDigest: '1'.repeat(64),
    stepInstanceId: 'delivery/1/task/1',
    isFreshContext: true,
    declaredScope: ['src/api.mjs', 'src/util.mjs'],
    normativeContent: [
      { ref: 'spec:REQ-2', digest: 'b'.repeat(64) },
      { ref: 'spec:REQ-1', digest: 'a'.repeat(64) },
    ],
    sourceFiles: [
      { path: 'src/util.mjs', digest: '2'.repeat(64), changeKind: 'unchanged' },
      { path: 'src/api.mjs', digest: '3'.repeat(64), changeKind: 'modified' },
    ],
    evidenceAndIssues: [{ ref: 'check:lint', digest: 'c'.repeat(64) }],
  };

  const pkg1 = buildContextPackage(params);
  const pkg2 = buildContextPackage({
    ...params,
    // Pass in reverse order to test canonical normalization
    declaredScope: ['src/util.mjs', 'src/api.mjs'],
    normativeContent: [
      { ref: 'spec:REQ-1', digest: 'a'.repeat(64) },
      { ref: 'spec:REQ-2', digest: 'b'.repeat(64) },
    ],
  });

  assert.equal(pkg1.semanticFingerprint, pkg2.semanticFingerprint);
  assert.equal(pkg1.packageId, pkg2.packageId);
  assert.deepEqual(pkg1.normativeContent[0].ref, 'spec:REQ-1');
  assert.deepEqual(pkg1.sourceAndChanges[0].path, 'src/api.mjs');
  const names = ['é', 'a', 'Z'];
  const mixed = buildContextPackage({ ...params, sourceFiles: names.map(path => ({ path, digest: '4'.repeat(64), changeKind: 'unchanged' })) });
  assert.deepEqual(mixed.sourceAndChanges.map(item => item.path), ['Z', 'a', 'é'], 'Canonical semantic order must not depend on the host locale.');
});

test('ADR4-S01 / ADR4-06: Compatibility fingerprints support v1 and v2, and adopting v2 invalidates carried v1 approvals', () => {
  const common = {
    subjectHash: 'a'.repeat(64),
    scope: 'src/**',
    role: 'codeReviewer',
    provider: 'codex',
    model: 'review-v1',
    effort: 'high',
    promptInstructions: 'Review carefully.',
  };

  const v1Fingerprint = computeCompatibilityFingerprint({ version: 1, ...common });
  const pkg = buildContextPackage({
    role: 'codeReviewer',
    taskBinding: 'TASK-1',
    subjectDigest: 'a'.repeat(64),
    stepInstanceId: 'step-1',
    declaredScope: ['src/Header.tsx'],
  });

  const v2Fingerprint = computeCompatibilityFingerprint({
    version: 2,
    contextPackage: pkg,
    ...common,
  });

  assert.notEqual(v1Fingerprint, v2Fingerprint);

  // Attempt to carry v1 approval into v2 execution: rejected due to migration boundary!
  const carryAcrossVersions = canCarryApproval({
    priorFingerprint: v1Fingerprint,
    currentFingerprint: v2Fingerprint,
    priorVersion: 1,
    currentVersion: 2,
  });
  assert.equal(carryAcrossVersions.canCarry, false);
  assert.ok(carryAcrossVersions.reason.includes('Cannot carry approval across fingerprint versions'));

  // Matching v2 fingerprints carry
  const carrySameV2 = canCarryApproval({
    priorFingerprint: v2Fingerprint,
    currentFingerprint: v2Fingerprint,
    priorVersion: 2,
    currentVersion: 2,
  });
  assert.equal(carrySameV2.canCarry, true);

  // Changed package invalidates v2 carry
  const pkgChanged = buildContextPackage({
    role: 'codeReviewer',
    taskBinding: 'TASK-1',
    subjectDigest: 'a'.repeat(64),
    stepInstanceId: 'step-1',
    declaredScope: ['src/Header.tsx', 'src/Sidebar.tsx'],
  });
  const v2FingerprintChanged = computeCompatibilityFingerprint({
    version: 2,
    contextPackage: pkgChanged,
    ...common,
  });
  const carryDifferentPkg = canCarryApproval({
    priorFingerprint: v2Fingerprint,
    currentFingerprint: v2FingerprintChanged,
    priorVersion: 2,
    currentVersion: 2,
  });
  assert.equal(carryDifferentPkg.canCarry, false);
});

test('ADR4-05: context_needed request materializes content and widens package within attempt limits', () => {
  const pkg = buildContextPackage({
    role: 'codeReviewer',
    taskBinding: 'TASK-1',
    subjectDigest: 'a'.repeat(64),
    stepInstanceId: 'step-1',
    declaredScope: ['src/Header.tsx'],
  });

  const available = new Map([['src/theme.ts', 'export const theme = "dark";']]);

  const req = {
    paths: ['src/theme.ts'],
    reason: 'Need theme definition to verify color tokens',
    blocksDecision: 'approval',
  };

  const res = handleContextNeededRequest({
    request: req,
    contextPackage: pkg,
    stepAttempts: 1,
    maxStepAttempts: 3,
    availableArtifacts: available,
  });

  assert.equal(res.resumed, true);
  assert.equal(res.consumedStepAttempts, 2);
  assert.equal(res.widenedPackage.sourceAndChanges.some(s => s.path === 'src/theme.ts'), true);

  // If budget is exhausted, produces REVIEW_INCOMPLETE
  const exhaustedRes = handleContextNeededRequest({
    request: req,
    contextPackage: pkg,
    stepAttempts: 3,
    maxStepAttempts: 3,
    availableArtifacts: available,
  });
  assert.equal(exhaustedRes.resumed, false);
  assert.equal(exhaustedRes.outcome, 'REVIEW_INCOMPLETE');
  assert.equal(exhaustedRes.reason, 'budget_exhausted');
});

test('ADR4-R03 / ADR4-12: REVIEW_INCOMPLETE in loops retries widening, then pauses without consuming repair iterations', () => {
  // COMPLETED with APPROVED
  const approvedRes = handleReviewOutcomeInLoop({
    reviewOutcome: { status: 'COMPLETED', verdict: 'APPROVED' },
    loopState: { iteration: 1, maxIterations: 3, retryAllowed: true },
  });
  assert.equal(approvedRes.action, 'proceed');
  assert.equal(approvedRes.consumesIteration, false);

  // COMPLETED with CHANGES_REQUESTED consumes iteration
  const changesRes = handleReviewOutcomeInLoop({
    reviewOutcome: { status: 'COMPLETED', verdict: 'CHANGES_REQUESTED' },
    loopState: { iteration: 1, maxIterations: 3, retryAllowed: true },
  });
  assert.equal(changesRes.action, 'repair');
  assert.equal(changesRes.consumesIteration, true);
  assert.equal(changesRes.iteration, 2);

  // REVIEW_INCOMPLETE with retryAllowed retries widening WITHOUT consuming repair iteration
  const incompleteRetryRes = handleReviewOutcomeInLoop({
    reviewOutcome: { status: 'REVIEW_INCOMPLETE', reason: 'context_unavailable' },
    loopState: { iteration: 1, maxIterations: 3, retryAllowed: true },
  });
  assert.equal(incompleteRetryRes.action, 'retry_widen_context');
  assert.equal(incompleteRetryRes.consumesIteration, false);
  assert.equal(incompleteRetryRes.iteration, 1);

  // REVIEW_INCOMPLETE when retry is not allowed transitions to waiting_for_user WITHOUT consuming repair iteration
  const incompletePauseRes = handleReviewOutcomeInLoop({
    reviewOutcome: { status: 'REVIEW_INCOMPLETE', reason: 'retrieval_failed' },
    loopState: { iteration: 1, maxIterations: 3, retryAllowed: false },
  });
  assert.equal(incompletePauseRes.action, 'pause_for_user');
  assert.equal(incompletePauseRes.nextState, 'waiting_for_user');
  assert.equal(incompletePauseRes.consumesIteration, false);
});

// Engine-owned evidence record for the single satisfied criterion of a record (A2 contract).
function engineRecord(record, overrides = {}) {
  const ref = record.criteria[0].evidenceRefs[0];
  return {
    id: ref.id,
    kind: ref.kind,
    digest: ref.digest,
    subjectId: record.subjectId,
    candidateDigest: record.candidateDigest,
    boundary: record.deliveryBoundary,
    source: 'engine',
    outcome: ref.kind === 'check' ? 'passed' : 'recorded',
    appliesToCriteria: [record.criteria[0].criterionId],
    recordedAt: nowIso(),
    ...overrides,
  };
}

function authoritativeOptions(record, resolveEvidence) {
  return {
    expectedCriteria: record.criteria.map(c => c.criterionId),
    expectedBoundary: record.deliveryBoundary,
    expectedSubjectId: record.subjectId,
    expectedCandidateDigest: record.candidateDigest,
    resolveEvidence,
  };
}

test('A2: authoritative evaluation requires complete engine records matching kind, digest, subject, boundary, criterion and outcome', () => {
  const record = {
    schemaVersion: 1,
    kind: 'AcceptanceRecord',
    recordId: 'ACC-A2',
    deliveryBoundary: 'candidate',
    subjectId: 'SUBJ-A2',
    candidateDigest: 'c'.repeat(64),
    accepter: { role: 'analyst', provider: 'codex', model: 'analyst-v1', effort: 'high', contextId: 'ctx-a2', independent: false },
    criteria: [{
      criterionId: 'AC-1',
      requirementRef: 'REQ-1',
      status: 'satisfied',
      reason: 'Check passed.',
      evidenceRefs: [{ kind: 'check', id: 'check-12', digest: 'd'.repeat(64) }],
    }],
    overallStatus: 'accepted',
    unresolvedLimitations: [],
    evaluatedAt: nowIso(),
  };
  const good = engineRecord(record);
  assert.equal(evaluateAcceptanceRecord(record, authoritativeOptions(record, ref => (ref.id === good.id ? good : undefined))).canOpenGate, true);

  // Structural validation and collection names never open a Gate.
  assert.equal(evaluateAcceptanceRecord(record, { expectedCriteria: ['AC-1'], expectedSubjectId: 'SUBJ-A2', expectedCandidateDigest: 'c'.repeat(64) }).canOpenGate, false);
  assert.equal(evaluateAcceptanceRecord(record, { ...authoritativeOptions(record), resolveEvidence: undefined, resolvedEvidence: new Map([[good.id, good]]) }).canOpenGate, false);

  const refused = {
    'identifier and digest only': { id: good.id, digest: good.digest },
    'digest that differs from the reference': { ...good, digest: 'e'.repeat(64) },
    'kind that differs from the reference': { ...good, kind: 'artifact' },
    'another subject': { ...good, subjectId: 'OTHER-SUBJECT' },
    'another candidate': { ...good, candidateDigest: 'f'.repeat(64) },
    'another boundary': { ...good, boundary: 'verified_branch' },
    'a source other than the engine': { ...good, source: 'caller' },
    'a criterion it does not apply to': { ...good, appliesToCriteria: ['AC-9'] },
    'a failed check outcome': { ...good, outcome: 'failed' },
    'a record with an extra caller field': { ...good, note: 'trust me' },
  };
  for (const [label, resolved] of Object.entries(refused)) {
    const result = evaluateAcceptanceRecord(record, authoritativeOptions(record, () => resolved));
    assert.equal(result.canOpenGate, false, `Gate opened with ${label}.`);
  }
  const throwing = evaluateAcceptanceRecord(record, authoritativeOptions(record, () => { throw new Error('store unavailable'); }));
  assert.equal(throwing.canOpenGate, false, 'Gate opened when the engine resolver failed.');
});

test('ADR4-11: AcceptanceRecord enforces that unsatisfied or unverified criteria block acceptance Gate', () => {
  const baseRecord = {
    schemaVersion: 1,
    kind: 'AcceptanceRecord',
    recordId: 'ACC-001',
    deliveryBoundary: 'candidate',
    subjectId: 'SUBJ-001',
    candidateDigest: 'c'.repeat(64),
    accepter: {
      role: 'analyst',
      provider: 'codex',
      model: 'analyst-v1',
      effort: 'high',
      contextId: 'ctx-accept-1',
      independent: false,
    },
    criteria: [
      {
        criterionId: 'AC-1',
        requirementRef: 'REQ-1',
        status: 'satisfied',
        reason: 'Verified against check report #12.',
        evidenceRefs: [
          { kind: 'check', id: 'check-12', digest: 'd'.repeat(64) },
        ],
      },
    ],
    overallStatus: 'accepted',
    unresolvedLimitations: [],
    evaluatedAt: nowIso(),
  };

  // Structural validation alone never opens a Gate (A2)
  const structuralEval = evaluateAcceptanceRecord(baseRecord);
  assert.equal(structuralEval.valid, true);
  assert.equal(structuralEval.canOpenGate, false);

  // A satisfied record opens the Gate only with captured inputs and a verified engine record
  const engine = engineRecord(baseRecord);
  const satisfiedEval = evaluateAcceptanceRecord(baseRecord, authoritativeOptions(baseRecord, ref => (ref.id === engine.id ? engine : undefined)));
  assert.equal(satisfiedEval.valid, true);
  assert.equal(satisfiedEval.canOpenGate, true);

  // Unverified criterion cannot open Gate and cannot be accepted
  const unverifiedRecord = {
    ...baseRecord,
    criteria: [
      {
        criterionId: 'AC-2',
        requirementRef: 'REQ-2',
        status: 'unverified',
        reason: 'Check output was missing.',
        evidenceRefs: [],
      },
    ],
    overallStatus: 'incomplete',
  };
  const unverifiedEval = evaluateAcceptanceRecord(unverifiedRecord);
  assert.equal(unverifiedEval.canOpenGate, false);

  // Record claiming "accepted" with unverified criterion throws error
  assert.throws(() => {
    evaluateAcceptanceRecord({
      ...unverifiedRecord,
      overallStatus: 'accepted',
    });
  }, /cannot have status "accepted" when criteria are unverified/i);
});

test('R8: evaluateAcceptanceRecord refuses empty criteria or satisfied criteria without evidence', () => {
  const baseRecord = {
    schemaVersion: 1,
    kind: 'AcceptanceRecord',
    recordId: 'ACC-R8',
    deliveryBoundary: 'candidate',
    subjectId: 'SUBJ-R8',
    candidateDigest: 'c'.repeat(64),
    accepter: {
      role: 'analyst',
      provider: 'codex',
      model: 'analyst-v1',
      effort: 'high',
      contextId: 'ctx-accept-1',
      independent: false,
    },
    criteria: [],
    overallStatus: 'accepted',
    unresolvedLimitations: [],
    evaluatedAt: nowIso(),
  };

  // Empty criteria refuses gate
  const emptyEval = evaluateAcceptanceRecord(baseRecord);
  assert.equal(emptyEval.canOpenGate, false);

  // Satisfied criterion with empty evidenceRefs refuses gate
  const noEvidenceRecord = {
    ...baseRecord,
    criteria: [
      {
        criterionId: 'AC-1',
        requirementRef: 'REQ-1',
        status: 'satisfied',
        reason: 'Claimed satisfied',
        evidenceRefs: [],
      },
    ],
  };
  const noEvidenceEval = evaluateAcceptanceRecord(noEvidenceRecord);
  assert.equal(noEvidenceEval.canOpenGate, false);
});

test('R12: Widened package semantic fingerprint is independent of attempt identity', () => {
  const pkgInput = {
    role: 'codeReviewer',
    taskBinding: 'TASK-1',
    subjectDigest: 'a'.repeat(64),
    declaredScope: ['src/main.js'],
  };
  const firstPackage = buildContextPackage({ ...pkgInput, stepInstanceId: 'attempt-A' });
  const secondPackage = buildContextPackage({ ...pkgInput, stepInstanceId: 'attempt-B' });

  const request = { paths: ['src/helper.js'], reason: 'Required dependency', blocksDecision: 'approval' };
  const available = new Map([['src/helper.js', 'export const helper = 1;']]);

  const a = handleContextNeededRequest({ request, contextPackage: firstPackage, availableArtifacts: available });
  const b = handleContextNeededRequest({ request, contextPackage: secondPackage, availableArtifacts: available });

  assert.equal(firstPackage.semanticFingerprint, secondPackage.semanticFingerprint);
  assert.equal(a.widenedPackage.semanticFingerprint, b.widenedPackage.semanticFingerprint);
});

test('R13: Partially missing context request produces unresolved items and prevents resumption', () => {
  const pkg = buildContextPackage({
    role: 'codeReviewer',
    taskBinding: 'TASK-1',
    subjectDigest: 'a'.repeat(64),
    stepInstanceId: 'attempt-A',
    declaredScope: ['src/main.js'],
  });

  const available = new Map([['src/helper.js', 'export const helper = 1;']]);
  const result = handleContextNeededRequest({
    request: { paths: ['src/helper.js', 'src/missing.js'], reason: 'Dependencies', blocksDecision: 'approval' },
    contextPackage: pkg,
    availableArtifacts: available,
  });

  assert.equal(result.resumed, false);
  assert.deepEqual(result.missing, ['src/missing.js']);
  assert.equal(result.outcome, 'REVIEW_INCOMPLETE');
});

test('R1: Store persists AcceptanceRecord into m9 acceptance_records table', () => {
  const storeRoot = join(resolve(import.meta.dirname, '../../.deszo/tests'), `context-store-${randomUUID()}`);
  mkdirSync(join(storeRoot, 'store'), { recursive: true });
  const store = new Store(storeRoot);
  try {
    const runId = randomUUID();
    store.run('PRAGMA foreign_keys = OFF;');
    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      runId, 'wf-1', 'ws-1', 'art-1', 'art-2', 'a'.repeat(64), 'running', nowIso()
    );

    const record = {
      schemaVersion: 1,
      kind: 'AcceptanceRecord',
      recordId: 'ACC-PERSIST-1',
      deliveryBoundary: 'candidate',
      subjectId: 'SUBJ-1',
      candidateDigest: 'c'.repeat(64),
      accepter: {
        role: 'analyst',
        provider: 'codex',
        model: 'analyst-v1',
        effort: 'high',
        contextId: 'ctx-1',
        independent: false,
      },
      criteria: [
        {
          criterionId: 'AC-1',
          requirementRef: 'REQ-1',
          status: 'satisfied',
          reason: 'Verified',
          evidenceRefs: [{ kind: 'check', id: 'chk-1', digest: 'd'.repeat(64) }],
        },
      ],
      overallStatus: 'accepted',
      unresolvedLimitations: [],
      evaluatedAt: nowIso(),
    };

    const { recordId } = store.recordAcceptanceRecord(record, runId);
    assert.equal(recordId, record.recordId);

    const row = store.get('SELECT * FROM acceptance_records WHERE id = ?', recordId);
    assert.ok(row);
    assert.equal(row.run_id, runId);
    assert.equal(row.overall_status, 'accepted');
  } finally {
    store.close();
  }
});


