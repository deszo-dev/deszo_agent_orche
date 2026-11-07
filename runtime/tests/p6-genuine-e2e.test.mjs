// P6-BUILD-GENUINE-E2E: two consecutive genuine protected Self-Repair cycles, A -> B -> C, through the production P5 workflow, the
// production P6 trigger, the trusted builder and the Rust Lifecycle Host. The test provisions inputs and observes. The Developer
// and Judge are controlled provider responses (test-owned agent CLI fixture); every P3, P4, P2, Gate, Judge, handoff, P6 build,
// Host operation and continuation record is written by the production code. No Owner approval, no manual P6 route, no Git push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachEngine, buildArtifacts, eventually, newScratch, startCustodyHost } from './custody-support.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { actualGit, api, createTestSourceRepository, gitRunner, journal, profileQuery, runtimeDependencyPackages, sha256 } from './p5-e2e-support.mjs';
import { ENGINE_A, activeSelector, freshDescriptor, hostEvents, installShell, lifecycleState, shellRelease, startShellHost } from './p6-g0-support.mjs';
import { packageEngineRelease } from '../../scripts/desktop-release.mjs';
import { Store } from '../core/store.mjs';
import { collectP5GitBaseline, P5_ENROLLMENT_RELATIVE_PATH, profileWorkspaceOf, validateP5Contract } from '../core/protectedSelfRepair.mjs';
import { installP5Enrollment } from '../core/p5Provisioning.mjs';
import { AUTHORITY_PATH, REPRODUCER_PATH, SUBJECT, genuineSourceFiles, protectedCheck, publish, publicationOf, parentDefinition,
  repairDefinition, writeDeveloperPlan, writeProbe } from './p6-genuine-support.mjs';

const ref = value => ({ artifactId: value.artifactId, sha256: value.sha256 });
// The enrolled single-use slot pool: one slot per planned Repair (A → B and B → C) plus one for the release after the last Repair,
// which the successor of C still needs to be continuation-eligible. The Parent publication pins the first slot.
const PARENT_WORKSPACE = 'p5-parent', PARENT_WORKSPACE_TWO = 'p5-parent-2', SLOT_WORKSPACES = ['p5-slot-1', 'p5-slot-2', 'p5-slot-3'];

// The Host's own outcome of one P6 switch. Waiting is bounded per switch and fails at once on a durable hold or rollback.
async function awaitSwitchVerified(installation, count, description) {
  await eventually(() => {
    if (hostEvents(installation).filter(event => event.type === 'engine_switch_verified').length >= count) return true;
    const operation = lifecycleState(installation).engineOperation;
    if (operation?.phase === 'held' || operation?.phase === 'rolled_back')
      throw new Error(`The Host ended the switch in phase ${operation.phase} before ${description}: ${operation.failure}`);
    if (operation?.phase === 'committed' && operation.failure) throw new Error(`The committed switch recorded a failure: ${operation.failure}`);
    return false;
  }, description, 45 * 60_000, 500);
  return hostEvents(installation).filter(event => event.type === 'engine_switch_verified').at(count - 1);
}

// The handoff and its receipt are immutable Store objects. The journal names the handoff by reference only, so the chain reads the
// bytes it names and checks what P5 acceptance produced: a passed verification receipt, the P2 approval and authorization, the Judge
// attempt, the Host provenance and the managed-clone candidate. A presence-only check would pass a handoff without its acceptance.
function artifactJson(profile, ref) {
  const [row] = profileQuery(profile, 'SELECT relative_path, sha256 FROM artifacts WHERE id = ?', ref.artifactId);
  assert.ok(row, `artifact ${ref.artifactId} is recorded`);
  const bytes = readFileSync(join(profile, 'store', row.relative_path));
  assert.equal(sha256(bytes), ref.sha256, `artifact ${ref.artifactId} matches its reference`);
  return JSON.parse(bytes.toString('utf8'));
}

function genuineHandoff(profile, record, label) {
  const handoff = artifactJson(profile, record);
  assert.equal(handoff.kind, 'ProtectedSelfRepairHandoff', `${label} is a P5 handoff`);
  assert.equal(artifactJson(profile, handoff.verificationReceipt).status, 'passed', `${label}: its verification receipt passed`);
  assert.ok(handoff.p2Approval && handoff.p2Authorization, `${label}: the P2 approval and authorization are present`);
  assert.ok(handoff.judgeAttemptId && handoff.hostProvenance, `${label}: the Judge attempt and Host provenance are present`);
  assert.ok(handoff.gitCandidate, `${label}: the candidate names its managed clone`);
  return handoff;
}

// One genuine chain. `exhaustion` runs the same chain with a two-slot pool: A → B takes the first two slots, and the successor of B
// must be refused fail-closed, before any Host staging, because the pool has no third slot.
async function genuineChain(t, { slotCount, exhaustion }) {
  const { fixtureExe, fixtureSha256 } = buildArtifacts();
  const nodeTool = { path: process.execPath, sha256: sha256(readFileSync(process.execPath)) };
  const gitTool = actualGit(), git = gitRunner(gitTool.path);
  const scratch = newScratch('p6-genuine');
  const evidence = { schemaVersion: 1, kind: 'P6BuildGenuineE2EEvidence', phases: {} };
  // Every Owner-facing HTTP call the chain makes goes through `api()`, so this trace sees each one. Calls are labelled by window:
  // `setup` before A -> B, `a_to_c` from B's verified switch until C's verified switch, `after_c` afterwards.
  const ownerActions = [];
  let ownerWindow = 'setup';
  const traced = connection => {
    const call = api(connection, connection.firstPartyToken);
    return async (method, path, body, headers) => {
      const response = await call(method, path, body, headers);
      ownerActions.push({ window: ownerWindow, method, path, status: response.status });
      return response;
    };
  };
  const slotIds = SLOT_WORKSPACES.slice(0, slotCount);
  const slotRoots = slotIds.map(() => ownedDir(join(testsRoot, 'p6-genuine-slot-')));
  let host = null, identityHost = null, lastHost = null;
  try {
    // Source: the current P5 closure plus both installed defects and the protected checks, committed as the release baseline.
    const source = createTestSourceRepository(join(scratch.root, 'source'), gitTool.path,
      { dependencies: await runtimeDependencyPackages(), extraFiles: genuineSourceFiles() });
    const origin = join(scratch.root, 'origin.git');
    git(scratch.root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    git(source.root, ['push', '--quiet', pathToFileURL(origin).href, 'HEAD:refs/heads/main']);
    evidence.source = { releaseCommit: source.releaseCommit, historyRoot: source.historyRoot };

    // Installation: the stable Shell and the Engine A package built from the release commit by the trusted packager.
    const installation = join(scratch.root, 'installation'), profile = join(scratch.root, 'profile');
    installShell(installation);
    const shellRecord = JSON.parse(readFileSync(join(installation, 'shell', 'shell.json'), 'utf8'));
    const runtimeResources = shellRelease().resources;
    mkdirSync(join(installation, 'versions'), { recursive: true });
    mkdirSync(join(installation, 'staging'), { recursive: true });
    const previousHooks = process.env.DESZO_TEST_FAULT_HOOKS;
    process.env.DESZO_TEST_FAULT_HOOKS = '1';
    let engineA;
    try {
      engineA = await packageEngineRelease({ sourceRoot: source.root, gitTool: { path: gitTool.path, sha256: sha256(readFileSync(gitTool.path)) },
        outDir: join(installation, 'versions', ENGINE_A), engineBuildId: ENGINE_A, shell: shellRecord, runtimeResources, testFaultHooks: true });
    } finally {
      if (previousHooks === undefined) delete process.env.DESZO_TEST_FAULT_HOOKS;
      else process.env.DESZO_TEST_FAULT_HOOKS = previousHooks;
    }
    const aRoot = join(installation, 'versions', ENGINE_A);
    evidence.engineA = { buildId: ENGINE_A, sourceCommit: engineA.sourceCommit, sourceDigest: engineA.sourceDigest, inputsDigest: engineA.inputsDigest };

    // Test-owned provider inputs: the Parent worker probes every installed incident and the Developer edits the first defect.
    // The installed Engine's source closure is the P5 support payload (`p5/`); the package root holds only the runner.
    writeProbe(scratch.fixtureState, nodeTool.path, join(aRoot, 'p5'));
    writeDeveloperPlan(scratch.fixtureState, 1);
    const fixtureEnv = { PATH: `${dirname(fixtureExe)}${delimiter}${process.env.PATH || ''}`, CUSTODY_FIXTURE_STATE_DIR: scratch.fixtureState,
      CODEX_HOME: join(scratch.root, 'codex-home') };
    mkdirSync(fixtureEnv.CODEX_HOME, { recursive: true });
    const custody = { allowedExecutables: [{ path: fixtureExe, sha256: fixtureSha256 }, nodeTool] };
    // Every Host session starts a new managed Engine. The previous session's descriptor stays in the profile until replaced, so a
    // session connects only to a descriptor whose runtime instance differs from the one it superseded.
    let staleInstance = null;
    const startHost = () => {
      lastHost = startShellHost({ root: scratch.root, installation, profile, initialBuildId: ENGINE_A, custody, env: fixtureEnv, testEngineProbe: false });
      return lastHost;
    };
    const connectEngine = async () => {
      const value = await freshDescriptor(profile, ENGINE_A, staleInstance);
      staleInstance = value.runtimeInstanceId;
      return value;
    };

    // Owner setup, step 0: the captured verification policy, bound to Engine A's build inputs digest.
    mkdirSync(profile, { recursive: true });
    let store = new Store(profile);
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
      // P5-CLOSURE §6: the production Gate must observe the incident on the installed baseline and its repair on the candidate.
      causalReproduction: { schemaVersion: 1, checkId: 'incident-reproducer', baselineMustPass: ['incident-captured'], baselineMustFail: ['incident-repaired'] } };
    validateP5Contract('verificationPolicy', verificationPolicy);
    const policyRef = ref(store.putJson(verificationPolicy));
    store.db.close(); store = null;

    // Host session 1: workspaces, the Repair publication and the Host's own attestation of the running release.
    // Each incident runs in its own Parent workspace: a Parent waiting for recovery holds its workspace until its owner ends it.
    const parentWorkspace = join(scratch.root, 'parent-workspace'), parentWorkspaceTwo = join(scratch.root, 'parent-workspace-2');
    mkdirSync(parentWorkspace); mkdirSync(parentWorkspaceTwo);
    identityHost = await startCustodyHost(join(scratch.root, 'identity'), { allowedExecutables: custody.allowedExecutables });
    host = startHost();
    let connection = await connectEngine();
    let call = traced(connection);
    assert.equal((await call('PUT', `/api/v2/workspaces/${PARENT_WORKSPACE}`, { cwd: parentWorkspace })).status, 200);
    assert.equal((await call('PUT', `/api/v2/workspaces/${PARENT_WORKSPACE_TWO}`, { cwd: parentWorkspaceTwo })).status, 200);
    for (const [index, workspaceId] of slotIds.entries())
      assert.equal((await call('PUT', `/api/v2/workspaces/${workspaceId}`, { cwd: slotRoots[index] })).status, 200);
    const repairPublication = await publish(call, repairDefinition('p5-genuine-repair', policyRef));
    const attested = await call('GET', '/api/v2/installation/source-release');
    assert.equal(attested.status, 200, JSON.stringify(attested.body));
    const attestedRelease = attested.body.release;
    assert.equal(attestedRelease.buildId, ENGINE_A);
    assert.equal(attestedRelease.bootstrap, 'engine');
    assert.equal(attestedRelease.sourceCommit, source.releaseCommit, 'the Host attests the committed test source');
    assert.equal(attestedRelease.inputsDigest, engineA.inputsDigest);
    assert.equal(attested.body.protectedSelfRepair.admissionEnabled, false, 'no enrollment: P5 admission is closed');
    await host.stop(); host = null;

    // Owner setup, step 1: the enrolled repository and baseline, measured through an authenticated Host identity reader.
    const epoch = await attachEngine(identityHost);
    const readers = {
      nativeSourceReader: request => identityHost.request('custody.source_identity', { generation: identityHost.generation, epoch, ...request }),
      nativeToolIdentityReader: request => identityHost.request('custody.tool_identity', { generation: identityHost.generation, epoch, ...request }),
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
    const repositoryIdentity = { enrollmentId, canonicalCommonDirectory: common.canonicalRoot, nativeDirectoryIdentity: common.rootIdentity };
    const baseline = await collectP5GitBaseline({ store, repositoryRoot: source.root, gitTool, repositoryIdentity, enrollmentId,
      runningSourceRelease: releaseRef, pathPolicy: { include: ['**'], exclude: ['.git/**', '.p5/**', 'node_modules/**'], secretPaths: [] },
      budgets: { maxSourceFiles: budgets.maxSourceFiles, maxSourceBytes: budgets.maxSourceBytes }, expectedCommit: source.releaseCommit, ...readers });
    const scopeSelectors = ['runtime/**'];
    const scope = { add: scopeSelectors, modify: scopeSelectors, delete: scopeSelectors, executable: [], denied: [], sensitiveCategories: [] };
    const workspacePool = slotIdentities.map((identity, index) => ({ workspaceId: slotIds[index], canonicalRoot: identity.canonicalRoot,
      allocationId: randomUUID(), nativeIdentity: identity.rootIdentity }));
    const workspace = workspacePool[0];
    const p5Profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity, baselineId: baseline.baselineId,
      baseline: baseline.baselineManifest, runningSourceRelease: releaseRef, repairPublication: publicationOf(repairPublication),
      developerNodeId: 'developer', verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
      workspace: profileWorkspaceOf(workspace),
      scope, verificationPolicy: policyRef, requiredCheckIds,
      eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'process' }], failedNodeRetry: 'never',
      acceptanceMode: 'judge_post_execution', budgets };
    validateP5Contract('profile', p5Profile);
    const profileRef = ref(store.putJson(p5Profile));
    store.db.close(); store = null;

    // Host session 2: the Parent publication carries exactly one captured Self-Repair profile.
    host = startHost();
    connection = await connectEngine();
    call = traced(connection);
    const parentPublication = await publish(call, parentDefinition('p5-genuine-parent', {
      profileId: 'self-repair', repairWorkflowId: 'p5-genuine-repair', repairPublishedVersion: repairPublication.version,
      repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId: slotIds[0], failedNodeInstanceId: 'worker',
      repairResultNodeInstanceId: 'developer', verificationNodeInstanceIds: ['verify'], acceptanceMode: 'judge_post_execution',
      failedNodeRetry: 'never', selfRepair: profileRef }));
    await host.stop(); host = null;

    // Owner setup, step 2: the complete enrollment, installed once through the installation-owned path.
    store = new Store(profile);
    const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
      gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree, gitCandidatePolicy: 'managed-clone-v1',
      gitSource: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1', sourceRepositoryId: 'deszo-p6-genuine',
        remote: { remoteId: 'p6-genuine-origin', url: pathToFileURL(origin).href, protocol: 'file' }, fetchRefs: ['refs/heads/main'],
        sourceCommit: baseline.baseCommit, sourceTree: baseline.baseTree, objectFormat: baseline.gitObjectFormat,
        releaseSourceDigest: attestedRelease.sourceDigest, credentialPolicy: 'none',
        publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: false, remoteId: 'p6-genuine-origin',
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
    evidence.enrollment = { enrollmentId, baselineId: baseline.baselineId, verificationPolicy: policyRef, runningSourceRelease: releaseRef };
    // The root enrollment file and the enrolled origin's main are the immutable baseline the chain must not change.
    const rootEnrollmentSha256 = sha256(readFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH)));
    const originMainBefore = git(origin, ['rev-parse', 'refs/heads/main']).trim();
    // The window's boundary state: the root enrollment bytes and every ref of the enrolled origin. Nothing in the window may change them.
    const boundary = () => ({ rootEnrollmentSha256: sha256(readFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH))),
      originRefs: git(origin, ['for-each-ref', '--format=%(refname) %(objectname)']).trim() });
    // Closes the Owner-action window. Between A -> B and B -> C the only Owner-facing calls allowed are reads and the Parent incident
    // starts that the chain itself makes (POST /api/v2/runs). Any enrollment, approval, workflow republication, manual lifecycle request
    // or other write fails here, and so does any change to the root enrollment or to the origin's refs.
    const closeWindow = open => {
      const close = boundary();
      const inWindow = ownerActions.filter(action => action.window === 'a_to_c');
      const forbidden = inWindow.filter(action => action.method !== 'GET' && !(action.method === 'POST' && action.path === '/api/v2/runs'));
      evidence.ownerActions = { setupCalls: ownerActions.filter(action => action.window === 'setup').length, window: inWindow, forbidden,
        boundaries: { open, close } };
      assert.deepEqual(forbidden, [], 'no Owner action between A -> B and B -> C');
      assert.equal(close.rootEnrollmentSha256, open.rootEnrollmentSha256, 'the root enrollment is unchanged between A -> B and B -> C');
      assert.equal(close.originRefs, open.originRefs, 'no remote publication between A -> B and B -> C');
      ownerWindow = 'after_c';
    };

    // Host session 3: Engine A admits the Parent incident under its own enrollment.
    host = startHost();
    connection = await connectEngine();
    call = traced(connection);
    const admitted = await call('GET', '/api/v2/installation/source-release');
    assert.equal(admitted.body.protectedSelfRepair.enrollmentLoaded, true, JSON.stringify(admitted.body));
    assert.equal(admitted.body.protectedSelfRepair.admissionEnabled, true, JSON.stringify(admitted.body.protectedSelfRepair));
    t.diagnostic(`Engine A admission: ${JSON.stringify(admitted.body.protectedSelfRepair.decision)}`);

    // Phase A -> B: a Parent incident, a real Repair of incident one, and the production P6 activation of the accepted handoff.
    const started = await call('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
      workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
      definitionDigest: parentPublication.definitionDigest, workspaceId: PARENT_WORKSPACE, requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const parentRunId = started.body.run.runId;
    const link = await eventually(() => profileQuery(profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunId)[0] ?? null,
      'the P2 linked Repair created by the Parent Judge', 600_000, 500);
    const repairRunId = link.repair_run_id;
    // A refused Repair ends the chain at once: its journal names the refusal, so the wait does not run to its deadline. A Parent
    // whose failed node is not authorized for retry stays suspended after an approved Repair (failedNodeRetry 'never'); that is
    // not a refusal of the Repair, so the wait only fails on a blocked resumption that precedes the Repair's approval.
    const handoff = await eventually(() => {
      const repairEvents = journal(profile, repairRunId);
      const approved = repairEvents.some(item => item.type === 'repair.approval_recorded');
      const refusal = [...journal(profile, parentRunId), ...repairEvents].find(item => ['continuation.repair_failed', 'self_repair.candidate_invalidated'].includes(item.type)
        || (item.type === 'continuation.parent_resumption_blocked' && !approved));
      if (refusal) throw new Error(`The Repair of handoff B was refused: ${JSON.stringify(refusal)}`);
      return repairEvents.find(item => item.type === 'self_repair.handoff_recorded') ?? null;
    }, 'the genuine P5 handoff of candidate B', 45 * 60_000, 1000);
    evidence.phases.aToB = { parentRunId, linkId: link.id, repairRunId, handoffSequence: handoff.sequence };
    t.diagnostic(`A->B genuine handoff ${JSON.stringify(handoff.payload.record)} for Repair ${repairRunId}`);
    const handoffA = genuineHandoff(profile, handoff.payload.record, 'the A -> B handoff');
    evidence.phases.aToB.handoff = { record: handoff.payload.record, candidateId: handoffA.candidateId, gitCandidate: handoffA.gitCandidate };
    const switched = await awaitSwitchVerified(installation, 1, 'the automatic P6 activation of handoff B');
    const operation = lifecycleState(installation).engineOperation;
    const active = activeSelector(installation);
    evidence.phases.aToB.operation = { operationId: operation.operationId, phase: operation.phase, toBuildId: operation.toBuildId,
      packageSha256: operation.packageSha256, fallbackAttempted: operation.fallbackAttempted };
    evidence.phases.aToB.verifiedAt = switched.at;
    assert.equal(active.buildId, operation.toBuildId, 'the Host selector names the verified B build');
    assert.equal(operation.phase, 'verified');
    assert.equal(operation.fallbackAttempted, false);
    // Engine B is the successor of exactly the handoff A -> B produced: its build identity derives from that candidate.
    assert.equal(operation.toBuildId, `engine-${handoffA.candidateId.slice(0, 12)}`, 'Engine B is the successor of the A -> B handoff');
    t.diagnostic(`B verified: ${operation.toBuildId} operation ${operation.operationId}`);
    ownerWindow = 'a_to_c';
    const windowOpen = boundary();

    // Phase B continuation: B is Host-selected and derives its own effective P5 enrollment from the committed release.
    const bConnection = await freshDescriptor(profile, operation.toBuildId);
    const bCall = traced(bConnection);
    const bStatus = await bCall('GET', '/api/v2/installation/source-release');
    assert.equal(bStatus.status, 200, JSON.stringify(bStatus.body));
    assert.equal(bStatus.body.release.buildId, operation.toBuildId);
    assert.equal(bStatus.body.release.bootstrap, 'engine');
    assert.equal(bStatus.body.release.committedOperationId, operation.operationId);
    assert.equal(bStatus.body.release.packageSha256, operation.packageSha256);
    assert.equal(bStatus.body.protectedSelfRepair.enrollmentLoaded, true, JSON.stringify(bStatus.body.protectedSelfRepair));
    // Single use, enforced at the Owner-facing route: an ordinary Parent run aimed at the slot Repair one claimed is refused.
    const intoClaimed = await bCall('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
      workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
      definitionDigest: parentPublication.definitionDigest, workspaceId: slotIds[0], requestId: randomUUID() });
    assert.equal(intoClaimed.status, 409, JSON.stringify(intoClaimed.body));
    assert.equal(intoClaimed.body.code, 'p5_workspace_reserved', JSON.stringify(intoClaimed.body));
    evidence.phases.claimedSlotRefusal = { slot: slotIds[0], status: intoClaimed.status, code: intoClaimed.body.code };
    evidence.phases.bContinuation = { release: bStatus.body.release, admission: bStatus.body.protectedSelfRepair.decision };
    t.diagnostic(`B admission: ${JSON.stringify(bStatus.body.protectedSelfRepair)}`);

    // Phase B -> C: a second legitimate Parent incident, inside B. B's Repair must prepare the same enrolled single-use slot that
    // A's Repair used. Production retention does not release that slot (P5-08: no automatic recursive deletion or recycling), so
    // this phase records what the Engine does with the occupied slot and refuses to claim more than it observed.
    writeDeveloperPlan(scratch.fixtureState, 2);
    writeProbe(scratch.fixtureState, nodeTool.path, join(installation, 'versions', operation.toBuildId, 'p5'));
    const startedB = await bCall('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
      workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
      definitionDigest: parentPublication.definitionDigest, workspaceId: PARENT_WORKSPACE_TWO, requestId: randomUUID() });
    assert.equal(startedB.status, 202, JSON.stringify(startedB.body));
    const parentRunB = startedB.body.run.runId;
    const linkB = await eventually(() => profileQuery(profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunB)[0] ?? null,
      'the P2 linked Repair of the second incident under B', 600_000, 500);
    const repairRunB = linkB.repair_run_id;
    // Only the Repair's own refusals end the wait. The Parent's failed attempt is the incident itself, not a refusal of the Repair; a
    // Parent resumption blocked before the Repair's approval is one. Failure text is collected for the report either way.
    const settled = await eventually(() => {
      const events = journal(profile, repairRunB);
      const handoffB = events.find(item => item.type === 'self_repair.handoff_recorded');
      if (handoffB) return { handoffB };
      const approved = events.some(item => item.type === 'repair.approval_recorded');
      const refusal = events.find(item => ['attempt.error', 'attempt.failure_outcome', 'continuation.repair_failed',
        'self_repair.candidate_invalidated'].includes(item.type))
        ?? journal(profile, parentRunB).find(item => item.type === 'continuation.repair_failed'
          || (item.type === 'continuation.parent_resumption_blocked' && !approved));
      return refusal ? { refusal } : null;
    }, 'the second Repair under B to settle', 30 * 60_000, 1000);
    evidence.phases.bToC = { parentRunId: parentRunB, linkId: linkB.id, repairRunId: repairRunB, settled: settled.handoffB ? 'handoff' : 'refused',
      evidence: settled.handoffB ?? settled.refusal };
    if (!settled.handoffB) {
      const tail = (lastHost?.stderr ?? '').slice(-4000);
      const runnerLog = join(profile, 'runtime', 'runner.log');
      throw new Error(`BLOCKED at Repair two under B: no handoff. ${JSON.stringify(settled.refusal)}\nRunner log: ${existsSync(runnerLog) ? readFileSync(runnerLog, 'utf8').slice(-3000) : '(none)'}\nHost stderr (tail): ${tail}\nRepair journal: ${JSON.stringify(journal(profile, repairRunB).slice(-12).map(item => [item.sequence, item.type]))}`);
    }
    // Repair two is a genuine second handoff with its own candidate and its own managed clone, not a copy of Repair one's.
    const handoffB = genuineHandoff(profile, settled.handoffB.payload.record, 'the B -> C handoff');
    assert.notEqual(handoffB.candidateId, handoffA.candidateId, 'Repair two produced a distinct candidate');
    assert.notEqual(handoffB.gitCandidate.artifactId, handoffA.gitCandidate.artifactId, 'Repair two has its own managed clone');
    evidence.phases.bToC.handoff = { record: settled.handoffB.payload.record, candidateId: handoffB.candidateId, gitCandidate: handoffB.gitCandidate };
    if (exhaustion) {
      // B's successor needs a third enrolled slot the two-slot pool does not have. The Engine refuses it in the P6 consumer, before
      // any build, Host staging or switch. The refusal text is read from the Engine's runner log or the Host's stderr.
      const refusal = await eventually(() => {
        const runnerLog = join(profile, 'runtime', 'runner.log');
        const text = `${existsSync(runnerLog) ? readFileSync(runnerLog, 'utf8') : ''}\n${lastHost?.stderr ?? ''}`;
        return text.includes('p6_successor_workspace_exhausted') ? text : null;
      }, 'the fail-closed refusal of the successor of B', 20 * 60_000, 1000);
      const staged = hostEvents(installation).filter(event => event.type === 'engine_staged');
      assert.equal(staged.length, 1, 'no successor was staged after the exhausted refusal');
      assert.equal(activeSelector(installation).buildId, operation.toBuildId, 'Engine B remains the Host-selected release');
      evidence.exhaustion = { pool: slotIds, claims: profileQuery(profile, 'SELECT id AS repairRunId, workspace_id AS slot, state FROM runs WHERE id IN (?, ?)', repairRunId, repairRunB),
        stagedEvents: staged.length, refusal: refusal.split(/\r?\n/).filter(line => line.includes('p6_successor_workspace_exhausted')).slice(0, 2) };
      closeWindow(windowOpen);
      if (process.env.DESZO_P6_GENUINE_EVIDENCE_DIR) {
        mkdirSync(process.env.DESZO_P6_GENUINE_EVIDENCE_DIR, { recursive: true });
        writeFileSync(join(process.env.DESZO_P6_GENUINE_EVIDENCE_DIR, '2026-11-04-p6-genuine-e2e-exhaustion-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      }
      return;
    }
    const switchedC = await awaitSwitchVerified(installation, 2, 'the automatic P6 activation of handoff C');
    const operationC = lifecycleState(installation).engineOperation;
    evidence.phases.bToC.operation = { operationId: operationC.operationId, phase: operationC.phase, toBuildId: operationC.toBuildId,
      packageSha256: operationC.packageSha256, fallbackAttempted: operationC.fallbackAttempted, verifiedAt: switchedC.at };
    assert.equal(activeSelector(installation).buildId, operationC.toBuildId, 'the Host selector names the verified C build');
    assert.equal(operationC.phase, 'verified');
    assert.equal(operationC.fallbackAttempted, false);
    // Operation C is the switch of exactly Repair two's handoff, from the B the first switch verified: not a repeat of operation B.
    assert.equal(operationC.fromBuildId, operation.toBuildId, 'operation C switches from the verified Engine B');
    assert.equal(operationC.toBuildId, `engine-${handoffB.candidateId.slice(0, 12)}`, 'Engine C is the successor of the B -> C handoff');
    assert.notEqual(operationC.operationId, operation.operationId);
    closeWindow(windowOpen);
    t.diagnostic(`C verified: ${operationC.toBuildId} operation ${operationC.operationId}`);

    // C validates its own P5 continuation: the Host selects C, C loads its effective enrollment and admission is enabled.
    const cConnection = await freshDescriptor(profile, operationC.toBuildId);
    const cStatus = await traced(cConnection)('GET', '/api/v2/installation/source-release');
    assert.equal(cStatus.status, 200, JSON.stringify(cStatus.body));
    assert.equal(cStatus.body.release.buildId, operationC.toBuildId);
    assert.equal(cStatus.body.release.committedOperationId, operationC.operationId);
    assert.equal(cStatus.body.protectedSelfRepair.enrollmentLoaded, true, JSON.stringify(cStatus.body.protectedSelfRepair));
    assert.equal(cStatus.body.protectedSelfRepair.admissionEnabled, true, JSON.stringify(cStatus.body.protectedSelfRepair));
    evidence.phases.cContinuation = { release: cStatus.body.release, admission: cStatus.body.protectedSelfRepair.decision };
    // No change to the immutable baseline: the root enrollment bytes and the enrolled origin's main are exactly as before the chain.
    assert.equal(sha256(readFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH))), rootEnrollmentSha256, 'the root enrollment file is byte-identical');
    assert.equal(git(origin, ['rev-parse', 'refs/heads/main']).trim(), originMainBefore, 'no publication: the enrolled origin main is unchanged');
    evidence.rootEnrollmentSha256 = rootEnrollmentSha256;
    evidence.originMain = originMainBefore;

    // Evidence for the report, written only after every assertion above passed. Each Repair names the slot it claimed; each
    // switch names its staged package and operation.
    evidence.claims = profileQuery(profile, 'SELECT id AS repairRunId, workspace_id AS slot, state FROM runs WHERE id IN (?, ?)', repairRunId, repairRunB);
    evidence.pool = slotIds;
    evidence.switches = hostEvents(installation).filter(event => ['engine_staged', 'engine_switch_accepted', 'engine_switch_committed',
      'engine_switch_verified', 'engine_ready'].includes(event.type))
      .map(event => ({ at: event.at, type: event.type, buildId: event.payload?.engineBuildId ?? event.payload?.buildId ?? null,
        operationId: event.payload?.operationId ?? null, packageSha256: event.payload?.packageSha256 ?? null }));
    evidence.handoffs = { a: evidence.phases.aToB, b: evidence.phases.bToC };
    // The P6 receipts are immutable Store artifacts named by their command receipts. The evidence keeps each receipt's identity, digest and
    // the fields the acceptance review checks, read from the Store before the test removes its profile.
    evidence.receipts = profileQuery(profile, `SELECT r.command, r.request_id, r.payload_sha256, r.response_artifact_id, a.sha256, a.relative_path
      FROM command_receipts r JOIN artifacts a ON a.id = r.response_artifact_id WHERE r.command LIKE 'p6.%' ORDER BY r.created_at`).map(row => {
      const body = JSON.parse(readFileSync(join(profile, 'store', row.relative_path), 'utf8'));
      return { command: row.command, requestId: row.request_id, artifactId: row.response_artifact_id, sha256: row.sha256,
        payloadSha256: row.payload_sha256, kind: body.kind ?? null, operationId: body.operationId ?? null, handoffId: body.handoffId ?? null,
        engineBuildId: body.engineBuildId ?? null, packageSha256: body.packageSha256 ?? null,
        reproducedPackageSha256: body.reproducedPackageSha256 ?? null, reproducible: body.reproducible ?? null,
        sourceCommit: body.sourceCommit ?? null, sourceTree: body.sourceTree ?? null };
    });
    if (process.env.DESZO_P6_GENUINE_EVIDENCE_DIR) {
      mkdirSync(process.env.DESZO_P6_GENUINE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.DESZO_P6_GENUINE_EVIDENCE_DIR, '2026-11-04-p6-genuine-e2e-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  } catch (error) {
    error.message += `\nEvidence so far: ${JSON.stringify(evidence)}`;
    if (lastHost) error.message += `\nHost stderr (tail): ${lastHost.stderr.slice(-6000)}`;
    throw error;
  } finally {
    if (host) await host.stop();
    if (identityHost) await identityHost.shutdown().catch(() => identityHost.crash());
    for (const root of slotRoots) releaseOwnedDir(root);
  }
}

test('P6-BUILD-GENUINE-E2E: a real Repair of Engine A produces B and a real Repair of Engine B produces C, both activated automatically',
  { timeout: 150 * 60_000 }, t => genuineChain(t, { slotCount: 3, exhaustion: false }));

test('P6-BUILD-GENUINE-E2E-EXHAUSTION: a two-slot pool activates B, then refuses the successor of B fail-closed before any staging',
  { timeout: 150 * 60_000 }, t => genuineChain(t, { slotCount: 2, exhaustion: true }));
