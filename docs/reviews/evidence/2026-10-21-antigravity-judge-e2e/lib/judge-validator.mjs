// Deszo Engine Validation Module for ADR-0007 Judge Decisions
// Enforces strict authorization, integrity, and admission bounds on Judge outputs.
// Ensures untrusted provider output is strictly validated before any state transition.

import { createHash } from 'node:crypto';

export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class EngineJudgeValidator {
  constructor() {
    this.appliedReceipts = new Map(); // requestId -> receipt
  }

  /**
   * Validates and applies an external Judge decision.
   * 
   * @param {Object} params
   * @param {Object} params.decision - The structured decision payload from the Judge
   * @param {Object} params.attentionRequest - The active durable attention request
   * @param {Object} params.registeredSession - The authorized Judge session registration
   * @param {Object} params.activeWorkflowRun - The active workflow run state
   * @returns {Object} { ok: boolean, code?: string, reason?: string, receipt?: Object, duplicate?: boolean }
   */
  validateAndApply({ decision, attentionRequest, registeredSession, activeWorkflowRun }) {
    if (!decision || typeof decision !== 'object') {
      return { ok: false, code: 'MALFORMED_DECISION_PAYLOAD', reason: 'Decision must be a valid JSON object.' };
    }

    // Check 1: Schema Version
    if (decision.schema_version !== 'deszo.judge.decision.v1') {
      return { ok: false, code: 'UNSUPPORTED_SCHEMA_VERSION', reason: `Expected deszo.judge.decision.v1, got ${decision.schema_version}` };
    }

    // Check 2: Request ID Binding
    if (!decision.request_id || decision.request_id !== attentionRequest.requestId) {
      return {
        ok: false,
        code: 'INVALID_REQUEST_ID',
        reason: `Decision request_id '${decision.request_id}' does not match attention request '${attentionRequest.requestId}'.`
      };
    }

    // Check 3: Controller ID Binding
    if (!decision.controller_id || decision.controller_id !== registeredSession.controllerId) {
      return {
        ok: false,
        code: 'INVALID_CONTROLLER_ID',
        reason: `Controller ID '${decision.controller_id}' does not match registered Judge '${registeredSession.controllerId}'.`
      };
    }

    // Check 4: Session ID Binding
    if (!decision.session_id || decision.session_id !== registeredSession.sessionId) {
      return {
        ok: false,
        code: 'INVALID_SESSION_ID',
        reason: `Session ID '${decision.session_id}' does not match registered active session '${registeredSession.sessionId}'.`
      };
    }

    // Check 5: Session Authorization Expiry
    if (registeredSession.expiresAt && Date.now() > registeredSession.expiresAt) {
      return {
        ok: false,
        code: 'SESSION_AUTHORIZATION_EXPIRED',
        reason: `Judge session authorization expired at ${new Date(registeredSession.expiresAt).toISOString()}.`
      };
    }

    // Check 6: Idempotency / Duplicate Delivery Check
    if (this.appliedReceipts.has(attentionRequest.requestId)) {
      const existingReceipt = this.appliedReceipts.get(attentionRequest.requestId);
      return {
        ok: true,
        code: 'DUPLICATE_DECISION_IGNORED',
        duplicate: true,
        applied: false,
        receipt: existingReceipt,
        reason: 'Decision was previously validated and applied. Returning existing authenticated receipt.'
      };
    }

    // Check 7: Workflow Revision Freshness (Stale revision check)
    if (typeof decision.workflow_revision !== 'number' || decision.workflow_revision !== activeWorkflowRun.currentRevision) {
      return {
        ok: false,
        code: 'STALE_WORKFLOW_REVISION',
        reason: `Decision revision ${decision.workflow_revision} does not match active workflow revision ${activeWorkflowRun.currentRevision}.`
      };
    }

    // Check 8: Evidence Digest Binding (Tamper protection)
    if (!decision.evidence_digest || decision.evidence_digest !== attentionRequest.evidenceDigest) {
      return {
        ok: false,
        code: 'EVIDENCE_DIGEST_MISMATCH',
        reason: `Decision evidence digest '${decision.evidence_digest}' does not match verified attention request digest '${attentionRequest.evidenceDigest}'.`
      };
    }

    // Check 9: Resource Adjustments / Budget Authority (Inviolable engine boundary)
    if (decision.resource_adjustments !== null && decision.resource_adjustments !== undefined) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_BUDGET_ADJUSTMENT',
        reason: 'Judge decision attempted to specify resource_adjustments. Only Engine may alter budgets.'
      };
    }

    // Check 10: Run State Admission (Decision delivered after application stop)
    if (activeWorkflowRun.status === 'STOPPED' || activeWorkflowRun.status === 'TERMINATED') {
      return {
        ok: false,
        code: 'DECISION_AFTER_STOP',
        reason: `Cannot apply decision to workflow run in ${activeWorkflowRun.status} state.`
      };
    }

    // Check 11: Valid Verdict Range
    const validVerdicts = new Set(['APPROVE', 'REVISE', 'REJECT', 'ABORT', 'NEED_MORE_EVIDENCE']);
    if (!validVerdicts.has(decision.verdict)) {
      return {
        ok: false,
        code: 'INVALID_VERDICT',
        reason: `Verdict '${decision.verdict}' is not a recognized verdict.`
      };
    }

    // All validations succeeded -> generate authenticated decision receipt
    const receipt = {
      receipt_id: `rcpt-judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      request_id: decision.request_id,
      controller_id: decision.controller_id,
      session_id: decision.session_id,
      workflow_run_id: activeWorkflowRun.runId,
      workflow_revision: decision.workflow_revision,
      verdict: decision.verdict,
      confidence: decision.confidence,
      evidence_digest: decision.evidence_digest,
      findings_count: Array.isArray(decision.findings) ? decision.findings.length : 0,
      validated_at: new Date().toISOString(),
      authorized_state_transition: this.mapVerdictToStateTransition(decision.verdict, activeWorkflowRun),
      decision_hash: canonicalHash(decision)
    };

    // Store in applied receipt ledger
    this.appliedReceipts.set(attentionRequest.requestId, receipt);

    return {
      ok: true,
      code: 'DECISION_VALIDATED_AND_APPLIED',
      duplicate: false,
      applied: true,
      receipt
    };
  }

  mapVerdictToStateTransition(verdict, activeWorkflowRun) {
    switch (verdict) {
      case 'APPROVE':
        return { from: activeWorkflowRun.status, to: 'COMPLETED', action: 'promote_to_release' };
      case 'REVISE':
        return { from: activeWorkflowRun.status, to: 'IN_REVISION', action: 'dispatch_to_developer' };
      case 'REJECT':
        return { from: activeWorkflowRun.status, to: 'REJECTED', action: 'terminate_with_rejection' };
      case 'ABORT':
        return { from: activeWorkflowRun.status, to: 'ABORTED', action: 'terminate_immediate' };
      case 'NEED_MORE_EVIDENCE':
        return { from: activeWorkflowRun.status, to: 'AWAITING_EVIDENCE', action: 'request_expanded_evidence' };
      default:
        return { from: activeWorkflowRun.status, to: 'UNKNOWN', action: 'none' };
    }
  }
}
