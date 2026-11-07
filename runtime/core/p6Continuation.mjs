// P6 P5 Enrollment Continuation Reader (ADR-0010 Section 8, Contracts Section 8).
// The installed profile remains the immutable root enrollment. An Engine update is admitted only
// when Store lineage and the Lifecycle Host's durable switch status identify the same operation.

import { canonicalHash } from './canonical.mjs';
import { nextP5WorkspaceSlot, poolEntryForProfileWorkspace, validateP5Contract } from './protectedSelfRepair.mjs';
import { verifyP6SourceGitProvenance } from './p6Reconstruction.mjs';

const continuationRequestId = operationId => `p6-continuation-${operationId}`;
const commandRequestId = (kind, identity) => `p6-${kind}-${identity}`;
const same = (left, right) => canonicalHash(left) === canonicalHash(right);

function validateContinuationReceipt(value) {
  try { validateP5Contract('p6ContinuationReceipt', value); }
  catch (error) {
    if (Array.isArray(error.details) && error.details.length)
      error.message = `${error.message}: ${JSON.stringify(error.details)}`;
    throw error;
  }
}

function p6BuildInputDigest(receipt) {
  const closure = receipt?.buildInputClosure;
  if (!closure) return null;
  const hostInputsDigest = canonicalHash({ sourceCommit: receipt.sourceCommit, sourceDigest: closure.sourceInventoryDigest,
    authorityClosureDigest: closure.authorityClosureDigest, dependencyDigest: closure.dependencyDigest, gitTool: closure.gitTool });
  if (hostInputsDigest !== closure.hostInputsDigest || !same(closure.builderIdentity, receipt.builderIdentity)) return null;
  return canonicalHash({ hostInputsDigest, builderIdentity: closure.builderIdentity });
}

export class P6ContinuationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6ContinuationError';
    this.code = code;
    this.details = details;
  }
}

function readCommandArtifact(store, requestId, command) {
  const row = store.get('SELECT command, payload_sha256, response_artifact_id FROM command_receipts WHERE request_id = ?', requestId);
  if (!row) return null;
  if (row.command !== command) throw new P6ContinuationError('p6_continuation_command_mismatch', `Receipt ${requestId} has an unexpected command.`);
  const artifact = store.artifactRow(row.response_artifact_id);
  if (!artifact?.sha256) throw new P6ContinuationError('p6_continuation_artifact_missing', `Receipt ${requestId} references a missing artifact.`);
  const ref = { artifactId: row.response_artifact_id, sha256: artifact.sha256 };
  store.verifyRef(ref);
  return { row, ref, value: store.readJson(ref.artifactId) };
}

/** Returns the unique immutable P6 build receipt claiming the current Host package. */
export function findP6BuildReceiptForRelease(store, runningSourceRelease) {
  const targetBuildId = runningSourceRelease?.buildId;
  const targetPackageSha256 = runningSourceRelease?.packageSha256;
  if (!targetBuildId || !/^[a-f0-9]{64}$/.test(targetPackageSha256 || '')) return null;

  const rows = store.all(
    `SELECT request_id, command, payload_sha256, response_artifact_id FROM command_receipts
     WHERE command = 'p6.build' AND payload_sha256 = ? ORDER BY created_at`, targetPackageSha256
  );
  const matches = [];
  for (const row of rows) {
    try {
      const artifact = store.artifactRow(row.response_artifact_id);
      if (!artifact?.sha256) throw new Error('missing build receipt artifact');
      const receiptRef = { artifactId: row.response_artifact_id, sha256: artifact.sha256 };
      store.verifyRef(receiptRef);
      const receipt = store.readJson(receiptRef.artifactId);
      validateP5Contract('p6BuildReceipt', receipt);
      if (receipt.engineBuildId === targetBuildId && receipt.packageSha256 === targetPackageSha256) {
        if (row.payload_sha256 !== receipt.packageSha256) throw new Error('build command digest differs from receipt');
        matches.push({ receipt, receiptRef, row });
      }
    } catch (error) {
      throw new P6ContinuationError('p6_continuation_build_receipt_invalid',
        `A P6 build receipt claiming the active package is invalid: ${error.message}`);
    }
  }
  if (matches.length > 1) throw new P6ContinuationError('p6_continuation_receipt_ambiguous', 'More than one P6 build receipt claims the current Host release.');
  return matches[0] ?? null;
}

function assertBuildAndHostIdentity({ store, build, rootEnrollment, runningSourceRelease, hostSwitchStatus, installationId, visited = new Set() }) {
  const { receipt, receiptRef, row: buildRow } = build;
  if (visited.has(receipt.operationId)) throw new P6ContinuationError('p6_continuation_chain_cycle', 'The P6 continuation chain contains an operation cycle.');
  visited.add(receipt.operationId);
  if (!hostSwitchStatus || hostSwitchStatus.operationId !== receipt.operationId
    || !['committed', 'verified'].includes(hostSwitchStatus.phase)
    || hostSwitchStatus.fromEngineBuildId !== receipt.previousRelease.buildId
    || hostSwitchStatus.toEngineBuildId !== receipt.engineBuildId
    || hostSwitchStatus.shellBuildId !== receipt.shellBuildId
    || hostSwitchStatus.packageSha256 !== receipt.packageSha256
    || runningSourceRelease.committedOperationId !== receipt.operationId
    || runningSourceRelease.installationId !== installationId
    || runningSourceRelease.bootstrap !== 'engine'
    || runningSourceRelease.buildId !== receipt.engineBuildId
    || runningSourceRelease.packageSha256 !== receipt.packageSha256
    || runningSourceRelease.sourceCommit !== receipt.sourceCommit
    || runningSourceRelease.sourceDigest !== receipt.installedSourceDigest
    || runningSourceRelease.inputsDigest !== receipt.buildInputDigest
    || receipt.buildInputClosure?.sourceInventoryDigest !== receipt.installedSourceDigest
    || p6BuildInputDigest(receipt) !== receipt.buildInputDigest) {
    throw new P6ContinuationError('p6_continuation_host_status_mismatch',
      'The active Host release and durable switch status do not identify the same committed P6 package.');
  }
  if (buildRow.payload_sha256 !== receipt.packageSha256) {
    throw new P6ContinuationError('p6_continuation_build_digest_mismatch', 'The P6 build command is not bound to its package digest.');
  }

  for (const ref of [receipt.operationIntent, receipt.handoff, receipt.candidate, receipt.gitCandidate, receipt.successorP5Profile]) store.verifyRef(ref);
  const handoff = store.readJson(receipt.handoff.artifactId);
  validateP5Contract('handoff', handoff);
  if (handoff.handoffId !== receipt.handoffId
    || !same(handoff.candidate, receipt.candidate) || !same(handoff.gitCandidate, receipt.gitCandidate)
    || handoff.candidateSourceDigest !== receipt.candidateSourceDigest) {
    throw new P6ContinuationError('p6_continuation_handoff_mismatch', 'The P6 build receipt does not bind its exact accepted P5 handoff and candidate refs.');
  }
  const provenance = verifyP6SourceGitProvenance({ store, handoff, handoffRef: receipt.handoff });
  if (provenance.sourceCommit !== receipt.sourceCommit || provenance.sourceTree !== receipt.sourceTree
    || provenance.candidateSourceDigest !== receipt.candidateSourceDigest
    || provenance.sourceDigest !== receipt.installedSourceDigest) {
    throw new P6ContinuationError('p6_continuation_source_mismatch', 'The P6 build receipt does not match recomputed accepted Git and source identities.');
  }

  const operationRecord = readCommandArtifact(store, commandRequestId('operation', handoff.handoffId), 'p6.operation');
  if (!operationRecord) throw new P6ContinuationError('p6_continuation_operation_missing', 'The durable P6 operation intent is missing.');
  validateP5Contract('p6Operation', operationRecord.value);
  const operation = operationRecord.value;
  if (operationRecord.row.payload_sha256 !== canonicalHash(operation) || operation.operationId !== receipt.operationId
    || !same(operationRecord.ref, receipt.operationIntent) || !same(operation.handoff, receipt.handoff)
    || !same(operation.candidate, receipt.candidate) || !same(operation.gitCandidate, receipt.gitCandidate)
    || operation.handoffId !== receipt.handoffId || operation.candidateId !== handoff.candidateId
    || operation.candidateSourceDigest !== receipt.candidateSourceDigest || !same(operation.previousRelease, receipt.previousRelease)
    || operation.engineBuildId !== receipt.engineBuildId || operation.shellBuildId !== receipt.shellBuildId
    || !same(operation.enrollmentRoot, handoff.enrollment)) {
    throw new P6ContinuationError('p6_continuation_operation_mismatch', 'The P6 operation intent differs from its build receipt or accepted handoff.');
  }

  const stageRecord = readCommandArtifact(store, commandRequestId('stage', receipt.operationId), 'p6.stage');
  if (!stageRecord) throw new P6ContinuationError('p6_continuation_stage_missing', 'The durable Host stage receipt is missing.');
  validateP5Contract('p6StageReceipt', stageRecord.value);
  const stage = stageRecord.value;
  if (stageRecord.row.payload_sha256 !== receipt.packageSha256 || stage.operationId !== receipt.operationId
    || stage.fromEngineBuildId !== receipt.previousRelease.buildId || stage.toEngineBuildId !== receipt.engineBuildId
    || stage.shellBuildId !== receipt.shellBuildId || stage.packageSha256 !== receipt.packageSha256 || stage.phase !== 'staged') {
    throw new P6ContinuationError('p6_continuation_stage_mismatch', 'The durable Host stage receipt differs from the exact P6 build operation.');
  }

  const admissionRecord = readCommandArtifact(store, commandRequestId('switch-admitted', receipt.operationId), 'p6.switch_admitted');
  if (!admissionRecord) throw new P6ContinuationError('p6_continuation_admission_missing', 'The durable P6 switch admission is missing.');
  validateP5Contract('p6SwitchAdmission', admissionRecord.value);
  const admission = admissionRecord.value;
  const expectedAdmission = {
    operationId: receipt.operationId, operationIntent: receipt.operationIntent, handoff: receipt.handoff,
    buildReceipt: receiptRef, stageReceipt: stageRecord.ref, candidate: receipt.candidate, gitCandidate: receipt.gitCandidate,
    previousRelease: receipt.previousRelease, engineBuildId: receipt.engineBuildId, shellBuildId: receipt.shellBuildId,
    generation: operation.generation, packageSha256: receipt.packageSha256,
  };
  const { schemaVersion: _version, kind: _kind, admittedAt: _admittedAt, ...admissionIdentity } = admission;
  if (admissionRecord.row.payload_sha256 !== receipt.packageSha256 || !same(admissionIdentity, expectedAdmission)) {
    throw new P6ContinuationError('p6_continuation_admission_mismatch', 'The durable P6 switch admission differs from the exact operation and package.');
  }

  store.verifyRef(rootEnrollment.runningSourceRelease);
  const rootRelease = store.readJson(rootEnrollment.runningSourceRelease.artifactId);
  const predecessorEnrollmentRef = handoff.enrollment;
  store.verifyRef(predecessorEnrollmentRef);
  const predecessorEnrollment = store.readJson(predecessorEnrollmentRef.artifactId);
  validateP5Contract('enrollment', predecessorEnrollment);
  const enrolledGitTools = (predecessorEnrollment.toolIdentities || []).filter(item => item.name === 'git');
  if (enrolledGitTools.length !== 1
    || !same(receipt.buildInputClosure.gitTool, { path: enrolledGitTools[0].path, sha256: enrolledGitTools[0].sha256 })) {
    throw new P6ContinuationError('p6_continuation_tool_identity_mismatch',
      'The build-input closure does not use the Git tool identity from the exact predecessor enrollment.');
  }
  store.verifyRef(predecessorEnrollment.runningSourceRelease);
  const predecessorRelease = store.readJson(predecessorEnrollment.runningSourceRelease.artifactId);
  if (!same(predecessorRelease, receipt.previousRelease)) {
    throw new P6ContinuationError('p6_continuation_predecessor_mismatch', 'The accepted handoff was not enrolled against the exact P6 predecessor release.');
  }

  // Every later hop must descend from an earlier continuation receipt; a forged or forked predecessor fails closed.
  if (!same(receipt.previousRelease, rootRelease)) {
    const previousBuild = findP6BuildReceiptForRelease(store, receipt.previousRelease);
    if (!previousBuild) throw new P6ContinuationError('p6_continuation_chain_missing', 'The P6 predecessor has no prior build receipt.');
    const priorContinuation = readCommandArtifact(store, continuationRequestId(previousBuild.receipt.operationId), 'p6.continuation');
    if (!priorContinuation) throw new P6ContinuationError('p6_continuation_chain_missing', 'The P6 predecessor has no durable continuation receipt.');
    validateContinuationReceipt(priorContinuation.value);
    const prior = priorContinuation.value;
    if (priorContinuation.row.payload_sha256 !== previousBuild.receipt.packageSha256
      || prior.operationId !== previousBuild.receipt.operationId
      || !same(prior.buildReceipt, previousBuild.receiptRef)
      || !same(prior.successorRelease, predecessorEnrollment.runningSourceRelease)
      || !same(prior.observedRunningSourceRelease, receipt.previousRelease)) {
      throw new P6ContinuationError('p6_continuation_chain_mismatch', 'The P6 predecessor is not backed by its exact prior continuation record.');
    }
    assertBuildAndHostIdentity({ store, build: previousBuild, rootEnrollment,
      runningSourceRelease: receipt.previousRelease, hostSwitchStatus: prior.hostSwitchStatus,
      installationId, visited });
  }

  return { handoff, operationRecord, stageRecord, admissionRecord, predecessorEnrollment };
}

export function p6ContinuationReplayMatches(existingIdentity, observedIdentity) {
  const { hostSwitchStatus: existingHost, ...existingFields } = existingIdentity ?? {};
  const { hostSwitchStatus: observedHost, ...observedFields } = observedIdentity ?? {};
  if (!existingHost || !observedHost || !same(existingFields, observedFields)) return false;
  const { phase: existingPhase, ...existingHostFields } = existingHost;
  const { phase: observedPhase, ...observedHostFields } = observedHost;
  const phaseMatches = existingPhase === observedPhase
    || existingPhase === 'committed' && observedPhase === 'verified';
  return phaseMatches && same(existingHostFields, observedHostFields);
}

/** A durable receipt ignores its timestamp and allows only the Host's monotone committed→verified phase advance. */
export function p6ContinuationReceiptReplayMatches(recordedReceipt, observedIdentity) {
  if (!recordedReceipt || typeof recordedReceipt !== 'object') return false;
  const { recordedAt: _recordedAt, ...recordedIdentity } = recordedReceipt;
  return p6ContinuationReplayMatches(recordedIdentity, observedIdentity);
}

function readOrCreateContinuationReceipt({ store, build, successorReleaseRef, runningSourceRelease, hostSwitchStatus, verifiedRefs }) {
  const requestId = continuationRequestId(build.receipt.operationId);
  const existing = readCommandArtifact(store, requestId, 'p6.continuation');
  const statusEvidence = {
    operationId: hostSwitchStatus.operationId, phase: hostSwitchStatus.phase,
    fromEngineBuildId: hostSwitchStatus.fromEngineBuildId, toEngineBuildId: hostSwitchStatus.toEngineBuildId,
    shellBuildId: hostSwitchStatus.shellBuildId, packageSha256: hostSwitchStatus.packageSha256,
  };
  const identity = {
    schemaVersion: 1, kind: 'P6ContinuationReceipt', operationId: build.receipt.operationId,
    buildReceipt: build.receiptRef, operationIntent: build.receipt.operationIntent,
    stageReceipt: verifiedRefs.stageRecord.ref, switchAdmission: verifiedRefs.admissionRecord.ref,
    handoff: build.receipt.handoff, candidate: build.receipt.candidate, gitCandidate: build.receipt.gitCandidate,
    previousRelease: build.receipt.previousRelease, successorRelease: successorReleaseRef,
    successorProfile: build.receipt.successorP5Profile, packageSha256: build.receipt.packageSha256,
    hostSwitchStatus: statusEvidence, observedRunningSourceRelease: runningSourceRelease,
  };
  if (existing) {
    validateContinuationReceipt(existing.value);
    if (existing.row.payload_sha256 !== build.receipt.packageSha256 || !p6ContinuationReceiptReplayMatches(existing.value, identity)) {
      throw new P6ContinuationError('p6_continuation_replay_mismatch', 'The durable P6 continuation record has different operation, Host or profile identity.');
    }
    return existing;
  }
  const value = { ...identity, recordedAt: new Date().toISOString() };
  validateContinuationReceipt(value);
  const artifact = store.putJson(value);
  const ref = { artifactId: artifact.artifactId, sha256: artifact.sha256 };
  store.transaction(() => {
    const current = readCommandArtifact(store, requestId, 'p6.continuation');
    if (current) {
      validateContinuationReceipt(current.value);
      if (current.row.payload_sha256 !== build.receipt.packageSha256 || !p6ContinuationReceiptReplayMatches(current.value, identity))
        throw new P6ContinuationError('p6_continuation_replay_mismatch', 'A different P6 continuation record already owns this operation.');
      return;
    }
    store.run(`INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?)`, requestId, 'p6.continuation', build.receipt.packageSha256, ref.artifactId, value.recordedAt);
  });
  const saved = readCommandArtifact(store, requestId, 'p6.continuation');
  if (!saved || saved.row.payload_sha256 !== build.receipt.packageSha256
    || !p6ContinuationReceiptReplayMatches(saved.value, identity)) {
    throw new P6ContinuationError('p6_continuation_persist_failed', 'The P6 continuation receipt was not durably recorded.');
  }
  return saved;
}

/** Resolves the effective P5 enrollment only after Host and Store agree on a committed update. */
// The verification policy a successor may differ from the root's in one way only: the harness closure, which must name the installed
// release's inputs. Every other field of the policy is identical, so the authority checks, tiers and causal requirement stay the root's.
export function successorPolicyMatches({ rootPolicy, successorPolicy, rootEnrollment, rootRelease, runningSourceRelease }) {
  const { harnessClosureDigest: _rootClosure, ...rootPolicyIdentity } = rootPolicy;
  const { harnessClosureDigest: successorClosure, ...successorPolicyIdentity } = successorPolicy;
  return same(rootPolicyIdentity, successorPolicyIdentity)
    && rootEnrollment.harnessClosureDigest === rootRelease.inputsDigest
    && successorClosure === runningSourceRelease.inputsDigest;
}

// The root's fields a successor profile carries unchanged: the nodes, the eligible incidents and checks, the repository, budgets, scope,
// the Repair publication, the retry and acceptance policy. The successor's workspace and policy are checked by their own rules.
export function successorProfileFieldsMatch(rootProfile, successorProfile) {
  return successorProfile.developerNodeId === rootProfile.developerNodeId
    && successorProfile.verificationNodeId === rootProfile.verificationNodeId
    && successorProfile.repairJudgeNodeId === rootProfile.repairJudgeNodeId
    && same(successorProfile.eligibleIncidents, rootProfile.eligibleIncidents)
    && same(successorProfile.requiredCheckIds, rootProfile.requiredCheckIds)
    && same(successorProfile.repositoryIdentity, rootProfile.repositoryIdentity)
    && same(successorProfile.budgets, rootProfile.budgets)
    && same(successorProfile.scope, rootProfile.scope)
    && same(successorProfile.repairPublication, rootProfile.repairPublication)
    && successorProfile.failedNodeRetry === rootProfile.failedNodeRetry
    && successorProfile.acceptanceMode === rootProfile.acceptanceMode;
}

export function resolveP6Continuation({ store, rootEnrollment, runningSourceRelease, installationId, hostSwitchStatus }) {
  if (!store || !rootEnrollment || !runningSourceRelease) return null;

  store.verifyRef(rootEnrollment.runningSourceRelease);
  const rootRelease = store.readJson(rootEnrollment.runningSourceRelease.artifactId);
  if (same(rootRelease, runningSourceRelease)) return { rootEnrollment, effectiveEnrollment: rootEnrollment, buildReceipt: null };

  const build = findP6BuildReceiptForRelease(store, runningSourceRelease);
  if (!build) return null;
  validateP5Contract('p6BuildReceipt', build.receipt);
  const verifiedRefs = assertBuildAndHostIdentity({ store, build, rootEnrollment, runningSourceRelease,
    hostSwitchStatus, installationId });

  const receipt = build.receipt;
  store.verifyRef(rootEnrollment.profile);
  const rootProfile = store.readJson(rootEnrollment.profile.artifactId);
  store.verifyRef(rootEnrollment.verificationPolicy);
  const rootPolicy = store.readJson(rootEnrollment.verificationPolicy.artifactId);
  validateP5Contract('verificationPolicy', rootPolicy);
  store.verifyRef(receipt.successorP5Profile);
  const successorProfile = store.readJson(receipt.successorP5Profile.artifactId);
  validateP5Contract('profile', successorProfile);
  store.verifyRef(successorProfile.verificationPolicy);
  const successorPolicy = store.readJson(successorProfile.verificationPolicy.artifactId);
  validateP5Contract('verificationPolicy', successorPolicy);
  const policyMatches = successorPolicyMatches({ rootPolicy, successorPolicy, rootEnrollment, rootRelease, runningSourceRelease });
  // The successor names exactly the pool slot after the one its predecessor release ran on. The handoff names that predecessor's
  // effective enrollment, so the slot follows from the verified chain: nothing outside the pool, nothing reused, nothing skipped.
  const successorSlot = poolEntryForProfileWorkspace(rootEnrollment, successorProfile.workspace);
  store.verifyRef(receipt.handoff);
  const handoffRecord = store.readJson(receipt.handoff.artifactId);
  store.verifyRef(handoffRecord.enrollment);
  const predecessorEnrollment = store.readJson(handoffRecord.enrollment.artifactId);
  const expectedSlot = nextP5WorkspaceSlot(predecessorEnrollment);
  const exactSlot = Boolean(successorSlot && expectedSlot) && canonicalHash(expectedSlot) === canonicalHash(successorSlot);
  const nonReleaseMatches = exactSlot && successorProfileFieldsMatch(rootProfile, successorProfile) && policyMatches;
  if (!nonReleaseMatches) throw new P6ContinuationError('p6_continuation_profile_mismatch',
    'Successor P5 profile violates root enrollment policy, workspace, scope or budgets.');

  store.verifyRef(successorProfile.runningSourceRelease);
  const successorRelease = store.readJson(successorProfile.runningSourceRelease.artifactId);
  if (!same(successorRelease, runningSourceRelease)
    || successorRelease.committedOperationId !== receipt.operationId
    || successorRelease.packageSha256 !== receipt.packageSha256
    || successorRelease.sourceCommit !== receipt.sourceCommit
    || successorRelease.sourceDigest !== receipt.installedSourceDigest
    || successorRelease.inputsDigest !== receipt.buildInputDigest) {
    throw new P6ContinuationError('p6_continuation_release_mismatch',
      'Successor P5 release does not match the exact Host-verified package and operation.');
  }

  store.verifyRef(successorProfile.baseline);
  const successorBaseline = store.readJson(successorProfile.baseline.artifactId);
  validateP5Contract('baselineManifest', successorBaseline);
  if (successorBaseline.baseCommit !== receipt.sourceCommit || successorBaseline.baseTree !== receipt.sourceTree
    || successorBaseline.effectiveSourceDigest !== receipt.candidateSourceDigest
    || !same(successorBaseline.runningSourceRelease, successorProfile.runningSourceRelease)) {
    throw new P6ContinuationError('p6_continuation_baseline_mismatch', 'Successor P5 baseline does not bind the verified Git source and package release.');
  }

  if (rootEnrollment.gitCandidatePolicy !== 'managed-clone-v1' || !rootEnrollment.gitSource
    || rootEnrollment.gitSource.sourceCommit !== rootRelease.sourceCommit
    || rootEnrollment.gitSource.sourceTree !== rootEnrollment.baseTree
    || rootEnrollment.gitSource.releaseSourceDigest !== rootRelease.sourceDigest) {
    throw new P6ContinuationError('p6_continuation_git_source_mismatch',
      'The root managed-clone source must match the exact Host-attested root release before advancing.');
  }
  const successorGitSource = {
    ...rootEnrollment.gitSource,
    sourceCommit: successorBaseline.baseCommit,
    sourceTree: successorBaseline.baseTree,
    objectFormat: successorBaseline.gitObjectFormat,
    releaseSourceDigest: runningSourceRelease.sourceDigest,
  };
  const continuationRecord = readOrCreateContinuationReceipt({ store, build, runningSourceRelease, hostSwitchStatus,
    successorReleaseRef: successorProfile.runningSourceRelease,
    verifiedRefs: { ...verifiedRefs, successorReleaseRef: successorProfile.runningSourceRelease } });
  const verifiedLocalSource = {
    schemaVersion: 1,
    kind: 'P6StoreGitObjectSource',
    enrollmentId: rootEnrollment.enrollmentId,
    repositoryIdentityDigest: canonicalHash(rootEnrollment.repositoryIdentity),
    sourceRepositoryId: successorGitSource.sourceRepositoryId,
    remoteId: successorGitSource.remote.remoteId,
    baselineId: successorBaseline.baselineId,
    candidateSourceDigest: successorBaseline.effectiveSourceDigest,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    objectFormat: successorBaseline.gitObjectFormat,
    releaseSourceDigest: runningSourceRelease.sourceDigest,
    installationId: runningSourceRelease.installationId,
    engineBuildId: runningSourceRelease.buildId,
    operationId: receipt.operationId,
    packageSha256: receipt.packageSha256,
    predecessorEnrollment: verifiedRefs.handoff.enrollment,
    handoff: receipt.handoff,
    buildReceipt: build.receiptRef,
    continuationReceipt: continuationRecord.ref,
  };
  validateP5Contract('gitObjectSource', verifiedLocalSource);
  successorGitSource.verifiedLocalSource = verifiedLocalSource;
  validateP5Contract('gitSource', successorGitSource);

  const effectiveEnrollment = {
    ...rootEnrollment, profile: receipt.successorP5Profile, rootProfile: rootEnrollment.profile, workspace: successorSlot,
    baselineId: successorProfile.baselineId,
    baselineManifest: successorProfile.baseline, verificationPolicy: successorProfile.verificationPolicy,
    runningSourceRelease: successorProfile.runningSourceRelease, baseCommit: successorBaseline.baseCommit,
    baseTree: successorBaseline.baseTree, effectiveSourceDigest: successorBaseline.effectiveSourceDigest,
    harnessClosureDigest: successorPolicy.harnessClosureDigest, gitSource: successorGitSource,
  };
  validateP5Contract('enrollment', effectiveEnrollment);
  return { rootEnrollment, effectiveEnrollment, buildReceipt: receipt };
}
