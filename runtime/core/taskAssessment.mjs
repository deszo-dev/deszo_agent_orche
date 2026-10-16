import { canonicalHash } from './canonical.mjs';
import { check } from './schemas.mjs';
import { nowIso } from './store.mjs';
import { scopeMatches } from './map.mjs';

export const POLICY_VERSION = 1;
export const SELECTOR_VERSION = 1;

export const DEFAULT_DESZO_CRITICAL_AREAS = [
  'docs/storage/m*.sql',
  '**/launch_shim.rs',
  '**/supervisor.rs',
  'docs/schemas/*.json',
];

export const REFERENCE_STAGES = [
  'define',
  'readiness_review',
  'prepare',
  'implement',
  'assemble_and_check',
  'delivery_review',
  'accept_outcome',
];

// Evaluates captured source facts against project policy.
// If criticalAreas is not declared, fails closed to full reference stages.
export function deriveSourceFacts(sourceFiles = [], projectPolicy = {}) {
  const criticalAreaPatterns = projectPolicy.criticalAreas;
  const publicContractPatterns = projectPolicy.publicContracts || ['docs/schemas/*.json', 'src/types.ts'];
  const fanOutThreshold = projectPolicy.fanOutThreshold ?? 5;

  const undeclaredPolicy = !criticalAreaPatterns || criticalAreaPatterns.length === 0;
  const criticalPaths = [];
  const publicContracts = [];

  const patterns = undeclaredPolicy ? [] : criticalAreaPatterns;

  for (const file of sourceFiles) {
    const norm = file.replace(/\\/g, '/');
    if (patterns.some(p => scopeMatches(norm, p))) {
      criticalPaths.push(norm);
    }
    if (publicContractPatterns.some(p => scopeMatches(norm, p))) {
      publicContracts.push(norm);
    }
  }

  const dependencyFanOut = projectPolicy.declaredFanOut ?? sourceFiles.length;

  return {
    undeclaredPolicy,
    criticalPaths: criticalPaths.sort(),
    publicContracts: publicContracts.sort(),
    dependencyFanOut,
    fanOutExceeded: dependencyFanOut > fanOutThreshold,
  };
}

const CLASSIFICATION_SEVERITY = {
  local: 1,
  modular: 2,
  shared_contract: 3,
  critical: 4,
};

// Selects deterministic plan from assessment and project policy facts.
export function selectExecutionPlan({
  assessment,
  sourceFacts,
  projectPolicy = {},
  deliveryBoundary = 'candidate',
  roleBindings = null,
  aggregateBounds = { maxAttempts: 15, maxElapsedSeconds: 3600 },
  reviewerConfirmation = null,
  checks = [
    { id: 'syntax-lint', source: 'candidate', command: 'npm', args: ['run', 'lint'], expectedExitCode: 0 },
    { id: 'test-suite', source: 'candidate', command: 'npm', args: ['test'], expectedExitCode: 0 },
  ],
}) {
  const issues = check('task-assessment.schema.json', '', assessment);
  if (issues.length) {
    throw new Error(`Invalid TaskAssessment: ${issues.map(i => i.message).join('; ')}`);
  }

  // Derive floor
  let derivedFloor = 'local';
  let floorReason = 'Source facts indicate local scope.';

  // Assess axes including uncertainty and verifiability
  const axes = assessment.assessmentAxes;
  const hasUncertainty = axes.uncertainty === 'high' || axes.verifiability === 'unverified' || (assessment.grounds.unresolvedQuestions && assessment.grounds.unresolvedQuestions.length > 0);

  if (sourceFacts.undeclaredPolicy) {
    derivedFloor = 'critical';
    floorReason = 'Project policy critical areas undeclared; failing closed to full reference stages.';
  } else if (sourceFacts.criticalPaths.length > 0) {
    derivedFloor = 'critical';
    floorReason = `Touched paths match declared critical areas: ${sourceFacts.criticalPaths.join(', ')}.`;
  } else if (sourceFacts.publicContracts.length > 0) {
    derivedFloor = 'shared_contract';
    floorReason = `Public contracts or schemas modified: ${sourceFacts.publicContracts.join(', ')}.`;
  } else if (sourceFacts.fanOutExceeded) {
    derivedFloor = 'modular';
    floorReason = `Dependency fan-out (${sourceFacts.dependencyFanOut}) exceeds threshold.`;
  } else if (hasUncertainty) {
    derivedFloor = 'modular';
    floorReason = 'Material uncertainty, unverified verifiability or unresolved questions require full reference stages / discovery.';
  }

  // Analyst classification from axes
  let analystClassification = 'local';
  if (axes.failureImpact === 'critical' || axes.failureImpact === 'persistent_data' || axes.failureImpact === 'security_process') {
    analystClassification = 'critical';
  } else if (axes.scopeCoupling === 'cross_component' || axes.scopeCoupling === 'architectural') {
    analystClassification = 'shared_contract';
  } else if (axes.scopeCoupling === 'modular' || axes.technicalDifficulty === 'high' || hasUncertainty) {
    analystClassification = 'modular';
  }

  // Stricter wins
  const analystSeverity = CLASSIFICATION_SEVERITY[analystClassification] || 1;
  const floorSeverity = CLASSIFICATION_SEVERITY[derivedFloor] || 1;
  const winningClassification = floorSeverity >= analystSeverity ? derivedFloor : analystClassification;
  const winningReason = floorSeverity >= analystSeverity
    ? `Source-derived floor (${derivedFloor}: ${floorReason}) takes precedence over analyst assessment (${analystClassification}).`
    : `Analyst assessment (${analystClassification}) is stricter than derived floor (${derivedFloor}).`;

  // Explicit role bindings are strictly required - no invented defaults (R9)
  if (!roleBindings || Object.keys(roleBindings).length === 0) {
    throw new Error('Explicit role bindings required for all invoked roles. No automatic model or provider substitution allowed.');
  }

  const requiredRoles = ['analyst', 'developer', 'codeReviewer', 'testReviewer'];
  const independentAcceptance = projectPolicy.requireIndependentAcceptance === true
    || (projectPolicy.independentAcceptanceOnHighUncertainty === true && hasUncertainty)
    || (projectPolicy.independentAcceptanceOnHighConsequence === true && ['critical', 'persistent_data', 'security_process'].includes(axes.failureImpact))
    || assessment.grounds.disputedSemantics === true;
  if (independentAcceptance) requiredRoles.push('businessAccepter');
  for (const roleKey of requiredRoles) {
    if (!roleBindings[roleKey] || !roleBindings[roleKey].provider || !roleBindings[roleKey].model || !roleBindings[roleKey].effort) {
      throw new Error(`Missing explicit role binding for "${roleKey}". Explicit provider, model, and effort are required.`);
    }
  }

  // Reviewer separation: distinct roles required by serialized identity (R10)
  if (roleBindings.codeReviewer.role === roleBindings.testReviewer.role) {
    throw new Error(`Code reviewer and test reviewer must have distinct roles; observed identical role "${roleBindings.codeReviewer.role}".`);
  }

  // Select stages
  let selectedStages;
  const omittedStages = [];

  if (winningClassification === 'critical' || winningClassification === 'shared_contract' || winningClassification === 'modular') {
    selectedStages = [...REFERENCE_STAGES];
  } else {
    // Compact: omit readiness_review and prepare
    selectedStages = ['define', 'implement', 'assemble_and_check', 'delivery_review', 'accept_outcome'];
    const omitted = ['readiness_review', 'prepare'];
    for (const stage of omitted) {
      if (!reviewerConfirmation || !reviewerConfirmation.confirmed) {
        throw new Error(`Omitting reference stage "${stage}" requires explicit independent reviewer confirmation.`);
      }
      omittedStages.push({
        stage,
        reason: `Compact workflow selected for ${winningClassification} task.`,
        reviewerConfirmation: {
          confirmed: reviewerConfirmation.confirmed,
          confirmedBy: reviewerConfirmation.confirmedBy || 'code-reviewer',
          confirmedAt: reviewerConfirmation.confirmedAt || assessment.createdAt || '1970-01-01T00:00:00.000Z',
          reason: reviewerConfirmation.reason || 'Assessment scope confirmed as limited.',
        },
      });
    }
  }

  if (deliveryBoundary === 'verified_branch') {
    selectedStages.push('branch_delivery');
  }
  if (projectPolicy.requiresTests && !selectedStages.includes('prepare')) {
    selectedStages.splice(selectedStages.indexOf('implement'), 0, 'prepare');
    omittedStages.splice(omittedStages.findIndex(item => item.stage === 'prepare'), 1);
  }

  const bounds = {
    maxAttempts: aggregateBounds?.maxAttempts ?? 15,
    maxElapsedSeconds: aggregateBounds?.maxElapsedSeconds ?? 3600,
    consumedAttempts: 0,
    consumedElapsedSeconds: 0,
  };

  const planId = `PLAN-${canonicalHash({ assessmentId: assessment.assessmentId, winningClassification, selectedStages }).slice(0, 12)}`;
  const planRevisionId = `REV-${nowIso().replace(/[:.]/g, '-')}`;

  // Complete semantic plan fingerprint: covers assessment requirements, criteria, intended outcome, constraints, exclusions, stages, bindings, boundary and aggregate limits (R11 / F9)
  const planFingerprint = canonicalHash({
    policyVersion: POLICY_VERSION,
    selectorVersion: SELECTOR_VERSION,
    projectPolicy,
    checks,
    independentAcceptance,
    sourceSnapshotHash: assessment.sourceSnapshotHash,
    assessmentContent: {
      intendedOutcome: assessment.intendedOutcome,
      constraints: assessment.constraints || [],
      exclusions: assessment.exclusions || [],
      requirements: assessment.requirements,
      scope: assessment.scope,
      assessmentAxes: assessment.assessmentAxes,
      grounds: assessment.grounds,
    },
    winningClassification,
    selectedStages,
    omittedStages,
    roleBindings,
    deliveryBoundary,
    aggregateBounds: {
      maxAttempts: bounds.maxAttempts,
      maxElapsedSeconds: bounds.maxElapsedSeconds,
    },
  });

  const plan = {
    schemaVersion: 1,
    kind: 'ExecutionPlan',
    planId,
    planRevisionId,
    assessmentRunId: assessment.assessmentRunId,
    executionRunId: null,
    sourceSnapshotHash: assessment.sourceSnapshotHash,
    policyVersion: POLICY_VERSION,
    selectorVersion: SELECTOR_VERSION,
    independentAcceptance,
    classification: {
      analystClassification,
      derivedFloor,
      winningClassification,
      reason: winningReason,
    },
    selectedStages,
    omittedStages,
    roleBindings,
    contexts: {
      codeReviewerContext: `ctx-code-review-${planId}`,
      testReviewerContext: `ctx-test-review-${planId}`,
      acceptanceContext: `ctx-accept-${planId}`,
    },
    checks,
    deliveryBoundary,
    aggregateBounds: {
      maxAttempts: aggregateBounds.maxAttempts ?? 15,
      maxElapsedSeconds: aggregateBounds.maxElapsedSeconds ?? 3600,
      consumedAttempts: 0,
      consumedElapsedSeconds: 0,
    },
    candidateFloorCheck: {
      status: 'pending',
      evaluatedAt: null,
      exceededPaths: [],
      escalationRevisionId: null,
    },
    planFingerprint,
    createdAt: nowIso(),
  };

  const planIssues = check('execution-plan.schema.json', '', plan);
  if (planIssues.length) {
    throw new Error(`Generated invalid ExecutionPlan: ${planIssues.map(i => i.message).join('; ')}`);
  }

  return plan;
}

// Mandatory candidate-time floor check (assemble and check boundary).
// If candidate diff touches critical areas not accounted for in compact plan, trigger escalation.
export function evaluateCandidateFloors(plan, candidateDiffPaths = [], projectPolicy = {}) {
  const criticalAreaPatterns = projectPolicy.criticalAreas || DEFAULT_DESZO_CRITICAL_AREAS;
  const publicContractPatterns = projectPolicy.publicContracts || ['docs/schemas/*.json', 'src/types.ts'];

  const exceeded = [];
  for (const path of candidateDiffPaths) {
    const norm = path.replace(/\\/g, '/');
    if (criticalAreaPatterns.some(p => scopeMatches(norm, p)) || publicContractPatterns.some(p => scopeMatches(norm, p))) {
      exceeded.push(norm);
    }
  }

  const isCompact = !plan.selectedStages.includes('readiness_review') || !plan.selectedStages.includes('prepare');

  if (exceeded.length > 0 && (isCompact || plan.classification.winningClassification !== 'critical')) {
    // Escalation required
    const escalatedStages = [...REFERENCE_STAGES];
    if (plan.deliveryBoundary === 'verified_branch') escalatedStages.push('branch_delivery');

    const escalationRevisionId = `REV-ESCALATED-${nowIso().replace(/[:.]/g, '-')}`;
    const escalatedPlan = {
      ...plan,
      planRevisionId: escalationRevisionId,
      classification: {
        ...plan.classification,
        derivedFloor: 'critical',
        winningClassification: 'critical',
        reason: `Assembly-time floor check failed: candidate diff touches critical paths [${exceeded.join(', ')}]. Escalating compact plan to full reference workflow.`,
      },
      selectedStages: escalatedStages,
      omittedStages: [],
      candidateFloorCheck: {
        status: 'escalated',
        evaluatedAt: nowIso(),
        exceededPaths: exceeded.sort(),
        escalationRevisionId,
      },
      planFingerprint: canonicalHash({
        priorSemanticFingerprint: plan.planFingerprint,
        selectedStages: escalatedStages,
        winningClassification: 'critical',
        exceededPaths: [...exceeded].sort(),
      }),
    };

    return {
      status: 'escalated',
      exceededPaths: exceeded.sort(),
      escalationPlan: escalatedPlan,
    };
  }

  return {
    status: 'passed',
    evaluatedAt: nowIso(),
    exceededPaths: [],
    escalationPlan: null,
  };
}

// Charges preparation and execution attempts/time against aggregate bounds.
export function chargeAggregateBounds(plan, { attempts = 1, elapsedSeconds = 0 } = {}) {
  const nextAttempts = plan.aggregateBounds.consumedAttempts + attempts;
  const nextElapsed = plan.aggregateBounds.consumedElapsedSeconds + elapsedSeconds;

  const exceededAttempts = nextAttempts > plan.aggregateBounds.maxAttempts;
  const exceededTime = nextElapsed > plan.aggregateBounds.maxElapsedSeconds;

  const updatedBounds = {
    ...plan.aggregateBounds,
    consumedAttempts: nextAttempts,
    consumedElapsedSeconds: nextElapsed,
  };

  if (exceededAttempts || exceededTime) {
    return {
      exhausted: true,
      reason: exceededAttempts ? 'Aggregate attempts limit exhausted.' : 'Aggregate elapsed time limit exhausted.',
      bounds: updatedBounds,
    };
  }

  return {
    exhausted: false,
    reason: null,
    bounds: updatedBounds,
  };
}
