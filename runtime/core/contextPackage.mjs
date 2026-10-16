import { canonicalHash, compareText } from './canonical.mjs';
import { check, checkSchema } from './schemas.mjs';
import { nowIso } from './store.mjs';

export const PROMPT_STYLE_VERSION = 1;
export const GLOSSARY_VERSION = 1;
export const PACKAGE_SELECTOR_VERSION = 1;

// Pure semantic package fingerprint builder (ADR-0004 §2 & review R12)
// Purely hashes semantic inputs: role, binding, subject, policy, normative, source, evidence.
// Excludes attempt-specific metadata (packageId, createdAt, stepInstanceId).
export function computePackageSemanticFingerprint({
  role,
  taskBinding,
  subjectDigest,
  selectionPolicy,
  normativeContent = [],
  sourceAndChanges = [],
  evidenceAndIssues = [],
}) {
  const sortedNormative = [...normativeContent].sort((a, b) => compareText(a.ref, b.ref));
  const sourceMap = new Map();
  for (const s of sourceAndChanges) {
    sourceMap.set(s.path, s);
  }
  const sortedSource = Array.from(sourceMap.values()).sort((a, b) => compareText(a.path, b.path));
  const evidenceMap = new Map();
  for (const e of evidenceAndIssues) {
    evidenceMap.set(e.ref, e);
  }
  const sortedEvidence = Array.from(evidenceMap.values()).sort((a, b) => compareText(a.ref, b.ref));

  return canonicalHash({
    role,
    taskBinding,
    subjectDigest,
    selectionPolicy,
    normativeContent: sortedNormative,
    sourceAndChanges: sortedSource,
    evidenceAndIssues: sortedEvidence,
  });
}

// Builds role-specific context package deterministically from captured inputs.
export function buildContextPackage({
  role,
  taskBinding,
  subjectDigest,
  stepInstanceId,
  isFreshContext = true,
  declaredScope = [],
  normativeContent = [],
  sourceFiles = [],
  evidenceAndIssues = [],
}) {
  // Canonical sort and deduplication
  const sortedScope = [...new Set(declaredScope)].sort();
  const sortedNormative = [...normativeContent].sort((a, b) => compareText(a.ref, b.ref));
  const sortedSource = [...sourceFiles].sort((a, b) => compareText(a.path, b.path));
  const sortedEvidence = [...evidenceAndIssues].sort((a, b) => compareText(a.ref, b.ref));

  const roleInclusionReasons = {
    developer: 'Assigned requirements, task inputs, relevant interfaces, production-code scope, test contracts.',
    testAuthor: 'Requirements, scenarios, interfaces and test fixtures needed to verify behavior.',
    codeReviewer: 'Changed implementation, necessary dependency/consumer contracts, requirements and relevant checks.',
    testReviewer: 'Requirements/scenarios, tests/fixtures, affected implementation interfaces and check records.',
    analyst: 'Original business contract, criterion-to-evidence coverage, and unresolved limitations.',
    juniorAnalyst: 'Assigned document defects and normative references needed to preserve meaning.',
  };

  const inclusionReason = roleInclusionReasons[role] || 'Standard role-specific context closure.';

  const selectionPolicy = {
    selector: 'deterministic-role-closure',
    selectorVersion: PACKAGE_SELECTOR_VERSION,
    declaredScope: sortedScope,
    inclusionReasons: [inclusionReason],
  };

  // Pure semantic fingerprint (R12)
  const semanticFingerprint = computePackageSemanticFingerprint({
    role,
    taskBinding,
    subjectDigest,
    selectionPolicy,
    normativeContent: sortedNormative,
    sourceAndChanges: sortedSource,
    evidenceAndIssues: sortedEvidence,
  });

  const packageId = `PKG-${canonicalHash({ semanticFingerprint, stepInstanceId }).slice(0, 12)}`;

  const pkg = {
    schemaVersion: 1,
    kind: 'ContextPackage',
    packageId,
    role,
    taskBinding,
    subjectDigest,
    selectionPolicy,
    normativeContent: sortedNormative,
    sourceAndChanges: sortedSource,
    evidenceAndIssues: sortedEvidence,
    contextBinding: {
      mode: isFreshContext ? 'fresh' : 'continued',
      stepInstanceId,
    },
    semanticFingerprint,
    createdAt: nowIso(),
  };

  const issues = check('context-package.schema.json', '', pkg);
  if (issues.length) {
    throw new Error(`Invalid ContextPackage: ${issues.map(i => i.message).join('; ')}`);
  }

  return pkg;
}

// Versioned compatibility fingerprinting (ADR-0004 §3 & §5)
// version 1: implicit legacy composition (no package, no style/glossary version)
// version 2: package-aware composition including package semantic fingerprint, style version, glossary version
export function computeCompatibilityFingerprint({
  version = 2,
  subjectHash,
  scope,
  role,
  provider,
  model,
  effort,
  promptInstructions,
  contextPackage = null,
  promptStyleVersion = PROMPT_STYLE_VERSION,
  glossaryVersion = GLOSSARY_VERSION,
}) {
  if (version === 1) {
    return canonicalHash({
      fingerprintVersion: 1,
      subjectHash,
      scope,
      role,
      provider,
      model,
      effort,
      promptInstructions,
    });
  }

  if (version === 2) {
    return canonicalHash({
      fingerprintVersion: 2,
      subjectHash,
      scope,
      role,
      provider,
      model,
      effort,
      promptInstructions,
      packageSemanticFingerprint: contextPackage?.semanticFingerprint ?? null,
      promptStyleVersion,
      glossaryVersion,
    });
  }

  throw new Error(`Unsupported fingerprint version: ${version}`);
}

// Decides carry compatibility across versions: v1 records NEVER carry into v2 executions
export function canCarryApproval({ priorFingerprint, currentFingerprint, priorVersion = 1, currentVersion = 2 }) {
  if (priorVersion !== currentVersion) {
    // Migration boundary: one-time invalidation of pre-package approvals
    return {
      canCarry: false,
      reason: `Cannot carry approval across fingerprint versions (prior v${priorVersion} vs current v${currentVersion}): package-aware execution requires re-review.`,
    };
  }
  if (priorFingerprint !== currentFingerprint) {
    return {
      canCarry: false,
      reason: 'Fingerprint mismatch: inputs, prompt instructions or context package changed.',
    };
  }
  return {
    canCarry: true,
    reason: 'Fingerprints match identically.',
  };
}

// Request-as-result and resume handling (ADR-0004 §4)
export function handleContextNeededRequest({
  request,
  contextPackage,
  stepAttempts = 1,
  maxStepAttempts = 3,
  availableArtifacts = new Map(),
}) {
  if (stepAttempts >= maxStepAttempts) {
    return {
      resumed: false,
      outcome: 'REVIEW_INCOMPLETE',
      reason: 'budget_exhausted',
      diagnostics: `Step attempt budget (${maxStepAttempts}) exhausted during context retrieval.`,
    };
  }

  const requestedPaths = request.paths || [];
  const materialized = [];
  const missing = [];

  for (const path of requestedPaths) {
    if (availableArtifacts.has(path)) {
      materialized.push({ path, content: availableArtifacts.get(path) });
    } else {
      missing.push(path);
    }
  }

  // Widen package with materialized artifacts
  const mergedSource = [
    ...contextPackage.sourceAndChanges,
    ...materialized.map(m => ({
      path: m.path,
      digest: canonicalHash(m.content),
      changeKind: 'unchanged',
    })),
  ];

  // Pure semantic fingerprint across widening attempts (R12)
  const widenedSemanticFingerprint = computePackageSemanticFingerprint({
    role: contextPackage.role,
    taskBinding: contextPackage.taskBinding,
    subjectDigest: contextPackage.subjectDigest,
    selectionPolicy: contextPackage.selectionPolicy,
    normativeContent: contextPackage.normativeContent,
    sourceAndChanges: mergedSource,
    evidenceAndIssues: contextPackage.evidenceAndIssues,
  });

  const widenedPackage = {
    ...contextPackage,
    sourceAndChanges: mergedSource,
    contextBinding: {
      mode: 'continued',
      stepInstanceId: contextPackage.contextBinding.stepInstanceId,
    },
    semanticFingerprint: widenedSemanticFingerprint,
  };

  // If any requested path was missing, retrieval is incomplete; do not treat as resumable (R13)
  if (missing.length > 0) {
    return {
      resumed: false,
      outcome: 'REVIEW_INCOMPLETE',
      reason: 'retrieval_failed',
      missing,
      diagnostics: `Requested context artifacts not found: ${missing.join(', ')}.`,
      unresolvedRequests: [
        {
          paths: missing,
          reason: request.reason || 'Required dependency',
          blocksDecision: request.blocksDecision || 'approval',
        },
      ],
      widenedPackage: materialized.length > 0 ? widenedPackage : null,
      materializedCount: materialized.length,
    };
  }

  return {
    resumed: true,
    widenedPackage,
    materializedCount: materialized.length,
    consumedStepAttempts: stepAttempts + 1,
  };
}

// Loop handling for REVIEW_INCOMPLETE (ADR-0004 §4)
// Within an enclosing loop, retry with wider package if budget allows; else pause for user (waiting_for_user)
// without consuming repair iterations.
export function handleReviewOutcomeInLoop({
  reviewOutcome, // { status: 'COMPLETED' | 'REVIEW_INCOMPLETE', verdict: 'APPROVED' | 'CHANGES_REQUESTED', reason }
  loopState = { iteration: 1, maxIterations: 3, retryAllowed: true },
}) {
  if (reviewOutcome.status === 'COMPLETED') {
    if (reviewOutcome.verdict === 'APPROVED') {
      return { action: 'proceed', nextState: 'approved', consumesIteration: false };
    }
    // CHANGES_REQUESTED consumes repair iteration
    return {
      action: 'repair',
      nextState: loopState.iteration + 1 > loopState.maxIterations ? 'failed' : 'repairing',
      consumesIteration: true,
      iteration: loopState.iteration + 1,
    };
  }

  if (reviewOutcome.status === 'REVIEW_INCOMPLETE') {
    if (loopState.retryAllowed && loopState.iteration <= loopState.maxIterations) {
      // First tier: retry with widened context package without consuming repair iteration
      return {
        action: 'retry_widen_context',
        nextState: 'retrying_context',
        consumesIteration: false,
        iteration: loopState.iteration,
      };
    }

    // Second tier: pause for user rather than consuming iteration as failed implementation
    return {
      action: 'pause_for_user',
      nextState: 'waiting_for_user',
      consumesIteration: false,
      diagnostics: `Review incomplete (${reviewOutcome.reason || 'context_unavailable'}). Pausing for user without consuming repair iterations.`,
    };
  }

  throw new Error(`Unknown review outcome status: ${reviewOutcome.status}`);
}

const BOUNDARIES = ['candidate', 'verified_branch'];

// A complete immutable engine record. Anything less (an identifier, a digest alone, a caller's own note) is refused.
const RESOLVED_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { enum: ['check', 'artifact', 'observation', 'commit'] },
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    subjectId: { type: 'string', minLength: 1 },
    candidateDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    boundary: { enum: BOUNDARIES },
    source: { const: 'engine' },
    outcome: { enum: ['passed', 'failed', 'recorded'] },
    appliesToCriteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    recordedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'kind', 'digest', 'subjectId', 'candidateDigest', 'boundary', 'source', 'outcome', 'appliesToCriteria', 'recordedAt'],
  additionalProperties: false,
};

// Authoritative evaluation needs the captured inputs and an engine resolver. A caller's collection name is not trust.
function authoritativeInputsMissing(options) {
  const missing = [];
  if (!Array.isArray(options.expectedCriteria) || options.expectedCriteria.length === 0) missing.push('expectedCriteria');
  if (!BOUNDARIES.includes(options.expectedBoundary)) missing.push('expectedBoundary');
  if (typeof options.expectedSubjectId !== 'string' || options.expectedSubjectId.length === 0) missing.push('expectedSubjectId');
  if (!/^[a-f0-9]{64}$/.test(options.expectedCandidateDigest || '')) missing.push('expectedCandidateDigest');
  if (typeof options.resolveEvidence !== 'function') missing.push('resolveEvidence');
  return missing;
}

// Returns why a reference is not verified, or null when the engine record supports the criterion.
function evidenceProblem(criterion, ref, options) {
  let resolved;
  try { resolved = options.resolveEvidence(ref); } catch (error) { return `engine resolver failed: ${error.message}`; }
  if (!resolved) return 'not found in the engine evidence store';
  if (checkSchema(RESOLVED_EVIDENCE_SCHEMA, resolved).length) return 'incomplete or malformed engine record';
  if (resolved.id !== ref.id) return 'record identity differs from the reference';
  if (resolved.kind !== ref.kind) return `record kind "${resolved.kind}" differs from referenced kind "${ref.kind}"`;
  if (resolved.digest !== ref.digest) return 'record digest differs from the reference';
  if (resolved.subjectId !== options.expectedSubjectId) return 'record belongs to another subject';
  if (resolved.candidateDigest !== options.expectedCandidateDigest) return 'record belongs to another candidate';
  const expectedEvidenceBoundary = options.criterionBoundaries?.[criterion.criterionId] || options.expectedBoundary;
  if (resolved.boundary !== expectedEvidenceBoundary) return `record was made at boundary "${resolved.boundary}"`;
  if (!resolved.appliesToCriteria.includes(criterion.criterionId)) return 'record does not apply to this criterion';
  const requiredOutcome = ref.kind === 'check' ? 'passed' : 'recorded';
  if (resolved.outcome !== requiredOutcome) return `outcome "${resolved.outcome}" does not satisfy required outcome "${requiredOutcome}"`;
  return null;
}

// Evaluates AcceptanceRecord (ADR-0004 §1 & review R8)
export function evaluateAcceptanceRecord(record, options = {}) {
  const issues = check('acceptance-record.schema.json', '', record);
  if (issues.length) {
    return {
      valid: false,
      canOpenGate: false,
      reason: `Invalid AcceptanceRecord: ${issues.map(i => i.message).join('; ')}`,
    };
  }

  // Criteria inventory cannot be empty (R8)
  if (!record.criteria || record.criteria.length === 0) {
    return {
      valid: false,
      canOpenGate: false,
      reason: 'AcceptanceRecord criteria inventory cannot be empty.',
    };
  }

  // Expected criteria inventory check (R8)
  if (options.expectedCriteria && Array.isArray(options.expectedCriteria)) {
    const presentIds = new Set(record.criteria.map(c => c.criterionId));
    const missingExpected = options.expectedCriteria.filter(id => !presentIds.has(id));
    if (missingExpected.length > 0) {
      return {
        valid: false,
        canOpenGate: false,
        reason: `Missing expected criteria from inventory: ${missingExpected.join(', ')}.`,
      };
    }
  }

  // Subject and candidate digest verification
  if (options.expectedSubjectId && record.subjectId !== options.expectedSubjectId) {
    return {
      valid: false,
      canOpenGate: false,
      reason: `Subject ID mismatch: expected "${options.expectedSubjectId}", got "${record.subjectId}".`,
    };
  }
  if (options.expectedCandidateDigest && record.candidateDigest !== options.expectedCandidateDigest) {
    return {
      valid: false,
      canOpenGate: false,
      reason: `Candidate digest mismatch: expected "${options.expectedCandidateDigest}", got "${record.candidateDigest}".`,
    };
  }

  if (options.expectedBoundary && record.deliveryBoundary !== options.expectedBoundary) {
    return {
      valid: false,
      canOpenGate: false,
      reason: `Delivery boundary mismatch: expected "${options.expectedBoundary}", got "${record.deliveryBoundary}".`,
    };
  }

  // Any satisfied criteria must have at least one valid evidence reference (R8)
  const satisfiedWithoutEvidence = record.criteria.filter(
    c => c.status === 'satisfied' && (!c.evidenceRefs || c.evidenceRefs.length === 0)
  );
  if (satisfiedWithoutEvidence.length > 0) {
    return {
      valid: false,
      canOpenGate: false,
      reason: `Satisfied criteria lack required evidence references: ${satisfiedWithoutEvidence.map(c => c.criterionId).join(', ')}.`,
    };
  }

  // Authoritative Gate check (ADR-0004, audit A2): every satisfied reference must resolve, through the engine
  // resolver, to a complete record matching its kind, digest, subject, candidate, boundary, criterion and outcome.
  const authoritativeMissing = authoritativeInputsMissing(options);
  if (authoritativeMissing.length === 0) {
    const unverifiedRefs = [];
    for (const c of record.criteria) {
      if (c.status !== 'satisfied') continue;
      for (const ref of c.evidenceRefs || []) {
        const problem = evidenceProblem(c, ref, options);
        if (problem) unverifiedRefs.push(`${c.criterionId} ${ref.id}: ${problem}`);
      }
    }
    if (unverifiedRefs.length > 0) {
      return {
        valid: true,
        canOpenGate: false,
        reason: `Evidence not verified against immutable engine records: ${unverifiedRefs.join('; ')}.`,
      };
    }
  }

  const unverified = record.criteria.filter(c => c.status === 'unverified');
  const unsatisfied = record.criteria.filter(c => c.status === 'unsatisfied');

  if (unsatisfied.length > 0) {
    if (record.overallStatus === 'accepted') {
      throw new Error(`AcceptanceRecord cannot have status "accepted" when criteria are unsatisfied: ${unsatisfied.map(c => c.criterionId).join(', ')}`);
    }
    return { valid: true, canOpenGate: false, reason: 'Criteria unsatisfied.' };
  }

  if (unverified.length > 0) {
    if (record.overallStatus === 'accepted') {
      throw new Error(`AcceptanceRecord cannot have status "accepted" when criteria are unverified: ${unverified.map(c => c.criterionId).join(', ')}`);
    }
    return { valid: true, canOpenGate: false, reason: 'Criteria unverified.' };
  }

  if (record.overallStatus === 'accepted') {
    if (authoritativeMissing.length > 0) {
      // Structural validation alone never opens a Gate.
      return {
        valid: true,
        canOpenGate: false,
        reason: `Structural validation only; no Gate opened. Authoritative evaluation requires: ${authoritativeMissing.join(', ')}.`,
      };
    }
    return { valid: true, canOpenGate: true, reason: 'All criteria satisfied with evidence verified against engine records.' };
  }

  return { valid: true, canOpenGate: false, reason: `Overall status is ${record.overallStatus}.` };
}
