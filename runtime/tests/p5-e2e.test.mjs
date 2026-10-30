// P5-E2E-1: the first real Protected Self-Repair lifecycle of an installed test release. A test-owned source repository is
// packaged by runtime/host/runtimeRelease.mjs, installed under the real Rust Lifecycle Host (`run` mode with Process Custody),
// enrolled through the installation-owned install step, and repaired through ordinary P3 → P4 → P2 → Developer → Gate →
// Repair Judge → P2 acceptance. The test only provisions inputs and observes; every P5 record is produced by the Engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { attachEngine, buildArtifacts, eventually, newScratch, repo as repoRoot, startCustodyHost } from './custody-support.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { actualGit, api, createTestSourceRepository, currentDescriptor, DESKTOP_BUILD_ID, gitRunner, hostEvents, hostExecutable, journal,
  packageInstalledRelease, profileQuery, reconstructHandoff, runtimeDependencyPackages, sha256, startLifecycleHost } from './p5-e2e-support.mjs';
import { Store } from '../core/store.mjs';
import { canonicalHash } from '../core/canonical.mjs';
import { collectP5GitBaseline, p5VerificationCommandDigest, validateP5Contract } from '../core/protectedSelfRepair.mjs';
import { installP5Enrollment } from '../core/p5Provisioning.mjs';

const ref = value => ({ artifactId: value.artifactId, sha256: value.sha256 });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const DEFECT = '// Formats a P3 canonical failure code as a human label.\nexport function incidentLabel(code) { return String(code).split(\'_\')[0]; }\n';
const FIXED_LABEL = '// Formats a P3 canonical failure code as a human label.\nexport function incidentLabel(code) { return String(code).split(\'_\').join(\' \'); }\n';
const REPRODUCER_PATH = 'runtime/tests/p5-e2e/incident-reproducer.test.mjs';
const AUTHORITY_PATH = 'runtime/tests/p5-e2e/authority-regression.test.mjs';
const PLAN_RECORD = String.fromCharCode(30), PLAN_FIELD = String.fromCharCode(31);
const planText = operations => operations.map(item => item.join(PLAN_FIELD)).join(PLAN_RECORD);

// Each scenario installs a release with one genuine defect in real Engine source. The Parent worker exercises the installed
// module and fails because of it; the Gate's protected reproducer replays the same captured incident against the candidate.
// `engine` and `p5` defect modules the P5-E2E-1 boundary used to refuse outright (engine.mjs, protectedSelfRepair.mjs).
export const SCENARIOS = Object.freeze({
  label: { subject: 'runtime/core/incidentLabel.mjs', exportName: 'incidentLabel', args: ['provider_unavailable'], expected: 'provider unavailable',
    tier: 'engine-core', installed: () => DEFECT, fix: () => [['write', 'runtime/core/incidentLabel.mjs', '', FIXED_LABEL]] },
  engine: { subject: 'runtime/core/engine.mjs', exportName: 'loopStep', args: [{ iteration: 3, maxIterations: 3, continue: true }],
    expected: 'pause_iteration_limit', tier: 'repair-authority',
    good: "return iteration >= maxIterations ? 'pause_iteration_limit' : 'next';", bad: "return iteration > maxIterations ? 'pause_iteration_limit' : 'next';" },
  p5: { subject: 'runtime/core/protectedSelfRepair.mjs', exportName: 'p5PortablePathOrdering', args: [['src/b.mjs', 'src/a.mjs']],
    expected: ['src/a.mjs', 'src/b.mjs'], tier: 'repair-authority',
    good: '  return [...paths].map(validateP5SourcePath).sort(compareText);', bad: '  return [...paths].map(validateP5SourcePath);' },
});

function scenarioFiles(scenario) {
  if (scenario.installed) return new Map([[scenario.subject, scenario.installed()]]);
  const current = readFileSync(join(repoRoot, ...scenario.subject.split('/')), 'utf8');
  assert.equal(current.split(scenario.good).length, 2, `the ${scenario.subject} repair anchor is unique`);
  return new Map([[scenario.subject, current.replace(scenario.good, scenario.bad)]]);
}
export const scenarioFix = scenario => scenario.fix ? scenario.fix() : [['replace', scenario.subject, scenario.bad, scenario.good]];

// Protected reproducer, committed in the installed baseline and overlaid over every candidate. Its criteria (subject, input,
// expected result) live in this protected file; the captured P3 incident must name the same subject and input and record the
// installed failure. `incident-captured` binds the replay to that incident; `incident-repaired` runs the candidate subject.
const reproducer = scenario => [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { join, resolve } from 'node:path';",
  `import { ${scenario.exportName} as subject } from '../../${scenario.subject.slice('runtime/'.length)}';`,
  `const SUBJECT = ${JSON.stringify(scenario.subject)}, EXPORT = ${JSON.stringify(scenario.exportName)};`,
  `const ARGS = ${JSON.stringify(scenario.args)}, EXPECTED = ${JSON.stringify(scenario.expected)};`,
  'function capturedIncident() {',
  "  const manifest = JSON.parse(readFileSync(process.env.DESZO_P5_INPUT_MANIFEST, 'utf8'));",
  '  for (const input of manifest.inputs) {',
  '    let value;',
  "    try { value = JSON.parse(readFileSync(resolve(manifest.root, input.relativePath), 'utf8')); } catch { continue; }",
  "    const line = String(value.stderrTail || '').split(/\\r?\\n/).find(item => item.startsWith('P5-INCIDENT '));",
  "    if (line) return JSON.parse(line.slice('P5-INCIDENT '.length));",
  '  }',
  '  return null;',
  '}',
  "test('incident-captured', () => {",
  '  const incident = capturedIncident();',
  "  assert.ok(incident, 'the captured P3 evidence carries the installed incident');",
  '  assert.equal(incident.subject, SUBJECT); assert.equal(incident.export, EXPORT);',
  '  assert.deepEqual(incident.args, ARGS); assert.deepEqual(incident.expected, EXPECTED);',
  "  assert.notDeepEqual(incident.observed, EXPECTED, 'the installed baseline failed this exact reproduction');",
  '});',
  "test('incident-repaired', async () => {",
  '  const barrier = process.env.P5_E2E_GATE_BARRIER;',
  '  if (barrier) {',
  "    writeFileSync(join(barrier, 'READY-P5_GATE.marker'), String(process.pid));",
  "    for (let waited = 0; !existsSync(join(barrier, 'RELEASE-P5_GATE.marker')) && waited < 150_000; waited += 50) await new Promise(done => setTimeout(done, 50));",
  '  }',
  '  assert.deepEqual(await subject(...ARGS), EXPECTED);',
  '});', ''].join('\n');

// Protected authority regression for the strictest tier: it executes the candidate's P5 module as future Engine code.
const AUTHORITY_REGRESSION = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { p5VerificationReceiptId, validateP5SourcePath } from '../../core/protectedSelfRepair.mjs';",
  "test('authority-path-guard', () => {",
  "  for (const path of ['../escape.mjs', 'C:/absolute.mjs', 'a/../../b.mjs', 'a//b.mjs']) assert.throws(() => validateP5SourcePath(path), path);",
  "  assert.equal(validateP5SourcePath('src/a.mjs'), 'src/a.mjs');",
  '});',
  "test('authority-receipt-identity', () => {",
  "  const base = { candidateId: 'a'.repeat(64), verificationPolicyDigest: 'b'.repeat(64), gateAttemptId: '00000000-0000-4000-8000-000000000001', custodyId: 'c', checks: [] };",
  '  assert.equal(p5VerificationReceiptId(base), p5VerificationReceiptId({ ...base }));',
  "  assert.notEqual(p5VerificationReceiptId(base), p5VerificationReceiptId({ ...base, custodyId: 'd' }));",
  '});', ''].join('\n');

// The Parent worker's probe: imports the installed subject by its installation path and reports the observed behavior.
const probeScript = (scenario, installedRoot) => [
  "import { pathToFileURL } from 'node:url';",
  `const subject = await import(pathToFileURL(${JSON.stringify(join(installedRoot, ...scenario.subject.split('/')))}).href);`,
  `const record = { subject: ${JSON.stringify(scenario.subject)}, export: ${JSON.stringify(scenario.exportName)}, args: ${JSON.stringify(scenario.args)}, expected: ${JSON.stringify(scenario.expected)} };`,
  'record.observed = await subject[record.export](...record.args);',
  'if (JSON.stringify(record.observed) === JSON.stringify(record.expected)) console.log(JSON.stringify(record));',
  "else { console.log('P5-INCIDENT ' + JSON.stringify(record)); process.exitCode = 1; }", ''].join('\n');

function p4Policy(judgeNodeId, repairProfiles = []) {
  return { version: 'workflow-judge/1', judgeNodeId, maxJudgeAttemptsPerRun: 8, maxEvidenceExpansionsPerAttention: 1, repairProfiles };
}

function repairDefinition(workflowId, policyRef, developerModel = 'custody-p5-developer', judgeModel = 'custody-p5-repair-judge') {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'protected-self-repair-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Repair the installed Engine defect that the captured P3 incident reproduces.' } },
      { id: 'developer', type: 'agent', config: { provider: 'codex', model: developerModel, timeoutSeconds: 240, output: { format: 'text' } } },
      { id: 'developer-result', type: 'result-viewer', config: {} },
      { id: 'verify', type: 'gate', config: { mode: 'self-repair-verify', verificationPolicy: policyRef } },
      { id: 'report', type: 'result-viewer', config: {} },
      { id: 'repair-judge', type: 'agent', config: { provider: 'codex', model: judgeModel, timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } },
    ],
    edges: [edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-result', 'developer', 'text', 'developer-result', 'value'),
      edge('verify-report', 'verify', 'report', 'report', 'value')],
    after: [{ before: 'developer', after: 'verify' }], judgePolicy: p4Policy('repair-judge') };
}

function parentDefinition(workflowId, profile) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1', 'protected-self-repair-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Exercise the installed Engine behavior for the current incident.' } },
      { id: 'worker', type: 'agent', config: { provider: 'codex', model: 'custody-p5-parent-probe', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
      { id: 'judge', type: 'agent', config: { provider: 'codex', model: 'custody-p5-parent-judge', timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } },
    ],
    edges: [edge('request-worker', 'request', 'text', 'worker', 'prompt'), edge('worker-result', 'worker', 'text', 'result', 'value')],
    after: [], judgePolicy: p4Policy('judge', [profile]) };
}

async function publish(call, definition) {
  const draft = await call('PUT', `/api/v4/workflows/${definition.workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const validation = await call('POST', `/api/v4/workflows/${definition.workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
  const publication = await call('POST', `/api/v4/workflows/${definition.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  return publication.body;
}

const publicationOf = body => ({ workflowId: body.workflow.workflowId, publishedVersionId: body.publishedVersionId, version: body.version,
  snapshotSha256: body.snapshotSha256 });

/** Build, install and enroll one isolated test release. Every step uses a production entry point or the Owner API. */
export async function provisionInstallation(label, { scenario: scenarioId = 'label', developerModel = 'custody-p5-developer', developerPlan = null,
  judgeModel = 'custody-p5-repair-judge', gateBarrier = false, installEnrollment = true, publication = false, distribution = 'runtime',
  transientCaptureFault = null, crashOnce = null, developerOrphanMs = null, custodyTest = {} } = {}) {
  const scenario = SCENARIOS[scenarioId];
  const { fixtureExe, fixtureSha256 } = buildArtifacts();
  const scratch = newScratch(`p5-e2e-${label}`);
  const gitTool = actualGit(), git = gitRunner(gitTool.path);
  const source = createTestSourceRepository(join(scratch.root, 'source'), gitTool.path, { dependencies: await runtimeDependencyPackages(), extraFiles: new Map([
    ...scenarioFiles(scenario), [REPRODUCER_PATH, reproducer(scenario)], [AUTHORITY_PATH, AUTHORITY_REGRESSION]]) });
  const origin = join(scratch.root, 'origin.git');
  git(scratch.root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(source.root, ['push', '--quiet', pathToFileURL(origin).href, 'HEAD:refs/heads/main']);
  const installation = join(scratch.root, 'installation'), profile = join(scratch.root, 'profile');
  // A desktop release installs as the shell's compiled build identity and runs its Gate from the `p5/` support payload.
  const buildId = distribution === 'desktop' ? DESKTOP_BUILD_ID : 'p5-e2e-release';
  const release = await packageInstalledRelease({ sourceRoot: source.root, gitTool, installation, buildId, distribution });
  const installedRoot = join(installation, 'versions', buildId, ...(distribution === 'desktop' ? ['p5'] : []));
  const parentWorkspace = join(scratch.root, 'parent-workspace'); mkdirSync(parentWorkspace);
  const slotRoot = ownedDir(join(testsRoot, `p5-e2e-slot-${label}-`));
  const nodeTool = { path: process.execPath, sha256: sha256(readFileSync(process.execPath)) };
  const allowedExecutables = [{ path: fixtureExe, sha256: fixtureSha256 }, nodeTool];
  // F10: an optional test-only transient Host failure at a named capture point ("<point> <count>"), counted down per pass.
  const transientFile = join(scratch.fixtureState, 'p5-transient-capture.txt');
  if (transientCaptureFault) writeFileSync(transientFile, transientCaptureFault);
  // C07: an optional one-shot Engine exit at a named Gate point.
  const crashFile = join(scratch.fixtureState, 'p5-crash-once.txt');
  if (crashOnce) writeFileSync(crashFile, crashOnce);
  if (developerOrphanMs) writeFileSync(join(scratch.fixtureState, 'p5-orphan-ms.txt'), String(developerOrphanMs));
  const hostArgs = { root: scratch.root, installation, profile, buildId, fixtureState: scratch.fixtureState, allowedExecutables, distribution,
    env: { ...(transientCaptureFault ? { DESZO_P5_TEST_TRANSIENT_CAPTURE: transientFile } : {}), ...(crashOnce ? { DESZO_P5_TEST_CRASH_ONCE: crashFile } : {}) },
    custodyTest };
  // The Parent worker's probe of the installed release, and the Developer's edit plan (both test-owned agent inputs).
  writeFileSync(join(scratch.fixtureState, 'p5-probe-node.txt'), process.execPath);
  writeFileSync(join(scratch.fixtureState, 'p5-probe.mjs'), probeScript(scenario, installedRoot));
  if (developerPlan) writeFileSync(join(scratch.fixtureState, 'p5-developer-plan.txt'), planText(developerPlan));

  // Owner step 0: the captured verification policy, bound to the release build-input digest.
  mkdirSync(profile, { recursive: true });
  let store = new Store(profile);
  const environment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
    ...(gateBarrier ? { P5_E2E_GATE_BARRIER: scratch.fixtureState } : {}) }).filter(([, value]) => typeof value === 'string'));
  const protectedCheck = (checkId, stageId, path, subject, expectedAssertions, env) => {
    const value = { checkId, stageId, required: true, executable: nodeTool.path, executableSha256: nodeTool.sha256,
      argv: ['--test-reporter=junit', '--test', path], cwd: 'candidate-execution-tree', inputRefs: [], environment: env,
      subjectEntryPoints: [subject], expectedAssertions, expectedExitCodes: [0], timeoutSeconds: 200, maxOutputBytes: 65536,
      subjectBinding: 'protected-overlay', overlayPaths: [path] };
    value.commandDigest = p5VerificationCommandDigest(value);
    return value;
  };
  const checks = [protectedCheck('incident-reproducer', 'reproduce', REPRODUCER_PATH, scenario.subject, ['incident-captured', 'incident-repaired'], environment),
    protectedCheck('authority-regression', 'regression', AUTHORITY_PATH, 'runtime/core/protectedSelfRepair.mjs',
      ['authority-path-guard', 'authority-receipt-identity'], Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'P5_E2E_GATE_BARRIER')))];
  const requiredCheckIds = checks.map(item => item.checkId);
  // Verification tiers: Engine-core repairs need the causal reproducer; repair-authority and Custody-integration repairs
  // additionally need the protected authority regression. The Gate runs every required check, so the union always holds.
  const verificationPolicy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1, requiredStages: ['regression', 'reproduce'],
    requiredCheckIds, optionalCheckIds: [], harnessClosureDigest: release.inputsDigest,
    incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8, maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
    checks, verificationRetries: 0, aggregateTimeoutSeconds: 400,
    mutationTiers: [{ tierId: 'engine-core', requiredCheckIds: ['incident-reproducer'] }, { tierId: 'repair-authority', requiredCheckIds },
      { tierId: 'engine-custody', requiredCheckIds }],
    // P5-CLOSURE §6: the production Gate must observe the defect on the installed baseline and the repair on the candidate.
    causalReproduction: { schemaVersion: 1, checkId: 'incident-reproducer', baselineMustPass: ['incident-captured'], baselineMustFail: ['incident-repaired'] } };
  validateP5Contract('verificationPolicy', verificationPolicy);
  const policyRef = ref(store.putJson(verificationPolicy));
  store.db.close();

  // Host session 1: workspaces, Repair publication and the Host's own attestation of the running release.
  let host = startLifecycleHost(hostArgs);
  const setup = await host.firstConnection();
  let call = api(setup, setup.firstPartyToken);
  for (const [id, cwd] of [['p5-parent', parentWorkspace], ['p5-slot', slotRoot]])
    assert.equal((await call('PUT', `/api/v2/workspaces/${id}`, { cwd })).status, 200);
  const repairPublication = await publish(call, repairDefinition('p5-e2e-repair', policyRef, developerModel, judgeModel));
  const attested = await call('GET', '/api/v2/installation/source-release');
  assert.equal(attested.status, 200, JSON.stringify(attested.body));
  const attestedRelease = attested.body.release;
  assert.equal(attestedRelease.sourceCommit, source.releaseCommit, 'the Host attests the committed test source');
  assert.equal(attestedRelease.sourceDigest, release.sourceDigest);
  assert.equal(attestedRelease.inputsDigest, release.inputsDigest);
  assert.equal(attested.body.protectedSelfRepair.admissionEnabled, false, 'no enrollment: P5 admission is closed');
  await host.shutdown();

  // Owner step 1: baseline, workspace allocation and P5 profile, measured through an authenticated Host identity reader.
  const identityHost = await startCustodyHost(join(scratch.root, 'identity'), { allowedExecutables });
  const epoch = await attachEngine(identityHost);
  const readers = {
    nativeSourceReader: request => identityHost.request('custody.source_identity', { generation: identityHost.generation, epoch, ...request }),
    nativeToolIdentityReader: request => identityHost.request('custody.tool_identity', { generation: identityHost.generation, epoch, ...request }),
  };
  store = new Store(profile);
  let enrollmentArtifact;
  try {
    const common = await readers.nativeSourceReader({ root: join(source.root, '.git'), include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    const slotIdentity = await readers.nativeSourceReader({ root: slotRoot, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
    assert.equal(common.refused, undefined, common.message); assert.equal(slotIdentity.refused, undefined, slotIdentity.message);
    const enrollmentId = randomUUID();
    const repositoryIdentity = { enrollmentId, canonicalCommonDirectory: common.canonicalRoot, nativeDirectoryIdentity: common.rootIdentity };
    const releaseRef = ref(store.putJson(attestedRelease));
    const budgets = { maxSourceFiles: 2000, maxSourceBytes: 64 * 1024 * 1024, developerTimeoutSeconds: 240, verificationTimeoutSeconds: 400,
      maxCheckOutputBytes: 65536, verificationRetries: 0, maxJudgeAttempts: 4, maxEvidenceExpansions: 1 };
    const baseline = await collectP5GitBaseline({ store, repositoryRoot: source.root, gitTool, repositoryIdentity, enrollmentId,
      runningSourceRelease: releaseRef, pathPolicy: { include: ['**'], exclude: ['.git/**', '.p5/**', 'node_modules/**'], secretPaths: [] },
      budgets: { maxSourceFiles: budgets.maxSourceFiles, maxSourceBytes: budgets.maxSourceBytes }, expectedCommit: source.releaseCommit, ...readers });
    const scopeSelectors = ['runtime/**', 'src/**', 'lifecycle-host/**'];
    const scope = { add: scopeSelectors, modify: scopeSelectors, delete: scopeSelectors, executable: [], denied: [], sensitiveCategories: [] };
    const workspace = { workspaceId: 'p5-slot', canonicalRoot: slotIdentity.canonicalRoot, allocationId: randomUUID(), nativeIdentity: slotIdentity.rootIdentity };
    const p5Profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity, baselineId: baseline.baselineId,
      baseline: baseline.baselineManifest, runningSourceRelease: releaseRef, repairPublication: publicationOf(repairPublication),
      developerNodeId: 'developer', verificationNodeId: 'verify', repairJudgeNodeId: 'repair-judge',
      workspace: { workspaceId: workspace.workspaceId, allocationId: workspace.allocationId, canonicalRoot: workspace.canonicalRoot, singleUse: true, cleanCommitted: true },
      scope, verificationPolicy: policyRef, requiredCheckIds,
      eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'process' }], failedNodeRetry: 'never',
      acceptanceMode: 'judge_post_execution', budgets };
    validateP5Contract('profile', p5Profile);
    const profileRef = ref(store.putJson(p5Profile));
    store.db.close(); store = null;

    // Host session 2: the Parent publication carries exactly one captured Self-Repair profile.
    host = startLifecycleHost(hostArgs);
    const second = await host.firstConnection();
    call = api(second, second.firstPartyToken);
    const parentPublication = await publish(call, parentDefinition('p5-e2e-parent', {
      profileId: 'self-repair', repairWorkflowId: 'p5-e2e-repair', repairPublishedVersion: repairPublication.version,
      repairWorkflowSnapshotSha256: repairPublication.snapshotSha256, repairWorkspaceId: 'p5-slot', failedNodeInstanceId: 'worker',
      repairResultNodeInstanceId: 'developer', verificationNodeInstanceIds: ['verify'], acceptanceMode: 'judge_post_execution',
      failedNodeRetry: 'never', selfRepair: profileRef }));
    await host.shutdown();

    // Owner step 2: the complete enrollment, installed once through the installation-owned path.
    store = new Store(profile);
    const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
      gitObjectFormat: baseline.gitObjectFormat, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree, gitCandidatePolicy: 'managed-clone-v1',
      gitSource: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1', sourceRepositoryId: 'deszo-p5-e2e',
        remote: { remoteId: 'p5-e2e-origin', url: pathToFileURL(origin).href, protocol: 'file' }, fetchRefs: ['refs/heads/main'],
        sourceCommit: baseline.baseCommit, sourceTree: baseline.baseTree, objectFormat: baseline.gitObjectFormat,
        releaseSourceDigest: attestedRelease.sourceDigest, credentialPolicy: 'none',
        publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: publication, remoteId: 'p5-e2e-origin',
          refNamespace: 'refs/heads/self-repair/', requireExpectedRemoteState: true, allowMerge: false } },
      pathPolicyDigest: baseline.pathPolicyDigest, effectiveSourceDigest: baseline.sourceDigest, baselineId: baseline.baselineId,
      baselineManifest: baseline.baselineManifest, runningSourceRelease: releaseRef, parentPublication: publicationOf(parentPublication),
      profile: profileRef, repairPublication: publicationOf(repairPublication), workspace, verificationPolicy: policyRef,
      harnessClosureDigest: release.inputsDigest, toolIdentities: [{ name: 'git', ...gitTool }, { name: 'node', ...nodeTool }], scope, budgets,
      minimumReaderCapability: 'protected-self-repair-v1' };
    const installed = installEnrollment ? installP5Enrollment({ profileRoot: profile, store, enrollment, attestedRelease }) : null;
    enrollmentArtifact = ref(store.putJson(enrollment));
    store.db.close(); store = null;
    return { scenario, dependencyPackages: await runtimeDependencyPackages(), scratch, source, origin, installation, profile, buildId, release, attestedRelease, slotRoot, parentWorkspace, hostArgs, policyRef,
      distribution, installedRoot,
      repairPublication, parentPublication, enrollment, enrollmentArtifact, installed, gitTool, git, identityHost,
      close: async () => { await identityHost.shutdown().catch(() => identityHost.crash()); releaseOwnedDir(slotRoot); } };
  } catch (error) {
    if (store) store.db.close();
    await identityHost.shutdown().catch(() => identityHost.crash());
    throw error;
  }
}

function diagnostics(context, host, runIds = []) {
  const parts = [`Host stderr (tail): ${host?.stderr?.slice(-6000) ?? ''}`];
  // The packaged desktop Engine writes its stderr to the profile runtime log, not to the Host.
  const runnerLog = join(context.profile, 'runtime', 'runner.log');
  if (existsSync(runnerLog)) parts.push(`Desktop Engine runner.log (tail): ${readFileSync(runnerLog, 'utf8').slice(-6000)}`);
  for (const runId of runIds.filter(Boolean)) {
    parts.push(`Run ${runId} attempts: ${JSON.stringify(profileQuery(context.profile, `SELECT a.id, n.node_id, a.state, a.ordinal FROM attempts a
      JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id WHERE a.run_id = ? ORDER BY a.rowid`, runId))}`);
    parts.push(`Run ${runId} journal: ${JSON.stringify(journal(context.profile, runId).map(item => item.type))}`);
  }
  return parts.join('\n');
}

function artifactJson(profile, artifactRef) {
  const row = profileQuery(profile, 'SELECT * FROM artifacts WHERE id = ?', artifactRef.artifactId)[0];
  assert.ok(row && row.sha256 === artifactRef.sha256, `artifact ${artifactRef.artifactId} is present with its digest`);
  const bytes = readFileSync(join(profile, 'store', ...row.relative_path.split('/')));
  assert.equal(sha256(bytes), row.sha256);
  return JSON.parse(bytes.toString('utf8'));
}

const attemptOf = (profile, runId, nodeId) => profileQuery(profile, `SELECT a.* FROM attempts a JOIN node_instances n ON n.run_id = a.run_id
  AND n.id = a.node_instance_id WHERE a.run_id = ? AND n.node_id = ? ORDER BY a.rowid`, runId, nodeId);

/**
 * Independent replay of the protected reproducer over an exact Git commit of the managed repository, with the exact
 * immutable P3 inputs the Gate captured (copied from their verified Store objects). Used to show R(B) fails, R(C) passes.
 */
function replayReproducer(context, commit, verificationInputs, label) {
  const tree = join(context.scratch.root, `replay-${label}`), tar = join(context.scratch.root, `replay-${label}.tar`);
  mkdirSync(tree);
  context.git(`${context.slotRoot}\\source`, ['archive', '--format=tar', '-o', tar, commit]);
  const untar = spawnSync('tar', ['-xf', tar, '-C', tree], { windowsHide: true, encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  for (const name of context.dependencyPackages) cpSync(join(repoRoot, 'node_modules', ...name.split('/')), join(tree, 'node_modules', ...name.split('/')), { recursive: true });
  const inputs = join(context.scratch.root, `replay-${label}-inputs`);
  mkdirSync(inputs);
  const rows = verificationInputs.inputs.map((input, index) => {
    const row = profileQuery(context.profile, 'SELECT * FROM artifacts WHERE id = ?', input.artifact.artifactId)[0];
    const bytes = readFileSync(join(context.profile, 'store', ...row.relative_path.split('/')));
    assert.equal(sha256(bytes), input.artifact.sha256, 'the replay input is the exact captured Store object');
    const relativePath = `input-${index}.bin`;
    writeFileSync(join(inputs, relativePath), bytes);
    return { relativePath, sha256: input.artifact.sha256 };
  });
  const manifest = join(inputs, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ root: inputs, inputs: rows }));
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot, DESZO_P5_INPUT_MANIFEST: manifest };
  const result = spawnSync(process.execPath, ['--test-reporter=tap', '--test', REPRODUCER_PATH], { cwd: tree, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const passed = name => new RegExp(`^ok \\d+ - ${name}$`, 'm').test(result.stdout);
  return { status: result.status, captured: passed('incident-captured'), repaired: passed('incident-repaired'), stdout: result.stdout.slice(-2000) };
}

/** Read the durable lifecycle evidence and assert every P5-E2E-1 invariant against the actual Store, journal and Git graph. */
async function collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef, expectedChanges = [context.scenario.subject],
  expectedTiers = [context.scenario.tier] }) {
  const { profile } = context;
  const repairEvents = journal(profile, repairRunId), parentEvents = journal(profile, parentRunId);
  const once = type => {
    const rows = repairEvents.filter(item => item.type === type);
    assert.equal(rows.length, 1, `exactly one ${type}`);
    return rows[0].payload.record;
  };
  const anchorRef = once('self_repair.candidate_capture_started'), intentRef = once('self_repair.git_commit_intent');
  const candidateRef = once('self_repair.candidate_captured'), startRef = once('self_repair.verification_started');
  const receiptRef = once('self_repair.verification_recorded'), retentionRef = once('self_repair.retention_changed');
  assert.deepEqual(once('self_repair.handoff_recorded'), handoffRef);
  once('self_repair.workspace_prepared'); once('self_repair.preparation_intent');
  // P3 → P4 → P2 authority and the never-retry Parent rule.
  const outcome = parentEvents.find(item => item.type === 'attempt.failure_outcome').payload.outcome;
  assert.equal(outcome.canonicalCode, 'process');
  // Causal incident: the P3 evidence is the installed probe's own record of the defective installed subject behavior.
  const evidenceRef = outcome.evidenceReferences.find(item => item.type === 'artifact');
  const incidentEvidence = artifactJson(profile, { artifactId: evidenceRef.id, sha256: evidenceRef.sha256 });
  const incidentLine = incidentEvidence.stderrTail.split(/\r?\n/).find(line => line.startsWith('P5-INCIDENT '));
  assert.ok(incidentLine, 'the P3 failure evidence carries the installed incident record');
  const incident = JSON.parse(incidentLine.slice('P5-INCIDENT '.length));
  assert.equal(incident.subject, context.scenario.subject); assert.deepEqual(incident.expected, context.scenario.expected);
  assert.notDeepEqual(incident.observed, incident.expected, 'the installed baseline exhibited the failure');
  assert.equal(attemptOf(profile, parentRunId, 'worker').length, 1, 'the old binary never retries the failed Parent node');
  const accepted = parentEvents.findIndex(item => item.type === 'continuation.repair_result_accepted');
  const refused = parentEvents.findIndex(item => item.type === 'continuation.parent_resumption_blocked');
  assert.ok(accepted >= 0 && refused > accepted && parentEvents[refused].payload.code === 'retry_not_authorized');
  const link = profileQuery(profile, 'SELECT * FROM run_links WHERE id = ?', linkId)[0];
  assert.equal(link.decision_status, 'accepted'); assert.equal(link.repair_outcome, 'succeeded'); assert.equal(link.failed_node_retry, 'never');
  // Developer and Gate ran as Host-owned Custody invocations, once each.
  const developer = attemptOf(profile, repairRunId, 'developer'), gate = attemptOf(profile, repairRunId, 'verify');
  assert.equal(developer.length, 1); assert.equal(gate.length, 1);
  const custody = id => profileQuery(profile, 'SELECT * FROM attempt_custody WHERE attempt_id = ?', id)[0];
  assert.ok(custody(developer[0].id)?.custody_id, 'the Developer is bound to a Rust Host invocation');
  assert.ok(custody(gate[0].id)?.custody_id, 'the verifier is bound to a Rust Host invocation');
  // Candidate, Git commit and receipt.
  const anchor = artifactJson(profile, anchorRef), candidate = artifactJson(profile, candidateRef);
  assert.equal(candidate.candidateId, anchor.expectedCandidateId); assert.equal(candidate.developerAttemptId, developer[0].id);
  const gitCandidate = artifactJson(profile, candidate.gitCandidate);
  assert.equal(gitCandidate.git.historyPolicy, 'managed-clone-v1'); assert.equal(gitCandidate.git.sourceAncestryVerified, true);
  const managed = args => context.git(`${context.slotRoot}\\source`, args).trim();
  const candidateCommit = gitCandidate.git.candidateCommit;
  assert.equal(managed(['rev-parse', `${candidateCommit}^`]), context.attestedRelease.sourceCommit, 'the candidate commit descends from the installed commit');
  assert.equal(managed(['rev-parse', `refs/heads/${gitCandidate.git.repairBranch}`]), candidateCommit);
  assert.deepEqual(managed(['diff', '--name-only', context.attestedRelease.sourceCommit, candidateCommit]).split(/\r?\n/), [...expectedChanges].sort());
  const changeManifest = artifactJson(profile, candidate.changeManifest);
  assert.deepEqual(changeManifest.mutationClassification.tiers, [...expectedTiers].sort(), 'the captured verification tiers of the candidate');
  const receipt = artifactJson(profile, receiptRef);
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.candidateId, candidate.candidateId);
  assert.deepEqual(receipt.checks.find(item => item.checkId === 'incident-reproducer').completedAssertions, ['incident-captured', 'incident-repaired']);
  assert.deepEqual(receipt.checks.find(item => item.checkId === 'authority-regression').completedAssertions, ['authority-path-guard', 'authority-receipt-identity']);
  // The verification inputs bind the same P3 outcome revision, and the same protected reproducer fails on B and passes on C.
  const verificationInputs = artifactJson(profile, candidate.verificationInputs);
  assert.equal(verificationInputs.outcomeId, outcome.outcomeId); assert.equal(verificationInputs.outcomeRevision, outcome.revision);
  assert.ok(verificationInputs.inputs.some(item => item.artifact.artifactId === evidenceRef.id), 'the Gate input is the exact P3 evidence object');
  const causal = artifactJson(profile, receipt.causalReproduction);
  assert.equal(causal.baselineObservation.status, 'reproduced', 'the production Gate observed the defect on the installed baseline');
  assert.deepEqual(causal.baselineObservation.defectFailed, ['incident-repaired']); assert.deepEqual(causal.baselineObservation.harnessPassed, ['incident-captured']);
  assert.equal(causal.baselineObservation.exitCode, 1);
  assert.equal(causal.baselineCommit, context.attestedRelease.sourceCommit, 'R(B) ran on the exact installed commit');
  assert.equal(causal.candidateId, candidate.candidateId); assert.equal(causal.candidateObservation.status, 'passed');
  assert.equal(causal.outcomeId, outcome.outcomeId); assert.equal(causal.outcomeRevision, outcome.revision);
  assert.equal(causal.gateAttemptId, receipt.gateAttemptId);
  const dependencyClosure = artifactJson(profile, receipt.dependencyClosure);
  assert.equal(causal.dependencyClosureDigest, dependencyClosure.closureDigest, 'R(B) and R(C) ran on one bound dependency closure');
  assert.equal(dependencyClosure.installedRelease.packageSha256, context.attestedRelease.packageSha256);
  assert.equal(dependencyClosure.installedRelease.bootstrap, context.distribution === 'desktop' ? 'tauri' : 'runtime');
  const baselineReplay = replayReproducer(context, context.attestedRelease.sourceCommit, verificationInputs, 'baseline');
  assert.ok(baselineReplay.status !== 0 && baselineReplay.captured && !baselineReplay.repaired, `R(B) fails: ${baselineReplay.stdout}`);
  const candidateReplay = replayReproducer(context, candidateCommit, verificationInputs, 'candidate');
  assert.ok(candidateReplay.status === 0 && candidateReplay.captured && candidateReplay.repaired, `R(C) passes: ${candidateReplay.stdout}`);
  // The active installed v1 control is unchanged: its running files still equal the installed commit, not the candidate.
  for (const path of [context.scenario.subject, ...expectedChanges])
    assert.equal(readFileSync(join(context.installedRoot, ...path.split('/')), 'utf8'),
      context.git(context.source.root, ['show', `${context.source.releaseCommit}:${path}`]), `installed ${path} is unchanged by the candidate`);
  assert.equal(receipt.gateAttemptId, gate[0].id);
  assert.equal(receipt.execution.custodyId, custody(gate[0].id).custody_id);
  // Handoff, projection and boundaries.
  const handoff = artifactJson(profile, handoffRef);
  assert.equal(handoff.candidateId, candidate.candidateId); assert.deepEqual(handoff.gitCandidate, candidate.gitCandidate);
  for (const field of ['hostModificationAuthorized', 'hostReplacementAuthorized', 'hostUpdateAuthorized', 'branchPublished', 'activated', 'binaryInstalled'])
    assert.equal(handoff.authority[field], false, field);
  const projection = await call('GET', `/api/v2/runs/${repairRunId}/self-repair`);
  assert.equal(projection.status, 200, JSON.stringify(projection.body));
  assert.equal(projection.body.stage, 'retained_for_p6', JSON.stringify(projection.body)); assert.deepEqual(projection.body.issues, []);
  assert.equal(context.git(context.source.root, ['rev-parse', 'HEAD']).trim(), context.source.releaseCommit, 'the test source checkout is untouched');
  assert.equal(context.git(context.source.root, ['status', '--porcelain']).trim(), '');
  assert.deepEqual(context.git(context.origin, ['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/), ['refs/heads/main'], 'nothing was published');
  return { parentRunId, repairRunId, linkId, incidentId: link.incident_id, outcomeId: outcome.outcomeId, outcomeRevision: outcome.revision,
    developerAttemptId: developer[0].id, developerCustodyId: custody(developer[0].id).custody_id, gateAttemptId: gate[0].id,
    gateCustodyId: custody(gate[0].id).custody_id, candidateId: candidate.candidateId, candidateSourceDigest: candidate.candidateSourceDigest,
    installedCommit: context.attestedRelease.sourceCommit, repairBranch: gitCandidate.git.repairBranch, candidateCommit,
    candidateTree: gitCandidate.git.candidateTree, receiptId: receipt.receiptId, approvalArtifact: link.repair_approval_artifact_id,
    handoffId: handoff.handoffId, retentionRecord: retentionRef.artifactId, intent: intentRef.artifactId, verificationStarted: startRef.artifactId,
    incident, tiers: changeManifest.mutationClassification.tiers, baselineReplayExit: baselineReplay.status, candidateReplayExit: candidateReplay.status,
    causalReproduction: receipt.causalReproduction, causalBaseline: { status: causal.baselineObservation.status, exitCode: causal.baselineObservation.exitCode,
      defectFailed: causal.baselineObservation.defectFailed, baselineCommit: causal.baselineCommit },
    dependencyClosure: { record: receipt.dependencyClosure, digest: dependencyClosure.closureDigest, files: dependencyClosure.files.length,
      packages: dependencyClosure.packages, artifactList: dependencyClosure.installedRelease.artifactList },
    journal: { parent: parentEvents.filter(item => /failure_outcome|linked_repair|repair_result|resumption/.test(item.type)).map(item => `${item.sequence}:${item.type}`),
      repair: repairEvents.filter(item => item.type.startsWith('self_repair.') || item.type.startsWith('repair.')).map(item => `${item.sequence}:${item.type}`) } };
}

test('P5-E2E1-HAPPY: an installed test release repairs its own Engine source through P3 → P4 → P2 → Gate → Judge → handoff', { timeout: 900_000 }, async t => {
  const context = await provisionInstallation('happy');
  let host = null, parentRunId = null, repairRunId = null;
  try {
    host = startLifecycleHost(context.hostArgs);
    const connection = await host.firstConnection();
    const call = api(connection, connection.firstPartyToken);
    const status = await call('GET', '/api/v2/installation/source-release');
    assert.equal(status.body.protectedSelfRepair.enrollmentLoaded, true, JSON.stringify(status.body));
    assert.equal(status.body.protectedSelfRepair.admissionEnabled, true, JSON.stringify(status.body.protectedSelfRepair));
    // The runtime dependency closure is part of the attested package, so the installed Engine never resolves ambient modules.
    const manifest = JSON.parse(readFileSync(join(context.installation, 'versions', context.buildId, 'build.json'), 'utf8'));
    for (const path of ['node_modules/ajv/package.json', 'node_modules/typescript/lib/typescript.js'])
      assert.ok(manifest.artifacts.some(item => item.path === path), `${path} is a packaged, attested artifact`);
    t.diagnostic(`release ${context.release.sourceCommit} source=${context.release.sourceDigest} inputs=${context.release.inputsDigest} dependencies=${context.release.dependencyPackages.join(',')} dependencyFiles=${context.release.packagedDependencyFiles}`);
    t.diagnostic(`admission: ${JSON.stringify(status.body.protectedSelfRepair.decision)}`);
    const parent = context.parentPublication;
    const started = await call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: parent.publishedVersionId, definitionDigest: parent.definitionDigest, workspaceId: 'p5-parent', requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    parentRunId = started.body.run.runId;
    const link = await eventually(() => profileQuery(context.profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunId)[0] ?? null,
      'the P2 linked Repair created by the Parent Judge', 240_000, 250);
    repairRunId = link.repair_run_id;
    t.diagnostic(`P2 link ${link.id} Repair ${repairRunId}`);
    let approvedAt = null;
    const handoff = await eventually(() => {
      const repairEvents = journal(context.profile, repairRunId);
      if (!approvedAt && repairEvents.some(item => item.type === 'repair.approval_recorded')) approvedAt = Date.now();
      if (approvedAt && Date.now() - approvedAt > 90_000) throw new Error('The P2 approval was recorded but no handoff followed within 90 seconds.');
      const failed = [...journal(context.profile, parentRunId), ...repairEvents].find(item => item.type === 'continuation.repair_failed'
        || item.type === 'self_repair.candidate_invalidated'
        || (item.type === 'continuation.parent_resumption_blocked' && !approvedAt));
      if (failed) throw new Error(`The P5 lifecycle was blocked: ${JSON.stringify(failed.payload)}`);
      return repairEvents.find(item => item.type === 'self_repair.handoff_recorded') ?? null;
    }, 'the durable P6 handoff', 600_000, 500);
    const evidence = await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId: link.id, handoffRef: handoff.payload.record });
    t.diagnostic(`P5-E2E1-HAPPY evidence: ${JSON.stringify(evidence)}`);
    await host.shutdown(); host = null;
    const rebuilt = await reconstructHandoff({ profile: context.profile, handoffRef: handoff.payload.record, outDir: join(context.scratch.root, 'reconstructed') });
    assert.equal(rebuilt.digest, rebuilt.handoff.candidateSourceDigest, 'the reconstructed source reproduces the accepted SHA-256 identity');
    assert.equal(rebuilt.gitCandidate.git.candidateCommit, evidence.candidateCommit);
    assert.equal(readFileSync(join(context.scratch.root, 'reconstructed', 'runtime', 'core', 'incidentLabel.mjs'), 'utf8'),
      context.git(context.slotRoot + '\\source', ['show', `${evidence.candidateCommit}:runtime/core/incidentLabel.mjs`]), 'Store bytes equal the committed candidate bytes');
    assert.notEqual(readFileSync(join(context.scratch.root, 'reconstructed', 'runtime', 'core', 'incidentLabel.mjs'), 'utf8'), DEFECT);
    // E1-N18: a forged handoff reference or a corrupted reachable Store object refuses reconstruction.
    await assert.rejects(reconstructHandoff({ profile: context.profile, handoffRef: { ...handoff.payload.record, sha256: 'f'.repeat(64) },
      outDir: join(context.scratch.root, 'reconstructed-forged') }));
    const corruptProfile = join(context.scratch.root, 'corrupt-profile');
    cpSync(context.profile, corruptProfile, { recursive: true });
    const entry = rebuilt.manifest.entries.find(item => item.path === 'runtime/core/incidentLabel.mjs');
    const row = profileQuery(corruptProfile, 'SELECT relative_path FROM artifacts WHERE id = ?', entry.artifact.artifactId)[0];
    writeFileSync(join(corruptProfile, 'store', ...row.relative_path.split('/')), 'tampered');
    await assert.rejects(reconstructHandoff({ profile: corruptProfile, handoffRef: handoff.payload.record, outDir: join(context.scratch.root, 'reconstructed-corrupt') }));
  } catch (error) {
    error.message += `\n${diagnostics(context, host, [parentRunId, repairRunId])}`;
    try {
      const live = currentDescriptor(context.profile);
      const token = host?.tokens?.at(-1)?.firstPartyToken;
      if (live && token && repairRunId) {
        const snapshot = await api(live, token)('GET', `/api/v2/runs/${repairRunId}`);
        error.message += `\nLive Repair snapshot: ${JSON.stringify(snapshot.body).slice(0, 6000)}`;
      }
      error.message += `\nLive link: ${JSON.stringify(profileQuery(context.profile, 'SELECT * FROM run_links')[0])}`;
    } catch (diagnosticError) { error.message += `\nLive diagnostics failed: ${diagnosticError.message}`; }
    throw error;
  } finally {
    if (host) await host.shutdown();
    await context.close();
  }
});

const latestEngine = installation => hostEvents(installation).filter(item => item.type === 'engine_ready').at(-1)?.payload ?? null;
const processAlive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(String(pid));
const invocationCount = (fixtureState, model) => {
  const path = join(fixtureState, 'invocations.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.endsWith(` ${model}`)).length : 0;
};

/** End the managed Engine process (never its Host or the Host-owned CLIs) and wait for the Host's supported relaunch. */
async function replaceEngine(context, host, reason) {
  const before = latestEngine(context.installation);
  assert.ok(before?.enginePid, `${reason}: a ready managed Engine exists`);
  const descriptors = host.tokens.length;
  spawnSync('taskkill', ['/PID', String(before.enginePid), '/F'], { windowsHide: true, stdio: 'ignore' });
  await eventually(() => !processAlive(before.enginePid), `${reason}: Engine ${before.enginePid} to end`, 30_000, 100);
  const after = await eventually(() => {
    const ready = latestEngine(context.installation);
    return ready && ready.enginePid !== before.enginePid ? ready : null;
  }, `${reason}: the Host to relaunch a replacement Engine`, 120_000, 200);
  assert.ok(hostEvents(context.installation).some(item => item.type === 'managed_application_relaunched' && item.payload.previousPid === before.enginePid),
    `${reason}: the Lifecycle Host relaunched the active build after the abnormal exit`);
  assert.equal(after.generation, before.generation, `${reason}: the lifecycle generation is unchanged`);
  // The replacement Engine announces its own port and first-party token; the previous descriptor is stale.
  const descriptor = await eventually(() => host.tokens.length > descriptors ? host.tokens.at(-1) : null,
    `${reason}: the replacement Engine setup descriptor`, 120_000, 100);
  return { before, after, call: api(descriptor, descriptor.firstPartyToken) };
}

test('P5-E2E1-DEVELOPER-RECOVERY, GATE-RECOVERY and repeated restart: Engine replacement reattaches live Custody work exactly once', { timeout: 1_200_000 }, async t => {
  const context = await provisionInstallation('recovery', { developerModel: 'custody-p5-developer-gated', gateBarrier: true });
  const marker = name => join(context.scratch.fixtureState, name);
  let host = null, parentRunId = null, repairRunId = null;
  try {
    host = startLifecycleHost(context.hostArgs);
    const connection = await host.firstConnection();
    let call = api(connection, connection.firstPartyToken);
    const parent = context.parentPublication;
    const started = await call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
      publishedVersionId: parent.publishedVersionId, definitionDigest: parent.definitionDigest, workspaceId: 'p5-parent', requestId: randomUUID() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    parentRunId = started.body.run.runId;
    const link = await eventually(() => profileQuery(context.profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunId)[0] ?? null,
      'the P2 linked Repair', 240_000, 250);
    repairRunId = link.repair_run_id;

    // R1: Developer live under Custody when Engine A ends.
    await eventually(() => existsSync(marker('READY-P5_DEVELOPER.marker')), 'the custodied Developer to reach its barrier', 240_000, 100);
    const developerPid = Number(readFileSync(marker('READY-P5_DEVELOPER.marker'), 'utf8').split(' ')[0]);
    const [developer] = attemptOf(context.profile, repairRunId, 'developer');
    const developerCustody = profileQuery(context.profile, 'SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', developer.id)[0].custody_id;
    const r1 = await replaceEngine(context, host, 'R1');
    call = r1.call;
    assert.equal(processAlive(developerPid), true, 'the Host-owned Developer survives Engine A');
    writeFileSync(marker('RELEASE-P5_DEVELOPER.marker'), 'release\n');

    // R2: the trusted verifier live under Custody when Engine B ends.
    await eventually(() => {
      const failed = journal(context.profile, repairRunId).find(item => ['continuation.repair_failed', 'self_repair.candidate_invalidated'].includes(item.type));
      if (failed) throw new Error(`The P5 lifecycle failed after R1: ${JSON.stringify(failed.payload)}`);
      return existsSync(marker('READY-P5_GATE.marker'));
    }, 'the trusted verifier check to reach its barrier', 300_000, 100);
    const checkPid = Number(readFileSync(marker('READY-P5_GATE.marker'), 'utf8'));
    const [gate] = attemptOf(context.profile, repairRunId, 'verify');
    const gateCustody = profileQuery(context.profile, 'SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', gate.id)[0].custody_id;
    assert.equal(journal(context.profile, repairRunId).filter(item => item.type === 'self_repair.candidate_captured').length, 1);
    const r2 = await replaceEngine(context, host, 'R2');
    call = r2.call;
    assert.equal(processAlive(checkPid), true, 'the Host-owned verifier check survives Engine B');
    writeFileSync(marker('RELEASE-P5_GATE.marker'), 'release\n');

    const handoff = await eventually(() => {
      const repairEvents = journal(context.profile, repairRunId);
      const failed = repairEvents.find(item => ['continuation.repair_failed', 'self_repair.candidate_invalidated'].includes(item.type));
      if (failed) throw new Error(`The P5 lifecycle failed after R2: ${JSON.stringify(failed.payload)}`);
      return repairEvents.find(item => item.type === 'self_repair.handoff_recorded') ?? null;
    }, 'the durable handoff after both Engine replacements', 600_000, 500);
    const evidence = await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId: link.id, handoffRef: handoff.payload.record });
    assert.equal(evidence.developerAttemptId, developer.id, 'R1: the same Developer Attempt settled');
    assert.equal(evidence.developerCustodyId, developerCustody, 'R1: the same Host invocation settled');
    assert.equal(evidence.gateAttemptId, gate.id, 'R2: the same Gate Attempt issued the receipt');
    assert.equal(evidence.gateCustodyId, gateCustody, 'R2: the same verifier invocation');
    assert.equal(invocationCount(context.scratch.fixtureState, 'custody-p5-developer-gated'), 1, 'no duplicate Developer launch');

    // R3: a further Engine generation after completion changes no completed history.
    // Logical history: every journal event except the per-startup `continuation.reconciled` receipt an Engine writes on boot.
    const logical = runId => journal(context.profile, runId).filter(item => item.type !== 'continuation.reconciled').map(item => item.type);
    const history = () => ({ repair: logical(repairRunId), parent: logical(parentRunId),
      attempts: profileQuery(context.profile, 'SELECT COUNT(*) AS n FROM attempts')[0].n, links: profileQuery(context.profile, 'SELECT COUNT(*) AS n FROM run_links')[0].n,
      custody: profileQuery(context.profile, 'SELECT COUNT(*) AS n FROM attempt_custody')[0].n,
      refs: context.git(`${context.slotRoot}\\source`, ['for-each-ref', '--format=%(refname) %(objectname)']) });
    const before = { ...history(), parentTotal: journal(context.profile, parentRunId).length, repairTotal: journal(context.profile, repairRunId).length };
    const r3 = await replaceEngine(context, host, 'R3');
    await new Promise(done => setTimeout(done, 10_000));
    const { parentTotal: _p, repairTotal: _r, ...beforeLogical } = before;
    assert.deepEqual(history(), beforeLogical, 'R3: repeated startup adds no link, Attempt, candidate, commit, receipt, decision, approval or handoff');
    const added = journal(context.profile, parentRunId).slice(before.parentTotal).concat(journal(context.profile, repairRunId).slice(before.repairTotal));
    assert.ok(added.every(item => item.type === 'continuation.reconciled'), `R3 added only startup reconciliation receipts: ${JSON.stringify(added.map(item => item.type))}`);
    const projection = await r3.call('GET', `/api/v2/runs/${repairRunId}/self-repair`);
    assert.equal(projection.body.stage, 'retained_for_p6', JSON.stringify(projection.body));
    t.diagnostic(`P5-E2E1-RECOVERY evidence: ${JSON.stringify({ ...evidence, engines: [r1.before.enginePid, r1.after.enginePid, r2.after.enginePid, r3.after.enginePid],
      lifecycleGeneration: r1.before.generation, developerPid, checkPid })}`);
  } catch (error) {
    error.message += `\n${diagnostics(context, host, [parentRunId, repairRunId])}`;
    throw error;
  } finally {
    for (const name of ['RELEASE-P5_DEVELOPER.marker', 'RELEASE-P5_GATE.marker']) if (!existsSync(marker(name))) writeFileSync(marker(name), 'teardown\n');
    if (host) await host.shutdown();
    await context.close();
  }
});

const startParent = async (context, call) => {
  const parent = context.parentPublication;
  return call('POST', '/api/v2/runs', { workflowId: parent.workflow.workflowId, workflowSnapshotSha256: parent.snapshotSha256,
    publishedVersionId: parent.publishedVersionId, definitionDigest: parent.definitionDigest, workspaceId: 'p5-parent', requestId: randomUUID() });
};

/** Run one installed case to its settled outcome and return the durable record for assertions. */
async function runInstalledCase(label, options, { duringGate = null, inspect = null, beforeSettle = null } = {}) {
  const context = await provisionInstallation(label, options);
  let host = null, parentRunId = null, repairRunId = null;
  const hostDigestBefore = sha256(readFileSync(context.hostArgs.allowedExecutables[0].path));
  try {
    host = startLifecycleHost(context.hostArgs);
    const connection = await host.firstConnection();
    let call = api(connection, connection.firstPartyToken);
    const started = await startParent(context, call);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    parentRunId = started.body.run.runId;
    const link = await eventually(() => profileQuery(context.profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunId)[0] ?? null,
      'the P2 linked Repair', 240_000, 250);
    repairRunId = link.repair_run_id;
    if (duringGate) {
      await eventually(() => existsSync(join(context.scratch.fixtureState, 'READY-P5_GATE.marker')), 'the verifier to reach its barrier', 300_000, 100);
      await duringGate({ context, call, parentRunId, repairRunId });
      writeFileSync(join(context.scratch.fixtureState, 'RELEASE-P5_GATE.marker'), 'release\n');
    }
    // A hook may replace the Engine; it then returns the replacement Engine's API.
    if (beforeSettle) call = (await beforeSettle({ context, call, host, parentRunId, repairRunId }))?.call ?? call;
    await eventually(() => {
      const repairEvents = journal(context.profile, repairRunId);
      const current = profileQuery(context.profile, 'SELECT * FROM run_links WHERE id = ?', link.id)[0];
      const run = profileQuery(context.profile, 'SELECT state FROM runs WHERE id = ?', repairRunId)[0];
      // A Judge-held run (rejected or blocked decision, run waiting_for_user) is a settled fail-closed outcome for the Owner.
      const lastJudge = repairEvents.filter(item => item.type.startsWith('judge.')).at(-1)?.type;
      const held = run.state === 'waiting_for_user' && ['judge.admission_blocked', 'judge.decision_rejected'].includes(lastJudge);
      return repairEvents.some(item => ['self_repair.handoff_recorded', 'continuation.repair_failed'].includes(item.type))
        || held || current.state !== 'open' || ['failed', 'canceled', 'succeeded'].includes(run.state);
    }, `the ${label} case to settle`, 600_000, 500);
    await new Promise(done => setTimeout(done, 3_000));
    const repairEvents = journal(context.profile, repairRunId);
    const errors = repairEvents.filter(item => item.type === 'attempt.error').map(item => item.payload);
    const receipts = repairEvents.filter(item => item.type === 'self_repair.verification_recorded').map(item => artifactJson(context.profile, item.payload.record));
    // After a Host relaunch the newest Engine descriptor is the live API (runtime bootstrap announces it on stdout).
    const newest = host.tokens.at(-1);
    if (newest && hostEvents(context.installation).some(item => item.type === 'managed_application_relaunched')) call = api(newest, newest.firstPartyToken);
    const inspected = inspect ? await inspect({ context, call, parentRunId, repairRunId, linkId: link.id, repairEvents }) : null;
    return { context, call, parentRunId, repairRunId, linkId: link.id, repairEvents, errors, receipts, hostDigestBefore, inspected,
      count: type => repairEvents.filter(item => item.type === type).length,
      finalLink: profileQuery(context.profile, 'SELECT * FROM run_links WHERE id = ?', link.id)[0] };
  } catch (error) {
    error.message += `\n${diagnostics(context, host, [parentRunId, repairRunId])}`;
    throw error;
  } finally {
    const release = join(context.scratch.fixtureState, 'RELEASE-P5_GATE.marker');
    if (options.gateBarrier && !existsSync(release)) writeFileSync(release, 'teardown\n');
    if (host) await host.shutdown();
    await context.close();
  }
}

const handoffOf = repairEvents => repairEvents.find(item => item.type === 'self_repair.handoff_recorded')?.payload.record ?? null;
const installedSha = (context, path) => sha256(readFileSync(join(context.installedRoot, ...path.split('/'))));

/** F9: the Owner request records the durable intent (202); the Engine executes it; the client reads the durable state. */
async function publishAndAwait(call, repairRunId) {
  const requested = await call('POST', `/api/v2/runs/${repairRunId}/self-repair/publication`, {});
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  assert.equal(requested.body.status, 'intent_recorded');
  let state = null;
  await eventually(async () => {
    state = (await call('GET', `/api/v2/runs/${repairRunId}/self-repair/publication`)).body;
    return ['published', 'not_published', 'conflict'].includes(state.state);
  }, 'the publication to settle', 120_000, 250);
  return { requested: requested.body, state };
}

// P5-FINAL Checkpoint I: the corrected policy repairs a formerly refused Engine control module (engine.mjs loop scheduling)
// and a P5 module (protectedSelfRepair.mjs) through the full installed lifecycle, under the strictest applicable tier.
// The Owner-granted publication policy is enrolled for both; ENGINE-CORE publishes through the Engine route, P5-MODULE stops
// the Parent after acceptance and shows that the historical approval no longer authorizes publication (P5-FINAL §8.2, §14).
for (const [id, scenario, tiers, publishAction] of [['P5-FINAL-ENGINE-CORE', 'engine', ['repair-authority'], 'publish'], ['P5-FINAL-P5-MODULE', 'p5', ['repair-authority'], 'stop-then-publish']]) {
  test(`${id}: an installed release repairs ${SCENARIOS[scenario].subject} through P3 → P4 → P2 → Gate → Judge → handoff`, { timeout: 900_000 }, async t => {
    const outcome = await runInstalledCase(id.toLowerCase(), { scenario, developerModel: 'custody-p5-developer-plan', developerPlan: scenarioFix(SCENARIOS[scenario]), publication: true }, {
      inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
        const handoffRef = handoffOf(repairEvents);
        assert.ok(handoffRef, `${id}: the repair reached a durable handoff: ${JSON.stringify(repairEvents.map(item => item.type))}`);
        const evidence = await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef, expectedTiers: tiers });
        const originRefs = () => context.git(context.origin, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split(/\r?\n/).sort();
        const mainBefore = context.git(context.origin, ['rev-parse', 'refs/heads/main']).trim();
        if (publishAction === 'publish') {
          const { state } = await publishAndAwait(call, repairRunId);
          assert.equal(state.state, 'published', JSON.stringify(state)); assert.equal(state.pushed, true);
          assert.equal(state.commit, evidence.candidateCommit);
          assert.deepEqual(originRefs(), [`refs/heads/${evidence.repairBranch} ${evidence.candidateCommit}`, `refs/heads/main ${mainBefore}`].sort(),
            'exactly the accepted commit at exactly the repair ref; main untouched');
          const replay = await call('POST', `/api/v2/runs/${repairRunId}/self-repair/publication`, {});
          assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.replay, true);
          evidence.publication = { ref: state.ref, commit: state.commit, result: state.result };
        } else {
          const stopped = await call('POST', `/api/v2/runs/${parentRunId}/stop`, { requestId: randomUUID() });
          assert.ok([200, 202].includes(stopped.status), JSON.stringify(stopped.body));
          await eventually(() => ['canceled', 'stopped'].includes(profileQuery(context.profile, 'SELECT state FROM runs WHERE id = ?', parentRunId)[0].state),
            'the Parent Stop to settle', 60_000, 250);
          const refused = await call('POST', `/api/v2/runs/${repairRunId}/self-repair/publication`, {});
          assert.equal(refused.status, 409, JSON.stringify(refused.body));
          assert.match(refused.body.message, /handoff_not_current/);
          assert.deepEqual(originRefs(), [`refs/heads/main ${mainBefore}`], 'nothing was published after the Parent Stop');
          evidence.publication = { refusedAfterParentStop: refused.body.code };
        }
        return evidence;
      } });
    assert.equal(sha256(readFileSync(outcome.context.hostArgs.allowedExecutables[0].path)), outcome.hostDigestBefore);
    t.diagnostic(`${id} evidence: ${JSON.stringify(outcome.inspected)}`);
  });
}

// P5-CLOSURE Checkpoint K: the full lifecycle on the distributed desktop runtime. The Host launches the packaged Tauri shell,
// which starts its bundled Engine; the Gate runs from the release's attested `p5/` payload with R(B)/R(C) in production, and
// the accepted branch is published asynchronously. The source-layout runtime package is not involved anywhere.
test('P5-CLOSURE-DESKTOP: the packaged desktop runtime repairs runtime/core/engine.mjs through P3 → P4 → P2 → causal Gate → Judge → handoff → publication', { timeout: 1_200_000 }, async t => {
  const lifecycleHostDigest = sha256(readFileSync(hostExecutable()));
  let layout = null;
  const outcome = await runInstalledCase('desktop', { distribution: 'desktop', scenario: 'engine', developerModel: 'custody-p5-developer-plan',
    developerPlan: scenarioFix(SCENARIOS.engine), publication: true }, {
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const status = await call('GET', '/api/v2/installation/source-release');
      assert.equal(status.body.release.bootstrap, 'tauri', 'the Host attests the desktop (tauri) release');
      assert.equal(status.body.protectedSelfRepair.admissionEnabled, true, JSON.stringify(status.body.protectedSelfRepair));
      const releaseRoot = join(context.installation, 'versions', context.buildId);
      const manifest = JSON.parse(readFileSync(join(releaseRoot, 'build.json'), 'utf8'));
      const support = JSON.parse(readFileSync(join(releaseRoot, 'p5', 'p5-support.json'), 'utf8'));
      assert.equal(manifest.bootstrap, 'tauri'); assert.equal(manifest.sourceCommit, context.source.releaseCommit);
      assert.equal(support.runtimeBundle.sha256, sha256(readFileSync(join(releaseRoot, 'runtime', 'runner.mjs'))), 'the running Engine is the reproduced bundle');
      assert.equal(manifest.p5Support.sha256, sha256(readFileSync(join(releaseRoot, 'p5', 'p5-support.json'))));
      const engines = hostEvents(context.installation).filter(item => item.type === 'application_spawned');
      assert.ok(engines.length && engines.every(item => item.payload.bootstrap === 'tauri'), 'every application launch was the desktop shell');
      layout = { bootstrap: manifest.bootstrap, packageSha256: status.body.release.packageSha256, runnerSha256: support.runtimeBundle.sha256,
        runnerBytes: support.runtimeBundle.bytes, payloadFiles: support.files.length, desktopExeSha256: sha256(readFileSync(join(releaseRoot, 'deszo.exe'))),
        supportSha256: manifest.p5Support.sha256 };
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, `the desktop repair reached a durable handoff: ${JSON.stringify(repairEvents.map(item => item.type))}`);
      const evidence = await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef, expectedTiers: ['repair-authority'] });
      const { state } = await publishAndAwait(call, repairRunId);
      assert.equal(state.state, 'published', JSON.stringify(state));
      assert.equal(context.git(context.origin, ['rev-parse', `refs/heads/${evidence.repairBranch}`]).trim(), evidence.candidateCommit);
      evidence.publication = { ref: state.ref, commit: state.commit, result: state.result };
      assert.equal(sha256(readFileSync(join(releaseRoot, 'deszo.exe'))), layout.desktopExeSha256, 'the desktop shell is unchanged');
      return evidence;
    } });
  assert.equal(sha256(readFileSync(hostExecutable())), lifecycleHostDigest, 'the Lifecycle Host executable is unchanged');
  assert.ok(!hostEvents(outcome.context.installation).some(item => /activation|update|install/.test(item.type) && !/^engine_/.test(item.type)),
    'no Host lifecycle activation, update or install through P5');
  t.diagnostic(`P5-CLOSURE-DESKTOP layout: ${JSON.stringify(layout)}`);
  t.diagnostic(`P5-CLOSURE-DESKTOP evidence: ${JSON.stringify(outcome.inspected)}`);
});

// P5-CLOSURE H1 (original E2E-14): the P5 Developer leader exits but a descendant in its Custody Job lives on, and the real Rust
// Host cannot prove the tree ended (its debug test hook drains the Job only briefly and does not terminate it). The established
// Custody contract applies to P5 unchanged: the Attempt is not accepted, its workspace stays held until the Host proves the end,
// and nothing is captured, sealed, verified, accepted or published; an Engine replacement during the hold relaunches nothing.
test('P5-CLOSURE-UNCERTAIN-TREE: an unproven P5 Developer tree is never captured and holds its workspace across Engine replacement until the Host proves the end', { timeout: 1_200_000 }, async t => {
  let observed = null;
  const outcome = await runInstalledCase('uncertain-tree', { developerModel: 'custody-p5-developer-plan-orphan', developerPlan: scenarioFix(SCENARIOS.label),
    developerOrphanMs: 75_000, custodyTest: { testUndrainedDrainMs: 300 } }, {
    beforeSettle: async ({ context, host, repairRunId }) => {
      const fixture = name => join(context.scratch.fixtureState, name);
      await eventually(() => existsSync(fixture('p5-developer-descendant.pid')), 'the Developer to leave its descendant running', 300_000, 100);
      // The descendant appends a tick every 100 ms while it lives: a growing log is direct evidence the tree has not ended.
      const ticks = () => existsSync(fixture('p5-orphan.log')) ? readFileSync(fixture('p5-orphan.log'), 'utf8').split(/\n/).filter(Boolean).length : 0;
      const alive = async () => { const before = ticks(); await new Promise(done => setTimeout(done, 1_500)); return ticks() > before; };
      const developer = () => attemptOf(context.profile, repairRunId, 'developer');
      const p5Events = () => journal(context.profile, repairRunId).map(item => item.type).filter(type => /capture|verification_started|handoff|publication/.test(type));
      const hold = () => profileQuery(context.profile, 'SELECT state FROM custody_workspace_holds WHERE attempt_id = ?', developer()[0].id)[0]?.state ?? null;
      await eventually(() => developer()[0]?.state === 'failed', 'the unproven Developer Attempt to be refused', 120_000, 250);
      assert.ok(await alive(), 'the descendant still runs, so the tree end is unproven');
      const refusal = journal(context.profile, repairRunId).find(item => item.type === 'attempt.error' && /process tree ended/.test(item.payload?.message ?? ''))?.payload;
      assert.match(refusal?.message ?? '', /not proven that its process tree ended/, JSON.stringify(refusal));
      assert.deepEqual(p5Events(), [], 'no capture anchor, commit intent, candidate, verification or handoff while uncertain');
      assert.equal(hold(), 'held', 'the workspace is held while the Host has not proven the end');
      const custodyId = profileQuery(context.profile, 'SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', developer()[0].id)[0]?.custody_id;
      const replaced = await replaceEngine(context, host, 'uncertain Developer tree');
      await new Promise(done => setTimeout(done, 5_000));
      assert.ok(await alive(), 'still unproven after the replacement');
      assert.deepEqual(p5Events(), [], 'the replacement Engine captured nothing');
      assert.equal(hold(), 'held', 'the hold survives the Engine replacement');
      assert.equal(developer().length, 1, 'no replacement Developer Attempt');
      assert.equal(invocationCount(context.scratch.fixtureState, 'custody-p5-developer-plan-orphan'), 1, 'the Developer CLI ran once');
      await eventually(async () => !(await alive()), 'the descendant to end', 180_000, 500);
      await eventually(() => hold() !== 'held', 'the Host proof of the tree end to release the workspace hold', 180_000, 500);
      observed = { attemptId: developer()[0].id, custodyId, holdAfterProof: hold(), enginesBefore: replaced.before.enginePid, enginesAfter: replaced.after.enginePid };
      return { call: replaced.call };
    } });
  for (const type of ['self_repair.candidate_capture_started', 'self_repair.git_commit_intent', 'self_repair.candidate_captured',
    'self_repair.verification_started', 'self_repair.handoff_recorded', 'self_repair.publication_intent'])
    assert.equal(outcome.count(type), 0, `${type} after an unproven Developer tree`);
  assertNoAcceptance(outcome, 'P5-CLOSURE-UNCERTAIN-TREE');
  t.diagnostic(`P5-CLOSURE-UNCERTAIN-TREE: ${JSON.stringify(observed)}`);
});

// P5-CLOSURE H3 / original C07: the Engine exits after the verifier's terminal completion and before the receipt transaction.
// The replacement Engine reattaches the same Gate Attempt and Custody invocation, settles it once and issues one receipt that
// keeps the admitting epoch (E-06); the checks are not run again.
test('P5-CLOSURE-C07: an Engine exit between verifier completion and receipt issues exactly one receipt for the original Gate Attempt', { timeout: 1_200_000 }, async t => {
  const outcome = await runInstalledCase('c07', { crashOnce: 'p5_before_gate_receipt' }, {
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, `the reattached Gate settled to a handoff: ${JSON.stringify(repairEvents.map(item => item.type))}`);
      return { evidence: await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef }), crash: readFileSync(join(context.scratch.fixtureState, 'p5-crash-once.txt'), 'utf8') };
    } });
  const { evidence, crash } = outcome.inspected;
  assert.equal(crash, 'consumed', 'the Engine really exited at the receipt boundary');
  assert.ok(hostEvents(outcome.context.installation).some(item => item.type === 'managed_application_relaunched'), 'the Host relaunched the Engine');
  assert.equal(outcome.count('self_repair.verification_started'), 1, 'one Gate start, never a second verifier');
  assert.equal(attemptOf(outcome.context.profile, outcome.repairRunId, 'verify').length, 1, 'one Gate Attempt');
  const receipts = outcome.receipts.filter(item => item.kind === 'ProtectedSelfRepairVerificationReceipt');
  assert.equal(receipts.length, 1, 'exactly one receipt');
  const start = artifactJson(outcome.context.profile, outcome.repairEvents.find(item => item.type === 'self_repair.verification_started').payload.record);
  assert.equal(receipts[0].execution.engineEpoch, start.engineEpoch, 'the receipt binds the admitting Engine epoch');
  t.diagnostic(`P5-CLOSURE-C07: gate ${evidence.gateAttemptId} custody ${evidence.gateCustodyId} receipt ${evidence.receiptId} admittingEpoch ${start.engineEpoch}`);
});

// P5-CLOSURE H3 / original C09: the Repair Judge is running its accepting decision when the Engine is replaced. The replacement
// reattaches the same Judge Attempt; no second Judge runs for that attention, and acceptance happens once.
test('P5-CLOSURE-C09: a Repair Judge active during Engine replacement is reattached and accepts exactly once', { timeout: 1_200_000 }, async t => {
  const outcome = await runInstalledCase('c09', { judgeModel: 'custody-p5-repair-judge-gated' }, {
    beforeSettle: async ({ context, host }) => {
      const fixture = name => join(context.scratch.fixtureState, name);
      await eventually(() => existsSync(fixture('READY-P5_JUDGE.marker')), 'the Repair Judge accepting call to start', 600_000, 200);
      const judgeCalls = invocationCount(context.scratch.fixtureState, 'custody-p5-repair-judge-gated');
      const replaced = await replaceEngine(context, host, 'active Repair Judge');
      await new Promise(done => setTimeout(done, 3_000));
      assert.equal(invocationCount(context.scratch.fixtureState, 'custody-p5-repair-judge-gated'), judgeCalls, 'no second Judge was launched by the replacement');
      writeFileSync(fixture('RELEASE-P5_JUDGE.marker'), 'release\n');
      return { call: replaced.call, judgeCalls };
    },
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, `the reattached Judge accepted: ${JSON.stringify(repairEvents.map(item => item.type))}`);
      return collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef });
    } });
  assert.equal(outcome.count('repair.approval_recorded'), 1, 'one acceptance');
  assert.equal(outcome.count('self_repair.handoff_recorded'), 1, 'one handoff');
  t.diagnostic(`P5-CLOSURE-C09: judge invocations ${invocationCount(outcome.context.scratch.fixtureState, 'custody-p5-repair-judge-gated')} handoff ${outcome.inspected.handoffId}`);
});

// P5-CLOSURE F10: a transient Host failure during capture is a held, bounded, durable retry of the exact same capture.
test('P5-CLOSURE-F10-RECOVER: a transient Host failure after the candidate commit is retried on its bounded budget and captures exactly once', { timeout: 900_000 }, async t => {
  const outcome = await runInstalledCase('f10-recover', { transientCaptureFault: 'p5_after_git_candidate_bound 2' }, {
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, `the held capture recovered to a handoff: ${JSON.stringify(repairEvents.map(item => item.type))}`);
      return collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef });
    } });
  const holds = outcome.repairEvents.filter(item => item.type === 'self_repair.capture_held').map(item => ({ payload: artifactJson(outcome.context.profile, item.payload.record) }));
  assert.deepEqual(holds.map(item => item.payload.holdNumber), [1, 2], 'two durable bounded holds before the capture succeeded');
  assert.ok(holds.every(item => item.payload.code === 'ECONNRESET' && item.payload.attemptId === outcome.inspected.developerAttemptId));
  // collectLifecycleEvidence asserted exactly one anchor, one Git commit intent, one candidate and one Developer Attempt.
  t.diagnostic(`P5-CLOSURE-F10-RECOVER: holds ${JSON.stringify(holds.map(item => item.payload))} candidate ${outcome.inspected.candidateCommit}`);
});

test('P5-CLOSURE-F10-EXHAUST: a capture that stays unavailable fails closed after the bounded budget, with no candidate', { timeout: 900_000 }, async t => {
  const outcome = await runInstalledCase('f10-exhaust', { transientCaptureFault: 'p5_before_capture_anchor 9' });
  const holds = outcome.repairEvents.filter(item => item.type === 'self_repair.capture_held').map(item => ({ payload: artifactJson(outcome.context.profile, item.payload.record) }));
  assert.deepEqual(holds.map(item => item.payload.holdNumber), [1, 2, 3]);
  for (const type of ['self_repair.candidate_capture_started', 'self_repair.git_commit_intent', 'self_repair.candidate_captured', 'self_repair.verification_started'])
    assert.equal(outcome.count(type), 0, `${type} after an exhausted capture budget`);
  const developer = attemptOf(outcome.context.profile, outcome.repairRunId, 'developer');
  assert.equal(developer.length, 1, 'the Developer is never launched twice');
  assert.equal(developer[0].state, 'failed');
  assert.ok(outcome.errors.some(item => /stayed unavailable after 3 bounded retries/.test(item.message)), JSON.stringify(outcome.errors));
  assertNoAcceptance(outcome, 'P5-CLOSURE-F10-EXHAUST');
  t.diagnostic(`P5-CLOSURE-F10-EXHAUST: holds ${holds.length}, attempt ${developer[0].id} ${developer[0].state}`);
});

// Re-review: Root Stop during a held capture cancels the held Attempt at once; nothing is retried, captured or accepted.
test('P5-CLOSURE-F10-STOP: Root Stop during a held capture cancels the held Attempt and nothing is captured', { timeout: 900_000 }, async t => {
  const outcome = await runInstalledCase('f10-stop', { transientCaptureFault: 'p5_before_capture_anchor 9' }, {
    beforeSettle: async ({ context, call, parentRunId, repairRunId }) => {
      await eventually(() => journal(context.profile, repairRunId).some(item => item.type === 'self_repair.capture_held'), 'the capture to be held', 600_000, 250);
      const stopped = await call('POST', `/api/v2/runs/${parentRunId}/stop`, { requestId: randomUUID() });
      assert.ok([200, 202].includes(stopped.status), JSON.stringify(stopped.body));
      await eventually(() => attemptOf(context.profile, repairRunId, 'developer')[0]?.state === 'canceled', 'the held Attempt to be cancelled', 60_000, 250);
      await new Promise(done => setTimeout(done, 15_000));
    } });
  const holds = outcome.repairEvents.filter(item => item.type === 'self_repair.capture_held');
  assert.equal(holds.length, 1, 'the Stop prevented every further retry');
  for (const type of ['self_repair.candidate_capture_started', 'self_repair.git_commit_intent', 'self_repair.candidate_captured', 'self_repair.verification_started'])
    assert.equal(outcome.count(type), 0, type);
  assertNoAcceptance(outcome, 'P5-CLOSURE-F10-STOP');
  t.diagnostic(`P5-CLOSURE-F10-STOP: holds ${holds.length}, developer ${attemptOf(outcome.context.profile, outcome.repairRunId, 'developer')[0].state}`);
});

// P5-FINAL §5 negatives: a candidate that edits its own verification logic, removes the protected assertions, or changes
// authorization behavior cannot obtain acceptance on anything but the installed v1 checks.
test('P5-FINAL-NEG-VERIFIER: a candidate that tampers with the verifier and leaves the defect gets no passing receipt', { timeout: 900_000 }, async () => {
  const plan = [['append', 'runtime/verification/p5Verifier.mjs', '', '\nexport const candidateVerifierAlwaysPasses = true;\n']];
  const outcome = await runInstalledCase('neg-verifier', { scenario: 'engine', developerModel: 'custody-p5-developer-plan', developerPlan: plan },
    { inspect: async ({ context }) => ({ verifierSha: installedSha(context, 'runtime/verification/p5Verifier.mjs'),
      releaseSha: sha256(context.git(context.source.root, ['show', `${context.source.releaseCommit}:runtime/verification/p5Verifier.mjs`])) }) });
  assert.equal(outcome.count('self_repair.candidate_captured'), 1, 'the repair-authority candidate is representable');
  assert.ok(!outcome.receipts.some(item => item.kind === 'ProtectedSelfRepairVerificationReceipt' && item.status === 'passed'), 'no passing receipt');
  assert.equal(outcome.inspected.verifierSha, outcome.inspected.releaseSha, 'the installed v1 verifier stayed the trusted verifier');
  assertNoAcceptance(outcome, 'P5-FINAL-NEG-VERIFIER');
});

test('P5-FINAL-NEG-ASSERTIONS: a candidate that rewrites the protected reproducer to pass gets no passing receipt', { timeout: 900_000 }, async () => {
  const plan = [['write', REPRODUCER_PATH, '', "import test from 'node:test';\ntest('incident-captured', () => {});\ntest('incident-repaired', () => {});\n"]];
  const outcome = await runInstalledCase('neg-assertions', { scenario: 'engine', developerModel: 'custody-p5-developer-plan', developerPlan: plan });
  assert.ok(!outcome.receipts.some(item => item.kind === 'ProtectedSelfRepairVerificationReceipt' && item.status === 'passed'), 'no passing receipt');
  assertNoAcceptance(outcome, 'P5-FINAL-NEG-ASSERTIONS');
});

test('P5-FINAL-NEG-AUTHORIZATION: candidate authorization changes are verified as future code and never govern the current repair', { timeout: 900_000 }, async () => {
  const plan = [...scenarioFix(SCENARIOS.engine),
    ['append', 'runtime/core/workflowJudge.mjs', '', '\n// Candidate change: approve every repair without evidence.\nexport const candidateApprovesEverything = true;\n']];
  const outcome = await runInstalledCase('neg-authorization', { scenario: 'engine', developerModel: 'custody-p5-developer-plan', developerPlan: plan }, {
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, 'the valid repair is still judged on the installed v1 evidence path');
      const evidence = await collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef,
        expectedChanges: ['runtime/core/engine.mjs', 'runtime/core/workflowJudge.mjs'], expectedTiers: ['repair-authority'] });
      return { evidence, judgeSha: installedSha(context, 'runtime/core/workflowJudge.mjs'),
        releaseSha: sha256(context.git(context.source.root, ['show', `${context.source.releaseCommit}:runtime/core/workflowJudge.mjs`])) };
    } });
  assert.equal(outcome.inspected.judgeSha, outcome.inspected.releaseSha, 'the installed v1 Judge implementation is unchanged');
  assert.ok(outcome.count('judge.evidence_read') + outcome.count('self_repair.review_delivery_carried') >= 1
    || outcome.repairEvents.some(item => item.type === 'judge.decision_applied'), 'the Repair Judge decided through the installed v1 dossier path');
});

// P5-FINAL §14: after the dossier was delivered the Repair Judge asks the Owner a semantic question. The Owner answers the exact
// pending Repair question through the Engine API; the review-delivery lineage is carried into the answered attention, no new
// evidence allowance is granted, and acceptance happens only on that carried dossier.
test('P5-FINAL-JUDGE-QUESTION: an Owner answer to the Repair Judge preserves the delivered dossier lineage', { timeout: 900_000 }, async t => {
  let answered = null;
  const outcome = await runInstalledCase('judge-question', { scenario: 'engine', developerModel: 'custody-p5-developer-plan',
    developerPlan: scenarioFix(SCENARIOS.engine), judgeModel: 'custody-p5-repair-judge-question' }, {
    beforeSettle: async ({ context, call, repairRunId }) => {
      const question = await eventually(() => profileQuery(context.profile,
        "SELECT * FROM workflow_questions WHERE originating_run_id = ? AND status = 'pending'", repairRunId)[0] ?? null, 'the Repair Judge question', 420_000, 500);
      await eventually(() => profileQuery(context.profile, 'SELECT state FROM runs WHERE id = ?', question.root_run_id)[0]?.state === 'waiting_for_user',
        'the root Run to wait for the Owner', 60_000, 250);
      const response = await call('POST', `/api/v2/judge-questions/${question.id}/answers`, { requestId: randomUUID(),
        answer: { type: 'text', value: 'P5-OWNER-ANSWER: yes, pausing at the iteration limit is intended.' } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      answered = { questionId: question.id, judgeAttemptId: response.body.judgeAttemptId };
    },
    inspect: async ({ context, call, parentRunId, repairRunId, linkId, repairEvents }) => {
      const handoffRef = handoffOf(repairEvents);
      assert.ok(handoffRef, `the answered repair reached a handoff: ${JSON.stringify(repairEvents.map(item => item.type))}`);
      return collectLifecycleEvidence(context, call, { parentRunId, repairRunId, linkId, handoffRef });
    } });
  assert.ok(answered, 'the Owner answered the pending Repair question');
  const carries = outcome.repairEvents.filter(item => item.type === 'self_repair.review_delivery_carried');
  assert.equal(carries.length, 1, 'the dossier lineage is carried exactly once across the answer');
  const carry = artifactJson(outcome.context.profile, carries[0].payload.record);
  assert.equal(carry.questionId, answered.questionId);
  assert.equal(carry.receiptId, outcome.inspected.receiptId);
  assert.equal(outcome.count('judge.evidence_read'), 1, 'no second evidence expansion was granted for the answer');
  assert.equal(outcome.count('repair.approval_recorded'), 1);
  t.diagnostic(`P5-FINAL-JUDGE-QUESTION: question ${answered.questionId} carry ${JSON.stringify(carries[0].payload.record)} handoff ${outcome.inspected.handoffId}`);
});

const assertNoAcceptance = (outcome, label) => {
  assert.equal(outcome.count('repair.approval_recorded'), 0, `${label}: no P2 approval`);
  assert.equal(outcome.count('self_repair.handoff_recorded'), 0, `${label}: no handoff`);
  assert.notEqual(outcome.finalLink.decision_status, 'accepted', `${label}: the link is not accepted`);
};

for (const [id, model, path] of [['E1-N05', 'custody-p5-developer-host', 'lifecycle-host/src/custody.rs'],
  ['E1-N06', 'custody-p5-developer-indirect', 'runtime/core/transport.mjs']]) {
  test(`P5-E2E1-NEGATIVE ${id}: a Developer change to ${path} is refused at capture`, { timeout: 900_000 }, async () => {
    const outcome = await runInstalledCase(id.toLowerCase(), { developerModel: model });
    assert.equal(outcome.count('self_repair.candidate_captured'), 0, `${id}: no candidate is captured`);
    // P3 normalizes the Attempt error code; the durable message carries the exact boundary refusal and path.
    assert.ok(outcome.errors.some(item => item.message.includes('P5 candidate capture failed closed: P5 Self-Repair may not change Lifecycle Host')
      && item.message.includes(`"${path}"`)), `${id}: ${JSON.stringify(outcome.errors)}`);
    assert.equal(outcome.receipts.length, 0, `${id}: no verification receipt`);
    assertNoAcceptance(outcome, id);
  });
}

for (const [id, model] of [['E1-N07', 'custody-p5-developer-broken'], ['E1-N08', 'custody-p5-developer-forged']]) {
  test(`P5-E2E1-NEGATIVE ${id}: a candidate that fails the protected check gets no passing receipt or approval`, { timeout: 900_000 }, async () => {
    const outcome = await runInstalledCase(id.toLowerCase(), { developerModel: model });
    assert.equal(outcome.count('self_repair.candidate_captured'), 1, `${id}: the candidate itself is captured`);
    assert.ok(!outcome.receipts.some(item => item.kind === 'ProtectedSelfRepairVerificationReceipt' && item.status === 'passed'),
      `${id}: no passing receipt: ${JSON.stringify(outcome.receipts.map(item => [item.kind, item.status]))}`);
    assertNoAcceptance(outcome, id);
  });
}

test('P5-E2E1-NEGATIVE E1-N11: a Repair Judge accepting without the delivered dossier is refused', { timeout: 900_000 }, async () => {
  const outcome = await runInstalledCase('e1-n11', { judgeModel: 'custody-p5-repair-judge-early' });
  assert.ok(outcome.receipts.some(item => item.status === 'passed'), 'the candidate itself passed verification');
  assert.ok(outcome.count('judge.decision_rejected') >= 1 || outcome.errors.some(item => /review|dossier|evidence|p5/i.test(item.message)),
    `E1-N11: the early acceptance is rejected: ${JSON.stringify(outcome.errors)}`);
  assertNoAcceptance(outcome, 'E1-N11');
});

test('P5-E2E1-NEGATIVE E1-N12: Parent Stop during the Gate prevents late acceptance and handoff', { timeout: 900_000 }, async () => {
  const outcome = await runInstalledCase('e1-n12', { gateBarrier: true }, { duringGate: async ({ call, parentRunId }) => {
    const stopped = await call('POST', `/api/v2/runs/${parentRunId}/stop`, { requestId: randomUUID() });
    assert.ok([200, 202].includes(stopped.status), JSON.stringify(stopped.body));
  } });
  assertNoAcceptance(outcome, 'E1-N12');
});

test('P5-E2E1-NEGATIVE E1-N16: Developer output requesting Host activation grants no Host update or activation', { timeout: 900_000 }, async () => {
  const outcome = await runInstalledCase('e1-n16', { developerModel: 'custody-p5-developer-activate' });
  const handoffs = outcome.repairEvents.filter(item => item.type === 'self_repair.handoff_recorded');
  assert.equal(handoffs.length, 1, 'the valid source repair is still accepted on its merits');
  const handoff = artifactJson(outcome.context.profile, handoffs[0].payload.record);
  for (const field of ['hostModificationAuthorized', 'hostReplacementAuthorized', 'hostUpdateAuthorized', 'activated', 'binaryInstalled', 'productionBuilt'])
    assert.equal(handoff.authority[field], false, field);
  assert.equal(sha256(readFileSync(outcome.context.hostArgs.allowedExecutables[0].path)), outcome.hostDigestBefore);
  const operations = hostEvents(outcome.context.installation).filter(item => /activat|candidate|staging|lifecycle_operation/i.test(item.type));
  assert.deepEqual(operations, [], 'no Lifecycle activation or staging operation was requested');
});

test('P5-E2E1-NEGATIVE E1-N01/N02/N03: missing, tampered or wrong-release enrollment keeps P5 admission closed', { timeout: 900_000 }, async () => {
  const context = await provisionInstallation('enrollment', { installEnrollment: false });
  const enrollmentPath = join(context.profile, 'p5', 'enrollment.json');
  const session = async label => {
    const host = startLifecycleHost(context.hostArgs);
    try {
      const connection = await host.firstConnection();
      const call = api(connection, connection.firstPartyToken);
      const status = (await call('GET', '/api/v2/installation/source-release')).body.protectedSelfRepair;
      const run = await startParent(context, call);
      return { status, run };
    } finally { await host.shutdown(); }
  };
  try {
    const none = await session('E1-N01');
    assert.equal(none.status.enrollmentLoaded, false); assert.equal(none.status.admissionEnabled, false);
    assert.notEqual(none.run.status, 202, `E1-N01: the P5 Parent is not admitted: ${JSON.stringify(none.run.body)}`);
    mkdirSync(join(context.profile, 'p5'), { recursive: true });
    const { canonicalize } = await import('../core/canonical.mjs');
    writeFileSync(enrollmentPath, `${canonicalize({ ...context.enrollment, baseCommit: '0'.repeat(40) })}\n`);
    const tampered = await session('E1-N03');
    assert.equal(tampered.status.admissionEnabled, false, `E1-N03: ${JSON.stringify(tampered.status)}`);
    assert.notEqual(tampered.run.status, 202);
    const { Store } = await import('../core/store.mjs');
    let store = new Store(context.profile);
    const foreignRelease = ref(store.putJson({ ...context.attestedRelease, packageSha256: 'f'.repeat(64) }));
    assert.throws(() => installP5Enrollment({ profileRoot: join(context.scratch.root, 'unused-profile'), store,
      enrollment: { ...context.enrollment, runningSourceRelease: foreignRelease }, attestedRelease: context.attestedRelease }),
    { code: 'p5_enrollment_install_refused' }, 'E1-N02: the installer refuses a release the Host did not attest');
    store.db.close();
    writeFileSync(enrollmentPath, `${canonicalize({ ...context.enrollment, runningSourceRelease: foreignRelease })}\n`);
    const wrongRelease = await session('E1-N02');
    assert.equal(wrongRelease.status.admissionEnabled, false, `E1-N02: ${JSON.stringify(wrongRelease.status)}`);
    assert.notEqual(wrongRelease.run.status, 202);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(enrollmentPath);
    store = new Store(context.profile);
    installP5Enrollment({ profileRoot: context.profile, store, enrollment: context.enrollment, attestedRelease: context.attestedRelease });
    store.db.close();
    const control = await session('control');
    assert.equal(control.status.admissionEnabled, true, `the valid installation-owned enrollment opens admission: ${JSON.stringify(control.status)}`);
    assert.equal(control.run.status, 202);
  } finally { await context.close(); }
});
