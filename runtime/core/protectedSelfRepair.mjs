import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalBytes, canonicalHash, compareText, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid } from './schemas.mjs';
import { workspaceRootsOverlap } from './workspaceIsolation.mjs';
import { assertP5HostBoundary, classifyP5Mutation, deriveP5HostProtection, P5_SENSITIVE_TIERS, p5HostStaticReason as p5HostProtectedReason,
  verifyP5MutationClassification } from './p5HostBoundary.mjs';

export const P5_CAPABILITY = 'protected-self-repair-v1';
export const P5_ENROLLMENT_RELATIVE_PATH = join('p5', 'enrollment.json');
export const P5_VERIFICATION_INPUT_MANIFEST_ENV = 'DESZO_P5_INPUT_MANIFEST';
export const P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV = 'DESZO_P5_CANDIDATE_ENTRYPOINT';
export const P5_EVENT_TYPES = Object.freeze([
  'self_repair.source_bound', 'self_repair.preparation_intent', 'self_repair.workspace_prepared',
  'self_repair.candidate_capture_started', 'self_repair.git_commit_intent', 'self_repair.candidate_captured', 'self_repair.verification_started', 'self_repair.verification_recorded',
  'self_repair.candidate_invalidated', 'self_repair.review_delivery_carried', 'self_repair.handoff_recorded',
  'self_repair.retention_changed', 'self_repair.cleanup_deferred',
  'self_repair.publication_intent', 'self_repair.publication_recorded', 'self_repair.capture_held',
]);

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEX = /^[a-f0-9]{64}$/;
const asRef = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });
const sortEntries = entries => [...entries].sort((a, b) => compareText(a.path, b.path));

// P5-FINAL E-01: a capture failure caused by an unavailable Host or dependency is not evidence about the candidate. Such a
// failure holds the Developer Attempt unsettled, so its durable anchor and Git commit intent resume when Custody next re-delivers
// the terminal record (Host reattachment or Engine start), exactly as after an Engine exit. Every other failure, including
// every integrity, drift, scope and boundary refusal, still fails closed.
export const P5_TRANSIENT_CAPTURE_CODES = Object.freeze(['p5_host_unavailable', 'lifecycle_host_unavailable', 'custody_unavailable',
  'custody_unreachable', 'host_unavailable', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
export function p5CaptureFailureDisposition(error) {
  return P5_TRANSIENT_CAPTURE_CODES.includes(error?.code) ? 'hold' : 'fail';
}
// P5-CLOSURE F10: a held capture is retried for the same Attempt, anchor and Git intent at these delays, counted durably across
// Engine restarts; when the budget is spent the Attempt fails closed. Never an unbounded background retry.
export const P5_CAPTURE_HOLD_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000]);
export function p5CaptureHoldDecision(previousHolds) {
  return previousHolds < P5_CAPTURE_HOLD_DELAYS_MS.length
    ? { action: 'retry', holdNumber: previousHolds + 1, delayMs: P5_CAPTURE_HOLD_DELAYS_MS[previousHolds] }
    : { action: 'fail', holdNumber: previousHolds };
}

export class ProtectedSelfRepairError extends Error {
  constructor(code, message) { super(message); this.name = 'ProtectedSelfRepairError'; this.code = code; }
}

function p5Fail(code, message) { throw new ProtectedSelfRepairError(code, message); }

export function validateP5Contract(name, value) {
  const definition = ({ enrollment: 'enrollment', profile: 'profile', sourceBinding: 'sourceBinding',
    verificationPolicy: 'verificationPolicy', verificationInputs: 'verificationInputs', baselineManifest: 'baselineManifest', sourceManifest: 'sourceManifest',
    repositoryIdentity: 'repositoryIdentity', sourcePathPolicy: 'sourcePathPolicy', runningSourceRelease: 'runningSourceRelease',
    runningSourceInventory: 'runningSourceInventory',
    preparationIntent: 'preparationIntent', workspacePreparation: 'workspacePreparation',
    gitRepository: 'gitRepository', gitCandidate: 'gitCandidate', gitCommitIntent: 'gitCommitIntent',
    gitSource: 'gitSource', gitFetchProvenance: 'gitFetchProvenance', hostProtection: 'hostProtection',
    candidateCaptureAnchor: 'candidateCaptureAnchor', gitPublicationPolicy: 'gitPublicationPolicy',
    gitPublicationIntent: 'gitPublicationIntent', gitPublicationResult: 'gitPublicationResult',
    verificationStarted: 'verificationStarted', verificationOutcome: 'verificationOutcome',
    subjectResolution: 'subjectResolution', materializedCheckInputs: 'materializedCheckInputs',
    executionTreeCaptureEvidence: 'executionTreeCaptureEvidence', overlayManifest: 'overlayManifest',
    testInputManifest: 'testInputManifest', commandManifest: 'commandManifest',
    checkObservationEvidence: 'checkObservationEvidence', changeManifest: 'changeManifest', sourceCaptureEvidence: 'sourceCaptureEvidence', candidate: 'candidate',
    reviewDossierChunk: 'reviewDossierChunk', reviewDeliveryCarry: 'reviewDeliveryCarry', candidateInvalidation: 'candidateInvalidation',
    verificationReceipt: 'verificationReceipt', acceptance: 'acceptance', p2Outcome: 'p2Outcome',
    causalReproduction: 'causalReproduction', dependencyClosure: 'dependencyClosure', captureHold: 'captureHold',
    retentionRecord: 'retentionRecord', handoff: 'handoff' })[name];
  if (!definition) p5Fail('p5_contract_unknown', `Unknown P5 contract "${name}".`);
  assertValid('protected-self-repair.schema.json', definition, value, `P5 ${name}`);
  return canonicalHash(value);
}

function assertP5SourcePathPolicy(policy) {
  validateP5Contract('sourcePathPolicy', policy);
  for (const selector of [...policy.include, ...policy.exclude, ...policy.secretPaths]) {
    if (!/^[\x20-\x7e]+$/.test(selector) || selector.includes('\\') || selector.includes(':')
      || selector.startsWith('/') || selector.endsWith('/'))
      p5Fail('p5_source_policy_invalid', 'P5 source selectors must be portable ASCII relative paths.');
    const components = selector.split('/');
    if (components.some(part => !part || part === '.' || part === '..' || (part.includes('**') && part !== '**')
      || part.endsWith('.') || part.endsWith(' ') || DEVICE_NAME.test(part.replaceAll('*', 'x'))))
      p5Fail('p5_source_policy_invalid', `P5 source selector "${selector}" contains an unsupported path component.`);
  }
  return canonicalHash(policy);
}

function lstatIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function pathKey(path) { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value; }

/**
 * Load the explicit, installation-owned P5 manifest from the managed profile. Its parent folder and file
 * must be ordinary filesystem objects under the Host-canonical profile root. The external file is never
 * trusted by location alone: every artifact ref is checked and its runtime release must equal the Host's
 * current, re-hashed active package identity.
 */
function readP5EnrollmentFile(profileRoot, maxBytes) {
  if (typeof profileRoot !== 'string' || !profileRoot || !isAbsolute(profileRoot))
    p5Fail('p5_enrollment_unavailable', 'P5 enrollment requires the absolute managed profile root.');
  let canonicalProfile;
  try { canonicalProfile = realpathSync.native(profileRoot); }
  catch { p5Fail('p5_profile_root_unavailable', 'The managed profile root cannot be resolved.'); }
  if (pathKey(canonicalProfile) !== pathKey(profileRoot) || lstatSync(canonicalProfile).isSymbolicLink())
    p5Fail('p5_profile_root_unsafe', 'The managed profile root is not the canonical Host-owned directory.');
  const directory = join(canonicalProfile, 'p5');
  const directoryInfo = lstatIfPresent(directory);
  if (!directoryInfo) return null;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || pathKey(realpathSync.native(directory)) !== pathKey(directory))
    p5Fail('p5_enrollment_path_unsafe', 'The installed P5 enrollment directory must be a plain directory inside the managed profile.');
  const path = join(directory, 'enrollment.json');
  const fileInfo = lstatIfPresent(path);
  if (!fileInfo) return null;
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || pathKey(realpathSync.native(path)) !== pathKey(path))
    p5Fail('p5_enrollment_path_unsafe', 'The installed P5 enrollment must be a plain file inside the managed profile.');
  if (fileInfo.size <= 0 || fileInfo.size > maxBytes)
    p5Fail('p5_enrollment_size_invalid', 'The installed P5 enrollment is empty or exceeds its size bound.');
  let bytes;
  try {
    bytes = readFileSync(path);
    if (bytes.length !== fileInfo.size || bytes.length > maxBytes) p5Fail('p5_enrollment_changed', 'The installed P5 enrollment changed while it was being read.');
  } catch (error) {
    if (error instanceof ProtectedSelfRepairError) throw error;
    p5Fail('p5_enrollment_invalid', `The installed P5 enrollment cannot be read: ${error.message}`);
  }
  return { profileRoot: canonicalProfile, path, bytes, byteSize: bytes.length, fileSha256: sha256(bytes) };
}

function validateP5EnrollmentFile({ file, store, installationId, runningSourceRelease }) {
  if (!file) return null;
  if (!store || !installationId || !runningSourceRelease)
    p5Fail('p5_enrollment_unavailable', 'P5 enrollment requires the Store, installation identity and Host source-release proof.');
  let enrollment;
  try { enrollment = parseStrictJson(file.bytes.toString('utf8')); }
  catch (error) { p5Fail('p5_enrollment_invalid', `The installed P5 enrollment cannot be parsed: ${error.message}`); }
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('runningSourceRelease', runningSourceRelease);
  if (enrollment.repositoryIdentity.enrollmentId !== enrollment.enrollmentId)
    p5Fail('p5_repository_enrollment_mismatch', 'The installed P5 repository identity does not use the enrollment UUID.');
  store.verifyRef(enrollment.runningSourceRelease);
  const enrolledRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
  validateP5Contract('runningSourceRelease', enrolledRelease);
  if (canonicalHash(enrolledRelease) !== enrollment.runningSourceRelease.sha256
    || canonicalHash(enrolledRelease) !== canonicalHash(runningSourceRelease)
    || enrolledRelease.installationId !== installationId
    || enrolledRelease.sourceCommit !== enrollment.baseCommit)
    p5Fail('p5_runtime_source_mismatch', 'The current Host-verified runtime package does not match the enrolled source release and baseline commit.');
  const profile = store.readJson(enrollment.profile.artifactId);
  const { enrollmentDigest, profileDigest } = assertP5EnrollmentCurrent({ store, enrollment, profile,
    parentPublication: enrollment.parentPublication, repairPublication: enrollment.repairPublication,
    sourceRelease: enrollment.runningSourceRelease, currentRepositoryIdentity: enrollment.repositoryIdentity });
  if (enrollmentDigest !== canonicalHash(enrollment) || profileDigest !== enrollment.profile.sha256)
    p5Fail('p5_enrollment_invalid', 'The installed P5 enrollment artifact graph is inconsistent.');
  return { enrollment, profileRoot: file.profileRoot, path: file.path, fileSha256: file.fileSha256,
    byteSize: file.byteSize, enrollmentDigest, runningSourceRelease: enrolledRelease };
}

export function loadP5Enrollment({ profileRoot, store, installationId, runningSourceRelease, maxBytes = 1024 * 1024 }) {
  return validateP5EnrollmentFile({ file: readP5EnrollmentFile(profileRoot, maxBytes), store, installationId, runningSourceRelease });
}

/**
 * Read the installation-owned enrollment only while the authenticated Rust Host observes the exact
 * file path and bytes before and after Node reads it. The Host scan also rejects aliases,
 * reparse points and hard-linked files on Windows.
 */
export async function captureP5EnrollmentFileWithHostIdentity({ profileRoot, nativeSourceReader, expectedHostPid,
  expectedGeneration, expectedEpoch, maxBytes = 1024 * 1024 }) {
  if (typeof profileRoot !== 'string' || !profileRoot || !isAbsolute(profileRoot) || typeof nativeSourceReader !== 'function'
    || !Number.isSafeInteger(expectedHostPid) || expectedHostPid < 1 || typeof expectedGeneration !== 'string'
    || !expectedGeneration || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1)
    p5Fail('p5_enrollment_unavailable', 'P5 enrollment requires the absolute managed profile and exact attached Rust Host PID, generation and epoch.');
  const relativePath = P5_ENROLLMENT_RELATIVE_PATH.split(sep).join('/');
  const maxFiles = 1;
  const include = [relativePath];
  const exclude = [];
  const scan = expectedPathsDigest => readP5NativeIdentity(nativeSourceReader, { root: profileRoot, include, exclude,
    maxFiles, maxBytes, ...(expectedPathsDigest ? { expectedPathsDigest } : {}) });
  const before = await scan();
  const file = readP5EnrollmentFile(profileRoot, maxBytes);
  const expectedPaths = file ? [relativePath] : [];
  const expectedPathDigest = p5PathSetDigest(expectedPaths);
  const expectedContentDigest = file ? p5NativeContentDigest([{ path: relativePath, byteSize: file.byteSize, sha256: file.fileSha256 }])
    : p5NativeContentDigest([]);
  const expectedBytes = file?.byteSize ?? 0;
  const after = await scan(expectedPathDigest);
  const matches = identity => identity.fileCount === expectedPaths.length && identity.totalBytes === expectedBytes
    && identity.pathDigest === expectedPathDigest && identity.contentDigest === expectedContentDigest
    && identity.hostPid === expectedHostPid && identity.generation === expectedGeneration && identity.epoch === expectedEpoch;
  if (!matches(before) || !matches(after) || before.snapshotDigest !== after.snapshotDigest
    || canonicalHash(before.rootIdentity) !== canonicalHash(after.rootIdentity))
    p5Fail('p5_enrollment_changed', 'The Rust Host observed a different enrollment path, file identity or byte digest during the bounded enrollment read.');
  return file ? { ...file, nativeEvidence: { snapshotDigest: after.snapshotDigest, pathDigest: after.pathDigest,
    contentDigest: after.contentDigest, rootIdentity: after.rootIdentity, hostPid: after.hostPid,
    generation: after.generation, epoch: after.epoch } } : null;
}

export async function loadP5EnrollmentWithHostIdentity({ profileRoot, store, installationId, runningSourceRelease,
  nativeSourceReader, expectedHostPid, expectedGeneration, expectedEpoch, maxBytes = 1024 * 1024 }) {
  const file = await captureP5EnrollmentFileWithHostIdentity({ profileRoot, nativeSourceReader,
    expectedHostPid, expectedGeneration, expectedEpoch, maxBytes });
  return validateP5EnrollmentFile({ file, store, installationId, runningSourceRelease });
}

/** Bind the selected, content-addressed P5 baseline files to the active Host-verified build inventory. */
export async function verifyP5RunningSourceInventory({ store, enrollment, currentRunningSourceRelease, generation, readBatch, batchSize = 32,
  installedInventory = null }) {
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('runningSourceRelease', currentRunningSourceRelease);
  if (!store || typeof generation !== 'string' || !generation || typeof readBatch !== 'function'
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32)
    p5Fail('p5_source_inventory_unavailable', 'P5 enrollment requires a bounded Host source-inventory reader and active lifecycle generation.');
  for (const reference of [enrollment.baselineManifest, enrollment.runningSourceRelease]) store.verifyRef(reference);
  const enrolledRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
  validateP5Contract('runningSourceRelease', enrolledRelease);
  if (canonicalHash(enrolledRelease) !== enrollment.runningSourceRelease.sha256
    || canonicalHash(currentRunningSourceRelease) !== canonicalHash(enrolledRelease))
    p5Fail('p5_runtime_source_mismatch', 'The active Host source release differs from the exact enrolled package identity.');

  const baseline = store.readJson(enrollment.baselineManifest.artifactId);
  validateP5Contract('baselineManifest', baseline);
  if (canonicalHash(baseline) !== enrollment.baselineManifest.sha256
    || canonicalHash(baseline.runningSourceRelease) !== canonicalHash(enrollment.runningSourceRelease)
    || baseline.baseCommit !== enrollment.baseCommit || baseline.effectiveSourceDigest !== enrollment.effectiveSourceDigest) {
    p5Fail('p5_baseline_mismatch', 'The enrolled baseline manifest does not bind the selected source and running release.');
  }
  store.verifyRef(baseline.sourceManifest);
  const sourceManifest = store.readJson(baseline.sourceManifest.artifactId);
  validateP5Contract('sourceManifest', sourceManifest);
  if (canonicalHash(sourceManifest) !== baseline.sourceManifest.sha256
    || sourceManifest.sourceDigest !== enrollment.effectiveSourceDigest || !Array.isArray(sourceManifest.entries)
    || sourceManifest.entries.length < 1 || sourceManifest.entries.length > enrollment.budgets.maxSourceFiles)
    p5Fail('p5_baseline_mismatch', 'The enrolled baseline source manifest is missing or inconsistent.');

  const baselineEntries = sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
  if (p5SourceDigest(baselineEntries) !== enrollment.effectiveSourceDigest)
    p5Fail('p5_baseline_mismatch', 'The enrolled baseline file list does not match its canonical source digest.');
  for (const entry of sourceManifest.entries) {
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256 || entry.artifact.sha256 !== entry.sha256)
      p5Fail('p5_baseline_object_mismatch', `The enrolled source object for "${entry.path}" differs from its baseline manifest.`);
  }

  if (enrolledRelease.sourceCommit !== enrollment.baseCommit || enrolledRelease.sourceDigest !== currentRunningSourceRelease.sourceDigest)
    p5Fail('p5_runtime_source_mismatch', 'The enrolled source baseline commit or full build inventory digest differs from the active package.');
  // The installed package's own committed source inventory, authenticated by the Host-attested source digest (which is by
  // definition the canonical hash of that inventory's file list), proves every entry with one Host attestation instead of one
  // Host round trip (and package digest) per batch. Without it the Host serves the inventory in batches.
  if (installedInventory) {
    if (installedInventory.schemaVersion !== 1 || installedInventory.kind !== 'DeszoBuildSourceInventory' || !Array.isArray(installedInventory.files)
      || installedInventory.sourceCommit !== enrolledRelease.sourceCommit || installedInventory.sourceDigest !== currentRunningSourceRelease.sourceDigest
      || canonicalHash(installedInventory.files) !== currentRunningSourceRelease.sourceDigest)
      p5Fail('p5_runtime_source_mismatch', 'The installed source inventory is not the one the Host attests for the running release.');
    const byPath = new Map(installedInventory.files.map(item => [item.path, item]));
    for (const entry of sourceManifest.entries)
      if (byPath.get(entry.path)?.sha256 !== entry.sha256)
        p5Fail('p5_runtime_source_mismatch', `The running build source differs from the enrolled baseline at "${entry.path}".`);
    return true;
  }
  for (let offset = 0; offset < sourceManifest.entries.length; offset += batchSize) {
    const batch = sourceManifest.entries.slice(offset, offset + batchSize);
    const paths = batch.map(entry => entry.path);
    let response;
    try { response = await readBatch(paths); }
    catch (error) { p5Fail('p5_source_inventory_unavailable', `Lifecycle Host could not read the active source inventory: ${error.message}`); }
    validateP5Contract('runningSourceInventory', response);
    if (response.installationId !== enrolledRelease.installationId || response.buildId !== enrolledRelease.buildId
      || response.packageSha256 !== enrolledRelease.packageSha256 || response.sourceCommit !== enrolledRelease.sourceCommit
      || response.sourceDigest !== enrolledRelease.sourceDigest || response.generation !== generation
      || response.entries.length !== batch.length)
      p5Fail('p5_runtime_source_mismatch', 'The Host source-inventory response is not bound to the active enrolled package and generation.');
    for (let index = 0; index < batch.length; index++) {
      const actual = response.entries[index];
      if (actual.path !== batch[index].path || actual.sha256 !== batch[index].sha256)
        p5Fail('p5_runtime_source_mismatch', `The running build source differs from the enrolled baseline at "${batch[index].path}".`);
    }
  }
  return { installationId: enrolledRelease.installationId, buildId: enrolledRelease.buildId,
    packageSha256: enrolledRelease.packageSha256, sourceCommit: enrolledRelease.sourceCommit,
    sourceDigest: enrolledRelease.sourceDigest, baselineSourceDigest: enrollment.effectiveSourceDigest,
    verifiedFiles: sourceManifest.entries.length, generation };
}

export async function verifyP5EnrollmentFileCurrent({ profileRoot, path, fileSha256, enrollmentDigest,
  nativeSourceReader, expectedHostPid, expectedGeneration, expectedEpoch, maxBytes = 1024 * 1024 }) {
  if (typeof profileRoot !== 'string' || !profileRoot || typeof path !== 'string' || !path || !HEX.test(fileSha256 || '') || !HEX.test(enrollmentDigest || ''))
    p5Fail('p5_enrollment_unavailable', 'The loaded P5 enrollment identity is incomplete.');
  const file = await captureP5EnrollmentFileWithHostIdentity({ profileRoot, nativeSourceReader,
    expectedHostPid, expectedGeneration, expectedEpoch, maxBytes });
  if (!file || pathKey(resolve(path)) !== pathKey(file.path))
    p5Fail('p5_enrollment_changed', 'The installed P5 enrollment path changed after Engine startup.');
  let value;
  try { value = parseStrictJson(file.bytes.toString('utf8')); }
  catch { p5Fail('p5_enrollment_changed', 'The installed P5 enrollment file is no longer readable JSON.'); }
  if (file.fileSha256 !== fileSha256 || canonicalHash(value) !== enrollmentDigest)
    p5Fail('p5_enrollment_changed', 'The installed P5 enrollment changed after Engine startup.');
  return value;
}

export function assertP5EnrollmentCurrent({ store, enrollment, profile, parentPublication, repairPublication,
  sourceRelease, currentRepositoryIdentity, runtimeCapability = P5_CAPABILITY }) {
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('profile', profile);
  if (runtimeCapability !== P5_CAPABILITY || enrollment.minimumReaderCapability !== P5_CAPABILITY)
    p5Fail('p5_reader_incompatible', 'This runtime cannot safely interpret the installed P5 enrollment contract.');
  const enrollmentDigest = canonicalHash(enrollment);
  const profileDigest = canonicalHash(profile);
  for (const ref of [enrollment.baselineManifest, enrollment.runningSourceRelease, enrollment.profile,
    enrollment.verificationPolicy, profile.baseline, profile.runningSourceRelease, profile.verificationPolicy]) store.verifyRef(ref);
  const installedProfile = store.readJson(enrollment.profile.artifactId);
  if (profileDigest !== enrollment.profile.sha256 || canonicalHash(installedProfile) !== profileDigest)
    p5Fail('p5_enrollment_profile_mismatch', 'The installed enrollment and P5 profile identities do not match.');
  if (canonicalHash(parentPublication) !== canonicalHash(enrollment.parentPublication)
    || canonicalHash(repairPublication) !== canonicalHash(enrollment.repairPublication)
    || canonicalHash(profile.repairPublication) !== canonicalHash(enrollment.repairPublication))
    p5Fail('p5_publication_mismatch', 'The Parent or Repair publication differs from the installed P5 enrollment.');
  if (canonicalHash(sourceRelease) !== canonicalHash(enrollment.runningSourceRelease)
    || canonicalHash(profile.runningSourceRelease) !== canonicalHash(enrollment.runningSourceRelease))
    p5Fail('p5_runtime_source_mismatch', 'The trusted running-source release differs from the installed P5 enrollment.');
  validateP5Contract('repositoryIdentity', enrollment.repositoryIdentity);
  if (enrollment.repositoryIdentity.enrollmentId !== enrollment.enrollmentId
    || profile.enrollmentId !== enrollment.enrollmentId || profile.repositoryIdentity.enrollmentId !== enrollment.enrollmentId)
    p5Fail('p5_repository_enrollment_mismatch', 'The profile, repository identity and installed P5 enrollment UUIDs must agree.');
  if (!currentRepositoryIdentity) p5Fail('p5_repository_identity_unavailable', 'P5 requires a live canonical Git common-directory identity before enrollment admission.');
  validateP5Contract('repositoryIdentity', currentRepositoryIdentity);
  if (canonicalHash(currentRepositoryIdentity) !== canonicalHash(enrollment.repositoryIdentity))
    p5Fail('p5_repository_identity_mismatch', 'The live Git common-directory identity differs from the installed repository enrollment.');
  const baselineManifest = store.readJson(enrollment.baselineManifest.artifactId);
  validateP5Contract('baselineManifest', baselineManifest);
  if (!isAbsolute(baselineManifest.repositoryRoot) || assertP5SourcePathPolicy(baselineManifest.pathPolicy) !== enrollment.pathPolicyDigest)
    p5Fail('p5_baseline_mismatch', 'The enrolled source root or retained path policy is missing or changed.');
  store.verifyRef(baselineManifest.sourceManifest);
  const runningRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
  validateP5Contract('runningSourceRelease', runningRelease);
  if (runningRelease.sourceCommit !== enrollment.baseCommit)
    p5Fail('p5_runtime_source_mismatch', 'The enrolled runtime release was not built from the enrolled source commit.');
  if (enrollment.harnessClosureDigest !== runningRelease.inputsDigest)
    p5Fail('p5_runtime_source_mismatch', 'The enrolled verifier closure must bind to the Host-attested build-input digest, including the authority import and dependency closure.');
  if (canonicalHash(profile.baseline) !== canonicalHash(enrollment.baselineManifest)
    || baselineManifest.enrollmentId !== enrollment.enrollmentId || baselineManifest.baselineId !== enrollment.baselineId
    || baselineManifest.repositoryIdentity.enrollmentId !== enrollment.enrollmentId
    || canonicalHash(baselineManifest.repositoryIdentity) !== canonicalHash(enrollment.repositoryIdentity) || baselineManifest.baseCommit !== enrollment.baseCommit
    || baselineManifest.baseTree !== enrollment.baseTree || baselineManifest.gitObjectFormat !== enrollment.gitObjectFormat
    || baselineManifest.pathPolicyDigest !== enrollment.pathPolicyDigest || baselineManifest.effectiveSourceDigest !== enrollment.effectiveSourceDigest
    || canonicalHash(baselineManifest.runningSourceRelease) !== canonicalHash(enrollment.runningSourceRelease))
    p5Fail('p5_baseline_mismatch', 'The enrolled baseline manifest does not match the installed commit, repository and source identities.');
  const baselineSourceManifest = store.readJson(baselineManifest.sourceManifest.artifactId);
  validateP5Contract('sourceManifest', baselineSourceManifest);
  const baselineEntries = baselineSourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
  for (const entry of baselineSourceManifest.entries) {
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_baseline_object_mismatch', `The enrolled source object for "${entry.path}" does not match its manifest.`);
  }
  if (baselineSourceManifest.sourceDigest !== enrollment.effectiveSourceDigest
    || p5SourceDigest(baselineEntries) !== enrollment.effectiveSourceDigest
    || p5BaselineId({ repositoryIdentity: enrollment.repositoryIdentity, gitObjectFormat: enrollment.gitObjectFormat,
      baseCommit: enrollment.baseCommit, baseTree: enrollment.baseTree, pathPolicyDigest: enrollment.pathPolicyDigest,
      effectiveSourceDigest: enrollment.effectiveSourceDigest }) !== enrollment.baselineId)
    p5Fail('p5_baseline_mismatch', 'The enrolled source objects or canonical baseline identity do not match the enrollment.');
  const policy = store.readJson(enrollment.verificationPolicy.artifactId);
  assertP5VerificationPolicy(policy);
  if (canonicalHash(profile.verificationPolicy) !== canonicalHash(enrollment.verificationPolicy)
    || enrollment.harnessClosureDigest !== policy.harnessClosureDigest
    || profile.workspace.workspaceId !== enrollment.workspace.workspaceId || profile.workspace.canonicalRoot !== enrollment.workspace.canonicalRoot
    || profile.workspace.allocationId !== enrollment.workspace.allocationId
    || canonicalHash(profile.scope) !== canonicalHash(enrollment.scope) || canonicalHash(profile.budgets) !== canonicalHash(enrollment.budgets)
    || canonicalHash(profile.requiredCheckIds) !== canonicalHash(policy.requiredCheckIds))
    p5Fail('p5_profile_mismatch', 'The P5 profile changed the enrolled workspace, scope, budget or required verification policy.');
  if (profile.enrollmentId !== enrollment.enrollmentId || profile.baselineId !== enrollment.baselineId
    || canonicalHash(profile.repositoryIdentity) !== canonicalHash(enrollment.repositoryIdentity))
    p5Fail('p5_profile_mismatch', 'The P5 profile is not bound to the enrolled baseline and Repair publication.');
  return { enrollmentDigest, profileDigest };
}

/** Validate the deliberately small, portable P5 source path language. */
export function validateP5SourcePath(path) {
  if (typeof path !== 'string' || !path || !/^[\x20-\x7e]+$/.test(path) || CONTROL.test(path)
    || path.includes('\\') || path.includes(':') || path.startsWith('/') || path.endsWith('/') || isAbsolute(path))
    p5Fail('p5_path_unsupported', 'P5 source paths must be portable ASCII relative paths using forward slashes.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || DEVICE_NAME.test(part) || /[<>"|?*]/.test(part) || part.toLowerCase() === '.git' || part.toLowerCase() === '.p5'))
    p5Fail('p5_path_unsupported', `P5 source path "${path}" contains an unsupported Windows or reserved component.`);
  return path;
}

/** P5 Git adapter entry point; all commands share the pinned, scrubbed process policy below. */
export function runP5GitCommand(gitTool, repositoryRoot, args, options = {}) {
  return p5GitRun(gitTool, repositoryRoot, args, options);
}

/**
 * The same pinned, sanitized Git invocation without blocking the Engine event loop (P5-CLOSURE F9: remote reads and the
 * publication push may be slow). The bounded timeout ends the child; its outcome is then unknown to the caller.
 */
export function runP5GitCommandAsync(gitTool, repositoryRoot, args, { timeoutMs = 120_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const root = resolve(repositoryRoot);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(gitTool.path, [...P5_GIT_CONFIG, '-c', `safe.directory=${root.replace(/\\/g, '/')}`, '-C', root, ...args], {
      cwd: root, env: p5GitEnvironment({}), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(Buffer.concat(out)); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already ended */ } finish(new ProtectedSelfRepairError('p5_git_timeout', `Pinned Git timed out for ${args[0]}.`)); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size <= maxBuffer) out.push(chunk); });
    child.stderr.resume();
    child.once('error', error => finish(new ProtectedSelfRepairError('p5_git_source_unavailable', `Pinned Git failed for ${args[0]}: ${error.message}.`)));
    child.once('close', (code, signal) => finish(code === 0 && !signal ? null
      : new ProtectedSelfRepairError('p5_git_source_unavailable', `Pinned Git failed for ${args[0]}.`)));
  });
}

/** Reuse enrollment's pinned Git executable checks from the narrow candidate adapter. */
export async function verifyP5GitToolIdentity({ gitTool, identityReader = null, nativeToolIdentityReader = null }) {
  verifyGitTool(gitTool, identityReader, { hostIdentityProven: process.platform === 'win32' });
  const nativeIdentity = process.platform === 'win32' ? await readP5NativeToolIdentity(nativeToolIdentityReader, gitTool.path) : null;
  const after = sha256(readFileSync(gitTool.path));
  if (after !== gitTool.sha256) p5Fail('p5_git_tool_mismatch', 'The pinned Git executable changed during identity validation.');
  return { path: realpathSync.native(gitTool.path), sha256: after, nativeIdentity };
}

/** Reject Git checkout transformations using the same policy as P5 baseline capture. */
export function verifyP5GitAttributes(gitTool, repositoryRoot, paths) {
  return p5GitAttributes(gitTool, repositoryRoot, paths);
}

function assertUniquePortablePaths(entries) {
  const exact = new Set(), folded = new Map(), files = new Set();
  for (const entry of entries) {
    validateP5SourcePath(entry.path);
    if (exact.has(entry.path)) p5Fail('p5_path_duplicate', `P5 source path "${entry.path}" appears more than once.`);
    exact.add(entry.path);
    const foldedPath = entry.path.toLowerCase();
    if (folded.has(foldedPath) && folded.get(foldedPath) !== entry.path)
      p5Fail('p5_case_collision', `P5 source paths "${folded.get(foldedPath)}" and "${entry.path}" alias on Windows.`);
    folded.set(foldedPath, entry.path);
    files.add(foldedPath);
  }
  for (const path of files) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (files.has(prefix)) p5Fail('p5_path_collision', `A P5 file path is also an ancestor directory: "${prefix}".`);
    }
  }
}

export function p5SourceDigest(entries) {
  const sorted = sortEntries(entries);
  assertUniquePortablePaths(sorted);
  for (const entry of sorted) {
    if (entry.type !== 'regular' || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0 || !HEX.test(entry.sha256)
      || typeof entry.executable !== 'boolean') p5Fail('p5_source_entry_invalid', `Invalid P5 source entry for "${entry.path}".`);
  }
  return canonicalHash({ kind: 'P5SourceTree', version: 1, entries: sorted });
}

export function p5BaselineId({ repositoryIdentity, gitObjectFormat, baseCommit, baseTree, pathPolicyDigest, effectiveSourceDigest }) {
  validateP5Contract('repositoryIdentity', repositoryIdentity);
  if (!isAbsolute(repositoryIdentity.canonicalCommonDirectory) || !['sha1', 'sha256'].includes(gitObjectFormat)
    || typeof baseCommit !== 'string' || !baseCommit || typeof baseTree !== 'string' || !baseTree
    || !HEX.test(pathPolicyDigest) || !HEX.test(effectiveSourceDigest))
    p5Fail('p5_baseline_invalid', 'The P5 baseline identity is incomplete or invalid.');
  return canonicalHash({ kind: 'P5Baseline', version: 1, repositoryIdentity, gitObjectFormat, baseCommit, baseTree,
    pathPolicyDigest, effectiveSourceDigest, dirtyPolicy: 'clean-committed' });
}

export function p5CandidateId({ baselineId, incidentId, parentRunId, repairRunId, linkId, developerAttemptId,
  workspaceAllocationId, candidateSourceDigest, selfRepairProfileDigest, verificationPolicyDigest, verificationInputsDigest }) {
  for (const [field, value] of Object.entries({ baselineId, candidateSourceDigest, selfRepairProfileDigest, verificationPolicyDigest, verificationInputsDigest }))
    if (!HEX.test(value || '')) p5Fail('p5_candidate_identity_invalid', `The P5 candidate ${field} must be a SHA-256 digest.`);
  for (const [field, value] of Object.entries({ incidentId, parentRunId, repairRunId, linkId, developerAttemptId, workspaceAllocationId }))
    if (typeof value !== 'string' || value.length === 0) p5Fail('p5_candidate_identity_invalid', `The P5 candidate ${field} is required.`);
  return canonicalHash({ kind: 'P5Candidate', version: 1, baselineId, incidentId, parentRunId, repairRunId, linkId,
    developerAttemptId, candidateOrdinal: 1, workspaceAllocationId, candidateSourceDigest,
    selfRepairProfileDigest, verificationPolicyDigest, verificationInputsDigest });
}

export function p5VerificationCommandDigest(check) {
  return canonicalHash({ kind: 'P5VerificationCommand', version: 1,
    checkId: check.checkId, stageId: check.stageId, required: check.required,
    executable: check.executable, executableSha256: check.executableSha256, argv: check.argv,
    cwd: check.cwd, inputRefs: check.inputRefs, environment: check.environment,
    subjectEntryPoints: check.subjectEntryPoints, expectedAssertions: check.expectedAssertions,
    expectedExitCodes: check.expectedExitCodes, timeoutSeconds: check.timeoutSeconds,
    maxOutputBytes: check.maxOutputBytes, subjectBinding: check.subjectBinding, overlayPaths: check.overlayPaths });
}

export function p5VerificationReceiptId({ candidateId, verificationPolicyDigest, gateAttemptId, custodyId, checks,
  causalReproduction = null, dependencyClosure = null }) {
  const observationSetDigest = canonicalHash([...checks].sort((a, b) => compareText(a.checkId, b.checkId)));
  // P5-CLOSURE evidence joins the identity only when present, so earlier receipts keep their exact identities.
  return canonicalHash({ kind: 'P5Verification', version: 1, candidateId, verificationPolicyDigest,
    gateAttemptId, custodyId, observationSetDigest,
    ...(causalReproduction ? { causalReproduction } : {}), ...(dependencyClosure ? { dependencyClosure } : {}) });
}

export function p5CheckInputDigest({ candidate, check, verificationInputs }) {
  const staticInputRefs = [...check.inputRefs].sort((a, b) => compareText(a.artifactId, b.artifactId) || compareText(a.sha256, b.sha256));
  const incidentInputs = [...verificationInputs.inputs].sort((a, b) => compareText(a.selector, b.selector)
    || compareText(a.sourceOutcomeId, b.sourceOutcomeId) || a.sourceRevision - b.sourceRevision);
  return canonicalHash({ kind: 'P5CheckInputSet', version: 1, candidateId: candidate.candidateId,
    candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, checkId: check.checkId,
    staticInputRefs, incidentInputs });
}

export function p5ExecutionTreeDigest({ candidate, checkId, subjectResolution, inputDigest, overlayManifest }) {
  return canonicalHash({ kind: 'P5VerificationExecutionTree', version: 1, candidateId: candidate.candidateId,
    candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, checkId,
    subjectResolution, inputDigest, overlayManifest });
}

export function p5OverlayManifestDigest(manifest) {
  const { overlayManifestDigest: _overlayDigest, materializationDigest: _materializationDigest, ...body } = manifest;
  return canonicalHash(body);
}

export function p5OverlayMaterializationDigest({ candidateSourceDigest, overlayManifestDigest, completeExecutionInventory }) {
  return canonicalHash({ candidateSourceDigest, overlayManifestDigest, completeExecutionInventory });
}

function p5FileEntry(entry) {
  const { artifact: _artifact, ...file } = entry;
  return file;
}

function p5SameRef(left, right) { return canonicalHash(left) === canonicalHash(right); }

function p5ReadVerifiedSourceManifest(store, artifactRef, label) {
  store.verifyRef(artifactRef);
  const manifest = store.readJson(artifactRef.artifactId);
  validateP5Contract('sourceManifest', manifest);
  const entries = manifest.entries.map(entry => p5FileEntry(entry));
  assertUniquePortablePaths(entries);
  if (canonicalHash(entries) !== canonicalHash(sortEntries(entries)) || p5SourceDigest(entries) !== manifest.sourceDigest)
    p5Fail('p5_overlay_source_manifest_invalid', `The ${label} source manifest is unsorted, duplicated or has an invalid source digest.`);
  for (const entry of manifest.entries) {
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_overlay_source_object_invalid', `The ${label} object for "${entry.path}" does not match its source manifest.`);
  }
  return { manifest, entries, byPath: new Map(manifest.entries.map(entry => [entry.path, entry])) };
}

/** Validate the protected overlay and its complete Host-scanned execution inventory against sealed candidate and baseline objects. */
export function verifyP5OverlayManifest({ store, overlayManifestRef, candidateRef, check, execution = null }) {
  if (!store || !overlayManifestRef || !candidateRef || !check)
    p5Fail('p5_overlay_ineligible', 'P5 overlay verification requires the Store, exact candidate, overlay manifest and captured check.');
  store.verifyRef(candidateRef);
  const candidate = store.readJson(candidateRef.artifactId);
  validateP5Contract('candidate', candidate);
  store.verifyRef(candidate.baselineRef);
  store.verifyRef(overlayManifestRef);
  const manifest = store.readJson(overlayManifestRef.artifactId);
  validateP5Contract('overlayManifest', manifest);
  if (!Array.isArray(check.overlayPaths) || !check.overlayPaths.length || check.subjectBinding !== 'protected-overlay'
    || manifest.candidateId !== candidate.candidateId || manifest.candidateSourceDigest !== candidate.candidateSourceDigest
    || manifest.baselineId !== candidate.baselineId || manifest.checkId !== check.checkId
    || !p5SameRef(manifest.candidateManifest, candidateRef) || !p5SameRef(manifest.baselineManifest, candidate.baselineRef))
    p5Fail('p5_overlay_identity_mismatch', 'The protected overlay is not bound to the exact captured check and sealed candidate.');
  const overlayPaths = [...check.overlayPaths].map(validateP5SourcePath).sort(compareText);
  const overlayEntries = [...manifest.entries].sort((a, b) => compareText(a.path, b.path));
  if (new Set(overlayPaths).size !== overlayPaths.length
    || canonicalHash(overlayEntries.map(item => item.path)) !== canonicalHash(overlayPaths)
    || check.subjectEntryPoints.some(path => overlayPaths.includes(path)))
    p5Fail('p5_overlay_path_mismatch', 'The protected overlay paths differ from policy, duplicate a path or replace a declared candidate subject entrypoint.');

  const candidateSource = p5ReadVerifiedSourceManifest(store, candidate.sourceManifest, 'candidate');
  if (candidateSource.manifest.sourceDigest !== candidate.candidateSourceDigest)
    p5Fail('p5_overlay_candidate_digest_mismatch', 'The candidate source manifest digest differs from the sealed candidate identity.');
  const baseline = store.readJson(candidate.baselineRef.artifactId);
  validateP5Contract('baselineManifest', baseline);
  if (baseline.baselineId !== candidate.baselineId)
    p5Fail('p5_overlay_baseline_mismatch', 'The protected overlay baseline differs from the sealed candidate baseline.');
  const baselineSource = p5ReadVerifiedSourceManifest(store, baseline.sourceManifest, 'baseline');
  if (baselineSource.manifest.sourceDigest !== baseline.effectiveSourceDigest)
    p5Fail('p5_overlay_baseline_mismatch', 'The baseline source manifest digest differs from the enrolled baseline.');
  const executionByPath = new Map(candidateSource.entries.map(entry => [entry.path, entry]));
  for (const overlay of overlayEntries) {
    validateP5SourcePath(overlay.path);
    const candidateEntry = candidateSource.byPath.get(overlay.path) ?? null;
    const baselineEntry = baselineSource.byPath.get(overlay.path);
    if (!baselineEntry || canonicalHash(overlay.candidateBefore) !== canonicalHash(candidateEntry ? p5FileEntry(candidateEntry) : null)
      || canonicalHash(overlay.protectedReplacement) !== canonicalHash(p5FileEntry(baselineEntry))
      || !p5SameRef(overlay.protectedArtifact, baselineEntry.artifact))
      p5Fail('p5_overlay_object_mismatch', `Protected overlay entry "${overlay.path}" does not bind the candidate preimage and exact baseline object.`);
    executionByPath.set(overlay.path, p5FileEntry(baselineEntry));
  }
  const completeExecutionInventory = [...executionByPath.values()].sort((a, b) => compareText(a.path, b.path));
  assertUniquePortablePaths(completeExecutionInventory);
  if (canonicalHash(manifest.executionInventory) !== canonicalHash(completeExecutionInventory))
    p5Fail('p5_overlay_inventory_mismatch', 'The overlay manifest execution inventory is not the complete candidate tree with only protected baseline replacements.');

  const captureRef = manifest.executionTreeCapture;
  store.verifyRef(captureRef);
  const capture = store.readJson(captureRef.artifactId);
  validateP5Contract('executionTreeCaptureEvidence', capture);
  const totalBytes = completeExecutionInventory.reduce((sum, item) => sum + item.byteSize, 0);
  const expectedPathDigest = p5PathSetDigest(completeExecutionInventory.map(item => item.path));
  const expectedContentDigest = p5NativeContentDigest(completeExecutionInventory);
  const verifyRoot = resolve(candidate.workspace.canonicalRoot, '.p5', 'verify');
  const treeRoot = resolve(capture.rootPath);
  const treeRelative = relative(verifyRoot, treeRoot);
  if (!isAbsolute(capture.rootPath) || treeRelative === '' || treeRelative === '..' || treeRelative.startsWith(`..${sep}`) || isAbsolute(treeRelative)
    || capture.snapshotDigestBefore !== capture.snapshotDigestAfter || capture.pathDigest !== expectedPathDigest
    || capture.contentDigest !== expectedContentDigest || capture.fileCount !== completeExecutionInventory.length
    || capture.totalBytes !== totalBytes
    || execution && (capture.generation !== execution.lifecycleGeneration || capture.epoch !== execution.engineEpoch))
    p5Fail('p5_overlay_capture_mismatch', 'The protected execution-tree Host scan is incomplete, changed, out of slot or inconsistent with its complete inventory.');

  if (manifest.overlayManifestDigest !== p5OverlayManifestDigest(manifest)
    || manifest.materializationDigest !== p5OverlayMaterializationDigest({ candidateSourceDigest: candidate.candidateSourceDigest,
      overlayManifestDigest: manifest.overlayManifestDigest, completeExecutionInventory }))
    p5Fail('p5_overlay_digest_mismatch', 'The protected overlay or materialized execution-tree digest is invalid.');
  return { manifest, capture, completeExecutionInventory };
}

function p5AssertMaterializedTreeLayout(root, paths) {
  const expectedFiles = new Set(paths), expectedDirectories = new Set();
  for (const path of expectedFiles) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const actualFiles = new Set(), actualDirectories = new Set();
  const walk = (directory, relativeDirectory = '') => {
    for (const name of p5DirectoryEntries(directory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = join(directory, name);
      let info, canonical;
      try { info = lstatSync(absolute); canonical = realpathSync.native(absolute); }
      catch { p5Fail('p5_overlay_tree_conflict', `Derived path "${relativePath}" could not be inspected.`); }
      if (info.isDirectory() && !info.isSymbolicLink() && pathKey(canonical) === pathKey(absolute)) {
        if (!expectedDirectories.has(relativePath)) p5Fail('p5_overlay_tree_conflict', `The derived tree contains unexpected directory "${relativePath}".`);
        actualDirectories.add(relativePath);
        walk(absolute, relativePath);
      } else if (info.isFile() && !info.isSymbolicLink() && pathKey(canonical) === pathKey(absolute)) {
        if (!expectedFiles.has(relativePath)) p5Fail('p5_overlay_tree_conflict', `The derived tree contains unexpected file "${relativePath}".`);
        actualFiles.add(relativePath);
      } else p5Fail('p5_overlay_tree_conflict', `Derived path "${relativePath}" has an unsafe or unsupported type.`);
    }
  };
  let rootInfo, canonicalRoot;
  try { rootInfo = lstatSync(root); canonicalRoot = realpathSync.native(root); }
  catch { p5Fail('p5_overlay_tree_conflict', 'The derived execution root could not be inspected.'); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || pathKey(canonicalRoot) !== pathKey(root))
    p5Fail('p5_overlay_tree_conflict', 'The derived execution root is not a canonical ordinary directory.');
  walk(root);
  if (canonicalHash([...actualFiles].sort(compareText)) !== canonicalHash([...expectedFiles].sort(compareText))
    || canonicalHash([...actualDirectories].sort(compareText)) !== canonicalHash([...expectedDirectories].sort(compareText)))
    p5Fail('p5_overlay_tree_conflict', 'The derived execution tree does not contain the exact expected file and directory layout.');
}

/** Reconstruct one derived verification tree from Store objects, apply only captured baseline overlays, then Host-scan the complete tree. */
export async function materializeP5VerificationOverlay({ store, candidateRef, check, budgets,
  nativeSourceReader, identityReader = null, allowPartialReuse = false }) {
  if (!store || !candidateRef || !check || !budgets || typeof nativeSourceReader !== 'function')
    p5Fail('p5_overlay_materialization_unavailable', 'P5 overlay materialization requires the Store, exact candidate/check, source budgets and authenticated Host reader.');
  if (check.subjectBinding !== 'protected-overlay' || !Array.isArray(check.overlayPaths) || !check.overlayPaths.length
    || check.commandDigest !== p5VerificationCommandDigest(check))
    p5Fail('p5_overlay_policy_unsupported', 'P5 materialization accepts only an exact captured protected-overlay check.');
  store.verifyRef(candidateRef);
  const candidate = store.readJson(candidateRef.artifactId);
  validateP5Contract('candidate', candidate);
  const candidateSource = p5ReadVerifiedSourceManifest(store, candidate.sourceManifest, 'candidate');
  if (candidateSource.manifest.sourceDigest !== candidate.candidateSourceDigest)
    p5Fail('p5_overlay_candidate_digest_mismatch', 'The candidate source manifest digest differs from the sealed candidate identity.');
  store.verifyRef(candidate.baselineRef);
  const baseline = store.readJson(candidate.baselineRef.artifactId);
  validateP5Contract('baselineManifest', baseline);
  if (baseline.baselineId !== candidate.baselineId)
    p5Fail('p5_overlay_baseline_mismatch', 'The overlay materializer received a different baseline than the candidate.');
  const baselineSource = p5ReadVerifiedSourceManifest(store, baseline.sourceManifest, 'baseline');
  const overlayPaths = [...check.overlayPaths].map(validateP5SourcePath).sort(compareText);
  if (new Set(overlayPaths).size !== overlayPaths.length || check.subjectEntryPoints.some(path => overlayPaths.includes(path)))
    p5Fail('p5_overlay_path_mismatch', 'P5 protected overlays must be unique and cannot replace a declared candidate subject entrypoint.');

  const executionByPath = new Map(candidateSource.entries.map(entry => [entry.path, entry]));
  const entries = [];
  for (const path of overlayPaths) {
    const candidateEntry = candidateSource.byPath.get(path) ?? null;
    const baselineEntry = baselineSource.byPath.get(path);
    if (!baselineEntry) p5Fail('p5_overlay_baseline_object_missing', `The protected baseline has no object for overlay path "${path}".`);
    entries.push({ path, candidateBefore: candidateEntry ? p5FileEntry(candidateEntry) : null,
      protectedReplacement: p5FileEntry(baselineEntry), protectedArtifact: baselineEntry.artifact });
    executionByPath.set(path, p5FileEntry(baselineEntry));
  }
  const completeExecutionInventory = [...executionByPath.values()].sort((a, b) => compareText(a.path, b.path));
  assertUniquePortablePaths(completeExecutionInventory);
  const maxFiles = budgets.maxSourceFiles, maxBytes = budgets.maxSourceBytes;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || completeExecutionInventory.length > maxFiles
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || completeExecutionInventory.reduce((sum, item) => sum + item.byteSize, 0) > maxBytes)
    p5Fail('p5_overlay_budget_exceeded', 'The derived verification tree exceeds the enrolled source file or byte budget.');

  const slotRoot = realpathSync.native(resolve(candidate.workspace.canonicalRoot));
  const verifyRoot = p5EnsureDirectoryChain(slotRoot, ['.p5', 'verify']);
  const executionParent = p5EnsureDirectoryChain(verifyRoot, ['execution']);
  const executionRoot = join(executionParent, check.checkId);
  try { mkdirSync(executionRoot); }
  catch (error) {
    if (error.code !== 'EEXIST') p5Fail('p5_overlay_tree_create_failed', `P5 could not create a fresh derived verification tree (${error.code || 'error'}).`);
    if (!allowPartialReuse) p5Fail('p5_overlay_tree_conflict', 'A derived verification tree already occupies this check slot; automatic cleanup or overwrite is refused.');
    let info, canonical;
    try { info = lstatSync(executionRoot); canonical = realpathSync.native(executionRoot); }
    catch { p5Fail('p5_overlay_tree_conflict', 'The partial derived verification tree could not be safely inspected.'); }
    if (!info.isDirectory() || info.isSymbolicLink() || pathKey(canonical) !== pathKey(executionRoot))
      p5Fail('p5_overlay_tree_conflict', 'The partial derived verification root is not a canonical ordinary directory.');
  }
  const expectedByPath = new Map(completeExecutionInventory.map(item => [item.path, item]));
  for (const entry of completeExecutionInventory) {
    validateP5SourcePath(entry.path);
    const parent = dirname(resolve(executionRoot, ...entry.path.split('/')));
    const relativeParent = relative(executionRoot, parent);
    if (relativeParent && (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)))
      p5Fail('p5_overlay_path_escape', `Derived verification path "${entry.path}" escapes its enrolled execution tree.`);
    if (relativeParent) p5EnsureDirectoryChain(executionRoot, relativeParent.split(sep));
    const sourceEntry = executionByPath.get(entry.path);
    const artifact = entries.find(item => item.path === entry.path)?.protectedArtifact ?? candidateSource.byPath.get(entry.path)?.artifact;
    if (!artifact || !sourceEntry) p5Fail('p5_overlay_object_missing', `P5 has no sealed object for derived path "${entry.path}".`);
    store.verifyRef(artifact);
    const bytes = store.readBytes(artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_overlay_object_invalid', `The sealed object for derived path "${entry.path}" failed digest verification.`);
    const absolute = resolve(executionRoot, ...entry.path.split('/'));
    if (p5WriteExclusive(absolute, bytes)) {
      if (process.platform !== 'win32') chmodSync(absolute, entry.executable ? 0o755 : 0o644);
    } else {
      const existing = lstatSync(absolute, { bigint: true });
      if (!existing.isFile() || existing.isSymbolicLink())
        p5Fail('p5_overlay_tree_conflict', `Derived path "${entry.path}" is not a regular file.`);
      const existingBytes = readFileSync(absolute);
      if (existingBytes.length !== entry.byteSize || sha256(existingBytes) !== entry.sha256)
        p5Fail('p5_overlay_tree_conflict', `Derived path "${entry.path}" already contains different bytes.`);
    }
  }
  p5AssertMaterializedTreeLayout(executionRoot, completeExecutionInventory.map(entry => entry.path));
  const captured = await inventoryP5SourceWithHost(executionRoot, { nativeSourceReader,
    maxFiles, maxBytes, include: ['**'], exclude: [], identityReader,
    executableFor: path => expectedByPath.get(path)?.executable ?? false });
  if (canonicalHash(captured.entries) !== canonicalHash(completeExecutionInventory))
    p5Fail('p5_overlay_tree_mismatch', 'The Host-scanned derived tree differs from the exact candidate plus protected baseline overlays.');
  const evidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairExecutionTreeCaptureEvidence', rootPath: captured.root,
    rootIdentity: captured.nativeEvidence.rootIdentity, hostPid: captured.nativeEvidence.hostPid,
    generation: captured.nativeEvidence.generation, epoch: captured.nativeEvidence.epoch,
    snapshotDigestBefore: captured.nativeEvidence.snapshotDigest, snapshotDigestAfter: captured.nativeEvidence.snapshotDigest,
    pathDigest: captured.nativeEvidence.pathDigest, contentDigest: captured.nativeEvidence.contentDigest,
    fileCount: captured.entries.length, totalBytes: captured.totalBytes };
  validateP5Contract('executionTreeCaptureEvidence', evidence);
  const executionTreeCapture = asRef(store.putJson(evidence));
  const overlayManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairOverlayManifest', candidateId: candidate.candidateId,
    candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, checkId: check.checkId,
    candidateManifest: asRef(candidateRef), baselineManifest: candidate.baselineRef,
    entries, executionInventory: completeExecutionInventory, executionTreeCapture };
  overlayManifest.overlayManifestDigest = p5OverlayManifestDigest(overlayManifest);
  overlayManifest.materializationDigest = p5OverlayMaterializationDigest({ candidateSourceDigest: candidate.candidateSourceDigest,
    overlayManifestDigest: overlayManifest.overlayManifestDigest, completeExecutionInventory });
  validateP5Contract('overlayManifest', overlayManifest);
  const overlayManifestRef = asRef(store.putJson(overlayManifest));
  store.verifyRef(overlayManifestRef);
  verifyP5OverlayManifest({ store, overlayManifestRef, candidateRef, check });
  return { overlayManifest, overlayManifestRef, executionTreeCapture, executionTree: captured };
}

export const P5_BASELINE_TREE_DIRECTORY = '.baseline';

/**
 * P5-CLOSURE §6.3: the installed baseline B as an isolated execution tree for the causal reproducer, reconstructed only from the
 * enrolled baseline source objects (the exact installed commit, verified against its manifest), never from a mutable directory.
 * The protected test files are baseline objects already, so B is the complete baseline source. The tree is Host-scanned.
 */
export async function materializeP5BaselineReproducerTree({ store, candidateRef, check, budgets, nativeSourceReader,
  identityReader = null, allowPartialReuse = false }) {
  if (!store || !candidateRef || !check || !budgets || typeof nativeSourceReader !== 'function' || check.subjectBinding !== 'protected-overlay'
    || check.commandDigest !== p5VerificationCommandDigest(check))
    p5Fail('p5_baseline_tree_unavailable', 'P5 baseline reproduction requires the Store, exact candidate, a captured protected-overlay check, budgets and the Host reader.');
  store.verifyRef(candidateRef);
  const candidate = store.readJson(candidateRef.artifactId);
  validateP5Contract('candidate', candidate);
  store.verifyRef(candidate.baselineRef);
  const baseline = store.readJson(candidate.baselineRef.artifactId);
  validateP5Contract('baselineManifest', baseline);
  if (baseline.baselineId !== candidate.baselineId)
    p5Fail('p5_baseline_tree_mismatch', 'The baseline reproduction tree received a different baseline than the candidate.');
  const baselineSource = p5ReadVerifiedSourceManifest(store, baseline.sourceManifest, 'baseline');
  if (baselineSource.manifest.sourceDigest !== baseline.effectiveSourceDigest)
    p5Fail('p5_baseline_tree_mismatch', 'The baseline source manifest digest differs from the enrolled baseline.');
  for (const path of [...check.subjectEntryPoints, ...check.overlayPaths])
    if (!baselineSource.byPath.has(validateP5SourcePath(path)))
      p5Fail('p5_baseline_tree_subject_missing', `The installed baseline has no source object for reproducer path "${path}".`);
  const inventory = baselineSource.entries;
  if (inventory.length > budgets.maxSourceFiles || inventory.reduce((sum, item) => sum + item.byteSize, 0) > budgets.maxSourceBytes)
    p5Fail('p5_baseline_tree_budget_exceeded', 'The baseline reproduction tree exceeds the enrolled source file or byte budget.');
  const slotRoot = realpathSync.native(resolve(candidate.workspace.canonicalRoot));
  const parent = p5EnsureDirectoryChain(slotRoot, ['.p5', 'verify', 'execution', P5_BASELINE_TREE_DIRECTORY]);
  const root = join(parent, check.checkId);
  try { mkdirSync(root); }
  catch (error) {
    if (error.code !== 'EEXIST') p5Fail('p5_baseline_tree_create_failed', `P5 could not create the baseline reproduction tree (${error.code || 'error'}).`);
    if (!allowPartialReuse) p5Fail('p5_baseline_tree_conflict', 'A baseline reproduction tree already occupies this check slot; overwrite or cleanup is refused.');
  }
  for (const entry of inventory) {
    const target = resolve(root, ...entry.path.split('/'));
    const relativeParent = relative(root, dirname(target));
    if (relativeParent && (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)))
      p5Fail('p5_overlay_path_escape', `Baseline path "${entry.path}" escapes its reproduction tree.`);
    if (relativeParent) p5EnsureDirectoryChain(root, relativeParent.split(sep));
    const artifact = baselineSource.byPath.get(entry.path).artifact;
    store.verifyRef(artifact);
    const bytes = store.readBytes(artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_baseline_tree_object_invalid', `The baseline object for "${entry.path}" failed digest verification.`);
    if (p5WriteExclusive(target, bytes)) {
      if (process.platform !== 'win32') chmodSync(target, entry.executable ? 0o755 : 0o644);
    } else {
      const existing = readFileSync(target);
      if (existing.length !== entry.byteSize || sha256(existing) !== entry.sha256)
        p5Fail('p5_baseline_tree_conflict', `Baseline reproduction path "${entry.path}" already contains different bytes.`);
    }
  }
  p5AssertMaterializedTreeLayout(root, inventory.map(entry => entry.path));
  const byPath = new Map(inventory.map(entry => [entry.path, entry]));
  const captured = await inventoryP5SourceWithHost(root, { nativeSourceReader, maxFiles: budgets.maxSourceFiles,
    maxBytes: budgets.maxSourceBytes, include: ['**'], exclude: [], identityReader, executableFor: path => byPath.get(path)?.executable ?? false });
  if (canonicalHash(captured.entries) !== canonicalHash(inventory))
    p5Fail('p5_baseline_tree_mismatch', 'The Host-scanned baseline reproduction tree differs from the exact enrolled baseline source.');
  const evidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairExecutionTreeCaptureEvidence', rootPath: captured.root,
    rootIdentity: captured.nativeEvidence.rootIdentity, hostPid: captured.nativeEvidence.hostPid,
    generation: captured.nativeEvidence.generation, epoch: captured.nativeEvidence.epoch,
    snapshotDigestBefore: captured.nativeEvidence.snapshotDigest, snapshotDigestAfter: captured.nativeEvidence.snapshotDigest,
    pathDigest: captured.nativeEvidence.pathDigest, contentDigest: captured.nativeEvidence.contentDigest,
    fileCount: captured.entries.length, totalBytes: captured.totalBytes };
  validateP5Contract('executionTreeCaptureEvidence', evidence);
  return { root: captured.root, capture: asRef(store.putJson(evidence)), inventory, inventoryDigest: canonicalHash(inventory),
    baselineCommit: baseline.baseCommit, baselineSourceDigest: baseline.effectiveSourceDigest,
    subject: { path: check.subjectEntryPoints[0], sha256: byPath.get(check.subjectEntryPoints[0]).sha256 } };
}

// Every sensitive tier is verified by required checks only, at least one of which runs a protected test from the installed
// baseline over the candidate (a candidate cannot replace it). Repair-authority and Custody-integration tiers are at least as
// strict as the Engine-core tier, so a more sensitive change can never need fewer checks.
function assertP5MutationTiers(policy) {
  const tiers = policy.mutationTiers ?? [];
  const byId = new Map(tiers.map(tier => [tier.tierId, tier]));
  const definitions = new Map(policy.checks.map(check => [check.checkId, check]));
  if (byId.size !== tiers.length || tiers.some(tier => !P5_SENSITIVE_TIERS.includes(tier.tierId)))
    p5Fail('p5_policy_tier_invalid', 'P5 verification tiers must be unique known Engine tiers.');
  for (const tier of tiers) {
    if (tier.requiredCheckIds.some(id => !policy.requiredCheckIds.includes(id)))
      p5Fail('p5_policy_tier_invalid', `P5 tier "${tier.tierId}" may name only required checks of the captured policy.`);
    if (!tier.requiredCheckIds.some(id => definitions.get(id)?.subjectBinding === 'protected-overlay'))
      p5Fail('p5_policy_tier_invalid', `P5 tier "${tier.tierId}" requires at least one protected-overlay check.`);
  }
  const core = byId.get('engine-core')?.requiredCheckIds ?? [];
  for (const tierId of ['repair-authority', 'engine-custody'])
    if (byId.has(tierId) && core.some(id => !byId.get(tierId).requiredCheckIds.includes(id)))
      p5Fail('p5_policy_tier_invalid', `P5 tier "${tierId}" must include every engine-core check.`);
  // Review R6: Engine-side Custody code is imported by the trusted control closure, so it is verified at least as strictly.
  const authority = byId.get('repair-authority')?.requiredCheckIds ?? [];
  if (byId.has('engine-custody') && authority.some(id => !byId.get('engine-custody').requiredCheckIds.includes(id)))
    p5Fail('p5_policy_tier_invalid', 'P5 tier "engine-custody" must include every repair-authority check.');
}

function assertP5PolicyCommands(policy) {
  const checkIds = policy.checks.map(check => check.checkId);
  const expectedRequired = policy.checks.filter(check => check.required).map(check => check.checkId).sort(compareText);
  const expectedOptional = policy.checks.filter(check => !check.required).map(check => check.checkId).sort(compareText);
  const requiredStages = [...new Set(policy.checks.filter(check => check.required).map(check => check.stageId))].sort(compareText);
  if (new Set(checkIds).size !== checkIds.length || canonicalHash([...policy.requiredCheckIds].sort(compareText)) !== canonicalHash(expectedRequired)
    || canonicalHash([...policy.optionalCheckIds].sort(compareText)) !== canonicalHash(expectedOptional)
    || canonicalHash([...policy.requiredStages].sort(compareText)) !== canonicalHash(requiredStages))
    p5Fail('p5_policy_check_set_mismatch', 'P5 required/optional check sets and required stages must exactly match the captured check definitions.');
  for (const check of policy.checks) {
    if (check.commandDigest !== p5VerificationCommandDigest(check))
      p5Fail('p5_policy_command_mismatch', `P5 verification command digest for "${check.checkId}" is invalid.`);
  }
}

export function assertP5VerificationPolicy(policy) {
  validateP5Contract('verificationPolicy', policy);
  assertP5PolicyCommands(policy);
  if (policy.incidentInputSelectors.length !== 1 || policy.incidentInputSelectors[0].selector !== 'p3-outcome-artifacts'
    || policy.incidentInputSelectors[0].source !== 'p3-outcome-artifacts')
    p5Fail('p5_policy_input_selector_unsupported', 'This P5 reader supports only the captured selector for artifact references on the exact P3 outcome.');
  if (policy.checks.some(check => Object.hasOwn(check.environment, P5_VERIFICATION_INPUT_MANIFEST_ENV)))
    p5Fail('p5_policy_reserved_environment', `P5 verification policy cannot set the Engine-reserved ${P5_VERIFICATION_INPUT_MANIFEST_ENV} environment variable.`);
  if (policy.checks.some(check => Object.hasOwn(check.environment, P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV)))
    p5Fail('p5_policy_reserved_environment', `P5 verification policy cannot set the Engine-reserved ${P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV} environment variable.`);
  for (const check of policy.checks.filter(item => item.subjectBinding === 'candidate-entrypoint')) {
    if (check.overlayPaths.length || check.expectedAssertions.length !== 1
      || check.expectedAssertions[0] !== 'candidate-entrypoint-syntax')
      p5Fail('p5_policy_candidate_entrypoint_unsupported', 'The installed P5 candidate-entrypoint driver supports only an independent candidate source syntax assertion without overlays.');
  }
  assertP5MutationTiers(policy);
  // P5-CLOSURE §6: causal reproduction names one required protected reproducer and how the installed baseline must answer it:
  // the harness assertions pass (the captured incident was loaded and recognized) and the defect assertions fail.
  const causal = policy.causalReproduction;
  if (causal) {
    const check = policy.checks.find(item => item.checkId === causal.checkId);
    const assertions = new Set(check?.expectedAssertions ?? []);
    if (!check || !check.required || check.subjectBinding !== 'protected-overlay'
      || [...causal.baselineMustPass, ...causal.baselineMustFail].some(name => !assertions.has(name))
      || causal.baselineMustPass.some(name => causal.baselineMustFail.includes(name)))
      p5Fail('p5_policy_causality_invalid', 'P5 causal reproduction must name a required protected-overlay check and two disjoint subsets of its exact assertions.');
  }
  return canonicalHash(policy);
}

function p5IncidentKey(value) { return typeof value === 'string' ? value.replaceAll('_', '-') : ''; }

/** Capture the policy-selected artifacts from one exact current P3 outcome before Developer admission. */
export function captureP5VerificationInputs({ store, enrollment, profile, parentRunId, incidentId, outcome, persist = true, capturedAt = new Date().toISOString() }) {
  if (!store || !enrollment || !profile || !parentRunId || !outcome || !incidentId)
    p5Fail('p5_verification_inputs_invalid', 'P5 verification-input capture requires the enrolled profile and exact P3 outcome.');
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('profile', profile);
  const currentOutcomeRow = store.get('SELECT revision, outcome_json FROM failure_outcomes WHERE outcome_id = ? AND run_id = ?', outcome.outcomeId, parentRunId);
  if (!currentOutcomeRow || currentOutcomeRow.revision !== outcome.revision
    || canonicalHash(parseStrictJson(currentOutcomeRow.outcome_json)) !== canonicalHash(outcome))
    p5Fail('p5_verification_input_stale', 'P5 requires the exact current P3 outcome row from the enrolled Parent Run.');
  const policyRef = enrollment.verificationPolicy;
  store.verifyRef(policyRef);
  const policy = store.readJson(policyRef.artifactId);
  assertP5VerificationPolicy(policy);
  const eligible = profile.eligibleIncidents.some(item => item.category === p5IncidentKey(outcome.category)
    && item.canonicalCode === p5IncidentKey(outcome.canonicalCode));
  if (!eligible || outcome.outcomeId == null || !Number.isSafeInteger(outcome.revision) || outcome.revision < 1
    || outcome.executionCertainty === 'unresolved' || outcome.executionCertainty === 'unknown')
    p5Fail('p5_incident_ineligible', 'The exact P3 outcome is not eligible under the enrolled P5 profile or has uncertain execution.');
  const selector = policy.incidentInputSelectors[0];
  const artifactRefs = new Map();
  for (const source of outcome.evidenceReferences || []) {
    if (source.type !== 'artifact' || typeof source.id !== 'string') continue;
    const row = store.artifactRow(source.id);
    if (!row || source.sha256 && source.sha256 !== row.sha256)
      p5Fail('p5_verification_input_mismatch', 'A selected P3 evidence artifact is missing or has changed digest.');
    const verified = store.verifyRef({ artifactId: row.id, sha256: row.sha256 });
    if (row.byte_size > selector.maxBytesPerArtifact)
      p5Fail('p5_verification_input_limit', 'A selected P3 evidence artifact exceeds the enrolled per-artifact verification-input limit.');
    artifactRefs.set(row.id, { artifact: verified, byteSize: row.byte_size });
  }
  if (!artifactRefs.size || artifactRefs.size > selector.maxItems)
    p5Fail('p5_verification_input_missing', 'The exact P3 outcome does not provide the bounded artifact evidence selected by the enrolled verification policy.');
  const inputs = [...artifactRefs.entries()].sort(([left], [right]) => compareText(left, right)).map(([artifactId, item]) => ({
    selector: selector.selector, artifact: item.artifact, sourceOutcomeId: outcome.outcomeId, sourceRevision: outcome.revision,
  }));
  const totalBytes = [...artifactRefs.values()].reduce((sum, item) => sum + item.byteSize, 0);
  if (totalBytes > selector.maxTotalBytes) p5Fail('p5_verification_input_limit', 'Selected P3 evidence exceeds the enrolled aggregate verification-input limit.');
  const record = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationInputs', incidentId, outcomeId: outcome.outcomeId,
    outcomeRevision: outcome.revision, verificationPolicy: policyRef, inputs, capturedAt };
  validateP5Contract('verificationInputs', record);
  if (!persist) return { record, artifact: null };
  const artifact = store.putJson(record);
  store.verifyRef(artifact);
  return { record, artifact: asRef(artifact) };
}

/** Re-derive the exact selected P3 artifact set at each later authority boundary. */
export function verifyP5VerificationInputsCurrent({ store, enrollment, profile, parentRunId, inputs }) {
  validateP5Contract('verificationInputs', inputs);
  const row = store?.get('SELECT revision, outcome_json FROM failure_outcomes WHERE outcome_id = ? AND run_id = ?', inputs.outcomeId, parentRunId);
  if (!row || row.revision !== inputs.outcomeRevision)
    p5Fail('p5_verification_input_stale', 'The captured P3 verification-input outcome is no longer the current Parent outcome revision.');
  const outcome = parseStrictJson(row.outcome_json);
  const recaptured = captureP5VerificationInputs({ store, enrollment, profile, parentRunId, incidentId: inputs.incidentId,
    outcome, persist: false, capturedAt: inputs.capturedAt });
  if (canonicalHash(recaptured.record) !== canonicalHash(inputs))
    p5Fail('p5_verification_input_mismatch', 'The durable verification-input artifact does not match the exact policy-selected P3 evidence.');
  return outcome;
}

function nativeIdentity(path, info, identityReader, { directory = false, hostIdentityProven = false } = {}) {
  if (process.platform === 'win32' && typeof identityReader !== 'function' && !hostIdentityProven)
    p5Fail('p5_native_identity_unavailable', 'P5 refuses Windows source capture until a trusted native volume/file/reparse identity reader is installed.');
  const native = typeof identityReader === 'function' ? identityReader(path) : null;
  if (native && (native.reparsePoint !== false || (!directory && native.linkCount !== 1) || !native.volumeId || !native.fileId))
    p5Fail('p5_topology_unsupported', `P5 cannot establish a regular single-link filesystem identity for "${path}".`);
  if (info.isSymbolicLink() || (!directory && Number(info.nlink) !== 1))
    p5Fail('p5_topology_unsupported', `P5 rejects links, reparse points and hardlinked source files: "${path}".`);
  if (!native && !hostIdentityProven && (!Number.isSafeInteger(Number(info.dev)) || !Number.isSafeInteger(Number(info.ino)) || Number(info.ino) === 0))
    p5Fail('p5_native_identity_unavailable', `P5 cannot establish a stable file identity for "${path}".`);
  // This token is only a path-stability placeholder for the synchronous walk. A caller may set
  // hostIdentityProven only inside inventoryP5SourceWithHost, which brackets the byte walk with
  // two authenticated native scans and compares their content and topology digests.
  if (hostIdentityProven && !native) return { volumeId: 'host-attested', fileId: pathKey(path) };
  return native ? { volumeId: String(native.volumeId), fileId: String(native.fileId) }
    : { volumeId: String(info.dev), fileId: String(info.ino) };
}

function assertNoRedirectedAncestors(root, identityReader, hostIdentityProven = false) {
  let current = resolve(root);
  while (true) {
    let info;
    try { info = lstatSync(current, { bigint: true }); } catch { p5Fail('p5_workspace_unavailable', 'A P5 source-root ancestor cannot be inspected.'); }
    nativeIdentity(current, info, identityReader, { directory: true, hostIdentityProven });
    if (!info.isDirectory() || info.isSymbolicLink()) p5Fail('p5_topology_unsupported', 'A P5 source-root ancestor is not a stable real directory.');
    const parent = resolve(current, '..');
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Bounded, no-follow inventory used by P5 capture and drift checks. Windows callers must
 * supply the installed native identity reader; pathname/lstat checks alone are insufficient.
 */
function p5MayContainIncluded(path, include) {
  return !include.length || include.some(selector => p5SelectorMayMatchDescendant(path, selector));
}

function pathIsExcluded(path, excluded) {
  return p5SelectorMatches(path, excluded) || excluded.some(item => item.endsWith('/**') && path.startsWith(`${item.slice(0, -3)}/`));
}

export function inventoryP5Source(root, { maxFiles = 20_000, maxBytes = 512 * 1024 * 1024,
  excluded = ['.git/**', '.p5/**'], include = ['**'], identityReader = null, executableFor = null, hostIdentityProven = false } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
    p5Fail('p5_budget_invalid', 'P5 source inventory budgets must be finite nonnegative integers.');
  assertNoRedirectedAncestors(root, identityReader, hostIdentityProven);
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(resolve(root)); } catch { p5Fail('p5_workspace_unavailable', 'P5 source root cannot be resolved.'); }
  const rootInfo = lstatSync(canonicalRoot, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) p5Fail('p5_topology_unsupported', 'P5 source root must be a real directory.');
  const rootIdentity = nativeIdentity(canonicalRoot, rootInfo, identityReader, { directory: true, hostIdentityProven });
  const entries = [], identities = [{ path: '.', ...rootIdentity }];
  const seenCase = new Map(); let totalBytes = 0;
  const walk = (directory, relativeDirectory) => {
    const beforeDirectory = lstatSync(directory, { bigint: true });
    const identityBefore = nativeIdentity(directory, beforeDirectory, identityReader, { directory: true, hostIdentityProven });
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) p5Fail('p5_topology_unsupported', `P5 source directory changed topology: "${directory}".`);
    const names = readdirSync(directory).sort(compareText);
    const namesAfterEnumeration = readdirSync(directory).sort(compareText);
    if (canonicalHash(names) !== canonicalHash(namesAfterEnumeration)) p5Fail('p5_source_drift', `P5 source directory entries changed during enumeration: "${directory}".`);
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (pathIsExcluded(relativePath, excluded) || !p5MayContainIncluded(relativePath, include)) continue;
      validateP5SourcePath(relativePath);
      const folded = relativePath.toLowerCase();
      const priorCase = seenCase.get(folded);
      if (priorCase && priorCase !== relativePath) p5Fail('p5_case_collision', `P5 source paths "${priorCase}" and "${relativePath}" alias on Windows.`);
      seenCase.set(folded, relativePath);
      const absolutePath = resolve(directory, name);
      const info = lstatSync(absolutePath, { bigint: true });
      if (info.isDirectory()) { const identity = nativeIdentity(absolutePath, info, identityReader, { directory: true, hostIdentityProven }); identities.push({ path: relativePath, ...identity }); walk(absolutePath, relativePath); continue; }
      if (!info.isFile()) p5Fail('p5_topology_unsupported', `P5 source entry is not a regular file: "${relativePath}".`);
      if (!p5SelectorMatches(relativePath, include) || pathIsExcluded(relativePath, excluded)) continue;
      const identity = nativeIdentity(absolutePath, info, identityReader, { hostIdentityProven });
      if (entries.length >= maxFiles) p5Fail('p5_source_budget_exceeded', 'The P5 source file-count budget was exceeded.');
      const byteSize = Number(info.size);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxBytes - totalBytes)
        p5Fail('p5_source_budget_exceeded', 'The P5 source byte budget was exceeded.');
      const bytes = readFileSync(absolutePath);
      const after = lstatSync(absolutePath, { bigint: true });
      const afterIdentity = nativeIdentity(absolutePath, after, identityReader, { hostIdentityProven });
      if (bytes.length !== byteSize || after.size !== info.size || after.mtimeNs !== info.mtimeNs
        || afterIdentity.fileId !== identity.fileId || afterIdentity.volumeId !== identity.volumeId)
        p5Fail('p5_source_drift', `P5 source changed while it was being read: "${relativePath}".`);
      totalBytes += bytes.length;
      const executable = typeof executableFor === 'function' ? executableFor(relativePath, info)
        : process.platform === 'win32' ? null : (Number(info.mode) & 0o111) !== 0;
      if (typeof executable !== 'boolean') p5Fail('p5_mode_unavailable', `P5 cannot establish the committed executable bit for "${relativePath}".`);
      entries.push({ path: relativePath, type: 'regular', byteSize: bytes.length, sha256: sha256(bytes), executable });
    }
    const afterDirectory = lstatSync(directory, { bigint: true });
    const identityAfter = nativeIdentity(directory, afterDirectory, identityReader, { directory: true, hostIdentityProven });
    if (identityAfter.fileId !== identityBefore.fileId || identityAfter.volumeId !== identityBefore.volumeId)
      p5Fail('p5_source_drift', `P5 source directory changed while it was enumerated: "${directory}".`);
  };
  walk(canonicalRoot, '');
  const sorted = sortEntries(entries);
  assertUniquePortablePaths(sorted);
  return { root: canonicalRoot, rootIdentity, identities: identities.sort((a, b) => compareText(a.path, b.path)),
    entries: sorted, sourceDigest: p5SourceDigest(sorted), totalBytes };
}

function selectorMatches(path, selectors = []) {
  return selectors.some(selector => selector.endsWith('/**') ? path.startsWith(selector.slice(0, -2)) : path === selector);
}

function deriveChanges(baselineEntries, candidateEntries) {
  const before = new Map(baselineEntries.map(entry => [entry.path, entry]));
  const after = new Map(candidateEntries.map(entry => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);
  return paths.flatMap(path => {
    const oldEntry = before.get(path) || null, newEntry = after.get(path) || null;
    if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256 && oldEntry.byteSize === newEntry.byteSize && oldEntry.executable === newEntry.executable) return [];
    return [{ path, operation: !oldEntry ? 'add' : !newEntry ? 'delete' : 'modify', before: oldEntry, after: newEntry }];
  });
}

function assertScope(changes, scope) {
  for (const change of changes) {
    if (selectorMatches(change.path, scope?.denied ?? [])) p5Fail('p5_scope_violation', `P5 explicitly denies changes to "${change.path}".`);
    const selectors = scope?.[change.operation];
    if (!Array.isArray(selectors) || !selectorMatches(change.path, selectors))
      p5Fail('p5_scope_violation', `P5 does not authorize ${change.operation} of "${change.path}".`);
    const executableChange = change.before && change.after
      ? change.before.executable !== change.after.executable
      : Boolean(change.after?.executable || change.before?.executable);
    if (executableChange && !selectorMatches(change.path, scope?.executable ?? []))
      p5Fail('p5_metadata_violation', `P5 does not authorize an executable-bit change for "${change.path}".`);
  }
}

/** Stage verified source objects and candidate records. The caller commits refs/events in its Store transaction. */
export async function sealP5Candidate({ store, sourceRoot, baseline, authorization, budgets, identityReader = null,
  nativeSourceReader = null, executableFor = null }) {
  if (!store || !baseline || !authorization || !budgets) p5Fail('p5_candidate_invalid', 'P5 candidate capture requires a Store, baseline, authorization and captured budgets.');
  if (authorization.developerTerminal?.processTreeEnded !== true || authorization.developerTerminal?.spoolComplete !== true)
    p5Fail('p5_developer_unsettled', 'P5 cannot capture a candidate before complete Host-backed Developer tree termination.');
  if (authorization.linkId == null || authorization.candidateOrdinal !== undefined && authorization.candidateOrdinal !== 1)
    p5Fail('p5_candidate_invalid', 'P5 captures only the first candidate for an authorized P2 link.');
  if (!baseline.baselineManifest) p5Fail('p5_baseline_manifest_missing', 'P5 candidate capture requires the exact enrolled baseline manifest.');
  for (const ref of [authorization.enrollment, baseline.baselineManifest, baseline.sourceManifest, authorization.selfRepairProfile, authorization.verificationPolicy,
    authorization.verificationInputs, authorization.sourceBinding, authorization.developerTerminal.artifact])
    store.verifyRef(ref);
  const enrollment = store.readJson(authorization.enrollment.artifactId);
  const profile = store.readJson(authorization.selfRepairProfile.artifactId);
  const policy = store.readJson(authorization.verificationPolicy.artifactId);
  const inputs = store.readJson(authorization.verificationInputs.artifactId);
  const sourceBinding = store.readJson(authorization.sourceBinding.artifactId);
  const terminalArtifact = store.readJson(authorization.developerTerminal.artifact.artifactId);
  const baselineRecord = store.readJson(baseline.baselineManifest.artifactId);
  const baselineSource = store.readJson(baseline.sourceManifest.artifactId);
  validateP5Contract('profile', profile);
  assertP5VerificationPolicy(policy);
  validateP5Contract('verificationInputs', inputs);
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('sourceBinding', sourceBinding);
  validateP5Contract('baselineManifest', baselineRecord);
  validateP5Contract('sourceManifest', baselineSource);
  if (canonicalHash(profile) !== authorization.selfRepairProfile.sha256
    || canonicalHash(enrollment) !== authorization.enrollment.sha256
    || canonicalHash(policy) !== authorization.verificationPolicy.sha256
    || canonicalHash(inputs) !== authorization.verificationInputs.sha256
    || canonicalHash(sourceBinding) !== authorization.sourceBinding.sha256
    || canonicalHash(baselineRecord.sourceManifest) !== canonicalHash(baseline.sourceManifest))
    p5Fail('p5_artifact_mismatch', 'The P5 candidate authorization references do not match the stored immutable artifact contents.');
  const baselineEntries = baselineSource.entries.map(({ artifact: _artifact, ...entry }) => entry);
  for (const entry of baselineSource.entries) {
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_baseline_object_mismatch', `The enrolled source object for "${entry.path}" does not match its manifest.`);
  }
  const recomputedBaselineId = p5BaselineId({ repositoryIdentity: baselineRecord.repositoryIdentity,
    gitObjectFormat: baselineRecord.gitObjectFormat, baseCommit: baselineRecord.baseCommit, baseTree: baselineRecord.baseTree,
    pathPolicyDigest: baselineRecord.pathPolicyDigest, effectiveSourceDigest: baselineRecord.effectiveSourceDigest });
  if (baselineRecord.baselineId !== baseline.baselineId || baselineRecord.effectiveSourceDigest !== baseline.sourceDigest
    || baselineSource.sourceDigest !== baseline.sourceDigest || p5SourceDigest(baselineEntries) !== baseline.sourceDigest
    || canonicalHash(baselineEntries) !== canonicalHash(baseline.entries) || recomputedBaselineId !== baseline.baselineId
    || baselineRecord.baseCommit !== baseline.baseCommit || canonicalHash(baselineRecord.repositoryIdentity) !== canonicalHash(baseline.repositoryIdentity)
    || canonicalHash(baseline.excludedPaths) !== canonicalHash(baselineRecord.excludedPaths))
    p5Fail('p5_baseline_mismatch', 'The caller-supplied baseline entries or identity differ from the enrolled immutable baseline artifacts.');
  const refEqual = (left, right) => canonicalHash(left) === canonicalHash(right);
  if (!refEqual(profile.baseline, baseline.baselineManifest)
    || !refEqual(enrollment.baselineManifest, baseline.baselineManifest)
    || !refEqual(enrollment.profile, authorization.selfRepairProfile)
    || !refEqual(enrollment.verificationPolicy, authorization.verificationPolicy)
    || !refEqual(enrollment.runningSourceRelease, baselineRecord.runningSourceRelease)
    || enrollment.enrollmentId !== profile.enrollmentId || enrollment.repositoryIdentity.enrollmentId !== enrollment.enrollmentId
    || baselineRecord.enrollmentId !== enrollment.enrollmentId || baselineRecord.repositoryIdentity.enrollmentId !== enrollment.enrollmentId
    || enrollment.baselineId !== baseline.baselineId
    || canonicalHash(enrollment.repositoryIdentity) !== canonicalHash(baseline.repositoryIdentity)
    || enrollment.baseCommit !== baseline.baseCommit || enrollment.baseTree !== baseline.baseTree
    || enrollment.gitObjectFormat !== baseline.gitObjectFormat || enrollment.effectiveSourceDigest !== baseline.sourceDigest
    || enrollment.workspace.workspaceId !== authorization.workspace?.workspaceId
    || enrollment.workspace.allocationId !== authorization.workspace?.allocationId
    || enrollment.workspace.canonicalRoot !== authorization.workspace?.canonicalRoot
    || canonicalHash(enrollment.workspace.nativeIdentity) !== canonicalHash(authorization.workspace?.nativeIdentity)
    || canonicalHash(enrollment.scope) !== canonicalHash(authorization.scope)
    || canonicalHash(enrollment.budgets) !== canonicalHash(budgets)
    || enrollment.harnessClosureDigest !== policy.harnessClosureDigest
    || !refEqual(profile.runningSourceRelease, baselineRecord.runningSourceRelease)
    || !refEqual(profile.verificationPolicy, authorization.verificationPolicy)
    || !refEqual(profile.repairPublication, authorization.repairPublication)
    || profile.enrollmentId !== sourceBinding.enrollmentId || profile.baselineId !== baseline.baselineId
    || canonicalHash(profile.repositoryIdentity) !== canonicalHash(baseline.repositoryIdentity)
    || profile.developerNodeId !== authorization.developerNodeId
    || profile.workspace.workspaceId !== authorization.workspace?.workspaceId
    || profile.workspace.allocationId !== authorization.workspace?.allocationId
    || profile.workspace.canonicalRoot !== authorization.workspace?.canonicalRoot
    || canonicalHash(profile.scope) !== canonicalHash(authorization.scope)
    || canonicalHash(profile.budgets) !== canonicalHash(budgets)
    || canonicalHash(profile.requiredCheckIds) !== canonicalHash(policy.requiredCheckIds)
    || inputs.incidentId !== authorization.incidentId || inputs.outcomeId !== authorization.outcomeId
    || inputs.outcomeRevision !== authorization.outcomeRevision || !refEqual(inputs.verificationPolicy, authorization.verificationPolicy)
    || sourceBinding.parentRunId !== authorization.parentRunId || sourceBinding.baselineId !== baseline.baselineId
    || !refEqual(sourceBinding.parentPublication, authorization.parentPublication)
    || !refEqual(sourceBinding.baselineManifest, profile.baseline) || !refEqual(sourceBinding.profile, authorization.selfRepairProfile)
    || !refEqual(sourceBinding.runningSourceRelease, profile.runningSourceRelease)
    || terminalArtifact.attemptId !== authorization.developerAttemptId
    || terminalArtifact.processTreeEnded !== authorization.developerTerminal.processTreeEnded
    || terminalArtifact.spoolComplete !== authorization.developerTerminal.spoolComplete
    || (terminalArtifact.kind === 'ProtectedSelfRepairDeveloperTerminalEvidence' ? terminalArtifact.state : terminalArtifact.status) !== authorization.developerTerminal.status
    || terminalArtifact.exitCode !== authorization.developerTerminal.exitCode)
    p5Fail('p5_authorization_mismatch', 'The P5 candidate authorization differs from its enrolled profile, source binding, incident inputs or Developer terminal artifact.');
  if (!authorization.workspace?.canonicalRoot || !p5RootIsInsideSlot(sourceRoot, authorization.workspace.canonicalRoot))
    p5Fail('p5_workspace_binding_mismatch', 'The P5 candidate source is outside its enrolled workspace allocation.');
  const workspacePath = resolve(authorization.workspace.canonicalRoot);
  const workspaceNativeBefore = await readP5NativeIdentity(nativeSourceReader, { root: workspacePath });
  const workspaceIdentity = workspaceNativeBefore.rootIdentity;
  if (canonicalHash(workspaceIdentity) !== canonicalHash(authorization.workspace.nativeIdentity))
    p5Fail('p5_workspace_identity_mismatch', 'The physical P5 workspace allocation identity changed.');
  const expectedSourceRoot = resolve(workspacePath, 'source');
  const actualSourceRoot = realpathSync.native(resolve(sourceRoot));
  const normalizedExpectedSourceRoot = realpathSync.native(expectedSourceRoot);
  const sameRoot = process.platform === 'win32'
    ? actualSourceRoot.toLowerCase() === normalizedExpectedSourceRoot.toLowerCase()
    : actualSourceRoot === normalizedExpectedSourceRoot;
  if (!sameRoot) p5Fail('p5_workspace_binding_mismatch', 'P5 candidate capture is bound only to the exact enrolled <slot>/source directory.');
  const baselineModes = new Map(baseline.entries.map(entry => [entry.path, entry.executable]));
  const modeResolver = executableFor || (process.platform === 'win32' ? path => baselineModes.get(path) ?? false : null);
  const options = { maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes,
    include: baselineRecord.pathPolicy.include, exclude: baselineRecord.pathPolicy.exclude, identityReader, executableFor: modeResolver };
  const captured = await inventoryP5SourceWithHost(sourceRoot, { ...options, nativeSourceReader });
  const secretSelectors = [...DEFAULT_SECRET_PATHS, ...baselineRecord.pathPolicy.secretPaths];
  if (captured.entries.some(entry => p5SelectorMatches(entry.path, secretSelectors)))
    p5Fail('p5_tracked_secret', 'Candidate source capture selected a path covered by the P5 secret-path deny list.');
  const changes = deriveChanges(baseline.entries, captured.entries);
  if (!changes.length) p5Fail('p5_no_source_change', 'The Developer produced no source changes; P5 does not create a review loop for a no-op candidate.');
  // P5-GIT-2 §25: Lifecycle Host source, trust, build and packaging inputs are outside Self-Repair for every policy;
  // no enrolled scope, profile or Judge decision can widen it, so it is checked before the scope.
  for (const change of changes) {
    const reason = p5HostProtectedReason(change.path);
    if (reason) p5Fail('p5_host_boundary_violation', `P5 Self-Repair may not change Lifecycle Host source, trust or build inputs: "${change.path}" (${reason}).`);
  }
  // The Host import closure derived from the candidate tree itself applies to every policy, before any durable intent.
  assertP5HostBoundary({ changes, candidateClosure: await deriveP5HostProtection({ sourceRoot: captured.root, sourceCommit: baseline.baseCommit }) });
  assertScope(changes, authorization.scope);
  // P5-FINAL §5.2: Engine source is repairable; the captured policy decides how strictly. Unclassified sensitive source fails closed.
  const mutationClassification = classifyP5Mutation({ changes, policy });
  const candidateId = p5CandidateId({ baselineId: baseline.baselineId, incidentId: authorization.incidentId,
    parentRunId: authorization.parentRunId, repairRunId: authorization.repairRunId, linkId: authorization.linkId,
    developerAttemptId: authorization.developerAttemptId, workspaceAllocationId: authorization.workspace.allocationId,
    candidateSourceDigest: captured.sourceDigest, selfRepairProfileDigest: authorization.selfRepairProfile.sha256,
    verificationPolicyDigest: authorization.verificationPolicy.sha256, verificationInputsDigest: authorization.verificationInputs.sha256 });
  const contentRefs = new Map();
  const sourceEntries = captured.entries.map(entry => {
    const path = resolve(captured.root, ...entry.path.split('/'));
    const bytes = readFileSync(path);
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256) p5Fail('p5_source_drift', `P5 source changed before object sealing: "${entry.path}".`);
    const artifact = store.putBytes(bytes, 'application/octet-stream');
    store.verifyRef(artifact);
    const reread = store.readBytes(artifact.artifactId).bytes;
    if (reread.length !== entry.byteSize || sha256(reread) !== entry.sha256) p5Fail('p5_object_mismatch', `P5 object verification failed for "${entry.path}".`);
    contentRefs.set(entry.path, asRef(artifact));
    return { ...entry, artifact: asRef(artifact) };
  });
  const live = await inventoryP5SourceWithHost(sourceRoot, { ...options, nativeSourceReader });
  const workspaceNativeAfter = await readP5NativeIdentity(nativeSourceReader, { root: workspacePath });
  if (live.sourceDigest !== captured.sourceDigest || canonicalHash(live.identities) !== canonicalHash(captured.identities)
    || live.nativeEvidence.snapshotDigest !== captured.nativeEvidence.snapshotDigest
    || live.nativeEvidence.contentDigest !== captured.nativeEvidence.contentDigest
    || live.nativeEvidence.pathDigest !== captured.nativeEvidence.pathDigest
    || canonicalHash(workspaceNativeAfter.rootIdentity) !== canonicalHash(workspaceNativeBefore.rootIdentity)
    || workspaceNativeAfter.snapshotDigest !== workspaceNativeBefore.snapshotDigest)
    p5Fail('p5_source_drift', 'The P5 candidate workspace changed during source object sealing.');
  const sourceCaptureEvidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceCaptureEvidence',
    sourceRoot: captured.root, rootIdentity: captured.nativeEvidence.rootIdentity, hostPid: captured.nativeEvidence.hostPid,
    generation: captured.nativeEvidence.generation, epoch: captured.nativeEvidence.epoch,
    snapshotDigestBefore: captured.nativeEvidence.snapshotDigest, snapshotDigestAfter: live.nativeEvidence.snapshotDigest,
    pathDigest: captured.nativeEvidence.pathDigest, contentDigest: captured.nativeEvidence.contentDigest,
    fileCount: captured.entries.length, totalBytes: captured.totalBytes };
  validateP5Contract('sourceCaptureEvidence', sourceCaptureEvidence);
  const sourceCaptureEvidenceArtifact = store.putJson(sourceCaptureEvidence); store.verifyRef(sourceCaptureEvidenceArtifact);
  const sourceManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest: captured.sourceDigest, entries: sourceEntries };
  assertValid('protected-self-repair.schema.json', 'sourceManifest', sourceManifest, 'P5 source manifest');
  const sourceManifestArtifact = store.putJson(sourceManifest); store.verifyRef(sourceManifestArtifact);
  const changeRecords = changes.map(change => {
    const beforeArtifact = change.before ? (baseline.contentRefs instanceof Map
      ? baseline.contentRefs.get(change.path) : baseline.contentRefs?.[change.path]) : null;
    if (change.before && !beforeArtifact) p5Fail('p5_baseline_object_missing', `P5 has no verified baseline object for "${change.path}".`);
    return { ...change,
      ...(change.before ? { beforeArtifact: asRef(beforeArtifact) } : {}),
      ...(change.after ? { afterArtifact: contentRefs.get(change.path) } : {}) };
  });
  const changeManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairChangeManifest', candidateId,
    baselineId: baseline.baselineId, baseSourceDigest: baseline.sourceDigest, candidateSourceDigest: captured.sourceDigest,
    profileDigest: authorization.selfRepairProfile.sha256, verificationPolicyDigest: authorization.verificationPolicy.sha256,
    verificationInputsDigest: authorization.verificationInputs.sha256,
    workspaceAllocationId: authorization.workspace.allocationId, parentRunId: authorization.parentRunId,
    repairRunId: authorization.repairRunId, linkId: authorization.linkId, incidentId: authorization.incidentId,
    changes: changeRecords, mutationClassification };
  assertValid('protected-self-repair.schema.json', 'changeManifest', changeManifest, 'P5 change manifest');
  const changeManifestArtifact = store.putJson(changeManifest); store.verifyRef(changeManifestArtifact);
  const candidate = { schemaVersion: 1, kind: 'ProtectedSelfRepairCandidate', candidateId, enrollment: asRef(authorization.enrollment),
    baselineRef: asRef(baseline.baselineManifest), baselineId: baseline.baselineId, baseCommit: baseline.baseCommit,
    baseSourceDigest: baseline.sourceDigest, candidateSourceDigest: captured.sourceDigest,
    sourceManifest: asRef(sourceManifestArtifact), changeManifest: asRef(changeManifestArtifact),
    sourceCaptureEvidence: asRef(sourceCaptureEvidenceArtifact),
    repositoryIdentity: baseline.repositoryIdentity, sourceBinding: asRef(authorization.sourceBinding),
    workspace: { workspaceId: authorization.workspace.workspaceId, allocationId: authorization.workspace.allocationId,
      canonicalRoot: realpathSync.native(resolve(authorization.workspace.canonicalRoot)), sourceRoot: captured.root,
      nativeIdentity: authorization.workspace.nativeIdentity },
    parentRunId: authorization.parentRunId, repairRunId: authorization.repairRunId, linkId: authorization.linkId,
    incidentId: authorization.incidentId, outcomeId: authorization.outcomeId, outcomeRevision: authorization.outcomeRevision,
    parentPublication: authorization.parentPublication, repairPublication: authorization.repairPublication,
    developerNodeId: authorization.developerNodeId, developerAttemptId: authorization.developerAttemptId,
    selfRepairProfile: asRef(authorization.selfRepairProfile), verificationPolicy: asRef(authorization.verificationPolicy),
    verificationInputs: asRef(authorization.verificationInputs), developerTerminalEvidence: asRef(authorization.developerTerminal.artifact),
    scopeVerdict: { status: 'within_scope', changeCount: changes.length }, capturedAt: authorization.capturedAt,
    journalCursor: authorization.journalCursor };
  assertValid('protected-self-repair.schema.json', 'candidate', candidate, 'P5 candidate');
  const candidateArtifact = store.putJson(candidate); store.verifyRef(candidateArtifact);
  return { candidate, candidateArtifact: asRef(candidateArtifact), sourceManifest, sourceManifestArtifact: asRef(sourceManifestArtifact),
    changeManifest, changeManifestArtifact: asRef(changeManifestArtifact), sourceCaptureEvidence,
    sourceCaptureEvidenceArtifact: asRef(sourceCaptureEvidenceArtifact), capturedSourceDigest: captured.sourceDigest };
}

/**
 * Check immutable P5 receipt consistency and referenced objects. This is deliberately not an
 * issuer or Host verifier: Engine must still validate the current Gate Attempt, Custody lifecycle,
 * Host terminal evidence, journal events and transaction preconditions before accepting a receipt.
 */
export function verifyP5Receipt(receipt, { store, candidateRef, gateAttemptId, terminalEvidenceRef }) {
  assertValid('protected-self-repair.schema.json', 'verificationReceipt', receipt, 'P5 verification receipt');
  if (!store || !candidateRef || !terminalEvidenceRef || !gateAttemptId)
    p5Fail('p5_receipt_ineligible', 'P5 receipt validation requires the Store, exact candidate, Gate Attempt and terminal evidence references.');
  const sameRef = (left, right) => canonicalHash(left) === canonicalHash(right);
  const verifyRef = ref => { store.verifyRef(ref); return ref; };
  const readJson = ref => store.readJson(verifyRef(ref).artifactId);
  const readManifest = (ref, name) => {
    const value = readJson(ref);
    validateP5Contract(name, value);
    return value;
  };
  const verifySourceObjects = manifest => {
    const entries = manifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
    assertUniquePortablePaths(entries);
    if (canonicalHash(entries) !== canonicalHash(sortEntries(entries)))
      p5Fail('p5_receipt_object_mismatch', 'A P5 source manifest is not sorted by its portable path identity.');
    for (const entry of manifest.entries) {
      const bytes = store.readBytes(verifyRef(entry.artifact).artifactId).bytes;
      if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
        p5Fail('p5_receipt_object_mismatch', `P5 source object for "${entry.path}" does not match its immutable manifest.`);
    }
    if (p5SourceDigest(entries) !== manifest.sourceDigest)
      p5Fail('p5_receipt_object_mismatch', 'The P5 source manifest digest does not match its entries.');
    return entries;
  };

  const candidate = readManifest(candidateRef, 'candidate');
  if (receipt.status !== 'passed' || receipt.captureStatus !== 'complete' || receipt.gateAttemptId !== gateAttemptId
    || receipt.candidateId !== candidate.candidateId || receipt.candidateSourceDigest !== candidate.candidateSourceDigest
    || receipt.baselineId !== candidate.baselineId || receipt.linkId !== candidate.linkId
    || receipt.repairRunId !== candidate.repairRunId || receipt.incidentId !== candidate.incidentId
    || !sameRef(receipt.candidateManifest, candidateRef) || !sameRef(receipt.changeManifest, candidate.changeManifest)
    || !sameRef(receipt.selfRepairProfile, candidate.selfRepairProfile)
    || !sameRef(receipt.verificationPolicy, candidate.verificationPolicy)
    || !sameRef(receipt.verificationInputs, candidate.verificationInputs)
    || !sameRef(receipt.terminalEvidence, terminalEvidenceRef))
    p5Fail('p5_receipt_ineligible', 'The P5 receipt does not name the exact sealed candidate, current Gate Attempt and captured lineage.');

  for (const ref of [candidate.enrollment, candidate.baselineRef, candidate.sourceManifest, candidate.changeManifest, candidate.gitCandidate, candidate.selfRepairProfile,
    candidate.sourceCaptureEvidence, candidate.verificationPolicy, candidate.verificationInputs, candidate.developerTerminalEvidence, terminalEvidenceRef,
    receipt.execution.commandManifest, receipt.execution.testInputManifest].filter(Boolean)) verifyRef(ref);
  if (candidate.gitCandidate) {
    if (!receipt.gitCandidate || !sameRef(receipt.gitCandidate, candidate.gitCandidate))
      p5Fail('p5_receipt_git_candidate_mismatch', 'The P5 receipt omits or changes the exact committed Git candidate binding.');
    const gitCandidate = readManifest(candidate.gitCandidate, 'gitCandidate');
    const { candidateGitId, ...gitCandidateBody } = gitCandidate;
    if (candidateGitId !== canonicalHash(gitCandidateBody) || gitCandidate.candidateId !== candidate.candidateId
      || gitCandidate.source.candidateDigest !== candidate.candidateSourceDigest
      || gitCandidate.source.baselineDigest !== candidate.baseSourceDigest
      || !sameRef(gitCandidate.source.sourceManifest, candidate.sourceManifest)
      || !sameRef(gitCandidate.source.changeManifest, candidate.changeManifest))
      p5Fail('p5_receipt_git_candidate_mismatch', 'The P5 receipt Git binding differs from the immutable source candidate.');
    const baseCandidate = readManifest(gitCandidate.baseCandidate, 'candidate');
    const { gitCandidate: _binding, ...sourceCandidate } = candidate;
    if (!sameRef(receipt.gitCandidate, candidate.gitCandidate) || canonicalHash(baseCandidate) !== canonicalHash(sourceCandidate))
      p5Fail('p5_receipt_git_candidate_mismatch', 'The P5 Git commit does not extend this exact source candidate.');
    const commitIntent = readManifest(gitCandidate.commitIntent, 'gitCommitIntent');
    if (!sameRef(commitIntent.candidateManifest, gitCandidate.baseCandidate)
      || commitIntent.candidateId !== candidate.candidateId
      || commitIntent.candidateSourceDigest !== candidate.candidateSourceDigest)
      p5Fail('p5_receipt_git_candidate_mismatch', 'The P5 Git candidate commit intent differs from the exact sealed source candidate.');
  } else if (receipt.gitCandidate) {
    p5Fail('p5_receipt_git_candidate_mismatch', 'The P5 receipt claims a Git candidate that the sealed source candidate does not contain.');
  }
  const profile = readManifest(candidate.selfRepairProfile, 'profile');
  const policy = readManifest(candidate.verificationPolicy, 'verificationPolicy');
  assertP5PolicyCommands(policy);
  const inputs = readManifest(candidate.verificationInputs, 'verificationInputs');
  const sourceBinding = readManifest(candidate.sourceBinding, 'sourceBinding');
  const enrollment = readManifest(candidate.enrollment, 'enrollment');
  const changeManifest = readManifest(candidate.changeManifest, 'changeManifest');
  // The tiers are recomputed from the immutable changes and captured policy. A pre-tier manifest (P5-E2E-1 and earlier) has no
  // recorded classification; it keeps the rules it was captured under and is never re-classified by later rules.
  if (changeManifest.mutationClassification) verifyP5MutationClassification({ changeManifest, policy });
  const sourceManifest = readManifest(candidate.sourceManifest, 'sourceManifest');
  const baseline = readManifest(candidate.baselineRef, 'baselineManifest');
  const sourceCaptureEvidence = readManifest(candidate.sourceCaptureEvidence, 'sourceCaptureEvidence');
  const baselineSource = readManifest(baseline.sourceManifest, 'sourceManifest');
  const baselineEntries = verifySourceObjects(baselineSource);
  const candidateEntries = verifySourceObjects(sourceManifest);
  if (sourceCaptureEvidence.sourceRoot !== candidate.workspace.sourceRoot
    || sourceCaptureEvidence.snapshotDigestBefore !== sourceCaptureEvidence.snapshotDigestAfter
    || sourceCaptureEvidence.pathDigest !== p5PathSetDigest(candidateEntries.map(entry => entry.path))
    || sourceCaptureEvidence.contentDigest !== p5NativeContentDigest(candidateEntries)
    || sourceCaptureEvidence.fileCount !== candidateEntries.length
    || sourceCaptureEvidence.totalBytes !== candidateEntries.reduce((sum, entry) => sum + entry.byteSize, 0))
    p5Fail('p5_receipt_source_capture_mismatch', 'The candidate source manifest does not match the Host-backed capture evidence.');
  if (baseline.baselineId !== candidate.baselineId || baseline.effectiveSourceDigest !== candidate.baseSourceDigest
    || canonicalHash(baseline.repositoryIdentity) !== canonicalHash(candidate.repositoryIdentity) || baseline.baseCommit !== candidate.baseCommit
    || !sameRef(profile.baseline, candidate.baselineRef) || !sameRef(profile.verificationPolicy, candidate.verificationPolicy)
    || canonicalHash(profile.repairPublication) !== canonicalHash(candidate.repairPublication)
    || profile.workspace.workspaceId !== candidate.workspace.workspaceId
    || profile.workspace.allocationId !== candidate.workspace.allocationId
    || profile.workspace.canonicalRoot !== candidate.workspace.canonicalRoot
    || canonicalHash(profile.requiredCheckIds) !== canonicalHash(policy.requiredCheckIds)
    || !sameRef(enrollment.profile, candidate.selfRepairProfile) || !sameRef(enrollment.baselineManifest, candidate.baselineRef)
    || !sameRef(enrollment.verificationPolicy, candidate.verificationPolicy)
    || enrollment.enrollmentId !== profile.enrollmentId || enrollment.repositoryIdentity.enrollmentId !== enrollment.enrollmentId
    || profile.repositoryIdentity.enrollmentId !== enrollment.enrollmentId || baseline.enrollmentId !== enrollment.enrollmentId
    || baseline.repositoryIdentity.enrollmentId !== enrollment.enrollmentId || enrollment.baselineId !== candidate.baselineId
    || canonicalHash(enrollment.workspace.nativeIdentity) !== canonicalHash(candidate.workspace.nativeIdentity)
    || enrollment.workspace.workspaceId !== candidate.workspace.workspaceId
    || enrollment.workspace.allocationId !== candidate.workspace.allocationId
    || enrollment.workspace.canonicalRoot !== candidate.workspace.canonicalRoot
    || canonicalHash(enrollment.scope) !== canonicalHash(profile.scope)
    || canonicalHash(enrollment.budgets) !== canonicalHash(profile.budgets)
    || !sameRef(sourceBinding.profile, candidate.selfRepairProfile) || !sameRef(sourceBinding.baselineManifest, candidate.baselineRef)
    || sourceBinding.baselineId !== candidate.baselineId || sourceBinding.parentRunId !== candidate.parentRunId
    || canonicalHash(sourceBinding.parentPublication) !== canonicalHash(candidate.parentPublication)
    || sourceBinding.enrollmentId !== profile.enrollmentId
    || !sameRef(sourceBinding.runningSourceRelease, profile.runningSourceRelease)
    || !sameRef(baseline.runningSourceRelease, profile.runningSourceRelease)
    || inputs.incidentId !== candidate.incidentId || inputs.outcomeId !== candidate.outcomeId
    || inputs.outcomeRevision !== candidate.outcomeRevision || !sameRef(inputs.verificationPolicy, candidate.verificationPolicy))
    p5Fail('p5_receipt_lineage_mismatch', 'The P5 receipt candidate, baseline, source binding, profile or verification inputs do not share one enrolled lineage.');
  if (sourceManifest.sourceDigest !== candidate.candidateSourceDigest
    || changeManifest.candidateId !== candidate.candidateId
    || changeManifest.baselineId !== candidate.baselineId
    || changeManifest.baseSourceDigest !== candidate.baseSourceDigest
    || changeManifest.candidateSourceDigest !== candidate.candidateSourceDigest
    || changeManifest.linkId !== candidate.linkId || changeManifest.repairRunId !== candidate.repairRunId
    || changeManifest.parentRunId !== candidate.parentRunId
    || changeManifest.incidentId !== candidate.incidentId
    || changeManifest.workspaceAllocationId !== candidate.workspace.allocationId
    || changeManifest.profileDigest !== candidate.selfRepairProfile.sha256
    || changeManifest.verificationPolicyDigest !== candidate.verificationPolicy.sha256
    || changeManifest.verificationInputsDigest !== candidate.verificationInputs.sha256)
    p5Fail('p5_receipt_candidate_mismatch', 'P5 candidate source or change manifests do not match the candidate record.');
  const baselineEntryRefs = new Map(baselineSource.entries.map(entry => [entry.path, entry.artifact]));
  const candidateEntryRefs = new Map(sourceManifest.entries.map(entry => [entry.path, entry.artifact]));
  const expectedChanges = deriveChanges(baselineEntries, candidateEntries).map(change => ({ ...change,
    ...(change.before ? { beforeArtifact: baselineEntryRefs.get(change.path) } : {}),
    ...(change.after ? { afterArtifact: candidateEntryRefs.get(change.path) } : {}) }));
  assertScope(expectedChanges, profile.scope);
  if (canonicalHash(expectedChanges) !== canonicalHash(changeManifest.changes)
    || candidate.scopeVerdict.status !== 'within_scope' || candidate.scopeVerdict.changeCount !== expectedChanges.length
    || p5CandidateId({ baselineId: candidate.baselineId, incidentId: candidate.incidentId, parentRunId: candidate.parentRunId,
      repairRunId: candidate.repairRunId, linkId: candidate.linkId, developerAttemptId: candidate.developerAttemptId,
      workspaceAllocationId: candidate.workspace.allocationId, candidateSourceDigest: candidate.candidateSourceDigest,
      selfRepairProfileDigest: candidate.selfRepairProfile.sha256, verificationPolicyDigest: candidate.verificationPolicy.sha256,
      verificationInputsDigest: candidate.verificationInputs.sha256 }) !== candidate.candidateId)
    p5Fail('p5_receipt_candidate_mismatch', 'The P5 candidate identity, scoped change set or change count is inconsistent with its immutable source manifests.');

  const terminal = readJson(terminalEvidenceRef);
  const developerTerminal = readJson(candidate.developerTerminalEvidence);
  if (developerTerminal.attemptId !== candidate.developerAttemptId || developerTerminal.processTreeEnded !== true
    || developerTerminal.spoolComplete !== true || terminal.attemptId !== gateAttemptId
    || terminal.processTreeEnded !== true || terminal.spoolComplete !== true
    || (terminal.kind === 'ProtectedSelfRepairGateTerminalEvidence' ? terminal.state : terminal.status) !== 'exited'
    || terminal.exitCode !== 0 || terminal.custodyId !== receipt.execution.custodyId
    || terminal.invocationDigest !== receipt.execution.invocationDigest
    || terminal.lifecycleGeneration !== receipt.execution.lifecycleGeneration
    || (terminal.hostIdentity !== undefined && terminal.hostIdentity !== receipt.execution.hostIdentity))
    p5Fail('p5_receipt_terminal_mismatch', 'The P5 receipt is not bound to complete Developer and Gate terminal evidence for its exact attempts.');
  if (receipt.sourceBeforeDigest !== candidate.candidateSourceDigest
    || receipt.sourceAfterDigest !== candidate.candidateSourceDigest
    || receipt.liveCandidateDigest !== candidate.candidateSourceDigest
    || receipt.harnessAfterDigest !== policy.harnessClosureDigest
    || receipt.execution.harnessClosureDigest !== policy.harnessClosureDigest)
    p5Fail('p5_receipt_integrity_mismatch', 'Candidate source or verification harness integrity changed during the P5 Gate.');

  const required = [...policy.requiredCheckIds].sort(compareText);
  const optional = new Set(policy.optionalCheckIds);
  const definitions = new Map(policy.checks.map(check => [check.checkId, check]));
  const checks = new Map(receipt.checks.map(check => [check.checkId, check]));
  if (definitions.size !== policy.checks.length || checks.size !== receipt.checks.length
    || required.some(id => !definitions.get(id)?.required || !checks.has(id))
    || receipt.checks.some(observation => !definitions.has(observation.checkId)
      || !optional.has(observation.checkId) && !required.includes(observation.checkId)))
    p5Fail('p5_receipt_incomplete', 'The P5 receipt has duplicate, missing or policy-unknown check observations.');
  const commandManifest = readManifest(receipt.execution.commandManifest, 'commandManifest');
  const testInputManifest = readManifest(receipt.execution.testInputManifest, 'testInputManifest');
  const sortedChecks = [...receipt.checks].sort((a, b) => compareText(a.checkId, b.checkId));
  const commandRoots = commandManifest.roots;
  const slotRoot = candidate.workspace.canonicalRoot;
  const expectedRoots = { candidateSource: join(slotRoot, '.p5', 'verify', 'source'),
    executionRoot: join(slotRoot, '.p5', 'verify', 'execution'),
    verifyScratch: join(slotRoot, '.p5', 'verify', 'scratch', gateAttemptId) };
  if (!commandRoots || ['candidateSource', 'executionRoot', 'verifyScratch', 'installedControl'].some(name =>
    typeof commandRoots[name] !== 'string' || !isAbsolute(commandRoots[name]))
    || [commandRoots.candidateSource, commandRoots.executionRoot, commandRoots.verifyScratch, commandRoots.installedControl]
      .some((path, index, roots) => roots.slice(index + 1).some(other => workspaceRootsOverlap(path, other)))
    || ['candidateSource', 'executionRoot', 'verifyScratch'].some(name => pathKey(commandRoots[name]) !== pathKey(expectedRoots[name])))
    p5Fail('p5_receipt_command_roots_invalid', 'P5 command roots are missing, relative, aliased or overlapping.');
  const expectedCommandRows = sortedChecks.map(item => {
    const definition = definitions.get(item.checkId);
    const inputRow = testInputManifest.checks.find(row => row.checkId === item.checkId);
    if (!inputRow) p5Fail('p5_receipt_input_manifest_mismatch', `P5 check "${item.checkId}" has no materialized input row.`);
    const inputManifestPath = resolve(commandRoots.verifyScratch, ...inputRow.materializedInputPath.split('/'));
    const cwd = resolve(commandRoots.executionRoot, item.checkId);
    const environment = { ...definition.environment, [P5_VERIFICATION_INPUT_MANIFEST_ENV]: inputManifestPath };
    if (definition.subjectBinding === 'candidate-entrypoint')
      environment[P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV] = resolve(commandRoots.candidateSource, ...definition.subjectEntryPoints[0].split('/'));
    return { checkId: item.checkId, commandDigest: item.commandDigest, executable: definition.executable,
      executableSha256: definition.executableSha256, argv: definition.argv, cwdKind: definition.cwd, cwd,
      environment, environmentDigest: canonicalHash(environment), inputDigest: item.inputDigest,
      inputManifest: inputRow.materializedInputs, inputManifestPath, inputManifestDigest: inputRow.materializedInputDigest };
  });
  const expectedInputRows = sortedChecks.map(item => ({ checkId: item.checkId, inputDigest: item.inputDigest,
    subjectResolution: item.subjectResolution, executionTreeDigest: item.executionTreeDigest,
    materializedInputs: testInputManifest.checks.find(row => row.checkId === item.checkId)?.materializedInputs,
    materializedInputPath: testInputManifest.checks.find(row => row.checkId === item.checkId)?.materializedInputPath,
    materializedInputDigest: testInputManifest.checks.find(row => row.checkId === item.checkId)?.materializedInputDigest,
    overlayManifest: item.overlayManifest }));
  if (commandManifest.candidateId !== candidate.candidateId
    || commandManifest.candidateSourceDigest !== candidate.candidateSourceDigest
    || !sameRef(commandManifest.verificationPolicy, candidate.verificationPolicy)
    || commandManifest.gateAttemptId !== gateAttemptId
    || canonicalHash([...commandManifest.checks].sort((a, b) => compareText(a.checkId, b.checkId))) !== canonicalHash(expectedCommandRows)
    || testInputManifest.candidateId !== candidate.candidateId
    || testInputManifest.candidateSourceDigest !== candidate.candidateSourceDigest
    || testInputManifest.baselineId !== candidate.baselineId
    || !sameRef(testInputManifest.verificationPolicy, candidate.verificationPolicy)
    || !sameRef(testInputManifest.verificationInputs, candidate.verificationInputs)
    || testInputManifest.harnessClosureDigest !== policy.harnessClosureDigest
    || canonicalHash([...testInputManifest.checks].sort((a, b) => compareText(a.checkId, b.checkId))) !== canonicalHash(expectedInputRows))
    p5Fail('p5_receipt_input_manifest_mismatch', 'The P5 Gate command and test-input manifests do not describe the exact receipt checks and candidate.');
  for (const item of testInputManifest.checks) {
    const materialized = readManifest(item.materializedInputs, 'materializedCheckInputs');
    const definition = definitions.get(item.checkId);
    const observation = checks.get(item.checkId);
    if (!definition || !observation || item.materializedInputDigest !== item.materializedInputs.sha256
      || item.materializedInputPath !== `inputs/${item.checkId}/manifest.json`
      || materialized.candidateId !== candidate.candidateId || materialized.candidateSourceDigest !== candidate.candidateSourceDigest
      || materialized.baselineId !== candidate.baselineId || materialized.checkId !== item.checkId
      || materialized.inputDigest !== observation.inputDigest
      || pathKey(materialized.root) !== pathKey(commandRoots.verifyScratch)
      || observation.inputDigest !== p5CheckInputDigest({ candidate, check: definition, verificationInputs: inputs }))
      p5Fail('p5_receipt_input_manifest_mismatch', `P5 check "${item.checkId}" materialized inputs differ from its exact policy and captured P3 evidence.`);
    const expectedInputs = [
      ...[...definition.inputRefs].sort((left, right) => compareText(left.artifactId, right.artifactId) || compareText(left.sha256, right.sha256))
        .map(artifact => ({ source: 'policy', artifact })),
      ...[...inputs.inputs].sort((left, right) => compareText(left.selector, right.selector)
        || compareText(left.sourceOutcomeId, right.sourceOutcomeId) || left.sourceRevision - right.sourceRevision
        || compareText(left.artifact.artifactId, right.artifact.artifactId))
        .map(input => ({ source: 'incident', selector: input.selector, sourceOutcomeId: input.sourceOutcomeId,
          sourceRevision: input.sourceRevision, artifact: input.artifact })),
    ];
    if (materialized.inputs.length !== expectedInputs.length)
      p5Fail('p5_receipt_input_manifest_mismatch', `P5 check "${item.checkId}" omits a captured static or incident input.`);
    for (let index = 0; index < expectedInputs.length; index++) {
      const expected = expectedInputs[index], actual = materialized.inputs[index];
      const relativePath = `inputs/${item.checkId}/input-${String(index).padStart(4, '0')}.bin`;
      const { byteSize: _byteSize, ...actualIdentity } = actual;
      if (canonicalHash(actualIdentity) !== canonicalHash({ ...expected, relativePath, sha256: expected.artifact.sha256 })
        || !Number.isSafeInteger(actual.byteSize) || actual.byteSize < 0 || actual.byteSize > 64 * 1024 * 1024)
        p5Fail('p5_receipt_input_manifest_mismatch', `P5 check "${item.checkId}" input row ${index} differs from the exact captured reference.`);
      const bytes = store.readBytes(verifyRef(expected.artifact).artifactId).bytes;
      if (bytes.length !== actual.byteSize || sha256(bytes) !== actual.sha256)
        p5Fail('p5_receipt_input_object_mismatch', `P5 check "${item.checkId}" input row ${index} does not match its verified Store object.`);
    }
  }
  const requiredStages = new Set();
  for (const observation of receipt.checks) {
    const definition = definitions.get(observation.checkId);
    if (observation.stageId !== definition.stageId || observation.required !== definition.required
      || observation.commandDigest !== p5VerificationCommandDigest(definition)
      || canonicalHash(observation.expectedAssertions) !== canonicalHash(definition.expectedAssertions))
      p5Fail('p5_receipt_policy_mismatch', `P5 check "${observation.checkId}" does not match the captured verification plan.`);
    if (observation.required) requiredStages.add(observation.stageId);
    if (definition.overlayPaths.length) {
      if (!observation.overlayManifest)
        p5Fail('p5_overlay_manifest_missing', `P5 check "${observation.checkId}" requires its captured protected overlay manifest.`);
      const overlay = verifyP5OverlayManifest({ store, overlayManifestRef: observation.overlayManifest,
        candidateRef, check: definition, execution: receipt.execution });
      for (const entry of overlay.manifest.entries) {
        const candidateBefore = entry.candidateBefore;
        const changedByCandidate = !candidateBefore
          || canonicalHash(candidateBefore) !== canonicalHash(entry.protectedReplacement);
        if (!changedByCandidate) continue;
        const independentCheck = policy.checks.some(other => other.checkId !== definition.checkId && other.required
          && other.subjectBinding === 'candidate-entrypoint' && other.subjectEntryPoints.includes(entry.path));
        if (!independentCheck)
          p5Fail('p5_overlay_changed_subject_unverified', `Candidate-edited overlay path "${entry.path}" has no independent candidate-entrypoint check.`);
      }
    } else if (definition.subjectBinding !== 'candidate-entrypoint' || observation.overlayManifest !== null) {
      p5Fail('p5_overlay_policy_mismatch', `P5 check "${observation.checkId}" has an unsupported subject-binding/overlay combination.`);
    }
    for (const ref of [observation.subjectResolution, observation.stdout, observation.stderr, observation.observations,
      ...(observation.overlayManifest ? [observation.overlayManifest] : [])]) verifyRef(ref);
    for (const ref of [...definition.inputRefs, ...inputs.inputs.map(input => input.artifact)]) verifyRef(ref);
    const subjectResolution = readManifest(observation.subjectResolution, 'subjectResolution');
    const resolvedFiles = [...subjectResolution.resolvedFiles].sort((a, b) => compareText(a.path, b.path));
    const resolvedByPath = new Map(resolvedFiles.map(file => [file.path, file]));
    const sourceByPath = new Map(sourceManifest.entries.map(entry => [entry.path, entry]));
    if (resolvedByPath.size !== resolvedFiles.length
      || subjectResolution.candidateId !== candidate.candidateId
      || subjectResolution.candidateSourceDigest !== candidate.candidateSourceDigest
      || subjectResolution.baselineId !== candidate.baselineId || subjectResolution.checkId !== observation.checkId
      || !sameRef(subjectResolution.verificationPolicy, candidate.verificationPolicy)
      || !sameRef(subjectResolution.verificationInputs, candidate.verificationInputs)
      || subjectResolution.inputDigest !== p5CheckInputDigest({ candidate, check: definition, verificationInputs: inputs })
      || observation.inputDigest !== subjectResolution.inputDigest
      || subjectResolution.driverIdentity !== definition.executable
      || subjectResolution.driverSha256 !== definition.executableSha256
      || canonicalHash([...subjectResolution.entryPoints].sort(compareText)) !== canonicalHash([...definition.subjectEntryPoints].sort(compareText))
      || canonicalHash(resolvedFiles) !== canonicalHash(subjectResolution.resolvedFiles)
      || subjectResolution.sourceClosureDigest !== canonicalHash(resolvedFiles)
      || definition.subjectEntryPoints.some(path => !resolvedByPath.has(path))
      || resolvedFiles.some(file => {
        const source = sourceByPath.get(file.path);
        return !source || source.sha256 !== file.sha256 || source.byteSize !== file.byteSize || source.executable !== file.executable;
      })
      || canonicalHash([...subjectResolution.assertionBindings].sort((a, b) => compareText(a.assertion, b.assertion)))
        !== canonicalHash([...definition.expectedAssertions].sort(compareText).map(assertion => ({
          assertion, sourcePath: subjectResolution.assertionBindings.find(binding => binding.assertion === assertion)?.sourcePath,
        })))
      || subjectResolution.assertionBindings.some(binding => !resolvedByPath.has(binding.sourcePath)))
      p5Fail('p5_receipt_subject_mismatch', `P5 check "${observation.checkId}" does not resolve the exact candidate source and assertion inputs.`);
    const expectedTreeDigest = p5ExecutionTreeDigest({ candidate, checkId: observation.checkId,
      subjectResolution: observation.subjectResolution, inputDigest: observation.inputDigest, overlayManifest: observation.overlayManifest });
    if (observation.executionTreeDigest !== expectedTreeDigest)
      p5Fail('p5_receipt_execution_tree_mismatch', `P5 check "${observation.checkId}" execution tree is not bound to its candidate subject and inputs.`);
    const evidence = readManifest(observation.observations, 'checkObservationEvidence');
    const expectedEvidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairCheckObservation', candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, checkId: observation.checkId,
      commandDigest: observation.commandDigest, inputDigest: observation.inputDigest, subjectResolution: observation.subjectResolution,
      executionTreeDigest: observation.executionTreeDigest, startedAt: observation.startedAt, endedAt: observation.endedAt,
      status: observation.status, exitCode: observation.exitCode, expectedAssertions: observation.expectedAssertions,
      completedAssertions: observation.completedAssertions, stdout: observation.stdout, stderr: observation.stderr, captureStatus: 'complete' };
    if (canonicalHash(evidence) !== canonicalHash(expectedEvidence))
      p5Fail('p5_receipt_observation_mismatch', `P5 check "${observation.checkId}" observation evidence does not match the receipt.`);
    const completed = [...new Set(observation.completedAssertions)].sort(compareText);
    if (observation.required && (observation.status !== 'passed' || !definition.expectedExitCodes.includes(observation.exitCode)
      || canonicalHash(completed) !== canonicalHash([...definition.expectedAssertions].sort(compareText))))
      p5Fail('p5_receipt_incomplete', `P5 required check "${observation.checkId}" did not pass every captured assertion and expected exit code.`);
    if (observation.executionTreeDigest === null)
      p5Fail('p5_receipt_incomplete', `P5 check "${observation.checkId}" has no captured execution-tree digest.`);
  }
  // P5-CLOSURE F2: the exact installed dependency bytes served to the checks, bound before execution and re-verified after.
  let dependencyClosureDigest = null;
  if (receipt.dependencyClosure) {
    const closure = readManifest(receipt.dependencyClosure, 'dependencyClosure');
    const files = [...closure.files].sort((a, b) => compareText(a.path, b.path));
    if (closure.candidateId !== candidate.candidateId || closure.gateAttemptId !== gateAttemptId
      || canonicalHash(files) !== canonicalHash(closure.files) || closure.closureDigest !== canonicalHash({ packages: closure.packages, files })
      || files.some(file => !file.path.startsWith('node_modules/')))
      p5Fail('p5_receipt_dependency_mismatch', 'The P5 receipt dependency closure is not bound to this candidate Attempt or its own file digests.');
    const packages = new Set(closure.packages);
    for (const observation of receipt.checks) {
      const resolution = readManifest(observation.subjectResolution, 'subjectResolution');
      if ((resolution.installedPackages ?? []).some(name => !packages.has(name)))
        p5Fail('p5_receipt_dependency_mismatch', `P5 check "${observation.checkId}" imports an installed package outside the bound dependency closure.`);
    }
    const enrolledRelease = readJson(enrollment.runningSourceRelease);
    if (closure.installedRelease.buildId !== enrolledRelease.buildId || closure.installedRelease.packageSha256 !== enrolledRelease.packageSha256
      || closure.installedRelease.inputsDigest !== enrolledRelease.inputsDigest)
      p5Fail('p5_receipt_dependency_mismatch', 'The P5 receipt dependency closure was not served by the enrolled installed release.');
    dependencyClosureDigest = closure.closureDigest;
  } else if (receipt.checks.some(observation => (readManifest(observation.subjectResolution, 'subjectResolution').installedPackages ?? []).length)
    && policy.causalReproduction) {
    p5Fail('p5_receipt_dependency_missing', 'A causal-verification receipt must bind the installed dependency closure its checks imported.');
  }
  // P5-CLOSURE §6: under a causality-required policy the Gate itself ran the protected reproducer on the installed baseline
  // (expected defect observed) and on the candidate (passed). A receipt cannot claim causality its policy did not require.
  const causalPolicy = policy.causalReproduction ?? null;
  if (causalPolicy) {
    if (!receipt.causalReproduction) p5Fail('p5_receipt_causality_missing', 'The P5 policy requires production causal reproduction and the receipt has none.');
    const causal = readManifest(receipt.causalReproduction, 'causalReproduction');
    const definition = definitions.get(causalPolicy.checkId);
    const observation = checks.get(causalPolicy.checkId);
    const inputRow = testInputManifest.checks.find(row => row.checkId === causalPolicy.checkId);
    const sorted = values => [...values].sort(compareText);
    if (!definition || !observation || !inputRow || causal.checkId !== causalPolicy.checkId
      || causal.candidateId !== candidate.candidateId || causal.candidateSourceDigest !== candidate.candidateSourceDigest
      || causal.baselineId !== candidate.baselineId || causal.baselineCommit !== candidate.baseCommit
      || causal.baselineSourceDigest !== baseline.effectiveSourceDigest || causal.gateAttemptId !== gateAttemptId
      || causal.incidentId !== candidate.incidentId || causal.outcomeId !== inputs.outcomeId || causal.outcomeRevision !== inputs.outcomeRevision
      || !sameRef(causal.verificationPolicy, candidate.verificationPolicy) || !sameRef(causal.verificationInputs, candidate.verificationInputs)
      || causal.commandDigest !== definition.commandDigest || causal.inputDigest !== observation.inputDigest
      || !sameRef(causal.inputManifest, inputRow.materializedInputs)
      || canonicalHash(sorted(causal.baselineMustPass)) !== canonicalHash(sorted(causalPolicy.baselineMustPass))
      || canonicalHash(sorted(causal.baselineMustFail)) !== canonicalHash(sorted(causalPolicy.baselineMustFail))
      || causal.baselineObservation.status !== 'reproduced' || causal.baselineObservation.exitCode !== 1
      || causal.baselineExecutionTree.inventoryDigest !== canonicalHash(baselineSource.entries.map(({ artifact: _artifact, ...entry }) => entry))
      || canonicalHash(sorted(causal.baselineObservation.harnessPassed)) !== canonicalHash(sorted(causalPolicy.baselineMustPass))
      || canonicalHash(sorted(causal.baselineObservation.defectFailed)) !== canonicalHash(sorted(causalPolicy.baselineMustFail))
      || causal.candidateObservation.executionTreeDigest !== observation.executionTreeDigest || observation.status !== 'passed'
      || canonicalHash(sorted(causal.candidateObservation.completedAssertions)) !== canonicalHash(sorted(observation.completedAssertions))
      || causal.dependencyClosureDigest !== dependencyClosureDigest
      || baselineSource.entries.find(entry => entry.path === causal.baselineSubject.path)?.sha256 !== causal.baselineSubject.sha256)
      p5Fail('p5_receipt_causality_mismatch', 'The P5 causal reproduction does not show the expected baseline defect and candidate repair for this exact candidate, incident and reproducer.');
    for (const ref of [causal.baselineObservation.stdout, causal.baselineObservation.stderr, causal.baselineExecutionTree.capture]) verifyRef(ref);
  } else if (receipt.causalReproduction) {
    p5Fail('p5_receipt_causality_unexpected', 'The P5 receipt claims causal reproduction its captured policy did not require.');
  }
  if (policy.requiredStages.some(stage => !requiredStages.has(stage))
    || canonicalHash(required) !== receipt.requiredCheckSetDigest
    || canonicalHash([...checks.keys()].sort(compareText)) !== receipt.completedCheckSetDigest
    || receipt.receiptId !== p5VerificationReceiptId({ candidateId: candidate.candidateId,
      verificationPolicyDigest: candidate.verificationPolicy.sha256, gateAttemptId, custodyId: receipt.execution.custodyId,
      checks: receipt.checks, causalReproduction: receipt.causalReproduction ?? null, dependencyClosure: receipt.dependencyClosure ?? null }))
    p5Fail('p5_receipt_policy_mismatch', 'The P5 receipt check-set, required-stage or canonical receipt identity is invalid.');
  return true;
}

/**
 * Create the bounded, immutable source-detail artifacts issued to an enrolled P5 Repair Judge.
 * Callers must first validate the complete candidate and receipt with verifyP5Receipt; this
 * helper independently checks every changed-file object and refuses binary or oversized review.
 */
const p5Lines = text => text.length ? text.split(/(?<=\n)/) : [];

/** One exact hunk between two texts: the common line prefix and suffix are context; every other line is removed/added. */
export function p5ExactLineHunk(beforeText, afterText, context = 3) {
  const before = p5Lines(beforeText), after = p5Lines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { format: 'exact-line-hunk-v1', beforeLineCount: before.length, afterLineCount: after.length, startLine: prefix + 1,
    contextBefore: before.slice(Math.max(0, prefix - context), prefix), removed: before.slice(prefix, before.length - suffix),
    added: after.slice(prefix, after.length - suffix), contextAfter: before.slice(before.length - suffix, before.length - suffix + context) };
}

/** Apply an exact hunk to the exact before text; any mismatch with its recorded removed lines or counts is refused. */
export function p5ApplyExactLineHunk(beforeText, hunk) {
  const before = p5Lines(beforeText), start = hunk.startLine - 1;
  const removed = before.slice(start, start + hunk.removed.length);
  if (hunk.format !== 'exact-line-hunk-v1' || before.length !== hunk.beforeLineCount || canonicalHash(removed) !== canonicalHash(hunk.removed)
    || canonicalHash(before.slice(Math.max(0, start - hunk.contextBefore.length), start)) !== canonicalHash(hunk.contextBefore))
    p5Fail('p5_review_dossier_diff_mismatch', 'The review hunk does not apply to its exact before text.');
  const tail = before.slice(start + hunk.removed.length);
  if (canonicalHash(tail.slice(0, hunk.contextAfter.length)) !== canonicalHash(hunk.contextAfter))
    p5Fail('p5_review_dossier_diff_mismatch', 'The review hunk context does not match its exact before text.');
  const after = [...before.slice(0, start), ...hunk.added, ...tail];
  if (after.length !== hunk.afterLineCount) p5Fail('p5_review_dossier_diff_mismatch', 'The review hunk does not produce its recorded line count.');
  return after.join('');
}

export function createP5ReviewDossierArtifacts({ store, candidateRef, candidate, receiptRef, receipt, changeManifestRef, changeManifest }) {
  const maxChunkBytes = 64 * 1024;
  const maxChunks = 4;
  const maxExpansionBytes = 256 * 1024;
  const sameRef = (left, right) => canonicalHash(left) === canonicalHash(right);
  if (!store || !candidateRef || !candidate || !receiptRef || !receipt || !changeManifestRef || !changeManifest)
    p5Fail('p5_review_dossier_unavailable', 'P5 review dossier creation requires the exact candidate, receipt, change manifest and Store.');
  validateP5Contract('candidate', candidate);
  validateP5Contract('verificationReceipt', receipt);
  validateP5Contract('changeManifest', changeManifest);
  for (const artifactRef of [candidateRef, receiptRef, changeManifestRef]) store.verifyRef(artifactRef);
  if (receipt.status !== 'passed' || receipt.captureStatus !== 'complete'
    || receipt.candidateId !== candidate.candidateId || receipt.candidateSourceDigest !== candidate.candidateSourceDigest
    || receipt.baselineId !== candidate.baselineId || !sameRef(receipt.candidateManifest, candidateRef)
    || !sameRef(receipt.changeManifest, changeManifestRef) || !sameRef(candidate.changeManifest, changeManifestRef)
    || changeManifest.candidateId !== candidate.candidateId || changeManifest.baselineId !== candidate.baselineId
    || changeManifest.candidateSourceDigest !== candidate.candidateSourceDigest
    || candidate.scopeVerdict?.status !== 'within_scope' || candidate.scopeVerdict?.changeCount !== changeManifest.changes?.length)
    p5Fail('p5_review_dossier_subject_mismatch', 'P5 review details do not name the exact passing receipt and sealed candidate.');
  if (!Array.isArray(changeManifest.changes) || !changeManifest.changes.length)
    p5Fail('p5_review_dossier_empty', 'P5 review requires the complete non-empty changed-file manifest.');

  const decodeText = (bytes, path) => {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { p5Fail('p5_review_binary_unsupported', `Changed file "${path}" is not valid UTF-8 text and cannot be completely reviewed within the P5 dossier.`); }
    if (!Buffer.from(text, 'utf8').equals(bytes))
      p5Fail('p5_review_binary_unsupported', `Changed file "${path}" cannot be represented as an exact UTF-8 text review.`);
    return text;
  };
  const readSide = (change, side) => {
    const entry = change[side];
    if (entry === null) {
      if (change[`${side}Artifact`] !== undefined && change[`${side}Artifact`] !== null)
        p5Fail('p5_review_dossier_object_mismatch', `Changed file "${change.path}" has an artifact for an absent ${side} side.`);
      return null;
    }
    const artifactRef = change[`${side}Artifact`];
    if (!entry || !artifactRef?.artifactId || !artifactRef.sha256)
      p5Fail('p5_review_dossier_object_missing', `Changed file "${change.path}" is missing its verified ${side} source object.`);
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0)
      p5Fail('p5_review_dossier_object_mismatch', `Changed file "${change.path}" has an invalid ${side} size.`);
    store.verifyRef(artifactRef);
    const bytes = store.readBytes(artifactRef.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256 || artifactRef.sha256 !== entry.sha256)
      p5Fail('p5_review_dossier_object_mismatch', `Changed file "${change.path}" ${side} bytes differ from the immutable change manifest.`);
    return { artifact: artifactRef, byteSize: bytes.length, executable: entry.executable, sha256: entry.sha256,
      text: decodeText(bytes, change.path) };
  };
  // A file whose complete text fits is reviewed as both full sides. A larger modified file (real Engine modules) is reviewed as
  // one exact line hunk: every removed and added line with context, both sides' verified Store identities, and a hunk the
  // Engine has proven reconstructs the exact after bytes from the exact before bytes. Large adds and deletes stay refused.
  const identity = side => side && { artifact: side.artifact, byteSize: side.byteSize, executable: side.executable, sha256: side.sha256 };
  const reviewRow = change => {
    if (!change.before && !change.after) p5Fail('p5_review_dossier_change_invalid', 'P5 review cannot represent a changed file with both sides absent.');
    const full = { path: change.path, operation: change.operation, before: change.before, after: change.after };
    if ([change.before, change.after].every(side => !side || side.byteSize <= maxChunkBytes) && canonicalBytes(full).length <= maxChunkBytes - 4096) return full;
    if (!change.before || !change.after)
      p5Fail('p5_review_dossier_file_too_large', `Changed file "${change.path}" cannot fit completely in one 64 KiB review artifact.`);
    const diff = p5ExactLineHunk(change.before.text, change.after.text);
    if (sha256(Buffer.from(p5ApplyExactLineHunk(change.before.text, diff), 'utf8')) !== change.after.sha256)
      p5Fail('p5_review_dossier_diff_mismatch', `The review hunk of "${change.path}" does not reconstruct its exact after bytes.`);
    return { path: change.path, operation: change.operation, before: identity(change.before), after: identity(change.after), diff };
  };
  const paths = new Set();
  const fileChanges = changeManifest.changes.map(change => {
    if (paths.has(change.path)) p5Fail('p5_review_dossier_duplicate_path', `P5 change manifest repeats "${change.path}".`);
    paths.add(change.path);
    return reviewRow({ path: change.path, operation: change.operation, before: readSide(change, 'before'), after: readSide(change, 'after') });
  });

  const groups = [];
  let group = [];
  const makeChunk = (chunkIndex, fileRows) => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairReviewDossierChunk',
    candidateId: candidate.candidateId, candidateManifest: candidateRef, candidateSourceDigest: candidate.candidateSourceDigest,
    ...(candidate.gitCandidate ? { gitCandidate: candidate.gitCandidate } : {}),
    changeManifest: changeManifestRef, receiptId: receipt.receiptId, receipt: receiptRef, chunkIndex, fileChanges: fileRows });
  for (const fileChange of fileChanges) {
    const trial = [...group, fileChange];
    const encodedSize = canonicalBytes(makeChunk(groups.length, trial)).length;
    if (encodedSize <= maxChunkBytes) { group = trial; continue; }
    if (!group.length) p5Fail('p5_review_dossier_file_too_large', `Changed file "${fileChange.path}" cannot fit completely in one 64 KiB review artifact.`);
    groups.push(group);
    group = [fileChange];
    if (canonicalBytes(makeChunk(groups.length, group)).length > maxChunkBytes)
      p5Fail('p5_review_dossier_file_too_large', `Changed file "${fileChange.path}" cannot fit completely in one 64 KiB review artifact.`);
    if (groups.length >= maxChunks) p5Fail('p5_review_dossier_too_large', 'The complete P5 source review requires more than four bounded artifacts.');
  }
  if (group.length) groups.push(group);
  if (!groups.length || groups.length > maxChunks)
    p5Fail('p5_review_dossier_too_large', 'The complete P5 source review cannot fit within four bounded artifacts.');

  const chunks = groups.map((rows, chunkIndex) => {
    const value = makeChunk(chunkIndex, rows);
    validateP5Contract('reviewDossierChunk', value);
    const encoded = canonicalBytes(value);
    if (encoded.length > maxChunkBytes) p5Fail('p5_review_dossier_too_large', 'A P5 review artifact exceeds its 64 KiB bound.');
    const artifact = store.putJson(value);
    store.verifyRef(artifact);
    const byteSize = store.artifactRow(artifact.artifactId)?.byte_size;
    if (!Number.isSafeInteger(byteSize) || byteSize > maxChunkBytes) p5Fail('p5_review_dossier_too_large', 'A persisted P5 review artifact exceeds its 64 KiB bound.');
    return { id: artifact.artifactId, artifact: asRef(artifact), mediaType: 'application/json', byteSize,
      source: 'workflow_output_untrusted', label: `Complete source review ${chunkIndex + 1}/${groups.length}` };
  });
  const requiredReviewSetDigest = canonicalHash(chunks.map(item => item.artifact));
  const totalBytes = chunks.reduce((sum, item) => sum + item.byteSize, 0);
  const sizeProbe = { schemaVersion: 1, kind: 'JudgeEvidenceExpansion', attentionKey: '0'.repeat(64), totalBytes,
    p5Review: { candidateId: candidate.candidateId, receiptId: receipt.receiptId, requiredReviewSetDigest },
    items: chunks.map(item => ({ id: item.id, artifact: item.artifact, source: item.source, mediaType: item.mediaType,
      byteSize: item.byteSize, content: { text: store.readText(item.id) } })) };
  const encodedExpansionBytes = canonicalBytes(sizeProbe).length;
  if (totalBytes > maxExpansionBytes || encodedExpansionBytes > maxExpansionBytes)
    p5Fail('p5_review_dossier_too_large', 'The complete encoded P5 review expansion exceeds 256 KiB.');
  return { candidateId: candidate.candidateId, candidateRef, candidateSourceDigest: candidate.candidateSourceDigest,
    receiptId: receipt.receiptId, receiptRef, changeManifestRef, requiredReviewSetDigest, chunks, totalBytes, encodedExpansionBytes };
}

export function createP5Handoff({ candidate, receipt, approval, continuation, retention, sourceBinding, enrollment, currentEligibility }) {
  if (!candidate || !receipt || receipt.status !== 'passed' || !approval || approval.decision !== 'accept_repair'
    || currentEligibility?.eligible !== true || retention?.status !== 'retained' || !retention.artifact
    || retention.cleanupDeferred !== true)
    p5Fail('p5_handoff_ineligible', 'P5 cannot publish a handoff without current candidate, receipt, Judge/P2 approval and retention proof.');
  const handoff = { schemaVersion: 1, kind: 'ProtectedSelfRepairHandoff',
    handoffId: canonicalHash({ kind: 'P5Handoff', version: 1, linkId: candidate.linkId, candidateId: candidate.candidateId, decisionId: approval.decisionId }),
    candidateId: candidate.candidateId, candidateSourceDigest: candidate.candidateSourceDigest, candidate: candidate.candidateArtifact,
    ...(candidate.gitCandidate ? { gitCandidate: candidate.gitCandidate } : {}),
    baselineId: candidate.baselineId, repositoryIdentity: candidate.repositoryIdentity, sourceBinding, enrollment,
    sourceManifest: candidate.sourceManifest, changeManifest: candidate.changeManifest, verificationPolicy: receipt.verificationPolicy,
    verificationInputs: receipt.verificationInputs, verificationReceipt: receipt.artifact, parentRunId: candidate.parentRunId,
    repairRunId: candidate.repairRunId, linkId: candidate.linkId, incidentId: candidate.incidentId,
    judgeAttemptId: approval.judgeAttemptId, decisionId: approval.decisionId, p2Authorization: approval.authorization,
    p2Approval: approval.artifact, p2Outcome: approval.outcome, retentionRecord: retention.artifact,
    continuationState: continuation.state, hostProvenance: receipt.execution,
    retention: { status: retention.status, revision: retention.revision, retainedAt: retention.retainedAt, cleanupDeferred: retention.cleanupDeferred },
    currentEligibility,
    authority: { sourceCandidateAccepted: true, sourceApplied: false, branchPublished: false,
      productionBuilt: false, binaryInstalled: false, activated: false,
      hostModificationAuthorized: false, hostReplacementAuthorized: false, hostUpdateAuthorized: false } };
  assertValid('protected-self-repair.schema.json', 'handoff', handoff, 'P5 handoff');
  return handoff;
}

// Keep the root's location out of content identities. It is stored only as allocation evidence.
export function p5RootIsInsideSlot(root, slot) {
  const resolvedRoot = realpathSync.native(resolve(root));
  const resolvedSlot = realpathSync.native(resolve(slot));
  const rel = relative(resolvedSlot, resolvedRoot);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function p5PortablePathOrdering(paths) {
  return [...paths].map(validateP5SourcePath).sort(compareText);
}

const P5_GIT_CONFIG = Object.freeze([
  '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.autocrlf=false',
  '-c', 'core.eol=lf', '-c', 'core.attributesFile=', '-c', 'core.excludesFile=', '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL',
]);
const GIT_ENV_KEYS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_TRACE', 'GIT_TRACE_SETUP',
  'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_PAGER', 'GIT_ATTR_SOURCE', 'GIT_OBJECT_DIRECTORY_RELATIVE',
]);
const DEFAULT_SECRET_PATHS = Object.freeze(['.env', '.env.*', '.npmrc', '**/credentials*', '**/*secret*', '**/*.pem', '**/id_rsa*']);

function normalizedAbsolute(path) {
  const real = realpathSync.native(resolve(path));
  return process.platform === 'win32' ? real.replaceAll('/', '\\').toLowerCase() : real;
}

function p5SelectorMatches(path, selectors = []) {
  const value = path.split('/');
  return selectors.some(selector => {
    const pattern = selector.split('/'), pending = [[0, 0]], seen = new Set();
    while (pending.length) {
      const [p, v] = pending.pop(), key = `${p}:${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p === pattern.length) { if (v === value.length) return true; continue; }
      if (pattern[p] === '**') {
        pending.push([p + 1, v]);
        if (v < value.length) pending.push([p, v + 1]);
        continue;
      }
      if (v < value.length && p5ComponentMatches(pattern[p], value[v])) pending.push([p + 1, v + 1]);
    }
    return false;
  });
}

function p5ComponentMatches(pattern, value) {
  const component = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${component}$`).test(value);
}

function p5SelectorMayMatchDescendant(path, selector) {
  const pattern = selector.split('/'), value = path ? path.split('/') : [];
  const pending = [[0, 0]], seen = new Set();
  while (pending.length) {
    const [p, v] = pending.pop(), key = `${p}:${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (v === value.length) return true;
    if (p === pattern.length) continue;
    if (pattern[p] === '**') {
      pending.push([p + 1, v]);
      pending.push([p, v + 1]);
    } else if (p5ComponentMatches(pattern[p], value[v])) pending.push([p + 1, v + 1]);
  }
  return false;
}

function p5GitEnvironment(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  for (const key of GIT_ENV_KEYS) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  for (const [key, value] of Object.entries(overrides)) {
    if (!['GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].includes(key) || typeof value !== 'string' || !/^@[0-9]{1,12} \+0000$/.test(value))
      p5Fail('p5_git_environment_invalid', 'P5 Git command environment overrides are restricted to a UTC Engine commit timestamp.');
    env[key] = value;
  }
  return env;
}

function p5GitRun(gitTool, repositoryRoot, args, { input = null, maxBuffer = 64 * 1024 * 1024, env: overrides = {} } = {}) {
  const root = resolve(repositoryRoot);
  const env = p5GitEnvironment(overrides);
  const result = spawnSync(gitTool.path, [...P5_GIT_CONFIG, '-c', `safe.directory=${root.replace(/\\/g, '/')}`, '-C', root, ...args], {
    cwd: root, env, input, encoding: null, windowsHide: true, timeout: 60_000, maxBuffer,
  });
  if (result.error || result.status !== 0 || result.signal)
    p5Fail('p5_git_source_unavailable', `Pinned Git failed for ${args[0] ?? 'source inspection'}${result.error ? `: ${result.error.message}` : ''}.`);
  return result.stdout;
}

function parseGitTree(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 0) continue;
    if (index === start) { start = index + 1; continue; }
    const record = bytes.subarray(start, index);
    const tab = record.indexOf(0x09);
    if (tab < 0) p5Fail('p5_git_tree_invalid', 'Pinned Git returned a malformed NUL-delimited source tree.');
    const header = /^([0-7]{6}) (blob|commit|tree) ([a-f0-9]{40,64})\s+(-|\d+)$/.exec(record.subarray(0, tab).toString('ascii'));
    let path;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(tab + 1)); }
    catch { p5Fail('p5_path_unsupported', 'P5 source paths must be valid UTF-8 portable ASCII names.'); }
    if (!header)
      p5Fail('p5_git_tree_invalid', 'Pinned Git returned an unsupported source-tree record.');
    records.push({ mode: header[1], objectType: header[2], objectId: header[3], byteSize: header[4] === '-' ? null : Number(header[4]), path });
    start = index + 1;
  }
  return records;
}

function parseCatFileBatch(bytes, objectIds) {
  const objects = new Map();
  let offset = 0;
  for (const expectedId of objectIds) {
    const headerEnd = bytes.indexOf(0x0a, offset);
    if (headerEnd < 0) p5Fail('p5_git_object_invalid', 'Pinned Git returned a truncated object batch header.');
    const header = bytes.subarray(offset, headerEnd).toString('ascii').split(' ');
    if (header.length !== 3 || header[0] !== expectedId || header[1] !== 'blob' || !/^\d+$/.test(header[2]))
      p5Fail('p5_git_object_invalid', 'Pinned Git returned an unexpected object instead of an enrolled source blob.');
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length - headerEnd - 1)
      p5Fail('p5_git_object_invalid', 'Pinned Git returned an invalid source blob size.');
    const contentStart = headerEnd + 1, contentEnd = contentStart + size;
    if (bytes[contentEnd] !== 0x0a) p5Fail('p5_git_object_invalid', 'Pinned Git returned a malformed source blob boundary.');
    objects.set(expectedId, Buffer.from(bytes.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== bytes.length) p5Fail('p5_git_object_invalid', 'Pinned Git returned unrequested trailing source objects.');
  return objects;
}

function p5GitAttributes(gitTool, root, paths) {
  if (!paths.length) return;
  const input = Buffer.from(`${paths.join('\0')}\0`);
  const output = p5GitRun(gitTool, root, ['check-attr', '-z', '--stdin', 'filter', 'ident', 'text', 'eol', 'working-tree-encoding'],
    { input, maxBuffer: Math.max(64 * 1024, Math.min(32 * 1024 * 1024, paths.reduce((sum, path) => sum + path.length + 80, 0))) });
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3 !== 0) p5Fail('p5_git_attributes_invalid', 'Pinned Git returned malformed checkout-attribute evidence.');
  for (let index = 0; index < fields.length; index += 3) {
    const [, attribute, value] = fields.slice(index, index + 3);
    if (!['filter', 'ident', 'text', 'eol', 'working-tree-encoding'].includes(attribute)
      || !['unspecified', 'unset'].includes(value))
      p5Fail('p5_checkout_filter_unsupported', `P5 refuses checkout transformation attribute "${attribute}".`);
  }
}

function verifyGitTool(gitTool, identityReader, { hostIdentityProven = false } = {}) {
  if (!gitTool || typeof gitTool.path !== 'string' || !isAbsolute(gitTool.path) || !HEX.test(gitTool.sha256))
    p5Fail('p5_git_tool_unavailable', 'P5 requires an absolute pinned Git executable identity.');
  let info;
  try { info = lstatSync(gitTool.path, { bigint: true }); } catch { p5Fail('p5_git_tool_unavailable', 'The pinned Git executable cannot be inspected.'); }
  if (!info.isFile() || info.isSymbolicLink() || sha256(readFileSync(gitTool.path)) !== gitTool.sha256)
    p5Fail('p5_git_tool_mismatch', 'The pinned Git executable bytes or file type changed.');
  if (process.platform === 'win32' && typeof identityReader !== 'function' && !hostIdentityProven)
    p5Fail('p5_native_identity_unavailable', 'P5 requires the installed native Windows identity reader before inspecting source paths.');
  if (identityReader) {
    assertNoRedirectedAncestors(dirname(gitTool.path), identityReader);
    nativeIdentity(gitTool.path, info, identityReader);
  }
}

function p5PathSetDigest(paths) {
  return sha256(Buffer.from([...paths].sort(compareText).map(path => `${path}\0`).join(''), 'ascii'));
}

async function readP5NativeIdentity(reader, { root, include = [], exclude = [], maxFiles = 0, maxBytes = 0, expectedPathsDigest = undefined }) {
  if (typeof reader !== 'function') p5Fail('p5_native_identity_unavailable', 'P5 requires the attached Rust Host native source identity reader on Windows.');
  let result;
  try { result = await reader({ root, include, exclude, maxFiles, maxBytes, expectedPathsDigest }); }
  catch (error) { p5Fail('p5_native_identity_unavailable', `The Rust Host could not establish native source identity${error?.code ? ` (${error.code})` : ''}.`); }
  if (result?.refused) p5Fail('p5_native_identity_unavailable', `The Rust Host refused native source identity (${result.code ?? 'refused'}): ${String(result.message ?? 'no detail').slice(0, 512)}`);
  if (!result || typeof result.canonicalRoot !== 'string' || !result.rootIdentity
    || typeof result.rootIdentity.volumeId !== 'string' || typeof result.rootIdentity.fileId !== 'string'
    || !HEX.test(result.snapshotDigest) || !HEX.test(result.pathDigest)
    || !Number.isSafeInteger(result.fileCount) || !Number.isSafeInteger(result.totalBytes)
    || include.length > 0 && !HEX.test(result.contentDigest || ''))
    p5Fail('p5_native_identity_unavailable', 'The Rust Host returned incomplete native source identity evidence.');
  const normalize = value => {
    const text = resolve(value).replaceAll('/', '\\').replace(/\\+$/, '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  if (normalize(result.canonicalRoot) !== normalize(root))
    p5Fail('p5_native_identity_unavailable', 'The Rust Host resolved a different native source root than the enrolled path.');
  return result;
}

function p5NativeContentDigest(entries) {
  const records = sortEntries(entries).map(entry => `${entry.path}\0${entry.byteSize}\0${entry.sha256}\n`).join('');
  return sha256(Buffer.from(records, 'ascii'));
}

/**
 * Capture source bytes only when an authenticated Rust Host independently hashes and scans the
 * same selected paths both before and after the JavaScript read. This keeps the Windows path
 * fail-closed while allowing JS to seal content-addressed objects without trusting Node's lstat
 * identity fields.
 */
export async function inventoryP5SourceWithHost(root, { nativeSourceReader, maxFiles = 20_000,
  maxBytes = 512 * 1024 * 1024, include = ['**'], exclude = ['.git/**', '.p5/**'],
  identityReader = null, executableFor = null } = {}) {
  if (process.platform === 'win32' && typeof nativeSourceReader !== 'function')
    p5Fail('p5_native_identity_unavailable', 'Windows P5 source capture requires the authenticated Rust Host source identity reader.');
  const options = { maxFiles, maxBytes, include, excluded: exclude, identityReader, executableFor,
    hostIdentityProven: process.platform === 'win32' && typeof identityReader !== 'function' };
  const before = await readP5NativeIdentity(nativeSourceReader, { root, include, exclude, maxFiles, maxBytes });
  const inventory = inventoryP5Source(root, options);
  const expectedPathsDigest = p5PathSetDigest(inventory.entries.map(entry => entry.path));
  const contentDigest = p5NativeContentDigest(inventory.entries);
  const after = await readP5NativeIdentity(nativeSourceReader, { root, include, exclude, maxFiles, maxBytes, expectedPathsDigest });
  if (before.fileCount !== inventory.entries.length || after.fileCount !== inventory.entries.length
    || before.totalBytes !== inventory.totalBytes || after.totalBytes !== inventory.totalBytes
    || before.pathDigest !== expectedPathsDigest || after.pathDigest !== expectedPathsDigest
    || before.contentDigest !== contentDigest || after.contentDigest !== contentDigest
    || before.snapshotDigest !== after.snapshotDigest
    || canonicalHash(before.rootIdentity) !== canonicalHash(after.rootIdentity))
    p5Fail('p5_source_drift', 'The Rust Host source identity, selected paths or byte digests changed during the bounded source capture.');
  return { ...inventory, nativeEvidence: { snapshotDigest: after.snapshotDigest, pathDigest: after.pathDigest,
    contentDigest: after.contentDigest, rootIdentity: after.rootIdentity, hostPid: after.hostPid,
    generation: after.generation, epoch: after.epoch } };
}

function p5DirectoryEntries(path) {
  const before = readdirSync(path).sort(compareText);
  const after = readdirSync(path).sort(compareText);
  if (canonicalHash(before) !== canonicalHash(after)) p5Fail('p5_workspace_drift', `The P5 workspace directory changed during enumeration: "${path}".`);
  return before;
}

function p5EnsureDirectory(path) {
  try { mkdirSync(path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let info;
  try { info = lstatSync(path, { bigint: true }); }
  catch { p5Fail('p5_workspace_unavailable', `The P5 workspace directory cannot be inspected: "${path}".`); }
  if (!info.isDirectory() || info.isSymbolicLink()) p5Fail('p5_topology_unsupported', `The P5 workspace path is not a plain directory: "${path}".`);
}

function p5EnsureDirectoryChain(root, components) {
  let current = root;
  for (const component of components) {
    current = join(current, component);
    p5EnsureDirectory(current);
  }
  return current;
}

function p5WriteExclusive(path, bytes) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    p5Fail('p5_workspace_write_failed', `P5 could not create a baseline file exclusively: "${path}" (${error.code || 'error'}).`);
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) p5Fail('p5_workspace_write_failed', `P5 stopped while writing a baseline file: "${path}".`);
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof ProtectedSelfRepairError) throw error;
    p5Fail('p5_workspace_write_failed', `P5 could not flush a baseline file: "${path}" (${error.code || 'error'}).`);
  } finally { closeSync(fd); }
  return true;
}

function p5JournalHasRecord(store, runId, type, recordRef) {
  for (const row of store.all('SELECT envelope_json, envelope_sha256, envelope_byte_size FROM journal_events WHERE run_id = ? AND event_type = ? ORDER BY sequence', runId, type)) {
    const bytes = Buffer.from(row.envelope_json, 'utf8');
    if (bytes.length !== row.envelope_byte_size || sha256(bytes) !== row.envelope_sha256)
      p5Fail('p5_journal_corrupt', `A P5 ${type} journal envelope failed digest verification.`);
    let envelope;
    try { envelope = parseStrictJson(row.envelope_json); }
    catch { p5Fail('p5_journal_corrupt', `A P5 ${type} journal envelope is malformed.`); }
    assertValid('journal-event-v2.schema.json', null, envelope, `P5 ${type} journal envelope`);
    if (envelope.runId === runId && envelope.type === type
      && canonicalHash(envelope.payload?.record) === canonicalHash(recordRef)) return true;
  }
  return false;
}

/** Materialize only enrolled baseline bytes inside the slot named by a durable preparation intent. */
export async function prepareP5WorkspaceFromIntent({ store, intentRef, nativeSourceReader, recovery = false,
  prepareGitRepository = null,
  preparedAt = new Date().toISOString() }) {
  if (!store || typeof recovery !== 'boolean') p5Fail('p5_preparation_invalid', 'P5 workspace preparation requires its Store and an explicit recovery mode.');
  if (process.platform === 'win32' && typeof nativeSourceReader !== 'function')
    p5Fail('p5_native_identity_unavailable', 'Windows P5 workspace preparation requires the authenticated Rust Host identity reader.');
  store.verifyRef(intentRef);
  const intent = store.readJson(intentRef.artifactId);
  validateP5Contract('preparationIntent', intent);
  if (canonicalHash(intent) !== intentRef.sha256) p5Fail('p5_preparation_invalid', 'The durable P5 preparation intent digest changed.');
  if (!p5JournalHasRecord(store, intent.repairRunId, 'self_repair.preparation_intent', intentRef))
    p5Fail('p5_preparation_intent_missing', 'P5 will not write the workspace until the matching intent is durably journaled.');
  for (const ref of [intent.enrollment, intent.baselineManifest, intent.sourceManifest, intent.sourceBinding]) store.verifyRef(ref);
  const enrollment = store.readJson(intent.enrollment.artifactId);
  const baseline = store.readJson(intent.baselineManifest.artifactId);
  const sourceManifest = store.readJson(intent.sourceManifest.artifactId);
  const sourceBinding = store.readJson(intent.sourceBinding.artifactId);
  const verificationInputs = store.readJson(intent.verificationInputs.artifactId);
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('baselineManifest', baseline);
  validateP5Contract('sourceManifest', sourceManifest);
  validateP5Contract('sourceBinding', sourceBinding);
  validateP5Contract('verificationInputs', verificationInputs);
  const workspace = intent.workspace;
  if (intent.enrollment.sha256 !== canonicalHash(enrollment) || intent.baselineManifest.sha256 !== canonicalHash(baseline)
    || intent.sourceManifest.sha256 !== canonicalHash(sourceManifest) || intent.sourceBinding.sha256 !== canonicalHash(sourceBinding)
    || canonicalHash(enrollment.baselineManifest) !== canonicalHash(intent.baselineManifest)
    || canonicalHash(baseline.sourceManifest) !== canonicalHash(intent.sourceManifest)
    || canonicalHash(enrollment.workspace) !== canonicalHash(workspace)
    || canonicalHash(enrollment.verificationPolicy) !== canonicalHash(verificationInputs.verificationPolicy)
    || verificationInputs.incidentId == null || verificationInputs.outcomeId == null
    || sourceBinding.parentRunId !== intent.parentRunId || sourceBinding.enrollmentId !== enrollment.enrollmentId
    || sourceBinding.baselineId !== enrollment.baselineId || canonicalHash(sourceBinding.baselineManifest) !== canonicalHash(intent.baselineManifest)
    || canonicalHash(sourceBinding.parentPublication) !== canonicalHash(enrollment.parentPublication)
    || canonicalHash(sourceBinding.profile) !== canonicalHash(enrollment.profile)
    || canonicalHash(sourceBinding.runningSourceRelease) !== canonicalHash(enrollment.runningSourceRelease)
    || sourceManifest.sourceDigest !== enrollment.effectiveSourceDigest || baseline.baselineId !== enrollment.baselineId
    || baseline.effectiveSourceDigest !== enrollment.effectiveSourceDigest || baseline.enrollmentId !== enrollment.enrollmentId)
    p5Fail('p5_preparation_mismatch', 'The P5 preparation intent differs from the installed enrollment, source binding or immutable baseline.');
  if (typeof workspace.canonicalRoot !== 'string' || !isAbsolute(workspace.canonicalRoot)
    || pathKey(realpathSync.native(workspace.canonicalRoot)) !== pathKey(workspace.canonicalRoot))
    p5Fail('p5_workspace_binding_mismatch', 'The enrolled P5 slot root is not its exact canonical path.');
  const workspaceRoot = resolve(workspace.canonicalRoot);
  const link = store.get(`SELECT * FROM run_links WHERE id = ? AND parent_run_id = ? AND repair_run_id = ?`, intent.linkId, intent.parentRunId, intent.repairRunId);
  const parentRun = store.get('SELECT * FROM runs WHERE id = ?', intent.parentRunId);
  const repairRun = store.get('SELECT * FROM runs WHERE id = ?', intent.repairRunId);
  const workspaceRow = store.get('SELECT * FROM workspaces WHERE id = ?', workspace.workspaceId);
  if (!link || link.state !== 'open' || link.continuation_contract !== 'logical_policy'
    || !['suspension_requested', 'suspended_for_repair'].includes(link.parent_suspension_state)
    || !parentRun || !repairRun || !workspaceRow || link.repair_workspace_id !== workspace.workspaceId
    || repairRun.workspace_id !== workspace.workspaceId || link.parent_workspace_id !== parentRun.workspace_id
    || parentRun.published_version_id !== enrollment.parentPublication.publishedVersionId
    || repairRun.published_version_id !== enrollment.repairPublication.publishedVersionId
    || link.incident_id == null || !link.authorization_artifact_id)
    p5Fail('p5_preparation_authorization_missing', 'P5 workspace preparation requires the exact live P2 Parent/Repair link and enrolled publications.');
  const admittedAttempt = store.get(`SELECT 1 FROM attempts WHERE run_id = ?
    AND (state NOT IN ('scheduled','waiting') OR invocation_artifact_id IS NOT NULL OR id IN (SELECT attempt_id FROM attempt_custody)) LIMIT 1`, intent.repairRunId);
  if (repairRun.state !== 'queued' || admittedAttempt)
    p5Fail('p5_preparation_stale', 'P5 may materialize the baseline only while its Repair is queued and no Developer or other Repair Attempt has been admitted.');
  if (!p5JournalHasRecord(store, intent.parentRunId, 'self_repair.source_bound', intent.sourceBinding))
    p5Fail('p5_source_binding_missing', 'P5 workspace preparation requires the source binding journaled by the exact Parent Run.');
  const p2Authorization = store.readJson(link.authorization_artifact_id);
  if (p2Authorization.contract !== 'logical_policy' || p2Authorization.parentRunId !== intent.parentRunId
    || p2Authorization.repairRunId !== intent.repairRunId || p2Authorization.incidentId !== link.incident_id
    || p2Authorization.repairWorkspaceId !== workspace.workspaceId
    || p2Authorization.repairPublishedVersionId !== enrollment.repairPublication.publishedVersionId
    || p2Authorization.repairSnapshotSha256 !== enrollment.repairPublication.snapshotSha256
    || !p2Authorization.selfRepairProfile || canonicalHash(p2Authorization.selfRepairProfile) !== canonicalHash(enrollment.profile)
    || !p2Authorization.p5Enrollment || canonicalHash(p2Authorization.p5Enrollment) !== canonicalHash(intent.enrollment)
    || !p2Authorization.p5SourceBinding || canonicalHash(p2Authorization.p5SourceBinding) !== canonicalHash(intent.sourceBinding)
    || !p2Authorization.verificationInputs || canonicalHash(p2Authorization.verificationInputs) !== canonicalHash(intent.verificationInputs)
    || p2Authorization.outcomeId !== verificationInputs.outcomeId
    || p2Authorization.outcomeRevision !== verificationInputs.outcomeRevision
    || verificationInputs.incidentId !== link.incident_id)
    p5Fail('p5_preparation_authorization_mismatch', 'The durable P2 authorization does not bind this P5 workspace and Repair publication.');
  const enrolledProfile = store.readJson(enrollment.profile.artifactId);
  verifyP5VerificationInputsCurrent({ store, enrollment, profile: enrolledProfile, parentRunId: intent.parentRunId, inputs: verificationInputs });
  const registeredRoot = realpathSync.native(workspaceRow.cwd);
  const parentWorkspace = store.get('SELECT * FROM workspaces WHERE id = ?', parentRun.workspace_id);
  if (!parentWorkspace || pathKey(registeredRoot) !== pathKey(workspaceRoot)
    || workspaceRootsOverlap(workspaceRoot, realpathSync.native(parentWorkspace.cwd))
    || workspaceRootsOverlap(workspaceRoot, realpathSync.native(baseline.repositoryRoot))
    || workspaceRootsOverlap(workspaceRoot, realpathSync.native(store.root)))
    p5Fail('p5_workspace_overlap', 'The enrolled P5 slot overlaps its Parent, original source or Store root, or differs from its registration.');
  const sourceRoot = resolve(workspaceRoot, 'source');
  const rootBefore = await readP5NativeIdentity(nativeSourceReader, { root: workspaceRoot });
  if (canonicalHash(rootBefore.rootIdentity) !== canonicalHash(workspace.nativeIdentity))
    p5Fail('p5_workspace_identity_mismatch', 'The enrolled P5 workspace allocation identity changed before preparation.');
  const topLevel = p5DirectoryEntries(workspaceRoot);
  const allowedTop = new Set(['.p5', 'source']);
  if ((!recovery && topLevel.length !== 0) || topLevel.some(name => !allowedTop.has(name)))
    p5Fail('p5_workspace_conflict', 'The enrolled single-use P5 slot is not empty or contains an unrecognized path.');

  const budgets = enrollment.budgets;
  if (sourceManifest.entries.length < 1 || sourceManifest.entries.length > budgets.maxSourceFiles
    || sourceManifest.entries.reduce((sum, entry) => sum + entry.byteSize, 0) > budgets.maxSourceBytes)
    p5Fail('p5_source_budget_exceeded', 'The enrolled baseline exceeds the captured P5 workspace budget.');
  const expectedEntries = sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
  const baselineModes = new Map(expectedEntries.map(entry => [entry.path, entry.executable]));
  const sourceBeforeInfo = (() => { try { return lstatSync(sourceRoot, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
  if (sourceBeforeInfo && (!recovery || !sourceBeforeInfo.isDirectory() || sourceBeforeInfo.isSymbolicLink()))
    p5Fail('p5_workspace_conflict', 'The P5 source directory exists outside a recoverable durable preparation.');
  if (!sourceBeforeInfo) p5EnsureDirectory(sourceRoot);
  const initialInventory = sourceBeforeInfo
    ? await inventoryP5SourceWithHost(sourceRoot, { nativeSourceReader, include: ['**'], exclude: prepareGitRepository ? ['.git/**'] : [],
      maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes,
      executableFor: process.platform === 'win32' ? path => baselineModes.get(path) ?? false : null })
    : { entries: [], sourceDigest: p5SourceDigest([]), totalBytes: 0, nativeEvidence: null };
  const expectedByPath = new Map(sourceManifest.entries.map(entry => [entry.path, entry]));
  for (const existing of initialInventory.entries) {
    const expected = expectedByPath.get(existing.path);
    if (!expected || expected.sha256 !== existing.sha256 || expected.byteSize !== existing.byteSize
      || expected.executable !== existing.executable)
      p5Fail('p5_workspace_conflict', `A partial P5 preparation contains a file that differs from the enrolled baseline: "${existing.path}".`);
  }
  if (initialInventory.entries.length && !recovery)
    p5Fail('p5_workspace_conflict', 'P5 will not adopt pre-existing files in a slot without a durable preparation recovery.');

  const p5Root = p5EnsureDirectoryChain(workspaceRoot, ['.p5']);
  const controlRoot = p5EnsureDirectoryChain(p5Root, ['control']);
  const verifyRoot = p5EnsureDirectoryChain(p5Root, ['verify']);
  const verifySourceRoot = p5EnsureDirectoryChain(verifyRoot, ['source']);
  const verifyScratchRoot = p5EnsureDirectoryChain(verifyRoot, ['scratch']);
  if (canonicalHash(p5DirectoryEntries(workspaceRoot)) !== canonicalHash(['.p5', 'source'])
    || canonicalHash(p5DirectoryEntries(p5Root)) !== canonicalHash(['control', 'verify'])
    || canonicalHash(p5DirectoryEntries(verifyRoot)) !== canonicalHash(['scratch', 'source']))
    p5Fail('p5_workspace_conflict', 'The P5 slot contains an unrecognized path outside the enrolled workspace layout.');
  for (const directory of [controlRoot, verifySourceRoot, verifyScratchRoot]) {
    if (prepareGitRepository && directory === controlRoot) continue;
    if (p5DirectoryEntries(directory).length) p5Fail('p5_workspace_conflict', `P5 preparation found unexpected content in "${directory}".`);
  }
  for (const directory of [p5Root, controlRoot, verifyRoot, verifySourceRoot, verifyScratchRoot])
    await readP5NativeIdentity(nativeSourceReader, { root: directory });
  for (const entry of sourceManifest.entries) {
    validateP5SourcePath(entry.path);
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      p5Fail('p5_baseline_object_mismatch', `The baseline object for "${entry.path}" failed digest verification.`);
    const parts = entry.path.split('/');
    const target = join(sourceRoot, ...parts);
    p5EnsureDirectoryChain(sourceRoot, parts.slice(0, -1));
    const wrote = p5WriteExclusive(target, bytes);
    if (!wrote) {
      let info;
      try { info = lstatSync(target, { bigint: true }); } catch { p5Fail('p5_workspace_conflict', `A baseline path changed during preparation: "${entry.path}".`); }
      if (!info.isFile() || info.isSymbolicLink()) p5Fail('p5_topology_unsupported', `A prepared baseline path is not a regular file: "${entry.path}".`);
      const existingBytes = readFileSync(target);
      if (existingBytes.length !== entry.byteSize || sha256(existingBytes) !== entry.sha256)
        p5Fail('p5_workspace_conflict', `A partial P5 preparation contains different bytes at "${entry.path}".`);
    }
    if (process.platform !== 'win32') {
      try { chmodSync(target, entry.executable ? 0o755 : 0o644); }
      catch { p5Fail('p5_workspace_write_failed', `P5 could not apply the captured source mode to "${entry.path}".`); }
    }
  }
  const pathPolicy = baseline.pathPolicy;
  const finalInventory = await inventoryP5SourceWithHost(sourceRoot, { nativeSourceReader,
    include: pathPolicy.include, exclude: pathPolicy.exclude, maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes,
    executableFor: process.platform === 'win32' ? path => baselineModes.get(path) ?? false : null });
  if (canonicalHash(finalInventory.entries) !== canonicalHash(expectedEntries)
    || finalInventory.sourceDigest !== enrollment.effectiveSourceDigest)
    p5Fail('p5_workspace_mismatch', 'The materialized P5 source does not match every enrolled baseline path, byte and mode.');
  const rootAfter = await readP5NativeIdentity(nativeSourceReader, { root: workspaceRoot });
  if (canonicalHash(rootAfter.rootIdentity) !== canonicalHash(rootBefore.rootIdentity)
    || rootAfter.snapshotDigest !== rootBefore.snapshotDigest)
    p5Fail('p5_workspace_identity_mismatch', 'The enrolled P5 workspace root changed during baseline materialization.');
  const gitRepository = prepareGitRepository ? await prepareGitRepository({ store, intentRef, intent, enrollment, baseline,
    sourceManifest, sourceRoot, workspaceRoot, nativeSourceReader, expectedEntries }) : null;
  if (prepareGitRepository && (!gitRepository || gitRepository.kind !== 'ProtectedSelfRepairGitRepository'))
    p5Fail('p5_git_preparation_invalid', 'The P5 Git adapter did not return a verified private repository identity.');
  const evidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairWorkspacePreparation', intent: intentRef,
    workspaceRoot, sourceRoot, workspaceIdentity: rootAfter.rootIdentity, sourceIdentity: finalInventory.nativeEvidence.rootIdentity,
    baselineId: enrollment.baselineId, sourceDigest: finalInventory.sourceDigest, snapshotDigest: finalInventory.nativeEvidence.snapshotDigest,
    pathDigest: finalInventory.nativeEvidence.pathDigest, contentDigest: finalInventory.nativeEvidence.contentDigest,
    fileCount: finalInventory.entries.length, totalBytes: finalInventory.totalBytes, hostPid: finalInventory.nativeEvidence.hostPid,
    generation: finalInventory.nativeEvidence.generation, epoch: finalInventory.nativeEvidence.epoch, preparedAt,
    ...(gitRepository ? { gitRepository } : {}) };
  validateP5Contract('workspacePreparation', evidence);
  const evidenceArtifact = store.putJson(evidence);
  store.verifyRef(evidenceArtifact);
  return { evidence, evidenceArtifact: asRef(evidenceArtifact), inventory: finalInventory };
}

async function readP5NativeToolIdentity(reader, path) {
  if (typeof reader !== 'function') p5Fail('p5_native_identity_unavailable', 'P5 requires the attached Rust Host native identity reader for the pinned Git executable.');
  let result, lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { result = await reader({ path }); lastError = null; break; }
    catch (error) {
      lastError = error;
      if (attempt === 0 && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(error?.code))
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      else break;
    }
  }
  if (lastError) p5Fail('p5_native_identity_unavailable', `The Rust Host could not establish pinned Git identity${lastError?.code ? ` (${lastError.code})` : ''}.`);
  if (result?.refused) p5Fail('p5_native_identity_unavailable', `The Rust Host refused pinned Git identity (${result.code ?? 'refused'}): ${String(result.message ?? 'no detail').slice(0, 512)}`);
  if (!result || typeof result.canonicalPath !== 'string' || !result.identity
    || typeof result.identity.volumeId !== 'string' || typeof result.identity.fileId !== 'string'
    || !Number.isSafeInteger(result.byteSize) || !Number.isSafeInteger(result.linkCount) || result.linkCount < 1)
    p5Fail('p5_native_identity_unavailable', 'The Rust Host returned incomplete pinned Git identity evidence.');
  const normalize = value => {
    const text = resolve(value).replaceAll('/', '\\').replace(/\\+$/, '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  if (normalize(result.canonicalPath) !== normalize(path))
    p5Fail('p5_native_identity_unavailable', 'The Rust Host resolved a different path than the pinned Git executable.');
  return result;
}

/**
 * Collects a clean committed P5 baseline from pinned Git objects and exact working bytes.
 * On Windows an authenticated nativeSourceReader backed by the Rust Host is mandatory;
 * JavaScript pathname metadata is never used as a replacement for native topology checks.
 */
export async function collectP5GitBaseline({ store, repositoryRoot, gitTool, repositoryIdentity, enrollmentId, runningSourceRelease,
  pathPolicy, budgets, expectedCommit = null, identityReader = null, nativeSourceReader = null, nativeToolIdentityReader = null,
  expectedRepositoryRoot = null, persist = true, capturedAt = new Date().toISOString() }) {
  if (!store || !repositoryRoot || !repositoryIdentity || !enrollmentId || !runningSourceRelease || !pathPolicy || !budgets)
    p5Fail('p5_baseline_invalid', 'P5 baseline capture requires the Store, enrolled source policy, repository identity, runtime release and finite budgets.');
  if (typeof persist !== 'boolean') p5Fail('p5_baseline_invalid', 'P5 baseline persistence must be an explicit boolean.');
  validateP5Contract('repositoryIdentity', repositoryIdentity);
  if (repositoryIdentity.enrollmentId !== enrollmentId)
    p5Fail('p5_source_policy_invalid', 'P5 source policy or repository enrollment binding is invalid.');
  const pathPolicyDigest = assertP5SourcePathPolicy(pathPolicy);
  if (!Number.isSafeInteger(budgets.maxSourceFiles) || budgets.maxSourceFiles < 1
    || !Number.isSafeInteger(budgets.maxSourceBytes) || budgets.maxSourceBytes < 0)
    p5Fail('p5_budget_invalid', 'P5 baseline source budgets must be finite positive integers.');
  verifyGitTool(gitTool, identityReader, { hostIdentityProven: process.platform === 'win32' });
  let gitNativeBefore = null;
  if (process.platform === 'win32') {
    const gitInfo = (() => { try { return lstatSync(gitTool.path, { bigint: true }); } catch { return null; } })();
    if (!gitInfo?.isFile() || gitInfo.isSymbolicLink()) p5Fail('p5_git_tool_unavailable', 'The pinned Git executable cannot be inspected.');
    gitNativeBefore = await readP5NativeToolIdentity(nativeToolIdentityReader, gitTool.path);
    if (gitNativeBefore.byteSize !== Number(gitInfo.size))
      p5Fail('p5_git_tool_mismatch', 'The Host native file identity did not bind the pinned Git executable size.');
  }
  const root = resolve(repositoryRoot);
  let rootInfo;
  try { rootInfo = lstatSync(root, { bigint: true }); } catch { p5Fail('p5_repository_unavailable', 'The enrolled Git working directory cannot be inspected.'); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) p5Fail('p5_topology_unsupported', 'P5 source root must be a stable real directory.');
  if (process.platform !== 'win32' || identityReader) assertNoRedirectedAncestors(root, identityReader);
  const canonicalRoot = realpathSync.native(root);
  if (expectedRepositoryRoot && pathKey(canonicalRoot) !== pathKey(expectedRepositoryRoot))
    p5Fail('p5_repository_root_mismatch', 'The live source worktree path differs from the enrolled canonical source root.');
  const objectFormat = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--show-object-format=storage']).toString('utf8').trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) p5Fail('p5_git_object_format_unsupported', 'Pinned Git reported an unsupported object format.');
  const commit = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
  const objectIdLength = objectFormat === 'sha1' ? 40 : 64;
  if (!(new RegExp(`^[a-f0-9]{${objectIdLength}}$`)).test(commit) || expectedCommit && commit !== expectedCommit)
    p5Fail('p5_git_commit_mismatch', 'The live Git commit differs from the exact enrolled source baseline.');
  const tree = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).toString('ascii').trim();
  if (!(new RegExp(`^[a-f0-9]{${objectIdLength}}$`)).test(tree)) p5Fail('p5_git_tree_invalid', 'Pinned Git did not resolve the exact committed tree.');
  const commonText = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString('utf8').trim();
  const commonDirectory = realpathSync.native(isAbsolute(commonText) ? commonText : resolve(canonicalRoot, commonText));
  const commonInfo = lstatSync(commonDirectory, { bigint: true });
  if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) p5Fail('p5_topology_unsupported', 'The Git common directory is not a stable real directory.');
  if (process.platform !== 'win32' || identityReader) assertNoRedirectedAncestors(commonDirectory, identityReader);
  const commonNativeBefore = process.platform === 'win32'
    ? await readP5NativeIdentity(nativeSourceReader, { root: commonDirectory }) : null;
  const commonIdentity = commonNativeBefore?.rootIdentity ?? nativeIdentity(commonDirectory, commonInfo, identityReader, { directory: true });
  const expectedCommon = process.platform === 'win32' ? repositoryIdentity.canonicalCommonDirectory.toLowerCase() : repositoryIdentity.canonicalCommonDirectory;
  const actualCommon = process.platform === 'win32' ? commonDirectory.toLowerCase() : commonDirectory;
  if (expectedCommon !== actualCommon || canonicalHash(commonIdentity) !== canonicalHash(repositoryIdentity.nativeDirectoryIdentity))
    p5Fail('p5_repository_identity_mismatch', 'The live Git common directory or native directory identity differs from enrollment.');

  const status = p5GitRun(gitTool, canonicalRoot, ['status', '--porcelain=v2', '--untracked-files=all', '-z']);
  const staged = spawnGitDiff(gitTool, canonicalRoot, ['diff', '--cached', '--no-ext-diff', '--exit-code', 'HEAD', '--']);
  const worktree = spawnGitDiff(gitTool, canonicalRoot, ['diff', '--no-ext-diff', '--exit-code', 'HEAD', '--']);
  if (staged !== 0 || worktree !== 0) p5Fail('p5_source_dirty', 'P5 requires a clean committed source checkout with no staged or unstaged tracked changes.');
  const untrackedBytes = p5GitRun(gitTool, canonicalRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedBytes.toString('utf8').split('\0').filter(Boolean);
  const untrackedIncluded = untracked.filter(path => p5SelectorMatches(path, pathPolicy.include) && !p5SelectorMatches(path, pathPolicy.exclude));
  if (untrackedIncluded.length) p5Fail('p5_source_dirty', 'P5 refuses untracked non-ignored files inside the enrolled source inclusion set.');

  const treeEntries = parseGitTree(p5GitRun(gitTool, canonicalRoot, ['ls-tree', '-rz', '--full-tree', '-l', commit]));
  const excludedPaths = [];
  const included = [];
  const seenFolded = new Map();
  for (const item of treeEntries) {
    const includedByPolicy = p5SelectorMatches(item.path, pathPolicy.include);
    if (!includedByPolicy || p5SelectorMatches(item.path, pathPolicy.exclude)) { excludedPaths.push(item.path); continue; }
    const path = validateP5SourcePath(item.path);
    const folded = path.toLowerCase();
    const prior = seenFolded.get(folded);
    if (prior && prior !== path) p5Fail('p5_case_collision', `P5 source paths "${prior}" and "${path}" alias on Windows.`);
    seenFolded.set(folded, path);
    if (p5SelectorMatches(path, [...DEFAULT_SECRET_PATHS, ...(pathPolicy.secretPaths ?? [])]))
      p5Fail('p5_tracked_secret', `P5 refuses tracked secret input "${path}".`);
    if (item.mode !== '100644' && item.mode !== '100755' || item.objectType !== 'blob' || item.byteSize === null)
      p5Fail('p5_topology_unsupported', `P5 refuses symlinks, gitlinks and non-regular source objects: "${path}".`);
    if (included.length >= budgets.maxSourceFiles || item.byteSize > budgets.maxSourceBytes)
      p5Fail('p5_source_budget_exceeded', 'The enrolled committed source exceeds its file-count or byte budget.');
    included.push({ ...item, path, executable: item.mode === '100755' });
  }
  if (!included.length) p5Fail('p5_source_empty', 'The enrolled source inclusion policy selected no committed source files.');
  const totalExpected = included.reduce((sum, item) => sum + item.byteSize, 0);
  if (!Number.isSafeInteger(totalExpected) || totalExpected > budgets.maxSourceBytes)
    p5Fail('p5_source_budget_exceeded', 'The enrolled committed source exceeds its byte budget.');
  p5GitAttributes(gitTool, canonicalRoot, included.map(item => item.path));
  const expectedPathDigest = p5PathSetDigest(included.map(item => item.path));
  const nativeSourceBefore = process.platform === 'win32'
    ? await readP5NativeIdentity(nativeSourceReader, { root: canonicalRoot, include: pathPolicy.include, exclude: pathPolicy.exclude,
      maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes, expectedPathsDigest: expectedPathDigest }) : null;
  if (nativeSourceBefore && (nativeSourceBefore.fileCount !== included.length || nativeSourceBefore.totalBytes !== totalExpected))
    p5Fail('p5_native_inventory_mismatch', 'The Rust Host native source inventory differs from the exact committed source manifest.');

  const objectIds = [...new Set(included.map(item => item.objectId))];
  const objectInput = Buffer.from(`${objectIds.join('\n')}\n`);
  const objectBatch = p5GitRun(gitTool, canonicalRoot, ['cat-file', '--batch'], { input: objectInput, maxBuffer: Math.max(64 * 1024 * 1024, budgets.maxSourceBytes + objectIds.length * 128) });
  const blobs = parseCatFileBatch(objectBatch, objectIds);
  const entries = [], sourceObjects = [];
  let actualBytes = 0;
  for (const item of included) {
    const blob = blobs.get(item.objectId);
    if (!blob || blob.length !== item.byteSize) p5Fail('p5_git_object_mismatch', `The committed Git blob for "${item.path}" failed its size check.`);
    actualBytes += blob.length;
    if (actualBytes > budgets.maxSourceBytes) p5Fail('p5_source_budget_exceeded', 'The enrolled committed source exceeds its byte budget.');
    const absolutePath = resolve(canonicalRoot, ...item.path.split('/'));
    if (process.platform !== 'win32' || identityReader) assertNoRedirectedAncestors(dirname(absolutePath), identityReader);
    let info;
    try { info = lstatSync(absolutePath, { bigint: true }); } catch { p5Fail('p5_source_worktree_mismatch', `The committed source file "${item.path}" is missing from the checkout.`); }
    if (!info.isFile() || info.isSymbolicLink()) p5Fail('p5_topology_unsupported', `P5 refuses a non-regular working source file: "${item.path}".`);
    const identity = process.platform === 'win32' && !identityReader ? null : nativeIdentity(absolutePath, info, identityReader);
    const workingBytes = readFileSync(absolutePath);
    const after = lstatSync(absolutePath, { bigint: true });
    const afterIdentity = process.platform === 'win32' && !identityReader ? null : nativeIdentity(absolutePath, after, identityReader);
    if (workingBytes.length !== blob.length || !workingBytes.equals(blob) || after.size !== info.size || after.mtimeNs !== info.mtimeNs
      || identity && (identity.fileId !== afterIdentity.fileId || identity.volumeId !== afterIdentity.volumeId))
      p5Fail('p5_source_worktree_mismatch', `The effective working bytes for "${item.path}" differ from the pinned Git blob or changed during capture.`);
    const fileEntry = { path: item.path, type: 'regular', byteSize: blob.length, sha256: sha256(blob), executable: item.executable };
    entries.push(fileEntry);
    if (persist) {
      const artifact = store.putBytes(blob, 'application/octet-stream');
      store.verifyRef(artifact);
      sourceObjects.push({ ...fileEntry, artifact: asRef(artifact) });
    }
  }
  const sortedEntries = sortEntries(entries);
  const sourceDigest = p5SourceDigest(sortedEntries);
  const nativeContentDigest = p5NativeContentDigest(sortedEntries);
  store.verifyRef(runningSourceRelease);
  const baselineId = p5BaselineId({ repositoryIdentity, gitObjectFormat: objectFormat, baseCommit: commit, baseTree: tree, pathPolicyDigest, effectiveSourceDigest: sourceDigest });
  let sourceManifest = null, sourceManifestArtifact = null, baselineManifest = null, baselineManifestArtifact = null;
  if (persist) {
    sourceManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest, entries: sortEntries(sourceObjects) };
    validateP5Contract('sourceManifest', sourceManifest);
    sourceManifestArtifact = store.putJson(sourceManifest);
    store.verifyRef(sourceManifestArtifact);
    baselineManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairBaselineManifest', enrollmentId, repositoryIdentity,
      repositoryRoot: canonicalRoot, gitObjectFormat: objectFormat, baseCommit: commit, baseTree: tree, pathPolicyDigest, pathPolicy,
      effectiveSourceDigest: sourceDigest, baselineId, sourceManifest: asRef(sourceManifestArtifact), runningSourceRelease: asRef(runningSourceRelease),
      excludedPaths: [...new Set(excludedPaths)].sort(compareText), capturedAt };
    validateP5Contract('baselineManifest', baselineManifest);
    baselineManifestArtifact = store.putJson(baselineManifest);
    store.verifyRef(baselineManifestArtifact);
  }
  const recheckedCommit = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
  const recheckedTree = p5GitRun(gitTool, canonicalRoot, ['rev-parse', '--verify', `${recheckedCommit}^{tree}`]).toString('ascii').trim();
  const recheckedStatus = p5GitRun(gitTool, canonicalRoot, ['status', '--porcelain=v2', '--untracked-files=all', '-z']);
  if (recheckedCommit !== commit || recheckedTree !== tree || sha256(recheckedStatus) !== sha256(status)
    || spawnGitDiff(gitTool, canonicalRoot, ['diff', '--cached', '--no-ext-diff', '--exit-code', 'HEAD', '--']) !== 0
    || spawnGitDiff(gitTool, canonicalRoot, ['diff', '--no-ext-diff', '--exit-code', 'HEAD', '--']) !== 0)
    p5Fail('p5_source_drift', 'The source checkout changed before P5 baseline capture completed.');
  if (sha256(readFileSync(gitTool.path)) !== gitTool.sha256) p5Fail('p5_git_tool_mismatch', 'The pinned Git executable changed during P5 baseline capture.');
  const nativeSourceAfter = nativeSourceBefore
    ? await readP5NativeIdentity(nativeSourceReader, { root: canonicalRoot, include: pathPolicy.include, exclude: pathPolicy.exclude,
      maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes, expectedPathsDigest: expectedPathDigest }) : null;
  const commonNativeAfter = commonNativeBefore ? await readP5NativeIdentity(nativeSourceReader, { root: commonDirectory }) : null;
  const gitNativeAfter = gitNativeBefore ? await readP5NativeToolIdentity(nativeToolIdentityReader, gitTool.path) : null;
  if (nativeSourceBefore && (nativeSourceAfter.snapshotDigest !== nativeSourceBefore.snapshotDigest
      || canonicalHash(nativeSourceAfter.rootIdentity) !== canonicalHash(nativeSourceBefore.rootIdentity)
      || nativeSourceBefore.contentDigest !== nativeContentDigest || nativeSourceAfter.contentDigest !== nativeContentDigest
      || nativeSourceBefore.pathDigest !== expectedPathDigest || nativeSourceAfter.pathDigest !== expectedPathDigest)
    || commonNativeBefore && (commonNativeAfter.snapshotDigest !== commonNativeBefore.snapshotDigest
      || canonicalHash(commonNativeAfter.rootIdentity) !== canonicalHash(commonNativeBefore.rootIdentity))
    || gitNativeBefore && (canonicalHash(gitNativeAfter.identity) !== canonicalHash(gitNativeBefore.identity)
      || gitNativeAfter.canonicalPath !== gitNativeBefore.canonicalPath || gitNativeAfter.byteSize !== gitNativeBefore.byteSize
      || gitNativeAfter.linkCount !== gitNativeBefore.linkCount))
    p5Fail('p5_source_drift', 'Native Windows source, common-directory, or pinned Git identity changed during baseline capture.');
  return { baselineId, baselineManifest: baselineManifestArtifact ? asRef(baselineManifestArtifact) : null,
    sourceManifest: sourceManifestArtifact ? asRef(sourceManifestArtifact) : null,
    repositoryIdentity, gitObjectFormat: objectFormat, baseCommit: commit, baseTree: tree, sourceDigest, entries: sortedEntries,
    repositoryRoot: canonicalRoot, pathPolicy, pathPolicyDigest, excludedPaths: [...new Set(excludedPaths)].sort(compareText), totalBytes: actualBytes,
    dirtyState: { trackedClean: true, includedUntrackedCount: 0, statusSha256: sha256(status), excludedUntrackedCount: untracked.length,
      gitCommonDirectory: commonDirectory, nativeCommonDirectoryIdentity: commonIdentity,
      nativeSourceSnapshotDigest: nativeSourceAfter?.snapshotDigest ?? null,
      nativeSourceContentDigest: nativeSourceAfter?.contentDigest ?? null,
      nativeHostIdentity: nativeSourceAfter ? { hostPid: nativeSourceAfter.hostPid, generation: nativeSourceAfter.generation, epoch: nativeSourceAfter.epoch } : null } };
}

/** Re-read the live source checkout without adding artifacts; the enrollment remains the only baseline. */
export async function verifyP5GitBaselineCurrent({ store, enrollment, currentRunningSourceRelease = null,
  gitTool = enrollment?.toolIdentities?.find(item => item.name === 'git'), nativeSourceReader = null,
  nativeToolIdentityReader = null, identityReader = null }) {
  validateP5Contract('enrollment', enrollment);
  if (!gitTool || enrollment.toolIdentities.filter(item => item.name === 'git').length !== 1)
    p5Fail('p5_git_tool_unavailable', 'P5 enrollment must name exactly one pinned Git executable.');
  store.verifyRef(enrollment.baselineManifest);
  const baseline = store.readJson(enrollment.baselineManifest.artifactId);
  validateP5Contract('baselineManifest', baseline);
  if (assertP5SourcePathPolicy(baseline.pathPolicy) !== enrollment.pathPolicyDigest
    || baseline.baselineId !== enrollment.baselineId || baseline.baseCommit !== enrollment.baseCommit
    || baseline.baseTree !== enrollment.baseTree || canonicalHash(baseline.repositoryIdentity) !== canonicalHash(enrollment.repositoryIdentity)
    || canonicalHash(baseline.runningSourceRelease) !== canonicalHash(enrollment.runningSourceRelease))
    p5Fail('p5_baseline_mismatch', 'The installed baseline does not match the enrolled source, path policy or runtime release.');
  if (enrollment.gitCandidatePolicy === 'managed-clone-v1') {
    // D1: the installed release, not a user checkout, is the source authority. The immutable Store baseline is
    // revalidated here; the managed repository later proves the fetched commit reproduces exactly these bytes.
    store.verifyRef(baseline.sourceManifest);
    const sourceManifest = store.readJson(baseline.sourceManifest.artifactId);
    validateP5Contract('sourceManifest', sourceManifest);
    const entries = sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
    for (const entry of sourceManifest.entries) {
      store.verifyRef(entry.artifact);
      const bytes = store.readBytes(entry.artifact.artifactId).bytes;
      if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
        p5Fail('p5_baseline_object_mismatch', `The enrolled source object for "${entry.path}" does not match its manifest.`);
    }
    if (p5SourceDigest(entries) !== enrollment.effectiveSourceDigest || sourceManifest.sourceDigest !== enrollment.effectiveSourceDigest
      || enrollment.gitSource?.sourceCommit !== enrollment.baseCommit || enrollment.gitSource?.sourceTree !== enrollment.baseTree)
      p5Fail('p5_baseline_mismatch', 'The enrolled managed-clone source does not match its immutable baseline manifest and installed commit.');
    const enrolledRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
    validateP5Contract('runningSourceRelease', enrolledRelease);
    if (enrolledRelease.sourceCommit !== enrollment.baseCommit || enrolledRelease.sourceDigest !== enrollment.gitSource.releaseSourceDigest)
      p5Fail('p5_runtime_source_mismatch', 'The installed release provenance does not name the enrolled source commit and digest.');
    if (!currentRunningSourceRelease || canonicalHash(currentRunningSourceRelease) !== canonicalHash(enrolledRelease))
      p5Fail('p5_runtime_source_mismatch', 'The Host-verified running source release is unavailable or changed after enrollment.');
    validateP5Contract('runningSourceRelease', currentRunningSourceRelease);
    return { baselineId: baseline.baselineId, baselineManifest: enrollment.baselineManifest, sourceManifest: baseline.sourceManifest,
      repositoryIdentity: baseline.repositoryIdentity, gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit,
      baseTree: baseline.baseTree, sourceDigest: baseline.effectiveSourceDigest, entries, repositoryRoot: null,
      pathPolicy: baseline.pathPolicy, pathPolicyDigest: enrollment.pathPolicyDigest, excludedPaths: baseline.excludedPaths };
  }
  const current = await collectP5GitBaseline({ store, repositoryRoot: baseline.repositoryRoot, expectedRepositoryRoot: baseline.repositoryRoot,
    gitTool, repositoryIdentity: enrollment.repositoryIdentity, enrollmentId: enrollment.enrollmentId,
    runningSourceRelease: enrollment.runningSourceRelease, pathPolicy: baseline.pathPolicy, budgets: enrollment.budgets,
    expectedCommit: enrollment.baseCommit, identityReader, nativeSourceReader, nativeToolIdentityReader, persist: false });
  if (current.baselineId !== enrollment.baselineId || current.baseTree !== enrollment.baseTree
    || current.sourceDigest !== enrollment.effectiveSourceDigest || current.pathPolicyDigest !== enrollment.pathPolicyDigest)
    p5Fail('p5_baseline_mismatch', 'The live source commit, tree, path selection or effective bytes differ from the enrolled baseline.');
  if (currentRunningSourceRelease) {
    validateP5Contract('runningSourceRelease', currentRunningSourceRelease);
    const enrolledRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
    if (canonicalHash(currentRunningSourceRelease) !== canonicalHash(enrolledRelease))
      p5Fail('p5_runtime_source_mismatch', 'The Host-verified running source release changed after enrollment.');
  }
  return current;
}

function spawnGitDiff(gitTool, root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0'; env.GIT_TERMINAL_PROMPT = '0'; env.GIT_PAGER = 'cat';
  const result = spawnSync(gitTool.path, [...P5_GIT_CONFIG, '-c', `safe.directory=${root.replace(/\\/g, '/')}`, '-C', root, ...args],
    { cwd: root, env, encoding: null, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    p5Fail('p5_git_source_unavailable', `Pinned Git could not establish clean tracked state${result.error ? `: ${result.error.message}` : ''}.`);
  return result.status;
}
