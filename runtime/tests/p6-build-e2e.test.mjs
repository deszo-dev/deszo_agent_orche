// P6-BUILD Layer 3: Packaged P6/G0 Integration E2E — synthetic accepted P5 input. P5 accepted-looking Store state is
// intentionally fixture-authored; this is not a genuine P5 acceptance test. A->B is started by Engine A's own startup projection
// reconciliation of that eligible fixture handoff (the test-only route's 202 then has no effect, asserted below); B->C, whose
// fixture handoff is written while B runs, is started through the test-only route.
// Fixture handoff -> Engine A receives it -> verifies eligibility
// -> reconstructs source -> fixed trusted builder builds Engine B -> emits P6BuildReceipt/1
// -> prepares successor P5 profile -> Host engine.stage & engine.switch
// -> Custody fence + A termination -> B preflight on disposable Store -> Host commits B
// -> B normal startup -> P5 continuation in B (effective enrollment resolved).
// ZERO Owner human approvals between P5 acceptance and P6 activation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { attachEngine, buildArtifacts, eventually, startCustodyHost } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, fileSha256, freshDescriptor, hostEvents,
  hostDigest, installEngines, installShell, probeEngine, processAlive, readProfileDb, shellRelease, startShellHost } from './p6-g0-support.mjs';
import { Store } from '../core/store.mjs';
import { resolveP6Continuation } from '../core/p6Continuation.mjs';
import { materializeVerifiedP6GitObjects, verifyP6GitObjectSource } from '../core/p6GitObjectSource.mjs';
import { fetchP5EnrolledGitRefs, verifyP5GitHistoryComplete } from '../core/p5GitCandidate.mjs';
import { makeFailureOutcome } from '../core/failureOutcomes.mjs';
import { captureP5VerificationInputs, p5SourceDigest, p5BaselineId, p5CandidateId, p5CheckInputDigest, p5ExecutionTreeDigest,
  p5VerificationCommandDigest, p5VerificationReceiptId, validateP5Contract, createP5Handoff } from '../core/protectedSelfRepair.mjs';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { attachP6TestGitCandidate } from './p6-git-fixture.mjs';

function lifecycleState(installation) {
  const profileStates = join(installation, '.deszo-host', 'profiles');
  const key = readdirSync(profileStates)[0];
  return JSON.parse(readFileSync(join(profileStates, key, 'lifecycle.json'), 'utf8'));
}

// The Host's own outcome of one switch. Trigger -> verified took 116-144 s on an idle machine and about 190 s to the commit alone
// while another packaged run shared the CPU (P6-BUILD-UNBLOCK section 4), so the bound is wide. A fixed 180 s wait used to expire at
// the commit; teardown then stopped the Host mid-readiness. A pre-commit hold or rollback, or a failure recorded beside the committed
// phase (the Host's readiness wait has ended), fails at once.
async function awaitSwitchVerified(installation, count, description, triggeredAt) {
  await eventually(() => {
    if (hostEvents(installation).filter(event => event.type === 'engine_switch_verified').length >= count) return true;
    const operation = lifecycleState(installation).engineOperation;
    if (operation?.phase === 'held' || operation?.phase === 'rolled_back')
      throw new Error(`The Host ended the switch in phase ${operation.phase} before ${description}: ${operation.failure}`);
    // A failure recorded beside the committed phase means this Host's readiness wait already ended; a restart would be needed.
    if (operation?.phase === 'committed' && operation.failure) throw new Error(`The committed switch recorded a failure: ${operation.failure}`);
    return false;
  }, description, 600_000, 500);
  const timeline = hostEvents(installation).filter(event => Number(event.at) >= triggeredAt)
    .map(event => ({ sinceTriggerMs: Number(event.at) - triggeredAt, type: event.type }));
  console.log(`Host switch timeline for ${description}:`, JSON.stringify(timeline));
  return timeline;
}

async function stopHostRecorded(host, installation) {
  let operation = null;
  try { operation = lifecycleState(installation).engineOperation; } catch { /* The Host has written no state yet. */ }
  if (operation &&!['verified', 'rolled_back'].includes(operation.phase))
    console.log(`Test teardown stops the Host while Engine operation ${operation.operationId} is ${operation.phase}; a later hold or readiness refusal is a consequence of this stop.`);
  await host.stop();
}

test('P6-BUILD P6/G0 Integration (synthetic P5 handoffs): trusted build -> Host activation -> continuation', { timeout: 45 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-build-e2e-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const shellBefore = fileSha256(join(installation, 'shell', 'deszo.exe'));
  const hostBefore = fileSha256(hostExe);

  // Prepare source checkouts (base, cloneA, cloneB with engine-b marker)
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });

  // Install ONLY Engine A into versions/ (Engine B is NOT pre-installed or staged)
  const installed = await installEngines(installation, sources, { stageB: false, testFaultHooks: true });
  const { rmSync: rmDirSync } = await import('node:fs');
  rmDirSync(join(installation, 'versions', ENGINE_B), { recursive: true, force: true });
  rmDirSync(join(installation, 'staging', ENGINE_B), { recursive: true, force: true });
  const aRoot = join(installation, 'versions', ENGINE_A);

  const profile = join(root, 'profile');
  // Host installation identity is derived from the canonical installation/profile paths. Probe it
  // through the real Host before authoring Store-bound P5 release evidence for Engine A.
  const identityProbe = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true,
    custody: { allowedExecutables: [{ path: process.execPath, sha256: fileSha256(process.execPath) }] } });
  let hostInstallationId, identityProbeConnection;
  try {
    identityProbeConnection = await identityProbe.engineConnection(ENGINE_A);
    hostInstallationId = hostEvents(installation).find(event => event.type === 'host_started')?.payload?.installationId;
  } finally {
    await identityProbe.stop();
  }
  assert.match(hostInstallationId || '', /^[0-9a-f]{32}$/i, 'the real Host supplied its installation identity');
  const store = new Store(profile);

  const parentRunId = randomUUID();
  const repairRunId = randomUUID();
  const linkId = randomUUID();
  const incidentId = randomUUID();
  const enrollmentId = randomUUID();
  const normInstId = hostInstallationId.toLowerCase();

  // 1. Ingest candidate B sources from cloneB into Store artifacts
  const cloneB = sources.cloneB;
  const { readdirSync: readDirSync, lstatSync } = await import('node:fs');
  const { relative, sep } = await import('node:path');

  const entries = [];
  function walk(dir) {
    for (const name of readDirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name === '.git' || name === 'node_modules') continue;
        walk(full);
      } else if (st.isFile()) {
        const rel = relative(cloneB, full).split(sep).join('/');
        const bytes = readFileSync(full);
        const digest = sha256(bytes);
        const art = store.putBytes(bytes, 'application/octet-stream');
        entries.push({
          path: rel,
          type: 'regular',
          executable: false,
          byteSize: bytes.length,
          sha256: digest,
          artifact: { artifactId: art.artifactId, sha256: art.sha256 },
        });
      }
    }
  }
  walk(cloneB);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const cleanEntries = entries.map(({ artifact: _a, ...e }) => e);
  const candidateSourceDigest = p5SourceDigest(cleanEntries);

  // Enroll A against the exact source inventory embedded in its installed package.
  const inventoryA = JSON.parse(readFileSync(join(aRoot, '.deszo-source-inventory.json'), 'utf8'));
  const baselineEntries = inventoryA.files.map(({ path, sha256: digest }) => {
    const bytes = readFileSync(join(sources.cloneA, ...path.split('/')));
    if (sha256(bytes) !== digest) throw new Error(`Engine A package source inventory drift at ${path}`);
    const artifact = store.putBytes(bytes, 'application/octet-stream');
    return { path, type: 'regular', executable: false, byteSize: bytes.length, sha256: digest,
      artifact: { artifactId: artifact.artifactId, sha256: artifact.sha256 } };
  });
  const baselineSourceDigest = p5SourceDigest(baselineEntries.map(({ artifact: _artifact, ...entry }) => entry));
  const baselineSourceManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest',
    sourceDigest: baselineSourceDigest, entries: baselineEntries };
  validateP5Contract('sourceManifest', baselineSourceManifest);
  const baselineSourceManifestArt = store.putJson(baselineSourceManifest);

  const sourceManifest = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairSourceManifest',
    sourceDigest: candidateSourceDigest,
    entries,
  };
  validateP5Contract('sourceManifest', sourceManifest);
  const sourceManifestArt = store.putJson(sourceManifest);

  // 2. Set up P5 baseline, profile, enrollment
  const baseCommit = sources.baseCommit;
  const repositoryIdentity = {
    enrollmentId,
    canonicalCommonDirectory: sources.cloneA,
    nativeDirectoryIdentity: { volumeId: 'v1', fileId: 'r1' },
  };
  // The baseline manifest is the whole committed tree, so the path policy covers it: P5 preparation inventories the slot under
  // this policy and requires every manifest entry (P6-BUILD-UNBLOCK; a runtime/**-only policy refused the fresh B clone).
  const pathPolicy = { include: ['**'], exclude: ['.git/**', '.p5/**'], secretPaths: [] };
  const pathPolicyDigest = canonicalHash(pathPolicy);
  const baseTree = execFileSync(sources.gitPath, ['-C', sources.cloneA, 'rev-parse', `${baseCommit}^{tree}`],
    { encoding: 'utf8', windowsHide: true }).trim();
  const baselineId = p5BaselineId({
    repositoryIdentity,
    gitObjectFormat: 'sha1',
    baseCommit,
    baseTree,
    pathPolicyDigest,
    effectiveSourceDigest: baselineSourceDigest,
  });

  const releaseAArt = store.putJson({
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairRunningSourceRelease',
    buildId: ENGINE_A,
    bootstrap: 'engine',
    packageSha256: hostDigest(aRoot),
    sourceCommit: installed.a.sourceCommit,
    sourceDigest: installed.a.sourceDigest,
    inputsDigest: installed.a.inputsDigest,
    installationId: normInstId,
  });

  const baselineAArt = store.putJson({
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairBaselineManifest',
    baselineId,
    enrollmentId,
    repositoryIdentity,
    repositoryRoot: sources.cloneA,
    gitObjectFormat: 'sha1',
    baseCommit,
    baseTree,
    pathPolicyDigest,
    pathPolicy,
    effectiveSourceDigest: baselineSourceDigest,
    sourceManifest: { artifactId: baselineSourceManifestArt.artifactId, sha256: baselineSourceManifestArt.sha256 },
    runningSourceRelease: { artifactId: releaseAArt.artifactId, sha256: releaseAArt.sha256 },
    excludedPaths: [],
    capturedAt: new Date().toISOString(),
  });

  const check = {
    checkId: 'unit-check',
    stageId: 'unit',
    required: true,
    commandDigest: '0'.repeat(64),
    executable: process.execPath,
    executableSha256: sha256(readFileSync(process.execPath)),
    argv: ['--version'],
    cwd: 'candidate-source',
    inputRefs: [],
    environment: {},
    subjectEntryPoints: ['runtime/core/engine.mjs'],
    expectedAssertions: ['candidate-entrypoint-syntax'],
    expectedExitCodes: [0],
    timeoutSeconds: 30,
    maxOutputBytes: 4096,
    subjectBinding: 'candidate-entrypoint',
    overlayPaths: ['runtime/core/engine.mjs'],
  };
  check.overlayPaths = [];
  check.commandDigest = p5VerificationCommandDigest(check);
  const policyArt = store.putJson({
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairVerificationPolicy',
    planVersion: 1,
    requiredStages: ['unit'],
    requiredCheckIds: ['unit-check'],
    optionalCheckIds: [],
    harnessClosureDigest: installed.a.inputsDigest,
    incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8, maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
    checks: [check],
    verificationRetries: 0,
    aggregateTimeoutSeconds: 400,
  });

  const parentWorkflowSnapshot = store.putJson({ schemaVersion: 1, kind: 'WorkflowSnapshot', workflowId: 'wf-parent', version: 1,
    capabilities: ['protected-self-repair-v1'], nodes: [], edges: [], after: [] });
  const repairWorkflowSnapshot = store.putJson({ schemaVersion: 1, kind: 'WorkflowSnapshot', workflowId: 'wf-repair', version: 1,
    capabilities: ['protected-self-repair-v1'], nodes: [], edges: [], after: [] });
  const parentPublication = { workflowId: 'wf-parent', version: 1, publishedVersionId: randomUUID(),
    snapshotSha256: parentWorkflowSnapshot.sha256 };
  const repairPublication = { workflowId: 'wf-repair', version: 1, publishedVersionId: randomUUID(),
    snapshotSha256: repairWorkflowSnapshot.sha256 };
  const workspaceAllocationId = randomUUID();
  // The enrolled P5 pool: real, empty, test-owned directories with their native identities, so the Host-selected successor can
  // prepare a fresh managed clone in its entry. The successor takes the entry after the release's own (nextP5WorkspaceSlot), so the
  // pool needs one entry per planned Repair (A → B, B → C) plus one for the release after the last Repair, as the genuine chain does.
  // A separate custody Host reads those identities before any Engine has the enrollment.
  const POOL_IDS = ['p5-slot', 'p5-slot-2', 'p5-slot-3'];
  for (const id of POOL_IDS) mkdirSync(join(root, id), { recursive: true });
  const identityHost = await startCustodyHost(root, { allowedExecutables: [{ path: process.execPath, sha256: fileSha256(process.execPath) }] });
  const poolIdentities = [];
  try {
    const epoch = await attachEngine(identityHost);
    for (const id of POOL_IDS) poolIdentities.push(await identityHost.request('custody.source_identity', { generation: identityHost.generation, epoch,
      root: join(root, id), include: [], exclude: [], maxFiles: 0, maxBytes: 0 }));
  } finally { await identityHost.shutdown(); }
  for (const identity of poolIdentities) assert.equal(identity.refused, undefined, identity.message);
  const slotRoot = poolIdentities[0].canonicalRoot;
  const workspaceNativeIdentity = poolIdentities[0].rootIdentity;
  const slotRoot2 = poolIdentities[1].canonicalRoot;
  const slotRoot3 = poolIdentities[2].canonicalRoot;
  const workspacePool = [
    { workspaceId: 'p5-slot', canonicalRoot: slotRoot, allocationId: workspaceAllocationId, nativeIdentity: workspaceNativeIdentity },
    { workspaceId: 'p5-slot-2', canonicalRoot: slotRoot2, allocationId: randomUUID(), nativeIdentity: poolIdentities[1].rootIdentity },
    { workspaceId: 'p5-slot-3', canonicalRoot: slotRoot3, allocationId: randomUUID(), nativeIdentity: poolIdentities[2].rootIdentity },
  ];
  const rootProfileArt = store.putJson({
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairProfile',
    enrollmentId,
    repositoryIdentity,
    baselineId,
    baseline: { artifactId: baselineAArt.artifactId, sha256: baselineAArt.sha256 },
    runningSourceRelease: { artifactId: releaseAArt.artifactId, sha256: releaseAArt.sha256 },
    repairPublication,
    developerNodeId: 'dev',
    verificationNodeId: 'verify',
    repairJudgeNodeId: 'judge',
    workspace: { workspaceId: 'p5-slot', allocationId: workspaceAllocationId, canonicalRoot: slotRoot, singleUse: true, cleanCommitted: true },
    scope: { add: ['runtime/**'], modify: ['runtime/**'], delete: [], executable: [], denied: [], sensitiveCategories: [] },
    verificationPolicy: { artifactId: policyArt.artifactId, sha256: policyArt.sha256 },
    requiredCheckIds: ['unit-check'],
    // A category the production P3 outcome classifier emits, so B's fresh Repair captures its inputs through the real path.
    eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'provider-unavailable' }],
    failedNodeRetry: 'never',
    acceptanceMode: 'judge_post_execution',
    budgets: { maxSourceFiles: 1000, maxSourceBytes: 50_000_000, developerTimeoutSeconds: 60, verificationTimeoutSeconds: 120, maxCheckOutputBytes: 1024, verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 },
  });

  const enrollmentArt = store.putJson({
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairEnrollment',
    enrollmentId,
    repositoryIdentity,
    gitObjectFormat: 'sha1',
    baseCommit,
    baseTree,
    pathPolicyDigest,
    effectiveSourceDigest: baselineSourceDigest,
    gitCandidatePolicy: 'managed-clone-v1',
    gitSource: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1',
      sourceRepositoryId: 'p6-build-e2e', remote: { remoteId: 'p6-test-origin', url: pathToFileURL(sources.cloneA).href, protocol: 'file' },
      fetchRefs: ['refs/heads/main'], sourceCommit: baseCommit, sourceTree: baseTree, objectFormat: 'sha1',
      releaseSourceDigest: installed.a.sourceDigest, credentialPolicy: 'none',
      publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: false,
        remoteId: 'p6-test-origin', refNamespace: 'refs/heads/self-repair/', requireExpectedRemoteState: true, allowMerge: false } },
    baselineId,
    baselineManifest: { artifactId: baselineAArt.artifactId, sha256: baselineAArt.sha256 },
    runningSourceRelease: { artifactId: releaseAArt.artifactId, sha256: releaseAArt.sha256 },
    parentPublication,
    profile: { artifactId: rootProfileArt.artifactId, sha256: rootProfileArt.sha256 },
    repairPublication,
    workspace: workspacePool[0],
    workspacePool,
    verificationPolicy: { artifactId: policyArt.artifactId, sha256: policyArt.sha256 },
    harnessClosureDigest: installed.a.inputsDigest,
    toolIdentities: [{ name: 'git', path: sources.gitPath, sha256: sha256(readFileSync(sources.gitPath)) }],
    scope: { add: ['runtime/**'], modify: ['runtime/**'], delete: [], executable: [], denied: [], sensitiveCategories: [] },
    budgets: { maxSourceFiles: 1000, maxSourceBytes: 50_000_000, developerTimeoutSeconds: 60, verificationTimeoutSeconds: 120, maxCheckOutputBytes: 1024, verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 },
    minimumReaderCapability: 'protected-self-repair-v1',
  });

  // Write enrollment file into profile
  mkdirSync(join(profile, 'p5'), { recursive: true });
  writeFileSync(join(profile, 'p5', 'enrollment.json'), JSON.stringify(store.readJson(enrollmentArt.artifactId)));

  // 3. Build a production-schema-valid synthetic P5 handoff. The real P5 acceptance path is covered separately.
  const now = new Date().toISOString();
  const refOf = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });
  const evidenceArt = store.putJson({ schemaVersion: 1, kind: 'P6 Packaged E2E Fixture Evidence', createdAt: now });
  const evidenceRef = refOf(evidenceArt);
  const incidentBytes = Buffer.from('P6 packaged E2E fixture incident evidence\n');
  const incidentArt = store.putBytes(incidentBytes, 'text/plain');
  const incidentRef = refOf(incidentArt);
  const outcomeId = randomUUID();
  const outcomeRevision = 1;
  const workspace = store.readJson(enrollmentArt.artifactId).workspace;
  const enrollmentRef = refOf(enrollmentArt);
  const baselineRef = refOf(baselineAArt);
  const releaseRef = refOf(releaseAArt);
  const profileRef = refOf(rootProfileArt);
  const policyRef = refOf(policyArt);
  const sourceManifestRef = refOf(sourceManifestArt);
  const baselineSourceManifestRef = refOf(baselineSourceManifestArt);
  const verificationInputs = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationInputs', incidentId, outcomeId, outcomeRevision,
    verificationPolicy: policyRef,
    inputs: [{ selector: 'p3-outcome-artifacts', artifact: incidentRef, sourceOutcomeId: outcomeId, sourceRevision: outcomeRevision }],
    capturedAt: now,
  };
  validateP5Contract('verificationInputs', verificationInputs);
  const verificationInputsArt = store.putJson(verificationInputs);
  const verificationInputsRef = refOf(verificationInputsArt);
  const sourceBinding = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId, parentRunId, parentPublication,
    parentSnapshot: refOf(parentWorkflowSnapshot), baselineId, baselineManifest: baselineRef, profile: profileRef,
    runningSourceRelease: releaseRef, runtimeInstanceId: randomUUID(), lifecycleGeneration: randomUUID(), boundAt: now,
  };
  validateP5Contract('sourceBinding', sourceBinding);
  const sourceBindingArt = store.putJson(sourceBinding);
  const sourceBindingRef = refOf(sourceBindingArt);
  const preparationIntent = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: enrollmentRef,
    baselineManifest: baselineRef, sourceManifest: baselineSourceManifestRef, sourceBinding: sourceBindingRef,
    verificationInputs: verificationInputsRef, parentRunId, repairRunId, linkId, workspace, createdAt: now,
  };
  validateP5Contract('preparationIntent', preparationIntent);
  const preparationIntentArt = store.putJson(preparationIntent);
  const preparationIntentRef = refOf(preparationIntentArt);

  const candidateSourceRoot = resolve(workspace.canonicalRoot, 'source');
  const pathDigest = sha256(Buffer.from(cleanEntries.map(entry => `${entry.path}\0`).join(''), 'ascii'));
  const contentDigest = sha256(Buffer.from(cleanEntries.map(entry => `${entry.path}\0${entry.byteSize}\0${entry.sha256}\n`).join(''), 'ascii'));
  const sourceCaptureEvidence = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairSourceCaptureEvidence', sourceRoot: candidateSourceRoot,
    rootIdentity: workspace.nativeIdentity, hostPid: process.pid, generation: 'p6-fixture-source-capture', epoch: 1,
    snapshotDigestBefore: candidateSourceDigest, snapshotDigestAfter: candidateSourceDigest,
    pathDigest, contentDigest, fileCount: cleanEntries.length, totalBytes: cleanEntries.reduce((sum, entry) => sum + entry.byteSize, 0),
  };
  validateP5Contract('sourceCaptureEvidence', sourceCaptureEvidence);
  const sourceCaptureArt = store.putJson(sourceCaptureEvidence);
  const sourceCaptureRef = refOf(sourceCaptureArt);

  const developerAttemptId = randomUUID();
  const developerTerminal = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairDeveloperTerminalEvidence', attemptId: developerAttemptId,
    custodyId: randomUUID(), processId: process.pid, processCreationTime: now,
    invocationDigest: 'a'.repeat(64), executableSha256: sha256(readFileSync(process.execPath)),
    processTreeEnded: true, spoolComplete: true, status: 'exited', state: 'exited', exitCode: 0,
  };
  const developerTerminalArt = store.putJson(developerTerminal);
  const developerTerminalRef = refOf(developerTerminalArt);

  const changes = (() => {
    const before = new Map(baselineEntries.map(entry => [entry.path, entry]));
    const after = new Map(entries.map(entry => [entry.path, entry]));
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
      const oldEntry = before.get(path) ?? null;
      const newEntry = after.get(path) ?? null;
      if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256 && oldEntry.byteSize === newEntry.byteSize
        && oldEntry.executable === newEntry.executable) return [];
      const clean = entry => entry && ({ path: entry.path, type: entry.type, byteSize: entry.byteSize,
        sha256: entry.sha256, executable: entry.executable });
      return [{ path, operation: !oldEntry ? 'add' : !newEntry ? 'delete' : 'modify',
        before: clean(oldEntry), after: clean(newEntry),
        ...(oldEntry ? { beforeArtifact: oldEntry.artifact } : {}), ...(newEntry ? { afterArtifact: newEntry.artifact } : {}) }];
    });
  })();
  if (changes.some(change => !change.path.startsWith('runtime/')))
    throw new Error('The P6 fixture candidate exceeds its enrolled runtime-only P5 source scope.');

  const candidateId = p5CandidateId({ baselineId, incidentId, parentRunId, repairRunId, linkId, developerAttemptId,
    workspaceAllocationId: workspace.allocationId, candidateSourceDigest,
    selfRepairProfileDigest: profileRef.sha256, verificationPolicyDigest: policyRef.sha256,
    verificationInputsDigest: verificationInputsRef.sha256 });
  const changeManifest = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairChangeManifest', candidateId, baselineId,
    baseSourceDigest: baselineSourceDigest, candidateSourceDigest,
    profileDigest: profileRef.sha256, verificationPolicyDigest: policyRef.sha256,
    verificationInputsDigest: verificationInputsRef.sha256, workspaceAllocationId: workspace.allocationId,
    parentRunId, repairRunId, linkId, incidentId, changes,
  };
  validateP5Contract('changeManifest', changeManifest);
  const changeManifestArt = store.putJson(changeManifest);
  const changeManifestRef = refOf(changeManifestArt);

  const candidateBase = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairCandidate',
    candidateId,
    enrollment: enrollmentRef,
    baselineRef,
    baselineId,
    baseCommit,
    baseSourceDigest: baselineSourceDigest,
    candidateSourceDigest,
    sourceManifest: sourceManifestRef,
    changeManifest: changeManifestRef,
    sourceCaptureEvidence: sourceCaptureRef,
    repositoryIdentity,
    sourceBinding: sourceBindingRef,
    workspace: {
      ...workspace,
      sourceRoot: candidateSourceRoot,
    },
    parentRunId,
    repairRunId,
    linkId,
    incidentId,
    outcomeId,
    outcomeRevision,
    parentPublication,
    repairPublication,
    developerNodeId: 'dev',
    developerAttemptId,
    selfRepairProfile: profileRef,
    verificationPolicy: policyRef,
    verificationInputs: verificationInputsRef,
    developerTerminalEvidence: developerTerminalRef,
    scopeVerdict: { status: 'within_scope', changeCount: changes.length },
    capturedAt: now,
    journalCursor: 1,
  };
  validateP5Contract('candidate', candidateBase);
  const candidateBinding = await attachP6TestGitCandidate({ store, candidate: candidateBase, sourceRoot: sources.cloneB,
    gitPath: sources.gitPath, seedCommit: baseCommit, seedTree: baseTree, sourceEntries: entries, preparationIntentRef });
  const candidate = candidateBinding.candidate;
  const candidateRef = candidateBinding.candidateRef;
  const captureAnchor = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairCandidateCaptureAnchor',
    captureId: canonicalHash({ kind: 'P5CandidateCapture', version: 1, linkId, repairRunId, developerAttemptId,
      allocationId: workspace.allocationId }),
    linkId, parentRunId, repairRunId, incidentId, developerAttemptId,
    developerTerminalEvidence: developerTerminalRef,
    terminalIdentity: { custodyId: developerTerminal.custodyId, processId: developerTerminal.processId,
      processCreationTime: developerTerminal.processCreationTime, invocationDigest: developerTerminal.invocationDigest,
      executableSha256: developerTerminal.executableSha256, exitCode: 0 },
    enrollment: enrollmentRef, workspacePreparation: candidateBinding.workspacePreparationRef,
    allocationId: workspace.allocationId, workspaceIdentity: workspace.nativeIdentity,
    gitCandidatePolicy: 'managed-clone-v1', expectedSourceDigest: candidateSourceDigest,
    expectedCandidateId: candidateId, sourceSnapshotDigest: sourceCaptureEvidence.snapshotDigestAfter,
    capturedAt: now, journalCursor: 4,
  };
  validateP5Contract('candidateCaptureAnchor', captureAnchor);
  const captureAnchorRef = refOf(store.putJson(captureAnchor));

  const gateAttemptId = randomUUID();
  const custodyId = randomUUID();
  const lifecycleGeneration = randomUUID();
  const invocationDigest = 'b'.repeat(64);
  const hostIdentity = 'fixture-host';
  const gateTerminal = { schemaVersion: 1, kind: 'ProtectedSelfRepairGateTerminalEvidence', attemptId: gateAttemptId,
    custodyId, invocationDigest, lifecycleGeneration, hostIdentity, processTreeEnded: true, spoolComplete: true,
    state: 'exited', status: 'exited', exitCode: 0 };
  const gateTerminalArt = store.putJson(gateTerminal);
  const gateTerminalRef = refOf(gateTerminalArt);
  const verifyScratch = join(workspace.canonicalRoot, '.p5', 'verify', 'scratch', gateAttemptId);
  const commandRoots = {
    candidateSource: join(workspace.canonicalRoot, '.p5', 'verify', 'source'),
    executionRoot: join(workspace.canonicalRoot, '.p5', 'verify', 'execution'),
    verifyScratch,
    installedControl: join(root, 'p5-installed-control'),
  };
  const checkInputDigest = p5CheckInputDigest({ candidate, check, verificationInputs });
  const materializedInputManifest = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairMaterializedCheckInputs', candidateId,
    candidateSourceDigest, baselineId, checkId: check.checkId, inputDigest: checkInputDigest, root: verifyScratch,
    inputs: [{ source: 'incident', selector: 'p3-outcome-artifacts', sourceOutcomeId: outcomeId,
      sourceRevision: outcomeRevision, artifact: incidentRef, relativePath: `inputs/${check.checkId}/input-0000.bin`,
      sha256: sha256(incidentBytes), byteSize: incidentBytes.length }],
  };
  const materializedInputsRef = refOf(store.putJson(materializedInputManifest));
  const materializedInputPath = `inputs/${check.checkId}/manifest.json`;
  const absoluteInputManifestPath = join(verifyScratch, 'inputs', check.checkId, 'manifest.json');
  const subjectFiles = [check.subjectEntryPoints[0]].map(path => {
    const entry = entries.find(item => item.path === path);
    if (!entry) throw new Error(`P6 fixture Gate subject is absent from the candidate source: ${path}`);
    return { path, sha256: entry.sha256, byteSize: entry.byteSize, executable: entry.executable };
  });
  const subjectResolution = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairSubjectResolution', candidateId, candidateSourceDigest, baselineId,
    checkId: check.checkId, verificationPolicy: policyRef, verificationInputs: verificationInputsRef,
    inputDigest: checkInputDigest, driverIdentity: check.executable, driverSha256: check.executableSha256,
    entryPoints: check.subjectEntryPoints, resolvedFiles: subjectFiles,
    sourceClosureDigest: canonicalHash(subjectFiles),
    assertionBindings: check.expectedAssertions.map(assertion => ({ assertion, sourcePath: check.subjectEntryPoints[0] })),
  };
  const subjectResolutionRef = refOf(store.putJson(subjectResolution));
  const executionTreeDigest = p5ExecutionTreeDigest({ candidate, checkId: check.checkId,
    subjectResolution: subjectResolutionRef, inputDigest: checkInputDigest, overlayManifest: null });
  const testInputManifest = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairTestInputManifest', candidateId, candidateSourceDigest, baselineId,
    verificationPolicy: policyRef, verificationInputs: verificationInputsRef, harnessClosureDigest: installed.a.inputsDigest,
    checks: [{ checkId: check.checkId, inputDigest: checkInputDigest, subjectResolution: subjectResolutionRef,
      executionTreeDigest, materializedInputs: materializedInputsRef, materializedInputPath,
      materializedInputDigest: materializedInputsRef.sha256, overlayManifest: null }],
  };
  const testInputManifestRef = refOf(store.putJson(testInputManifest));
  const effectiveCheckEnvironment = { ...check.environment,
    DESZO_P5_INPUT_MANIFEST: absoluteInputManifestPath,
    DESZO_P5_CANDIDATE_ENTRYPOINT: resolve(commandRoots.candidateSource, ...check.subjectEntryPoints[0].split('/')) };
  const commandManifest = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairCommandManifest', candidateId, candidateSourceDigest,
    verificationPolicy: policyRef, gateAttemptId, roots: commandRoots,
    checks: [{ checkId: check.checkId, commandDigest: check.commandDigest, executable: check.executable,
      executableSha256: check.executableSha256, argv: check.argv, cwdKind: check.cwd,
      cwd: join(commandRoots.executionRoot, check.checkId), environment: effectiveCheckEnvironment,
      environmentDigest: canonicalHash(effectiveCheckEnvironment), inputDigest: checkInputDigest,
      inputManifest: materializedInputsRef, inputManifestPath: absoluteInputManifestPath,
      inputManifestDigest: materializedInputsRef.sha256 }],
  };
  const commandManifestRef = refOf(store.putJson(commandManifest));
  const outputRef = refOf(store.putText('P6 fixture Gate output\n'));
  const checkStartedAt = now;
  const checkEndedAt = now;
  const checkObservation = {
    checkId: check.checkId, stageId: check.stageId, required: true, commandDigest: check.commandDigest,
    toolIdentities: ['fixture-gate-driver'], inputDigest: checkInputDigest,
    subjectResolution: subjectResolutionRef, executionTreeDigest, overlayManifest: null,
    startedAt: checkStartedAt, endedAt: checkEndedAt, status: 'passed', exitCode: 0,
    expectedAssertions: check.expectedAssertions, completedAssertions: check.expectedAssertions,
    stdout: outputRef, stderr: outputRef,
  };
  const observationEvidence = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairCheckObservation', candidateId, candidateSourceDigest, baselineId,
    checkId: check.checkId, commandDigest: check.commandDigest, inputDigest: checkInputDigest,
    subjectResolution: subjectResolutionRef, executionTreeDigest, startedAt: checkStartedAt, endedAt: checkEndedAt,
    status: 'passed', exitCode: 0, expectedAssertions: check.expectedAssertions,
    completedAssertions: check.expectedAssertions, stdout: outputRef, stderr: outputRef, captureStatus: 'complete',
  };
  checkObservation.observations = refOf(store.putJson(observationEvidence));
  const verifierPlanRef = refOf(store.putJson({ schemaVersion: 1, kind: 'P6 Fixture Verifier Plan', candidateId, gateAttemptId }));
  const invocationRef = refOf(store.putJson({ schemaVersion: 1, kind: 'P6 Fixture Gate Invocation', gateAttemptId,
    commandManifest: commandManifestRef }));
  const verificationStarted = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationStarted', runId: repairRunId, repairRunId,
    parentRunId, linkId, incidentId, gateNodeId: 'verify', gateAttemptId, candidateId,
    candidateSourceDigest, candidateManifest: candidateRef, gitCandidate: candidate.gitCandidate,
    verificationPolicy: policyRef, verificationInputs: verificationInputsRef, verifierPlan: verifierPlanRef,
    commandManifest: commandManifestRef, testInputManifest: testInputManifestRef, invocation: invocationRef,
    candidateSourceRoot, candidateSourceBefore: candidateSourceDigest,
    freshSourceRoot: join(workspace.canonicalRoot, '.p5', 'verify', 'fresh-source'),
    executionRoot: commandRoots.executionRoot, verifyScratch,
    environmentDigest: canonicalHash(effectiveCheckEnvironment), harnessClosureDigest: installed.a.inputsDigest,
    lifecycleGeneration, engineEpoch: 1, startedAt: now,
  };
  validateP5Contract('verificationStarted', verificationStarted);
  const verificationStartedRef = refOf(store.putJson(verificationStarted));
  const receipt = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReceipt', receiptId: '0'.repeat(64), status: 'passed',
    candidateId, candidateSourceDigest, baselineId, candidateManifest: candidateRef,
    changeManifest: changeManifestRef, gitCandidate: candidate.gitCandidate, selfRepairProfile: profileRef,
    verificationPolicy: policyRef, verificationInputs: verificationInputsRef, repairRunId, linkId, incidentId,
    verificationNodeId: 'verify', gateAttemptId,
    execution: { custodyId, hostIdentity, lifecycleGeneration, engineEpoch: 1, invocationDigest,
      commandManifest: commandManifestRef, executableIdentity: process.execPath,
      harnessClosureDigest: installed.a.inputsDigest, testInputManifest: testInputManifestRef,
      environmentDigest: canonicalHash(effectiveCheckEnvironment) },
    checks: [checkObservation], requiredCheckSetDigest: canonicalHash(['unit-check']),
    completedCheckSetDigest: canonicalHash(['unit-check']), sourceBeforeDigest: candidateSourceDigest,
    sourceAfterDigest: candidateSourceDigest, liveCandidateDigest: candidateSourceDigest,
    harnessAfterDigest: installed.a.inputsDigest, terminalEvidence: gateTerminalRef, captureStatus: 'complete',
    startedAt: now, completedAt: now, observationJournalCursor: 7, issuedJournalCursor: 8,
  };
  receipt.receiptId = p5VerificationReceiptId({ candidateId, verificationPolicyDigest: policyRef.sha256,
    gateAttemptId, custodyId, checks: receipt.checks });
  validateP5Contract('verificationReceipt', receipt);
  const expectedCommandRow = { checkId: check.checkId, commandDigest: check.commandDigest, executable: check.executable,
    executableSha256: check.executableSha256, argv: check.argv, cwdKind: check.cwd,
    cwd: resolve(commandRoots.executionRoot, check.checkId), environment: effectiveCheckEnvironment,
    environmentDigest: canonicalHash(effectiveCheckEnvironment), inputDigest: checkInputDigest,
    inputManifest: materializedInputsRef, inputManifestPath: absoluteInputManifestPath,
    inputManifestDigest: materializedInputsRef.sha256 };
  assert.deepEqual(commandManifest.checks, [expectedCommandRow], 'fixture command manifest must match the production receipt projection');
  assert.deepEqual(testInputManifest.checks, [{ checkId: check.checkId, inputDigest: checkInputDigest,
    subjectResolution: subjectResolutionRef, executionTreeDigest, materializedInputs: materializedInputsRef,
    materializedInputPath, materializedInputDigest: materializedInputsRef.sha256, overlayManifest: null }],
  'fixture test-input manifest must match the production receipt projection');
  const { verifyP5Receipt } = await import('../core/protectedSelfRepair.mjs');
  assert.equal(verifyP5Receipt(receipt, { store, candidateRef, gateAttemptId, terminalEvidenceRef: gateTerminalRef }), true,
    'the fixture handoff is internally consistent under the production P5 receipt validator');
  const receiptArt = store.putJson(receipt);
  const receiptRef = refOf(receiptArt);

  // Authorization record
  const authorization = {
    schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy',
    incidentId, parentRunId, repairRunId,
    parentPublishedVersionId: parentPublication.publishedVersionId,
    parentSnapshotSha256: parentWorkflowSnapshot.sha256,
    repairWorkflowId: repairPublication.workflowId,
    repairPublishedVersionId: repairPublication.publishedVersionId,
    repairSnapshotSha256: repairWorkflowSnapshot.sha256,
    repairWorkspaceId: 'p5-slot', failedNodeInstanceId: 'worker', repairResultNodeInstanceId: 'dev',
    expectedRepairResultSha256: null, acceptanceMode: 'judge_post_execution', failedNodeRetry: 'never',
    selfRepairProfile: profileRef, profile: { selfRepair: store.readJson(rootProfileArt.artifactId) },
    p5Enrollment: enrollmentRef, p5SourceBinding: sourceBindingRef, verificationInputs: verificationInputsRef,
    outcomeId, outcomeRevision,
  };
  const authorizationArt = store.putJson(authorization);
  const authorizationRef = refOf(authorizationArt);

  const currentEligibility = { ...candidateBinding.currentEligibility, checkedAt: now };
  const judgeAttemptId = randomUUID();
  const decisionId = randomUUID();
  const attentionKey = canonicalHash({ kind: 'P6 Fixture Judge Attention', candidateId, receiptId: receipt.receiptId });
  const acceptance = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairAcceptance',
    acceptanceId: canonicalHash({ kind: 'P6 Fixture Acceptance', candidateId, decisionId }),
    candidateManifest: candidateRef, candidateId, candidateSourceDigest,
    verificationReceipt: receiptRef, receiptId: receipt.receiptId, gitCandidate: candidate.gitCandidate,
    currentEligibility, gateAttemptId, parentRunId, repairRunId, linkId, incidentId, decisionId, judgeAttemptId,
    attentionKey, p2Authorization: authorizationRef, sourceIntegrityRevision: canonicalHash({ candidateSourceDigest, baselineId }),
    retentionRevision: 1, requiredReviewSetDigest: canonicalHash([evidenceRef]),
    reviewDelivery: { attentionKey, evidenceArtifact: evidenceRef, expansionArtifact: evidenceRef,
      sourceAttentionKey: attentionKey, sourceDeliveryEventSequence: 1, sourceJudgeAttemptId: judgeAttemptId,
      sourceExpansionArtifact: evidenceRef }, acceptedAt: now,
  };
  validateP5Contract('acceptance', acceptance);
  const acceptanceRef = refOf(store.putJson(acceptance));

  // Synthetic approval is structurally tied to the candidate and receipt. The test does not claim a real Judge action.
  const approval = { schemaVersion: 1, kind: 'ProtectedSelfRepairApproval', decision: 'accept_repair', decisionId,
    judgeAttemptId, protectedSelfRepairAcceptance: acceptanceRef };
  const approvalArt = store.putJson(approval);
  const approvalRef = refOf(approvalArt);

  // P2 Outcome
  const p2Outcome = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairP2Outcome',
    outcomeId: canonicalHash({ kind: 'P6 Fixture P2 Outcome', candidateId, decisionId }),
    parentRunId,
    repairRunId,
    linkId,
    incidentId,
    decisionId,
    candidateId,
    receiptId: receipt.receiptId,
    p2Approval: approvalRef,
    p5Acceptance: acceptanceRef,
    gitCandidate: candidate.gitCandidate,
    currentEligibility,
    resultAttemptId: gateAttemptId,
    resultSha256: '9'.repeat(64),
    failedNodeRetry: 'never',
    continuationState: 'repair_accepted',
    recordedAt: now,
  };
  const outcomeArt = store.putJson(p2Outcome);
  validateP5Contract('p2Outcome', p2Outcome);
  const outcomeRef = refOf(outcomeArt);

  // Retention record
  const retentionRecord = {
    schemaVersion: 1,
    kind: 'ProtectedSelfRepairRetention',
    retentionId: canonicalHash({ kind: 'P6 Fixture Retention', candidateId, receiptId: receipt.receiptId }),
    parentRunId,
    repairRunId,
    linkId,
    incidentId,
    candidateManifest: candidateRef,
    candidateId,
    verificationReceipt: receiptRef,
    receiptId: receipt.receiptId,
    gitCandidate: candidate.gitCandidate,
    workspaceId: workspace.workspaceId,
    allocationId: workspace.allocationId,
    workspaceIdentity: workspace.nativeIdentity,
    status: 'retained',
    revision: 1,
    retainedAt: now,
    cleanupDeferred: true,
  };
  validateP5Contract('retentionRecord', retentionRecord);
  const retentionArt = store.putJson(retentionRecord);
  const retentionRef = refOf(retentionArt);

  const handoff = createP5Handoff({
    candidate: { ...candidate, candidateArtifact: candidateRef },
    receipt: { ...receipt, artifact: receiptRef },
    approval: {
      decision: 'accept_repair',
      judgeAttemptId,
      decisionId,
      authorization: authorizationRef,
      artifact: approvalRef,
      outcome: outcomeRef,
    },
    continuation: { state: 'repair_accepted' },
    retention: {
      status: 'retained',
      revision: 1,
      retainedAt: now,
      cleanupDeferred: true,
      artifact: retentionRef,
    },
    sourceBinding: sourceBindingRef,
    enrollment: enrollmentRef,
    currentEligibility,
  });
  const handoffArt = store.putJson(handoff);

  // 4. Create Parent & Repair run rows and run_links
  const settingsArt = store.putJson({ schemaVersion: 1, kind: 'Settings' });
  const wsParent = 'p5-parent';
  const wsSlot = 'p5-slot';
  const parentWorkspaceRoot = join(root, 'parent-workspace');
  mkdirSync(parentWorkspaceRoot, { recursive: true });
  store.run(
    `INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    wsParent, parentWorkspaceRoot, sha256(parentWorkspaceRoot), now, now
  );
  store.run(
    `INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    wsSlot, slotRoot, sha256(slotRoot), now, now
  );
  store.run(
    `INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'p5-slot-2', slotRoot2, sha256(slotRoot2), now, now
  );
  store.run(
    `INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'p5-slot-3', slotRoot3, sha256(slotRoot3), now, now
  );

  store.run(
    `INSERT INTO workflows(id, kind, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'wf-repair', 'system', repairWorkflowSnapshot.artifactId, now, now
  );
  store.run(
    `INSERT INTO workflows(id, kind, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'wf-parent', 'system', parentWorkflowSnapshot.artifactId, now, now
  );

  const parentDefinitionDigest = canonicalHash(store.readJson(parentWorkflowSnapshot.artifactId));
  const repairDefinitionDigest = canonicalHash(store.readJson(repairWorkflowSnapshot.artifactId));
  for (const [publication, snapshot, definitionDigest] of [
    [parentPublication, parentWorkflowSnapshot, parentDefinitionDigest],
    [repairPublication, repairWorkflowSnapshot, repairDefinitionDigest],
  ]) store.run(`INSERT INTO workflow_publications(id, workflow_id, version, snapshot_artifact_id, definition_digest, execution_hash,
    authority_policy_version, provenance, runnable, validation_json, source_draft_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'workflow-publication/1', 'owner-publication', 1, '{}', NULL, ?)`,
  publication.publishedVersionId, publication.workflowId, publication.version, snapshot.artifactId,
  definitionDigest, definitionDigest, now);

  const checkpointArt = store.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', incidentId, parentRunId, repairRunId,
    parentPublishedVersionId: parentPublication.publishedVersionId, resumeNodeInstanceId: 'worker', targetAttemptId: null });

  store.run(
    `INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence,
       created_at, journal_version, kind, published_version_id, definition_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'workflow', ?, ?)`,
    parentRunId, 'wf-parent', wsParent, parentWorkflowSnapshot.artifactId, settingsArt.artifactId,
    parentDefinitionDigest, 'waiting_for_user', 0, now, parentPublication.publishedVersionId, parentDefinitionDigest
  );
  store.run(
    `INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence,
       created_at, journal_version, kind, published_version_id, definition_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'workflow', ?, ?)`,
    repairRunId, 'wf-repair', wsSlot, repairWorkflowSnapshot.artifactId, settingsArt.artifactId,
    repairDefinitionDigest, 'succeeded', 1, now, repairPublication.publishedVersionId, repairDefinitionDigest
  );

  store.run(
    `INSERT INTO run_links(
      id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
      resume_node_instance_id, candidate_digest, checkpoint_artifact_id, state, continuation_contract,
      incident_id, parent_suspension_state, repair_outcome, decision_status, authorization_artifact_id,
      repair_result_node_instance_id, failed_node_retry, acceptance_mode, repair_approval_artifact_id,
      created_at, updated_at
    ) VALUES (
      ?, 'linked_repair', ?, ?, ?, ?,
      'worker', NULL, ?, 'repair_accepted', 'logical_policy',
      ?, 'suspended_for_repair', 'succeeded', 'accepted', ?,
      'dev', 'never', 'judge_post_execution', ?,
      ?, ?
    )`,
    linkId, parentRunId, repairRunId, wsParent, wsSlot,
    checkpointArt.artifactId,
    incidentId, authorizationArt.artifactId,
    approvalArt.artifactId,
    now, now
  );

  // Journal every projection-bound P5 record in production order. The accepted state remains fixture-authored.
  store.appendEvents(parentRunId, [
    { type: 'self_repair.source_bound', payload: { record: sourceBindingRef }, nodeInstanceId: null, attemptId: null },
  ]);
  store.appendEvents(repairRunId, [
    { type: 'self_repair.preparation_intent', payload: { record: preparationIntentRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.workspace_prepared', payload: { record: candidateBinding.workspacePreparationRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.candidate_capture_started', payload: { record: captureAnchorRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.git_commit_intent', payload: { record: candidateBinding.gitCommitIntentRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.candidate_captured', payload: { record: candidateRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.verification_started', payload: { record: verificationStartedRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.verification_recorded', payload: { record: receiptRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.retention_changed', payload: { record: retentionRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.cleanup_deferred', payload: { record: retentionRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.handoff_recorded', payload: { record: refOf(handoffArt) }, nodeInstanceId: null, attemptId: null },
  ]);

  store.close();

  // 5. Start the real Shell Host with Engine A
  let host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true,
    custody: { allowedExecutables: [{ path: process.execPath, sha256: fileSha256(process.execPath) }] } });

  let storeC = null;
  try {
    let connectionA;
    try {
      connectionA = await freshDescriptor(profile, ENGINE_A, identityProbeConnection.runtimeInstanceId, 60_000);
    } catch (err) {
      console.log('Host events before Engine A descriptor:', JSON.stringify(hostEvents(installation), null, 2));
      const runnerLog = join(profile, 'runtime', 'runner.log');
      if (existsSync(runnerLog)) console.log('Runner log before Engine A descriptor:\n', readFileSync(runnerLog, 'utf8'));
      const hostLog = join(installation, '.deszo-host', 'host.log');
      if (existsSync(hostLog)) console.log('Host log before Engine A descriptor:\n', readFileSync(hostLog, 'utf8'));
      throw err;
    }
    const runA = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(connectionA.applicationBuildId, ENGINE_A);
    assert.equal(connectionA.engineMarker, undefined, 'Engine A carries no Engine marker');
    // A P6 Engine package passes the P5 package-layout gate; only this fixture's policy reason (no causal reproduction) remains.
    const sourceStatusA = await (await fetch(`http://127.0.0.1:${connectionA.port}/api/v2/installation/source-release`, {
      headers: { Authorization: `Bearer ${connectionA.token}` } })).json();
    assert.equal(sourceStatusA.protectedSelfRepair.enrollmentLoaded, true);
    assert.deepEqual(sourceStatusA.protectedSelfRepair.decision.reasons, ['causal_verification'], 'Engine A admission layout and slot checks pass');

    // Trigger P6 autonomous activation
    const triggeredAtB = Date.now();
    const triggerRes = await fetch(`http://127.0.0.1:${connectionA.port}/api/v4/lifecycle/p6-activate/${repairRunId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connectionA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetEngineBuildId: ENGINE_B }),
    });
    assert.equal(triggerRes.status, 202, 'P6 activation trigger accepted');

    // Await switch completion
    try {
      await awaitSwitchVerified(installation, 1, 'the committed Engine B to become ready via autonomous P6 pipeline', triggeredAtB);
    } catch (err) {
      console.log('Host events recorded:', JSON.stringify(hostEvents(installation), null, 2));
      const runnerLog = join(profile, 'runtime', 'runner.log');
      if (existsSync(runnerLog)) {
        console.log('Runner log:\n', readFileSync(runnerLog, 'utf8'));
      }
      const hostLog = join(installation, '.deszo-host', 'host.log');
      if (existsSync(hostLog)) {
        console.log('Host log:\n', readFileSync(hostLog, 'utf8'));
      }
      throw err;
    }

    // Verify Engine B connection and marker
    const operation = lifecycleState(installation).engineOperation;
    const expectedBuildIdB = operation.toBuildId;
    assert.match(expectedBuildIdB, /^engine-[a-f0-9]{12}$/);
    // The consumer names a target-less build from the candidate (p6Consumer.mjs); the route asked for ENGINE_B, so the startup trigger ran.
    assert.equal(expectedBuildIdB, `engine-${candidate.candidateId.slice(0, 12)}`, 'A->B came from Engine A\'s startup projection trigger');
    assert.notEqual(expectedBuildIdB, ENGINE_B);
    let connectionB = await freshDescriptor(profile, expectedBuildIdB, connectionA.runtimeInstanceId, 60_000);
    assert.equal(connectionB.applicationBuildId, expectedBuildIdB);
    assert.equal(connectionB.engineMarker, 'engine-b', 'Engine B carries the engine-b marker!');

    // Verify protocol ordering in Host journal
    const types = [
      'engine_staged',
      'engine_switch_accepted',
      'engine_preflight_passed',
      'engine_store_boundary_verified',
      'engine_switch_committed',
      'engine_switch_verified',
    ];
    const indices = types.map(type => hostEvents(installation).findIndex(e => e.type === type));
    indices.forEach((idx, i) => assert.ok(idx >= 0, `Host journal recorded ${types[i]}`));
    assert.deepEqual([...indices].sort((x, y) => x - y), indices, 'events occur in strict protocol order');

    // Verify atomic selector points to ENGINE_B
    const selector = activeSelector(installation);
    assert.equal(selector.buildId, expectedBuildIdB);

    // Verify operation verified in lifecycle.json
    assert.equal(operation.phase, 'verified');
    assert.equal(operation.fallbackAttempted, false);
    assert.equal(operation.toBuildId, expectedBuildIdB);

    // Verify Engine A stopped and Engine B running
    assert.equal(processAlive(runA.enginePid), false, 'Engine A was terminated after switch');
    let runB = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(runB.buildId, expectedBuildIdB);
    assert.equal(processAlive(runB.enginePid), true, 'Engine B is running');

    // Verify Shell and Host executables unchanged (Host immutability)
    assert.equal(fileSha256(join(installation, 'shell', 'deszo.exe')), shellBefore, 'Shell executable unchanged');
    assert.equal(fileSha256(hostExe), hostBefore, 'Host executable unchanged');

    // Verify P6BuildReceipt recorded in command_receipts
    const db = new DatabaseSync(join(profile, 'store', 'state.sqlite'), { readOnly: true });
    let buildReceiptArtifactId;
    try {
      const receiptRows = db.prepare('SELECT * FROM command_receipts WHERE command = ?').all('p6.build');
      assert.ok(receiptRows.length >= 1, 'P6 build receipt recorded in command_receipts');
      assert.equal(receiptRows[0].payload_sha256, operation.packageSha256);
      buildReceiptArtifactId = receiptRows[0].response_artifact_id;
    } finally {
      db.close();
    }
    const receiptStore = new Store(profile);
    try {
      const buildReceipt = receiptStore.readJson(buildReceiptArtifactId);
      assert.equal(resolve(buildReceipt.builderIdentity.esbuildPackage.path),
        resolve(installation, 'versions', ENGINE_A, 'p5', 'node_modules', 'esbuild', 'package.json'),
      'the builder identity names Engine A’s exact installed P5 esbuild package');
    } finally { receiptStore.close(); }

    // Verify Engine B serves owner API
    const served = await fetch(`http://127.0.0.1:${connectionB.port}/api/v2/settings`, {
      headers: { Authorization: `Bearer ${connectionB.token}` },
    });
    assert.equal(served.status, 200, 'Engine B serves API');

    const sourceStatusB = await fetch(`http://127.0.0.1:${connectionB.port}/api/v2/installation/source-release`, {
      headers: { Authorization: `Bearer ${connectionB.token}` },
    });
    assert.equal(sourceStatusB.status, 200);
    const runningB = await sourceStatusB.json();
    assert.equal(runningB.protectedSelfRepair.enrollmentLoaded, true, 'B resolved P5 continuation from Host status');
    assert.deepEqual(runningB.protectedSelfRepair.decision.reasons, ['causal_verification'], 'Engine B admission layout and slot checks pass');

    // B -> C below uses another fixture-authored handoff and test-only activation route. It verifies
    // consecutive package/Host/continuation lineage, not a second real P5 Developer/Gate/Judge run.
    storeC = new Store(profile);
    const parentRunIdC = randomUUID();
    const repairRunIdC = randomUUID();
    const linkIdC = randomUUID();
    const incidentIdC = randomUUID();

    // Create candidate C entries (with engine-c marker)
    const markerBytesC = Buffer.from("export const P6_G0_ENGINE_MARKER = 'engine-c';\n", 'utf8');
    const markerArtC = storeC.putBytes(markerBytesC, 'application/octet-stream');
    const entriesC = entries.map(e => {
      if (e.path === 'runtime/p6-g0-engine-marker.mjs') {
        return {
          path: e.path,
          type: 'regular',
          executable: false,
          byteSize: markerBytesC.length,
          sha256: sha256(markerBytesC),
          artifact: { artifactId: markerArtC.artifactId, sha256: markerArtC.sha256 },
        };
      }
      return e;
    });
    entriesC.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const cleanEntriesC = entriesC.map(({ artifact: _a, ...e }) => e);
    const candidateSourceDigestC = p5SourceDigest(cleanEntriesC);

    const sourceManifestC = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairSourceManifest',
      sourceDigest: candidateSourceDigestC,
      entries: entriesC,
    };
    validateP5Contract('sourceManifest', sourceManifestC);
    const sourceManifestArtC = storeC.putJson(sourceManifestC);

    const continuationBRow = storeC.get(`SELECT response_artifact_id FROM command_receipts WHERE request_id = ? AND command = ?`,
      `p6-continuation-${operation.operationId}`, 'p6.continuation');
    assert.ok(continuationBRow?.response_artifact_id, 'Engine B wrote a durable Host-bound continuation receipt');
    const continuationB = storeC.readJson(continuationBRow.response_artifact_id);
    const successorProfileB = storeC.readJson(storeC.verifyRef(continuationB.successorProfile).artifactId);
    const successorBaselineB = storeC.readJson(storeC.verifyRef(successorProfileB.baseline).artifactId);
    const releaseB = storeC.readJson(storeC.verifyRef(successorProfileB.runningSourceRelease).artifactId);
    assert.equal(canonicalHash(releaseB), canonicalHash(runningB.release));
    assert.equal(releaseB.committedOperationId, operation.operationId);
    const rootEnrollment = storeC.readJson(enrollmentArt.artifactId);
    const { effectiveEnrollment: effectiveEnrollmentB } = resolveP6Continuation({ store: storeC, rootEnrollment,
      runningSourceRelease: runningB.release, installationId: runningB.installationId,
      hostSwitchStatus: continuationB.hostSwitchStatus });
    validateP5Contract('enrollment', effectiveEnrollmentB);
    const enrollmentBArtifact = storeC.putJson(effectiveEnrollmentB);
    const enrollmentBRef = { artifactId: enrollmentBArtifact.artifactId, sha256: enrollmentBArtifact.sha256 };
    const readinessTimeline = hostEvents(installation).filter(event => Number(event.at) >= triggeredAtB).map(event => ({
      at: Number(event.at), type: event.type, hostPid: event.hostPid, ...Object.fromEntries(['applicationPid', 'enginePid', 'pid', 'buildId',
        'engineBuildId', 'generation', 'operationId', 'packageSha256'].filter(key => event.payload?.[key] != null).map(key => [key, event.payload[key]])) }));
    console.log('P6-UNBLOCK B readiness evidence:', JSON.stringify({ operation: { ...operation, storeEvidence: undefined }, selector,
      readinessTimeline, shellSha256: shellBefore, hostSha256: hostBefore, engineAPid: runA.enginePid, engineBPid: runB.enginePid,
      release: runningB.release, protectedSelfRepair: runningB.protectedSelfRepair, continuationReceipt: continuationBRow.response_artifact_id }));

    // P6-BUILD-UNBLOCK M3 / section 13: a fresh P5 managed clone in the Host-selected Engine B. B itself runs its production
    // preparation (materializeProtectedSelfRepairPreparation -> prepareP5WorkspaceFromIntent) with its own Host readers. The enrolled
    // origin holds only A's history; B's accepted commit exists only in the immutable Store evidence of B's committed release. The
    // queued Parent/Repair/P2 rows are fixture-authored (P5 admission is not under test here); every check on them is production code.
    const gitAt = (cwd, args) => execFileSync(sources.gitPath, ['-c', 'protocol.file.allow=always', '--no-optional-locks', '-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim();
    const localSourceB = effectiveEnrollmentB.gitSource.verifiedLocalSource;
    const commitA = rootEnrollment.gitSource.sourceCommit, commitB = runningB.release.sourceCommit, treeB = successorBaselineB.baseTree;
    const originUrl = effectiveEnrollmentB.gitSource.remote.url;
    assert.ok(localSourceB, 'B\'s effective enrollment carries the release-bound Store-backed Git source');
    assert.deepEqual({ sourceCommit: localSourceB.sourceCommit, sourceTree: localSourceB.sourceTree, operationId: localSourceB.operationId,
      engineBuildId: localSourceB.engineBuildId, packageSha256: localSourceB.packageSha256, continuationReceipt: localSourceB.continuationReceipt.artifactId },
    { sourceCommit: commitB, sourceTree: treeB, operationId: operation.operationId, engineBuildId: expectedBuildIdB,
      packageSha256: operation.packageSha256, continuationReceipt: continuationBRow.response_artifact_id });
    assert.equal(effectiveEnrollmentB.gitSource.sourceCommit, commitB);
    assert.deepEqual(effectiveEnrollmentB.gitSource.fetchRefs, rootEnrollment.gitSource.fetchRefs, 'the enrolled fetch refs are unchanged');
    assert.deepEqual(effectiveEnrollmentB.gitSource.publication, rootEnrollment.gitSource.publication, 'the publication policy is unchanged');
    assert.equal(effectiveEnrollmentB.gitSource.publication.enabled, false);
    assert.equal(gitAt(sources.cloneB, ['rev-parse', `${commitB}^`]), commitA, 'B is the accepted successor of the enrolled A baseline');
    const originRefsBefore = gitAt(sources.cloneA, ['for-each-ref', '--format=%(refname) %(objectname)']);
    assert.ok(!gitAt(sources.cloneA, ['ls-remote', originUrl]).includes(commitB), 'the enrolled origin does not advertise B');
    // Negative baseline: the enrolled origin cannot serve B by object ID.
    const directProbe = join(root, 'b-direct-fetch.git');
    gitAt(root, ['init', '--quiet', '--bare', directProbe]);
    const directFetch = spawnSync(sources.gitPath, ['-c', 'protocol.file.allow=always', '-C', directProbe, 'fetch', '--quiet', '--no-write-fetch-head',
      originUrl, commitB], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    assert.notEqual(directFetch.status, 0, 'git fetch <enrolled origin> <B> is refused');

    // A fresh queued Repair for one enrollment value: its own Parent and P3 outcome, P2 link and journaled preparation intent.
    const freshRepair = (label, enrollmentValue) => {
      const enrollmentRefF = refOf(storeC.putJson(enrollmentValue));
      const profileF = storeC.readJson(storeC.verifyRef(enrollmentValue.profile).artifactId);
      const baselineF = storeC.readJson(storeC.verifyRef(enrollmentValue.baselineManifest).artifactId);
      const parentRunIdF = randomUUID(), repairRunIdF = randomUUID(), linkIdF = randomUUID(), incidentIdF = randomUUID(), outcomeIdF = randomUUID();
      const at = new Date().toISOString();
      const parentWorkspaceF = `p5-parent-${label}`, parentRootF = join(root, `parent-workspace-${label}`);
      mkdirSync(parentRootF, { recursive: true });
      storeC.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', parentWorkspaceF, parentRootF, sha256(parentRootF), at, at);
      const insertRun = (id, workflowId, workspaceId, snapshot, state, publication, digest) => storeC.run(`INSERT INTO runs(id, workflow_id, workspace_id,
        workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at, journal_version, kind, published_version_id,
        definition_digest) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 2, 'workflow', ?, ?)`, id, workflowId, workspaceId, snapshot.artifactId, settingsArt.artifactId,
      digest, state, at, publication.publishedVersionId, digest);
      insertRun(parentRunIdF, 'wf-parent', parentWorkspaceF, parentWorkflowSnapshot, 'waiting_for_user', enrollmentValue.parentPublication, parentDefinitionDigest);
      insertRun(repairRunIdF, 'wf-repair', enrollmentValue.workspace.workspaceId, repairWorkflowSnapshot, 'queued', enrollmentValue.repairPublication, repairDefinitionDigest);
      storeC.run('INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, ?)', parentRunIdF, 'worker', 'worker', 'agent', 'failed');
      storeC.run('INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, 1, ?)', outcomeIdF, parentRunIdF, 'worker', 'failed');
      const evidenceF = storeC.putText(`P6-BUILD-UNBLOCK fresh Engine B Repair incident evidence (${label})`);
      const outcome = makeFailureOutcome({ run: storeC.get('SELECT * FROM runs WHERE id = ?', parentRunIdF),
        attempt: { id: outcomeIdF, node_instance_id: 'worker', state: 'failed' }, source: 'provider', code: 'provider_unavailable',
        attemptState: 'failed', runState: 'waiting_for_user', executionCertainty: 'completed', sideEffectCertainty: 'none_proven',
        causeKnowledge: 'direct_fact', evidenceReferences: [{ type: 'artifact', id: evidenceF.artifactId, sha256: evidenceF.sha256 }], recordedAt: at });
      storeC.appendEvents(parentRunIdF, [{ type: 'attempt.failure_outcome', payload: { outcome }, nodeInstanceId: 'worker', attemptId: outcomeIdF }]);
      const inputs = captureP5VerificationInputs({ store: storeC, enrollment: enrollmentValue, profile: profileF, parentRunId: parentRunIdF,
        incidentId: incidentIdF, outcome });
      const sourceBindingRefF = refOf(storeC.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId: enrollmentValue.enrollmentId,
        parentRunId: parentRunIdF, parentPublication: enrollmentValue.parentPublication, parentSnapshot: refOf(parentWorkflowSnapshot),
        baselineId: enrollmentValue.baselineId, baselineManifest: enrollmentValue.baselineManifest, profile: enrollmentValue.profile,
        runningSourceRelease: enrollmentValue.runningSourceRelease, runtimeInstanceId: connectionB.runtimeInstanceId,
        lifecycleGeneration: connectionB.applicationGeneration, boundAt: at }));
      storeC.appendEvents(parentRunIdF, [{ type: 'self_repair.source_bound', payload: { record: sourceBindingRefF } }]);
      const authorization = storeC.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy', incidentId: incidentIdF,
        parentRunId: parentRunIdF, repairRunId: repairRunIdF, parentPublishedVersionId: enrollmentValue.parentPublication.publishedVersionId,
        parentSnapshotSha256: enrollmentValue.parentPublication.snapshotSha256, repairWorkflowId: enrollmentValue.repairPublication.workflowId,
        repairPublishedVersionId: enrollmentValue.repairPublication.publishedVersionId, repairSnapshotSha256: enrollmentValue.repairPublication.snapshotSha256,
        repairWorkspaceId: enrollmentValue.workspace.workspaceId, failedNodeInstanceId: 'worker', repairResultNodeInstanceId: 'dev',
        expectedRepairResultSha256: null, failedNodeRetry: 'never', selfRepairProfile: enrollmentValue.profile, profile: { selfRepair: enrollmentValue.profile },
        p5Enrollment: enrollmentRefF, p5SourceBinding: sourceBindingRefF, verificationInputs: inputs.artifact, outcomeId: outcomeIdF,
        outcomeRevision: outcome.revision });
      const checkpoint = storeC.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', incidentId: incidentIdF, parentRunId: parentRunIdF,
        repairRunId: repairRunIdF, parentPublishedVersionId: enrollmentValue.parentPublication.publishedVersionId, resumeNodeInstanceId: 'worker',
        targetAttemptId: null });
      storeC.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id,
        checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state, decision_status, authorization_artifact_id,
        repair_result_node_instance_id, failed_node_retry, acceptance_mode, created_at, updated_at)
        VALUES (?, 'linked_repair', ?, ?, ?, ?, 'worker', ?, 'open', 'logical_policy', ?, 'suspended_for_repair', 'pending', ?, 'dev', 'never',
        'judge_post_execution', ?, ?)`, linkIdF, parentRunIdF, repairRunIdF, parentWorkspaceF, enrollmentValue.workspace.workspaceId,
      checkpoint.artifactId, incidentIdF, authorization.artifactId, at, at);
      const intentValue = { schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: enrollmentRefF,
        baselineManifest: enrollmentValue.baselineManifest, sourceManifest: baselineF.sourceManifest, sourceBinding: sourceBindingRefF,
        verificationInputs: inputs.artifact, parentRunId: parentRunIdF, repairRunId: repairRunIdF, linkId: linkIdF,
        workspace: enrollmentValue.workspace, createdAt: at };
      validateP5Contract('preparationIntent', intentValue);
      const intentRefF = refOf(storeC.putJson(intentValue));
      storeC.appendEvents(repairRunIdF, [{ type: 'self_repair.preparation_intent', payload: { record: intentRefF } }]);
      return { intentRef: intentRefF, parentRunId: parentRunIdF, repairRunId: repairRunIdF, linkId: linkIdF };
    };
    const retireRepair = fresh => {
      storeC.run(`UPDATE runs SET state = 'canceled' WHERE id IN (?, ?)`, fresh.parentRunId, fresh.repairRunId);
      storeC.run(`UPDATE run_links SET state = 'blocked', parent_suspension_state = 'blocked' WHERE id = ?`, fresh.linkId);
    };
    // A refused preparation leaves its partial slot in place (P5 never cleans it); the test empties Engine B's slot, keeping its identity.
    const slotRootB = effectiveEnrollmentB.workspace.canonicalRoot;
    const emptySlot = () => {
      const writable = path => { for (const name of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, name.name);
        if (name.isDirectory()) writable(child); else chmodSync(child, 0o666);
      } };
      writable(slotRootB);
      for (const name of readdirSync(slotRootB)) rmSync(join(slotRootB, name), { recursive: true, force: true });
      assert.deepEqual(readdirSync(slotRootB), []);
    };
    const materializeInB = (intentRef, recovery = false) =>
      probeEngine(profile, expectedBuildIdB, { action: 'p5_materialize_preparation', intentRef, recovery }, 600_000);

    // 1. Without its release-bound local source, the same B enrollment fails closed: the origin cannot provide B (F-15 on real B).
    const { verifiedLocalSource: _withheld, ...remoteOnlyGitSource } = effectiveEnrollmentB.gitSource;
    const remoteOnly = freshRepair('remote-only', { ...effectiveEnrollmentB, gitSource: remoteOnlyGitSource });
    const remoteOnlyResult = await materializeInB(remoteOnly.intentRef);
    assert.equal(remoteOnlyResult.ok, false);
    assert.equal(remoteOnlyResult.code, 'p5_git_source_commit_unavailable', remoteOnlyResult.message);
    retireRepair(remoteOnly); emptySlot();
    // 2. A local source naming another commit is refused through the same preparation path before any object is written.
    const substituted = freshRepair('substituted-commit', { ...effectiveEnrollmentB,
      gitSource: { ...effectiveEnrollmentB.gitSource, verifiedLocalSource: { ...localSourceB, sourceCommit: commitA } } });
    const substitutedResult = await materializeInB(substituted.intentRef);
    assert.equal(substitutedResult.ok, false);
    assert.equal(substitutedResult.code, 'p5_git_local_source_invalid', substitutedResult.message);
    retireRepair(substituted); emptySlot();

    // 3. The exact descriptor: B prepares a fresh managed clone whose HEAD and tree are its own installed release.
    const freshB = freshRepair('b-clone', effectiveEnrollmentB);
    const preparedB = await materializeInB(freshB.intentRef);
    assert.equal(preparedB.ok, true, `Engine B prepared its fresh managed clone: ${preparedB.code} ${preparedB.message}`);
    assert.equal(preparedB.buildId, expectedBuildIdB, 'the Host-selected Engine B performed the preparation');
    assert.equal(preparedB.value.loadedEnrollment.sha256, enrollmentBRef.sha256, 'the intent names the exact enrollment B loaded at startup');
    const repositoryB = preparedB.value.evidence.gitRepository;
    const fetchProvenanceB = storeC.readJson(storeC.verifyRef(repositoryB.fetchProvenance).artifactId);
    assert.equal(fetchProvenanceB.strategy, 'store-objects+enrolled-refs');
    assert.deepEqual(fetchProvenanceB.refspecs, ['refs/heads/main'], 'only the Owner-enrolled ref was fetched');
    assert.equal(canonicalHash(fetchProvenanceB.localObjectSource), canonicalHash(localSourceB), 'the exact release-bound descriptor was used');
    assert.deepEqual([repositoryB.seedCommit, repositoryB.seedTree, repositoryB.sourceAncestryVerified], [commitB, treeB, true]);
    const cloneRoot = join(slotRootB, 'source');
    const headB = gitAt(cloneRoot, ['rev-parse', 'HEAD']), headTreeB = gitAt(cloneRoot, ['rev-parse', 'HEAD^{tree}']);
    assert.equal(headB, commitB, 'the fresh clone checks out the installed B commit');
    assert.equal(headTreeB, treeB, 'the fresh clone tree is the verified B tree');
    assert.equal(gitAt(cloneRoot, ['rev-parse', 'HEAD^']), commitA, 'its history descends from the enrolled A baseline');
    assert.equal(gitAt(cloneRoot, ['status', '--porcelain=v2', '--untracked-files=all']), '', 'the working tree is exactly B');
    assert.equal(gitAt(cloneRoot, ['remote']), '', 'the private clone has no remote');
    assert.deepEqual(gitAt(cloneRoot, ['for-each-ref', '--format=%(refname)']).split(/\r?\n/), [`refs/heads/${repositoryB.repairBranch}`]);
    assert.equal(storeC.readEvents(freshB.repairRunId).filter(item => item.type === 'self_repair.workspace_prepared').length, 1);
    // Restart and duplicate: recovery rematerializes from the journaled Store evidence and returns the same record; a second fresh
    // preparation of the same slot is refused rather than creating another workspace.
    const recoveredB = await materializeInB(freshB.intentRef, true);
    assert.equal(recoveredB.ok, true, `recovery: ${recoveredB.code} ${recoveredB.message}`);
    assert.equal(canonicalHash(recoveredB.value.evidence), canonicalHash(preparedB.value.evidence), 'recovery is idempotent');
    const duplicateB = await materializeInB(freshB.intentRef);
    assert.equal(duplicateB.ok, false);
    assert.equal(duplicateB.code, 'p5_workspace_conflict', duplicateB.message);
    assert.equal(storeC.readEvents(freshB.repairRunId).filter(item => item.type === 'self_repair.workspace_prepared').length, 1);
    assert.equal(gitAt(cloneRoot, ['rev-parse', 'HEAD']), commitB);
    retireRepair(freshB);
    assert.equal(gitAt(sources.cloneA, ['for-each-ref', '--format=%(refname) %(objectname)']), originRefsBefore, 'nothing was published to the origin');
    assert.ok(!gitAt(sources.cloneA, ['ls-remote', originUrl]).includes(commitB), 'B is still not advertised by the origin');
    // The single-use slot is emptied (identity kept) before the synthetic C records name it again.
    emptySlot();

    // 4. The trust boundary on B's real evidence chain: every substitution is refused by the verifier both preparation paths call first.
    const verifyLocal = (sourceChanges = {}, enrollmentChanges = {}) => verifyP6GitObjectSource({ store: storeC, baseline: successorBaselineB,
      enrollment: { ...effectiveEnrollmentB, ...enrollmentChanges,
        gitSource: { ...effectiveEnrollmentB.gitSource, verifiedLocalSource: { ...localSourceB, ...sourceChanges } } } });
    const verifiedB = verifyLocal();
    assert.equal(verifiedB.provenance.sourceCommit, commitB);
    const substitutions = {
      'different commit': () => verifyLocal({ sourceCommit: commitA }),
      'different tree': () => verifyLocal({ sourceTree: rootEnrollment.baseTree }),
      'different repository': () => verifyLocal({ sourceRepositoryId: 'another-enrolled-repository' }),
      'different repository identity': () => verifyLocal({ repositoryIdentityDigest: canonicalHash({ ...rootEnrollment.repositoryIdentity, enrollmentId: randomUUID() }) }),
      'different Host release': () => verifyLocal({}, { runningSourceRelease: rootEnrollment.runningSourceRelease }),
      'another installed Engine': () => verifyLocal({ engineBuildId: ENGINE_A }),
      'another Host operation': () => verifyLocal({ operationId: randomUUID() }),
      'missing Store artifact': () => verifyLocal({ handoff: { artifactId: randomUUID(), sha256: localSourceB.handoff.sha256 } }),
      'changed Store artifact': () => verifyLocal({ handoff: { ...localSourceB.handoff, sha256: 'f'.repeat(64) } }),
      'wrong predecessor and parent': () => verifyLocal({ predecessorEnrollment: enrollmentBRef }),
      'invalid continuation': () => verifyLocal({ continuationReceipt: localSourceB.buildReceipt }),
      'invalid build receipt': () => verifyLocal({ buildReceipt: localSourceB.continuationReceipt }),
    };
    const refusalCodes = {};
    for (const [label, attempt] of Object.entries(substitutions)) {
      assert.throws(attempt, error => { refusalCodes[label] = error.code; return error.code === 'p5_git_local_source_invalid'; }, label);
    }
    // Missing parents, partial objects and a lost local object database, on B's exact Store evidence.
    const objectsOnly = join(root, 'b-store-objects.git');
    gitAt(root, ['init', '--quiet', '--bare', '--object-format=sha1', objectsOnly]);
    const storeGitTool = { path: sources.gitPath };
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: storeGitTool, repositoryRoot: objectsOnly,
      provenance: { ...verifiedB.provenance, gitObjects: verifiedB.provenance.gitObjects.slice(1) } }),
    error => error.code === 'p5_git_local_source_invalid', 'a partial object set is never accepted');
    for (const provenance of verifiedB.provenanceChain) materializeVerifiedP6GitObjects({ gitTool: storeGitTool, repositoryRoot: objectsOnly, provenance });
    assert.equal(gitAt(objectsOnly, ['rev-parse', `${commitB}^{tree}`]), treeB, 'B is rebuilt from immutable Store evidence alone');
    assert.throws(() => verifyP5GitHistoryComplete({ gitTool: storeGitTool, repositoryRoot: objectsOnly, sourceCommit: commitB }),
      error => error.code === 'p5_git_source_ancestry_incomplete', 'B without its parent objects is not complete history');
    fetchP5EnrolledGitRefs({ gitTool: storeGitTool, repositoryRoot: objectsOnly, gitSource: effectiveEnrollmentB.gitSource });
    const historyLength = verifyP5GitHistoryComplete({ gitTool: storeGitTool, repositoryRoot: objectsOnly, sourceCommit: commitB }).historyLength;
    assert.equal(gitAt(objectsOnly, ['for-each-ref']), '', 'fetching enrolled refs wrote no ref');
    console.log('P6-UNBLOCK fresh B managed clone evidence:', JSON.stringify({ repositoryIdentity: effectiveEnrollmentB.repositoryIdentity,
      sourceRepositoryId: effectiveEnrollmentB.gitSource.sourceRepositoryId, remote: effectiveEnrollmentB.gitSource.remote,
      fetchRefs: effectiveEnrollmentB.gitSource.fetchRefs, publication: effectiveEnrollmentB.gitSource.publication, commitA, commitB, treeB,
      objectFormat: localSourceB.objectFormat, operationId: localSourceB.operationId, packageSha256: localSourceB.packageSha256,
      continuationReceipt: localSourceB.continuationReceipt, buildReceipt: localSourceB.buildReceipt, localSourceDigest: canonicalHash(localSourceB),
      directFetch: { status: directFetch.status, stderr: directFetch.stderr.trim() }, remoteOnly: remoteOnlyResult.code, substituted: substitutedResult.code,
      preparation: preparedB.value.evidenceArtifact, preparedBy: { buildId: preparedB.buildId, pid: preparedB.applicationPid }, repairBranch: repositoryB.repairBranch,
      headB, headTreeB, fetchProvenance: { strategy: fetchProvenanceB.strategy, refspecs: fetchProvenanceB.refspecs }, duplicate: duplicateB.code,
      refusalCodes, storeObjectsHistoryLength: historyLength, originRefs: originRefsBefore }));
    // Restart with B committed and verified (P6-BUILD-UNBLOCK section 9): the Host starts B again, never A, keeps the operation identity
    // and its single verification, and B replays its Host-bound continuation without a second receipt. The same Host configuration
    // (initial build A) is used, so the durable selector, not the configuration, decides. Probe commands already answered by this B
    // process are removed so the restarted B does not replay them.
    const continuationRows = () => storeC.all(`SELECT request_id, response_artifact_id, payload_sha256 FROM command_receipts
      WHERE command = 'p6.continuation' ORDER BY request_id`);
    const continuationRowsBefore = continuationRows();
    const verifiedBefore = hostEvents(installation).filter(event => event.type === 'engine_switch_verified').length;
    const restartFrom = hostEvents(installation).length;
    for (const name of readdirSync(join(profile, 'p6-probe'))) if (name.includes(`-${expectedBuildIdB}-`)) rmSync(join(profile, 'p6-probe', name));
    await host.stop();
    assert.equal(processAlive(runB.enginePid), false, 'the stopped Host ended Engine B');
    host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true,
      custody: { allowedExecutables: [{ path: process.execPath, sha256: fileSha256(process.execPath) }] } });
    connectionB = await freshDescriptor(profile, expectedBuildIdB, connectionB.runtimeInstanceId, 300_000);
    await eventually(() => hostEvents(installation).slice(restartFrom).some(event => event.type === 'engine_ready'), 'the restarted Engine B readiness', 120_000, 200);
    const restartEvents = hostEvents(installation).slice(restartFrom);
    assert.deepEqual(restartEvents.filter(event => event.type === 'application_spawned').map(event => event.payload.buildId), [expectedBuildIdB],
      'the restarted Host launched exactly one Engine, the committed B');
    runB = restartEvents.filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(runB.buildId, expectedBuildIdB);
    assert.equal(processAlive(runB.enginePid), true, 'the restarted Engine B is running');
    assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_verified').length, verifiedBefore,
      'readiness after the restart is not another activation');
    const restartedOperation = lifecycleState(installation).engineOperation;
    assert.deepEqual([restartedOperation.operationId, restartedOperation.phase, restartedOperation.toBuildId, restartedOperation.packageSha256,
      restartedOperation.fallbackAttempted], [operation.operationId, 'verified', expectedBuildIdB, operation.packageSha256, false]);
    // Every Host start serves the selection under a fresh lifecycle generation (lib.rs reconcile); the selection itself is unchanged.
    const { generation: generationAfter, ...selectionAfter } = activeSelector(installation);
    const { generation: generationBefore, ...selectionBefore } = selector;
    assert.deepEqual(selectionAfter, selectionBefore, 'the committed selection (build, digest, operation) is unchanged');
    assert.notEqual(generationAfter, generationBefore);
    assert.equal(runB.generation, generationAfter, 'the restarted B runs under the selector generation');
    const restartedSource = await (await fetch(`http://127.0.0.1:${connectionB.port}/api/v2/installation/source-release`, {
      headers: { Authorization: `Bearer ${connectionB.token}` } })).json();
    assert.equal(restartedSource.protectedSelfRepair.enrollmentLoaded, true, 'B resolves its continuation again after the restart');
    assert.equal(canonicalHash(restartedSource.release), canonicalHash(runningB.release));
    assert.deepEqual(continuationRows(), continuationRowsBefore, 'the continuation replays its durable receipt; no second receipt exists');
    console.log('P6-UNBLOCK B restart evidence:', JSON.stringify({ restartEvents: restartEvents.map(event => ({ at: Number(event.at), type: event.type,
      hostPid: event.hostPid, buildId: event.payload?.buildId, applicationPid: event.payload?.applicationPid, enginePid: event.payload?.enginePid })),
    operation: { operationId: restartedOperation.operationId, phase: restartedOperation.phase }, continuationRows: continuationRows() }));

    const baselineIdC = successorProfileB.baselineId;
    const baseCommitC = successorBaselineB.baseCommit;
    const baseTreeC = successorBaselineB.baseTree;
    const baseSourceDigestC = successorBaselineB.effectiveSourceDigest;
    const nowC = new Date().toISOString();
    const outcomeIdC = randomUUID();
    const outcomeRevisionC = 1;
    const profileRefC = continuationB.successorProfile;
    const policyRefC = successorProfileB.verificationPolicy;
    const policyC = storeC.readJson(storeC.verifyRef(policyRefC).artifactId);
    // Continuation advances to the successor's pool entry (the effective enrollment's workspace), and P5 receipt lineage requires the
    // candidate's workspace to be that entry.
    const workspaceC = { ...effectiveEnrollmentB.workspace };
    workspaceC.sourceRoot = resolve(workspaceC.canonicalRoot, 'source');
    mkdirSync(workspaceC.sourceRoot, { recursive: true });
    const verificationInputsC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationInputs', incidentId: incidentIdC,
      outcomeId: outcomeIdC, outcomeRevision: outcomeRevisionC, verificationPolicy: policyRefC,
      inputs: [{ selector: 'p3-outcome-artifacts', artifact: incidentRef, sourceOutcomeId: outcomeIdC,
        sourceRevision: outcomeRevisionC }], capturedAt: nowC,
    };
    validateP5Contract('verificationInputs', verificationInputsC);
    const verificationInputsArtC = storeC.putJson(verificationInputsC);
    const verificationInputsRefC = { artifactId: verificationInputsArtC.artifactId, sha256: verificationInputsArtC.sha256 };
    const sourceBindingC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId: effectiveEnrollmentB.enrollmentId,
      parentRunId: parentRunIdC, parentPublication, parentSnapshot: refOf(parentWorkflowSnapshot),
      baselineId: baselineIdC, baselineManifest: successorProfileB.baseline, profile: profileRefC,
      runningSourceRelease: continuationB.successorRelease, runtimeInstanceId: connectionB.runtimeInstanceId,
      lifecycleGeneration: connectionB.applicationGeneration, boundAt: nowC,
    };
    validateP5Contract('sourceBinding', sourceBindingC);
    const sourceBindingArtC = storeC.putJson(sourceBindingC);
    const sourceBindingRefC = { artifactId: sourceBindingArtC.artifactId, sha256: sourceBindingArtC.sha256 };
    const pathDigestC = sha256(Buffer.from(cleanEntriesC.map(entry => `${entry.path}\0`).join(''), 'ascii'));
    const contentDigestC = sha256(Buffer.from(cleanEntriesC.map(entry => `${entry.path}\0${entry.byteSize}\0${entry.sha256}\n`).join(''), 'ascii'));
    const sourceCaptureEvidenceC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairSourceCaptureEvidence', sourceRoot: workspaceC.sourceRoot,
      rootIdentity: workspaceC.nativeIdentity, hostPid: process.pid, generation: connectionB.applicationGeneration,
      epoch: 1, snapshotDigestBefore: candidateSourceDigestC, snapshotDigestAfter: candidateSourceDigestC,
      pathDigest: pathDigestC, contentDigest: contentDigestC, fileCount: cleanEntriesC.length,
      totalBytes: cleanEntriesC.reduce((sum, entry) => sum + entry.byteSize, 0),
    };
    validateP5Contract('sourceCaptureEvidence', sourceCaptureEvidenceC);
    const sourceCaptureArtC = storeC.putJson(sourceCaptureEvidenceC);
    const sourceCaptureRefC = { artifactId: sourceCaptureArtC.artifactId, sha256: sourceCaptureArtC.sha256 };
    const baselineSourceManifestB = storeC.readJson(storeC.verifyRef(successorBaselineB.sourceManifest).artifactId);
    const preparationIntentC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: enrollmentBRef,
      baselineManifest: successorProfileB.baseline, sourceManifest: successorBaselineB.sourceManifest,
      sourceBinding: sourceBindingRefC, verificationInputs: verificationInputsRefC,
      parentRunId: parentRunIdC, repairRunId: repairRunIdC, linkId: linkIdC,
      workspace: { workspaceId: workspaceC.workspaceId, allocationId: workspaceC.allocationId,
        canonicalRoot: workspaceC.canonicalRoot, nativeIdentity: workspaceC.nativeIdentity }, createdAt: nowC,
    };
    validateP5Contract('preparationIntent', preparationIntentC);
    const preparationIntentArtC = storeC.putJson(preparationIntentC);
    const preparationIntentRefC = { artifactId: preparationIntentArtC.artifactId, sha256: preparationIntentArtC.sha256 };
    const beforeByPathC = new Map(baselineSourceManifestB.entries.map(entry => [entry.path, entry]));
    const afterByPathC = new Map(entriesC.map(entry => [entry.path, entry]));
    const changesC = [...new Set([...beforeByPathC.keys(), ...afterByPathC.keys()])].sort().flatMap(path => {
      const before = beforeByPathC.get(path) ?? null, after = afterByPathC.get(path) ?? null;
      if (before && after && before.sha256 === after.sha256 && before.byteSize === after.byteSize
        && before.executable === after.executable) return [];
      const clean = entry => entry && ({ path: entry.path, type: entry.type, byteSize: entry.byteSize,
        sha256: entry.sha256, executable: entry.executable });
      return [{ path, operation: !before ? 'add' : !after ? 'delete' : 'modify', before: clean(before), after: clean(after),
        ...(before ? { beforeArtifact: before.artifact } : {}), ...(after ? { afterArtifact: after.artifact } : {}) }];
    });
    const developerAttemptIdC = randomUUID();
    const candidateIdC = p5CandidateId({ baselineId: baselineIdC, incidentId: incidentIdC, parentRunId: parentRunIdC,
      repairRunId: repairRunIdC, linkId: linkIdC, developerAttemptId: developerAttemptIdC,
      workspaceAllocationId: workspaceC.allocationId, candidateSourceDigest: candidateSourceDigestC,
      selfRepairProfileDigest: profileRefC.sha256, verificationPolicyDigest: policyRefC.sha256,
      verificationInputsDigest: verificationInputsRefC.sha256 });
    const developerTerminalC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairDeveloperTerminalEvidence', attemptId: developerAttemptIdC,
      custodyId: randomUUID(), processId: process.pid, processCreationTime: nowC,
      invocationDigest: 'c'.repeat(64), executableSha256: sha256(readFileSync(process.execPath)),
      processTreeEnded: true, spoolComplete: true, status: 'exited', state: 'exited', exitCode: 0,
    };
    const developerTerminalArtC = storeC.putJson(developerTerminalC);
    const developerTerminalRefC = { artifactId: developerTerminalArtC.artifactId, sha256: developerTerminalArtC.sha256 };

    const changeManifestC = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairChangeManifest',
      candidateId: candidateIdC,
      baselineId: baselineIdC,
      baseSourceDigest: baseSourceDigestC,
      candidateSourceDigest: candidateSourceDigestC,
      profileDigest: profileRefC.sha256,
      verificationPolicyDigest: policyRefC.sha256,
      verificationInputsDigest: verificationInputsRefC.sha256,
      workspaceAllocationId: workspaceC.allocationId,
      parentRunId: parentRunIdC,
      repairRunId: repairRunIdC,
      linkId: linkIdC,
      incidentId: incidentIdC,
      changes: changesC,
    };
    validateP5Contract('changeManifest', changeManifestC);
    const changeManifestArtC = storeC.putJson(changeManifestC);

    const candidateCBase = {
      ...candidate,
      candidateId: candidateIdC,
      baselineId: baselineIdC,
      baseCommit: baseCommitC,
      baseSourceDigest: baseSourceDigestC,
      candidateSourceDigest: candidateSourceDigestC,
      parentRunId: parentRunIdC,
      repairRunId: repairRunIdC,
      linkId: linkIdC,
      incidentId: incidentIdC,
      outcomeId: outcomeIdC,
      outcomeRevision: outcomeRevisionC,
      enrollment: enrollmentBRef,
      baselineRef: successorProfileB.baseline,
      sourceManifest: { artifactId: sourceManifestArtC.artifactId, sha256: sourceManifestArtC.sha256 },
      changeManifest: { artifactId: changeManifestArtC.artifactId, sha256: changeManifestArtC.sha256 },
      sourceCaptureEvidence: sourceCaptureRefC,
      sourceBinding: sourceBindingRefC,
      workspace: workspaceC,
      developerAttemptId: developerAttemptIdC,
      selfRepairProfile: profileRefC,
      verificationPolicy: policyRefC,
      verificationInputs: verificationInputsRefC,
      developerTerminalEvidence: developerTerminalRefC,
      scopeVerdict: { status: 'within_scope', changeCount: changesC.length },
      capturedAt: nowC,
      journalCursor: 1,
    };
    validateP5Contract('candidate', candidateCBase);
    const candidateBindingC = await attachP6TestGitCandidate({ store: storeC, candidate: candidateCBase, sourceRoot: sources.cloneB,
      gitPath: sources.gitPath, seedCommit: baseCommitC, seedTree: baseTreeC, sourceEntries: entriesC,
      preparationIntentRef: preparationIntentRefC });
    const candidateC = candidateBindingC.candidate;
    const candidateRefC = candidateBindingC.candidateRef;
    const captureAnchorC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairCandidateCaptureAnchor',
      captureId: canonicalHash({ kind: 'P5CandidateCapture', version: 1, linkId: linkIdC, repairRunId: repairRunIdC,
        developerAttemptId: developerAttemptIdC, allocationId: workspaceC.allocationId }),
      linkId: linkIdC, parentRunId: parentRunIdC, repairRunId: repairRunIdC, incidentId: incidentIdC,
      developerAttemptId: developerAttemptIdC, developerTerminalEvidence: developerTerminalRefC,
      terminalIdentity: { custodyId: developerTerminalC.custodyId, processId: developerTerminalC.processId,
        processCreationTime: developerTerminalC.processCreationTime, invocationDigest: developerTerminalC.invocationDigest,
        executableSha256: developerTerminalC.executableSha256, exitCode: 0 },
      enrollment: enrollmentBRef, workspacePreparation: candidateBindingC.workspacePreparationRef,
      allocationId: workspaceC.allocationId, workspaceIdentity: workspaceC.nativeIdentity,
      gitCandidatePolicy: 'managed-clone-v1', expectedSourceDigest: candidateSourceDigestC,
      expectedCandidateId: candidateIdC, sourceSnapshotDigest: candidateSourceDigestC,
      capturedAt: nowC, journalCursor: 4,
    };
    validateP5Contract('candidateCaptureAnchor', captureAnchorC);
    const captureAnchorArtC = storeC.putJson(captureAnchorC);
    const captureAnchorRefC = { artifactId: captureAnchorArtC.artifactId, sha256: captureAnchorArtC.sha256 };

    const gateAttemptIdC = randomUUID();
    const custodyIdC = randomUUID();
    const lifecycleGenerationC = randomUUID();
    const invocationDigestC = canonicalHash({ kind: 'P6 fixture Gate invocation', candidateId: candidateIdC,
      repairRunId: repairRunIdC, gateAttemptId: gateAttemptIdC });
    const hostIdentityC = 'fixture-host-b';
    const gateTerminalC = { schemaVersion: 1, kind: 'ProtectedSelfRepairGateTerminalEvidence', attemptId: gateAttemptIdC,
      custodyId: custodyIdC, invocationDigest: invocationDigestC, lifecycleGeneration: lifecycleGenerationC,
      hostIdentity: hostIdentityC, processTreeEnded: true, spoolComplete: true, state: 'exited', status: 'exited', exitCode: 0 };
    const gateTerminalArtC = storeC.putJson(gateTerminalC);
    const gateTerminalRefC = { artifactId: gateTerminalArtC.artifactId, sha256: gateTerminalArtC.sha256 };
    const checkC = policyC.checks.find(item => item.checkId === policyC.requiredCheckIds[0]);
    assert.ok(checkC, 'B continuation policy retains a required verification check');
    const verifyScratchC = join(workspaceC.canonicalRoot, '.p5', 'verify', 'scratch', gateAttemptIdC);
    const commandRootsC = {
      candidateSource: join(workspaceC.canonicalRoot, '.p5', 'verify', 'source'),
      executionRoot: join(workspaceC.canonicalRoot, '.p5', 'verify', 'execution'),
      verifyScratch: verifyScratchC, installedControl: join(root, 'p5-installed-control'),
    };
    const checkInputDigestC = p5CheckInputDigest({ candidate: candidateC, check: checkC, verificationInputs: verificationInputsC });
    const sortedPolicyInputsC = [...checkC.inputRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)
      || left.sha256.localeCompare(right.sha256)).map(artifact => ({ source: 'policy', artifact }));
    const sortedIncidentInputsC = [...verificationInputsC.inputs].sort((left, right) => left.selector.localeCompare(right.selector)
      || left.sourceOutcomeId.localeCompare(right.sourceOutcomeId) || left.sourceRevision - right.sourceRevision
      || left.artifact.artifactId.localeCompare(right.artifact.artifactId)).map(input => ({ source: 'incident', ...input }));
    const materializedRowsC = [...sortedPolicyInputsC, ...sortedIncidentInputsC].map((row, index) => {
      const bytes = storeC.readBytes(row.artifact.artifactId).bytes;
      return { ...row, relativePath: `inputs/${checkC.checkId}/input-${String(index).padStart(4, '0')}.bin`,
        sha256: sha256(bytes), byteSize: bytes.length };
    });
    const materializedInputsArtC = storeC.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairMaterializedCheckInputs',
      candidateId: candidateIdC, candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC,
      checkId: checkC.checkId, inputDigest: checkInputDigestC, root: verifyScratchC, inputs: materializedRowsC });
    const materializedInputsRefC = { artifactId: materializedInputsArtC.artifactId, sha256: materializedInputsArtC.sha256 };
    const materializedInputPathC = `inputs/${checkC.checkId}/manifest.json`;
    const absoluteInputManifestPathC = join(verifyScratchC, 'inputs', checkC.checkId, 'manifest.json');
    const subjectFilesC = checkC.subjectEntryPoints.map(path => {
      const entry = entriesC.find(item => item.path === path);
      if (!entry) throw new Error(`P6 fixture Gate subject is absent from candidate C: ${path}`);
      return { path, sha256: entry.sha256, byteSize: entry.byteSize, executable: entry.executable };
    });
    const subjectResolutionC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairSubjectResolution', candidateId: candidateIdC,
      candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC, checkId: checkC.checkId,
      verificationPolicy: policyRefC, verificationInputs: verificationInputsRefC, inputDigest: checkInputDigestC,
      driverIdentity: checkC.executable, driverSha256: checkC.executableSha256,
      entryPoints: checkC.subjectEntryPoints, resolvedFiles: subjectFilesC, sourceClosureDigest: canonicalHash(subjectFilesC),
      assertionBindings: checkC.expectedAssertions.map(assertion => ({ assertion, sourcePath: checkC.subjectEntryPoints[0] })),
    };
    const subjectResolutionArtC = storeC.putJson(subjectResolutionC);
    const subjectResolutionRefC = { artifactId: subjectResolutionArtC.artifactId, sha256: subjectResolutionArtC.sha256 };
    const executionTreeDigestC = p5ExecutionTreeDigest({ candidate: candidateC, checkId: checkC.checkId,
      subjectResolution: subjectResolutionRefC, inputDigest: checkInputDigestC, overlayManifest: null });
    const testInputManifestC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairTestInputManifest', candidateId: candidateIdC,
      candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC, verificationPolicy: policyRefC,
      verificationInputs: verificationInputsRefC, harnessClosureDigest: policyC.harnessClosureDigest,
      checks: [{ checkId: checkC.checkId, inputDigest: checkInputDigestC, subjectResolution: subjectResolutionRefC,
        executionTreeDigest: executionTreeDigestC, materializedInputs: materializedInputsRefC,
        materializedInputPath: materializedInputPathC, materializedInputDigest: materializedInputsRefC.sha256, overlayManifest: null }],
    };
    const testInputManifestArtC = storeC.putJson(testInputManifestC);
    const testInputManifestRefC = { artifactId: testInputManifestArtC.artifactId, sha256: testInputManifestArtC.sha256 };
    const effectiveCheckEnvironmentC = { ...checkC.environment, DESZO_P5_INPUT_MANIFEST: absoluteInputManifestPathC,
      ...(checkC.subjectBinding === 'candidate-entrypoint'
        ? { DESZO_P5_CANDIDATE_ENTRYPOINT: resolve(commandRootsC.candidateSource, ...checkC.subjectEntryPoints[0].split('/')) } : {}) };
    const commandManifestC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairCommandManifest', candidateId: candidateIdC,
      candidateSourceDigest: candidateSourceDigestC, verificationPolicy: policyRefC, gateAttemptId: gateAttemptIdC,
      roots: commandRootsC,
      checks: [{ checkId: checkC.checkId, commandDigest: checkC.commandDigest, executable: checkC.executable,
        executableSha256: checkC.executableSha256, argv: checkC.argv, cwdKind: checkC.cwd,
        cwd: join(commandRootsC.executionRoot, checkC.checkId), environment: effectiveCheckEnvironmentC,
        environmentDigest: canonicalHash(effectiveCheckEnvironmentC), inputDigest: checkInputDigestC,
        inputManifest: materializedInputsRefC, inputManifestPath: absoluteInputManifestPathC,
        inputManifestDigest: materializedInputsRefC.sha256 }],
    };
    const commandManifestArtC = storeC.putJson(commandManifestC);
    const commandManifestRefC = { artifactId: commandManifestArtC.artifactId, sha256: commandManifestArtC.sha256 };
    const outputArtC = storeC.putText('P6 fixture Engine B Gate output\n');
    const outputRefC = { artifactId: outputArtC.artifactId, sha256: outputArtC.sha256 };
    const checkObservationC = {
      checkId: checkC.checkId, stageId: checkC.stageId, required: checkC.required, commandDigest: checkC.commandDigest,
      toolIdentities: ['fixture-gate-driver'], inputDigest: checkInputDigestC,
      subjectResolution: subjectResolutionRefC, executionTreeDigest: executionTreeDigestC, overlayManifest: null,
      startedAt: nowC, endedAt: nowC, status: 'passed', exitCode: checkC.expectedExitCodes[0],
      expectedAssertions: checkC.expectedAssertions, completedAssertions: checkC.expectedAssertions,
      stdout: outputRefC, stderr: outputRefC,
    };
    const observationEvidenceC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairCheckObservation', candidateId: candidateIdC,
      candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC, checkId: checkC.checkId,
      commandDigest: checkC.commandDigest, inputDigest: checkInputDigestC, subjectResolution: subjectResolutionRefC,
      executionTreeDigest: executionTreeDigestC, startedAt: nowC, endedAt: nowC, status: 'passed',
      exitCode: checkC.expectedExitCodes[0], expectedAssertions: checkC.expectedAssertions,
      completedAssertions: checkC.expectedAssertions, stdout: outputRefC, stderr: outputRefC, captureStatus: 'complete',
    };
    const observationEvidenceArtC = storeC.putJson(observationEvidenceC);
    checkObservationC.observations = { artifactId: observationEvidenceArtC.artifactId, sha256: observationEvidenceArtC.sha256 };
    const verifierPlanArtC = storeC.putJson({ schemaVersion: 1, kind: 'P6 Fixture Verifier Plan', candidateId: candidateIdC,
      gateAttemptId: gateAttemptIdC });
    const verifierPlanRefC = { artifactId: verifierPlanArtC.artifactId, sha256: verifierPlanArtC.sha256 };
    const invocationArtC = storeC.putJson({ schemaVersion: 1, kind: 'P6 Fixture Gate Invocation', gateAttemptId: gateAttemptIdC,
      commandManifest: commandManifestRefC });
    const invocationRefC = { artifactId: invocationArtC.artifactId, sha256: invocationArtC.sha256 };
    const verificationStartedC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationStarted', runId: repairRunIdC, repairRunId: repairRunIdC,
      parentRunId: parentRunIdC, linkId: linkIdC, incidentId: incidentIdC, gateNodeId: successorProfileB.verificationNodeId,
      gateAttemptId: gateAttemptIdC, candidateId: candidateIdC, candidateSourceDigest: candidateSourceDigestC,
      candidateManifest: candidateRefC, gitCandidate: candidateC.gitCandidate, verificationPolicy: policyRefC,
      verificationInputs: verificationInputsRefC, verifierPlan: verifierPlanRefC, commandManifest: commandManifestRefC,
      testInputManifest: testInputManifestRefC, invocation: invocationRefC, candidateSourceRoot: workspaceC.sourceRoot,
      candidateSourceBefore: candidateSourceDigestC, freshSourceRoot: join(workspaceC.canonicalRoot, '.p5', 'verify', 'fresh-source'),
      executionRoot: commandRootsC.executionRoot, verifyScratch: verifyScratchC,
      environmentDigest: canonicalHash(effectiveCheckEnvironmentC), harnessClosureDigest: policyC.harnessClosureDigest,
      lifecycleGeneration: lifecycleGenerationC, engineEpoch: 1, startedAt: nowC,
    };
    validateP5Contract('verificationStarted', verificationStartedC);
    const verificationStartedArtC = storeC.putJson(verificationStartedC);
    const verificationStartedRefC = { artifactId: verificationStartedArtC.artifactId, sha256: verificationStartedArtC.sha256 };
    const receiptC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReceipt', receiptId: '0'.repeat(64), status: 'passed',
      candidateId: candidateIdC, candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC,
      candidateManifest: candidateRefC,
      changeManifest: { artifactId: changeManifestArtC.artifactId, sha256: changeManifestArtC.sha256 },
      gitCandidate: candidateC.gitCandidate, selfRepairProfile: profileRefC, verificationPolicy: policyRefC,
      verificationInputs: verificationInputsRefC, repairRunId: repairRunIdC, linkId: linkIdC, incidentId: incidentIdC,
      verificationNodeId: successorProfileB.verificationNodeId, gateAttemptId: gateAttemptIdC,
      execution: { custodyId: custodyIdC, hostIdentity: hostIdentityC, lifecycleGeneration: lifecycleGenerationC,
        engineEpoch: 1, invocationDigest: invocationDigestC, commandManifest: commandManifestRefC,
        executableIdentity: process.execPath, harnessClosureDigest: policyC.harnessClosureDigest,
        testInputManifest: testInputManifestRefC, environmentDigest: canonicalHash(effectiveCheckEnvironmentC) },
      checks: [checkObservationC], requiredCheckSetDigest: canonicalHash([...policyC.requiredCheckIds].sort()),
      completedCheckSetDigest: canonicalHash([checkC.checkId]), sourceBeforeDigest: candidateSourceDigestC,
      sourceAfterDigest: candidateSourceDigestC, liveCandidateDigest: candidateSourceDigestC,
      harnessAfterDigest: policyC.harnessClosureDigest, terminalEvidence: gateTerminalRefC, captureStatus: 'complete',
      startedAt: nowC, completedAt: nowC, observationJournalCursor: 7, issuedJournalCursor: 8,
    };
    receiptC.receiptId = p5VerificationReceiptId({ candidateId: candidateIdC, verificationPolicyDigest: policyRefC.sha256,
      gateAttemptId: gateAttemptIdC, custodyId: custodyIdC, checks: receiptC.checks });
    validateP5Contract('verificationReceipt', receiptC);
    const { verifyP5Receipt } = await import('../core/protectedSelfRepair.mjs');
    assert.equal(verifyP5Receipt(receiptC, { store: storeC, candidateRef: candidateRefC, gateAttemptId: gateAttemptIdC,
      terminalEvidenceRef: gateTerminalRefC }), true, 'synthetic C receipt is internally consistent under production P5 validation');
    const receiptArtC = storeC.putJson(receiptC);
    const receiptRefC = { artifactId: receiptArtC.artifactId, sha256: receiptArtC.sha256 };

    const currentEligibilityC = { ...candidateBindingC.currentEligibility, checkedAt: nowC };
    const judgeAttemptIdC = randomUUID();
    const decisionIdC = randomUUID();
    const attentionKeyC = canonicalHash({ kind: 'P6 Fixture Judge Attention', candidateId: candidateIdC, receiptId: receiptC.receiptId });
    const authorizationC = {
      schemaVersion: 1, kind: 'ParentRepairAuthorization', contract: 'logical_policy', incidentId: incidentIdC,
      parentRunId: parentRunIdC, repairRunId: repairRunIdC,
      parentPublishedVersionId: parentPublication.publishedVersionId, parentSnapshotSha256: parentWorkflowSnapshot.sha256,
      repairWorkflowId: repairPublication.workflowId, repairPublishedVersionId: repairPublication.publishedVersionId,
      repairSnapshotSha256: repairWorkflowSnapshot.sha256, repairWorkspaceId: workspaceC.workspaceId,
      failedNodeInstanceId: 'worker', repairResultNodeInstanceId: 'dev', expectedRepairResultSha256: null,
      acceptanceMode: 'judge_post_execution', failedNodeRetry: 'never', selfRepairProfile: profileRefC,
      profile: { selfRepair: storeC.readJson(profileRefC.artifactId) }, p5Enrollment: enrollmentBRef,
      p5SourceBinding: sourceBindingRefC, verificationInputs: verificationInputsRefC,
      outcomeId: outcomeIdC, outcomeRevision: outcomeRevisionC,
    };
    const authorizationArtC = storeC.putJson(authorizationC);
    const authorizationRefC = { artifactId: authorizationArtC.artifactId, sha256: authorizationArtC.sha256 };
    const acceptanceC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairAcceptance',
      acceptanceId: canonicalHash({ kind: 'P6 Fixture Acceptance', candidateId: candidateIdC, decisionId: decisionIdC }),
      candidateManifest: candidateRefC, candidateId: candidateIdC, candidateSourceDigest: candidateSourceDigestC,
      verificationReceipt: receiptRefC, receiptId: receiptC.receiptId, gitCandidate: candidateC.gitCandidate,
      currentEligibility: currentEligibilityC, gateAttemptId: gateAttemptIdC, parentRunId: parentRunIdC,
      repairRunId: repairRunIdC, linkId: linkIdC, incidentId: incidentIdC, decisionId: decisionIdC,
      judgeAttemptId: judgeAttemptIdC, attentionKey: attentionKeyC, p2Authorization: authorizationRefC,
      sourceIntegrityRevision: canonicalHash({ candidateSourceDigest: candidateSourceDigestC, baselineId: baselineIdC }),
      retentionRevision: 1, requiredReviewSetDigest: canonicalHash([evidenceRef]),
      reviewDelivery: { attentionKey: attentionKeyC, evidenceArtifact: evidenceRef, expansionArtifact: evidenceRef,
        sourceAttentionKey: attentionKeyC, sourceDeliveryEventSequence: 1, sourceJudgeAttemptId: judgeAttemptIdC,
        sourceExpansionArtifact: evidenceRef }, acceptedAt: nowC,
    };
    validateP5Contract('acceptance', acceptanceC);
    const acceptanceArtC = storeC.putJson(acceptanceC);
    const acceptanceRefC = { artifactId: acceptanceArtC.artifactId, sha256: acceptanceArtC.sha256 };
    const approvalC = { schemaVersion: 1, kind: 'ProtectedSelfRepairApproval', decision: 'accept_repair',
      decisionId: decisionIdC, judgeAttemptId: judgeAttemptIdC, protectedSelfRepairAcceptance: acceptanceRefC };
    const approvalArtC = storeC.putJson(approvalC);
    const approvalRefC = { artifactId: approvalArtC.artifactId, sha256: approvalArtC.sha256 };
    const outcomeC = {
      schemaVersion: 1, kind: 'ProtectedSelfRepairP2Outcome',
      outcomeId: canonicalHash({ kind: 'P6 Fixture P2 Outcome', candidateId: candidateIdC, decisionId: decisionIdC }),
      parentRunId: parentRunIdC, repairRunId: repairRunIdC, linkId: linkIdC, incidentId: incidentIdC,
      decisionId: decisionIdC, candidateId: candidateIdC, receiptId: receiptC.receiptId,
      p2Approval: approvalRefC, p5Acceptance: acceptanceRefC, gitCandidate: candidateC.gitCandidate,
      currentEligibility: currentEligibilityC, resultAttemptId: gateAttemptIdC, resultSha256: '9'.repeat(64),
      failedNodeRetry: 'never', continuationState: 'repair_accepted', recordedAt: nowC,
    };
    validateP5Contract('p2Outcome', outcomeC);
    const outcomeArtC = storeC.putJson(outcomeC);
    const outcomeRefC = { artifactId: outcomeArtC.artifactId, sha256: outcomeArtC.sha256 };

    const retentionRecordC = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairRetention',
      retentionId: canonicalHash({ kind: 'P6 Fixture Retention', candidateId: candidateIdC, receiptId: receiptC.receiptId }),
      parentRunId: parentRunIdC,
      repairRunId: repairRunIdC,
      linkId: linkIdC,
      incidentId: incidentIdC,
      candidateManifest: candidateRefC,
      candidateId: candidateIdC,
      verificationReceipt: receiptRefC,
      receiptId: receiptC.receiptId,
      workspaceId: workspaceC.workspaceId,
      allocationId: candidateC.workspace.allocationId,
      workspaceIdentity: candidateC.workspace.nativeIdentity,
      status: 'retained',
      revision: 1,
      retainedAt: nowC,
      cleanupDeferred: true,
    };
    const retentionArtC = storeC.putJson(retentionRecordC);
    const retentionRefC = { artifactId: retentionArtC.artifactId, sha256: retentionArtC.sha256 };

    const handoffC = createP5Handoff({
      candidate: { ...candidateC, candidateArtifact: candidateRefC },
      receipt: { ...receiptC, artifact: receiptRefC },
      approval: {
        decision: 'accept_repair',
        judgeAttemptId: judgeAttemptIdC,
        decisionId: decisionIdC,
        authorization: authorizationRefC,
        artifact: approvalRefC,
        outcome: outcomeRefC,
      },
      continuation: { state: 'repair_accepted' },
      retention: {
        status: 'retained',
        revision: 1,
        retainedAt: nowC,
        cleanupDeferred: true,
        artifact: retentionRefC,
      },
      sourceBinding: sourceBindingRefC,
      enrollment: enrollmentBRef,
      currentEligibility: currentEligibilityC,
    });
    const handoffArtC = storeC.putJson(handoffC);
    const handoffRefC = { artifactId: handoffArtC.artifactId, sha256: handoffArtC.sha256 };

    // Parent C has its own workspace (one active Run per workspace); Repair C is a terminal Run in the enrolled, registered slot.
    const wsParentC = 'p5-parent-c';
    const wsSlotC = workspaceC.workspaceId;
    const parentWorkspaceRootC = join(root, 'parent-workspace-c');
    mkdirSync(parentWorkspaceRootC, { recursive: true });
    storeC.run(`INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      wsParentC, parentWorkspaceRootC, sha256(parentWorkspaceRootC), nowC, nowC);

    // Insert runs & run_links for Candidate C
    const checkpointArtC = storeC.putJson({ schemaVersion: 1, kind: 'LinkedRepairCheckpoint', incidentId: incidentIdC,
      parentRunId: parentRunIdC, repairRunId: repairRunIdC, parentPublishedVersionId: parentPublication.publishedVersionId,
      resumeNodeInstanceId: 'worker', targetAttemptId: null });
    storeC.run(
      `INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence,
         created_at, journal_version, kind, published_version_id, definition_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'workflow', ?, ?)`,
      parentRunIdC, 'wf-parent', wsParentC, parentWorkflowSnapshot.artifactId, settingsArt.artifactId,
      parentDefinitionDigest, 'waiting_for_user', 0, nowC, parentPublication.publishedVersionId, parentDefinitionDigest
    );
    storeC.run(
      `INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence,
         created_at, journal_version, kind, published_version_id, definition_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'workflow', ?, ?)`,
      repairRunIdC, 'wf-repair', wsSlotC, repairWorkflowSnapshot.artifactId, settingsArt.artifactId,
      repairDefinitionDigest, 'succeeded', 1, nowC, repairPublication.publishedVersionId, repairDefinitionDigest
    );
    storeC.run(
      `INSERT INTO run_links(
        id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
        resume_node_instance_id, candidate_digest, checkpoint_artifact_id, state, continuation_contract,
        incident_id, parent_suspension_state, repair_outcome, decision_status, authorization_artifact_id,
        repair_result_node_instance_id, failed_node_retry, acceptance_mode, repair_approval_artifact_id,
        created_at, updated_at
      ) VALUES (
        ?, 'linked_repair', ?, ?, ?, ?,
        'worker', NULL, ?, 'repair_accepted', 'logical_policy',
        ?, 'suspended_for_repair', 'succeeded', 'accepted', ?,
        'dev', 'never', 'judge_post_execution', ?,
        ?, ?
      )`,
      linkIdC, parentRunIdC, repairRunIdC, wsParentC, wsSlotC,
      checkpointArtC.artifactId,
      incidentIdC, authorizationArtC.artifactId,
      approvalArtC.artifactId,
      nowC, nowC
    );

    // Write every P5 projection event in production order; the accepted state remains fixture-authored.
    storeC.appendEvents(parentRunIdC, [
      { type: 'self_repair.source_bound', payload: { record: sourceBindingRefC }, nodeInstanceId: null, attemptId: null },
    ]);
    storeC.appendEvents(repairRunIdC, [
      { type: 'self_repair.preparation_intent', payload: { record: preparationIntentRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.workspace_prepared', payload: { record: candidateBindingC.workspacePreparationRef }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.candidate_capture_started', payload: { record: captureAnchorRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.git_commit_intent', payload: { record: candidateBindingC.gitCommitIntentRef }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.candidate_captured', payload: { record: candidateRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.verification_started', payload: { record: verificationStartedRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.verification_recorded', payload: { record: receiptRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.retention_changed', payload: { record: retentionRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.cleanup_deferred', payload: { record: retentionRefC }, nodeInstanceId: null, attemptId: null },
      { type: 'self_repair.handoff_recorded', payload: { record: handoffRefC }, nodeInstanceId: null, attemptId: null },
    ]);
    storeC.close();
    storeC = null;

    // This uses the test-only route to exercise another switch from the synthetic fixture handoff. No target build is named, so C
    // gets the consumer's content-derived build ID, as A->B did through Engine A's startup projection trigger (engine.mjs:1411).
    const triggeredAtC = Date.now();
    const triggerResC = await fetch(`http://127.0.0.1:${connectionB.port}/api/v4/lifecycle/p6-activate/${repairRunIdC}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connectionB.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(triggerResC.status, 202, 'P6 activation trigger for Engine C accepted');

    // Await second switch completion (B -> C)
    try {
      await awaitSwitchVerified(installation, 2, 'the committed Engine C to become ready through the P6 builder and G0 Host protocol', triggeredAtC);
    } catch (err) {
      console.log('Host events recorded during B->C:', JSON.stringify(hostEvents(installation), null, 2));
      const runnerLog = join(profile, 'runtime', 'runner.log');
      if (existsSync(runnerLog)) {
        console.log('Runner log:\n', readFileSync(runnerLog, 'utf8'));
      }
      const hostLog = join(installation, '.deszo-host', 'host.log');
      if (existsSync(hostLog)) {
        console.log('Host log:\n', readFileSync(hostLog, 'utf8'));
      }
      throw err;
    }

    // Verify Engine C connection and marker
    const operationC = lifecycleState(installation).engineOperation;
    const expectedBuildIdC = operationC.toBuildId;
    assert.match(expectedBuildIdC, /^engine-[a-f0-9]{12}$/);
    const connectionC = await freshDescriptor(profile, expectedBuildIdC, connectionB.runtimeInstanceId, 60_000);
    assert.equal(connectionC.applicationBuildId, expectedBuildIdC);
    assert.equal(connectionC.engineMarker, 'engine-c', 'Engine C carries the engine-c marker!');

    // Verify atomic selector points to ENGINE_C
    const selectorC = activeSelector(installation);
    assert.equal(selectorC.buildId, expectedBuildIdC);

    // Verify operation verified in lifecycle.json
    assert.equal(operationC.phase, 'verified');
    assert.equal(operationC.fallbackAttempted, false);
    assert.equal(operationC.toBuildId, expectedBuildIdC);

    // Verify Engine B stopped and Engine C running
    assert.equal(processAlive(runB.enginePid), false, 'Engine B was terminated after switch to C');
    const runC = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(runC.buildId, expectedBuildIdC);
    assert.equal(processAlive(runC.enginePid), true, 'Engine C is running');

    // Verify Engine C serves owner API
    const servedC = await fetch(`http://127.0.0.1:${connectionC.port}/api/v2/settings`, {
      headers: { Authorization: `Bearer ${connectionC.token}` },
    });
    assert.equal(servedC.status, 200, 'Engine C serves API');

    // Verify 2 P6BuildReceipts recorded in command_receipts
    const dbFinal = new DatabaseSync(join(profile, 'store', 'state.sqlite'), { readOnly: true });
    try {
      const allBuildReceipts = dbFinal.prepare('SELECT * FROM command_receipts WHERE command = ?').all('p6.build');
      assert.equal(allBuildReceipts.length, 2, 'Two P6 build receipts recorded for A->B and B->C');
    } finally {
      dbFinal.close();
    }
  } finally {
    if (storeC) storeC.close();
    if (host) await stopHostRecorded(host, installation);
  }
});
