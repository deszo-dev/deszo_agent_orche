// P6 Autonomous Pipeline Consumer (ADR-0010 Section 1, 5, 12, Contracts Section 1-3).
// Consumes accepted ProtectedSelfRepairHandoff/1 artifacts autonomously:
// 1. Detects accepted eligible handoffs.
// 2. Verifies current eligibility and Parent/Repair link state.
// 3. Classifies candidate scope (rejects Host, UI, toolchain, migrations).
// 4. Reconstructs exact source from immutable Store.
// 5. Invokes fixed installed builder (two builds, byte reproducibility).
// 6. Prepares successor P5 profile and produces P6BuildReceipt/1.
// 7. Re-validates eligibility immediately before switch (protects against Stop races).
// 8. Quiesces Engine and initiates Host staging and atomic switch.
// ZERO human approvals between P5 acceptance and P6 activation!

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertP6CandidateScope, classifyP6CandidateScope } from './p6Scope.mjs';
import { reconstructCandidateSource, verifyP6SourceGitProvenance } from './p6Reconstruction.mjs';
import { prepareP6Successor } from './p6Successor.mjs';
import { requestEngineSwitch, createSwitchQuiescence } from '../host/p6Switch.mjs';
import { nextP5WorkspaceSlot, runP5GitCommand, validateP5Contract } from './protectedSelfRepair.mjs';
import { fetchP5EnrolledGitRefs, verifyP5GitHistoryComplete } from './p5GitCandidate.mjs';
import { testFaultHooksEnabled } from './testFaultPolicy.mjs';
import { canonicalHash, sha256 } from './canonical.mjs';
import { materializeVerifiedP6GitObjects, verifyP6GitObjectSource } from './p6GitObjectSource.mjs';

export class P6ConsumerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6ConsumerError';
    this.code = code;
    this.details = details;
  }
}

const asRef = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });
const commandRequest = (kind, identity) => `p6-${kind}-${identity}`;

function readCommandArtifact(store, requestId, command) {
  const row = store.get('SELECT command, payload_sha256, response_artifact_id FROM command_receipts WHERE request_id = ?', requestId);
  if (!row) return null;
  if (row.command !== command) throw new P6ConsumerError('p6_receipt_command_mismatch', `Receipt ${requestId} has an unexpected command.`);
  const artifactRow = store.artifactRow(row.response_artifact_id);
  if (!artifactRow?.sha256) throw new P6ConsumerError('p6_receipt_artifact_missing', `Receipt ${requestId} references a missing artifact.`);
  const ref = { artifactId: row.response_artifact_id, sha256: artifactRow.sha256 };
  store.verifyRef(ref);
  return { row, ref, value: store.readJson(ref.artifactId) };
}

function ensureCommandArtifact(store, { requestId, command, payloadSha256, value }) {
  const artifact = store.putJson(value);
  const artifactRef = asRef(artifact);
  return store.transaction(() => {
    const existing = readCommandArtifact(store, requestId, command);
    if (existing) {
      if (existing.row.payload_sha256 !== payloadSha256 || existing.ref.artifactId !== artifactRef.artifactId
        || existing.ref.sha256 !== artifactRef.sha256)
        throw new P6ConsumerError('p6_receipt_replay_mismatch', `Receipt ${requestId} was replayed with different content.`);
      return existing.ref;
    }
    store.run(`INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?)`, requestId, command, payloadSha256, artifactRef.artifactId, new Date().toISOString());
    return artifactRef;
  });
}

function recordP6SourceContinuityRefusal({ store, operationIntent, operationIntentRef, handoff, handoffRef, receipt, error }) {
  const value = { schemaVersion: 1, kind: 'P6SourceContinuityRefusal', operationId: operationIntent.operationId,
    operationIntent: operationIntentRef, handoff: handoffRef, handoffId: handoff.handoffId,
    candidate: receipt.candidate, gitCandidate: receipt.gitCandidate, packageSha256: receipt.packageSha256,
    sourceCommit: receipt.sourceCommit, sourceTree: receipt.sourceTree,
    reasonCode: error.code || 'p6_source_continuity_unavailable', diagnosticsDigest: canonicalHash({ name: error.name, message: error.message }),
    recordedAt: new Date().toISOString() };
  validateP5Contract('p6SourceRefusal', value);
  const requestId = commandRequest('source-refused', operationIntent.operationId);
  const existing = readCommandArtifact(store, requestId, 'p6.source_refused');
  if (existing) {
    validateP5Contract('p6SourceRefusal', existing.value);
    const { recordedAt: _recordedAt, ...priorIdentity } = existing.value;
    const { recordedAt: _newRecordedAt, ...expectedIdentity } = value;
    if (existing.row.payload_sha256 !== receipt.packageSha256 || canonicalHash(priorIdentity) !== canonicalHash(expectedIdentity))
      throw new P6ConsumerError('p6_source_refusal_replay_mismatch', 'A different source-continuity refusal already owns this P6 operation.');
    return existing.ref;
  }
  return ensureCommandArtifact(store, { requestId, command: 'p6.source_refused', payloadSha256: receipt.packageSha256, value });
}

function assertReceiptMatchesHandoff({ receipt, handoff, handoffRef, operationIntentRef, buildId, packageSha256 }) {
  if (receipt?.kind !== 'P6BuildReceipt' || receipt.engineBuildId !== buildId || receipt.packageSha256 !== packageSha256
    || receipt.handoffId !== handoff.handoffId || canonicalHash(receipt.handoff) !== canonicalHash(handoffRef)
    || canonicalHash(receipt.candidate) !== canonicalHash(handoff.candidate)
    || canonicalHash(receipt.gitCandidate) !== canonicalHash(handoff.gitCandidate)
    || canonicalHash(receipt.operationIntent) !== canonicalHash(operationIntentRef)
    || receipt.candidateSourceDigest !== handoff.candidateSourceDigest)
    throw new P6ConsumerError('p6_build_receipt_mismatch', 'The durable P6 build receipt does not bind this exact accepted handoff, candidate, operation and package.');
}

// The successor's slot must be the registered workspace the enrollment names at its enrolled root. The Developer runs in the registered
// row's cwd, so a missing or re-pointed row would send the successor's Repair to another directory after its switch has committed.
// Native identity and emptiness are checked later; this check runs before any P6 state is written.
export function assertSuccessorSlotRegistered(store, slot) {
  const row = store.get('SELECT cwd FROM workspaces WHERE id = ?', slot.workspaceId);
  if (!row || resolve(row.cwd).toLowerCase() !== resolve(slot.canonicalRoot).toLowerCase())
    throw new P6ConsumerError('p6_successor_slot_unverified', 'The successor P5 slot is not the registered workspace at its enrolled root; no operation, build or Host staging was started.');
}

function getOrCreateP6Operation({ store, handoff, handoffRef, engineBuildId, shellBuildId, previousRelease, generation }) {
  const requestId = commandRequest('operation', handoff.handoffId);
  const expected = { handoff: handoffRef, handoffId: handoff.handoffId, candidate: handoff.candidate,
    gitCandidate: handoff.gitCandidate, candidateId: handoff.candidateId, candidateSourceDigest: handoff.candidateSourceDigest,
    previousRelease, engineBuildId, shellBuildId, generation, enrollmentRoot: handoff.enrollment };
  const existing = readCommandArtifact(store, requestId, 'p6.operation');
  if (existing) {
    validateP5Contract('p6Operation', existing.value);
    const { operationId: _operationId, createdAt: _createdAt, schemaVersion: _schemaVersion, kind: _kind, ...identity } = existing.value;
    if (existing.row.payload_sha256 !== canonicalHash(existing.value) || canonicalHash(identity) !== canonicalHash(expected)) {
      throw new P6ConsumerError('p6_operation_replay_mismatch', 'The durable P6 operation intent does not match the current handoff or Host baseline.');
    }
    return { operationIntent: existing.value, operationIntentRef: existing.ref };
  }

  const operationIntent = { schemaVersion: 1, kind: 'P6Operation', operationId: randomUUID(), ...expected,
    createdAt: new Date().toISOString() };
  validateP5Contract('p6Operation', operationIntent);
  const intentArtifact = store.putJson(operationIntent);
  const operationIntentRef = asRef(intentArtifact);
  store.transaction(() => {
    const current = readCommandArtifact(store, requestId, 'p6.operation');
    if (current) {
      validateP5Contract('p6Operation', current.value);
      if (canonicalHash(current.value) !== canonicalHash(operationIntent))
        throw new P6ConsumerError('p6_operation_replay_mismatch', 'A different P6 operation intent already owns this handoff.');
      return;
    }
    store.run(`INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?)`, requestId, 'p6.operation', canonicalHash(operationIntent), operationIntentRef.artifactId, operationIntent.createdAt);
  });
  const stored = readCommandArtifact(store, requestId, 'p6.operation');
  if (!stored || canonicalHash(stored.value) !== canonicalHash(operationIntent))
    throw new P6ConsumerError('p6_operation_persist_failed', 'The immutable P6 operation intent was not durably recorded.');
  return { operationIntent, operationIntentRef: stored.ref };
}

function validateP6StageReceipt(store, record, { operationId, fromEngineBuildId, toEngineBuildId, shellBuildId, packageSha256 }) {
  if (!record) return null;
  validateP5Contract('p6StageReceipt', record.value);
  const value = record.value;
  if (record.row.payload_sha256 !== packageSha256 || value.operationId !== operationId
    || value.fromEngineBuildId !== fromEngineBuildId || value.toEngineBuildId !== toEngineBuildId
    || value.shellBuildId !== shellBuildId || value.packageSha256 !== packageSha256)
    throw new P6ConsumerError('p6_stage_receipt_mismatch', 'The durable Host stage receipt does not match this exact P6 operation.');
  store.verifyRef(record.ref);
  return record.ref;
}

function validateP6Admission(store, record, expected) {
  if (!record) return null;
  validateP5Contract('p6SwitchAdmission', record.value);
  const value = record.value;
  const identity = { operationId: value.operationId, operationIntent: value.operationIntent, handoff: value.handoff,
    buildReceipt: value.buildReceipt, stageReceipt: value.stageReceipt, candidate: value.candidate,
    gitCandidate: value.gitCandidate, previousRelease: value.previousRelease, engineBuildId: value.engineBuildId,
    shellBuildId: value.shellBuildId, generation: value.generation, packageSha256: value.packageSha256 };
  if (record.row.payload_sha256 !== expected.packageSha256 || canonicalHash(identity) !== canonicalHash(expected))
    throw new P6ConsumerError('p6_switch_admission_mismatch', 'The durable P6 switch admission was replayed with different handoff or package content.');
  store.verifyRef(record.ref);
  return record.ref;
}

function p5Eligibility(engine, repairRunId, link, handoffRef, handoff) {
  const parent = engine.store.get('SELECT state FROM runs WHERE id = ?', link.parent_run_id);
  const freshLink = engine.store.get('SELECT * FROM run_links WHERE id = ?', link.id);
  const projection = engine.protectedSelfRepairRunProjection?.(repairRunId);
  const handoffEvents = engine.store.readEvents(repairRunId).filter(event => event.type === 'self_repair.handoff_recorded');
  const eventRef = handoffEvents.length === 1 ? handoffEvents[0].payload?.record : null;
  const accepted = parent && !['stopping', 'stopped', 'cancelled', 'canceled', 'failed'].includes(parent.state)
    && freshLink?.decision_status === 'accepted'
    && freshLink.parent_suspension_state !== 'stopped'
    && projection?.kind === 'ProtectedSelfRepairRunProjection'
    && projection.eligible === true && projection.stage === 'retained_for_p6'
    && projection.repairRunId === repairRunId && projection.parentRunId === link.parent_run_id
    && projection.linkId === link.id && projection.handoffId === handoff.handoffId
    && projection.candidateId === handoff.candidateId && eventRef?.artifactId === handoffRef.artifactId
    && eventRef?.sha256 === handoffRef.sha256;
  return accepted ? { accepted: true, parent, link: freshLink, projection } : { accepted: false, parent, link: freshLink, projection };
}

/** Store transaction that serializes P5 Stop/invalidation with the final P6 Host admission. */
export function persistP6SwitchAdmission({ engine, requestId, command, packageSha256, expected,
  stageReceiptRef, repairRunId, link, handoffRef, handoff }) {
  const store = engine.store;
  return store.transaction(() => {
    const current = readCommandArtifact(store, requestId, command);
    if (current) {
      const ref = validateP6Admission(store, current, { ...expected, stageReceipt: stageReceiptRef });
      if (!ref) throw new P6ConsumerError('p6_switch_admission_missing', 'The P6 switch admission record is invalid.');
      return ref;
    }
    if (!stageReceiptRef) throw new P6ConsumerError('p6_stage_receipt_missing', 'The exact Host stage receipt is required before switch admission.');
    const eligibility = p5Eligibility(engine, repairRunId, link, handoffRef, handoff);
    if (!eligibility.accepted) throw new P6ConsumerError('p6_eligibility_revoked_before_switch', 'P5 Stop or invalidation committed before P6 switch admission.');
    const admittedAt = new Date().toISOString();
    const value = { schemaVersion: 1, kind: 'P6SwitchAdmission', ...expected, stageReceipt: stageReceiptRef, admittedAt };
    validateP5Contract('p6SwitchAdmission', value);
    const artifact = store.putJson(value);
    store.run(`INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?)`, requestId, command, packageSha256, artifact.artifactId, admittedAt);
    return asRef(artifact);
  });
}

/**
 * Locates the installed Shell release descriptor and runtime resources.
 */
function resolveInstalledShellAndResources(engine) {
  const bridge = engine.lifecycleClient || engine.lifecycleHost;
  let installation = bridge?.context?.installationRoot || engine.lifecycleHost?.installationRoot || engine.installationRoot;

  if (!installation) {
    for (const candidateFile of [
      (() => { try { return fileURLToPath(import.meta.url); } catch { return null; } })(),
      process.argv[1],
      process.argv[2],
    ]) {
      if (!candidateFile) continue;
      const norm = candidateFile.replaceAll('\\', '/');
      const vIdx = norm.toLowerCase().lastIndexOf('/versions/');
      if (vIdx !== -1) {
        const candidateInstall = candidateFile.slice(0, vIdx);
        if (existsSync(join(candidateInstall, 'shell', 'shell.json'))) {
          installation = candidateInstall;
          break;
        }
      }
      let cur = dirname(candidateFile);
      for (let i = 0; i < 6; i++) {
        if (existsSync(join(cur, 'shell', 'shell.json'))) {
          installation = cur;
          break;
        }
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (installation) break;
    }
  }

  if (!installation) {
    let cur = process.cwd();
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(cur, 'shell', 'shell.json'))) {
        installation = cur;
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  if (!installation) {
    throw new P6ConsumerError('p6_consumer_no_installation', `Installation root is not available (cwd: ${process.cwd()}, argv: ${JSON.stringify(process.argv)})`);
  }

  const shellManifestPath = join(installation, 'shell', 'shell.json');
  if (!existsSync(shellManifestPath)) {
    throw new P6ConsumerError('p6_consumer_missing_shell', `Shell manifest missing at ${shellManifestPath}`);
  }
  const shell = JSON.parse(readFileSync(shellManifestPath, 'utf8'));

  // Runtime resources directory: versions/<currentBuildId>/runtime or dist-runtime or installation/shell
  let runtimeResources = null;
  const currentBuildId = bridge?.context?.buildId || engine.lifecycleHost?.buildId || engine.lifecycleHost?.context?.buildId;
  if (currentBuildId && existsSync(join(installation, 'versions', currentBuildId, 'runtime'))) {
    runtimeResources = join(installation, 'versions', currentBuildId, 'runtime');
  } else if (existsSync(join(installation, 'shell', 'runtime'))) {
    runtimeResources = join(installation, 'shell', 'runtime');
  } else if (existsSync(join(installation, 'shell'))) {
    runtimeResources = join(installation, 'shell');
  }

  if (!runtimeResources || !existsSync(join(runtimeResources, 'bridge.mjs'))) {
    const versionsDir = join(installation, 'versions');
    if (existsSync(versionsDir)) {
      for (const ver of readdirSync(versionsDir)) {
        const cand = join(versionsDir, ver, 'runtime');
        if (existsSync(join(cand, 'bridge.mjs'))) {
          runtimeResources = cand;
          break;
        }
      }
    }
  }

  if (!runtimeResources) {
    runtimeResources = join(installation, 'shell');
  }

  return { shell, runtimeResources, installation };
}

/**
 * Executes the autonomous P6 activation pipeline for a repair run.
 * @param {Object} options
 * @param {Object} options.engine Engine instance
 * @param {string} options.repairRunId ID of the Repair run that has an accepted handoff
 * @param {string} [options.targetEngineBuildId] Optional target build ID
 * @param {boolean} [options.skipHostSwitch=false] If true, stops after build and receipt (for testing)
 * @returns {Promise<Object>} Outcome of the activation pipeline
 */
// Module-private: only the entry point's bindTrustedP6Builder call writes here. A repaired Engine cannot reach or replace the binding.
const trustedBuilders = new WeakMap();

/** Binds the trusted P6 builder to one Engine instance. The entry point calls it once, after construction and before serving. */
export function bindTrustedP6Builder(engine, binding) {
  if (!engine || typeof engine !== 'object') throw new P6ConsumerError('p6_builder_bind_invalid', 'A P6 builder binds only to an Engine instance.');
  if (typeof binding?.buildAndAttestEnginePackage !== 'function') throw new P6ConsumerError('p6_builder_bind_invalid', 'The P6 builder binding has no builder function.');
  if (trustedBuilders.has(engine)) throw new P6ConsumerError('p6_builder_already_bound', 'This Engine already has its trusted P6 builder.');
  trustedBuilders.set(engine, Object.freeze({ buildAndAttestEnginePackage: binding.buildAndAttestEnginePackage }));
}

function trustedBuilderOf(engine) {
  return trustedBuilders.get(engine) ?? null;
}

export function hasTrustedP6Builder(engine) {
  return trustedBuilders.has(engine);
}

export async function executeP6Activation({
  engine,
  repairRunId,
  targetEngineBuildId = null,
  skipHostSwitch = false,
}) {
  if (!engine || !engine.store) {
    throw new P6ConsumerError('p6_consumer_no_engine', 'Valid engine with store is required.');
  }
  if (!repairRunId) {
    throw new P6ConsumerError('p6_consumer_no_repair_run', 'repairRunId is required.');
  }

  // 1. Locate the accepted logical P5 Repair and reject obvious terminal states.
  const link = engine.logicalRepairLinkForRun
    ? engine.logicalRepairLinkForRun(repairRunId)
    : engine.store?.get('SELECT * FROM run_links WHERE repair_run_id = ?', repairRunId);
  if (!link) {
    throw new P6ConsumerError('p6_consumer_not_p5_repair', `Run ${repairRunId} has no linked repair record.`);
  }

  // Check Stop / cancellation race
  const parent = engine.store.get('SELECT state FROM runs WHERE id = ?', link.parent_run_id);
  if (['stopping', 'stopped', 'cancelled', 'canceled', 'failed'].includes(parent?.state) || link.parent_suspension_state === 'stopped') {
    return { activated: false, reason: 'parent_stopped' };
  }
  if (link.decision_status === 'rejected' || link.state === 'rejected' || link.state === 'repair_failed') {
    return { activated: false, reason: 'repair_rejected' };
  }

  // 2. Read the one exact immutable handoff recorded by the P5 acceptance transaction.
  const events = engine.store.readEvents(repairRunId);
  const handoffEvents = events.filter(e => e.type === 'self_repair.handoff_recorded');
  const handoffEvent = handoffEvents.length === 1 ? handoffEvents[0] : null;
  const handoffRef = handoffEvent?.payload?.record;
  if (!handoffRef?.artifactId || !handoffRef.sha256) {
    throw new P6ConsumerError('p6_consumer_no_handoff_event', 'No self_repair.handoff_recorded event found on run.');
  }

  engine.store.verifyRef(handoffRef);
  const handoff = engine.store.readJson(handoffRef.artifactId);
  if (canonicalHash(handoff) !== handoffRef.sha256) throw new P6ConsumerError('p6_consumer_handoff_digest_mismatch', 'The P5 handoff ref does not match its immutable bytes.');
  validateP5Contract('handoff', handoff);

  // 3. Candidate Scope Classification
  let changeManifest = handoff.changeManifest;
  if (changeManifest && !changeManifest.modifications && changeManifest.artifactId) {
    engine.store.verifyRef(changeManifest);
    changeManifest = engine.store.readJson(changeManifest.artifactId);
  }
  const scopeVerdict = classifyP6CandidateScope(changeManifest);
  if (!scopeVerdict.supported) {
    return {
      activated: false,
      reason: scopeVerdict.reason,
      path: scopeVerdict.path,
      details: scopeVerdict.details,
    };
  }

  const priorBuild = readCommandArtifact(engine.store, commandRequest('build', handoff.handoffId), 'p6.build');
  const priorAdmission = priorBuild
    ? readCommandArtifact(engine.store, commandRequest('switch-admitted', priorBuild.value.operationId), 'p6.switch_admitted')
    : null;
  const initialEligibility = priorAdmission ? { accepted: true, resumed: true }
    : p5Eligibility(engine, repairRunId, link, handoffRef, handoff);
  if (!initialEligibility.accepted) {
    return { activated: false, reason: 'p5_acceptance_not_current', stage: initialEligibility.projection?.stage ?? 'unavailable',
      issues: initialEligibility.projection?.issues || [] };
  }

  // 4. Resolve build identities
  const buildId = targetEngineBuildId || `engine-${handoff.candidateId.slice(0, 12)}`;
  const currentBuildId = engine.lifecycleClient?.context?.buildId
    || engine.lifecycleHost?.buildId
    || engine.lifecycleHost?.context?.buildId
    || null;
  if (currentBuildId && currentBuildId === buildId) {
    return {
      activated: false,
      reason: 'already_active',
      buildId,
    };
  }

  // Check if build receipt already exists for this handoff
  const buildRequestId = commandRequest('build', handoff.handoffId);
  const existingBuild = readCommandArtifact(engine.store, buildRequestId, 'p6.build');

  let receiptArtifact = null;
  let receipt = null;
  let packageSha256 = null;
  const { shell, runtimeResources, installation } = resolveInstalledShellAndResources(engine);
  const bridge = engine.lifecycleClient || engine.lifecycleHost;
  const hostContext = bridge?.context || engine.lifecycleHost || {};
  const shellBuildId = shell.shellBuildId;
  const generation = hostContext.generation || engine.lifecycleHost?.generation || null;
  if (!engine.installedSourceRelease || !generation || !shellBuildId
    || hostContext.shellBuildId && hostContext.shellBuildId !== shellBuildId) {
    throw new P6ConsumerError('p6_consumer_host_identity_unavailable', 'P6 requires the exact Host release, Shell and generation identity.');
  }
  // The trusted builder is bound by the entry point (runner.mjs) through bindTrustedP6Builder. It is not an import here (this module
  // is in the Self-Repair subject closure, where the P5 resolver refuses the builder's module-loader import) and not an Engine property
  // that repaired source could set. It is checked before the durable operation intent is written, so a missing builder leaves no P6 state.
  const buildAndAttestEnginePackage = trustedBuilderOf(engine)?.buildAndAttestEnginePackage;
  if (typeof buildAndAttestEnginePackage !== 'function')
    throw new P6ConsumerError('p6_builder_unavailable', 'The Engine has no trusted P6 builder; no operation, build or Host staging was started.');
  const previousRelease = (await engine.installedSourceRelease()).release;
  if (!previousRelease || currentBuildId && previousRelease.buildId !== currentBuildId) {
    throw new P6ConsumerError('p6_consumer_previous_release_mismatch', 'The Host-attested predecessor release differs from the active Engine.');
  }
  // The successor's slot is decided before the durable operation intent is written: an exhausted pool leaves no P6 state at all.
  const handoffEnrollment = engine.store.readJson(engine.store.verifyRef(handoff.enrollment).artifactId);
  const successorSlot = nextP5WorkspaceSlot(handoffEnrollment);
  if (!successorSlot) throw new P6ConsumerError('p6_successor_workspace_exhausted',
    'The enrolled single-use P5 slot pool has no slot left for the successor; no operation, build or Host staging was started.');
  assertSuccessorSlotRegistered(engine.store, successorSlot);
  const { operationIntent, operationIntentRef } = getOrCreateP6Operation({ store: engine.store, handoff, handoffRef,
    engineBuildId: buildId, shellBuildId, previousRelease, generation });
  const operationId = operationIntent.operationId;

  if (existingBuild) {
    receipt = existingBuild.value;
    validateP5Contract('p6BuildReceipt', receipt);
    receiptArtifact = existingBuild.ref;
    packageSha256 = receipt.packageSha256;
    assertReceiptMatchesHandoff({ receipt, handoff, handoffRef, operationIntentRef, buildId, packageSha256 });
    if (existingBuild.row.payload_sha256 !== packageSha256 || receipt.operationId !== operationId
      || canonicalHash(receipt.previousRelease) !== canonicalHash(previousRelease)) {
      throw new P6ConsumerError('p6_build_receipt_replay_mismatch', 'The P6 build receipt does not match its command identity or Host predecessor.');
    }
  } else {
    // 5. Reconstruct exact candidate source into two separate scratch roots
    const scratch1 = mkdtempSync(join(tmpdir(), 'deszo-p6-src1-'));
    const scratch2 = mkdtempSync(join(tmpdir(), 'deszo-p6-src2-'));

    try {
      reconstructCandidateSource({ store: engine.store, handoff, targetDir: scratch1 });
      reconstructCandidateSource({ store: engine.store, handoff, targetDir: scratch2 });

      const packageOutDir = join(installation, 'staging', buildId);

      // Locate dependencies directory if present in current engine or versions
      let dependenciesDir = null;
      if (currentBuildId && existsSync(join(installation, 'versions', currentBuildId, 'p5', 'node_modules'))) {
        dependenciesDir = join(installation, 'versions', currentBuildId, 'p5');
      } else {
        const versionsDir = join(installation, 'versions');
        if (existsSync(versionsDir)) {
          for (const ver of readdirSync(versionsDir)) {
            const candidateP5 = join(versionsDir, ver, 'p5', 'node_modules');
            if (existsSync(candidateP5)) {
              dependenciesDir = join(versionsDir, ver, 'p5');
              break;
            }
          }
        }
      }

      // The successor's Repair slot is verified before any build or Host staging: its native identity must match the enrollment and
      // it must be empty. A slot the Host cannot attest refuses here, not after the switch.
      const slotIdentity = await engine.protectedSelfRepairHostReaders().nativeSourceReader({ root: successorSlot.canonicalRoot,
        include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
      if (slotIdentity?.refused || canonicalHash(slotIdentity?.rootIdentity) !== canonicalHash(successorSlot.nativeIdentity)
        || readdirSync(successorSlot.canonicalRoot).length)
        throw new P6ConsumerError('p6_successor_slot_unverified', 'The successor P5 slot is not the enrolled, empty native slot.');

      // 8. Build & attest Engine package (two independent builds, byte reproducibility)
      // The successor carries the test-fault marker only in a Node test process; a developer's source run never builds one.
      const testFaultHooks = testFaultHooksEnabled(import.meta.url) && Boolean(process.env.NODE_TEST_CONTEXT);

      const buildResult = await buildAndAttestEnginePackage({
        store: engine.store,
        handoff,
        handoffRef,
        reconstructedSourceRoot1: scratch1,
        reconstructedSourceRoot2: scratch2,
        shell,
        runtimeResources,
        outDir: packageOutDir,
        engineBuildId: buildId,
        operationId,
        operationIntentRef,
        previousRelease,
        prepareSuccessor: identities => prepareP6Successor({ store: engine.store, handoff,
          engineBuildId: buildId, operationId, shellBuildId,
          candidateSourceDigest: identities.candidateSourceDigest, packageSha256: identities.packageSha256,
          candidateCommit: identities.sourceCommit, candidateTree: identities.sourceTree,
          installedSourceDigest: identities.sourceDigest, buildInputDigest: identities.buildInputDigest, previousRelease }),
        dependenciesSourceDir: dependenciesDir,
        testFaultHooks,
      });

      receipt = buildResult.receipt;
      receiptArtifact = asRef(buildResult.receiptArtifact);
      packageSha256 = buildResult.packageSha256;
      assertReceiptMatchesHandoff({ receipt, handoff, handoffRef, operationIntentRef, buildId, packageSha256 });
      const persisted = ensureCommandArtifact(engine.store, { requestId: buildRequestId, command: 'p6.build',
        payloadSha256: packageSha256, value: receipt });
      if (persisted.artifactId !== receiptArtifact.artifactId || persisted.sha256 !== receiptArtifact.sha256)
        throw new P6ConsumerError('p6_build_receipt_persist_mismatch', 'The stored P6 build receipt differs from its immutable builder artifact.');
    } finally {
      rmSync(scratch1, { recursive: true, force: true });
      rmSync(scratch2, { recursive: true, force: true });
    }
  }

  // Source continuity is a pre-switch invariant. The next Engine's Git baseline must be
  // reconstructible from the exact accepted P5 objects before the Host is asked to stage it.
  try {
    const sourceProof = verifyP6SourceGitProvenance({ store: engine.store, handoff, handoffRef });
    if (sourceProof.sourceCommit !== receipt.sourceCommit || sourceProof.sourceTree !== receipt.sourceTree
      || sourceProof.candidateSourceDigest !== receipt.candidateSourceDigest
      || sourceProof.sourceDigest !== receipt.installedSourceDigest)
      throw new P6ConsumerError('p6_source_continuity_mismatch', 'The accepted P5 Git source does not match the build receipt.');
    const gitTool = receipt.buildInputClosure?.gitTool;
    if (!gitTool?.path || sha256(readFileSync(gitTool.path)) !== gitTool.sha256)
      throw new P6ConsumerError('p6_source_continuity_git_tool_mismatch', 'The enrolled Git executable changed before source continuity preparation.');
    engine.store.verifyRef(handoff.enrollment);
    const sourceEnrollment = engine.store.readJson(handoff.enrollment.artifactId);
    validateP5Contract('enrollment', sourceEnrollment);
    engine.store.verifyRef(sourceEnrollment.baselineManifest);
    const sourceBaseline = engine.store.readJson(sourceEnrollment.baselineManifest.artifactId);
    validateP5Contract('baselineManifest', sourceBaseline);
    const predecessorSource = verifyP6GitObjectSource({ store: engine.store, enrollment: sourceEnrollment, baseline: sourceBaseline });
    if (predecessorSource && predecessorSource.localSource.sourceCommit !== sourceProof.parentCommit)
      throw new P6ConsumerError('p6_source_continuity_predecessor_mismatch', 'The prior P6 source does not provide the accepted candidate parent commit.');
    const objectProbe = mkdtempSync(join(tmpdir(), 'deszo-p6-git-source-'));
    try {
      runP5GitCommand(gitTool, objectProbe, ['init', '--quiet', '--bare', `--object-format=${sourceProof.objectFormat}`]);
      for (const provenance of predecessorSource?.provenanceChain ?? [])
        materializeVerifiedP6GitObjects({ gitTool, repositoryRoot: objectProbe, provenance });
      const materialized = materializeVerifiedP6GitObjects({ gitTool, repositoryRoot: objectProbe, provenance: sourceProof });
      if (materialized.sourceCommit !== receipt.sourceCommit || materialized.sourceTree !== receipt.sourceTree)
        throw new P6ConsumerError('p6_source_continuity_materialization_mismatch', 'The prepared successor Git objects differ from the build receipt.');
      fetchP5EnrolledGitRefs({ gitTool, repositoryRoot: objectProbe, gitSource: sourceEnrollment.gitSource });
      verifyP5GitHistoryComplete({ gitTool, repositoryRoot: objectProbe, sourceCommit: receipt.sourceCommit });
      const commitType = runP5GitCommand(gitTool, objectProbe, ['cat-file', '-t', receipt.sourceCommit]).toString('ascii').trim();
      if (commitType !== 'commit') throw new P6ConsumerError('p6_source_continuity_materialization_missing', 'The prepared successor commit is missing from its complete source history.');
    } finally { rmSync(objectProbe, { recursive: true, force: true }); }
  } catch (error) {
    recordP6SourceContinuityRefusal({ store: engine.store, operationIntent, operationIntentRef, handoff, handoffRef, receipt, error });
    throw new P6ConsumerError('p6_source_continuity_unavailable',
      `The exact successor Git source could not be established before Host staging: ${error.message}`, { cause: error.code || 'invalid_source' });
  }

  if (skipHostSwitch) {
    return {
      activated: true,
      switched: false,
      buildReceipt: receipt,
      packageSha256,
      targetEngineBuildId: buildId,
    };
  }

  // 9. Stage the inert package, then commit P5 eligibility and exact package admission in one Store transaction.
  if (!bridge || typeof bridge.p6Call !== 'function') {
    throw new P6ConsumerError('p6_consumer_no_host', 'Lifecycle Host bridge is required for Engine switch.');
  }

  if (!engine.switchQuiescence) {
    engine.switchQuiescence = createSwitchQuiescence();
  }

  const admissionRequestId = commandRequest('switch-admitted', operationId);
  const admissionCommand = 'p6.switch_admitted';
  const stageRequestId = commandRequest('stage', operationId);
  const existingStage = readCommandArtifact(engine.store, stageRequestId, 'p6.stage');
  let stageReceiptRef = existingStage ? validateP6StageReceipt(engine.store, existingStage, {
    operationId, fromEngineBuildId: operationIntent.previousRelease.buildId, toEngineBuildId: buildId,
    shellBuildId, packageSha256,
  }) : null;
  const existingAdmission = readCommandArtifact(engine.store, admissionRequestId, admissionCommand);
  if (existingAdmission) {
    if (!stageReceiptRef || canonicalHash(existingAdmission.value.stageReceipt) !== canonicalHash(stageReceiptRef))
      throw new P6ConsumerError('p6_switch_stage_receipt_missing', 'The admitted switch has no matching durable Host stage receipt.');
  }
  const admissionExpected = {
    operationId, operationIntent: operationIntentRef, handoff: handoffRef, buildReceipt: receiptArtifact,
    stageReceipt: stageReceiptRef, candidate: receipt.candidate, gitCandidate: receipt.gitCandidate,
    previousRelease: operationIntent.previousRelease, engineBuildId: buildId, shellBuildId, generation, packageSha256,
  };
  const admissionRef = existingAdmission ? validateP6Admission(engine.store, existingAdmission, admissionExpected) : null;

  const onStaged = ({ common, response }) => {
    if (common.fromEngineBuildId !== operationIntent.previousRelease.buildId || common.toEngineBuildId !== buildId
      || common.packageSha256 !== packageSha256 || common.shellBuildId !== shellBuildId || common.generation !== generation
      || response?.operationId !== operationId || response?.phase !== 'staged'
      || response?.fromEngineBuildId !== common.fromEngineBuildId || response?.toEngineBuildId !== buildId
      || response?.packageSha256 !== packageSha256 || response?.shellBuildId !== shellBuildId) {
      throw new P6ConsumerError('p6_stage_host_identity_mismatch', 'The Host stage response does not match the exact P6 operation, predecessor and package.');
    }
    const existing = readCommandArtifact(engine.store, stageRequestId, 'p6.stage');
    if (existing) {
      stageReceiptRef = validateP6StageReceipt(engine.store, existing, {
        operationId, fromEngineBuildId: common.fromEngineBuildId, toEngineBuildId: buildId, shellBuildId, packageSha256,
      });
      return;
    }
    const value = { schemaVersion: 1, kind: 'P6StageReceipt', operationId,
      fromEngineBuildId: common.fromEngineBuildId, toEngineBuildId: buildId, shellBuildId, packageSha256,
      phase: 'staged', recordedAt: new Date().toISOString() };
    validateP5Contract('p6StageReceipt', value);
    stageReceiptRef = ensureCommandArtifact(engine.store, { requestId: stageRequestId, command: 'p6.stage',
      payloadSha256: packageSha256, value });
    admissionExpected.stageReceipt = stageReceiptRef;
  };

  const beforeSwitchAdmission = () => persistP6SwitchAdmission({ engine, requestId: admissionRequestId,
    command: admissionCommand, packageSha256, expected: admissionExpected, stageReceiptRef,
    repairRunId, link, handoffRef, handoff });

  const switchOutcome = await requestEngineSwitch({
    engine,
    lifecycleHost: bridge,
    quiescence: engine.switchQuiescence,
    body: {
      operationId,
      targetEngineBuildId: buildId,
      packageSha256,
    },
    timeoutMs: 60_000,
    onStaged,
    beforeSwitchAdmission,
  });

  return {
    activated: true,
    switched: true,
    operationId,
    targetEngineBuildId: buildId,
    packageSha256,
    switchOutcome,
  };
}
