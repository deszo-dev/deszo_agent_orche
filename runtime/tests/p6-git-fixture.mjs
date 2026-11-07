// Test-only P5 Git-candidate fixture. It writes the Store source bytes into an isolated test checkout,
// creates a real Git tree/commit with the P5 commit format, and seals the ordinary candidate/intent/binding refs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { deriveP5HostProtection } from '../core/p5HostBoundary.mjs';
import { validateP5Contract } from '../core/protectedSelfRepair.mjs';

const asRef = value => ({ artifactId: value.artifactId, sha256: value.sha256 });
const gitEnv = extra => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' }, extra);
  return env;
};
const git = (gitPath, root, args, env = {}) => execFileSync(gitPath,
  ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.hooksPath=NUL', '-C', root, ...args],
  { cwd: root, env: gitEnv(env), encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();

/**
 * Attach an immutable P5-shaped Git candidate to a source candidate. The acceptance records that
 * consume these refs remain the caller's responsibility; this fixture only supplies real Git identity.
 */
export async function attachP6TestGitCandidate({ store, candidate: candidateInput, sourceRoot, gitPath, seedCommit,
  seedTree = git(gitPath, sourceRoot, ['rev-parse', `${seedCommit}^{tree}`]), sourceEntries, preparationIntentRef }) {
  const { gitCandidate: _oldGitCandidate, ...candidate } = candidateInput;
  validateP5Contract('candidate', candidate);
  if (candidate.baseCommit !== seedCommit) throw new Error('The test Git candidate seed must equal candidate.baseCommit.');
  const sourceManifest = store.readJson(store.verifyRef(candidate.sourceManifest).artifactId);
  const entries = sourceEntries ?? sourceManifest.entries;
  for (const entry of entries) {
    const artifact = entry.artifact || { artifactId: entry.artifactId, sha256: entry.sha256 };
    store.verifyRef(artifact);
    const bytes = store.readBytes(artifact.artifactId).bytes;
    const target = join(sourceRoot, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  git(gitPath, sourceRoot, ['add', '--all']);
  for (const entry of entries) git(gitPath, sourceRoot, ['update-index', '--chmod=-x', '--', entry.path]);
  const candidateTree = git(gitPath, sourceRoot, ['write-tree']);
  const commitTimestamp = Math.floor(Date.now() / 1000);
  const candidateCommit = git(gitPath, sourceRoot, ['commit-tree', candidateTree, '-p', seedCommit, '-m', `P5 candidate ${candidate.candidateId}`], {
    GIT_AUTHOR_NAME: 'Deszo P5 Engine', GIT_AUTHOR_EMAIL: 'deszo-p5-engine@invalid',
    GIT_COMMITTER_NAME: 'Deszo P5 Engine', GIT_COMMITTER_EMAIL: 'deszo-p5-engine@invalid',
    GIT_AUTHOR_DATE: `@${commitTimestamp} +0000`, GIT_COMMITTER_DATE: `@${commitTimestamp} +0000`,
  });
  const baseCandidateArtifact = store.putJson(candidate);
  const baseCandidateRef = asRef(baseCandidateArtifact);
  const repairBranch = `self-repair/${candidate.linkId.replaceAll('-', '').toLowerCase().slice(0, 12)}`;
  const digest = canonicalHash(entries.map(entry => ({ path: entry.path, sha256: entry.sha256 })));
  const enrollment = store.readJson(candidate.enrollment.artifactId);
  const gitSource = enrollment.gitSource;
  const fetchProvenance = store.putJson({
    schemaVersion: 1, kind: 'ProtectedSelfRepairGitFetchProvenance', policy: 'managed-clone-v1',
    sourceRepositoryId: gitSource.sourceRepositoryId, remoteId: gitSource.remote.remoteId, remoteUrl: gitSource.remote.url,
    protocol: gitSource.remote.protocol, strategy: 'commit', refspecs: [], sourceCommit: seedCommit, sourceTree: seedTree,
    objectFormat: 'sha1', releaseSourceDigest: gitSource.releaseSourceDigest, unreachableObjects: [], recordedAt: new Date().toISOString(),
  });
  const hostProtection = store.putJson(await deriveP5HostProtection({ sourceRoot, sourceCommit: seedCommit }));
  const gitRepository = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairGitRepository', policy: 'managed-clone-v1',
    allocationId: candidate.workspace.allocationId, repositoryRoot: resolve(sourceRoot),
    commonDirectory: candidate.repositoryIdentity.canonicalCommonDirectory,
    nativeDirectoryIdentity: candidate.repositoryIdentity.nativeDirectoryIdentity,
    sourceRepositoryIdentity: candidate.repositoryIdentity, sourceBaseCommit: candidate.baseCommit,
    seedCommit, seedTree, repairBranch, objectFormat: 'sha1', sourceAncestryVerified: true,
    seedAncestryVerified: true, fetchProvenance: asRef(fetchProvenance), hostProtection: asRef(hostProtection),
    configurationDigest: '1'.repeat(64), excludeFileDigest: '2'.repeat(64),
    storageSnapshotDigest: '3'.repeat(64), storagePathDigest: '4'.repeat(64), storageContentDigest: '5'.repeat(64),
    preparedAt: new Date().toISOString(),
  };
  validateP5Contract('gitRepository', gitRepository);
  const workspacePreparation = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairWorkspacePreparation', intent: preparationIntentRef ?? candidate.sourceBinding,
    workspaceRoot: candidate.workspace.canonicalRoot, sourceRoot: candidate.workspace.sourceRoot,
    workspaceIdentity: candidate.workspace.nativeIdentity, sourceIdentity: candidate.workspace.nativeIdentity,
    baselineId: candidate.baselineId, sourceDigest: candidate.baseSourceDigest,
    snapshotDigest: '6'.repeat(64), pathDigest: '7'.repeat(64), contentDigest: '8'.repeat(64),
    fileCount: entries.length, totalBytes: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
    hostPid: process.pid, generation: 'p6-test-generation', epoch: 1, gitRepository,
    preparedAt: new Date().toISOString(),
  };
  validateP5Contract('workspacePreparation', workspacePreparation);
  const preparationRef = asRef(store.putJson(workspacePreparation));
  const intentBody = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairGitCommitIntent', candidateManifest: baseCandidateRef,
    workspacePreparation: preparationRef, gitRepository, candidateId: candidate.candidateId,
    candidateSourceDigest: candidate.candidateSourceDigest, sourceManifest: candidate.sourceManifest,
    changeManifest: candidate.changeManifest, parentRunId: candidate.parentRunId, repairRunId: candidate.repairRunId,
    linkId: candidate.linkId, incidentId: candidate.incidentId, enrollment: candidate.enrollment,
    allocationId: candidate.workspace.allocationId, repairBranch, seedCommit, seedTree, commitTimestamp,
  };
  const intent = { ...intentBody, intentId: canonicalHash(intentBody) };
  validateP5Contract('gitCommitIntent', intent);
  const intentRef = asRef(store.putJson(intent));
  const gitBody = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairGitCandidate', candidateId: candidate.candidateId,
    baseCandidate: baseCandidateRef, commitIntent: intentRef, enrollment: candidate.enrollment, repository: gitRepository,
    sourceRepositoryIdentity: candidate.repositoryIdentity, parentPublication: candidate.parentPublication,
    repairPublication: candidate.repairPublication, parentRunId: candidate.parentRunId, repairRunId: candidate.repairRunId,
    linkId: candidate.linkId, incidentId: candidate.incidentId,
    git: { historyPolicy: 'managed-clone-v1', sourceBaseCommit: candidate.baseCommit, seedCommit, seedTree,
      repairBranch, candidateCommit, candidateTree, objectFormat: 'sha1', sourceAncestryVerified: true,
      seedAncestryVerified: true, storageSnapshotDigest: '3'.repeat(64), storagePathDigest: '4'.repeat(64),
      storageContentDigest: '5'.repeat(64), configurationDigest: '1'.repeat(64), excludeFileDigest: '2'.repeat(64) },
    source: { baselineId: candidate.baselineId, baselineDigest: candidate.baseSourceDigest,
      candidateDigest: candidate.candidateSourceDigest, sourceManifest: candidate.sourceManifest,
      changeManifest: candidate.changeManifest }, capturedAt: new Date().toISOString(),
  };
  const gitCandidate = { ...gitBody, candidateGitId: canonicalHash(gitBody) };
  validateP5Contract('gitCandidate', gitCandidate);
  const gitCandidateRef = asRef(store.putJson(gitCandidate));
  const finalCandidate = { ...candidate, gitCandidate: gitCandidateRef };
  validateP5Contract('candidate', finalCandidate);
  const candidateRef = asRef(store.putJson(finalCandidate));
  return { candidate: finalCandidate, candidateRef, gitCandidate, gitCandidateRef,
    sourceCommit: candidateCommit, sourceTree: candidateTree, seedCommit, seedTree, digest,
    workspacePreparation, workspacePreparationRef: preparationRef, gitCommitIntent: intent, gitCommitIntentRef: intentRef,
    currentEligibility: { eligible: true, revision: 1, checkedAt: new Date().toISOString(), stage: 'p5_acceptance',
      candidateSourceDigest: candidate.candidateSourceDigest, gitCandidate: gitCandidateRef, repairBranch,
      candidateCommit, candidateTree, storageSnapshotDigest: '3'.repeat(64) } };
}
