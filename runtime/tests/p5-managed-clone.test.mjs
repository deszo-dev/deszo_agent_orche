// P5-GIT-2: managed-clone-v1 source policy, immutable Lifecycle Host boundary and Engine capture recovery, exercised with
// Git for Windows' actual git.exe, the authenticated Rust custody Host, a real Host-custodied Developer process and
// separate Engine processes that end at named P5 boundaries. Every Git write targets test-owned repositories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachEngine, eventually, hostExe, newScratch, startCustodyHost } from './custody-support.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { buildRustFixture, rustFixtureDir } from './build-cache.mjs';
import { Store } from '../core/store.mjs';
import { canonicalHash } from '../core/canonical.mjs';
import { captureP5VerificationInputs, collectP5GitBaseline, p5SourceDigest, p5VerificationCommandDigest, prepareP5WorkspaceFromIntent,
  sealP5Candidate, validateP5Contract } from '../core/protectedSelfRepair.mjs';
import { evaluateP5GitPublication, executeP5GitPublication, p5GitPublicationStatus, prepareP5GitRepositoryFromIntent, publishP5GitCandidate,
  requestP5GitPublication,
  verifyP5GitCandidateCurrent } from '../core/p5GitCandidate.mjs';
import { assertP5HostBoundary, classifyP5Mutation, p5HostStaticReason, p5MutationTier, readP5HostProtection } from '../core/p5HostBoundary.mjs';
import { sourceInventory } from '../host/sourceProvenance.mjs';
import { makeFailureOutcome } from '../core/failureOutcomes.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ref = value => ({ artifactId: value.artifactId, sha256: value.sha256 });
const childScript = resolve(import.meta.dirname, 'fixtures', 'p5-capture-engine.mjs');

function actualGit() {
  const listed = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const candidates = listed.flatMap(path => [path, resolve(dirname(path), '..', 'mingw64', 'bin', 'git.exe')]);
  const found = candidates.find(path => /[\\/]mingw64[\\/]bin[\\/]git\.exe$/i.test(path) && existsSync(path));
  assert.ok(found, 'the proof needs Git for Windows actual mingw64 git.exe, not its command shim');
  return found;
}

function gitRunner(gitPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' });
  return (cwd, args, options = {}) => execFileSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.hooksPath=NUL',
    '-c', 'init.templateDir=', '-c', 'commit.gpgsign=false', '-c', 'user.name=P5 Fixture', '-c', 'user.email=p5@example.invalid',
    '-c', 'protocol.file.allow=always', '-C', cwd, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options });
}

const UPSTREAM_FILES = new Map([
  ['README.md', 'Deszo P5-GIT-2 fixture\n'],
  ['package.json', '{ "name": "deszo-fixture", "private": true }\n'],
  ['lifecycle-host/Cargo.toml', '[package]\nname = "fixture-lifecycle-host"\nversion = "0.1.0"\n'],
  ['lifecycle-host/src/custody.rs', 'pub fn custody_boundary() -> &\'static str { "host" }\n'],
  ['runtime/host/lifecycle.mjs', "import { trustTag } from '../core/canonical.mjs';\nexport const hostTrust = trustTag;\n"],
  ['runtime/core/canonical.mjs', "export const trustTag = 'host-trust';\n"],
  ['runtime/core/feature.mjs', 'export const boundary = "baseline";\n'],
  ['src/ui.ts', 'export const ui = 1;\n'],
]);

/** One enrolled P5 fixture: its own Store, slot, enrollment, P2 link, journaled preparation intent. */
async function enrollFixture({ label, host, readers, gitPath, upstreamRoot, repositoryIdentity, installedCommit, remoteUrl, releaseDigestOverride = null }) {
  const scratch = newScratch(label);
  const slotRoot = ownedDir(join(testsRoot, `p5-git2-${label}-`));
  const store = new Store(scratch.root);
  const gitTool = { path: gitPath, sha256: sha256(readFileSync(gitPath)) };
  const inventory = await sourceInventory(upstreamRoot, gitTool);
  assert.equal(inventory.sourceCommit, installedCommit, 'the fixture release is built from the installed commit');
  const releaseSourceDigest = releaseDigestOverride ?? inventory.sourceDigest;
  const releaseValue = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'a'.repeat(32),
    buildId: `p5-git2-${label}`, bootstrap: 'runtime', packageSha256: sha256(`fixture-package:${installedCommit}`), sourceCommit: installedCommit,
    sourceDigest: releaseSourceDigest, inputsDigest: sha256(`fixture-inputs:${installedCommit}`) };
  const runningSourceRelease = store.putJson(releaseValue);
  const enrollmentId = repositoryIdentity.enrollmentId;
  const budgets = { maxSourceFiles: 50, maxSourceBytes: 65536, developerTimeoutSeconds: 60, verificationTimeoutSeconds: 60,
    maxCheckOutputBytes: 4096, verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 };
  const baseline = await collectP5GitBaseline({ store, repositoryRoot: upstreamRoot, gitTool, repositoryIdentity, enrollmentId,
    runningSourceRelease, pathPolicy: { include: ['**'], exclude: ['.git/**', '.p5/**'], secretPaths: [] },
    budgets: { maxSourceFiles: budgets.maxSourceFiles, maxSourceBytes: budgets.maxSourceBytes }, expectedCommit: installedCommit, ...readers });
  // The scope deliberately authorizes Host paths: the immutable Host boundary must hold even against an over-broad profile.
  const scopeSelectors = ['README.md', 'package.json', 'lifecycle-host/**', 'runtime/**', 'src/**'];
  const scope = { add: scopeSelectors, modify: scopeSelectors, delete: scopeSelectors, executable: [], denied: [], sensitiveCategories: [] };
  const verificationPolicy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
    requiredStages: ['unit'], requiredCheckIds: ['unit-check'], optionalCheckIds: [], harnessClosureDigest: '1'.repeat(64),
    incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8, maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
    checks: [{ checkId: 'unit-check', stageId: 'unit', required: true, executable: process.execPath, executableSha256: sha256(readFileSync(process.execPath)),
      argv: ['--test', 'runtime/core/engine.test.mjs'], cwd: 'candidate-execution-tree', inputRefs: [], environment: { PATH: process.env.PATH },
      subjectEntryPoints: ['runtime/core/feature.mjs'], expectedAssertions: ['candidate-value'], expectedExitCodes: [0], timeoutSeconds: 60,
      maxOutputBytes: 4096, subjectBinding: 'protected-overlay', overlayPaths: ['runtime/core/engine.test.mjs'] }],
    verificationRetries: 0, aggregateTimeoutSeconds: 120,
    mutationTiers: [{ tierId: 'engine-core', requiredCheckIds: ['unit-check'] }, { tierId: 'repair-authority', requiredCheckIds: ['unit-check'] }] };
  verificationPolicy.checks[0].commandDigest = p5VerificationCommandDigest(verificationPolicy.checks[0]);
  const policyRef = store.putJson(verificationPolicy);
  const slotIdentity = await readers.nativeSourceReader({ root: slotRoot, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
  assert.equal(slotIdentity.refused, undefined, slotIdentity.message);
  const workspace = { workspaceId: 'p5-slot', canonicalRoot: slotIdentity.canonicalRoot, allocationId: randomUUID(), nativeIdentity: slotIdentity.rootIdentity };
  const repairPublication = { workflowId: 'p5-repair', publishedVersionId: randomUUID(), version: 1, snapshotSha256: policyRef.sha256 };
  const profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity,
    baselineId: baseline.baselineId, baseline: baseline.baselineManifest, runningSourceRelease: ref(runningSourceRelease),
    repairPublication, developerNodeId: 'developer', verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
    workspace: { workspaceId: workspace.workspaceId, allocationId: workspace.allocationId, canonicalRoot: workspace.canonicalRoot, singleUse: true, cleanCommitted: true },
    scope, verificationPolicy: ref(policyRef), requiredCheckIds: ['unit-check'],
    eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'provider-unavailable' }], failedNodeRetry: 'never',
    acceptanceMode: 'judge_post_execution', budgets };
  const profileRef = store.putJson(profile);
  const parentPublication = { workflowId: 'p5-parent', publishedVersionId: randomUUID(), version: 1, snapshotSha256: profileRef.sha256 };
  const gitSource = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1', sourceRepositoryId: 'deszo-fixture',
    remote: { remoteId: 'fixture-origin', url: remoteUrl, protocol: 'file' }, fetchRefs: ['refs/heads/main'],
    sourceCommit: installedCommit, sourceTree: baseline.baseTree, objectFormat: baseline.gitObjectFormat, releaseSourceDigest, credentialPolicy: 'none',
    publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: false, remoteId: 'fixture-origin',
      refNamespace: 'refs/heads/self-repair/', requireExpectedRemoteState: true, allowMerge: false } };
  const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
    gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree,
    gitCandidatePolicy: 'managed-clone-v1', gitSource,
    pathPolicyDigest: baseline.pathPolicyDigest, effectiveSourceDigest: baseline.sourceDigest, baselineId: baseline.baselineId,
    baselineManifest: baseline.baselineManifest, runningSourceRelease: ref(runningSourceRelease),
    parentPublication, profile: ref(profileRef), repairPublication, workspace, verificationPolicy: ref(policyRef), harnessClosureDigest: '1'.repeat(64),
    toolIdentities: [{ name: 'git', path: gitPath, sha256: gitTool.sha256 }], scope, budgets, minimumReaderCapability: 'protected-self-repair-v1' };
  validateP5Contract('enrollment', enrollment);
  const enrollmentArtifact = store.putJson(enrollment);

  const parentRunId = randomUUID(), repairRunId = randomUUID(), linkId = randomUUID(), incidentId = randomUUID(), outcomeId = randomUUID();
  const at = new Date().toISOString();
  const settings = store.putJson({ schemaVersion: 1, fixture: 'P5-GIT-2' });
  const publish = (publication, snapshot, digest) => {
    store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?)', publication.workflowId, snapshot.artifactId, at, at);
    store.run(`INSERT INTO workflow_publications(id, workflow_id, version, snapshot_artifact_id, definition_digest, execution_hash, authority_policy_version,
      provenance, runnable, validation_json, source_draft_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 'workflow-publication/1', 'owner-publication', 1, '{}', NULL, ?)`,
    publication.publishedVersionId, publication.workflowId, publication.version, snapshot.artifactId, digest, 'c'.repeat(64), at);
  };
  publish(repairPublication, policyRef, 'b'.repeat(64));
  publish(parentPublication, profileRef, 'd'.repeat(64));
  const parentRoot = join(scratch.root, 'parent-workspace'); mkdirSync(parentRoot);
  store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', workspace.workspaceId, slotRoot, sha256(slotRoot), at, at);
  store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'p5-parent-slot', parentRoot, sha256(parentRoot), at, at);
  const insertRun = (id, publication, snapshot, state, digest) => store.run(`INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id,
    settings_artifact_id, execution_hash, state, last_sequence, created_at, journal_version, kind, published_version_id, definition_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 2, 'workflow', ?, ?)`, id, publication.workflowId, publication === repairPublication ? workspace.workspaceId : 'p5-parent-slot',
  snapshot.artifactId, settings.artifactId, 'a'.repeat(64), state, at, publication.publishedVersionId, digest);
  insertRun(repairRunId, repairPublication, policyRef, 'queued', 'b'.repeat(64));
  insertRun(parentRunId, parentPublication, profileRef, 'waiting_for_user', 'd'.repeat(64));
  store.run('INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, ?)', parentRunId, 'failed-node', 'failed-node', 'agent', 'failed');
  store.run('INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, 1, ?)', outcomeId, parentRunId, 'failed-node', 'failed');
  const evidence = store.putText('bounded P3 incident evidence');
  const outcome = makeFailureOutcome({ run: store.get('SELECT * FROM runs WHERE id = ?', parentRunId),
    attempt: { id: outcomeId, node_instance_id: 'failed-node', state: 'failed' }, source: 'provider', code: 'provider_unavailable',
    attemptState: 'failed', runState: 'waiting_for_user', executionCertainty: 'completed', sideEffectCertainty: 'none_proven', causeKnowledge: 'direct_fact',
    evidenceReferences: [{ type: 'artifact', id: evidence.artifactId, sha256: evidence.sha256 }], recordedAt: at });
  store.appendEvents(parentRunId, [{ type: 'attempt.failure_outcome', payload: { outcome }, nodeInstanceId: 'failed-node', attemptId: outcomeId }]);
  const inputs = captureP5VerificationInputs({ store, enrollment, profile, parentRunId, incidentId, outcome });
  const sourceBinding = store.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId, parentRunId, parentPublication,
    parentSnapshot: ref(profileRef), baselineId: baseline.baselineId, baselineManifest: baseline.baselineManifest, profile: enrollment.profile,
    runningSourceRelease: enrollment.runningSourceRelease, runtimeInstanceId: randomUUID(), lifecycleGeneration: randomUUID(), boundAt: at });
  store.appendEvents(parentRunId, [{ type: 'self_repair.source_bound', payload: { record: ref(sourceBinding) } }]);
  const authorization = store.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy', incidentId, parentRunId, repairRunId,
    parentPublishedVersionId: parentPublication.publishedVersionId, parentSnapshotSha256: parentPublication.snapshotSha256,
    repairWorkflowId: repairPublication.workflowId, repairPublishedVersionId: repairPublication.publishedVersionId,
    repairSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId: workspace.workspaceId, failedNodeInstanceId: 'failed-node',
    repairResultNodeInstanceId: 'repair-result', expectedRepairResultSha256: null, failedNodeRetry: 'never', selfRepairProfile: enrollment.profile,
    profile: { selfRepair: enrollment.profile }, p5Enrollment: ref(enrollmentArtifact), p5SourceBinding: ref(sourceBinding),
    verificationInputs: inputs.artifact, outcomeId, outcomeRevision: outcome.revision });
  const checkpoint = store.putJson({ fixture: 'P5-GIT-2 checkpoint' });
  store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id,
    checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state, decision_status, authorization_artifact_id,
    repair_result_node_instance_id, failed_node_retry, acceptance_mode, created_at, updated_at)
    VALUES (?, 'linked_repair', ?, ?, 'p5-parent-slot', ?, 'failed-node', ?, 'open', 'logical_policy', ?, 'suspended_for_repair', 'pending', ?,
    'repair-result', 'never', 'judge_post_execution', ?, ?)`, linkId, parentRunId, repairRunId, workspace.workspaceId, checkpoint.artifactId,
  incidentId, authorization.artifactId, at, at);
  const intent = store.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: ref(enrollmentArtifact),
    baselineManifest: baseline.baselineManifest, sourceManifest: baseline.sourceManifest, sourceBinding: ref(sourceBinding),
    verificationInputs: inputs.artifact, parentRunId, repairRunId, linkId, workspace, createdAt: at });
  store.appendEvents(repairRunId, [{ type: 'self_repair.preparation_intent', payload: { record: ref(intent) } }]);
  const candidateAuthorization = { incidentId, parentRunId, repairRunId, linkId, outcomeId, outcomeRevision: outcome.revision,
    developerNodeId: 'developer', parentPublication, repairPublication, workspace, enrollment: ref(enrollmentArtifact),
    selfRepairProfile: enrollment.profile, verificationPolicy: enrollment.verificationPolicy, verificationInputs: inputs.artifact,
    sourceBinding: ref(sourceBinding), scope };
  const prepareGitRepository = context => prepareP5GitRepositoryFromIntent({ ...context, ...readers, protectedRoots: [upstreamRoot] });
  return { scratch, slotRoot, store, verificationPolicy, enrollment, enrollmentArtifact, baseline, intentRef: ref(intent), repairRunId, parentRunId, linkId,
    candidateAuthorization, prepareGitRepository, sourceRoot: join(slotRoot, 'source'), gitTool, releaseValue,
    close: () => { store.db.close(); releaseOwnedDir(slotRoot); } };
}

test('P5-GIT-2 managed clone: real ancestry, immutable Host boundary and Engine Aâ†’B capture recovery', { timeout: 900_000 }, async t => {
  const scratch = newScratch('p5-git2');
  const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: process.execPath, sha256: sha256(readFileSync(process.execPath)) }] });
  const hostExeDigest = sha256(readFileSync(hostExe)), hostExeMtime = statSync(hostExe).mtimeMs;
  const fixtures = [];
  try {
    const current = { epoch: await attachEngine(host) };
    const readers = {
      nativeSourceReader: request => host.request('custody.source_identity', { generation: host.generation, epoch: current.epoch, ...request }),
      nativeToolIdentityReader: request => host.request('custody.tool_identity', { generation: host.generation, epoch: current.epoch, ...request }),
    };
    const gitPath = actualGit(), git = gitRunner(gitPath);

    // Upstream source: two commits, the second is the installed release. A bare remote stands in for the enrolled origin.
    const upstreamRoot = join(scratch.root, 'upstream');
    mkdirSync(upstreamRoot);
    git(upstreamRoot, ['init', '--quiet', '--initial-branch=main']);
    for (const [path, text] of UPSTREAM_FILES) { mkdirSync(dirname(join(upstreamRoot, path)), { recursive: true }); writeFileSync(join(upstreamRoot, path), text); }
    git(upstreamRoot, ['add', '--all']);
    git(upstreamRoot, ['commit', '--quiet', '-m', 'fixture history root']);
    const ancestorCommit = git(upstreamRoot, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(upstreamRoot, 'src', 'ui.ts'), 'export const ui = 2;\n');
    git(upstreamRoot, ['commit', '--quiet', '-am', 'installed release source']);
    const installedCommit = git(upstreamRoot, ['rev-parse', 'HEAD']).trim();
    const remoteRoot = join(scratch.root, 'origin.git');
    git(scratch.root, ['init', '--quiet', '--bare', '--initial-branch=main', remoteRoot]);
    git(upstreamRoot, ['push', '--quiet', pathToFileURL(remoteRoot).href, 'HEAD:refs/heads/main']);
    // GIT2-02: the remote default branch moves after the installed release was built.
    const movedCommit = git(remoteRoot, ['commit-tree', `${installedCommit}^{tree}`, '-p', installedCommit, '-m', 'later upstream work']).trim();
    git(remoteRoot, ['update-ref', 'refs/heads/main', movedCommit, installedCommit]);
    const remoteRefsBefore = git(remoteRoot, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const upstreamState = () => [git(upstreamRoot, ['rev-parse', 'HEAD']), git(upstreamRoot, ['for-each-ref', '--format=%(refname) %(objectname)']),
      git(upstreamRoot, ['status', '--porcelain=v2', '--untracked-files=all']), sha256(readFileSync(join(upstreamRoot, '.git', 'index')))];
    const upstreamBefore = upstreamState();
    const common = await readers.nativeSourceReader({ root: join(upstreamRoot, '.git'), include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    assert.equal(common.refused, undefined, common.message);
    const identityFor = () => ({ enrollmentId: randomUUID(), canonicalCommonDirectory: common.canonicalRoot, nativeDirectoryIdentity: common.rootIdentity });
    const enrollArgs = { host, readers, gitPath, upstreamRoot, installedCommit };

    // GIT2-03: a remote without the installed commit is refused; no newer revision is adopted and nothing is cleaned.
    const missingRemote = join(scratch.root, 'missing.git');
    git(scratch.root, ['init', '--quiet', '--bare', '--initial-branch=main', missingRemote]);
    git(upstreamRoot, ['push', '--quiet', pathToFileURL(missingRemote).href, `${ancestorCommit}:refs/heads/main`]);
    const missing = await enrollFixture({ ...enrollArgs, label: 'missing', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(missingRemote).href });
    fixtures.push(missing);
    await assert.rejects(prepareP5WorkspaceFromIntent({ store: missing.store, intentRef: missing.intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository: missing.prepareGitRepository }), { code: 'p5_git_source_commit_unavailable' });
    assert.equal(git(missing.sourceRoot, ['for-each-ref', '--format=%(refname)']).trim(), '', 'no repair branch is created from another revision');
    assert.ok(existsSync(join(missing.slotRoot, '.p5', 'control', 'git-repository-intent.json')), 'the refused repository is retained, not cleaned');

    // GIT2-04: fetched bytes that do not reproduce the installed release source digest are refused.
    const mismatch = await enrollFixture({ ...enrollArgs, label: 'digest', repositoryIdentity: identityFor(),
      remoteUrl: pathToFileURL(remoteRoot).href, releaseDigestOverride: sha256('not the installed source') });
    fixtures.push(mismatch);
    await assert.rejects(prepareP5WorkspaceFromIntent({ store: mismatch.store, intentRef: mismatch.intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository: mismatch.prepareGitRepository }), { code: 'p5_git_source_provenance_mismatch' });

    // P5-FINAL Â§8.1: a server that refuses object-ID wants. The pinned protocol-v0 client makes the real local repository
    // server apply its default uploadpack restrictions, so the installed commit (no longer a ref tip after main moved) is
    // refused by ID and P5 falls back to the enrolled refs. The baseline stays the installed commit, never the moved tip.
    const v0Source = resolve(import.meta.dirname, 'fixtures', 'git-v0-client.rs');
    const v0Git = join(rustFixtureDir(v0Source, join(testsRoot, 'custody-artifacts', 'git-v0')), 'git.exe');
    buildRustFixture(v0Source, v0Git);
    writeFileSync(join(dirname(v0Git), 'git-real.txt'), gitPath);
    const probeRoot = join(scratch.root, 'v0-probe.git');
    git(scratch.root, ['init', '--quiet', '--bare', probeRoot]);
    const refused = spawnSync(v0Git, ['-C', probeRoot, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-write-fetch-head', pathToFileURL(remoteRoot).href, installedCommit],
      { encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    assert.notEqual(refused.status, 0, 'the server refuses the unadvertised installed object ID over protocol v0');
    assert.match(refused.stderr, /unadvertised object/, refused.stderr);
    const fallback = await enrollFixture({ ...enrollArgs, gitPath: v0Git, label: 'fallback', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(remoteRoot).href });
    fixtures.push(fallback);
    const fallbackPrepared = await prepareP5WorkspaceFromIntent({ store: fallback.store, intentRef: fallback.intentRef,
      nativeSourceReader: readers.nativeSourceReader, prepareGitRepository: fallback.prepareGitRepository });
    const fallbackRepository = fallbackPrepared.evidence.gitRepository;
    const fallbackProvenance = fallback.store.readJson(fallbackRepository.fetchProvenance.artifactId);
    assert.equal(fallbackProvenance.strategy, 'enrolled-refs', 'the refused object-ID fetch fell back to the enrolled refs');
    assert.deepEqual(fallbackProvenance.refspecs, ['refs/heads/main'], 'only the enrolled ref is requested, never an arbitrary ref');
    assert.equal(fallbackRepository.seedCommit, installedCommit, 'the moved remote ref does not change the baseline');
    assert.ok(fallbackProvenance.unreachableObjects.includes(movedCommit), 'the moved tip is recorded as unreachable, not adopted');
    assert.deepEqual(git(fallback.sourceRoot, ['rev-list', installedCommit]).trim().split(/\r?\n/), [installedCommit, ancestorCommit], 'history stays valid');
    assert.equal(git(fallback.sourceRoot, ['for-each-ref', '--format=%(refname)']).trim(), `refs/heads/${fallbackRepository.repairBranch}`, 'no remote ref is written locally');
    // Missing commit through the same fallback: the enrolled refs do not contain it, so preparation fails closed.
    const fallbackMissing = await enrollFixture({ ...enrollArgs, gitPath: v0Git, label: 'fallback-missing', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(missingRemote).href });
    fixtures.push(fallbackMissing);
    await assert.rejects(prepareP5WorkspaceFromIntent({ store: fallbackMissing.store, intentRef: fallbackMissing.intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository: fallbackMissing.prepareGitRepository }), { code: 'p5_git_source_commit_unavailable' });
    // A credential-bearing remote is refused at enrollment validation, and the refusal never echoes the secret.
    const credentialed = await enrollFixture({ ...enrollArgs, label: 'credentialed', repositoryIdentity: identityFor(),
      remoteUrl: 'https://p5-user:p5-secret-token@example.invalid/deszo.git' }).catch(error => error);
    if (credentialed instanceof Error) {
      assert.ok(!String(credentialed.message).includes('p5-secret-token'), 'no credential is echoed');
    } else {
      fixtures.push(credentialed);
      const error = await prepareP5WorkspaceFromIntent({ store: credentialed.store, intentRef: credentialed.intentRef, nativeSourceReader: readers.nativeSourceReader,
        prepareGitRepository: credentialed.prepareGitRepository }).catch(value => value);
      assert.ok(error instanceof Error && ['p5_git_remote_invalid', 'p5_enrollment_invalid'].includes(error.code), `credentialed remote refused: ${error?.code}`);
      assert.ok(!String(error.message).includes('p5-secret-token'), 'no credential is echoed');
    }
    // P5-CLOSURE E-08 / H2: interrupted fetches. The pinned client fixture interrupts real fetches mid-transfer: it leaves a
    // partial temporary pack (and, when asked, a stale remote-tracking ref) and fails like a lost connection.
    const interruptSource = resolve(import.meta.dirname, 'fixtures', 'git-interrupt-client.rs');
    const interruptGit = join(rustFixtureDir(interruptSource, join(testsRoot, 'custody-artifacts', 'git-interrupt')), 'git.exe');
    buildRustFixture(interruptSource, interruptGit);
    writeFileSync(join(dirname(interruptGit), 'git-real.txt'), gitPath);
    const interruptMarker = join(dirname(interruptGit), 'interrupt-fetch.txt');
    const prepareFixture = (fixture, recovery = false) => prepareP5WorkspaceFromIntent({ store: fixture.store, intentRef: fixture.intentRef,
      nativeSourceReader: readers.nativeSourceReader, prepareGitRepository: fixture.prepareGitRepository, recovery });
    // Both strategies interrupted: no baseline, no recorded fetch result, and the partial pack is left in place (no cleanup).
    writeFileSync(interruptMarker, '2');
    const interrupted = await enrollFixture({ ...enrollArgs, gitPath: interruptGit, label: 'interrupted', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(remoteRoot).href });
    fixtures.push(interrupted);
    await assert.rejects(prepareFixture(interrupted), { code: 'p5_git_source_fetch_failed' });
    const partialPack = join(interrupted.sourceRoot, '.git', 'objects', 'pack', 'tmp_pack_p5_interrupted');
    assert.ok(existsSync(partialPack), 'the interrupted transfer left its partial pack, which P5 never deletes');
    assert.equal(spawnSync(gitPath, ['-C', interrupted.sourceRoot, 'cat-file', '-e', installedCommit], { windowsHide: true }).status === 0, false,
      'the installed commit is genuinely absent after the interruption');
    // Engine restart (startup recovery of the same durable intent) with the remote retrievable again: P5 refetches and verifies.
    writeFileSync(interruptMarker, '0');
    await assert.rejects(prepareFixture(interrupted), { code: 'p5_workspace_conflict' }, 'a non-recovery request never adopts partial state');
    const resumed = await prepareFixture(interrupted, true);
    assert.equal(resumed.evidence.gitRepository.seedCommit, installedCommit, 'the recovered baseline is the exact installed commit');
    assert.ok(existsSync(partialPack), 'unrelated partial state is still not cleaned up');
    assert.deepEqual(git(interrupted.sourceRoot, ['rev-list', installedCommit]).trim().split(/\r?\n/), [installedCommit, ancestorCommit], 'complete verified history');
    // A stale remote-tracking ref left by an interrupted transfer is unexpected metadata: refused and left untouched.
    writeFileSync(interruptMarker, `1 ${movedCommit}`);
    const staleRef = await enrollFixture({ ...enrollArgs, gitPath: interruptGit, label: 'stale-ref', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(remoteRoot).href });
    fixtures.push(staleRef);
    const staleError = await prepareFixture(staleRef).catch(error => error);
    assert.ok(staleError instanceof Error && String(staleError.code).startsWith('p5_git_'), `a stale ref is refused: ${staleError?.code} ${staleError?.message}`);
    assert.equal(readFileSync(join(staleRef.sourceRoot, '.git', 'refs', 'remotes', 'origin', 'main'), 'utf8').trim(), movedCommit, 'the stale ref is retained');
    writeFileSync(interruptMarker, '0');
    assert.deepEqual(upstreamState(), upstreamBefore, 'the original checkout is unchanged by every fallback case');

    // Main fixture: the enrolled origin whose main moved past the installed commit.
    const fx = await enrollFixture({ ...enrollArgs, label: 'main', repositoryIdentity: identityFor(), remoteUrl: pathToFileURL(remoteRoot).href });
    fixtures.push(fx);
    const { store } = fx;
    const managedGit = args => git(fx.sourceRoot, args);
    // GIT2-06: crash after the branch exists but before the prepared event, then recover the same branch.
    await assert.rejects(prepareP5WorkspaceFromIntent({ store, intentRef: fx.intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository: async context => { await fx.prepareGitRepository(context);
        throw Object.assign(new Error('fixture crash after managed clone'), { code: 'fixture_crash_after_clone' }); } }), { code: 'fixture_crash_after_clone' });
    assert.equal(store.readEvents(fx.repairRunId).filter(item => item.type === 'self_repair.workspace_prepared').length, 0);
    const branchBeforeRecovery = managedGit(['for-each-ref', '--format=%(refname) %(objectname)']).trim();
    const prepared = await prepareP5WorkspaceFromIntent({ store, intentRef: fx.intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository: fx.prepareGitRepository, recovery: true });
    const repository = prepared.evidence.gitRepository;
    assert.equal(managedGit(['for-each-ref', '--format=%(refname) %(objectname)']).trim(), branchBeforeRecovery, 'recovery reuses the exact branch');
    store.appendEvents(fx.repairRunId, [{ type: 'self_repair.workspace_prepared', payload: { record: prepared.evidenceArtifact } }]);
    const preparedRef = prepared.evidenceArtifact;
    store.run("UPDATE runs SET state = 'running' WHERE id = ?", fx.repairRunId);

    // GIT2-01 / GIT2-02: real installed ancestry, no synthetic root, remote movement ignored.
    assert.equal(repository.policy, 'managed-clone-v1');
    assert.equal(repository.sourceAncestryVerified, true);
    assert.equal(repository.seedCommit, installedCommit, 'the repair branch starts at the exact installed commit, not remote main');
    assert.match(repository.repairBranch, /^self-repair\/[a-f0-9]{12}$/);
    assert.equal(branchBeforeRecovery, `refs/heads/${repository.repairBranch} ${installedCommit}`);
    assert.deepEqual(managedGit(['rev-list', installedCommit]).trim().split(/\r?\n/), [installedCommit, ancestorCommit], 'original ancestry is present');
    assert.equal(managedGit(['rev-list', '--max-parents=0', installedCommit]).trim(), ancestorCommit, 'the history root is the original root');
    assert.equal(managedGit(['status', '--porcelain=v2', '--untracked-files=all', '--ignored=matching']), '');
    // GIT2-05: independent object storage, no remotes or alternates, upstream checkout untouched.
    assert.equal(resolve(managedGit(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()).toLowerCase(), join(fx.sourceRoot, '.git').toLowerCase());
    assert.equal(managedGit(['remote']).trim(), '');
    assert.equal(existsSync(join(fx.sourceRoot, '.git', 'objects', 'info', 'alternates')), false);
    assert.deepEqual(upstreamState(), upstreamBefore, 'the original checkout is unchanged');
    const provenance = store.readJson(repository.fetchProvenance.artifactId);
    assert.ok(['commit', 'enrolled-refs'].includes(provenance.strategy));
    assert.equal(provenance.remoteUrl, pathToFileURL(remoteRoot).href);
    const holdsMoved = spawnSync(gitPath, ['-C', fx.sourceRoot, 'cat-file', '-e', `${movedCommit}^{commit}`], { windowsHide: true }).status === 0;
    assert.equal(holdsMoved, provenance.unreachableObjects.includes(movedCommit), 'any newer fetched commit is recorded as unreachable, never as a ref');
    t.diagnostic(`fetch strategy: ${provenance.strategy}; unreachable fetched objects: ${provenance.unreachableObjects.length}`);
    const protection = readP5HostProtection(store, repository.hostProtection);
    assert.ok(protection.derivedPaths.includes('runtime/core/canonical.mjs'), 'the Host closure follows the Host service import graph');
    assert.ok(!protection.derivedPaths.includes('runtime/core/feature.mjs'), 'Engine-only modules stay outside the Host closure');
    for (const [path, reason] of [['lifecycle-host/src/custody.rs', 'host_source_or_packaging'], ['package.json', 'build_or_dependency_input'],
      ['Cargo.lock', 'build_or_dependency_input'], ['scripts/build-shim.mjs', 'host_source_or_packaging'], ['tools/new.mjs', 'host_impact_unknown'],
      ['docs/storage/host-h3.sql', 'host_source_or_packaging'], ['docs/storage/m1.sql', 'host_source_or_packaging'],
      // Review F1: nested dependency directories could shadow the installed packages served to protected checks.
      ['runtime/tests/node_modules/ajv/index.js', 'build_or_dependency_input'], ['src/.pnpm/x.js', 'build_or_dependency_input'],
      ['runtime/tests/Node_Modules/ajv/index.js', 'build_or_dependency_input'], ['Package.json', 'build_or_dependency_input'],
      ['Lifecycle-Host/src/main.rs', 'host_source_or_packaging'], ['Runtime/Host/lifecycle.mjs', 'host_source_or_packaging'],
      // P5-FINAL Â§5: Engine control and P5 modules are repairable Engine source, classified into verification tiers.
      ['runtime/core/p5HostBoundary.mjs', null], ['runtime/core/p5GitCandidate.mjs', null], ['runtime/verification/p5Verifier.mjs', null],
      ['runtime/core/engine.mjs', null], ['runtime/core/linkedRepair.mjs', null], ['runtime/runner.mjs', null],
      ['runtime/core/feature.mjs', null], ['src/ui.ts', null]]) assert.equal(p5HostStaticReason(path), reason, path);
    // P5-CLOSURE F5: every file of the attested trusted control closure is repair-authority; every other shipped Engine input
    // (including shared/, mcp/, docs/examples) is at least engine-core; an unknown runtime path is engine-core, never ordinary.
    for (const [path, tier] of [['runtime/core/p5Gate.mjs', 'repair-authority'], ['runtime/verification/p5Verifier.mjs', 'repair-authority'],
      ['runtime/core/workflowJudge.mjs', 'repair-authority'], ['runtime/core/custody.mjs', 'repair-authority'], ['runtime/core/engine.mjs', 'repair-authority'],
      ['runtime/runner.mjs', 'repair-authority'], ['runtime/core/gate.mjs', 'repair-authority'], ['runtime/core/processes.mjs', 'engine-custody'],
      ['runtime/core/adapters.mjs', 'engine-custody'], ['runtime/core/feature.mjs', 'engine-core'], ['shared/effort.mjs', 'engine-core'],
      ['mcp/bridge.mjs', 'engine-core'], ['docs/examples/managed-task/workflow.json', 'engine-core'], ['Runtime/Core/Engine.mjs', 'repair-authority'],
      ['src/ui.ts', 'ordinary']])
      assert.equal(p5MutationTier(path), tier, path);
    for (const path of ['dist-runtime/runner.mjs', 'Dist/index.html']) assert.equal(p5HostStaticReason(path), 'host_source_or_packaging', path);
    // Attestation and tiers come from one list, so a trusted control file can never fall to a weaker tier.
    const { TRUSTED_SOURCE_PATHS } = await import('../core/p5Gate.mjs');
    assert.ok(TRUSTED_SOURCE_PATHS.includes('runtime/core/engine.mjs') && TRUSTED_SOURCE_PATHS.includes('runtime/verification/p5Verifier.mjs'));
    for (const path of TRUSTED_SOURCE_PATHS.filter(item => !p5HostStaticReason(item)))
      assert.equal(p5MutationTier(path), 'repair-authority', `trusted control ${path}`);
    assert.throws(() => classifyP5Mutation({ changes: ['runtime/core/p5Gate.mjs'], policy: { ...fx.verificationPolicy, mutationTiers: [] } }),
      { code: 'p5_mutation_tier_unclassified' }, 'a sensitive tier the captured policy does not configure fails closed');
    assert.deepEqual(classifyP5Mutation({ changes: ['runtime/core/p5Gate.mjs', 'src/ui.ts'], policy: fx.verificationPolicy }).tiers, ['ordinary', 'repair-authority']);

    // GIT2-08 / GIT2-09: direct and indirect Host changes are refused before any Git commit intent.
    const sealArgs = () => {
      const terminal = store.putJson({ attemptId: randomUUID(), processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 });
      const value = store.readJson(terminal.artifactId);
      return { store, sourceRoot: fx.sourceRoot, budgets: fx.enrollment.budgets, nativeSourceReader: readers.nativeSourceReader,
        baseline: { ...fx.baseline, contentRefs: new Map(store.readJson(fx.baseline.sourceManifest.artifactId).entries.map(entry => [entry.path, entry.artifact])) },
        authorization: { ...fx.candidateAuthorization, developerAttemptId: value.attemptId, developerTerminal: { artifact: ref(terminal), attemptId: value.attemptId,
          processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 }, capturedAt: new Date().toISOString(), journalCursor: 1 } };
    };
    const editAndRestore = async (path, text, action) => {
      const absolute = join(fx.sourceRoot, ...path.split('/')), original = readFileSync(absolute);
      writeFileSync(absolute, text);
      try { await action(); } finally { writeFileSync(absolute, original); }
    };
    await editAndRestore('lifecycle-host/src/custody.rs', 'pub fn custody_boundary() -> &\'static str { "patched" }\n', () =>
      assert.rejects(sealP5Candidate(sealArgs()), { code: 'p5_host_boundary_violation' }, 'direct Lifecycle Host source change'));
    await editAndRestore('package.json', '{ "name": "deszo-fixture", "scripts": { "postinstall": "x" } }\n', () =>
      assert.rejects(sealP5Candidate(sealArgs()), { code: 'p5_host_boundary_violation' }, 'shared dependency/build input change'));
    await editAndRestore('runtime/core/canonical.mjs', "export const trustTag = 'patched';\n", () =>
      assert.rejects(sealP5Candidate(sealArgs()), { code: 'p5_host_boundary_violation' },
        'a Host-imported runtime module outside lifecycle-host/ is refused at sealing, before any anchor-bound intent'));
    assert.equal(store.readEvents(fx.repairRunId).filter(item => item.type === 'self_repair.git_commit_intent').length, 0);
    assert.throws(() => assertP5HostBoundary({ changes: ['runtime/core/canonical.mjs'], protection }), { code: 'p5_host_boundary_violation' });
    assert.deepEqual(assertP5HostBoundary({ changes: ['runtime/core/feature.mjs', 'src/ui.ts'], protection }).checked, 2);
    // A partial tree without Host entry points cannot establish the closure, so closure roots are refused there.
    const partialClosure = { ...protection, hostEntryPoints: [], derivedPaths: [] };
    assert.throws(() => assertP5HostBoundary({ changes: ['runtime/core/store.mjs'], candidateClosure: partialClosure }), { code: 'p5_host_boundary_violation' });
    assert.throws(() => assertP5HostBoundary({ changes: ['docs/schemas/x.schema.json'], candidateClosure: partialClosure }), { code: 'p5_host_boundary_violation' });
    assert.equal(assertP5HostBoundary({ changes: ['src/ui.ts'], candidateClosure: partialClosure }).checked, 1);

    // A real Developer process under Host Custody edits an allowed Engine file (GIT2-10).
    const developerAttemptId = randomUUID();
    const candidateText = 'export const boundary = "candidate";\n';
    const admission = await host.request('custody.reserve', { generation: host.generation, epoch: current.epoch, attemptId: developerAttemptId,
      runId: fx.repairRunId, provider: 'p5-developer', command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync('runtime/core/feature.mjs', ${JSON.stringify(candidateText)})`],
      cwd: fx.sourceRoot, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot }, stdinHex: '', deadlineMs: 60_000 });
    assert.ok(admission.permit, `the Host refused the Developer invocation: ${JSON.stringify(admission)}`);
    await host.request('custody.launch', { generation: host.generation, epoch: current.epoch, custodyId: admission.custodyId, permit: admission.permit });
    await eventually(async () => (await host.request('custody.status', { generation: host.generation, epoch: current.epoch, custodyId: admission.custodyId })).terminal,
      'the Developer process tree to end', 30_000, 50);
    assert.equal(readFileSync(join(fx.sourceRoot, 'runtime', 'core', 'feature.mjs'), 'utf8'), candidateText);

    const outFile = join(scratch.root, 'engine-result.json');
    const config = { root: fx.scratch.root, host: { address: host.address, capability: host.capability, generation: host.generation, pid: host.pid },
      repairRunId: fx.repairRunId, linkId: fx.linkId, developerAttemptId, custodyId: admission.custodyId, enrollment: ref(fx.enrollmentArtifact),
      preparedRef, sourceRoot: fx.sourceRoot, candidateAuthorization: { ...fx.candidateAuthorization, developerAttemptId }, out: outFile };
    const configFile = join(scratch.root, 'engine-config.json');
    writeFileSync(configFile, JSON.stringify(config));
    const runEngine = fault => {
      if (existsSync(outFile)) writeFileSync(outFile, '');
      const env = { ...process.env, ...(fault ? { DESZO_CUSTODY_TEST_FAULT: fault } : {}) };
      if (!fault) delete env.DESZO_CUSTODY_TEST_FAULT;
      const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', childScript, configFile], { env, encoding: 'utf8', timeout: 240_000, windowsHide: true });
      const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
      return { status: child.status, stderr: child.stderr, result: text ? JSON.parse(text) : null };
    };
    const events = type => store.readEvents(fx.repairRunId).filter(item => item.type === type);
    const counts = () => ({ anchors: events('self_repair.candidate_capture_started').length, intents: events('self_repair.git_commit_intent').length,
      captured: events('self_repair.candidate_captured').length });
    const branchTip = () => managedGit(['rev-parse', `refs/heads/${repository.repairBranch}`]).trim();
    const objectCount = () => managedGit(['count-objects', '-v']);
    const attemptsBefore = store.get('SELECT COUNT(*) AS n FROM attempts').n;

    // Engine A ends after the durable anchor, before sealing.
    let run = runEngine('p5_after_capture_anchor');
    assert.equal(run.status, 97, run.stderr);
    assert.deepEqual(counts(), { anchors: 1, intents: 0, captured: 0 });
    const anchor = store.readJson(events('self_repair.candidate_capture_started')[0].payload.record.artifactId);
    assert.equal(anchor.expectedSourceDigest.length, 64);
    assert.equal(branchTip(), installedCommit, 'no Git mutation precedes sealing');

    // GIT2-17: a Stop after the anchor forbids any further capture or Git mutation.
    store.run("UPDATE run_links SET parent_suspension_state = 'stopped' WHERE id = ?", fx.linkId);
    run = runEngine(null);
    assert.equal(run.result.ok, false); assert.equal(run.result.code, 'p5_candidate_authority_changed');
    assert.deepEqual(counts(), { anchors: 1, intents: 0, captured: 0 }); assert.equal(branchTip(), installedCommit);
    store.run("UPDATE run_links SET parent_suspension_state = 'suspended_for_repair' WHERE id = ?", fx.linkId);

    // GIT2-12 (negative): live bytes that changed after the anchor are never resealed as the same or a new candidate.
    await editAndRestore('runtime/core/feature.mjs', 'export const boundary = "drifted";\n', async () => {
      run = runEngine(null);
      assert.equal(run.result.ok, false); assert.equal(run.result.code, 'p5_capture_source_drift');
      assert.deepEqual(counts(), { anchors: 1, intents: 0, captured: 0 });
    });
    writeFileSync(join(fx.sourceRoot, 'runtime', 'core', 'feature.mjs'), candidateText);

    // Engine B reseals under the anchor and ends after sealing (GIT2-12); Engine C ends with the intent journaled, before Git.
    run = runEngine('p5_after_candidate_seal');
    assert.equal(run.status, 97, run.stderr);
    assert.deepEqual(counts(), { anchors: 1, intents: 0, captured: 0 });
    run = runEngine('p5_before_git_commit');
    assert.equal(run.status, 97, run.stderr);
    assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 0 });
    assert.equal(branchTip(), installedCommit);
    const intent = store.readJson(events('self_repair.git_commit_intent')[0].payload.record.artifactId);
    assert.equal(intent.candidateId, anchor.expectedCandidateId);
    assert.equal(intent.candidateSourceDigest, anchor.expectedSourceDigest);

    // P5-FINAL E-08: a held Git index lock and a partially written index are refused before any commit and left in place;
    // nothing is reset, cleaned or force-updated. Only after the Owner restores the index does the same intent proceed.
    const indexPath = join(fx.sourceRoot, '.git', 'index'), lockPath = `${indexPath}.lock`;
    writeFileSync(lockPath, '');
    run = runEngine(null);
    assert.equal(run.result?.ok, false, 'a held index lock refuses the Engine commit');
    assert.ok(existsSync(lockPath), 'the foreign index lock is retained, never deleted by P5');
    assert.equal(branchTip(), installedCommit); assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 0 });
    rmSync(lockPath);
    const indexBytes = readFileSync(indexPath);
    writeFileSync(indexPath, indexBytes.subarray(0, Math.floor(indexBytes.length / 2)));
    run = runEngine(null);
    assert.equal(run.result?.ok, false, 'a partially written index refuses the Engine commit');
    assert.equal(branchTip(), installedCommit, 'no commit or ref update follows a corrupt index');
    assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 0 });
    writeFileSync(indexPath, indexBytes);

    // Engine D creates the Engine commit and ends before binding (GIT2-11); Engine E binds and ends before the final event.
    run = runEngine('p5_after_git_commit');
    assert.equal(run.status, 97, run.stderr);
    const candidateCommit = branchTip();
    assert.notEqual(candidateCommit, installedCommit);
    assert.equal(managedGit(['rev-parse', `${candidateCommit}^`]).trim(), installedCommit, 'the candidate commit descends from the installed commit');
    run = runEngine('p5_after_git_candidate_bound');
    assert.equal(run.status, 97, run.stderr);
    assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 0 });
    assert.equal(branchTip(), candidateCommit, 'binding recovery reuses the existing commit');

    // GIT2-13: Engine F completes from durable state: same link, Attempt, allocation, source and commit; no new Developer.
    run = runEngine(null);
    assert.equal(run.result?.ok, true, JSON.stringify(run.result) + run.stderr);
    assert.equal(run.result.recoveryState.state, 'git_commit_pending');
    assert.equal(run.result.stage, 'capturing');
    assert.deepEqual(run.result.issues, []);
    assert.equal(run.result.recovered, true);
    assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 1 });
    assert.equal(branchTip(), candidateCommit);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM attempts').n, attemptsBefore, 'recovery never relaunches the Developer');
    const candidateRef = run.result.candidateArtifact;
    const candidate = store.readJson(candidateRef.artifactId);
    assert.equal(candidate.candidateId, anchor.expectedCandidateId);
    assert.equal(candidate.developerAttemptId, developerAttemptId);
    assert.equal(candidate.linkId, fx.linkId);
    assert.equal(candidate.workspace.allocationId, fx.enrollment.workspace.allocationId);
    assert.deepEqual(candidate.developerTerminalEvidence, anchor.developerTerminalEvidence, 'the first Engine terminal evidence remains authoritative');

    // GIT2-07 / GIT2-16: commit, tree and SHA-256 source manifest bind the same immutable candidate.
    current.epoch = await attachEngine(host);
    const verified = await verifyP5GitCandidateCurrent({ store, candidateRef, ...readers });
    assert.equal(verified.candidateCommit, candidateCommit);
    const sourceManifest = store.readJson(candidate.sourceManifest.artifactId);
    assert.equal(p5SourceDigest(sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry)), candidate.candidateSourceDigest);
    assert.equal(verified.sourceDigest, candidate.candidateSourceDigest);
    assert.deepEqual(managedGit(['diff', '--name-only', installedCommit, candidateCommit]).trim().split(/\r?\n/), ['runtime/core/feature.mjs']);
    assert.equal(managedGit(['show', `${candidateCommit}:runtime/core/feature.mjs`]), candidateText);
    assert.equal(managedGit(['log', '-1', '--format=%an <%ae>', candidateCommit]).trim(), 'Deszo P5 Engine <deszo-p5-engine@invalid>');
    const gitCandidate = store.readJson(candidate.gitCandidate.artifactId);
    assert.equal(gitCandidate.git.historyPolicy, 'managed-clone-v1');
    assert.equal(gitCandidate.git.sourceAncestryVerified, true);
    assert.deepEqual(gitCandidate.hostProtection, repository.hostProtection);

    // GIT2-14: repeated startup adds no candidate, event, commit or object.
    const objectsBefore = objectCount();
    run = runEngine(null);
    assert.equal(run.result.ok, false); assert.equal(run.result.code, 'p5_candidate_already_captured');
    assert.deepEqual(counts(), { anchors: 1, intents: 1, captured: 1 });
    assert.equal(branchTip(), candidateCommit); assert.equal(objectCount(), objectsBefore);

    // GIT2-15: conflicting Git or source state is refused and left in place.
    current.epoch = await attachEngine(host);
    await editAndRestore('src/ui.ts', 'export const ui = 3;\n', () =>
      assert.rejects(verifyP5GitCandidateCurrent({ store, candidateRef, ...readers }), { code: 'p5_git_source_mismatch' }));
    await verifyP5GitCandidateCurrent({ store, candidateRef, ...readers });
    managedGit(['update-ref', `refs/heads/${repository.repairBranch}`, installedCommit, candidateCommit]);
    await assert.rejects(verifyP5GitCandidateCurrent({ store, candidateRef, ...readers }), { code: 'p5_git_branch_moved' });
    assert.equal(branchTip(), installedCommit, 'the moved branch is retained, not force-reset');
    managedGit(['update-ref', `refs/heads/${repository.repairBranch}`, candidateCommit, installedCommit]);
    // Restoring the ref by hand does not restore eligibility: the Host-measured .git storage still records the tampering.
    await assert.rejects(verifyP5GitCandidateCurrent({ store, candidateRef, ...readers }), { code: 'p5_git_metadata_drift' });

    // GIT2-19 / GIT2-20: no Host build or replacement, no remote publication; publication is policy-evaluated only.
    assert.equal(sha256(readFileSync(hostExe)), hostExeDigest); assert.equal(statSync(hostExe).mtimeMs, hostExeMtime);
    assert.equal(managedGit(['diff', '--name-only', installedCommit, candidateCommit, '--', 'lifecycle-host']).trim(), '');
    assert.equal(git(remoteRoot, ['for-each-ref', '--format=%(refname) %(objectname)']), remoteRefsBefore, 'no ref was published');
    assert.deepEqual(upstreamState(), upstreamBefore);
    const handoffFor = (enrollmentRef, authority = {}) => {
      const placeholder = ref(store.putJson({ fixture: 'handoff placeholder' }));
      const handoff = { schemaVersion: 1, kind: 'ProtectedSelfRepairHandoff', handoffId: 'e'.repeat(64), candidateId: candidate.candidateId,
        candidateSourceDigest: candidate.candidateSourceDigest, candidate: candidateRef, gitCandidate: candidate.gitCandidate, baselineId: candidate.baselineId,
        repositoryIdentity: candidate.repositoryIdentity, sourceBinding: candidate.sourceBinding, enrollment: enrollmentRef, sourceManifest: candidate.sourceManifest,
        changeManifest: candidate.changeManifest, verificationPolicy: candidate.verificationPolicy, verificationInputs: candidate.verificationInputs,
        verificationReceipt: placeholder, parentRunId: candidate.parentRunId, repairRunId: candidate.repairRunId, linkId: candidate.linkId,
        incidentId: candidate.incidentId, judgeAttemptId: randomUUID(), decisionId: randomUUID(), p2Authorization: placeholder, p2Approval: placeholder,
        p2Outcome: placeholder, retentionRecord: placeholder, continuationState: 'accepted',
        hostProvenance: { custodyId: randomUUID(), hostIdentity: 'fixture-host', lifecycleGeneration: randomUUID(), engineEpoch: 1,
          invocationDigest: 'f'.repeat(64), commandManifest: placeholder, executableIdentity: 'node', harnessClosureDigest: '1'.repeat(64),
          testInputManifest: placeholder, environmentDigest: 'f'.repeat(64) },
        retention: { status: 'retained', revision: 1, retainedAt: new Date().toISOString(), cleanupDeferred: true },
        currentEligibility: { eligible: true, revision: 1, checkedAt: new Date().toISOString(), stage: 'p5_acceptance', candidateSourceDigest: candidate.candidateSourceDigest,
          gitCandidate: candidate.gitCandidate, repairBranch: repository.repairBranch, candidateCommit, candidateTree: verified.candidateTree,
          storageSnapshotDigest: verified.storageSnapshotDigest },
        authority: { sourceCandidateAccepted: true, sourceApplied: false, branchPublished: false, productionBuilt: false, binaryInstalled: false, activated: false,
          hostModificationAuthorized: false, hostReplacementAuthorized: false, hostUpdateAuthorized: false, ...authority } };
      return handoff;
    };
    const tryHandoff = (enrollmentRef, authority) => { const value = handoffFor(enrollmentRef, authority); validateP5Contract('handoff', value); return ref(store.putJson(value)); };
    for (const field of ['hostModificationAuthorized', 'hostReplacementAuthorized', 'hostUpdateAuthorized'])
      assert.throws(() => validateP5Contract('handoff', handoffFor(ref(fx.enrollmentArtifact), { [field]: true })), `a handoff can never carry ${field}`);
    assert.deepEqual(evaluateP5GitPublication({ store, eligibility: { stage: 'retained_for_p6', issues: [], parentStopped: false, handoffId: 'e'.repeat(64) }, handoffRef: tryHandoff(ref(fx.enrollmentArtifact)) }).reasons, ['publication_disabled']);
    const enabled = ref(store.putJson({ ...fx.enrollment, gitSource: { ...fx.enrollment.gitSource,
      publication: { ...fx.enrollment.gitSource.publication, enabled: true } } }));
    const plan = evaluateP5GitPublication({ store, eligibility: { stage: 'retained_for_p6', issues: [], parentStopped: false, handoffId: 'e'.repeat(64) }, handoffRef: tryHandoff(enabled) });
    assert.equal(plan.authorized, true);
    assert.equal(plan.plan.ref, `refs/heads/${repository.repairBranch}`); assert.equal(plan.plan.commit, candidateCommit);
    assert.deepEqual(evaluateP5GitPublication({ store, eligibility: { stage: 'retained_for_p6', issues: [], parentStopped: false, handoffId: 'e'.repeat(64) }, handoffRef: tryHandoff(enabled), observedRemoteObjectId: movedCommit }).reasons, ['remote_ref_conflict']);
    assert.throws(() => tryHandoff(enabled, { branchPublished: true }), 'a P5 handoff cannot itself claim a published branch');
    assert.equal(git(remoteRoot, ['for-each-ref', '--format=%(refname) %(objectname)']), remoteRefsBefore, 'policy evaluation never writes the remote');

    // P5-FINAL Â§8.2: the production publication operation against test-owned bare remotes (no real hosted remote).
    const gitTool = { path: gitPath, sha256: sha256(readFileSync(gitPath)) };
    const repairRef = `refs/heads/${repository.repairBranch}`;
    const liveEligibility = { stage: 'retained_for_p6', issues: [], parentStopped: false, handoffId: 'e'.repeat(64) };
    const publishEvents = () => store.readEvents(fx.repairRunId).filter(item => item.type.startsWith('self_repair.publication_')).map(item => item.type);
    // This fixture's private .git storage was deliberately tampered with above (GIT2-15), so its live-candidate hook checks the
    // exact branch, commit and tree; the installed E2E runs the production verifyP5GitCandidateCurrent hook.
    const verifyCurrent = async () => assert.equal(managedGit(['rev-parse', repairRef]).trim(), candidateCommit);
    const publish = (handoffRef, extra = {}) => publishP5GitCandidate({ store, repairRunId: fx.repairRunId, handoffRef, gitTool,
      eligibility: liveEligibility, appendEvent: event => store.appendEvents(fx.repairRunId, [event]), verifyCurrent, ...extra });
    const enrollmentWith = (gitSource, publication) => ref(store.putJson({ ...fx.enrollment, gitSource: { ...fx.enrollment.gitSource, ...gitSource,
      publication: { ...fx.enrollment.gitSource.publication, ...publication } } }));
    await assert.rejects(publish(tryHandoff(ref(fx.enrollmentArtifact))), { code: 'p5_publication_refused' }, 'publication needs the Owner-granted policy');
    await assert.rejects(publish(tryHandoff(enrollmentWith({}, { enabled: true, remoteId: 'another-remote' }))), /remote_not_authorized/);
    for (const stale of [{ stage: 'invalidated' }, { parentStopped: true }, { issues: ['handoff_mismatch'] }, { handoffId: 'd'.repeat(64) }])
      await assert.rejects(publishP5GitCandidate({ store, repairRunId: fx.repairRunId, handoffRef: tryHandoff(enabled), gitTool,
        eligibility: { ...liveEligibility, ...stale }, appendEvent: event => store.appendEvents(fx.repairRunId, [event]), verifyCurrent }), /handoff_not_current/,
      `an invalidated, stopped or stale handoff never publishes: ${JSON.stringify(stale)}`);
    // A remote whose repair ref already names another commit is a conflict, never overwritten.
    const conflictRemote = join(scratch.root, 'conflict.git');
    git(scratch.root, ['clone', '--quiet', '--bare', remoteRoot, conflictRemote]);
    git(conflictRemote, ['update-ref', repairRef, movedCommit]);
    const conflictUrl = pathToFileURL(conflictRemote).href;
    const conflictHandoff = tryHandoff(enrollmentWith({ remote: { ...fx.enrollment.gitSource.remote, url: conflictUrl } }, { enabled: true }));
    assert.deepEqual(publishEvents(), [], 'refused publications journal no intent');
    const conflicted = await publish(conflictHandoff);
    assert.equal(conflicted.status, 'conflict'); assert.equal(conflicted.pushed, false); assert.equal(conflicted.remoteObjectId, movedCommit);
    assert.equal(git(conflictRemote, ['rev-parse', repairRef]).trim(), movedCommit, 'the conflicting remote ref is retained');
    await assert.rejects(publish(conflictHandoff), { code: 'p5_publication_conflict' }, 'a recorded conflict on this remote is final');
    const executor = (handoffRef, currentEligibility, extra = {}) => executeP5GitPublication({ store, repairRunId: fx.repairRunId, handoffRef, gitTool,
      currentEligibility, appendEvent: event => store.appendEvents(fx.repairRunId, [event]), verifyCurrent, ...extra });
    const request = handoffRef => requestP5GitPublication({ store, repairRunId: fx.repairRunId, handoffRef, gitTool,
      eligibility: liveEligibility, appendEvent: event => store.appendEvents(fx.repairRunId, [event]), verifyCurrent });
    // F9: admission is a durable intent without any network write; Parent Stop that lands before execution prevents the push.
    const stopRemote = join(scratch.root, 'stop.git');
    git(scratch.root, ['clone', '--quiet', '--bare', remoteRoot, stopRemote]);
    const stopHandoff = tryHandoff(enrollmentWith({ remote: { ...fx.enrollment.gitSource.remote, url: pathToFileURL(stopRemote).href } }, { enabled: true }));
    const queued = await request(stopHandoff);
    assert.equal(queued.status, 'intent_recorded'); assert.equal(queued.reconcile, false);
    assert.equal(p5GitPublicationStatus({ store, repairRunId: fx.repairRunId }).state, 'held_uncertain', 'an intent nobody is executing is held');
    assert.equal(p5GitPublicationStatus({ store, repairRunId: fx.repairRunId, executing: true }).state, 'executing');
    const stopped = await executor(stopHandoff, () => ({ ...liveEligibility, parentStopped: true }));
    assert.equal(stopped.status, 'not_published'); assert.equal(stopped.pushed, false); assert.match(stopped.reason, /handoff_not_current/);
    assert.equal(git(stopRemote, ['for-each-ref', '--format=%(refname)', repairRef]).trim(), '', 'nothing was written after the Stop');
    // F9: an Engine crash after the intent and before the push leaves one open intent; a repeated request reuses it, and the
    // executor after restart performs the one write. A connection lost after the remote accepted it is reconciled by reading.
    const publishable = tryHandoff(enabled);
    const first = await request(publishable);
    const again = await request(publishable);
    assert.equal(again.reconcile, true); assert.deepEqual(again.intentRef, first.intentRef, 'a repeated request does not create a second intent');
    await assert.rejects(executor(publishable, () => liveEligibility, { faultAfterPush: () => { throw Object.assign(new Error('connection lost after push'), { code: 'fixture_network_lost' }); } }),
      { code: 'fixture_network_lost' });
    assert.equal(git(remoteRoot, ['rev-parse', repairRef]).trim(), candidateCommit, 'the push itself landed');
    const reconciled = await publish(publishable, { eligibility: { ...liveEligibility, parentStopped: true } });
    assert.equal(reconciled.status, 'published'); assert.equal(reconciled.pushed, false); assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.remoteObjectId, candidateCommit);
    assert.equal(p5GitPublicationStatus({ store, repairRunId: fx.repairRunId }).state, 'published', 'a recorded success survives the later Stop');
    const replay = await publish(publishable);
    assert.equal(replay.replay, true, 'an idempotent replay returns the recorded publication'); assert.equal(replay.commit, candidateCommit);
    assert.equal(replay.currentlyEligible, true);
    assert.deepEqual(publishEvents(), ['self_repair.publication_intent', 'self_repair.publication_recorded', 'self_repair.publication_intent',
      'self_repair.publication_recorded', 'self_repair.publication_intent', 'self_repair.publication_recorded'],
    'conflict, stopped and published intents each settle exactly once; no second write and no duplicate record');
    assert.equal(git(remoteRoot, ['rev-parse', 'refs/heads/main']).trim(), movedCommit, 'main is never updated');
    assert.deepEqual(git(remoteRoot, ['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/).sort(), ['refs/heads/main', repairRef].sort(),
      'exactly one repair ref was created in the permitted namespace');
    t.diagnostic(`publication: ${repairRef} -> ${candidateCommit} (reconciled after an interrupted push)`);
  } finally {
    for (const fixture of fixtures) { try { fixture.close(); } catch { /* best-effort fixture release */ } }
    await host.shutdown();
  }
});
