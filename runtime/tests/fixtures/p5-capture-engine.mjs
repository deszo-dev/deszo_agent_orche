// One Engine generation for the P5-GIT-2 capture-recovery proof. It attaches to the real Rust custody Host as a new
// epoch, receives the Developer's terminal record again from the Host (as Custody re-delivery does after a restart) and
// enters the production durable capture. DESZO_CUSTODY_TEST_FAULT ends this process at a named P5 boundary.
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../../core/engine.mjs';
import { verifyP5GitBaselineCurrent } from '../../core/protectedSelfRepair.mjs';
import { attachEngine, custodyRequest } from '../custody-support.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const host = { address: config.host.address, capability: config.host.capability, generation: config.host.generation };
host.request = (command, payload) => custodyRequest(host, command, payload);
const engine = new Engine({ root: config.root });
engine.custodyHost = { custody: (command, payload) => custodyRequest(host, command, payload) };
engine.custodyEpoch = await attachEngine(host);
engine.custodyHostPid = config.host.pid;
engine.lifecycleHost = { generation: host.generation };
const store = engine.store;
let result;
try {
  const recoveryState = engine.protectedSelfRepairCaptureRecoveryState(config.repairRunId);
  const projection = engine.protectedSelfRepairRunProjection(config.repairRunId);
  const status = await custodyRequest(host, 'custody.status', { generation: host.generation, epoch: engine.custodyEpoch, custodyId: config.custodyId });
  if (status.refused || status.terminal !== true || status.processTreeEnded !== true || status.spoolComplete !== true)
    throw Object.assign(new Error(`The Host did not re-deliver a proven Developer terminal record (${status.code ?? status.state}).`), { code: 'fixture_terminal_unproven' });
  const terminalEvidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairDeveloperTerminalEvidence', runId: config.repairRunId,
    attemptId: config.developerAttemptId, custodyId: status.custodyId, lifecycleGeneration: host.generation, engineEpoch: engine.custodyEpoch,
    processId: status.processId, processCreationTime: status.processCreationTime, invocationDigest: status.invocationDigest,
    executable: status.executable, executableSha256: status.executableSha256, state: status.state, terminal: status.terminal,
    processTreeEnded: status.processTreeEnded, spoolComplete: status.spoolComplete, tailGapPossible: status.tailGapPossible ?? false,
    stdoutDurable: status.stdoutDurable, stdoutAcked: status.stdoutAcked, stderrDurable: status.stderrDurable,
    stderrAcked: status.stderrAcked, exitCode: status.exitCode, terminationReason: status.terminationReason ?? null, observedAt: new Date().toISOString() };
  const enrollment = store.readJson(config.enrollment.artifactId);
  const release = store.readJson(enrollment.runningSourceRelease.artifactId);
  const readers = engine.protectedSelfRepairHostReaders();
  const current = await verifyP5GitBaselineCurrent({ store, enrollment, currentRunningSourceRelease: release, ...readers });
  const baselineRecord = store.readJson(enrollment.baselineManifest.artifactId);
  const baselineSource = store.readJson(baselineRecord.sourceManifest.artifactId);
  const baseline = { ...current, baselineId: enrollment.baselineId, baselineManifest: enrollment.baselineManifest,
    sourceManifest: baselineRecord.sourceManifest, sourceDigest: enrollment.effectiveSourceDigest,
    entries: baselineSource.entries.map(({ artifact: _artifact, ...entry }) => entry),
    contentRefs: new Map(baselineSource.entries.map(entry => [entry.path, entry.artifact])) };
  const link = store.get('SELECT * FROM run_links WHERE id = ?', config.linkId);
  const captured = await engine.captureProtectedSelfRepairCandidateDurably({ runId: config.repairRunId, link, enrollment,
    preparedRef: config.preparedRef, sourceRoot: config.sourceRoot, baseline, candidateAuthorization: config.candidateAuthorization,
    terminalEvidence, readers });
  // The production settle transaction journals the capture together with the Developer Attempt's success.
  store.transaction(() => store.appendEvents(config.repairRunId, [{ type: 'self_repair.candidate_captured',
    payload: { record: captured.candidateArtifact }, nodeInstanceId: null, attemptId: null }]));
  result = { ok: true, recoveryState, stage: projection?.stage, issues: projection?.issues, candidateArtifact: captured.candidateArtifact,
    gitCandidate: captured.candidate.gitCandidate ?? null, recovered: captured.recovered ?? null, epoch: engine.custodyEpoch };
} catch (error) {
  result = { ok: false, code: error.code ?? 'error', message: error.message };
}
writeFileSync(config.out, JSON.stringify(result));
process.exit(0);
