// P5's native topology boundary is exercised through the real, authenticated Rust Host service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, linkSync, symlinkSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { attachEngine, eventually, newScratch, startCustodyHost } from './custody-support.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { Store } from '../core/store.mjs';
import { canonicalHash } from '../core/canonical.mjs';
import { captureP5EnrollmentFileWithHostIdentity, captureP5VerificationInputs, collectP5GitBaseline, inventoryP5SourceWithHost, materializeP5VerificationOverlay,
  p5VerificationCommandDigest, prepareP5WorkspaceFromIntent, sealP5Candidate, verifyP5EnrollmentFileCurrent, verifyP5GitBaselineCurrent } from '../core/protectedSelfRepair.mjs';
import { makeFailureOutcome } from '../core/failureOutcomes.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('P5 native source identity is Host measured, stable, generation fenced, and rejects hard links', async () => {
  const scratch = newScratch('p5-native-source-identity');
  const slotRoot = ownedDir(join(testsRoot, 'p5-native-slot-'));
  const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: process.execPath, sha256: sha256(readFileSync(process.execPath)) }] });
  try {
    const epoch = await attachEngine(host);
    const sourceRoot = join(scratch.root, 'source-tree');
    mkdirSync(join(sourceRoot, 'src', 'core'), { recursive: true });
    const rootIdentity = await host.request('custody.source_identity', { generation: host.generation, epoch,
      root: sourceRoot, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    assert.equal(rootIdentity.refused, undefined, rootIdentity.message);
    assert.equal(rootIdentity.fileCount, 0);
    assert.equal(rootIdentity.pathDigest, sha256(Buffer.alloc(0)));
    const files = new Map([
      ['README.md', Buffer.from('P5 native source fixture\n')],
      ['src/core/engine.mjs', Buffer.from('export const boundary = "host";\n')],
      ['src/core/engine.test.mjs', Buffer.from("import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { boundary } from './engine.mjs';\ntest('candidate-value', () => assert.equal(boundary, 'baseline'));\n")],
    ]);
    for (const [path, bytes] of files) {
      const absolute = join(sourceRoot, ...path.split('/'));
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, bytes);
    }
    const paths = [...files.keys()].sort();
    const request = { generation: host.generation, epoch, root: sourceRoot, include: ['**'], exclude: ['.git/**', '.p5/**'],
      maxFiles: 10, maxBytes: 4096, expectedPathsDigest: sha256(Buffer.from(paths.map(path => `${path}\0`).join(''))) };
    const first = await host.request('custody.source_identity', request);
    assert.equal(first.refused, undefined, first.message);
    assert.equal(first.fileCount, files.size);
    assert.equal(first.totalBytes, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.match(first.canonicalRoot, /^[A-Za-z]:\\/);
    assert.match(first.rootIdentity.volumeId, /^[a-f0-9]{8}$/);
    assert.match(first.rootIdentity.fileId, /^[a-f0-9]{16}$/);
    assert.equal(first.pathDigest, request.expectedPathsDigest);
    assert.match(first.snapshotDigest, /^[a-f0-9]{64}$/);
    assert.equal(first.generation, host.generation);
    assert.equal(first.epoch, epoch);

    const second = await host.request('custody.source_identity', request);
    assert.equal(second.snapshotDigest, first.snapshotDigest);
    assert.deepEqual(second.rootIdentity, first.rootIdentity);
    assert.deepEqual(second.rootIdentity, rootIdentity.rootIdentity);

    const pathGit = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean).trim();
    const gitPath = resolve(dirname(pathGit), '..', 'mingw64', 'bin', 'git.exe');
    assert.ok(existsSync(gitPath), 'the native integration proof needs Git for Windows actual git.exe, not its hard-linked command shim');
    const gitEnvironment = { ...process.env };
    for (const key of Object.keys(gitEnvironment)) if (key.toUpperCase().startsWith('GIT_')) delete gitEnvironment[key];
    Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' });
    const git = args => execFileSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.hooksPath=NUL',
      '-c', 'init.templateDir=', '-c', 'commit.gpgsign=false', '-c', 'user.name=P5 Fixture', '-c', 'user.email=p5@example.invalid',
      '-C', sourceRoot, ...args], { cwd: sourceRoot, env: gitEnvironment, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['add', '--', 'README.md', 'src/core/engine.mjs', 'src/core/engine.test.mjs']);
    git(['commit', '--quiet', '-m', 'P5 native source fixture']);
    const commonDirectory = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const common = await host.request('custody.source_identity', { generation: host.generation, epoch,
      root: commonDirectory, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    assert.equal(common.refused, undefined, common.message);

    const store = new Store(scratch.root);
    try {
      const enrollmentId = randomUUID();
      const repositoryIdentity = { enrollmentId, canonicalCommonDirectory: common.canonicalRoot, nativeDirectoryIdentity: common.rootIdentity };
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      const runningReleaseValue = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'a'.repeat(32),
        buildId: 'fixture-build', bootstrap: 'runtime', packageSha256: 'b'.repeat(64), sourceCommit: baseCommit,
        sourceDigest: 'c'.repeat(64), inputsDigest: 'd'.repeat(64) };
      const runningSourceRelease = store.putJson(runningReleaseValue);
      const nativeSourceReader = request => host.request('custody.source_identity', {
        generation: host.generation, epoch, ...request,
      });
      const nativeToolIdentityReader = request => host.request('custody.tool_identity', {
        generation: host.generation, epoch, ...request,
      });
      const managedProfile = join(scratch.root, 'native-managed-profile');
      const enrollmentPath = join(managedProfile, 'p5', 'enrollment.json');
      mkdirSync(dirname(enrollmentPath), { recursive: true });
      const enrollmentBytes = Buffer.from('{"fixture":"native-file-capture"}\n');
      writeFileSync(enrollmentPath, enrollmentBytes);
      const capturedEnrollmentFile = await captureP5EnrollmentFileWithHostIdentity({ profileRoot: managedProfile, nativeSourceReader,
        expectedHostPid: host.pid, expectedGeneration: host.generation, expectedEpoch: epoch });
      assert.deepEqual(capturedEnrollmentFile.bytes, enrollmentBytes);
      assert.equal(capturedEnrollmentFile.byteSize, enrollmentBytes.length);
      assert.equal(capturedEnrollmentFile.fileSha256, sha256(enrollmentBytes));
      assert.equal(capturedEnrollmentFile.nativeEvidence.hostPid, host.pid);
      assert.equal(capturedEnrollmentFile.nativeEvidence.generation, host.generation);
      assert.equal(capturedEnrollmentFile.nativeEvidence.epoch, epoch);
      const fixtureEnrollmentValue = JSON.parse(enrollmentBytes.toString('utf8'));
      const currentEnrollmentValue = await verifyP5EnrollmentFileCurrent({ profileRoot: managedProfile, path: enrollmentPath,
        fileSha256: capturedEnrollmentFile.fileSha256, enrollmentDigest: canonicalHash(fixtureEnrollmentValue), nativeSourceReader,
        expectedHostPid: host.pid, expectedGeneration: host.generation, expectedEpoch: epoch });
      assert.deepEqual(currentEnrollmentValue, fixtureEnrollmentValue);
      await assert.rejects(verifyP5EnrollmentFileCurrent({ profileRoot: managedProfile, path: enrollmentPath,
        fileSha256: capturedEnrollmentFile.fileSha256, enrollmentDigest: canonicalHash(fixtureEnrollmentValue), nativeSourceReader,
        expectedHostPid: host.pid, expectedGeneration: 'stale-generation', expectedEpoch: epoch }),
      { code: 'p5_enrollment_changed' }, 'the enrollment check rejects a scan returned for another Lifecycle generation');
      const enrollmentHardLink = join(scratch.root, 'enrollment-hard-link.json');
      linkSync(enrollmentPath, enrollmentHardLink);
      try {
        await assert.rejects(captureP5EnrollmentFileWithHostIdentity({ profileRoot: managedProfile, nativeSourceReader,
          expectedHostPid: host.pid, expectedGeneration: host.generation, expectedEpoch: epoch }),
          { code: 'p5_native_identity_unavailable' }, 'the Rust Host refuses a multiply linked installed enrollment file');
      } finally {
        unlinkSync(enrollmentHardLink);
      }
      const hostInventory = await inventoryP5SourceWithHost(sourceRoot, { include: ['src/**'], exclude: ['.git/**', '.p5/**'],
        maxFiles: 10, maxBytes: 4096, executableFor: () => false, nativeSourceReader });
      assert.equal(hostInventory.entries.length, 2);
      assert.equal(hostInventory.entries.find(entry => entry.path === 'src/core/engine.mjs').sha256, sha256(files.get('src/core/engine.mjs')));
      assert.equal(hostInventory.nativeEvidence.contentDigest.length, 64);
      const nativeGit = await nativeToolIdentityReader({ path: gitPath });
      assert.equal(nativeGit.refused, undefined, nativeGit.message);
      assert.equal(nativeGit.canonicalPath.toLowerCase(), gitPath.toLowerCase());
      assert.ok(nativeGit.linkCount >= 1);
      const linkedGitPath = join(scratch.root, 'git-hard-link.exe');
      linkSync(gitPath, linkedGitPath);
      try {
        const linkedGit = await nativeToolIdentityReader({ path: linkedGitPath });
        assert.equal(linkedGit.refused, undefined, linkedGit.message);
        assert.equal(linkedGit.linkCount, nativeGit.linkCount + 1);
        assert.deepEqual(linkedGit.identity, nativeGit.identity);
      } finally {
        unlinkSync(linkedGitPath);
      }
      const nativeGitAfterLinkRemoval = await nativeToolIdentityReader({ path: gitPath });
      assert.equal(nativeGitAfterLinkRemoval.linkCount, nativeGit.linkCount);
      const captureArgs = { store, repositoryRoot: sourceRoot,
        gitTool: { path: gitPath, sha256: sha256(readFileSync(gitPath)) }, repositoryIdentity, enrollmentId, runningSourceRelease,
        pathPolicy: { include: ['src/**'], exclude: ['.git/**', '.p5/**'], secretPaths: [] },
        budgets: { maxSourceFiles: 10, maxSourceBytes: 4096 }, expectedCommit: baseCommit, nativeSourceReader, nativeToolIdentityReader };
      const baseline = await collectP5GitBaseline(captureArgs);
      assert.equal(baseline.baseCommit, baseCommit);
      assert.equal(baseline.entries.length, 2);
      assert.deepEqual(baseline.entries.map(entry => entry.path), ['src/core/engine.mjs', 'src/core/engine.test.mjs']);
      assert.equal(baseline.entries[0].sha256, sha256(files.get('src/core/engine.mjs')));
      assert.equal(baseline.dirtyState.trackedClean, true);
      assert.equal(baseline.dirtyState.nativeHostIdentity.hostPid, host.pid);
      store.verifyRef(baseline.baselineManifest);
      store.verifyRef(baseline.sourceManifest);
      const artifactCount = store.get('SELECT COUNT(*) AS count FROM artifacts').count;
      const readOnlyRecheck = await collectP5GitBaseline({ ...captureArgs, expectedRepositoryRoot: sourceRoot, persist: false });
      assert.equal(readOnlyRecheck.baselineId, baseline.baselineId);
      assert.equal(readOnlyRecheck.sourceDigest, baseline.sourceDigest);
      assert.equal(store.get('SELECT COUNT(*) AS count FROM artifacts').count, artifactCount,
        'a live source recheck must not replace or append to the enrolled immutable baseline');

      const scope = { add: ['src/**'], modify: ['src/**'], delete: ['src/**'], executable: [], denied: [], sensitiveCategories: [] };
      const verifyScratch = join(scratch.root, 'verify-scratch'), installedControl = join(scratch.root, 'installed-control');
      mkdirSync(verifyScratch); mkdirSync(installedControl);
      const verificationEnvironment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
        TEMP: verifyScratch, TMP: verifyScratch }).filter(([, value]) => typeof value === 'string'));
      const verificationPolicy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
        requiredStages: ['unit'], requiredCheckIds: ['unit-check'], optionalCheckIds: [], harnessClosureDigest: '1'.repeat(64),
        incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8,
          maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
        checks: [{ checkId: 'unit-check', stageId: 'unit', required: true, executable: process.execPath,
          executableSha256: sha256(readFileSync(process.execPath)),
          argv: ['--test-reporter=junit', '--test', 'src/core/engine.test.mjs'], cwd: 'candidate-execution-tree', inputRefs: [],
          environment: verificationEnvironment, subjectEntryPoints: ['src/core/engine.mjs'], expectedAssertions: ['candidate-value'],
          expectedExitCodes: [0], timeoutSeconds: 60, maxOutputBytes: 4096, subjectBinding: 'protected-overlay',
          overlayPaths: ['src/core/engine.test.mjs'] }],
        verificationRetries: 0, aggregateTimeoutSeconds: 120 };
      verificationPolicy.checks[0].commandDigest = p5VerificationCommandDigest(verificationPolicy.checks[0]);
      const policyRef = store.putJson(verificationPolicy);
      const slotIdentity = await host.request('custody.source_identity', { generation: host.generation, epoch,
        root: slotRoot, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
      assert.equal(slotIdentity.refused, undefined, slotIdentity.message);
      const workspace = { workspaceId: 'p5-slot', canonicalRoot: slotIdentity.canonicalRoot, allocationId: randomUUID(),
        nativeIdentity: slotIdentity.rootIdentity };
      const repairPublication = { workflowId: 'p5-repair', publishedVersionId: randomUUID(), version: 1, snapshotSha256: policyRef.sha256 };
      const profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity,
        baselineId: baseline.baselineId, baseline: baseline.baselineManifest,
        runningSourceRelease: { artifactId: runningSourceRelease.artifactId, sha256: runningSourceRelease.sha256 },
        repairPublication, developerNodeId: 'developer', verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
        workspace: { workspaceId: workspace.workspaceId, allocationId: workspace.allocationId, canonicalRoot: workspace.canonicalRoot,
          singleUse: true, cleanCommitted: true },
        scope, verificationPolicy: { artifactId: policyRef.artifactId, sha256: policyRef.sha256 }, requiredCheckIds: ['unit-check'],
        eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'provider-unavailable' }], failedNodeRetry: 'never',
        acceptanceMode: 'judge_post_execution', budgets: { maxSourceFiles: 10, maxSourceBytes: 4096,
          developerTimeoutSeconds: 60, verificationTimeoutSeconds: 60, maxCheckOutputBytes: 4096,
          verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 } };
      const profileRef = store.putJson(profile);
      const parentPublication = { workflowId: 'p5-parent', publishedVersionId: randomUUID(), version: 1, snapshotSha256: profileRef.sha256 };
      const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
        gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree,
        pathPolicyDigest: baseline.pathPolicyDigest, effectiveSourceDigest: baseline.sourceDigest, baselineId: baseline.baselineId,
        baselineManifest: baseline.baselineManifest, runningSourceRelease: { artifactId: runningSourceRelease.artifactId, sha256: runningSourceRelease.sha256 },
        parentPublication, profile: { artifactId: profileRef.artifactId, sha256: profileRef.sha256 }, repairPublication, workspace,
        verificationPolicy: { artifactId: policyRef.artifactId, sha256: policyRef.sha256 }, harnessClosureDigest: '1'.repeat(64),
        toolIdentities: [{ name: 'git', path: gitPath, sha256: captureArgs.gitTool.sha256 }], scope,
        budgets: { maxSourceFiles: 10, maxSourceBytes: 4096, developerTimeoutSeconds: 60, verificationTimeoutSeconds: 60,
          maxCheckOutputBytes: 4096, verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 },
        minimumReaderCapability: 'protected-self-repair-v1' };
      const verifiedEnrolledBaseline = await verifyP5GitBaselineCurrent({ store, enrollment,
        currentRunningSourceRelease: runningReleaseValue, nativeSourceReader, nativeToolIdentityReader });
      assert.equal(verifiedEnrolledBaseline.baselineId, baseline.baselineId);
      assert.equal(store.get('SELECT COUNT(*) AS count FROM artifacts').count, artifactCount + 2,
        'baseline revalidation reads the installed enrollment and adds no baseline/source objects');

      const parentRunId = randomUUID();
      const sourceBinding = store.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId,
        parentRunId, parentPublication, parentSnapshot: { artifactId: profileRef.artifactId, sha256: profileRef.sha256 },
        baselineId: baseline.baselineId, baselineManifest: baseline.baselineManifest, profile: enrollment.profile,
        runningSourceRelease: enrollment.runningSourceRelease, runtimeInstanceId: randomUUID(), lifecycleGeneration: randomUUID(),
        boundAt: new Date().toISOString() });
      const enrollmentArtifact = store.putJson(enrollment);
      const repairRunId = randomUUID();
      const repairSnapshot = policyRef;
      const settings = store.putJson({ schemaVersion: 1, fixture: 'P5 workspace preparation' });
      const at = new Date().toISOString();
      store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        repairPublication.workflowId, repairSnapshot.artifactId, at, at);
      const repairDefinitionDigest = 'b'.repeat(64);
      store.run(`INSERT INTO workflow_publications(id, workflow_id, version, snapshot_artifact_id, definition_digest,
        execution_hash, authority_policy_version, provenance, runnable, validation_json, source_draft_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'workflow-publication/1', 'owner-publication', 1, '{}', NULL, ?)`,
      repairPublication.publishedVersionId, repairPublication.workflowId, repairPublication.version, repairSnapshot.artifactId,
      repairDefinitionDigest, 'c'.repeat(64), at);
      store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        enrollment.workspace.workspaceId, slotRoot, sha256(Buffer.from(slotRoot)), at, at);
      store.run(`INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id,
        execution_hash, state, last_sequence, created_at, journal_version, kind, published_version_id, definition_digest)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, 2, 'workflow', ?, ?)`, repairRunId, repairPublication.workflowId,
      enrollment.workspace.workspaceId, repairSnapshot.artifactId, settings.artifactId, 'a'.repeat(64), at,
      repairPublication.publishedVersionId, repairDefinitionDigest);
      const parentWorkspaceId = 'p5-parent-slot';
      const parentRoot = join(scratch.root, 'parent-workspace');
      mkdirSync(parentRoot);
      store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        parentPublication.workflowId, profileRef.artifactId, at, at);
      store.run(`INSERT INTO workflow_publications(id, workflow_id, version, snapshot_artifact_id, definition_digest,
        execution_hash, authority_policy_version, provenance, runnable, validation_json, source_draft_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'workflow-publication/1', 'owner-publication', 1, '{}', NULL, ?)`,
      parentPublication.publishedVersionId, parentPublication.workflowId, parentPublication.version,
      profileRef.artifactId, 'd'.repeat(64), 'e'.repeat(64), at);
      store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        parentWorkspaceId, parentRoot, sha256(Buffer.from(parentRoot)), at, at);
      store.run(`INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id,
        execution_hash, state, last_sequence, created_at, journal_version, kind, published_version_id, definition_digest)
        VALUES (?, ?, ?, ?, ?, ?, 'waiting_for_user', 0, ?, 2, 'workflow', ?, ?)`, parentRunId, parentPublication.workflowId,
      parentWorkspaceId, profileRef.artifactId, settings.artifactId, 'e'.repeat(64), at, parentPublication.publishedVersionId, 'd'.repeat(64));
      store.run('INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, ?)',
        parentRunId, 'failed-node', 'failed-node', 'agent', 'failed');
      const outcomeId = randomUUID();
      store.run('INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, 1, ?)',
        outcomeId, parentRunId, 'failed-node', 'failed');
      const incidentId = randomUUID();
      const p3Evidence = store.putText('bounded P3 incident evidence');
      const parentRun = store.get('SELECT * FROM runs WHERE id = ?', parentRunId);
      const outcome = makeFailureOutcome({ run: parentRun, attempt: { id: outcomeId, node_instance_id: 'failed-node', state: 'failed' },
        source: 'provider', code: 'provider_unavailable', attemptState: 'failed', runState: 'waiting_for_user',
        executionCertainty: 'completed', sideEffectCertainty: 'none_proven', causeKnowledge: 'direct_fact',
        evidenceReferences: [{ type: 'artifact', id: p3Evidence.artifactId, sha256: p3Evidence.sha256 }], recordedAt: at });
      store.appendEvents(parentRunId, [{ type: 'attempt.failure_outcome', payload: { outcome }, nodeInstanceId: 'failed-node', attemptId: outcomeId }]);
      const capturedVerificationInputs = captureP5VerificationInputs({ store, enrollment, profile, parentRunId, incidentId, outcome });
      assert.equal(capturedVerificationInputs.record.outcomeId, outcomeId);
      assert.equal(capturedVerificationInputs.record.inputs.length, 1);
      assert.throws(() => captureP5VerificationInputs({ store, enrollment, profile, parentRunId, incidentId,
        outcome: { ...outcome, evidenceReferences: [] } }), { code: 'p5_verification_input_stale' },
      'P5 does not accept caller-supplied evidence that differs from the current durable P3 outcome');
      assert.throws(() => captureP5VerificationInputs({ store, enrollment, profile, parentRunId: randomUUID(), incidentId, outcome }),
        { code: 'p5_verification_input_stale' }, 'P5 does not accept an outcome from a different Parent Run');
      store.appendEvents(parentRunId, [{ type: 'self_repair.source_bound', payload: { record: { artifactId: sourceBinding.artifactId, sha256: sourceBinding.sha256 } } }]);
      const p2Authorization = store.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy',
        incidentId, parentRunId, repairRunId, parentPublishedVersionId: parentPublication.publishedVersionId,
        parentSnapshotSha256: parentPublication.snapshotSha256, repairWorkflowId: repairPublication.workflowId,
        repairPublishedVersionId: repairPublication.publishedVersionId, repairSnapshotSha256: repairPublication.snapshotSha256,
        repairWorkspaceId: enrollment.workspace.workspaceId, failedNodeInstanceId: 'failed-node',
        repairResultNodeInstanceId: 'repair-result', expectedRepairResultSha256: null, failedNodeRetry: 'never',
        selfRepairProfile: enrollment.profile,
        p5Enrollment: { artifactId: enrollmentArtifact.artifactId, sha256: enrollmentArtifact.sha256 },
        p5SourceBinding: { artifactId: sourceBinding.artifactId, sha256: sourceBinding.sha256 },
        verificationInputs: capturedVerificationInputs.artifact, outcomeId, outcomeRevision: outcome.revision });
      const checkpoint = store.putJson({ fixture: 'P5 checkpoint' });
      const linkId = randomUUID();
      store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
        resume_node_instance_id, checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state,
        decision_status, authorization_artifact_id, repair_result_node_instance_id, failed_node_retry, acceptance_mode,
        created_at, updated_at)
        VALUES (?, 'linked_repair', ?, ?, ?, ?, 'failed-node', ?, 'open', 'logical_policy', ?, 'suspended_for_repair',
        'pending', ?, 'repair-result', 'never', 'judge_post_execution', ?, ?)`, linkId, parentRunId, repairRunId,
      parentWorkspaceId, enrollment.workspace.workspaceId, checkpoint.artifactId, incidentId, p2Authorization.artifactId, at, at);
      const intent = store.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent',
        enrollment: { artifactId: enrollmentArtifact.artifactId, sha256: enrollmentArtifact.sha256 },
        baselineManifest: baseline.baselineManifest, sourceManifest: baseline.sourceManifest,
        sourceBinding: { artifactId: sourceBinding.artifactId, sha256: sourceBinding.sha256 }, verificationInputs: capturedVerificationInputs.artifact, parentRunId,
        repairRunId, linkId, workspace: enrollment.workspace, createdAt: at });
      store.appendEvents(repairRunId, [{ type: 'self_repair.preparation_intent', payload: { record: { artifactId: intent.artifactId, sha256: intent.sha256 } } }]);
      const unjournaledIntent = store.putJson({ ...store.readJson(intent.artifactId), linkId: randomUUID() });
      await assert.rejects(prepareP5WorkspaceFromIntent({ store,
        intentRef: { artifactId: unjournaledIntent.artifactId, sha256: unjournaledIntent.sha256 }, nativeSourceReader }),
      { code: 'p5_preparation_intent_missing' });
      assert.equal(existsSync(join(slotRoot, 'source')), false, 'P5 must not materialize before the matching intent event is durable');
      const prepared = await prepareP5WorkspaceFromIntent({ store, intentRef: { artifactId: intent.artifactId, sha256: intent.sha256 }, nativeSourceReader });
      assert.equal(prepared.evidence.sourceDigest, baseline.sourceDigest);
      assert.equal(prepared.evidence.fileCount, baseline.entries.length);
      assert.equal(prepared.evidence.hostPid, host.pid);
      assert.deepEqual(prepared.inventory.entries, baseline.entries);
      store.verifyRef(prepared.evidenceArtifact);
      const recoveredPreparation = await prepareP5WorkspaceFromIntent({ store,
        intentRef: { artifactId: intent.artifactId, sha256: intent.sha256 }, nativeSourceReader, recovery: true });
      assert.equal(recoveredPreparation.evidence.sourceDigest, baseline.sourceDigest);
      assert.deepEqual(recoveredPreparation.inventory.entries, baseline.entries);
      const baselineFile = join(slotRoot, 'source', 'src', 'core', 'engine.mjs');
      unlinkSync(baselineFile);
      await assert.rejects(prepareP5WorkspaceFromIntent({ store,
        intentRef: { artifactId: intent.artifactId, sha256: intent.sha256 }, nativeSourceReader }),
      { code: 'p5_workspace_conflict' });
      const resumedPreparation = await prepareP5WorkspaceFromIntent({ store,
        intentRef: { artifactId: intent.artifactId, sha256: intent.sha256 }, nativeSourceReader, recovery: true });
      assert.equal(readFileSync(baselineFile).toString(), files.get('src/core/engine.mjs').toString());
      assert.deepEqual(resumedPreparation.inventory.entries, baseline.entries);
      writeFileSync(join(slotRoot, 'source', 'unexpected.mjs'), 'export const unexpected = true;\n');
      await assert.rejects(prepareP5WorkspaceFromIntent({ store,
        intentRef: { artifactId: intent.artifactId, sha256: intent.sha256 }, nativeSourceReader, recovery: true }),
      { code: 'p5_workspace_conflict' });

      const candidateSourceRoot = join(slotRoot, 'source');
      writeFileSync(join(candidateSourceRoot, 'src', 'core', 'engine.mjs'), 'export const boundary = "candidate";\n');
      writeFileSync(join(candidateSourceRoot, 'src', 'core', 'engine.test.mjs'),
        "import test from 'node:test'; test('candidate-edited-test', () => {});\n");
      const developerAttemptId = randomUUID();
      const developerTerminal = store.putJson({ attemptId: developerAttemptId, processTreeEnded: true, spoolComplete: true,
        status: 'exited', exitCode: 0 });
      const candidateAuthorization = { incidentId, parentRunId, repairRunId, linkId, outcomeId, outcomeRevision: outcome.revision,
        developerAttemptId, developerNodeId: 'developer', parentPublication, repairPublication, workspace: enrollment.workspace,
        enrollment: enrollmentArtifact, selfRepairProfile: enrollment.profile, verificationPolicy: enrollment.verificationPolicy,
        verificationInputs: capturedVerificationInputs.artifact, sourceBinding, developerTerminal: { artifact: developerTerminal,
          attemptId: developerAttemptId, processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 },
        scope, capturedAt: new Date().toISOString(), journalCursor: 1 };
      const baselineSourceRecord = store.readJson(baseline.sourceManifest.artifactId);
      const sealBaseline = { ...baseline, contentRefs: new Map(baselineSourceRecord.entries.map(entry => [entry.path, entry.artifact])) };
      const sealedCandidate = await sealP5Candidate({ store, sourceRoot: candidateSourceRoot, baseline: sealBaseline, authorization: candidateAuthorization,
        budgets: enrollment.budgets, nativeSourceReader });
      assert.equal(sealedCandidate.candidate.candidateSourceDigest, sealedCandidate.sourceManifest.sourceDigest);
      assert.deepEqual(sealedCandidate.changeManifest.changes.map(change => change.path),
        ['src/core/engine.mjs', 'src/core/engine.test.mjs']);

      const overlayRoot = join(slotRoot, '.p5', 'verify', 'execution', verificationPolicy.checks[0].checkId);
      const partialCandidateEntry = sealedCandidate.sourceManifest.entries.find(entry => entry.path === 'src/core/engine.mjs');
      assert.ok(partialCandidateEntry, 'the candidate source manifest contains the production module used for the partial materialization');
      mkdirSync(join(overlayRoot, 'src', 'core'), { recursive: true });
      writeFileSync(join(overlayRoot, 'src', 'core', 'engine.mjs'), store.readBytes(partialCandidateEntry.artifact.artifactId).bytes);
      await assert.rejects(() => materializeP5VerificationOverlay({ store, candidateRef: sealedCandidate.candidateArtifact,
        check: verificationPolicy.checks[0], budgets: enrollment.budgets, nativeSourceReader }),
      { code: 'p5_overlay_tree_conflict' }, 'default callers must still refuse any occupied execution slot');
      const incorrectPartialBytes = Buffer.from('untrusted partial bytes\n');
      writeFileSync(join(overlayRoot, 'src', 'core', 'engine.mjs'), incorrectPartialBytes);
      await assert.rejects(() => materializeP5VerificationOverlay({ store, candidateRef: sealedCandidate.candidateArtifact,
        check: verificationPolicy.checks[0], budgets: enrollment.budgets, nativeSourceReader, allowPartialReuse: true }),
      { code: 'p5_overlay_tree_conflict' }, 'pre-start reuse rejects a path whose bytes differ from the sealed Store object');
      assert.deepEqual(readFileSync(join(overlayRoot, 'src', 'core', 'engine.mjs')), incorrectPartialBytes,
        'recovery refuses the conflict without overwriting it');
      writeFileSync(join(overlayRoot, 'src', 'core', 'engine.mjs'), store.readBytes(partialCandidateEntry.artifact.artifactId).bytes);
      const materialized = await materializeP5VerificationOverlay({ store, candidateRef: sealedCandidate.candidateArtifact,
        check: verificationPolicy.checks[0], budgets: enrollment.budgets, nativeSourceReader, allowPartialReuse: true });
      assert.equal(materialized.executionTree.nativeEvidence.hostPid, host.pid);
      assert.equal(materialized.executionTree.nativeEvidence.generation, host.generation);
      assert.equal(materialized.executionTree.nativeEvidence.epoch, epoch);
      assert.equal(readFileSync(join(materialized.executionTree.root, 'src', 'core', 'engine.mjs'), 'utf8'),
        'export const boundary = "candidate";\n');
      assert.equal(readFileSync(join(materialized.executionTree.root, 'src', 'core', 'engine.test.mjs'), 'utf8'),
        files.get('src/core/engine.test.mjs').toString(), 'the candidate-edited test is replaced with the exact protected baseline object');
      assert.deepEqual(await inventoryP5SourceWithHost(materialized.executionTree.root, { nativeSourceReader,
        maxFiles: enrollment.budgets.maxSourceFiles, maxBytes: enrollment.budgets.maxSourceBytes,
        include: ['**'], exclude: [], executableFor: () => false }).then(result => result.entries),
      materialized.executionTree.entries, 'pre-start recovery completes the exact Store-derived execution tree');
      const verifierPlan = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierPlan',
        candidateId: sealedCandidate.candidate.candidateId, candidateSourceDigest: sealedCandidate.candidate.candidateSourceDigest,
        baselineId: sealedCandidate.candidate.baselineId, gateAttemptId: randomUUID(), requiredCheckIds: ['unit-check'],
        policy: verificationPolicy, roots: { 'candidate-source': candidateSourceRoot,
          'candidate-execution-tree': materialized.executionTree.root, 'verify-scratch': verifyScratch,
          'installed-control': installedControl }, aggregateTimeoutSeconds: verificationPolicy.aggregateTimeoutSeconds,
        checks: verificationPolicy.checks };
      const gateAttemptId = verifierPlan.gateAttemptId;
      const verifierScript = resolve(import.meta.dirname, '../verification/p5Verifier.mjs');
      const verifierEnvironment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
        TEMP: verifyScratch, TMP: verifyScratch }).filter(([, value]) => typeof value === 'string'));
      const custodyAttemptId = randomUUID(), custodyRunId = randomUUID();
      const invocation = { generation: host.generation, epoch, attemptId: custodyAttemptId, runId: custodyRunId, provider: 'p5-verifier',
        command: process.execPath, args: [verifierScript], cwd: installedControl, env: verifierEnvironment,
        stdinHex: Buffer.from(JSON.stringify(verifierPlan), 'utf8').toString('hex'), deadlineMs: 90_000 };
      const admission = await host.request('custody.reserve', invocation);
      assert.ok(admission.permit, `Rust Host refused the pinned verifier invocation: ${JSON.stringify(admission)}`);
      const launch = await host.request('custody.launch', { generation: host.generation, epoch,
        custodyId: admission.custodyId, permit: admission.permit });
      assert.equal(launch.state, 'running');
      const terminal = await eventually(async () => {
        const status = await host.request('custody.status', { generation: host.generation, epoch, custodyId: admission.custodyId });
        if (status.refused) throw new Error(`Rust Host status refused: ${status.code}`);
        return status.terminal ? status : null;
      }, 'the trusted P5 verifier Custody invocation to terminate', 30_000, 50);
      assert.equal(terminal.custodyId, admission.custodyId);
      assert.equal(terminal.attemptId, custodyAttemptId);
      assert.equal(terminal.runId, custodyRunId);
      assert.equal(terminal.invocationDigest, admission.invocationDigest);
      assert.equal(terminal.executableSha256, sha256(readFileSync(process.execPath)));
      assert.ok(Number.isInteger(terminal.processId) && terminal.processId > 0);
      assert.ok(typeof terminal.processCreationTime === 'number' && Number.isFinite(terminal.processCreationTime) && terminal.processCreationTime > 0);
      assert.equal(terminal.processTreeEnded, true);
      assert.equal(terminal.spoolComplete, true);
      assert.equal(terminal.state, 'exited');
      assert.equal(terminal.exitCode, 0, 'a candidate check failure is captured in the trusted result, not confused with verifier process failure');
      const readCustodyStream = async stream => {
        let offset = 0;
        const chunks = [];
        for (let pages = 0; pages < 128; pages += 1) {
          const page = await host.request('custody.read', { generation: host.generation, epoch, custodyId: admission.custodyId,
            stream, offset, max: 32 * 1024 });
          assert.equal(page.refused, undefined, page.message);
          if (page.nextOffset > offset) {
            chunks.push(Buffer.from(page.dataHex, 'hex'));
            offset = page.nextOffset;
            const ack = await host.request('custody.ack', { generation: host.generation, epoch, custodyId: admission.custodyId, stream, offset });
            assert.equal(ack.refused, undefined, ack.message);
          }
          if (page.eof) return Buffer.concat(chunks);
        }
        throw new Error(`Rust Host ${stream} spool exceeded the bounded page count.`);
      };
      const verifierStdout = await readCustodyStream('stdout');
      const verifierStderr = await readCustodyStream('stderr');
      const verifierResult = JSON.parse(verifierStdout.toString('utf8'));
      assert.equal(verifierStderr.length, 0);
      assert.equal(verifierResult.gateAttemptId, gateAttemptId);
      assert.equal(verifierResult.status, 'failed');
      assert.equal(verifierResult.checks[0].status, 'failed');
      assert.deepEqual(verifierResult.checks[0].completedAssertions, []);
      assert.match(Buffer.from(verifierResult.checks[0].stdoutBase64, 'base64').toString('utf8'), /<failure/);

      const untracked = join(sourceRoot, 'src', 'core', 'untracked.mjs');
      writeFileSync(untracked, 'export const untracked = true;\n');
      await assert.rejects(collectP5GitBaseline(captureArgs), { code: 'p5_source_dirty' });
      unlinkSync(untracked);
      const tracked = join(sourceRoot, 'src', 'core', 'engine.mjs');
      writeFileSync(tracked, 'export const boundary = "dirty";\n');
      await assert.rejects(collectP5GitBaseline(captureArgs), { code: 'p5_source_dirty' });
      writeFileSync(tracked, files.get('src/core/engine.mjs'));
    } finally {
      store.db.close();
    }

    const stale = await host.request('custody.source_identity', { ...request, generation: 'stale-generation' });
    assert.equal(stale.refused, true);
    assert.equal(stale.code, 'stale_generation');

    const linkedPath = join(sourceRoot, 'src', 'core', 'linked-copy.mjs');
    linkSync(join(sourceRoot, 'src', 'core', 'engine.mjs'), linkedPath);
    const linked = await host.request('custody.source_identity', { ...request, expectedPathsDigest: undefined });
    assert.equal(linked.refused, true);
    assert.equal(linked.code, 'topology_unsupported');

    symlinkSync(join(sourceRoot, 'src', 'core'), join(sourceRoot, 'junction-alias'), 'junction');
    const junction = await host.request('custody.source_identity', { ...request, expectedPathsDigest: undefined });
    assert.equal(junction.refused, true);
    assert.equal(junction.code, 'topology_unsupported');
  } finally {
    await host.shutdown();
    releaseOwnedDir(slotRoot);
  }
});
