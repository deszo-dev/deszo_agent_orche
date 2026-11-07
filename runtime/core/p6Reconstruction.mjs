// P6 Exact Source Reconstruction from Immutable Store (ADR-0010 Section 3).
// Reconstructs the exact candidate source files from immutable Store objects referenced in sourceManifest.
// Verifies byteSize and SHA-256 for each entry.
// Prevents path traversal, symlink escapes, duplicate case-folded Windows paths, and Windows device names.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalHash, sha256 } from './canonical.mjs';
import { p5SourceDigest, validateP5Contract, validateP5SourcePath } from './protectedSelfRepair.mjs';

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class P6ReconstructionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6ReconstructionError';
    this.code = code;
    this.details = details;
  }
}

function refEqual(left, right) {
  return Boolean(left && right && left.artifactId === right.artifactId && left.sha256 === right.sha256);
}

function failGitProvenance(message, details = {}) {
  throw new P6ReconstructionError('p6_reconstruction_git_provenance_invalid', message, details);
}

function gitObjectId(objectFormat, kind, bytes) {
  const header = Buffer.from(`${kind} ${bytes.length}\0`, 'ascii');
  return createHash(objectFormat).update(header).update(bytes).digest('hex');
}

function gitTreeOrderKey(entry) {
  return Buffer.concat([Buffer.from(entry.name, 'ascii'), Buffer.from([entry.directory ? 0x2f : 0])]);
}

function buildGitTree(objectFormat, entries) {
  const root = { directories: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.directories.has(part)) directory.directories.set(part, { directories: new Map(), files: [] });
      directory = directory.directories.get(part);
    }
    directory.files.push({ name: parts.at(-1), objectId: entry.blobId, directory: false,
      mode: entry.executable ? '100755' : '100644' });
  }
  const writeTree = directory => {
    const children = [];
    for (const [name, child] of directory.directories) {
      children.push({ name, directory: true, mode: '40000', objectId: writeTree(child) });
    }
    children.push(...directory.files);
    children.sort((left, right) => Buffer.compare(gitTreeOrderKey(left), gitTreeOrderKey(right)));
    const chunks = [];
    for (const child of children) {
      chunks.push(Buffer.from(`${child.mode} ${child.name}\0`, 'ascii'), Buffer.from(child.objectId, 'hex'));
    }
    return gitObjectId(objectFormat, 'tree', Buffer.concat(chunks));
  };
  return writeTree(root);
}

/**
 * Verifies the P5 immutable candidate/Git lineage and recomputes the Git tree and commit IDs
 * directly from the accepted Store blobs. No mutable checkout or syntactic hash label is trusted.
 */
export function verifyP6SourceGitProvenance({ store, handoff, handoffRef }) {
  if (!store || !handoff || handoff.kind !== 'ProtectedSelfRepairHandoff' || !handoffRef) {
    failGitProvenance('An exact accepted handoff Store reference is required for P6 Git provenance.');
  }
  try {
    store.verifyRef(handoffRef);
    if (canonicalHash(store.readJson(handoffRef.artifactId)) !== handoffRef.sha256
      || canonicalHash(store.readJson(handoffRef.artifactId)) !== canonicalHash(handoff))
      failGitProvenance('The supplied handoff does not match its exact immutable Store reference.');

    for (const reference of [handoff.candidate, handoff.gitCandidate, handoff.sourceManifest, handoff.changeManifest,
      handoff.enrollment]) store.verifyRef(reference);
    const candidate = store.readJson(handoff.candidate.artifactId);
    validateP5Contract('candidate', candidate);
    if (canonicalHash(candidate) !== handoff.candidate.sha256 || candidate.candidateId !== handoff.candidateId
      || candidate.candidateSourceDigest !== handoff.candidateSourceDigest || candidate.repairRunId !== handoff.repairRunId
      || candidate.parentRunId !== handoff.parentRunId || candidate.linkId !== handoff.linkId
      || candidate.incidentId !== handoff.incidentId || !refEqual(candidate.gitCandidate, handoff.gitCandidate)
      || !refEqual(candidate.sourceManifest, handoff.sourceManifest) || !refEqual(candidate.changeManifest, handoff.changeManifest)
      || !refEqual(candidate.enrollment, handoff.enrollment))
      failGitProvenance('The accepted handoff does not bind the exact sealed P5 candidate and its source references.');

    const gitCandidate = store.readJson(handoff.gitCandidate.artifactId);
    validateP5Contract('gitCandidate', gitCandidate);
    const { candidateGitId, ...gitCandidateBody } = gitCandidate;
    if (canonicalHash(gitCandidate) !== handoff.gitCandidate.sha256 || candidateGitId !== canonicalHash(gitCandidateBody)
      || gitCandidate.candidateId !== candidate.candidateId
      || !refEqual(gitCandidate.enrollment, candidate.enrollment)
      || !refEqual(gitCandidate.source.sourceManifest, candidate.sourceManifest)
      || !refEqual(gitCandidate.source.changeManifest, candidate.changeManifest)
      || gitCandidate.source.candidateDigest !== candidate.candidateSourceDigest
      || gitCandidate.source.baselineId !== candidate.baselineId
      || gitCandidate.parentRunId !== candidate.parentRunId || gitCandidate.repairRunId !== candidate.repairRunId
      || gitCandidate.linkId !== candidate.linkId || gitCandidate.incidentId !== candidate.incidentId)
      failGitProvenance('The P5 Git candidate does not bind the exact accepted candidate lineage.');

    const baseCandidateRef = gitCandidate.baseCandidate;
    store.verifyRef(baseCandidateRef);
    const baseCandidate = store.readJson(baseCandidateRef.artifactId);
    validateP5Contract('candidate', baseCandidate);
    const { gitCandidate: _gitCandidate, ...candidateWithoutGitBinding } = candidate;
    if (canonicalHash(baseCandidate) !== canonicalHash(candidateWithoutGitBinding))
      failGitProvenance('The P5 Git candidate was not committed from this exact sealed source candidate.');

    const intentRef = gitCandidate.commitIntent;
    store.verifyRef(intentRef);
    const intent = store.readJson(intentRef.artifactId);
    validateP5Contract('gitCommitIntent', intent);
    const { intentId, ...intentBody } = intent;
    const git = gitCandidate.git;
    const repository = gitCandidate.repository;
    if (canonicalHash(intent) !== intentRef.sha256 || intentId !== canonicalHash(intentBody)
      || !refEqual(intent.candidateManifest, baseCandidateRef) || !refEqual(intent.enrollment, candidate.enrollment)
      || !refEqual(intent.sourceManifest, candidate.sourceManifest) || !refEqual(intent.changeManifest, candidate.changeManifest)
      || intent.candidateId !== candidate.candidateId || intent.candidateSourceDigest !== candidate.candidateSourceDigest
      || intent.parentRunId !== candidate.parentRunId || intent.repairRunId !== candidate.repairRunId
      || intent.linkId !== candidate.linkId || intent.incidentId !== candidate.incidentId
      || canonicalHash(intent.gitRepository) !== canonicalHash(repository)
      || gitCandidate.git.objectFormat !== repository.objectFormat
      || git.historyPolicy !== 'managed-clone-v1' || repository.policy !== 'managed-clone-v1'
      || git.sourceAncestryVerified !== true || repository.sourceAncestryVerified !== true
      || git.historyPolicy !== repository.policy || git.seedCommit !== intent.seedCommit || git.seedTree !== intent.seedTree
      || git.repairBranch !== intent.repairBranch || git.sourceBaseCommit !== candidate.baseCommit
      || gitCandidate.sourceRepositoryIdentity.enrollmentId !== candidate.repositoryIdentity.enrollmentId
      || canonicalHash(gitCandidate.sourceRepositoryIdentity) !== canonicalHash(candidate.repositoryIdentity)
      || handoff.currentEligibility?.eligible !== true
      || !refEqual(handoff.currentEligibility.gitCandidate, handoff.gitCandidate)
      || handoff.currentEligibility.candidateCommit !== git.candidateCommit
      || handoff.currentEligibility.candidateTree !== git.candidateTree
      || !['sha1', 'sha256'].includes(git.objectFormat))
      failGitProvenance('The accepted P5 Git commit intent, candidate binding and eligibility evidence disagree.');

    const enrollment = store.readJson(candidate.enrollment.artifactId);
    validateP5Contract('enrollment', enrollment);
    if (enrollment.gitCandidatePolicy !== 'managed-clone-v1')
      failGitProvenance('P6 v1 requires an enrollment using the managed-clone Git provenance policy.');
    if (!refEqual(enrollment.profile, candidate.selfRepairProfile) || enrollment.baselineId !== candidate.baselineId)
      failGitProvenance('The P5 candidate does not use its enrolled profile and baseline.');
    store.verifyRef(candidate.baselineRef);
    const baseline = store.readJson(candidate.baselineRef.artifactId);
    validateP5Contract('baselineManifest', baseline);
    if (baseline.baselineId !== candidate.baselineId || baseline.baseCommit !== candidate.baseCommit
      || baseline.baseTree !== git.seedTree || git.sourceBaseCommit !== baseline.baseCommit)
      failGitProvenance('The P5 Git seed does not match the accepted installed baseline identity.');
    store.verifyRef(enrollment.runningSourceRelease);
    const enrolledRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
    validateP5Contract('runningSourceRelease', enrolledRelease);
    const enrolledGitSource = enrollment.gitSource;
    try { validateP5Contract('gitSource', enrolledGitSource); }
    catch { failGitProvenance('P6 requires a complete managed-clone source identity in the accepted enrollment.'); }
    if (enrolledGitSource.policy !== 'managed-clone-v1' || enrolledGitSource.sourceCommit !== enrollment.baseCommit
      || enrolledGitSource.sourceTree !== baseline.baseTree || enrolledGitSource.objectFormat !== baseline.gitObjectFormat
      || enrolledGitSource.releaseSourceDigest !== enrolledRelease.sourceDigest
      || enrolledRelease.sourceCommit !== enrollment.baseCommit)
      failGitProvenance('The managed-clone enrollment source does not match the exact installed baseline release.');

    const sourceManifest = store.readJson(handoff.sourceManifest.artifactId);
    validateP5Contract('sourceManifest', sourceManifest);
    const entries = [...sourceManifest.entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const rawEntries = entries.map(({ artifact: _artifact, ...entry }) => entry);
    const sourceDigest = p5SourceDigest(rawEntries);
    if (sourceDigest !== handoff.candidateSourceDigest || sourceManifest.sourceDigest !== sourceDigest)
      failGitProvenance('The accepted source manifest does not match the P5 candidate source digest.');
    const gitEntries = entries.map(entry => {
      validateP5SourcePath(entry.path);
      const artifactRef = entry.artifact || { artifactId: entry.artifactId, sha256: entry.sha256 };
      store.verifyRef(artifactRef);
      const { bytes } = store.readBytes(artifactRef.artifactId);
      if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256 || artifactRef.sha256 !== entry.sha256)
        failGitProvenance(`The accepted Git blob for "${entry.path}" does not match its immutable source entry.`, { path: entry.path });
      return { path: entry.path, executable: entry.executable, blobId: gitObjectId(git.objectFormat, 'blob', bytes) };
    });
    const sourceTree = buildGitTree(git.objectFormat, gitEntries);
    const expectedOidLength = git.objectFormat === 'sha1' ? 40 : 64;
    const commitBytes = Buffer.from([
      `tree ${sourceTree}`,
      `parent ${intent.seedCommit}`,
      `author Deszo P5 Engine <deszo-p5-engine@invalid> ${intent.commitTimestamp} +0000`,
      `committer Deszo P5 Engine <deszo-p5-engine@invalid> ${intent.commitTimestamp} +0000`,
      '',
      `P5 candidate ${candidate.candidateId}`,
      '',
    ].join('\n'), 'utf8');
    const sourceCommit = gitObjectId(git.objectFormat, 'commit', commitBytes);
    if (sourceTree !== git.candidateTree || sourceTree.length !== expectedOidLength
      || sourceCommit !== git.candidateCommit || sourceCommit.length !== expectedOidLength)
      failGitProvenance('Recomputed Git blob, tree or commit identity differs from the accepted P5 Git candidate.');
    const gitObjects = entries.map(entry => {
      const artifactRef = entry.artifact || { artifactId: entry.artifactId, sha256: entry.sha256 };
      const { bytes } = store.readBytes(artifactRef.artifactId);
      return { path: entry.path, executable: entry.executable, blobId: gitObjectId(git.objectFormat, 'blob', bytes), bytes };
    });
    return { candidateRef: handoff.candidate, gitCandidateRef: handoff.gitCandidate,
      candidateSourceDigest: sourceDigest, sourceCommit, sourceTree, objectFormat: git.objectFormat,
      parentCommit: intent.seedCommit, commitBytes,
      gitObjects,
      sourceDigest: canonicalHash(entries.map(entry => ({ path: entry.path, sha256: entry.sha256 }))) };
  } catch (error) {
    if (error instanceof P6ReconstructionError) throw error;
    throw new P6ReconstructionError('p6_reconstruction_git_provenance_invalid',
      `Accepted P5 Git provenance could not be verified: ${error.message}`, { cause: error.code || 'invalid_source' });
  }
}

/**
 * Reconstructs exact candidate source from the immutable Store into targetDir.
 * @param {Object} options
 * @param {Object} options.store Store instance to read blobs from
 * @param {Object} options.handoff Accepted ProtectedSelfRepairHandoff/1 artifact
 * @param {string} options.targetDir Isolated destination directory
 * @returns {{ reconstructedFiles: number, sourceDigest: string, targetDir: string }}
 */
export function reconstructCandidateSource({ store, handoff, targetDir }) {
  if (!store || typeof store.readBytes !== 'function') {
    throw new P6ReconstructionError('p6_reconstruction_no_store', 'Valid Store instance is required for reconstruction.');
  }
  if (!handoff || handoff.kind !== 'ProtectedSelfRepairHandoff') {
    throw new P6ReconstructionError('p6_reconstruction_invalid_handoff', 'Accepted ProtectedSelfRepairHandoff is required.');
  }
  if (typeof targetDir !== 'string' || !targetDir) {
    throw new P6ReconstructionError('p6_reconstruction_invalid_target', 'targetDir must be a non-empty string path.');
  }

  // Load source manifest
  let sourceManifest = handoff.sourceManifest;
  if (sourceManifest?.artifactId && (!sourceManifest.entries || !sourceManifest.sourceDigest)) {
    store.verifyRef(sourceManifest);
    sourceManifest = store.readJson(sourceManifest.artifactId);
  } else if (!sourceManifest?.entries) {
    throw new P6ReconstructionError('p6_reconstruction_missing_manifest', 'handoff.sourceManifest has no entries or artifactId.');
  }
  validateP5Contract('sourceManifest', sourceManifest);

  const entries = sourceManifest.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new P6ReconstructionError('p6_reconstruction_empty_manifest', 'sourceManifest.entries is empty.');
  }

  const seenPaths = new Set();
  const seenFolded = new Set();
  mkdirSync(targetDir, { recursive: true });

  for (const entry of entries) {
    const p = entry.path;
    try {
      validateP5SourcePath(p);
    } catch (err) {
      throw new P6ReconstructionError('p6_reconstruction_unsafe_path', `Invalid source path "${p}": ${err.message}`, { path: p });
    }

    // Windows device name check
    const segments = p.split('/');
    if (segments.some(seg => DEVICE_NAME.test(seg))) {
      throw new P6ReconstructionError('p6_reconstruction_device_name', `Source path contains reserved Windows device name: ${p}`, { path: p });
    }

    // Case-folded collision check
    const folded = p.toLowerCase();
    if (seenFolded.has(folded)) {
      throw new P6ReconstructionError('p6_reconstruction_path_collision', `Case-folding collision detected for "${p}".`, { path: p });
    }
    seenFolded.add(folded);
    seenPaths.add(p);

    // Read artifact bytes from immutable Store
    const artifactRef = entry.artifact || { artifactId: entry.artifactId, sha256: entry.sha256 };
    store.verifyRef(artifactRef);
    const { bytes } = store.readBytes(artifactRef.artifactId);

    // Verify byte size and sha256 digest
    if (bytes.length !== entry.byteSize) {
      throw new P6ReconstructionError(
        'p6_reconstruction_bytes_mismatch',
        `File "${p}" expected ${entry.byteSize} bytes, got ${bytes.length}.`,
        { path: p, expectedBytes: entry.byteSize, actualBytes: bytes.length }
      );
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      throw new P6ReconstructionError(
        'p6_reconstruction_digest_mismatch',
        `File "${p}" expected sha256 ${entry.sha256}, got ${digest}.`,
        { path: p, expectedSha256: entry.sha256, actualSha256: digest }
      );
    }

    // Write file to target directory
    const dest = join(targetDir, ...segments);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    // Windows does not expose Git's executable bit as a distinct filesystem mode. Preserve it on
    // platforms that do, while Git provenance below always derives the mode from the immutable P5 entry.
    if (process.platform !== 'win32') chmodSync(dest, entry.executable ? 0o755 : 0o644);
  }

  // Verify overall source digest matches handoff
  const rawEntries = entries.map(({ artifact: _artifact, ...rest }) => rest);
  const computedSourceDigest = p5SourceDigest(rawEntries);
  if (computedSourceDigest !== handoff.candidateSourceDigest) {
    throw new P6ReconstructionError(
      'p6_reconstruction_source_digest_mismatch',
      `Reconstructed source digest ${computedSourceDigest} differs from handoff ${handoff.candidateSourceDigest}.`,
      { expected: handoff.candidateSourceDigest, actual: computedSourceDigest }
    );
  }

  return {
    reconstructedFiles: entries.length,
    sourceDigest: computedSourceDigest,
    targetDir,
  };
}
