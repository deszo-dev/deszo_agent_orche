// P6 Successor Preparation (ADR-0010 Section 8, Contracts Section 8).
// Trusted Engine A prepares the successor baseline, running-source, verification-policy,
// and P5 profile artifacts from the exact accepted handoff using existing P5 schemas.
// The successor policy preserves root checks, bounds, and closures.
// The successor profile preserves Owner-installed workspace, scope, budgets, repository identity,
// and Parent/Repair publication refs; only source/release-bound baseline and policy-closure refs advance.

import { canonicalHash } from './canonical.mjs';
import { RUNTIME_API_VERSION } from '../host/runtimeRelease.mjs';
import { nextP5WorkspaceSlot, p5BaselineId, profileWorkspaceOf, validateP5Contract } from './protectedSelfRepair.mjs';

const asRef = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });

export class P6SuccessorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6SuccessorError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Prepares and persists successor P5 artifacts in the immutable Store prior to Host switch.
 * @param {Object} options
 * @param {Object} options.store Store instance
 * @param {Object} options.handoff Accepted ProtectedSelfRepairHandoff/1
 * @param {string} options.engineBuildId Target Engine B build ID
 * @param {string} options.shellBuildId Target Shell build ID
 * @param {string} options.candidateSourceDigest Verified candidate source digest
 * @param {string} options.buildInputDigest Trusted Host-compatible build-input closure digest
 * @param {string} [options.candidateCommit] Candidate Git commit SHA
 * @param {Object} [options.previousRelease] Previous running source release
 * @returns {Promise<{ successorProfileRef: Object, successorReleaseRef: Object, successorBaselineRef: Object, successorPolicyRef: Object, successorProfile: Object, successorRelease: Object }>}
 */
export async function prepareP6Successor({
  store,
  handoff,
  engineBuildId,
  operationId,
  shellBuildId,
  candidateSourceDigest,
  buildInputDigest = null,
  packageSha256 = null,
  candidateCommit = null,
  candidateTree = null,
  installedSourceDigest = null,
  previousRelease = null,
}) {
  if (!store || typeof store.putJson !== 'function') {
    throw new P6SuccessorError('p6_successor_no_store', 'Store is required to prepare successor artifacts.');
  }
  if (!handoff || handoff.kind !== 'ProtectedSelfRepairHandoff') {
    throw new P6SuccessorError('p6_successor_invalid_handoff', 'Accepted ProtectedSelfRepairHandoff is required.');
  }

  // Read root/current enrollment
  store.verifyRef(handoff.enrollment);
  const enrollment = store.readJson(handoff.enrollment.artifactId);
  validateP5Contract('enrollment', enrollment);
  // The successor's Repair slot is the pool entry after the one this release runs on: a function of the handoff's effective
  // enrollment alone, so a replayed build and a rebuild after later Repairs name the same slot. An exhausted pool is refused
  // before any Store artifact or Host staging is written.
  const slot = nextP5WorkspaceSlot(enrollment);
  if (!slot) throw new P6SuccessorError('p6_successor_workspace_exhausted',
    'The enrolled single-use P5 slot pool has no slot left for the successor; it is refused before any Host staging.');

  // Read root/current profile
  store.verifyRef(enrollment.profile);
  const predecessorProfile = store.readJson(enrollment.profile.artifactId);
  validateP5Contract('profile', predecessorProfile);

  // Read root/current verification policy
  store.verifyRef(enrollment.verificationPolicy);
  const rootVerificationPolicy = store.readJson(enrollment.verificationPolicy.artifactId);
  validateP5Contract('verificationPolicy', rootVerificationPolicy);
  if (!previousRelease || rootVerificationPolicy.harnessClosureDigest !== previousRelease.inputsDigest
    || enrollment.harnessClosureDigest !== previousRelease.inputsDigest) {
    throw new P6SuccessorError('p6_successor_root_policy_mismatch',
      'The root P5 verification closure must match the exact Host-attested predecessor inputs.');
  }

  // Read root/current baseline manifest
  store.verifyRef(predecessorProfile.baseline);
  const rootBaseline = store.readJson(predecessorProfile.baseline.artifactId);
  validateP5Contract('baselineManifest', rootBaseline);

  // These identities come from the P6 builder's Git-object verification and exact Host release query.
  const objectFormat = rootBaseline.gitObjectFormat || 'sha1';
  const objectLength = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(operationId || '')
    || !objectLength || !new RegExp(`^[a-f0-9]{${objectLength}}$`).test(candidateCommit || '')
    || !new RegExp(`^[a-f0-9]{${objectLength}}$`).test(candidateTree || '')
    || !/^[a-f0-9]{64}$/.test(packageSha256 || '') || !/^[a-f0-9]{64}$/.test(candidateSourceDigest || '')
    || !/^[a-f0-9]{64}$/.test(buildInputDigest || '')
    || !/^[a-f0-9]{64}$/.test(installedSourceDigest || '')
    || !previousRelease?.installationId || !/^[a-f0-9]{32}$/.test(previousRelease.installationId)) {
    throw new P6SuccessorError('p6_successor_release_identity_invalid', 'Verified Git, Host package and source inventory identities are required.');
  }
  const normCommit = candidateCommit;
  const normTree = candidateTree;
  const normInstallationId = previousRelease.installationId;

  // 1. Successor runningSourceRelease artifact
  const successorRelease = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairRunningSourceRelease',
    installationId: normInstallationId,
    buildId: engineBuildId,
    bootstrap: 'engine',
    committedOperationId: operationId,
    packageSha256,
    sourceCommit: normCommit,
    sourceDigest: installedSourceDigest,
    inputsDigest: buildInputDigest,
  };
  validateP5Contract('runningSourceRelease', successorRelease);
  const successorReleaseArtifact = store.putJson(successorRelease);
  store.verifyRef(asRef(successorReleaseArtifact));

  // 2. Successor baselineManifest artifact
  const baselineId = p5BaselineId({
    repositoryIdentity: enrollment.repositoryIdentity,
    gitObjectFormat: rootBaseline.gitObjectFormat || 'sha1',
    baseCommit: normCommit,
    baseTree: normTree,
    pathPolicyDigest: rootBaseline.pathPolicyDigest,
    effectiveSourceDigest: candidateSourceDigest,
  });
  const successorBaseline = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairBaselineManifest',
    enrollmentId: enrollment.enrollmentId,
    repositoryIdentity: enrollment.repositoryIdentity,
    repositoryRoot: rootBaseline.repositoryRoot,
    gitObjectFormat: rootBaseline.gitObjectFormat || 'sha1',
    baseCommit: normCommit,
    baseTree: normTree,
    pathPolicyDigest: rootBaseline.pathPolicyDigest,
    pathPolicy: rootBaseline.pathPolicy,
    effectiveSourceDigest: candidateSourceDigest,
    baselineId,
    sourceManifest: handoff.sourceManifest,
    runningSourceRelease: asRef(successorReleaseArtifact),
    excludedPaths: rootBaseline.excludedPaths || [],
    capturedAt: new Date().toISOString(),
  };
  validateP5Contract('baselineManifest', successorBaseline);
  const successorBaselineArtifact = store.putJson(successorBaseline);
  store.verifyRef(asRef(successorBaselineArtifact));

  // 3. Successor verificationPolicy preserves the Owner's checks and bounds while advancing only
  // the Host-attested P5 control/input closure to the exact candidate source installed as B.
  const successorPolicy = { ...rootVerificationPolicy, harnessClosureDigest: buildInputDigest };
  validateP5Contract('verificationPolicy', successorPolicy);
  const successorPolicyArtifact = asRef(store.putJson(successorPolicy));

  // 4. Successor profile artifact
  // Preserves all Owner policy, scope, budgets, repository identity, node IDs and publications; names the slot it selected.
  const successorProfile = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairProfile',
    enrollmentId: enrollment.enrollmentId,
    repositoryIdentity: enrollment.repositoryIdentity,
    baselineId,
    baseline: asRef(successorBaselineArtifact),
    runningSourceRelease: asRef(successorReleaseArtifact),
    repairPublication: predecessorProfile.repairPublication,
    developerNodeId: predecessorProfile.developerNodeId,
    verificationNodeId: predecessorProfile.verificationNodeId,
    repairJudgeNodeId: predecessorProfile.repairJudgeNodeId,
    workspace: profileWorkspaceOf(slot),
    scope: predecessorProfile.scope,
    verificationPolicy: successorPolicyArtifact,
    requiredCheckIds: predecessorProfile.requiredCheckIds,
    eligibleIncidents: predecessorProfile.eligibleIncidents,
    failedNodeRetry: predecessorProfile.failedNodeRetry,
    acceptanceMode: predecessorProfile.acceptanceMode,
    budgets: predecessorProfile.budgets,
  };
  validateP5Contract('profile', successorProfile);
  const successorProfileArtifact = store.putJson(successorProfile);
  store.verifyRef(asRef(successorProfileArtifact));

  return {
    successorProfileRef: asRef(successorProfileArtifact),
    successorReleaseRef: asRef(successorReleaseArtifact),
    successorBaselineRef: asRef(successorBaselineArtifact),
    successorPolicyRef: successorPolicyArtifact,
    successorProfile,
    successorRelease,
  };
}
