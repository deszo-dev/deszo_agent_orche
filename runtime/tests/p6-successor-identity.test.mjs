// The successor's verification policy and non-release profile fields are checked against the root's by two pure helpers of the P6
// continuation (security review S1 and S3 negative cases). The genuine E2E proves the accepting path; these tests prove that each
// field the root binds refuses a successor which changes it, without building a whole continuation chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { successorPolicyMatches, successorProfileFieldsMatch } from '../core/p6Continuation.mjs';

const ROOT_CLOSURE = 'a'.repeat(64);
const RELEASE_INPUTS = 'b'.repeat(64);
const SUCCESSOR_INPUTS = 'c'.repeat(64);

const rootPolicy = () => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
  requiredStages: ['regression', 'reproduce'], requiredCheckIds: ['incident-reproducer', 'authority-regression'], optionalCheckIds: [],
  harnessClosureDigest: ROOT_CLOSURE,
  checks: [{ checkId: 'incident-reproducer', stageId: 'reproduce', path: 'runtime/tests/reproducer.mjs' },
    { checkId: 'authority-regression', stageId: 'regression', path: 'runtime/tests/authority.mjs' }],
  mutationTiers: [{ tierId: 'engine-core', requiredCheckIds: ['incident-reproducer'] },
    { tierId: 'repair-authority', requiredCheckIds: ['incident-reproducer', 'authority-regression'] }],
  causalReproduction: { schemaVersion: 1, checkId: 'incident-reproducer', baselineMustPass: ['incident-captured'],
    baselineMustFail: ['incident-repaired'] } });

// The successor's policy: the same identity with the closure the installed release's inputs name.
const successorPolicy = () => ({ ...rootPolicy(), harnessClosureDigest: SUCCESSOR_INPUTS });
const rootEnrollment = () => ({ harnessClosureDigest: RELEASE_INPUTS });
const rootRelease = () => ({ inputsDigest: RELEASE_INPUTS });
const runningSourceRelease = () => ({ inputsDigest: SUCCESSOR_INPUTS });
const policyCheck = overrides => successorPolicyMatches({ rootPolicy: rootPolicy(), successorPolicy: { ...successorPolicy(), ...overrides },
  rootEnrollment: rootEnrollment(), rootRelease: rootRelease(), runningSourceRelease: runningSourceRelease() });

test('a successor policy that differs only in its harness closure, naming the installed inputs, matches the root', () => {
  assert.equal(policyCheck({}), true);
});

test('an unexpected change to the authority verification requirement refuses the successor policy', () => {
  assert.equal(policyCheck({ requiredCheckIds: ['incident-reproducer'] }), false, 'a dropped required check');
  assert.equal(policyCheck({ checks: [{ ...rootPolicy().checks[0] }, { ...rootPolicy().checks[1], path: 'runtime/tests/other.mjs' }] }),
    false, 'a substituted check path');
  assert.equal(policyCheck({ mutationTiers: [{ tierId: 'repair-authority', requiredCheckIds: ['incident-reproducer'] }] }), false,
    'a weakened mutation tier');
  assert.equal(policyCheck({ requiredStages: ['reproduce'] }), false, 'a dropped stage');
});

test('the causal reproduction requirement cannot be changed or dropped by the successor policy', () => {
  assert.equal(policyCheck({ causalReproduction: { ...rootPolicy().causalReproduction, baselineMustFail: [] } }), false);
  const { causalReproduction: _dropped, ...withoutCausal } = successorPolicy();
  assert.equal(successorPolicyMatches({ rootPolicy: rootPolicy(), successorPolicy: withoutCausal, rootEnrollment: rootEnrollment(),
    rootRelease: rootRelease(), runningSourceRelease: runningSourceRelease() }), false);
});

test('an unexpected extra field in the successor policy refuses it, however harmless it looks', () => {
  assert.equal(policyCheck({ allowRelaxedGate: true }), false);
});

test('a successor closure that names other inputs than the installed release refuses the successor policy', () => {
  assert.equal(policyCheck({ harnessClosureDigest: 'd'.repeat(64) }), false, 'the closure is not the installed inputs');
  assert.equal(successorPolicyMatches({ rootPolicy: rootPolicy(), successorPolicy: successorPolicy(), rootEnrollment: rootEnrollment(),
    rootRelease: rootRelease(), runningSourceRelease: { inputsDigest: 'e'.repeat(64) } }), false, 'the installed release has other inputs');
});

test('a root enrollment whose harness closure is not the root release inputs refuses the successor policy', () => {
  assert.equal(successorPolicyMatches({ rootPolicy: rootPolicy(), successorPolicy: successorPolicy(),
    rootEnrollment: { harnessClosureDigest: 'f'.repeat(64) }, rootRelease: rootRelease(), runningSourceRelease: runningSourceRelease() }), false);
});

// The non-release profile fields. The root profile is the enrolled one; the successor copies it, with its own workspace.
const rootProfile = () => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', developerNodeId: 'developer',
  verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge', eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'process' }],
  requiredCheckIds: ['incident-reproducer', 'authority-regression'], failedNodeRetry: 'never', acceptanceMode: 'judge_post_execution',
  repositoryIdentity: { enrollmentId: '11111111-1111-4111-8111-111111111111', canonicalCommonDirectory: 'C:\\repo\\.git' },
  budgets: { maxSourceFiles: 2000, maxSourceBytes: 67108864, developerTimeoutSeconds: 240 },
  scope: { add: ['runtime/**'], modify: ['runtime/**'], delete: ['runtime/**'], executable: [], denied: [], sensitiveCategories: [] },
  repairPublication: { workflowId: 'p5-genuine-repair', publishedVersionId: '22222222-2222-4222-8222-222222222222', version: 1 },
  workspace: { workspaceId: 'p5-slot-1', canonicalRoot: 'C:\\deszo\\slots\\slot-1' } });
const successorOf = overrides => ({ ...rootProfile(), workspace: { workspaceId: 'p5-slot-2', canonicalRoot: 'C:\\deszo\\slots\\slot-2' }, ...overrides });

test('a successor profile that carries every non-release root field unchanged, with its own workspace, matches the root', () => {
  assert.equal(successorProfileFieldsMatch(rootProfile(), successorOf({})), true);
});

test('a successor profile that changes any root-bound field is refused', () => {
  const changed = [
    ['the developer node', { developerNodeId: 'developer-2' }],
    ['the verification node', { verificationNodeId: 'verify-2' }],
    ['the repair judge node', { repairJudgeNodeId: 'judge-2' }],
    ['the eligible incidents', { eligibleIncidents: [{ category: 'other', canonicalCode: 'process' }] }],
    ['the required checks', { requiredCheckIds: ['incident-reproducer'] }],
    ['the repository identity', { repositoryIdentity: { ...rootProfile().repositoryIdentity, enrollmentId: '33333333-3333-4333-8333-333333333333' } }],
    ['the budgets', { budgets: { ...rootProfile().budgets, maxSourceFiles: 2001 } }],
    ['the owner scope', { scope: { ...rootProfile().scope, add: ['**'] } }],
    ['the repair publication', { repairPublication: { ...rootProfile().repairPublication, publishedVersionId: '44444444-4444-4444-8444-444444444444' } }],
    ['the failed-node retry', { failedNodeRetry: 'once' }],
    ['the acceptance mode', { acceptanceMode: 'expected_digest' }],
  ];
  for (const [label, overrides] of changed)
    assert.equal(successorProfileFieldsMatch(rootProfile(), successorOf(overrides)), false, `${label} is root-bound`);
});
