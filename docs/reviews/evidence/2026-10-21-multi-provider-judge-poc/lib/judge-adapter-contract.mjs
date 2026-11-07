// Provider-Independent Judge Adapter Logical Interface and Capability Contracts for ADR-0007.
// Defines the minimal logical operations, mandatory capability declarations, and billing policies.

export const BILLING_MODES = Object.freeze({
  SUBSCRIPTION: 'subscription',
  API: 'api',
  CREDITS: 'credits',
  UNKNOWN: 'unknown',
});

export const REQUESTED_BILLING_POLICY = Object.freeze({
  SUBSCRIPTION_ONLY: 'subscription_only',
});

export const EVIDENCE_CLASSIFICATIONS = Object.freeze({
  VERIFIED: 'VERIFIED',
  DOCUMENTED: 'DOCUMENTED',
  UNVERIFIED: 'UNVERIFIED',
  CONTRADICTED: 'CONTRADICTED',
});

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
});

/**
 * Base abstract contract for an external Judge controller adapter.
 * Each provider implementation translates its native mechanisms into these normalized milestones.
 */
export class JudgeAdapter {
  constructor({ provider, cliPath, clientVersion, config = {} }) {
    this.provider = provider;
    this.cliPath = cliPath;
    this.clientVersion = clientVersion;
    this.config = config;
  }

  /**
   * Mandatory capability declarations.
   * Must explicitly declare every capability, billing mode, session persistence,
   * tool support, concurrency, recovery, and known unsupported capabilities.
   */
  async inspectCapabilities() {
    throw new Error('inspectCapabilities must be implemented by the provider adapter');
  }

  /**
   * Validate authentication credentials without exposing secrets.
   */
  async validateAuthentication() {
    throw new Error('validateAuthentication must be implemented by the provider adapter');
  }

  /**
   * Verify the active billing mode against the requested policy (default: subscription_only).
   * Fail-closed if subscription eligibility cannot be confirmed or if API fallback is possible.
   */
  async verifyBillingMode(requestedPolicy = REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY) {
    throw new Error('verifyBillingMode must be implemented by the provider adapter');
  }

  /**
   * Register a new controller session.
   */
  async registerSession({ sessionId, cwd, tools = [] }) {
    throw new Error('registerSession must be implemented by the provider adapter');
  }

  /**
   * Resume an existing controller session by its stable identifier.
   */
  async resumeSession({ sessionId, cwd }) {
    throw new Error('resumeSession must be implemented by the provider adapter');
  }

  /**
   * Atomically admit a turn under single-writer ownership, checking owner generation and bounds.
   */
  async admitTurn({ sessionId, ownerGeneration, requestId, budgetReservation }) {
    throw new Error('admitTurn must be implemented by the provider adapter');
  }

  /**
   * Initiate a model turn in the registered session.
   */
  async startTurn({ sessionId, turnId, input, outputContract }) {
    throw new Error('startTurn must be implemented by the provider adapter');
  }

  /**
   * Observe turn progress, streaming events, and lifecycle milestones.
   */
  async observeTurn({ sessionId, turnId, onEvent }) {
    throw new Error('observeTurn must be implemented by the provider adapter');
  }

  /**
   * Submit or capture an authenticated Judge decision with stable correlation.
   */
  async submitDecision({ sessionId, requestId, decision }) {
    throw new Error('submitDecision must be implemented by the provider adapter');
  }

  /**
   * Interrupt an active turn within bounded timeout.
   */
  async interruptTurn({ sessionId, turnId }) {
    throw new Error('interruptTurn must be implemented by the provider adapter');
  }

  /**
   * Reconcile an uncertain turn start (e.g. lost acknowledgement after turn dispatch).
   */
  async reconcileUncertainTurn({ sessionId, requestId, turnId }) {
    throw new Error('reconcileUncertainTurn must be implemented by the provider adapter');
  }

  /**
   * Cleanly release the session resources and lock.
   */
  async releaseSession({ sessionId }) {
    throw new Error('releaseSession must be implemented by the provider adapter');
  }
}
