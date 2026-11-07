// Test-owned provisioning of one protected installation: the trusted source and Engine A package, the verification policy, the Repair
// and Parent publications, the baseline, and the installed P5 enrollment with an ordered slot pool. Everything here is installation
// setup that an Owner performs once; every P3, P4, P2, Gate, Judge, handoff and P6 record is produced later by the Engine itself.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachEngine, buildArtifacts, newScratch, startCustodyHost } from './custody-support.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { actualGit, api, createTestSourceRepository, gitRunner, profileQuery, runtimeDependencyPackages, sha256 } from './p5-e2e-support.mjs';
import { ENGINE_A, freshDescriptor, installShell, shellRelease, startShellHost } from './p6-g0-support.mjs';
import { packageEngineRelease } from '../../scripts/desktop-release.mjs';
import { Store } from '../core/store.mjs';
import { collectP5GitBaseline, profileWorkspaceOf, validateP5Contract } from '../core/protectedSelfRepair.mjs';
import { installP5Enrollment } from '../core/p5Provisioning.mjs';
import { AUTHORITY_PATH, REPRODUCER_PATH, SUBJECT, genuineSourceFiles, protectedCheck, publish, publicationOf, parentDefinition,
  repairDefinition, writeProbe } from './p6-genuine-support.mjs';

export const PARENT_WORKSPACE = 'p5-parent';
export const PARENT_WORKSPACE_TWO = 'p5-parent-2';
export const SLOT_WORKSPACES = ['p5-slot-1', 'p5-slot-2'];
const ref = value => ({ artifactId: value.artifactId, sha256: value.sha256 });

/**
 * Provisions one protected release. The installation is installed but the Host is not started: call `admitted(R)` for a Host session.
 * `R.cleanup()` releases every test-owned directory, and the caller releases the scratch root through the test harness.
 */
export async function provisionProtectedRelease({ label }) {
  const { fixtureExe, fixtureSha256 } = buildArtifacts();
  const nodeTool = { path: process.execPath, sha256: sha256(readFileSync(process.execPath)) };
  const gitTool = actualGit(), git = gitRunner(gitTool.path);
  const scratch = newScratch(label);
  const slotRoots = SLOT_WORKSPACES.map(() => ownedDir(join(testsRoot, `${label}-slot-`)));
  const R = { scratch, slotRoots, slotIds: SLOT_WORKSPACES, fixtureExe, nodeTool, gitTool, identityHost: null, host: null, lastHost: null };
  let store = null;
  let engineA;
  try {
    // Source and Engine A: the trusted packager builds the release commit, exactly as the genuine chain does.
    const source = createTestSourceRepository(join(scratch.root, 'source'), gitTool.path,
      { dependencies: await runtimeDependencyPackages(), extraFiles: genuineSourceFiles() });
    const origin = join(scratch.root, 'origin.git');
    git(scratch.root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    git(source.root, ['push', '--quiet', pathToFileURL(origin).href, 'HEAD:refs/heads/main']);
    const installation = join(scratch.root, 'installation'), profile = join(scratch.root, 'profile');
    installShell(installation);
    const shellRecord = JSON.parse(readFileSync(join(installation, 'shell', 'shell.json'), 'utf8'));
    mkdirSync(join(installation, 'versions'), { recursive: true });
    mkdirSync(join(installation, 'staging'), { recursive: true });
    const previousHooks = process.env.DESZO_TEST_FAULT_HOOKS;
    process.env.DESZO_TEST_FAULT_HOOKS = '1';
    try {
      engineA = await packageEngineRelease({ sourceRoot: source.root, gitTool: { path: gitTool.path, sha256: sha256(readFileSync(gitTool.path)) },
        outDir: join(installation, 'versions', ENGINE_A), engineBuildId: ENGINE_A, shell: shellRecord, runtimeResources: shellRelease().resources,
        testFaultHooks: true });
    } finally {
      if (previousHooks === undefined) delete process.env.DESZO_TEST_FAULT_HOOKS;
      else process.env.DESZO_TEST_FAULT_HOOKS = previousHooks;
    }
    const aRoot = join(installation, 'versions', ENGINE_A);
    writeProbe(scratch.fixtureState, nodeTool.path, join(aRoot, 'p5'));
    const fixtureEnv = { PATH: `${dirname(fixtureExe)}${delimiter}${process.env.PATH || ''}`, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState,
      CODEX_HOME: join(scratch.root, 'codex-home') };
    mkdirSync(fixtureEnv.CODEX_HOME, { recursive: true });
    const custody = { allowedExecutables: [{ path: fixtureExe, sha256: fixtureSha256 }, nodeTool] };
    Object.assign(R, { source, origin, installation, profile, aRoot, fixtureEnv, custody, engineA });

    // Owner setup: the verification policy, the workspaces, the Repair publication and the baseline.
    mkdirSync(profile, { recursive: true });
    store = new Store(profile);
    const enrollmentId = randomUUID();
    const checks = [
      protectedCheck({ checkId: 'incident-reproducer', stageId: 'reproduce', path: REPRODUCER_PATH, subjectEntryPoints: [SUBJECT],
        expectedAssertions: ['incident-captured', 'incident-repaired'], environment: {}, nodeTool }),
      protectedCheck({ checkId: 'authority-regression', stageId: 'regression', path: AUTHORITY_PATH, subjectEntryPoints: ['runtime/core/protectedSelfRepair.mjs'],
        expectedAssertions: ['authority-path-guard', 'authority-receipt-identity'], environment: {}, nodeTool }),
    ];
    const requiredCheckIds = checks.map(item => item.checkId);
    const verificationPolicy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1, requiredStages: ['regression', 'reproduce'],
      requiredCheckIds, optionalCheckIds: [], harnessClosureDigest: engineA.inputsDigest,
      incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8, maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
      checks, verificationRetries: 0, aggregateTimeoutSeconds: 400,
      mutationTiers: [{ tierId: 'engine-core', requiredCheckIds: ['incident-reproducer'] }, { tierId: 'repair-authority', requiredCheckIds },
        { tierId: 'engine-custody', requiredCheckIds }],
      causalReproduction: { schemaVersion: 1, checkId: 'incident-reproducer', baselineMustPass: ['incident-captured'], baselineMustFail: ['incident-repaired'] } };
    validateP5Contract('verificationPolicy', verificationPolicy);
    const policyRef = ref(store.putJson(verificationPolicy));
    store.db.close(); store = null;

    const parentWorkspace = join(scratch.root, 'parent-workspace'), parentWorkspaceTwo = join(scratch.root, 'parent-workspace-2');
    mkdirSync(parentWorkspace); mkdirSync(parentWorkspaceTwo);
    R.identityHost = await startCustodyHost(join(scratch.root, 'identity'), { allowedExecutables: custody.allowedExecutables });
    R.host = startFreshHost(R);
    let connection = await connect(R);
    let call = api(connection, connection.firstPartyToken);
    assert.equal((await call('PUT', `/api/v2/workspaces/${PARENT_WORKSPACE}`, { cwd: parentWorkspace })).status, 200);
    assert.equal((await call('PUT', `/api/v2/workspaces/${PARENT_WORKSPACE_TWO}`, { cwd: parentWorkspaceTwo })).status, 200);
    for (const [index, workspaceId] of SLOT_WORKSPACES.entries())
      assert.equal((await call('PUT', `/api/v2/workspaces/${workspaceId}`, { cwd: slotRoots[index] })).status, 200);
    const repairPublication = await publish(call, repairDefinition(`${label}-repair`, policyRef));
    const attested = await call('GET', '/api/v2/installation/source-release');
    assert.equal(attested.status, 200, JSON.stringify(attested.body));
    const attestedRelease = attested.body.release;
    assert.equal(attestedRelease.buildId, ENGINE_A);
    assert.equal(attestedRelease.bootstrap, 'engine');
    await R.host.stop(); R.host = null;

    const epoch = await attachEngine(R.identityHost);
    const readers = {
      nativeSourceReader: request => R.identityHost.request('custody.source_identity', { generation: R.identityHost.generation, epoch, ...request }),
      nativeToolIdentityReader: request => R.identityHost.request('custody.tool_identity', { generation: R.identityHost.generation, epoch, ...request }),
    };
    const common = await readers.nativeSourceReader({ root: join(source.root, '.git'), include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    const slotIdentities = [];
    for (const root of slotRoots) slotIdentities.push(await readers.nativeSourceReader({ root, include: [], exclude: [], maxFiles: 0, maxBytes: 0 }));
    assert.equal(common.refused, undefined, common.message);
    for (const identity of slotIdentities) assert.equal(identity.refused, undefined, identity.message);
    store = new Store(profile);
    const releaseRef = ref(store.putJson(attestedRelease));
    const budgets = { maxSourceFiles: 2000, maxSourceBytes: 64 * 1024 * 1024, developerTimeoutSeconds: 240, verificationTimeoutSeconds: 400,
      maxCheckOutputBytes: 65536, verificationRetries: 0, maxJudgeAttempts: 4, maxEvidenceExpansions: 1 };
    const enrollmentIdentity = { enrollmentId, canonicalCommonDirectory: common.canonicalRoot, nativeDirectoryIdentity: common.rootIdentity };
    const baseline = await collectP5GitBaseline({ store, repositoryRoot: source.root, gitTool, repositoryIdentity: enrollmentIdentity, enrollmentId,
      runningSourceRelease: releaseRef, pathPolicy: { include: ['**'], exclude: ['.git/**', '.p5/**', 'node_modules/**'], secretPaths: [] },
      budgets: { maxSourceFiles: budgets.maxSourceFiles, maxSourceBytes: budgets.maxSourceBytes }, expectedCommit: source.releaseCommit, ...readers });
    const scopeSelectors = ['runtime/**'];
    const scope = { add: scopeSelectors, modify: scopeSelectors, delete: scopeSelectors, executable: [], denied: [], sensitiveCategories: [] };
    const workspacePool = slotIdentities.map((identity, index) => ({ workspaceId: SLOT_WORKSPACES[index], canonicalRoot: identity.canonicalRoot,
      allocationId: randomUUID(), nativeIdentity: identity.rootIdentity }));
    const workspace = workspacePool[0];
    const p5Profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity: enrollmentIdentity, baselineId: baseline.baselineId,
      baseline: baseline.baselineManifest, runningSourceRelease: releaseRef, repairPublication: publicationOf(repairPublication),
      developerNodeId: 'developer', verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
      workspace: profileWorkspaceOf(workspace), scope, verificationPolicy: policyRef, requiredCheckIds,
      eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'process' }], failedNodeRetry: 'never',
      acceptanceMode: 'judge_post_execution', budgets };
    validateP5Contract('profile', p5Profile);
    const profileRef = ref(store.putJson(p5Profile));
    store.db.close(); store = null;

    R.host = startFreshHost(R);
    connection = await connect(R);
    call = api(connection, connection.firstPartyToken);
    const parentPublication = await publish(call, parentDefinition(`${label}-parent`, {
      profileId: 'self-repair', repairWorkflowId: `${label}-repair`, repairPublishedVersion: repairPublication.version,
      repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId: SLOT_WORKSPACES[0], failedNodeInstanceId: 'worker',
      repairResultNodeInstanceId: 'developer', verificationNodeInstanceIds: ['verify'], acceptanceMode: 'judge_post_execution',
      failedNodeRetry: 'never', selfRepair: profileRef }));
    await R.host.stop(); R.host = null;

    store = new Store(profile);
    const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity: enrollmentIdentity,
      gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree, gitCandidatePolicy: 'managed-clone-v1',
      gitSource: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1', sourceRepositoryId: `deszo-${label}`,
        remote: { remoteId: `${label}-origin`, url: pathToFileURL(origin).href, protocol: 'file' }, fetchRefs: ['refs/heads/main'],
        sourceCommit: baseline.baseCommit, sourceTree: baseline.baseTree, objectFormat: baseline.gitObjectFormat,
        releaseSourceDigest: attestedRelease.sourceDigest, credentialPolicy: 'none',
        publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: false, remoteId: `${label}-origin`,
          refNamespace: 'refs/heads/self-repair/', requireExpectedRemoteState: true, allowMerge: false } },
      pathPolicyDigest: baseline.pathPolicyDigest, effectiveSourceDigest: baseline.sourceDigest, baselineId: baseline.baselineId,
      baselineManifest: baseline.baselineManifest, runningSourceRelease: releaseRef, parentPublication: publicationOf(parentPublication),
      profile: profileRef, repairPublication: publicationOf(repairPublication), workspace, workspacePool, verificationPolicy: policyRef,
      harnessClosureDigest: engineA.inputsDigest, toolIdentities: [{ name: 'git', ...gitTool }, { name: 'node', ...nodeTool }], scope, budgets,
      minimumReaderCapability: 'protected-self-repair-v1' };
    installP5Enrollment({ profileRoot: profile, store, enrollment, attestedRelease,
      hostWorkspaceIdentities: Object.fromEntries(workspacePool.map((entry, index) => [entry.workspaceId, slotIdentities[index].rootIdentity])) });
    store.putJson(enrollment);
    store.db.close(); store = null;
    Object.assign(R, { parentWorkspace, parentWorkspaceTwo, parentPublication, enrollment, attestedRelease, releaseRef, profileRef, policyRef });
    return R;
  } catch (error) {
    try { store?.db.close(); } catch { /* the handle was already closed */ }
    await R.host?.stop().catch(() => {});
    await R.identityHost?.shutdown().catch(() => R.identityHost.crash());
    for (const root of slotRoots) releaseOwnedDir(root);
    throw error;
  }
}

/** Starts an admitted Host session: the enrollment is loaded and P5 admission is enabled. The caller stops `session.host`. */
export async function admittedSession(R) {
  R.host = startFreshHost(R);
  const connection = await connect(R);
  const call = api(connection, connection.firstPartyToken);
  const admitted = await call('GET', '/api/v2/installation/source-release');
  assert.equal(admitted.body.protectedSelfRepair.admissionEnabled, true, JSON.stringify(admitted.body.protectedSelfRepair));
  return { host: R.host, call };
}

/**
 * Stops any running Host session, then releases the identity host and every slot directory. It runs whether or not the test's
 * assertions passed, so a failed session cannot leave a Host or a slot behind.
 */
export async function releaseProtectedRelease(R) {
  if (R.host) {
    await R.host.stop().catch(() => {});
    R.host = null;
  }
  await R.identityHost?.shutdown().catch(() => R.identityHost.crash());
  for (const root of R.slotRoots) releaseOwnedDir(root);
}

// Every session connects to a descriptor whose runtime instance differs from the one it superseded (see the genuine chain).
async function connect(R) {
  const value = await freshDescriptor(R.profile, ENGINE_A, R.staleInstance ?? null);
  R.staleInstance = value.runtimeInstanceId;
  return value;
}

function startFreshHost(R) {
  R.lastHost = startShellHost({ root: R.scratch.root, installation: R.installation, profile: R.profile, initialBuildId: ENGINE_A,
    custody: R.custody, env: R.fixtureEnv, testEngineProbe: false });
  return R.lastHost;
}

