// Store-backed Git object materialization for an exact Host-committed P6 Engine release.
// The Store objects are evidence for the enrolled source; this module does not create a remote or a new trust root.

import { canonicalHash } from './canonical.mjs';
import { verifyP6SourceGitProvenance } from './p6Reconstruction.mjs';
import { ProtectedSelfRepairError, runP5GitCommand, validateP5Contract } from './protectedSelfRepair.mjs';

const same = (left, right) => canonicalHash(left) === canonicalHash(right);
const fail = (message, details = {}) => { throw new ProtectedSelfRepairError('p5_git_local_source_invalid', message, details); };

function readCommandArtifact(store, requestId, command, expectedRef, payloadSha256) {
  const row = store.get('SELECT command, payload_sha256, response_artifact_id FROM command_receipts WHERE request_id = ?', requestId);
  if (!row || row.command !== command || row.response_artifact_id !== expectedRef.artifactId || row.payload_sha256 !== payloadSha256)
    fail(`The local Git source ${command} receipt is missing or does not match its immutable reference.`);
  const artifact = store.artifactRow(row.response_artifact_id);
  if (!artifact?.sha256 || artifact.sha256 !== expectedRef.sha256) fail(`The local Git source ${command} artifact reference changed.`);
  store.verifyRef(expectedRef);
  return { row, value: store.readJson(expectedRef.artifactId) };
}

/** Revalidates the exact P6 accepted source and its Host-committed package/continuation evidence. */
export function verifyP6GitObjectSource({ store, enrollment, baseline, visited = new Set() }) {
  const gitSource = enrollment?.gitSource;
  const local = gitSource?.verifiedLocalSource;
  if (!local) return null;
  try {
    validateP5Contract('gitObjectSource', local);
    validateP5Contract('gitSource', gitSource);
    validateP5Contract('baselineManifest', baseline);
    if (visited.has(local.operationId)) fail('The Store-backed Git source chain contains a repeated P6 operation.');
    const nextVisited = new Set(visited);
    nextVisited.add(local.operationId);
    store.verifyRef(enrollment.runningSourceRelease);
    const release = store.readJson(enrollment.runningSourceRelease.artifactId);
    validateP5Contract('runningSourceRelease', release);

    if (local.enrollmentId !== enrollment.enrollmentId
      || local.sourceRepositoryId !== gitSource.sourceRepositoryId
      || local.remoteId !== gitSource.remote.remoteId
      || local.repositoryIdentityDigest !== canonicalHash(enrollment.repositoryIdentity)
      || local.baselineId !== baseline.baselineId || local.candidateSourceDigest !== baseline.effectiveSourceDigest
      || local.sourceCommit !== baseline.baseCommit || local.sourceTree !== baseline.baseTree
      || local.objectFormat !== baseline.gitObjectFormat
      || local.sourceCommit !== gitSource.sourceCommit || local.sourceTree !== gitSource.sourceTree
      || local.objectFormat !== gitSource.objectFormat || local.releaseSourceDigest !== gitSource.releaseSourceDigest
      || local.releaseSourceDigest !== release.sourceDigest || local.sourceCommit !== release.sourceCommit
      || local.installationId !== release.installationId || local.engineBuildId !== release.buildId
      || local.operationId !== release.committedOperationId || local.packageSha256 !== release.packageSha256
      || release.bootstrap !== 'engine') {
      fail('The Store-backed Git source does not match the current enrolled repository, baseline and Host-selected release.');
    }

    store.verifyRef(local.handoff);
    const handoff = store.readJson(local.handoff.artifactId);
    validateP5Contract('handoff', handoff);
    const provenance = verifyP6SourceGitProvenance({ store, handoff, handoffRef: local.handoff });
    if (provenance.sourceCommit !== local.sourceCommit || provenance.sourceTree !== local.sourceTree
      || provenance.objectFormat !== local.objectFormat || provenance.candidateSourceDigest !== local.candidateSourceDigest
      || provenance.sourceDigest !== local.releaseSourceDigest
      || !same(handoff.enrollment, local.predecessorEnrollment)) {
      fail('The Store-backed Git source does not reproduce its exact accepted P5 candidate and enrolled predecessor.');
    }
    store.verifyRef(local.predecessorEnrollment);
    const predecessorEnrollment = store.readJson(local.predecessorEnrollment.artifactId);
    validateP5Contract('enrollment', predecessorEnrollment);
    store.verifyRef(predecessorEnrollment.runningSourceRelease);
    const predecessorRelease = store.readJson(predecessorEnrollment.runningSourceRelease.artifactId);
    validateP5Contract('runningSourceRelease', predecessorRelease);
    if (provenance.parentCommit !== predecessorEnrollment.baseCommit)
      fail('The accepted Git commit does not descend from the exact enrolled predecessor baseline.');

    let predecessorSource = null;
    if (predecessorEnrollment.gitSource?.verifiedLocalSource) {
      store.verifyRef(predecessorEnrollment.baselineManifest);
      const predecessorBaseline = store.readJson(predecessorEnrollment.baselineManifest.artifactId);
      validateP5Contract('baselineManifest', predecessorBaseline);
      predecessorSource = verifyP6GitObjectSource({ store, enrollment: predecessorEnrollment,
        baseline: predecessorBaseline, visited: nextVisited });
      if (!predecessorSource || predecessorSource.localSource.sourceCommit !== provenance.parentCommit
        || predecessorSource.localSource.sourceTree !== predecessorBaseline.baseTree)
        fail('The P6 predecessor Git object source does not provide the exact accepted parent commit and tree.');
    }

    const buildRecord = readCommandArtifact(store, `p6-build-${handoff.handoffId}`, 'p6.build', local.buildReceipt, local.packageSha256);
    const build = buildRecord.value;
    validateP5Contract('p6BuildReceipt', build);
    if (build.operationId !== local.operationId || build.engineBuildId !== local.engineBuildId
      || build.packageSha256 !== local.packageSha256 || build.sourceCommit !== local.sourceCommit
      || build.sourceTree !== local.sourceTree || build.candidateSourceDigest !== local.candidateSourceDigest
      || build.installedSourceDigest !== local.releaseSourceDigest || !same(build.handoff, local.handoff)
      || !same(build.successorP5Profile, enrollment.profile) || !same(build.previousRelease, predecessorRelease)) {
      fail('The immutable P6 build receipt does not bind the local Git source to the installed package.');
    }

    const continuationRecord = readCommandArtifact(store, `p6-continuation-${local.operationId}`, 'p6.continuation',
      local.continuationReceipt, local.packageSha256);
    const continuation = continuationRecord.value;
    validateP5Contract('p6ContinuationReceipt', continuation);
    const host = continuation.hostSwitchStatus;
    if (continuation.operationId !== local.operationId || !same(continuation.buildReceipt, local.buildReceipt)
      || !same(continuation.handoff, local.handoff) || !same(continuation.successorProfile, enrollment.profile)
      || !same(continuation.successorRelease, enrollment.runningSourceRelease)
      || !same(continuation.observedRunningSourceRelease, release)
      || continuation.packageSha256 !== local.packageSha256
      || host?.operationId !== local.operationId || !['committed', 'verified'].includes(host.phase)
      || host.fromEngineBuildId !== build.previousRelease.buildId || host.toEngineBuildId !== local.engineBuildId
      || host.shellBuildId !== build.shellBuildId || host.packageSha256 !== local.packageSha256) {
      fail('The durable P6 continuation does not bind the local Git source to the Host-committed release.');
    }
    return { localSource: local, provenance, provenanceChain: [...(predecessorSource?.provenanceChain ?? []), provenance] };
  } catch (error) {
    if (error instanceof ProtectedSelfRepairError && error.code === 'p5_git_local_source_invalid') throw error;
    throw new ProtectedSelfRepairError('p5_git_local_source_invalid',
      `The Store-backed Git source could not be verified: ${error.message}`, { cause: error.code || 'invalid_source' });
  }
}

function writeBlob(gitTool, root, bytes, expectedId) {
  const actual = runP5GitCommand(gitTool, root, ['hash-object', '-w', '--stdin'], { input: bytes }).toString('ascii').trim();
  if (actual !== expectedId) fail('A reconstructed P5 source blob has a different enrolled Git object ID.');
}

function treeOrderKey(entry) {
  return Buffer.concat([Buffer.from(entry.name, 'ascii'), Buffer.from([entry.directory ? 0x2f : 0])]);
}

function writeTree(gitTool, root, node, counter) {
  const children = [];
  for (const [name, child] of node.directories) children.push({ name, directory: true, mode: '040000', node: child });
  children.push(...node.files);
  children.sort((left, right) => Buffer.compare(treeOrderKey(left), treeOrderKey(right)));
  const records = [];
  for (const child of children) {
    const objectId = child.directory ? writeTree(gitTool, root, child.node, counter) : child.objectId;
    records.push(Buffer.from(`${child.mode} ${child.directory ? 'tree' : 'blob'} ${objectId}\t${child.name}\0`, 'ascii'));
  }
  const bytes = Buffer.concat(records);
  counter.count += 1;
  return runP5GitCommand(gitTool, root, ['mktree', '-z'], { input: bytes }).toString('ascii').trim();
}

/** Writes only the exact candidate blobs, trees and deterministic P5 commit into an initialized private clone. */
export function materializeVerifiedP6GitObjects({ gitTool, repositoryRoot, provenance }) {
  if (!gitTool?.path || !repositoryRoot || !provenance?.gitObjects || !Buffer.isBuffer(provenance.commitBytes))
    fail('Verified Store-backed Git source materialization requires exact Git objects and an enrolled Git tool.');
  const root = { directories: new Map(), files: [] };
  for (const entry of provenance.gitObjects) {
    const parts = entry.path.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.directories.has(part)) directory.directories.set(part, { directories: new Map(), files: [] });
      directory = directory.directories.get(part);
    }
    const blobId = provenance.objectFormat === 'sha1'
      ? runP5GitCommand(gitTool, repositoryRoot, ['hash-object', '--stdin'], { input: entry.bytes }).toString('ascii').trim()
      : runP5GitCommand(gitTool, repositoryRoot, ['hash-object', '--stdin'], { input: entry.bytes }).toString('ascii').trim();
    if (blobId !== entry.blobId) fail(`The Store-backed blob identity changed for "${entry.path}".`, { path: entry.path });
    writeBlob(gitTool, repositoryRoot, entry.bytes, entry.blobId);
    directory.files.push({ name: parts.at(-1), directory: false, mode: entry.executable ? '100755' : '100644', objectId: entry.blobId });
  }
  const treeCounter = { count: 0 };
  const treeId = writeTree(gitTool, repositoryRoot, root, treeCounter);
  if (treeId !== provenance.sourceTree) fail('The reconstructed P5 Git tree differs from the exact accepted Git candidate.');
  const commitId = runP5GitCommand(gitTool, repositoryRoot, ['hash-object', '-w', '-t', 'commit', '--stdin'],
    { input: provenance.commitBytes }).toString('ascii').trim();
  if (commitId !== provenance.sourceCommit) fail('The reconstructed P5 Git commit differs from the exact accepted Git candidate.');
  return { sourceCommit: commitId, sourceTree: treeId, objectCount: provenance.gitObjects.length + treeCounter.count + 1 };
}
