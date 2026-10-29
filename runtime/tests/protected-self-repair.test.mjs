import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Store } from '../core/store.mjs';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { check } from '../core/schemas.mjs';
import { Engine } from '../core/engine.mjs';
import { startRunner } from '../runner.mjs';
import { fixtureAdapters } from './fixture-adapters.mjs';
import { assertP5EnrollmentCurrent, assertP5VerificationPolicy, createP5Handoff, createP5ReviewDossierArtifacts, inventoryP5Source, loadP5Enrollment, materializeP5VerificationOverlay, P5_ENROLLMENT_RELATIVE_PATH, p5BaselineId, p5CandidateId, p5CheckInputDigest, p5ExecutionTreeDigest, p5SourceDigest, p5VerificationCommandDigest, p5VerificationReceiptId, sealP5Candidate, validateP5Contract, validateP5SourcePath, verifyP5EnrollmentFileCurrent, verifyP5OverlayManifest, verifyP5Receipt, verifyP5RunningSourceInventory } from '../core/protectedSelfRepair.mjs';
import { loadProtectedSelfRepairGateRecoveryBindings, materializeP5CheckInputs } from '../core/p5Gate.mjs';
import { executeP5VerifierPlan } from '../verification/p5Verifier.mjs';

const fixtureIdentity = path => {
  const info = lstatSync(path, { bigint: true });
  return { volumeId: String(info.dev), fileId: String(info.ino), reparsePoint: info.isSymbolicLink(), linkCount: Number(info.nlink) };
};
let fixtureGenerationOverride = null;
const fileEntry = (path, text) => ({ path, type: 'regular', byteSize: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)), executable: false });
const fixtureNativeSourceReader = async request => {
  const { volumeId, fileId } = fixtureIdentity(request.root);
  const rootIdentity = { volumeId, fileId };
  const inventory = request.include?.length ? inventoryP5Source(request.root, { maxFiles: request.maxFiles, maxBytes: request.maxBytes,
    include: request.include, excluded: request.exclude, identityReader: fixtureIdentity, executableFor: () => false }) : null;
  const paths = inventory?.entries.map(entry => entry.path).sort() ?? [];
  const pathDigest = sha256(Buffer.from(paths.map(path => `${path}\0`).join(''), 'ascii'));
  if (request.expectedPathsDigest && request.expectedPathsDigest !== pathDigest) throw Object.assign(new Error('Path set changed.'), { code: 'source_inventory_mismatch' });
  const contentDigest = sha256(Buffer.from(inventory?.entries.map(entry => `${entry.path}\0${entry.byteSize}\0${entry.sha256}\n`).sort().join('') ?? '', 'ascii'));
  const snapshotDigest = canonicalHash({ rootIdentity, identities: inventory?.identities ?? [], pathDigest, contentDigest });
  return { canonicalRoot: realpathSync.native(request.root), rootIdentity, pathDigest, contentDigest, snapshotDigest,
    fileCount: inventory?.entries.length ?? 0, totalBytes: inventory?.totalBytes ?? 0,
    hostPid: process.pid, generation: fixtureGenerationOverride ?? 'fixture-generation', epoch: 1 };
};

test('managed P5 enrollment opts into Lifecycle Host Custody before recovery; legacy profiles do not', async () => {
  const profileRoot = mkdtempSync(join(tmpdir(), 'deszo-p5-managed-profile-'));
  const capability = 'a'.repeat(64);
  const installationId = randomUUID();
  const generation = randomUUID();
  const calls = [];
  let rejectAttach = false;
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        assert.equal(message.capability, capability);
        calls.push(message.command);
        if (message.command === 'custody.attach' && rejectAttach) response = { ok: false, code: 'custody_unavailable', error: 'fixture refused Custody attachment' };
        else if (message.command === 'custody.attach') response = { ok: true, result: { epoch: 17 } };
        else if (message.command === 'engine.source_release') response = { ok: false, code: 'source_release_unavailable', error: 'fixture does not provide a trusted package identity' };
        else response = { ok: true, result: {} };
      } catch (error) {
        response = { ok: false, code: 'fixture_error', error: error.message };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  const managedEnv = [
    'DESZO_LIFECYCLE_HOST_ADDRESS', 'DESZO_LIFECYCLE_HOST_CAPABILITY', 'DESZO_LIFECYCLE_INSTALLATION_ID',
    'DESZO_LIFECYCLE_PROFILE_ROOT', 'DESZO_LIFECYCLE_GENERATION', 'DESZO_APPLICATION_BUILD_ID',
    'DESZO_LIFECYCLE_APPLICATION_PID', 'DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT',
    'DESZO_CUSTODY_ADDRESS', 'DESZO_CUSTODY_CAPABILITY', 'DESZO_CUSTODY_GENERATION', 'DESZO_PROCESS_CUSTODY',
    'DESZO_CONTROL_HOST_PIPE', 'DESZO_HOST_POLICY_ID', 'DESZO_HOST_RUNTIME_GENERATION', 'DESZO_HOST_ATTACH_SECRET',
    'DESZO_HOST_OPERATION_ID', 'DESZO_HOST_REGISTRATION_NONCE', 'DESZO_HOST_PROCESS_EVIDENCE', 'DESZO_HOST_PROFILE_ROOT',
    'DESZO_HOST_NODE_PATH', 'DESZO_HOST_BUILD_ID', 'DESZO_HOST_PROTOCOL_VERSION', 'DESZO_ALLOW_FIXTURE_HOST',
  ];
  const previousEnv = new Map(managedEnv.map(name => [name, process.env[name]]));
  let enrolledRoot = null;
  let legacyRoot = null;
  let unavailableRoot = null;
  let unavailableRunner = null;
  const setLifecycleEnvironment = () => {
    for (const name of managedEnv) delete process.env[name];
    Object.assign(process.env, {
      DESZO_LIFECYCLE_HOST_ADDRESS: `127.0.0.1:${server.address().port}`,
      DESZO_LIFECYCLE_HOST_CAPABILITY: capability,
      DESZO_LIFECYCLE_INSTALLATION_ID: installationId,
      DESZO_LIFECYCLE_PROFILE_ROOT: profileRoot,
      DESZO_LIFECYCLE_GENERATION: generation,
      DESZO_APPLICATION_BUILD_ID: 'fixture-build',
      DESZO_LIFECYCLE_APPLICATION_PID: 'self',
      DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT: '0',
    });
  };

  let enrolledRunner;
  let legacyRunner;
  try {
    const enrollmentDirectory = join(profileRoot, 'p5');
    mkdirSync(enrollmentDirectory, { recursive: true });
    writeFileSync(join(enrollmentDirectory, 'enrollment.json'), '{}');
    enrolledRoot = mkdtempSync(join(tmpdir(), 'deszo-p5-managed-runner-'));
    setLifecycleEnvironment();
    enrolledRunner = await startRunner({ root: enrolledRoot, adapters: fixtureAdapters(join(enrolledRoot, 'fixture-state')), devTestConfirmationOff: true });
    assert.ok(calls.includes('custody.attach'), 'an installed P5 enrollment attaches the managed Host Custody service');
    assert.ok(calls.includes('engine.source_release'), 'enrollment is checked only after Custody attachment');
    assert.deepEqual(calls.slice(0, 3), ['custody.attach', 'engine.source_release', 'engine.ready'], 'Custody attaches before source validation and normal readiness follows initialization');
    assert.equal(enrolledRunner.engine.custodyEpoch, 17);
    assert.equal(enrolledRunner.engine.processCustodyRequired, true, 'P5 enrollment makes Custody a required launch boundary');
    assert.equal(enrolledRunner.engine.protectedSelfRepairEnrollment, null, 'untrusted fixture provenance does not enable P5');
    assert.match(enrolledRunner.engine.protectedSelfRepairUnavailableReason, /fixture does not provide a trusted package identity/);
    await enrolledRunner.close();
    enrolledRunner = null;
    rmSync(enrolledRoot, { recursive: true, force: true });
    enrolledRoot = null;

    rmSync(enrollmentDirectory, { recursive: true, force: true });
    legacyRoot = mkdtempSync(join(tmpdir(), 'deszo-p5-legacy-runner-'));
    setLifecycleEnvironment();
    const callsBeforeLegacyStart = calls.length;
    legacyRunner = await startRunner({ root: legacyRoot, adapters: fixtureAdapters(join(legacyRoot, 'fixture-state')), devTestConfirmationOff: true });
    assert.equal(calls.slice(callsBeforeLegacyStart).includes('custody.attach'), false, 'a profile without P5 enrollment does not change the legacy launch path');
    assert.equal(legacyRunner.engine.custodyHost, null);
    assert.equal(legacyRunner.engine.processCustodyRequired, false);
    await legacyRunner.close();
    legacyRunner = null;
    rmSync(legacyRoot, { recursive: true, force: true });
    legacyRoot = null;

    mkdirSync(enrollmentDirectory, { recursive: true });
    writeFileSync(join(enrollmentDirectory, 'enrollment.json'), '{}');
    rejectAttach = true;
    unavailableRoot = mkdtempSync(join(tmpdir(), 'deszo-p5-unavailable-runner-'));
    setLifecycleEnvironment();
    const callsBeforeUnavailableStart = calls.length;
    unavailableRunner = await startRunner({ root: unavailableRoot, adapters: fixtureAdapters(join(unavailableRoot, 'fixture-state')), devTestConfirmationOff: true });
    assert.equal(calls.slice(callsBeforeUnavailableStart).filter(command => command === 'custody.attach').length, 1);
    assert.equal(calls.slice(callsBeforeUnavailableStart).includes('engine.source_release'), false, 'enrollment provenance is not read after failed Custody attachment');
    assert.equal(unavailableRunner.engine.processCustodyRequired, true);
    assert.match(unavailableRunner.engine.custodyUnavailable, /fixture refused Custody attachment/);
    const agent = { id: 'legacy-agent', type: 'agent', config: { provider: 'codex' } };
    const record = { mapped: false, taskExecutionId: undefined, loops: [] };
    assert.equal(unavailableRunner.engine.custodyScopeAllows(agent, record), true);
    assert.equal(unavailableRunner.engine.custodyEligible(agent, record), false, 'required Custody failure cannot fall back to a direct Agent launch');
    await unavailableRunner.close();
    unavailableRunner = null;
    rmSync(unavailableRoot, { recursive: true, force: true });
    unavailableRoot = null;
  } finally {
    await enrolledRunner?.close();
    await legacyRunner?.close();
    await unavailableRunner?.close();
    if (enrolledRoot) rmSync(enrolledRoot, { recursive: true, force: true });
    if (legacyRoot) rmSync(legacyRoot, { recursive: true, force: true });
    if (unavailableRoot) rmSync(unavailableRoot, { recursive: true, force: true });
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
    rmSync(profileRoot, { recursive: true, force: true });
  }
});

test('P5 source path policy rejects aliases and traversal before inventory', () => {
  for (const path of ['../secret', 'src\\file.mjs', 'C:/source.mjs', 'src/CON.txt', 'src/name.', 'src/a:b', 'src/.git/config', 'src/.p5/state', 'résumé.mjs'])
    assert.throws(() => validateP5SourcePath(path), { code: 'p5_path_unsupported' }, path);
  assert.equal(validateP5SourcePath('src/runtime.mjs'), 'src/runtime.mjs');
});

test('P5 Verification Gate has no caller inputs or policy body and refuses uninstalled admission', t => {
  const gate = { id: 'verify', type: 'gate', config: { mode: 'self-repair-verify', verificationPolicy: { artifactId: randomUUID(), sha256: 'a'.repeat(64) } } };
  assert.deepEqual(check('workflow.schema.json', 'gateNode', gate), []);
  assert.notDeepEqual(check('workflow.schema.json', 'gateNode', { ...gate, config: { ...gate.config, policy: { slots: [] } } }), []);

  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-admission-'));
  const engine = new Engine({ root });
  t.after(() => { engine.store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.processCustodyRequired = true;
  const workflow = { schemaVersion: 1, workflowId: 'p5-fixture', capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'protected-self-repair-v1'],
    settings: { nativeConfiguration: 'restricted' }, nodes: [gate], edges: [], after: [] };
  assert.ok(!engine.validateWorkflow(workflow).issues.some(issue => issue.message.includes('Protected Self-Repair enrollment')),
    'P5 publications can be constructed before the external enrollment references their exact publication digests.');
  assert.equal(engine.custodyScopeAllows(gate, { mapped: false, taskExecutionId: undefined, loops: [] }), false,
    'the asynchronous Gate cannot inherit the generic top-level Agent Custody/recovery binding');
  assert.throws(() => engine.captureRun({ workflow }), { code: 'p5_enrollment_unavailable' });
  assert.throws(() => engine.runGate({}, {}, gate, {}, {}, []), { code: 'p5_verification_unavailable' });
});

test('P5 Repair approval cannot fall through the generic P4/P2 transaction', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-approval-'));
  const engine = new Engine({ root });
  t.after(() => { engine.store.close(); rmSync(root, { recursive: true, force: true }); });
  const authorization = engine.store.putJson({ profile: { selfRepair: { artifactId: randomUUID(), sha256: 'a'.repeat(64) } } });
  const link = { authorization_artifact_id: authorization.artifactId };
  assert.throws(() => engine.applyWorkflowJudgeRepairApprovalInTransaction({}, {}, {},
    { kind: 'repair_approval', link }, randomUUID(), { action: { type: 'accept_repair' } }),
  { code: 'p5_acceptance_unavailable' });
});

test('P5 startup recovers a committed pre-Developer preparation intent once and defers while admission is disabled', async () => {
  const parentRunId = randomUUID(), repairRunId = randomUUID(), linkId = randomUUID();
  const ref = () => ({ artifactId: randomUUID(), sha256: 'a'.repeat(64) });
  const enrollmentRef = ref(), baselineManifest = ref(), sourceManifest = ref(), sourceBinding = ref(), verificationInputs = ref();
  const intentRef = ref(), preparationRef = ref();
  const at = new Date().toISOString();
  const intent = { schemaVersion: 1, kind: 'ProtectedSelfRepairPreparationIntent', enrollment: enrollmentRef,
    baselineManifest, sourceManifest, sourceBinding, verificationInputs, parentRunId, repairRunId, linkId,
    workspace: { workspaceId: 'p5-slot', allocationId: randomUUID(), canonicalRoot: 'C:/fixture/p5-slot',
      nativeIdentity: { volumeId: 'volume', fileId: 'slot' } }, createdAt: at };
  const preparation = { schemaVersion: 1, kind: 'ProtectedSelfRepairWorkspacePreparation', intent: intentRef,
    workspaceRoot: 'C:/fixture/p5-slot', sourceRoot: 'C:/fixture/p5-slot/source',
    workspaceIdentity: { volumeId: 'volume', fileId: 'slot' }, sourceIdentity: { volumeId: 'volume', fileId: 'source' },
    baselineId: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64),
    pathDigest: 'e'.repeat(64), contentDigest: 'f'.repeat(64), fileCount: 1, totalBytes: 1,
    hostPid: 1, generation: 'fixture-generation', epoch: 1, preparedAt: at };
  validateP5Contract('preparationIntent', intent);
  validateP5Contract('workspacePreparation', preparation);
  const artifacts = new Map([[intentRef.artifactId, intent], [preparationRef.artifactId, preparation],
    ['repair-workflow', { capabilities: ['protected-self-repair-v1'] }]]);
  const intentEvent = { type: 'self_repair.preparation_intent', payload: { record: intentRef } };
  const preparedEvent = { type: 'self_repair.workspace_prepared', payload: { record: preparationRef } };
  const events = [intentEvent];
  const link = { id: linkId, state: 'open', continuation_contract: 'logical_policy', parent_run_id: parentRunId,
    repair_run_id: repairRunId, parent_suspension_state: 'suspended_for_repair' };
  const parent = { id: parentRunId, state: 'waiting_for_user' };
  const repair = { id: repairRunId, state: 'queued', workflow_snapshot_artifact_id: 'repair-workflow' };
  const engine = Object.create(Engine.prototype);
  engine.protectedSelfRepairAdmissionEnabled = true;
  engine.protectedSelfRepairEnrollment = { workspace: { workspaceId: 'p5-slot' } };
  engine.protectedSelfRepairEnrollmentFile = {};
  engine.protectedSelfRepairEnrollmentArtifact = enrollmentRef;
  engine.lifecycleClient = {};
  engine.custodyHost = {};
  engine.custodyUnavailable = null;
  engine.custodyEpoch = 1;
  engine.store = {
    all: () => [link],
    get: (sql, id) => sql.includes('run_links') ? link
      : sql.includes('attempts') ? null : sql.includes('runs') ? (id === parentRunId ? parent : repair) : null,
    readEvents: () => events,
    verifyRef: artifactRef => {
      assert.ok([...artifacts.keys()].includes(artifactRef.artifactId), 'recovery reads only the fixture immutable refs');
      return artifactRef;
    },
    readJson: artifactId => artifacts.get(artifactId),
  };
  engine.requireRun = () => repair;
  engine.parentRepairAuthorization = () => ({ profile: { selfRepair: { profileId: 'fixture-profile' } } });
  engine.protectedSelfRepairRunProjection = () => ({ stage: 'prepared', issues: [], eligible: true });
  engine.logicalRepairLinkIntact = () => true;
  engine.parentRepairWorkInFlight = () => false;
  let materializeCalls = 0;
  engine.materializeProtectedSelfRepairPreparation = async (recoveredIntentRef, options) => {
    assert.deepEqual(recoveredIntentRef, intentRef);
    assert.deepEqual(options, { recovery: true });
    materializeCalls++;
    events.push(preparedEvent);
    return { evidenceArtifact: preparationRef };
  };

  const first = await engine.reconcileProtectedSelfRepairPreparations();
  assert.deepEqual(first, { recovered: [linkId], alreadyPrepared: [], deferred: [], blocked: [] });
  assert.equal(materializeCalls, 1);
  const second = await engine.reconcileProtectedSelfRepairPreparations();
  assert.deepEqual(second, { recovered: [], alreadyPrepared: [linkId], deferred: [], blocked: [] });
  assert.equal(materializeCalls, 1, 'Engine replacement recovery does not materialize or record the same workspace twice');
  assert.equal(engine.logicalRepairCanStart(repairRunId), true, 'P2 admits the Repair only after the durable preparation is bound to its exact intent');

  engine.protectedSelfRepairAdmissionEnabled = false;
  assert.equal(engine.logicalRepairCanStart(repairRunId), false, 'a queued P5 Repair never dispatches through a disabled reader');
  const deferred = await engine.reconcileProtectedSelfRepairPreparations();
  assert.deepEqual(deferred, { recovered: [], alreadyPrepared: [], deferred: [linkId], blocked: [] });
  assert.equal(materializeCalls, 1, 'disabled admission preserves the existing preparation without running it');
});

test('P5 acceptance contract requires the exact receipt and complete Judge review-delivery lineage', () => {
  const ref = { artifactId: randomUUID(), sha256: 'a'.repeat(64) };
  const acceptance = { schemaVersion: 1, kind: 'ProtectedSelfRepairAcceptance', acceptanceId: 'b'.repeat(64),
    candidateManifest: ref, candidateId: 'c'.repeat(64), candidateSourceDigest: 'd'.repeat(64),
    verificationReceipt: ref, receiptId: 'e'.repeat(64), gateAttemptId: randomUUID(), parentRunId: randomUUID(),
    repairRunId: randomUUID(), linkId: randomUUID(), incidentId: randomUUID(), decisionId: randomUUID(),
    judgeAttemptId: randomUUID(), attentionKey: 'f'.repeat(64), p2Authorization: ref,
    sourceIntegrityRevision: '0'.repeat(64), retentionRevision: 0, requiredReviewSetDigest: '1'.repeat(64),
    reviewDelivery: { attentionKey: 'f'.repeat(64), evidenceArtifact: ref, expansionArtifact: ref,
      sourceAttentionKey: 'f'.repeat(64), sourceDeliveryEventSequence: 1, sourceJudgeAttemptId: randomUUID(), sourceExpansionArtifact: ref },
    acceptedAt: new Date().toISOString() };
  assert.equal(validateP5Contract('acceptance', acceptance), canonicalHash(acceptance));
  assert.throws(() => validateP5Contract('acceptance', { ...acceptance, reviewDelivery: { ...acceptance.reviewDelivery,
    sourceDeliveryEventSequence: 0 } }), /P5 acceptance/);
});

test('P5 verification start records are strict and bind one Gate Attempt to its captured inputs', () => {
  const ref = { artifactId: randomUUID(), sha256: 'a'.repeat(64) };
  const runId = randomUUID();
  const started = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationStarted', runId, repairRunId: runId,
    parentRunId: randomUUID(), linkId: randomUUID(), incidentId: randomUUID(), gateNodeId: 'verify',
    gateAttemptId: randomUUID(), candidateId: 'b'.repeat(64), candidateSourceDigest: 'c'.repeat(64),
    candidateManifest: ref, verificationPolicy: ref, verificationInputs: ref, verifierPlan: ref,
    commandManifest: ref, testInputManifest: ref, invocation: ref, candidateSourceRoot: 'C:/p5/source',
    candidateSourceBefore: 'd'.repeat(64), freshSourceRoot: 'C:/p5/fresh-source', executionRoot: 'C:/p5/execution',
    verifyScratch: 'C:/p5/scratch', environmentDigest: 'e'.repeat(64), harnessClosureDigest: 'f'.repeat(64),
    lifecycleGeneration: randomUUID(), engineEpoch: 1, startedAt: new Date().toISOString() };
  assert.equal(validateP5Contract('verificationStarted', started), canonicalHash(started));
  assert.throws(() => validateP5Contract('verificationStarted', { ...started, invocation: undefined }), /P5 verificationStarted/);
});

test('P5 verification outcomes are strict and cannot use uncertain or incomplete identity shapes', () => {
  const ref = { artifactId: randomUUID(), sha256: 'a'.repeat(64) };
  const runId = randomUUID();
  const outcome = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationOutcome', status: 'failed',
    candidateManifest: ref, candidateId: 'b'.repeat(64), candidateSourceDigest: 'c'.repeat(64), baselineId: 'd'.repeat(64),
    repairRunId: runId, linkId: randomUUID(), incidentId: randomUUID(), gateAttemptId: randomUUID(),
    verificationPolicy: ref, verificationInputs: ref, verifierResult: null, terminalEvidence: null, streamEvidence: null,
    captureStatus: 'complete', reason: null, checks: [], recordedAt: new Date().toISOString() };
  assert.equal(validateP5Contract('verificationOutcome', outcome), canonicalHash(outcome));
  assert.throws(() => validateP5Contract('verificationOutcome', { ...outcome, status: 'uncertain' }), /P5 verificationOutcome/);
  assert.throws(() => validateP5Contract('verificationOutcome', { ...outcome, verificationInputs: undefined }), /P5 verificationOutcome/);
  assert.throws(() => validateP5Contract('verificationOutcome', { ...outcome, callerReport: { passed: true } }), /P5 verificationOutcome/);
});

test('P5 source-drift invalidation is durable, link-bound and idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-source-drift-'));
  const engine = new Engine({ root });
  t.after(() => { engine.store.close(); rmSync(root, { recursive: true, force: true }); });
  const { store } = engine, at = new Date().toISOString();
  const anchor = store.putJson({ kind: 'P5 source-drift fixture' });
  const parentRunId = randomUUID(), repairRunId = randomUUID();
  const parentWorkspaceId = randomUUID(), repairWorkspaceId = randomUUID();
  const parentWorkflowId = randomUUID(), repairWorkflowId = randomUUID();
  for (const [id, name, cwdIdentity] of [[parentWorkspaceId, 'parent', '5'.repeat(64)], [repairWorkspaceId, 'repair', '6'.repeat(64)]]) {
    const cwd = join(root, name); mkdirSync(cwd);
    store.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)', id, cwd, cwdIdentity, at, at);
  }
  const insertWorkflow = id => {
    store.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at) VALUES(?,?,?,?)', id, anchor.artifactId, at, at);
    const publishedVersionId = randomUUID(), definitionDigest = '7'.repeat(64);
    store.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,
      authority_policy_version,provenance,runnable,validation_json,source_draft_revision,created_at)
      VALUES(?,?,1,?,?,?,'workflow-judge/1','owner-publication',1,'{}',NULL,?)`,
    publishedVersionId, id, anchor.artifactId, definitionDigest, '8'.repeat(64), at);
    return { publishedVersionId, definitionDigest };
  };
  const parentPublication = insertWorkflow(parentWorkflowId), repairPublication = insertWorkflow(repairWorkflowId);
  for (const [id, workflowId, workspaceId, publication] of [[parentRunId, parentWorkflowId, parentWorkspaceId, parentPublication],
    [repairRunId, repairWorkflowId, repairWorkspaceId, repairPublication]])
    store.run(`INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,journal_version,
      published_version_id,definition_digest) VALUES(?,?,?,?,?,?,?,?,2,?,?)`, id, workflowId, workspaceId, anchor.artifactId, anchor.artifactId,
    '3'.repeat(64), 'running', at, publication.publishedVersionId, publication.definitionDigest);
  const authorization = store.putJson({ profile: { selfRepair: { artifactId: randomUUID(), sha256: '4'.repeat(64) } } });
  const linkId = randomUUID();
  store.run(`INSERT INTO run_links(id,kind,parent_run_id,repair_run_id,parent_workspace_id,repair_workspace_id,
    resume_node_instance_id,candidate_digest,checkpoint_artifact_id,state,continuation_contract,incident_id,
    parent_suspension_state,repair_outcome,decision_status,authorization_artifact_id,repair_result_node_instance_id,
    expected_repair_result_sha256,failed_node_retry,acceptance_mode,repair_result_sha256,repair_approval_artifact_id,created_at,updated_at)
    VALUES(?,'linked_repair',?,?,?,?,?,NULL,?,'open','logical_policy',?,'suspended_for_repair',NULL,'pending',?,?,NULL,'never',
      'judge_post_execution',NULL,NULL,?,?)`, linkId, parentRunId, repairRunId, parentWorkspaceId, repairWorkspaceId,
  'failed-node', anchor.artifactId, randomUUID(), authorization.artifactId, 'result-node', at, at);
  const link = store.get('SELECT * FROM run_links WHERE id = ?', linkId);
  assert.equal(store.transaction(() => engine.invalidateProtectedSelfRepairCandidateInTransaction(link, 'source_drift')), true);
  const rows = store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated');
  assert.equal(rows.length, 1);
  const record = store.readJson(store.verifyRef(rows[0].payload.record).artifactId);
  assert.equal(record.reason, 'source_drift');
  assert.equal(record.stoppedRunId, null);
  assert.equal(record.stoppedRunState, null);
  assert.equal(record.parentRunId, parentRunId);
  assert.equal(record.repairRunId, repairRunId);
  assert.equal(record.linkId, linkId);
  assert.equal(record.eligibility, false);
  assert.equal(engine.invalidateProtectedSelfRepairCandidateInTransaction(link, 'source_drift'), false);
  assert.equal(store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated').length, 1);
});

test('Root Stop invalidates P5 eligibility for an already terminal Parent in one durable event', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-stop-invalidation-'));
  const engine = new Engine({ root });
  t.after(() => { engine.store.close(); rmSync(root, { recursive: true, force: true }); });
  const { store } = engine;
  const now = new Date().toISOString();
  const artifact = store.putJson({ kind: 'P5 Stop fixture anchor' });
  const parentRunId = randomUUID(), repairRunId = randomUUID(), parentWorkspaceId = randomUUID(), repairWorkspaceId = randomUUID();
  const parentWorkflowId = randomUUID(), repairWorkflowId = randomUUID();
  const parentWorkspace = join(root, 'parent'), repairWorkspace = join(root, 'repair');
  mkdirSync(parentWorkspace); mkdirSync(repairWorkspace);
  store.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)',
    parentWorkspaceId, parentWorkspace, '1'.repeat(64), now, now);
  store.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)',
    repairWorkspaceId, repairWorkspace, '2'.repeat(64), now, now);
  const insertWorkflow = id => {
    store.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at) VALUES(?,?,?,?)', id, artifact.artifactId, now, now);
    const publishedVersionId = randomUUID(), definitionDigest = '4'.repeat(64);
    store.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,
      authority_policy_version,provenance,runnable,validation_json,source_draft_revision,created_at)
      VALUES(?,?,1,?,?,?,'workflow-judge/1','owner-publication',1,'{}',NULL,?)`,
    publishedVersionId, id, artifact.artifactId, definitionDigest, '3'.repeat(64), now);
    return { publishedVersionId, definitionDigest };
  };
  const parentPublication = insertWorkflow(parentWorkflowId), repairPublication = insertWorkflow(repairWorkflowId);
  const insertRun = (id, workflowId, workspaceId, state, publication) => store.run(`INSERT INTO runs(
    id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,journal_version,
    published_version_id,definition_digest)
    VALUES(?,?,?,?,?,?,?,?,2,?,?)`, id, workflowId, workspaceId, artifact.artifactId, artifact.artifactId, '3'.repeat(64), state,
  now, publication.publishedVersionId, publication.definitionDigest);
  insertRun(parentRunId, parentWorkflowId, parentWorkspaceId, 'succeeded', parentPublication);
  insertRun(repairRunId, repairWorkflowId, repairWorkspaceId, 'succeeded', repairPublication);
  const incidentId = randomUUID(), linkId = randomUUID();
  const authorization = store.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization',
    profile: { selfRepair: { artifactId: randomUUID(), sha256: 'a'.repeat(64) } } });
  store.run(`INSERT INTO run_links(id,kind,parent_run_id,repair_run_id,parent_workspace_id,repair_workspace_id,
    resume_node_instance_id,candidate_digest,checkpoint_artifact_id,state,continuation_contract,incident_id,
    parent_suspension_state,repair_outcome,decision_status,authorization_artifact_id,repair_result_node_instance_id,
    expected_repair_result_sha256,failed_node_retry,acceptance_mode,repair_result_sha256,repair_approval_artifact_id,created_at,updated_at)
    VALUES(?,'linked_repair',?,?,?,?,?,NULL,?,'blocked','logical_policy',?,'blocked','succeeded','accepted',?,?,NULL,'never',
      'judge_post_execution',NULL,NULL,?,?)`, linkId, parentRunId, repairRunId, parentWorkspaceId, repairWorkspaceId,
    'failed-node', artifact.artifactId, incidentId, authorization.artifactId, 'result-node', now, now);

  const anchorRef = { artifactId: artifact.artifactId, sha256: artifact.sha256 };
  const digest = '5'.repeat(64), repositoryIdentity = { enrollmentId: randomUUID(), canonicalCommonDirectory: process.cwd(),
    nativeDirectoryIdentity: { volumeId: 'fixture-volume', fileId: 'fixture-directory' } };
  const publication = workflowId => ({ workflowId, publishedVersionId: randomUUID(), version: 1, snapshotSha256: '6'.repeat(64) });
  const candidate = { schemaVersion: 1, kind: 'ProtectedSelfRepairCandidate', candidateId: digest, enrollment: anchorRef,
    baselineRef: anchorRef, baselineId: '7'.repeat(64), baseCommit: 'a'.repeat(40), baseSourceDigest: '8'.repeat(64),
    candidateSourceDigest: '9'.repeat(64), sourceManifest: anchorRef, changeManifest: anchorRef, sourceCaptureEvidence: anchorRef,
    repositoryIdentity, sourceBinding: anchorRef, workspace: { workspaceId: 'p5-slot', allocationId: randomUUID(),
      canonicalRoot: repairWorkspace, sourceRoot: join(repairWorkspace, 'source'), nativeIdentity: { volumeId: 'fixture-volume', fileId: 'fixture-slot' } },
    parentRunId, repairRunId, linkId, incidentId, outcomeId: randomUUID(), outcomeRevision: 1,
    parentPublication: publication('parent-workflow'), repairPublication: publication('repair-workflow'),
    developerNodeId: 'developer', developerAttemptId: randomUUID(), selfRepairProfile: anchorRef, verificationPolicy: anchorRef,
    verificationInputs: anchorRef, developerTerminalEvidence: anchorRef,
    scopeVerdict: { status: 'within_scope', changeCount: 1 }, capturedAt: now, journalCursor: 1 };
  validateP5Contract('candidate', candidate);
  const candidateRef = store.putJson(candidate);
  const execution = { custodyId: randomUUID(), hostIdentity: 'fixture-host', lifecycleGeneration: randomUUID(), engineEpoch: 1,
    invocationDigest: 'b'.repeat(64), commandManifest: anchorRef, executableIdentity: process.execPath,
    harnessClosureDigest: 'c'.repeat(64), testInputManifest: anchorRef, environmentDigest: 'd'.repeat(64) };
  const receipt = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReceipt', receiptId: 'e'.repeat(64), status: 'passed',
    candidateId: candidate.candidateId, candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId,
    candidateManifest: candidateRef, changeManifest: anchorRef, selfRepairProfile: anchorRef, verificationPolicy: anchorRef,
    verificationInputs: anchorRef, repairRunId, linkId, incidentId, verificationNodeId: 'verify', gateAttemptId: randomUUID(),
    execution, checks: [], requiredCheckSetDigest: 'f'.repeat(64), completedCheckSetDigest: '0'.repeat(64),
    sourceBeforeDigest: '1'.repeat(64), sourceAfterDigest: '1'.repeat(64), liveCandidateDigest: candidate.candidateSourceDigest,
    harnessAfterDigest: '2'.repeat(64), terminalEvidence: anchorRef, captureStatus: 'complete', startedAt: now, completedAt: now,
    observationJournalCursor: 1, issuedJournalCursor: 2 };
  validateP5Contract('verificationReceipt', receipt);
  const receiptRef = store.putJson(receipt);
  const handoff = createP5Handoff({ candidate: { ...candidate, candidateArtifact: candidateRef },
    receipt: { ...receipt, artifact: receiptRef },
    approval: { decision: 'accept_repair', judgeAttemptId: randomUUID(), decisionId: randomUUID(),
      authorization: { artifactId: authorization.artifactId, sha256: authorization.sha256 }, artifact: anchorRef, outcome: anchorRef },
    continuation: { state: 'repair_accepted' },
    retention: { status: 'retained', revision: 1, retainedAt: now, cleanupDeferred: true, artifact: anchorRef },
    sourceBinding: anchorRef, enrollment: anchorRef, currentEligibility: { eligible: true, revision: 1, checkedAt: now } });
  const handoffRef = store.putJson(handoff);
  store.appendEvents(repairRunId, [
    { type: 'self_repair.candidate_captured', payload: { record: candidateRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.verification_recorded', payload: { record: receiptRef }, nodeInstanceId: null, attemptId: null },
    { type: 'self_repair.handoff_recorded', payload: { record: handoffRef }, nodeInstanceId: null, attemptId: null },
  ]);

  const first = engine.stopRun(parentRunId, { requestId: randomUUID() });
  assert.equal(first.body.state, 'succeeded', 'late Stop preserves the historical terminal Run state');
  const afterFirst = store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated');
  assert.equal(afterFirst.length, 1);
  const invalidationRef = afterFirst[0].payload.record;
  store.verifyRef(invalidationRef);
  const invalidation = store.readJson(invalidationRef.artifactId);
  assert.equal(invalidation.kind, 'ProtectedSelfRepairEligibilityInvalidation');
  assert.equal(invalidation.stoppedRunId, parentRunId);
  assert.equal(invalidation.stoppedRunState, 'succeeded');
  assert.equal(invalidation.linkId, linkId);
  assert.equal(invalidation.eligibility, false);
  assert.deepEqual(invalidation.candidateManifest, candidateRef);
  assert.equal(invalidation.candidateId, candidate.candidateId);
  assert.deepEqual(invalidation.verificationReceipt, receiptRef);
  assert.equal(invalidation.receiptId, receipt.receiptId);
  assert.deepEqual(invalidation.handoff, handoffRef);
  assert.equal(invalidation.handoffId, handoff.handoffId);

  const second = engine.stopRun(parentRunId, { requestId: randomUUID() });
  assert.equal(second.body.state, 'succeeded');
  assert.equal(store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated').length, 1,
    'a repeated late Stop does not append a second P5 invalidation');
});

test('active Root Stop commits P5 invalidation with the Parent stopping transition', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-stop-atomic-'));
  const engine = new Engine({ root });
  t.after(() => { engine.store.close(); rmSync(root, { recursive: true, force: true }); });
  const { store } = engine;
  const now = new Date().toISOString();
  const anchor = store.putJson({ kind: 'P5 atomic Stop fixture' });
  const parentRunId = randomUUID(), repairRunId = randomUUID(), parentWorkspaceId = randomUUID(), repairWorkspaceId = randomUUID();
  const parentWorkflowId = randomUUID(), repairWorkflowId = randomUUID();
  const parentWorkspace = join(root, 'parent'), repairWorkspace = join(root, 'repair');
  mkdirSync(parentWorkspace); mkdirSync(repairWorkspace);
  for (const [id, cwd] of [[parentWorkspaceId, parentWorkspace], [repairWorkspaceId, repairWorkspace]])
    store.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)', id, cwd, '1'.repeat(64), now, now);
  const insertWorkflow = id => {
    store.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at) VALUES(?,?,?,?)', id, anchor.artifactId, now, now);
    const publishedVersionId = randomUUID(), definitionDigest = '4'.repeat(64);
    store.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,
      authority_policy_version,provenance,runnable,validation_json,source_draft_revision,created_at)
      VALUES(?,?,1,?,?,?,'workflow-judge/1','owner-publication',1,'{}',NULL,?)`,
    publishedVersionId, id, anchor.artifactId, definitionDigest, '3'.repeat(64), now);
    return { publishedVersionId, definitionDigest };
  };
  const parentPublication = insertWorkflow(parentWorkflowId), repairPublication = insertWorkflow(repairWorkflowId);
  const insertRun = (id, workflowId, workspaceId, state, publication) => store.run(`INSERT INTO runs(
    id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,journal_version,
    published_version_id,definition_digest)
    VALUES(?,?,?,?,?,?,?,?,2,?,?)`, id, workflowId, workspaceId, anchor.artifactId, anchor.artifactId, '3'.repeat(64), state,
  now, publication.publishedVersionId, publication.definitionDigest);
  insertRun(parentRunId, parentWorkflowId, parentWorkspaceId, 'running', parentPublication);
  insertRun(repairRunId, repairWorkflowId, repairWorkspaceId, 'succeeded', repairPublication);
  const incidentId = randomUUID(), linkId = randomUUID();
  const authorization = store.putJson({ schemaVersion: 1, kind: 'ParentRepairAuthorization',
    profile: { selfRepair: { artifactId: anchor.artifactId, sha256: anchor.sha256 } } });
  store.run(`INSERT INTO run_links(id,kind,parent_run_id,repair_run_id,parent_workspace_id,repair_workspace_id,
    resume_node_instance_id,candidate_digest,checkpoint_artifact_id,state,continuation_contract,incident_id,
    parent_suspension_state,repair_outcome,decision_status,authorization_artifact_id,repair_result_node_instance_id,
    expected_repair_result_sha256,failed_node_retry,acceptance_mode,repair_result_sha256,repair_approval_artifact_id,created_at,updated_at)
    VALUES(?,'linked_repair',?,?,?,?,?,NULL,?,'open','logical_policy',?,'suspension_requested',NULL,'pending',?,?,NULL,'never',
      'judge_post_execution',NULL,NULL,?,?)`, linkId, parentRunId, repairRunId, parentWorkspaceId, repairWorkspaceId,
  'failed-node', anchor.artifactId, incidentId, authorization.artifactId, 'result-node', now, now);
  const missingCandidateRef = { artifactId: randomUUID(), sha256: 'f'.repeat(64) };
  store.appendEvents(repairRunId, [{ type: 'self_repair.candidate_captured', payload: { record: missingCandidateRef },
    nodeInstanceId: null, attemptId: null }]);

  const originalSupersede = engine.workflowJudgeSupersedeAttentionInTransaction;
  engine.workflowJudgeSupersedeAttentionInTransaction = () => { throw new Error('injected Stop transaction failure'); };
  const requestId = randomUUID();
  assert.throws(() => engine.stopRun(parentRunId, { requestId }), /injected Stop transaction failure/);
  assert.equal(store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'running');
  assert.equal(store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated').length, 0,
    'a failed Stop transaction rolls back its P5 invalidation');

  engine.workflowJudgeSupersedeAttentionInTransaction = originalSupersede;
  assert.equal(engine.stopRun(parentRunId, { requestId }).body.state, 'stopping');
  assert.equal(store.get('SELECT state FROM runs WHERE id = ?', parentRunId).state, 'stopping');
  const invalidations = store.readEvents(repairRunId).filter(item => item.type === 'self_repair.candidate_invalidated');
  assert.equal(invalidations.length, 1, 'the successful retry commits one P5 invalidation');
  const invalidation = store.readJson(invalidations[0].payload.record.artifactId);
  assert.equal(invalidation.linkId, linkId);
  assert.deepEqual(invalidation.candidateManifest, missingCandidateRef,
    'Stop preserves the journal reference even when its candidate object is unavailable');
  assert.equal(invalidation.candidateId, null);
  assert.equal(invalidation.eligibility, false);
});

test('P5 source and candidate identities use the architecture canonical formulas', () => {
  const entries = [fileEntry('z.mjs', 'z'), fileEntry('a.mjs', 'a')];
  const expectedSourceDigest = canonicalHash({ kind: 'P5SourceTree', version: 1, entries: [...entries].sort((a, b) => a.path < b.path ? -1 : 1) });
  assert.equal(p5SourceDigest(entries), expectedSourceDigest);
  const policyDigest = canonicalHash({ include: ['src/**'], exclude: ['.git', '.p5'] });
  const repositoryIdentity = { enrollmentId: randomUUID(), canonicalCommonDirectory: process.cwd(),
    nativeDirectoryIdentity: { volumeId: 'fixture-volume', fileId: 'fixture-directory' } };
  const baselineId = p5BaselineId({ repositoryIdentity, gitObjectFormat: 'sha1', baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40), pathPolicyDigest: policyDigest, effectiveSourceDigest: expectedSourceDigest });
  assert.equal(baselineId, canonicalHash({ kind: 'P5Baseline', version: 1, repositoryIdentity, gitObjectFormat: 'sha1',
    baseCommit: 'a'.repeat(40), baseTree: 'b'.repeat(40), pathPolicyDigest: policyDigest,
    effectiveSourceDigest: expectedSourceDigest, dirtyPolicy: 'clean-committed' }));
  const fields = { baselineId, incidentId: randomUUID(), parentRunId: randomUUID(), repairRunId: randomUUID(), linkId: randomUUID(),
    developerAttemptId: randomUUID(), workspaceAllocationId: randomUUID(), candidateSourceDigest: 'c'.repeat(64),
    selfRepairProfileDigest: 'd'.repeat(64), verificationPolicyDigest: 'e'.repeat(64), verificationInputsDigest: 'f'.repeat(64) };
  assert.equal(p5CandidateId(fields), canonicalHash({ kind: 'P5Candidate', version: 1, ...fields, candidateOrdinal: 1 }));
  assert.notEqual(p5CandidateId({ ...fields, candidateSourceDigest: '1'.repeat(64) }), p5CandidateId(fields));
});

test('P5 inventory requires Windows native topology evidence and detects stable file identities', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'unit.mjs'), 'export const value = 1;');
  writeFileSync(join(root, 'src', 'deep', 'target.mjs'), 'export const target = true;');
  if (process.platform === 'win32')
    assert.throws(() => inventoryP5Source(root), { code: 'p5_native_identity_unavailable' });
  const inventory = inventoryP5Source(root, { identityReader: fixtureIdentity, executableFor: () => false });
  assert.equal(inventory.entries.length, 2);
  assert.deepEqual(inventory.entries.map(entry => entry.path), ['src/deep/target.mjs', 'src/unit.mjs']);
  assert.equal(inventory.sourceDigest, p5SourceDigest(inventory.entries));
  const nestedGlob = inventoryP5Source(root, { identityReader: fixtureIdentity, executableFor: () => false,
    include: ['src/*/target.mjs'], excluded: [] });
  assert.deepEqual(nestedGlob.entries.map(entry => entry.path), ['src/deep/target.mjs'], 'source include globs must traverse a wildcard directory prefix');
});

test('P5 candidate capture seals actual add/modify/delete bytes and refuses scope expansion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-candidate-'));
  let store = null;
  t.after(() => { fixtureGenerationOverride = null; store?.close(); rmSync(root, { recursive: true, force: true }); });
  const slot = join(root, 'slot'); const source = join(slot, 'source');
  const storeRoot = join(root, 'runtime');
  const scratchRoot = join(root, 'verify-scratch'), controlRoot = join(root, 'installed-control');
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(source, 'tests'), { recursive: true });
  mkdirSync(scratchRoot); mkdirSync(controlRoot);
  writeFileSync(join(source, 'src', 'normalize.mjs'), 'export const value = 2;');
  writeFileSync(join(source, 'src', 'new.mjs'), 'export const added = true;');
  const protectedTestText = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/normalize.mjs';\ntest('candidate-value', () => assert.equal(value, 1));\n";
  writeFileSync(join(source, 'tests', 'protected-check.test.mjs'), protectedTestText);
  writeFileSync(join(source, 'README.md'), 'outside the enrolled inclusion set');
  store = new Store(storeRoot);
  const baselineEntries = [fileEntry('src/normalize.mjs', 'export const value = 1;'), fileEntry('src/old.mjs', 'export const removed = true;'),
    fileEntry('tests/protected-check.test.mjs', protectedTestText)];
  const baselineContentRefs = new Map();
  for (const entry of baselineEntries) {
    const text = entry.path.endsWith('old.mjs') ? 'export const removed = true;'
      : entry.path === 'tests/protected-check.test.mjs' ? protectedTestText : 'export const value = 1;';
    const artifact = store.putBytes(Buffer.from(text), 'application/octet-stream');
    store.verifyRef(artifact);
    baselineContentRefs.set(entry.path, artifact);
  }
  const baselineSource = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest: p5SourceDigest(baselineEntries),
    entries: baselineEntries.map(entry => ({ ...entry, artifact: baselineContentRefs.get(entry.path) })) };
  const baselineSourceRef = store.putJson(baselineSource);
  const putRef = value => store.putJson(value);
  const runningInventoryFiles = baselineEntries.map(({ path, sha256 }) => ({ path, sha256 }));
  const runningSourceRelease = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'a'.repeat(32),
    buildId: 'fixture-build', bootstrap: 'runtime', packageSha256: '7'.repeat(64), sourceCommit: '1'.repeat(40),
    sourceDigest: canonicalHash(runningInventoryFiles), inputsDigest: '9'.repeat(64) };
  const releaseRef = putRef(runningSourceRelease);
  const enrollmentId = randomUUID();
  const repoInfo = lstatSync(root, { bigint: true });
  const repositoryIdentity = { enrollmentId, canonicalCommonDirectory: realpathSync.native(root),
    nativeDirectoryIdentity: { volumeId: String(repoInfo.dev), fileId: String(repoInfo.ino) } };
  const gitObjectFormat = 'sha1'; const baseCommit = '1'.repeat(40); const baseTree = '2'.repeat(40);
  const pathPolicy = { include: ['src/**', 'tests/**'], exclude: ['.git/**', '.p5/**'], secretPaths: [] };
  const pathPolicyDigest = canonicalHash(pathPolicy);
  const baselineId = p5BaselineId({ repositoryIdentity, gitObjectFormat, baseCommit, baseTree, pathPolicyDigest, effectiveSourceDigest: baselineSource.sourceDigest });
  const baselineRecord = { schemaVersion: 1, kind: 'ProtectedSelfRepairBaselineManifest', enrollmentId, repositoryIdentity, repositoryRoot: root,
    gitObjectFormat, baseCommit, baseTree, pathPolicyDigest, pathPolicy, effectiveSourceDigest: baselineSource.sourceDigest, baselineId,
    sourceManifest: baselineSourceRef, runningSourceRelease: releaseRef, excludedPaths: ['.git', '.p5'], capturedAt: new Date().toISOString() };
  const baselineManifest = putRef(baselineRecord);
  const baseline = { baselineManifest, baselineId, sourceDigest: baselineSource.sourceDigest, baseCommit, baseTree, gitObjectFormat,
    pathPolicyDigest, pathPolicy, repositoryRoot: root, repositoryIdentity, sourceManifest: baselineSourceRef, excludedPaths: ['.git', '.p5'],
    entries: baselineEntries, contentRefs: baselineContentRefs };
  const workspaceInfo = lstatSync(slot, { bigint: true });
  const workspaceIdentity = { volumeId: String(workspaceInfo.dev), fileId: String(workspaceInfo.ino) };
  const workspace = { workspaceId: 'p5-slot', allocationId: randomUUID(), canonicalRoot: slot, nativeIdentity: workspaceIdentity };
  const scope = { add: ['src/new.mjs'], modify: ['src/normalize.mjs'], delete: ['src/old.mjs'], executable: [], denied: [], sensitiveCategories: [] };
  const budgets = { maxSourceFiles: 10, maxSourceBytes: 4096, developerTimeoutSeconds: 60, verificationTimeoutSeconds: 60,
    maxCheckOutputBytes: 4096, verificationRetries: 0, maxJudgeAttempts: 1, maxEvidenceExpansions: 1 };
  const parentPublication = { workflowId: 'parent', publishedVersionId: randomUUID(), version: 1, snapshotSha256: '3'.repeat(64) };
  const repairPublication = { workflowId: 'repair', publishedVersionId: randomUUID(), version: 1, snapshotSha256: '4'.repeat(64) };
  const incidentId = randomUUID(), outcomeId = randomUUID(), parentRunId = randomUUID(), repairRunId = randomUUID();
  const outcomeRevision = 1, developerAttemptId = randomUUID();
  const verificationPolicy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
    requiredStages: ['unit'], requiredCheckIds: ['unit-check'], optionalCheckIds: [], harnessClosureDigest: runningSourceRelease.inputsDigest,
    incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8,
      maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }],
    checks: [{ checkId: 'unit-check', stageId: 'unit', required: true, executable: process.execPath, executableSha256: sha256(readFileSync(process.execPath)),
      argv: ['--test-reporter=junit', '--test', 'tests/protected-check.test.mjs'], cwd: 'candidate-execution-tree', inputRefs: [],
      environment: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
        TEMP: scratchRoot, TMP: scratchRoot }).filter(([, value]) => typeof value === 'string')), subjectEntryPoints: ['src/normalize.mjs'],
      expectedAssertions: ['candidate-value'], expectedExitCodes: [0], timeoutSeconds: 60, maxOutputBytes: 4096,
      subjectBinding: 'protected-overlay', overlayPaths: ['tests/protected-check.test.mjs'] }], verificationRetries: 0, aggregateTimeoutSeconds: 120 };
  verificationPolicy.checks[0].commandDigest = p5VerificationCommandDigest(verificationPolicy.checks[0]);
  const reservedEnvPolicy = structuredClone(verificationPolicy);
  reservedEnvPolicy.checks[0].environment.DESZO_P5_INPUT_MANIFEST = join(scratchRoot, 'forged.json');
  reservedEnvPolicy.checks[0].commandDigest = p5VerificationCommandDigest(reservedEnvPolicy.checks[0]);
  assert.throws(() => assertP5VerificationPolicy(reservedEnvPolicy), { code: 'p5_policy_reserved_environment' });
  assert.throws(() => assertP5VerificationPolicy({ ...verificationPolicy, requiredCheckIds: ['other-check'] }),
    { code: 'p5_policy_check_set_mismatch' });
  const policyRef = putRef(verificationPolicy);
  const incidentArtifact = putRef({ kind: 'P3FixtureEvidence', outcomeId, revision: outcomeRevision });
  const verificationInputs = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationInputs', incidentId, outcomeId, outcomeRevision,
    verificationPolicy: policyRef, inputs: [{ selector: 'p3-outcome-artifacts', artifact: incidentArtifact,
      sourceOutcomeId: outcomeId, sourceRevision: outcomeRevision }], capturedAt: new Date().toISOString() };
  const inputsRef = putRef(verificationInputs);
  const profileScope = scope;
  const profile = { schemaVersion: 1, kind: 'ProtectedSelfRepairProfile', enrollmentId, repositoryIdentity, baselineId,
    baseline: baselineManifest, runningSourceRelease: releaseRef, repairPublication, developerNodeId: 'developer',
    verificationNodeId: 'verify', repairJudgeNodeId: 'judge', workspace: { workspaceId: workspace.workspaceId,
      allocationId: workspace.allocationId, canonicalRoot: slot, singleUse: true, cleanCommitted: true },
    scope: profileScope, verificationPolicy: policyRef, requiredCheckIds: ['unit-check'],
    eligibleIncidents: [{ category: 'provider-failure', canonicalCode: 'provider-error' }], failedNodeRetry: 'never',
    acceptanceMode: 'judge_post_execution', budgets };
  const profileRef = putRef(profile);
  const parentSnapshot = putRef({ snapshot: 'parent' });
  const sourceBinding = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding', enrollmentId, parentRunId, parentPublication,
    parentSnapshot, baselineId, baselineManifest, profile: profileRef, runningSourceRelease: releaseRef,
    runtimeInstanceId: randomUUID(), lifecycleGeneration: randomUUID(), boundAt: new Date().toISOString() };
  const sourceBindingRef = putRef(sourceBinding);
  const terminal = putRef({ attemptId: developerAttemptId, processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 });
  const enrollment = { schemaVersion: 1, kind: 'ProtectedSelfRepairEnrollment', enrollmentId, repositoryIdentity,
    gitObjectFormat, baseCommit, baseTree, pathPolicyDigest, effectiveSourceDigest: baseline.sourceDigest, baselineId,
    baselineManifest, runningSourceRelease: releaseRef, parentPublication, profile: profileRef, repairPublication,
    workspace: { workspaceId: workspace.workspaceId, canonicalRoot: slot, allocationId: workspace.allocationId, nativeIdentity: workspaceIdentity },
    verificationPolicy: policyRef, harnessClosureDigest: verificationPolicy.harnessClosureDigest,
    toolIdentities: [{ name: 'node', path: process.execPath, sha256: '6'.repeat(64) }], scope, budgets, minimumReaderCapability: 'protected-self-repair-v1' };
  const managedProfile = join(root, 'managed-profile');
  mkdirSync(join(managedProfile, 'p5'), { recursive: true });
  const enrollmentPath = join(managedProfile, P5_ENROLLMENT_RELATIVE_PATH);
  const enrollmentBytes = Buffer.from(JSON.stringify(enrollment));
  writeFileSync(enrollmentPath, enrollmentBytes);
  const loaded = loadP5Enrollment({ profileRoot: managedProfile, store, installationId: runningSourceRelease.installationId, runningSourceRelease });
  assert.equal(loaded.enrollmentDigest, canonicalHash(enrollment));
  assert.equal(loaded.fileSha256, sha256(enrollmentBytes));
  assert.equal(loaded.runningSourceRelease.packageSha256, runningSourceRelease.packageSha256);
  const generation = randomUUID();
  const runningInventory = new Map(runningInventoryFiles.map(entry => [entry.path, entry.sha256]));
  const readBatch = async paths => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceInventory',
    installationId: runningSourceRelease.installationId, buildId: runningSourceRelease.buildId,
    packageSha256: runningSourceRelease.packageSha256, sourceCommit: runningSourceRelease.sourceCommit,
    sourceDigest: runningSourceRelease.sourceDigest, generation,
    entries: paths.map(path => ({ path, sha256: runningInventory.get(path) })) });
  assert.equal((await verifyP5RunningSourceInventory({ store, enrollment, currentRunningSourceRelease: runningSourceRelease,
    generation, readBatch })).verifiedFiles, baselineEntries.length);
  await assert.rejects(verifyP5RunningSourceInventory({ store, enrollment, currentRunningSourceRelease: runningSourceRelease,
    generation, readBatch: async paths => ({ ...(await readBatch(paths)), entries: paths.map(path => ({ path, sha256: 'f'.repeat(64) })) }) }),
  { code: 'p5_runtime_source_mismatch' });
  const fixtureNativeEvidence = { nativeSourceReader: fixtureNativeSourceReader, expectedHostPid: process.pid,
    expectedGeneration: fixtureGenerationOverride ?? 'fixture-generation', expectedEpoch: 1 };
  assert.equal(canonicalHash(await verifyP5EnrollmentFileCurrent({ ...loaded, ...fixtureNativeEvidence })), canonicalHash(enrollment));
  writeFileSync(enrollmentPath, Buffer.concat([enrollmentBytes, Buffer.from('\n')]));
  await assert.rejects(verifyP5EnrollmentFileCurrent({ ...loaded, ...fixtureNativeEvidence }),
    { code: 'p5_enrollment_changed' });
  writeFileSync(enrollmentPath, enrollmentBytes);
  assert.equal(assertP5EnrollmentCurrent({ store, enrollment, profile, parentPublication, repairPublication, sourceRelease: releaseRef,
    currentRepositoryIdentity: repositoryIdentity }).profileDigest, canonicalHash(profile));
  assert.throws(() => assertP5EnrollmentCurrent({ store, enrollment: { ...enrollment, harnessClosureDigest: '5'.repeat(64) },
    profile, parentPublication, repairPublication, sourceRelease: releaseRef, currentRepositoryIdentity: repositoryIdentity }),
  { code: 'p5_runtime_source_mismatch' });
  assert.throws(() => assertP5EnrollmentCurrent({ store,
    enrollment: { ...enrollment, repositoryIdentity: { ...repositoryIdentity, enrollmentId: randomUUID() } },
    profile, parentPublication, repairPublication, sourceRelease: releaseRef, currentRepositoryIdentity: repositoryIdentity }),
  { code: 'p5_repository_enrollment_mismatch' });
  const changedPolicyRef = putRef({ ...verificationPolicy, aggregateTimeoutSeconds: 119 });
  assert.throws(() => assertP5EnrollmentCurrent({ store, enrollment: { ...enrollment, verificationPolicy: changedPolicyRef },
    profile, parentPublication, repairPublication, sourceRelease: releaseRef, currentRepositoryIdentity: repositoryIdentity }), { code: 'p5_profile_mismatch' });
  const enrollmentRef = putRef(enrollment);
  const authorization = { incidentId, parentRunId, repairRunId, linkId: randomUUID(), outcomeId, outcomeRevision,
    developerAttemptId, developerNodeId: 'developer', parentPublication, repairPublication, workspace,
    enrollment: enrollmentRef, selfRepairProfile: profileRef, verificationPolicy: policyRef, verificationInputs: inputsRef, sourceBinding: sourceBindingRef,
    developerTerminal: { artifact: terminal, attemptId: developerAttemptId, processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 },
    scope, capturedAt: new Date().toISOString(), journalCursor: 1 };
  const result = await sealP5Candidate({ store, sourceRoot: source, baseline, authorization,
    budgets, identityReader: fixtureIdentity, nativeSourceReader: fixtureNativeSourceReader });
  assert.equal(result.candidate.kind, 'ProtectedSelfRepairCandidate');
  const stagedInputsRoot = join(root, 'p5-staged-inputs');
  mkdirSync(stagedInputsRoot);
  const stagedInputDigest = p5CheckInputDigest({ candidate: result.candidate,
    check: verificationPolicy.checks[0], verificationInputs });
  const partialInputPath = join(stagedInputsRoot, 'inputs', verificationPolicy.checks[0].checkId, 'input-0000.bin');
  mkdirSync(join(stagedInputsRoot, 'inputs', verificationPolicy.checks[0].checkId), { recursive: true });
  writeFileSync(partialInputPath, store.readBytes(incidentArtifact.artifactId).bytes);
  assert.throws(() => materializeP5CheckInputs({ store, candidate: result.candidate,
    check: verificationPolicy.checks[0], verificationInputs, inputDigest: stagedInputDigest,
    scratchRoot: stagedInputsRoot, aggregateBytes: { value: 0 } }), { code: 'p5_verification_input_conflict' },
  'ordinary preparation callers still refuse an occupied input path');
  const stagedInputs = materializeP5CheckInputs({ store, candidate: result.candidate,
    check: verificationPolicy.checks[0], verificationInputs, inputDigest: stagedInputDigest,
    scratchRoot: stagedInputsRoot, aggregateBytes: { value: 0 }, allowExisting: true });
  const repeatedInputs = materializeP5CheckInputs({ store, candidate: result.candidate,
    check: verificationPolicy.checks[0], verificationInputs, inputDigest: stagedInputDigest,
    scratchRoot: stagedInputsRoot, aggregateBytes: { value: 0 }, allowExisting: true });
  const stagedEvidenceBytes = store.readBytes(incidentArtifact.artifactId).bytes;
  assert.equal(stagedInputs.manifest.inputs[0].artifact.artifactId, incidentArtifact.artifactId);
  assert.equal(readFileSync(join(stagedInputsRoot, ...stagedInputs.manifest.inputs[0].relativePath.split('/'))).toString(), stagedEvidenceBytes.toString());
  assert.equal(stagedInputs.manifestRef.sha256, canonicalHash(stagedInputs.manifest));
  assert.equal(repeatedInputs.manifestRef.artifactId, stagedInputs.manifestRef.artifactId,
    'pre-start recovery accepts the exact already-materialized manifest and input bytes');
  assert.deepEqual(result.changeManifest.changes.map(item => [item.path, item.operation]), [
    ['src/new.mjs', 'add'], ['src/normalize.mjs', 'modify'], ['src/old.mjs', 'delete'],
  ]);
  assert.ok(!result.sourceManifest.entries.some(item => item.path === 'README.md'), 'candidate inventory follows the enrolled source include policy');
  await assert.rejects(() => sealP5Candidate({ store, sourceRoot: source,
    baseline: { ...baseline, excludedPaths: ['.git', '.p5', 'src'] }, authorization, budgets, identityReader: fixtureIdentity,
    nativeSourceReader: fixtureNativeSourceReader }),
  { code: 'p5_baseline_mismatch' });
  const secretPath = join(source, 'src', 'private.pem');
  writeFileSync(secretPath, 'private key material');
  await assert.rejects(() => sealP5Candidate({ store, sourceRoot: source, baseline, authorization, budgets,
    identityReader: fixtureIdentity, nativeSourceReader: fixtureNativeSourceReader }), { code: 'p5_tracked_secret' });
  rmSync(secretPath);
  assert.equal(store.readBytes(result.sourceManifest.entries.find(item => item.path === 'src/normalize.mjs').artifact.artifactId).bytes.toString(), 'export const value = 2;');
  assert.equal(store.readJson(result.candidateArtifact.artifactId).candidateSourceDigest, result.capturedSourceDigest);

  const gateAttemptId = randomUUID(), custodyId = randomUUID(), lifecycleGeneration = randomUUID();
  fixtureGenerationOverride = lifecycleGeneration;
  const invocationDigest = '8'.repeat(64), hostIdentity = 'fixture-host';
  const gateTerminalRef = putRef({ attemptId: gateAttemptId, custodyId, invocationDigest, lifecycleGeneration,
    hostIdentity, processTreeEnded: true, spoolComplete: true, status: 'exited', exitCode: 0 });
  const verifyScratchRoot = join(slot, '.p5', 'verify', 'scratch', gateAttemptId);
  const commandRoots = { candidateSource: join(slot, '.p5', 'verify', 'source'),
    executionRoot: join(slot, '.p5', 'verify', 'execution'), verifyScratch: verifyScratchRoot, installedControl: controlRoot };
  const stagedIncidentBytes = store.readBytes(incidentArtifact.artifactId).bytes;
  const materializedInputManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairMaterializedCheckInputs',
    candidateId: result.candidate.candidateId, candidateSourceDigest: result.candidate.candidateSourceDigest,
    baselineId: result.candidate.baselineId, checkId: 'unit-check', inputDigest: '0'.repeat(64), root: verifyScratchRoot,
    inputs: [{ source: 'incident', selector: 'p3-outcome-artifacts', sourceOutcomeId: outcomeId, sourceRevision: outcomeRevision,
      artifact: incidentArtifact, relativePath: 'inputs/unit-check/input-0000.bin', sha256: sha256(stagedIncidentBytes), byteSize: stagedIncidentBytes.length }] };
  const inputDigest = p5CheckInputDigest({ candidate: result.candidate, check: verificationPolicy.checks[0], verificationInputs });
  materializedInputManifest.inputDigest = inputDigest;
  const materializedInputRef = putRef(materializedInputManifest);
  const relativeInputManifestPath = 'inputs/unit-check/manifest.json';
  const absoluteInputManifestPath = join(verifyScratchRoot, 'inputs', 'unit-check', 'manifest.json');
  const effectiveCheckEnvironment = { ...verificationPolicy.checks[0].environment, DESZO_P5_INPUT_MANIFEST: absoluteInputManifestPath };
  const commandManifest = putRef({ schemaVersion: 1, kind: 'ProtectedSelfRepairCommandManifest', candidateId: result.candidate.candidateId,
    candidateSourceDigest: result.candidate.candidateSourceDigest, verificationPolicy: policyRef, gateAttemptId,
    roots: commandRoots, checks: [{ checkId: 'unit-check', commandDigest: verificationPolicy.checks[0].commandDigest,
      executable: verificationPolicy.checks[0].executable, executableSha256: verificationPolicy.checks[0].executableSha256,
      argv: verificationPolicy.checks[0].argv, cwdKind: verificationPolicy.checks[0].cwd,
      cwd: join(commandRoots.executionRoot, 'unit-check'), environment: effectiveCheckEnvironment,
      environmentDigest: canonicalHash(effectiveCheckEnvironment), inputDigest,
      inputManifest: materializedInputRef, inputManifestPath: absoluteInputManifestPath,
      inputManifestDigest: materializedInputRef.sha256 }] });
  const resolvedFiles = [{ path: 'src/normalize.mjs', sha256: sha256(Buffer.from('export const value = 2;')),
    byteSize: Buffer.byteLength('export const value = 2;'), executable: false }];
  const subjectResolution = putRef({ schemaVersion: 1, kind: 'ProtectedSelfRepairSubjectResolution', candidateId: result.candidate.candidateId,
    candidateSourceDigest: result.candidate.candidateSourceDigest, baselineId: result.candidate.baselineId, checkId: 'unit-check',
    verificationPolicy: policyRef, verificationInputs: inputsRef, inputDigest, driverIdentity: process.execPath,
    driverSha256: verificationPolicy.checks[0].executableSha256,
    entryPoints: ['src/normalize.mjs'], resolvedFiles, sourceClosureDigest: canonicalHash(resolvedFiles),
    assertionBindings: [{ assertion: 'candidate-value', sourcePath: 'src/normalize.mjs' }] });
  const materialized = await materializeP5VerificationOverlay({ store, candidateRef: result.candidateArtifact,
    check: verificationPolicy.checks[0], budgets, identityReader: fixtureIdentity, nativeSourceReader: fixtureNativeSourceReader });
  const { overlayManifest, overlayManifestRef } = materialized;
  const completeExecutionInventory = overlayManifest.executionInventory;
  const overlayPath = 'tests/protected-check.test.mjs';
  assert.equal(readFileSync(join(materialized.executionTree.root, overlayPath), 'utf8'), protectedTestText,
    'the execution tree applies the exact enrolled protected test bytes');
  assert.equal(readFileSync(join(materialized.executionTree.root, 'src', 'normalize.mjs'), 'utf8'), 'export const value = 2;',
    'the execution tree retains the sealed candidate production bytes');
  const verifierResult = await executeP5VerifierPlan({ schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierPlan',
    candidateId: result.candidate.candidateId, candidateSourceDigest: result.candidate.candidateSourceDigest,
    baselineId: result.candidate.baselineId, gateAttemptId, requiredCheckIds: ['unit-check'], policy: verificationPolicy,
    roots: { 'candidate-source': source, 'candidate-execution-tree': materialized.executionTree.root,
      'verify-scratch': scratchRoot, 'installed-control': controlRoot },
    aggregateTimeoutSeconds: verificationPolicy.aggregateTimeoutSeconds, checks: verificationPolicy.checks });
  assert.equal(verifierResult.status, 'failed', 'the protected assertion executes the sealed candidate module and detects its regression');
  assert.equal(verifierResult.checks[0].status, 'failed');
  assert.deepEqual(verifierResult.checks[0].completedAssertions, []);
  assert.match(Buffer.from(verifierResult.checks[0].stdoutBase64, 'base64').toString('utf8'), /<failure/);
  await assert.rejects(() => materializeP5VerificationOverlay({ store, candidateRef: result.candidateArtifact,
    check: verificationPolicy.checks[0], budgets, identityReader: fixtureIdentity, nativeSourceReader: fixtureNativeSourceReader }),
  { code: 'p5_overlay_tree_conflict' });
  assert.deepEqual(verifyP5OverlayManifest({ store, overlayManifestRef, candidateRef: result.candidateArtifact,
    check: verificationPolicy.checks[0], execution: { lifecycleGeneration, engineEpoch: 1 } }).completeExecutionInventory,
  completeExecutionInventory);
  const corruptOverlayRef = putRef({ ...overlayManifest, executionInventory: completeExecutionInventory.map((item, index) =>
    index === 0 ? { ...item, sha256: item.sha256 === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) } : item) });
  assert.throws(() => verifyP5OverlayManifest({ store, overlayManifestRef: corruptOverlayRef,
    candidateRef: result.candidateArtifact, check: verificationPolicy.checks[0], execution: { lifecycleGeneration, engineEpoch: 1 } }),
  { code: 'p5_overlay_inventory_mismatch' });
  const executionTreeDigest = p5ExecutionTreeDigest({ candidate: result.candidate, checkId: 'unit-check',
    subjectResolution, inputDigest, overlayManifest: overlayManifestRef });
  const testInputManifest = putRef({ schemaVersion: 1, kind: 'ProtectedSelfRepairTestInputManifest', candidateId: result.candidate.candidateId,
    candidateSourceDigest: result.candidate.candidateSourceDigest, baselineId: result.candidate.baselineId,
    verificationPolicy: policyRef, verificationInputs: inputsRef, harnessClosureDigest: verificationPolicy.harnessClosureDigest,
    checks: [{ checkId: 'unit-check', inputDigest, subjectResolution, executionTreeDigest,
      materializedInputs: materializedInputRef, materializedInputPath: relativeInputManifestPath,
      materializedInputDigest: materializedInputRef.sha256, overlayManifest: overlayManifestRef }] });
  const storedTestInputManifest = store.readJson(testInputManifest.artifactId);
  const recoveredOverlayBindings = loadProtectedSelfRepairGateRecoveryBindings({ store, policy: verificationPolicy,
    testInputManifest: storedTestInputManifest });
  assert.equal(recoveredOverlayBindings.get('unit-check').overlayManifestRef.artifactId, overlayManifestRef.artifactId,
    'Gate recovery restores the exact protected-overlay manifest');
  const candidateEntryPointPolicy = { checks: [{ ...verificationPolicy.checks[0], subjectBinding: 'candidate-entrypoint', overlayPaths: [] }] };
  const candidateEntryPointManifest = { ...storedTestInputManifest,
    checks: storedTestInputManifest.checks.map(row => ({ ...row, overlayManifest: null })) };
  const recoveredCandidateBindings = loadProtectedSelfRepairGateRecoveryBindings({ store, policy: candidateEntryPointPolicy,
    testInputManifest: candidateEntryPointManifest });
  assert.equal(recoveredCandidateBindings.get('unit-check').overlayManifest, null,
    'Gate recovery accepts the valid nullable overlay reference for candidate-entrypoint checks');
  assert.throws(() => loadProtectedSelfRepairGateRecoveryBindings({ store, policy: verificationPolicy,
    testInputManifest: candidateEntryPointManifest }), { code: 'p5_gate_recovery_overlay_mismatch' },
  'recovery refuses an omitted overlay for a protected-overlay check');
  assert.throws(() => loadProtectedSelfRepairGateRecoveryBindings({ store, policy: candidateEntryPointPolicy,
    testInputManifest: storedTestInputManifest }), { code: 'p5_gate_recovery_overlay_mismatch' },
  'recovery refuses an overlay reference for a candidate-entrypoint check');
  const outputRef = store.putText('bounded fixture output');
  const checkStartedAt = new Date().toISOString(), checkEndedAt = new Date().toISOString();
  const checkObservation = { checkId: 'unit-check', stageId: 'unit', required: true,
    commandDigest: verificationPolicy.checks[0].commandDigest, toolIdentities: ['node-fixture'], inputDigest,
    subjectResolution, executionTreeDigest, overlayManifest: overlayManifestRef,
    startedAt: checkStartedAt, endedAt: checkEndedAt, status: 'passed', exitCode: 0,
    expectedAssertions: ['candidate-value'], completedAssertions: ['candidate-value'], stdout: outputRef, stderr: outputRef,
    observations: null };
  const observationsRef = putRef({ schemaVersion: 1, kind: 'ProtectedSelfRepairCheckObservation', candidateId: result.candidate.candidateId,
    candidateSourceDigest: result.candidate.candidateSourceDigest, baselineId: result.candidate.baselineId, checkId: 'unit-check',
    commandDigest: checkObservation.commandDigest, inputDigest, subjectResolution, executionTreeDigest,
    startedAt: checkStartedAt, endedAt: checkEndedAt, status: 'passed', exitCode: 0,
    expectedAssertions: ['candidate-value'], completedAssertions: ['candidate-value'], stdout: outputRef, stderr: outputRef,
    captureStatus: 'complete' });
  checkObservation.observations = observationsRef;
  const receipt = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReceipt', receiptId: '0'.repeat(64), status: 'passed',
    candidateId: result.candidate.candidateId, candidateSourceDigest: result.candidate.candidateSourceDigest,
    baselineId: result.candidate.baselineId, candidateManifest: result.candidateArtifact,
    changeManifest: result.changeManifestArtifact, selfRepairProfile: profileRef, verificationPolicy: policyRef,
    verificationInputs: inputsRef, repairRunId, linkId: authorization.linkId, incidentId,
    verificationNodeId: 'verify', gateAttemptId,
    execution: { custodyId, hostIdentity, lifecycleGeneration, engineEpoch: 1, invocationDigest,
      commandManifest, executableIdentity: process.execPath, harnessClosureDigest: verificationPolicy.harnessClosureDigest,
      testInputManifest, environmentDigest: 'd'.repeat(64) },
    checks: [checkObservation], requiredCheckSetDigest: canonicalHash(['unit-check']),
    completedCheckSetDigest: canonicalHash(['unit-check']), sourceBeforeDigest: result.candidate.candidateSourceDigest,
    sourceAfterDigest: result.candidate.candidateSourceDigest, liveCandidateDigest: result.candidate.candidateSourceDigest,
    harnessAfterDigest: verificationPolicy.harnessClosureDigest, terminalEvidence: gateTerminalRef,
    captureStatus: 'complete', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    observationJournalCursor: 1, issuedJournalCursor: 2 };
  receipt.receiptId = p5VerificationReceiptId({ candidateId: receipt.candidateId, verificationPolicyDigest: policyRef.sha256,
    gateAttemptId, custodyId, checks: receipt.checks });
  assert.equal(verifyP5Receipt(receipt, { store, candidateRef: result.candidateArtifact, gateAttemptId,
    terminalEvidenceRef: gateTerminalRef }), true);
  const reviewDossier = createP5ReviewDossierArtifacts({ store, candidateRef: result.candidateArtifact, candidate: result.candidate,
    receiptRef: putRef(receipt), receipt, changeManifestRef: result.changeManifestArtifact, changeManifest: result.changeManifest });
  assert.deepEqual(reviewDossier.chunks.map(item => item.byteSize <= 64 * 1024), [true]);
  assert.equal(reviewDossier.requiredReviewSetDigest, canonicalHash(reviewDossier.chunks.map(item => item.artifact)));
  const reviewChunk = store.readJson(reviewDossier.chunks[0].id);
  assert.deepEqual(reviewChunk.fileChanges.map(item => [item.path, item.operation]), result.changeManifest.changes.map(item => [item.path, item.operation]));
  assert.equal(reviewChunk.fileChanges.find(item => item.path === 'src/normalize.mjs').before.text, 'export const value = 1;');
  assert.equal(reviewChunk.fileChanges.find(item => item.path === 'src/normalize.mjs').after.text, 'export const value = 2;');
  const judge = Object.create(Engine.prototype);
  judge.store = store;
  const reviewAttentionKey = 'a'.repeat(64);
  const reviewEvidence = { schemaVersion: 1, kind: 'JudgeEvidencePackage', attentionKey: reviewAttentionKey,
    p5Review: { candidateId: reviewDossier.candidateId, candidateManifest: result.candidateArtifact,
      receiptId: reviewDossier.receiptId, changeManifest: reviewDossier.changeManifestRef,
      requiredReviewRefs: reviewDossier.chunks.map(item => item.artifact),
      requiredReviewSetDigest: reviewDossier.requiredReviewSetDigest },
    permittedActions: ['wait', 'request_evidence', 'accept_repair', 'reject_repair', 'request_human_input'],
    referenceCatalog: reviewDossier.chunks };
  const reviewExpansion = { schemaVersion: 1, kind: 'JudgeEvidenceExpansion', attentionKey: reviewAttentionKey,
    p5Review: { candidateId: reviewDossier.candidateId, receiptId: reviewDossier.receiptId,
      requiredReviewSetDigest: reviewDossier.requiredReviewSetDigest }, totalBytes: reviewDossier.totalBytes,
    items: reviewDossier.chunks.map(item => ({ id: item.id, artifact: item.artifact, source: item.source,
      mediaType: item.mediaType, byteSize: item.byteSize, content: { text: store.readText(item.id) } })) };
  assert.equal(judge.workflowJudgeP5ExpansionMatches(reviewEvidence, reviewExpansion, reviewAttentionKey), true,
    'the P5 follow-up input is bound to the complete exact content of every issued dossier chunk');
  assert.equal(judge.workflowJudgeP5ExpansionMatches(reviewEvidence, { ...reviewExpansion, items: [] }, reviewAttentionKey), false,
    'omitting a required source chunk invalidates review delivery');
  assert.equal(judge.workflowJudgeP5ExpansionMatches(reviewEvidence, { ...reviewExpansion, items: reviewExpansion.items.map(item => ({ ...item,
    content: { text: item.content.text + '\nforged' } })) }, reviewAttentionKey), false,
  'rewriting the expanded text invalidates review delivery');
  const p5Context = { kind: 'repair_approval', policy: { judgeNodeId: 'judge', maxEvidenceExpansionsPerAttention: 1, maxJudgeAttemptsPerRun: 4 },
    p5Review: { candidate: result.candidate, receipt, dossier: reviewDossier } };
  const requestAttention = { record: { runId: randomUUID(), expansionCount: 0 }, evidence: reviewEvidence };
  assert.equal(judge.workflowJudgeActionAllowed(p5Context, requestAttention, { reasonCode: 'evidence_insufficient', evidenceRefs: [],
    action: { type: 'request_evidence', evidenceRefs: reviewDossier.chunks.map(item => item.id) } }), null,
  'P5 permits the exact complete required dossier set');
  assert.match(judge.workflowJudgeActionAllowed(p5Context, requestAttention, { reasonCode: 'evidence_insufficient', evidenceRefs: [],
    action: { type: 'request_evidence', evidenceRefs: [] } }), /complete exact issued review set/,
  'P5 refuses a partial or empty required review request');
  const binaryBytes = Buffer.from([0x00, 0xff, 0x10]);
  const binaryRef = store.putBytes(binaryBytes, 'application/octet-stream');
  const binaryChange = { path: 'src/binary.dat', operation: 'add', before: null,
    after: { path: 'src/binary.dat', type: 'regular', byteSize: binaryBytes.length, sha256: sha256(binaryBytes), executable: false },
    afterArtifact: binaryRef };
  const binaryChangeManifest = { ...result.changeManifest, changes: [binaryChange] };
  const binaryChangeRef = putRef(binaryChangeManifest);
  const binaryCandidate = { ...result.candidate, changeManifest: binaryChangeRef,
    scopeVerdict: { status: 'within_scope', changeCount: 1 } };
  const binaryCandidateRef = putRef(binaryCandidate);
  const binaryReceipt = { ...receipt, candidateManifest: binaryCandidateRef, changeManifest: binaryChangeRef };
  const binaryReceiptRef = putRef(binaryReceipt);
  assert.throws(() => createP5ReviewDossierArtifacts({ store, candidateRef: binaryCandidateRef, candidate: binaryCandidate,
    receiptRef: binaryReceiptRef, receipt: binaryReceipt, changeManifestRef: binaryChangeRef, changeManifest: binaryChangeManifest }),
  { code: 'p5_review_binary_unsupported' }, 'binary source changes fail closed when the captured profile has no review observation for them');
  assert.throws(() => verifyP5Receipt({ ...receipt, sourceAfterDigest: 'e'.repeat(64) },
    { store, candidateRef: result.candidateArtifact, gateAttemptId, terminalEvidenceRef: gateTerminalRef }),
  { code: 'p5_receipt_integrity_mismatch' });
  const missingRequired = { ...receipt, checks: [], completedCheckSetDigest: canonicalHash([]) };
  missingRequired.receiptId = p5VerificationReceiptId({ candidateId: receipt.candidateId, verificationPolicyDigest: policyRef.sha256,
    gateAttemptId, custodyId, checks: [] });
  assert.throws(() => verifyP5Receipt(missingRequired, { store, candidateRef: result.candidateArtifact,
    gateAttemptId, terminalEvidenceRef: gateTerminalRef }), { code: 'p5_receipt_incomplete' });
  const missingAssertionEvidence = putRef({ ...store.readJson(observationsRef.artifactId), completedAssertions: [] });
  const missingAssertion = { ...receipt, checks: [{ ...checkObservation, completedAssertions: [], observations: missingAssertionEvidence }] };
  missingAssertion.receiptId = p5VerificationReceiptId({ candidateId: receipt.candidateId,
    verificationPolicyDigest: policyRef.sha256, gateAttemptId, custodyId, checks: missingAssertion.checks });
  assert.throws(() => verifyP5Receipt(missingAssertion, { store, candidateRef: result.candidateArtifact,
    gateAttemptId, terminalEvidenceRef: gateTerminalRef }), { code: 'p5_receipt_incomplete' });
  const forgedObject = { ...receipt, checks: [{ ...checkObservation, stdout: { ...outputRef, sha256: 'f'.repeat(64) } }] };
  forgedObject.receiptId = p5VerificationReceiptId({ candidateId: receipt.candidateId,
    verificationPolicyDigest: policyRef.sha256, gateAttemptId, custodyId, checks: forgedObject.checks });
  assert.throws(() => verifyP5Receipt(forgedObject, { store, candidateRef: result.candidateArtifact,
    gateAttemptId, terminalEvidenceRef: gateTerminalRef }), { code: 'corruption' });
  const wrongTerminalRef = putRef({ ...store.readJson(gateTerminalRef.artifactId), custodyId: randomUUID() });
  assert.throws(() => verifyP5Receipt({ ...receipt, terminalEvidence: wrongTerminalRef },
    { store, candidateRef: result.candidateArtifact, gateAttemptId, terminalEvidenceRef: wrongTerminalRef }),
  { code: 'p5_receipt_terminal_mismatch' });

  const narrowedScope = { ...scope, modify: [] };
  const narrowedProfile = { ...profile, scope: narrowedScope };
  const narrowedProfileRef = putRef(narrowedProfile);
  const narrowedBindingRef = putRef({ ...sourceBinding, profile: narrowedProfileRef });
  await assert.rejects(() => sealP5Candidate({ store, sourceRoot: source, baseline,
    authorization: { ...authorization, scope: narrowedScope, selfRepairProfile: narrowedProfileRef, sourceBinding: narrowedBindingRef },
    budgets, identityReader: fixtureIdentity, nativeSourceReader: fixtureNativeSourceReader }), { code: 'p5_authorization_mismatch' });
});
