import { canonicalize } from './canonical.mjs';
import { createHash } from 'node:crypto';
import { nowIso } from './store.mjs';

// Keep this list aligned with the strict attempt.error code enum in journal-event-v2.schema.json.
export const ATTEMPT_ERROR_CODES = new Set([
  'authentication', 'quota', 'billing_policy', 'provider_unavailable', 'rate_limited', 'provider_protocol',
  'unsupported_cli', 'custody_unavailable', 'permission', 'timeout', 'process', 'output_contract',
  'context_unavailable', 'corruption', 'interrupted', 'input_unavailable', 'route_unmatched',
  'context_prerequisite', 'capture_failed', 'managed_tool_isolation_unavailable', 'capture_limit',
  'lifecycle_unauthorized', 'lifecycle_contract', 'lifecycle_candidate_mismatch', 'lifecycle_checkpoint_mismatch',
  'workspace_overlap', 'workspace_unavailable', 'workspace_binding_mismatch', 'custody_unresolved',
]);

const PROVIDER_CODES = new Set(['authentication', 'quota', 'billing_policy', 'provider_unavailable', 'rate_limited', 'provider_protocol', 'unsupported_cli', 'permission']);
const WORKFLOW_CODES = new Set(['output_contract', 'input_unavailable', 'route_unmatched', 'context_prerequisite',
  'lifecycle_unauthorized', 'lifecycle_contract', 'lifecycle_candidate_mismatch', 'lifecycle_checkpoint_mismatch']);
const HOST_CODES = new Set(['custody_unavailable', 'custody_unresolved']);
const RAW_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export function deterministicOutcomeId(scopeId, discriminator) {
  const hex = createHash('sha256').update(`deszo:failure-outcome:${scopeId}:${discriminator}`, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function safeRawCode(value) {
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return RAW_CODE.test(code) ? code : undefined;
}

export function sourceForErrorCode(code) {
  if (PROVIDER_CODES.has(code)) return 'provider';
  if (WORKFLOW_CODES.has(code)) return 'workflow';
  if (HOST_CODES.has(code) || code === 'lifecycle_host_unavailable') return 'host';
  if (code === 'interrupted') return 'recovery';
  return 'engine';
}

// Map external codes using their operation and source. In particular, ENOENT is only a
// provider-unavailable signal when the provider executable could not be spawned.
export function normalizeAttemptErrorCode(rawCode, { source = 'engine', operation = 'execution' } = {}) {
  const raw = typeof rawCode === 'string' ? rawCode : '';
  if (ATTEMPT_ERROR_CODES.has(raw)) return { canonicalCode: raw, rawCode: safeRawCode(raw) === raw ? undefined : safeRawCode(raw) };
  let canonicalCode = 'process';
  if (source === 'provider' && operation === 'provider_launch') canonicalCode = 'provider_unavailable';
  else if (source === 'host' && /^(custody_unreachable|custody_not_launched|custody_admission_lost|host_refused|host_unavailable|lifecycle_host_unavailable)$/i.test(raw)) canonicalCode = 'custody_unavailable';
  else if (source === 'workflow') canonicalCode = 'output_contract';
  else if (source === 'recovery' || source === 'external_control') canonicalCode = 'interrupted';
  return { canonicalCode, rawCode: safeRawCode(raw) };
}

function categoryFor(source, code, executionCertainty) {
  if (source === 'external_control') return 'control_outcome';
  if (executionCertainty === 'unresolved') return 'execution_uncertain';
  if (source === 'workflow' && code === 'interrupted') return 'control_outcome';
  if (source === 'recovery' && code === 'interrupted') return executionCertainty === 'not_started' ? 'control_outcome' : 'execution_uncertain';
  // Provenance wins over a compatibility code: a Host launch refusal may retain
  // the journal's provider_unavailable code without becoming a provider failure.
  if (source === 'host' || source === 'engine' || source === 'recovery') return 'orchestrator_failure';
  if (source === 'workflow' || WORKFLOW_CODES.has(code)) return 'task_failure';
  if (source === 'provider' || PROVIDER_CODES.has(code)) return 'provider_failure';
  return 'execution_uncertain';
}

function summaryFor(category, code, source, observedState = {}) {
  if (source === 'host' && code === 'provider_unavailable') return 'The Lifecycle Host refused to start the requested provider invocation.';
  if (code === 'authentication') return 'The provider rejected authentication or authorization.';
  if (code === 'quota' || code === 'rate_limited' || code === 'billing_policy') return 'The provider could not accept the requested operation under its current access or usage limits.';
  if (code === 'provider_unavailable' || code === 'unsupported_cli') return 'The requested provider executable or service was unavailable.';
  if (code === 'provider_protocol') return 'The provider response did not follow the expected event protocol.';
  if (code === 'output_contract') return 'The produced result did not satisfy the workflow output contract.';
  if (code === 'timeout') return 'The execution deadline ended before an accepted result was recorded.';
  if (code === 'capture_failed' || code === 'capture_limit') return 'The runtime could not preserve complete execution output.';
  if (code === 'custody_unresolved' && category === 'execution_uncertain') {
    if (observedState.hostState === 'unavailable') return 'The Lifecycle Host is unavailable; process completion remains unproven.';
    if (observedState.hostState === 'refused') return 'The Lifecycle Host refused a custody command; process completion remains unproven.';
    return 'The Lifecycle Host has not provided terminal process proof; completion remains unproven.';
  }
  if (code === 'custody_unresolved') return 'The Lifecycle Host returned additional evidence for this execution.';
  if (category === 'execution_uncertain') return 'The available evidence does not prove whether execution or its side effects completed.';
  if (code === 'lifecycle_candidate_mismatch') return 'The Repair result did not match the authorized expected digest.';
  if (category === 'control_outcome') return 'Execution ended through an explicit lifecycle control transition.';
  if (category === 'task_failure') return 'The workflow task did not satisfy its execution contract.';
  if (category === 'provider_failure') return 'The provider did not complete the requested operation.';
  return 'The Engine or Lifecycle Host recorded an operational failure.';
}

export function makeFailureOutcome({ run, attempt = null, outcomeId, source, code, rawCode, attemptState, runState, observedState = {},
  executionCertainty = 'unknown', sideEffectCertainty, causeKnowledge = 'deterministic_interpretation',
  evidenceReferences = [], recordedAt = nowIso(), updatedAt } = {}) {
  const resolvedSource = source || sourceForErrorCode(code);
  const normalized = normalizeAttemptErrorCode(code, { source: resolvedSource });
  const stableOutcomeId = outcomeId || attempt?.id;
  if (!stableOutcomeId) throw new TypeError('Run-scoped failure outcomes require a stable outcomeId.');
  const canonicalCode = normalized.canonicalCode;
  const certainty = ['not_started', 'completed', 'unresolved', 'unknown'].includes(executionCertainty) ? executionCertainty : 'unknown';
  const result = {
    schemaVersion: 1,
    outcomeId: stableOutcomeId,
    revision: 1,
    runId: run.id,
    ...(attempt?.id ? { attemptId: attempt.id } : {}),
    ...(attempt?.node_instance_id ? { nodeInstanceId: attempt.node_instance_id } : {}),
    source: resolvedSource,
    category: categoryFor(resolvedSource, canonicalCode, certainty),
    canonicalCode,
    observedState: {
      ...(attemptState || attempt?.state ? { attemptState: attemptState || attempt.state } : {}),
      ...(runState ? { runState } : {}),
      ...observedState,
    },
    causeKnowledge: ['direct_fact', 'deterministic_interpretation', 'unknown'].includes(causeKnowledge) ? causeKnowledge : 'unknown',
    executionCertainty: certainty,
    sideEffectCertainty: sideEffectCertainty || (certainty === 'not_started' ? 'none_proven' : 'unknown'),
    message: summaryFor(categoryFor(resolvedSource, canonicalCode, certainty), canonicalCode, resolvedSource, observedState),
    evidenceReferences: dedupeReferences(evidenceReferences),
    recordedAt,
    ...(updatedAt ? { updatedAt } : {}),
  };
  const safeCode = safeRawCode(rawCode ?? normalized.rawCode);
  if (safeCode) result.rawCode = safeCode;

  const optionalIds = {
    workspaceId: run.workspace_id,
    custodyInvocationId: run.custody_invocation_id || attempt?.custody_invocation_id,
    publishedVersionId: run.published_version_id,
    incidentId: run.incident_id,
    parentRunId: run.parent_run_id,
    repairRunId: run.repair_run_id,
  };
  for (const [key, value] of Object.entries(optionalIds)) if (typeof value === 'string') result[key] = value;
  return result;
}

export function dedupeReferences(references = []) {
  const byKey = new Map();
  for (const item of references) {
    if (!item || typeof item.type !== 'string' || typeof item.id !== 'string') continue;
    const ref = { type: item.type, id: item.id, ...(typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {}) };
    byKey.set(`${ref.type}:${ref.id}`, ref);
  }
  return [...byKey.values()];
}

export function sameOutcome(left, right) {
  const comparable = value => {
    const { revision, updatedAt, ...stable } = value;
    return canonicalize(stable);
  };
  return comparable(left) === comparable(right);
}

